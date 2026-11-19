/**
 * 词汇书：把《日本语精编词汇》这类「按课列词」的扫描书解析成结构化词条。
 *
 * 这类书是双栏排版，每行一个词条：
 *   きょうじゅ（教授）〔名〕教授
 * 即「假名读音 ＋（汉字表记）＋〔词性〕＋ 中文释义」，也有只有假名的（わたし〔代〕我）。
 * 课号「第 N 課」横跨两栏，相当于一条水平分隔线，所以按 y 坐标切课最稳。
 *
 * 扫描件的假名识别很准，但中文释义常被认错（「老师」→「老姉」、「職員」→「現景」），
 * 所以这里只做结构解析，释义与例句交给模型按「假名为准」逐条校正。
 */
import { z } from 'zod';

export interface VocabBookRow {
  page: number;
  lesson: number;
  /** 假名读音（OCR 原始，作为校正依据） */
  reading: string;
  /** 括注里的汉字表记，可能为空 */
  kanji: string;
  /** 原始词性标记，如 名 / 1 / 形1 */
  posToken: string;
  /** OCR 出的中文释义，常有错字 */
  meaning: string;
  /** 整行原文，模型校正时一起给，便于判断 */
  raw: string;
}

export interface VocabBookEntry {
  lesson: number;
  term: string;
  reading: string;
  pos: string;
  meaning: string;
  example: string;
  exampleCn: string;
}

/** 词性归一：书里用 名/1/2/3/形1/形2 这类简写，统一成中文词性名 */
const POS_MAP: Array<[RegExp, string]> = [
  [/^名/, '名詞'],
  [/^[123]$/, '動詞'],
  [/^動/, '動詞'],
  [/^形\s*1|^イ形/, '形容詞'],
  [/^形\s*2|^ナ形/, '形容動詞'],
  [/^副/, '副詞'],
  [/^代/, '代名詞'],
  [/^疑/, '疑問詞'],
  [/^接続|^接$/, '接続詞'],
  [/^連体/, '連体詞'],
  [/^数/, '数詞'],
  [/^感|^吸|^収|^叹/, '感動詞'],
  [/^慣用|^挨拶|^あいさつ/, '慣用句'],
];

export function normalizePos(token: string): string {
  const value = token.replace(/[\s　]/g, '');
  for (const [pattern, label] of POS_MAP) {
    if (pattern.test(value)) return label;
  }
  return '';
}

const KANA = /[ぁ-んァ-ヶー]/;
const CHINESE = /[\u4e00-\u9fff]/;

/** 全角/半角括号统一，OCR 经常把 〔名〕 认成 ［名］ 或 〔名） */
function normalizeBrackets(line: string): string {
  return line
    .replace(/[［[【]/g, '〔')
    .replace(/[］\]】]/g, '〕')
    .replace(/[（(]/g, '（')
    .replace(/[）)]/g, '）');
}

function stripLead(line: string): string {
  return line.replace(/^[\s:：・,，.。◆◇○〇●•]+/, '').trim();
}

const HEADER = /^第\s*([0-9]{1,2})\s*[^\d]{0,2}$/;
const PAGE_NO = /^[0-9]{1,3}$/;
/** 一行的结构：读音（汉字）〔词性〕释义 */
const ENTRY = /^([^（〔]+?)\s*(?:（([^）]*)）)?\s*〔([^〕]*)〕\s*(.*)$/;

interface RawLine {
  x: number;
  y: number;
  text: string;
}

/**
 * 解析 OCR 文本。支持两种输入：
 * - `OCR_XY=1` 的输出（每行 `x\ty\t文字`），能精确还原双栏阅读顺序；
 * - 普通纯文本（按 `===== PAGE n =====` 分页），退化为「按行顺序」。
 */
export function parseVocabOcr(text: string): {
  rows: VocabBookRow[];
  pages: number;
  lessons: number[];
  headerGaps: number;
} {
  const pages = new Map<number, RawLine[]>();
  let page = 0;
  let hasXY = false;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const marker = raw.match(/^=+\s*PAGE\s*(\d+)/i);
    if (marker) {
      page = Number(marker[1]);
      if (!pages.has(page)) pages.set(page, []);
      continue;
    }
    const parts = raw.split('\t');
    if (parts.length >= 3 && /^[0-9.]+$/.test(parts[0].trim()) && /^[0-9.]+$/.test(parts[1].trim())) {
      hasXY = true;
      const line = { x: Number(parts[0]), y: Number(parts[1]), text: parts.slice(2).join('\t').trim() };
      const bucket = pages.get(page) ?? [];
      bucket.push(line);
      pages.set(page, bucket);
    } else {
      const bucket = pages.get(page) ?? [];
      // 没有坐标时用行号伪造 y，保持原顺序
      bucket.push({ x: 0.1, y: bucket.length + 1, text: raw.trim() });
      pages.set(page, bucket);
    }
  }

  const rows: VocabBookRow[] = [];
  const lessonOrder: number[] = [];
  let current = 0;

  for (const pageNo of [...pages.keys()].sort((a, b) => a - b)) {
    const lines = pages.get(pageNo) ?? [];
    // 双栏：左栏读完再读右栏；没有坐标时全都算左栏
    const split = hasXY ? 0.45 : 1.1;
    const left = lines.filter((line) => line.x < split).sort((a, b) => a.y - b.y);
    const right = hasXY ? lines.filter((line) => line.x >= split).sort((a, b) => a.y - b.y) : [];

    // 课号是横跨两栏的分隔线：y 坐标记下来，两侧的词条都按它切课
    const headers = left
      .concat(right)
      .map((line) => ({ y: line.y, match: line.text.trim().match(HEADER) }))
      .filter((item) => item.match && item.match[1] !== undefined)
      .map((item) => ({ y: item.y, lesson: Number(item.match![1]) }))
      .sort((a, b) => a.y - b.y);

    const pageRows: Array<{ row: VocabBookRow; y: number; column: number }> = [];
    const frags: Array<{ y: number; text: string; column: number }> = [];
    let column = 0;

    for (const line of left.concat(right)) {
      // 换到右栏时重置列号，用于给「释义碎片」找同栏的宿主
      if (hasXY && line.x >= split) column = 1;
      const cleaned = stripLead(line.text);
      if (!cleaned) continue;
      if (HEADER.test(cleaned) || PAGE_NO.test(cleaned)) continue;

      if (!KANA.test(cleaned)) {
        // 没有假名的短行多半是被切成两半的释义（「…老师」的后半句）
        if (CHINESE.test(cleaned) && cleaned.length <= 14 && !/^[・◆◇○〇●•\s]+$/.test(cleaned)) {
          frags.push({ y: line.y, text: cleaned, column });
        }
        continue;
      }

      const parsed = ENTRY.exec(normalizeBrackets(cleaned));
      let reading = '';
      let kanji = '';
      let posToken = '';
      let meaning = '';
      if (parsed) {
        reading = parsed[1].trim();
        kanji = (parsed[2] ?? '').trim();
        posToken = (parsed[3] ?? '').trim();
        meaning = parsed[4].trim();
      } else {
        // 没有〔词性〕的（多是寒暄语）：读音后面直接跟中文
        const at = cleaned.search(CHINESE);
        reading = (at > 0 ? cleaned.slice(0, at) : cleaned).trim();
        meaning = at > 0 ? cleaned.slice(at).trim() : '';
      }

      // 上一次的括号没闭合（跨行换行），接上前一段
      const prev = pageRows[pageRows.length - 1];
      if (reading === '' && prev && meaning) {
        prev.row.meaning += cleaned;
        continue;
      }

      // 课号在本行上方则用该课，否则沿用上一页的课
      let lesson = current;
      for (const header of headers) {
        if (header.y < line.y) lesson = header.lesson;
      }

      pageRows.push({
        y: line.y,
        column,
        row: { page: pageNo, lesson, reading, kanji, posToken, meaning, raw: cleaned },
      });
    }

    // 释义碎片按 y 就近贴回词条（同一行被 OCR 拆成两个框时最常见）
    for (const frag of frags) {
      let best: (typeof pageRows)[number] | null = null;
      let bestGap = 0.02;
      for (const item of pageRows) {
        const sameColumn = item.column === frag.column ? 0 : 0.004;
        const gap = Math.abs(item.y - frag.y) + sameColumn;
        if (gap < bestGap) {
          best = item;
          bestGap = gap;
        }
      }
      if (!best) continue;
      best.row.meaning = best.row.meaning ? `${best.row.meaning}${frag.text}` : frag.text;
    }

    // 下一页的课从本页最大的课号接着算：末条词条可能还在上一课，
    // 但本页出现过「第 N 課」就说明后面已经是 N 课了
    if (pageRows.length > 0 || headers.length > 0) {
      current = Math.max(
        current,
        ...headers.map((header) => header.lesson),
        ...pageRows.map((item) => item.row.lesson),
      );
    }

    for (const item of pageRows) {
      rows.push(item.row);
      if (!lessonOrder.includes(item.row.lesson)) lessonOrder.push(item.row.lesson);
    }
  }

  // 跨页的缺号同样按段均分：找到相邻两个课号，把中间的词条等分成缺的那几课
  const sorted = [...lessonOrder].sort((a, b) => a - b);
  let headerGaps = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const from = sorted[i - 1];
    const to = sorted[i];
    if (to - from <= 1) continue;
    headerGaps += to - from - 1;
    const span = rows.filter((row) => row.lesson >= from && row.lesson <= to && row.page >= 0);
    const startIdx = span.findIndex((row) => row.lesson === to);
    if (startIdx <= 0) continue;
    const missing = to - from;
    const size = Math.floor(startIdx / missing);
    for (let k = 1; k < missing; k += 1) {
      const begin = k * size;
      const end = Math.min((k + 1) * size, startIdx);
      for (let j = begin; j < end; j += 1) span[j].lesson = from + k;
    }
  }

  rows.sort((a, b) => (a.page - b.page) || 0);
  return {
    rows,
    pages: pages.size,
    lessons: [...new Set(rows.map((row) => row.lesson))].sort((a, b) => a - b),
    headerGaps,
  };
}

// ------------------------------------------------------------------ 模型校正

export const CleanSchema = z.object({
  items: z
    .array(
      z.object({
        i: z.number(),
        term: z.string().default(''),
        reading: z.string().default(''),
        pos: z.string().default(''),
        meaning: z.string().default(''),
        example: z.string().default(''),
        exampleCn: z.string().default(''),
      }),
    )
    .default([]),
});

export type CleanItem = z.infer<typeof CleanSchema>['items'][number];

const POS_SET = '名詞/動詞/形容詞/形容動詞/副詞/代名詞/疑問詞/接続詞/連体詞/数詞/感動詞/慣用句';

export function buildCleanMessages(rows: VocabBookRow[]): Array<{ role: 'system' | 'user'; content: string }> {
  const system = [
    '你是日语教材编辑，正在把一本扫描版《日本语精编词汇》的 OCR 结果整理成词条。',
    'OCR 的特点是：假名（读音）几乎不会错；括注里的汉字表记偶尔错；中文释义错字较多（例：「老师」被认成「老姉」、「職員」被认成「現景」、「企業」认成「企止」）。',
    '',
    '对每一条，请输出：',
    '1. reading：假名读音，以输入的假名为准；只在明显多字/少字时修正。',
    '2. term：词条的汉字表记。括注有汉字就用括注（按读音还原正确写法）；没有括注就用假名。不要把释义写进 term。',
    '3. pos：词性，只能取 ' + POS_SET + ' 之一；『1/2/3』这类动词分组标为「動詞」。',
    '4. meaning：简体中文释义。按读音与上下文纠正 OCR 错字，保留原书的义项顺序与范围，多个义项用「；」分隔。不要补充原书没有的义项。',
    '5. example：用 N4 以内的语法造一句 8～22 字的自然日文例句，必须用上该词。',
    '6. exampleCn：例句的简体中文翻译。',
    '',
    '硬性要求：条目数与输入完全一致，i 必须原样回传；不许合并、不许遗漏、不许新增；',
    '拿不准的释义按读音推断最可能的常见义，不要留空。只输出 JSON。',
  ].join('\n');

  const body = rows
    .map((row, index) => `${index}\t${row.lesson}\t${row.raw}`)
    .join('\n');

  const user = [
    '下面是同一本书里的连续词条，每行格式：序号<TAB>课号<TAB>OCR 原文。',
    '',
    body,
    '',
    '按 {"items":[{"i":0,"term":"","reading":"","pos":"","meaning":"","example":"","exampleCn":""}]} 返回，items 数量必须等于输入行数。',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 把模型返回的条目合并回结构解析结果：模型负责文字，结构负责课号 */
export function mergeClean(
  row: VocabBookRow,
  item: CleanItem | undefined,
): VocabBookEntry {
  const reading = (item?.reading || row.reading).trim();
  const term = (item?.term || row.kanji || row.reading).trim();
  const pos = normalizePos(item?.pos || '') || normalizePos(row.posToken);
  const meaning = (item?.meaning || row.meaning).trim();
  // 模型偶尔把释义写进 term，这里挡一下
  const safeTerm = term === meaning ? row.kanji || row.reading : term;
  return {
    lesson: row.lesson,
    term: safeTerm,
    reading,
    pos,
    meaning,
    example: (item?.example ?? '').trim(),
    exampleCn: (item?.exampleCn ?? '').trim(),
  };
}

/** 明显不是词条的行：只有读音没有释义，或是页码残渣 */
export function isUsableRow(row: VocabBookRow): boolean {
  if (row.meaning.length === 0) return false;
  if (row.reading.length === 0) return false;
  if (row.reading.length > 24) return false;
  return true;
}
