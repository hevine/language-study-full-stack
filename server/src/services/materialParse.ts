import path from 'node:path';
import zlib from 'node:zlib';
import { listLexEntries, type LexLanguage } from '../content/lexicon';
import { stripPromo, stripPromoTitle } from './sanitize';

/** 解析出来的原始文档：按页（PDF）或按章（其它格式）给出文本 */
export interface ExtractedDoc {
  text: string;
  pages: string[];
  format: string;
}

export interface ParsedUnit {
  idx: number;
  title: string;
  body: string;
  charCount: number;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface ParsedWord {
  term: string;
  reading: string | null;
  pos: string | null;
  meaning: string | null;
  example: string | null;
  unitIdx: number;
  freq: number;
  inLexicon: boolean;
}

// ---------------------------------------------------------------- 文本抽取

const decodeEntities = (input: string): string =>
  input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));

/** HTML/XHTML → 纯文本：块级标签换行，去掉脚本与样式 */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote)>/gi, '\n\n')
      .replace(/<h([1-6])[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** 极简 ZIP 读取（EPUB / DOCX 都是标准 zip，只需要中央目录 + inflateRaw） */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const minEocd = Math.max(0, buffer.length - 66_000);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/epub 文件');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  for (const entry of entries) {
    if (entry.compressedSize === 0) continue;
    const localOffset = entry.localOffset;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const nameLength = buffer.readUInt16LE(localOffset + 26);
    const extraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLength + extraLength;
    const data = buffer.slice(start, start + entry.compressedSize);
    try {
      result.set(
        entry.name,
        entry.method === 0 ? data : zlib.inflateRawSync(data),
      );
    } catch {
      // 单条目损坏不影响整体
    }
  }
  return result;
}

/** 按 OPF 的 spine 顺序取 EPUB 正文文件；取不到就按文件名排序 */
function epubChapterFiles(files: Map<string, Buffer>): string[] {
  const all = [...files.keys()];
  const opfPath = all.find((name) => name.toLowerCase().endsWith('.opf'));
  const htmlFiles = all.filter((name) => /\.(x?html?)$/i.test(name) && !/nav|toc|cover/i.test(name));

  if (opfPath) {
    const opf = files.get(opfPath)?.toString('utf8') ?? '';
    const base = path.posix.dirname(opfPath);
    const manifest = new Map<string, string>();
    for (const match of opf.matchAll(/<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*>/gi)) {
      manifest.set(match[1], match[2]);
    }
    for (const match of opf.matchAll(/<item\b[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      manifest.set(match[2], match[1]);
    }
    const spine: string[] = [];
    for (const match of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/gi)) {
      const href = manifest.get(match[1]);
      if (!href) continue;
      const resolved = path.posix.normalize(path.posix.join(base, decodeURIComponent(href.split('#')[0])));
      if (files.has(resolved)) spine.push(resolved);
    }
    if (spine.length > 0) return spine;
  }
  return htmlFiles.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function pdfText(buffer: Buffer): Promise<{ text: string; pages: string[] }> {
  const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
    default: (data: Buffer, options?: Record<string, unknown>) => Promise<{ text: string; numpages: number }>;
  };
  const pages: string[] = [];
  const parsed = await mod.default(buffer, {
    pagerender: async (pageData: {
      getTextContent: (options: Record<string, unknown>) => Promise<{ items: Array<{ str: string; transform: number[] }> }>;
    }) => {
      const content = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      let text = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        const y = item.transform?.[5] ?? 0;
        if (lastY === null) text = item.str;
        else if (Math.abs(y - lastY) < 1) text += item.str;
        else text += `\n${item.str}`;
        lastY = y;
      }
      pages.push(text);
      return text;
    },
  });
  return { text: parsed.text ?? pages.join('\n\n'), pages };
}

export async function extractDocument(buffer: Buffer, fileName: string): Promise<ExtractedDoc> {
  const doc = await extractDocumentRaw(buffer, fileName);
  // 电子书/讲义里的网校署名、下载站水印、公众号与裸链接统一在这里剥掉
  return {
    ...doc,
    text: stripPromo(doc.text),
    pages: doc.pages.map((page) => stripPromo(page)).filter((page) => page.length > 0),
  };
}

async function extractDocumentRaw(buffer: Buffer, fileName: string): Promise<ExtractedDoc> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.pdf') {
    const { text, pages } = await pdfText(buffer);
    return { text, pages, format: 'pdf' };
  }

  if (ext === '.epub') {
    const files = readZip(buffer);
    const chapters = epubChapterFiles(files)
      .map((name) => htmlToText(files.get(name)?.toString('utf8') ?? ''))
      .filter((text) => text.length > 40);
    return { text: chapters.join('\n\n'), pages: chapters, format: 'epub' };
  }

  if (ext === '.docx') {
    const files = readZip(buffer);
    const xml = files.get('word/document.xml')?.toString('utf8') ?? '';
    if (!xml) throw new Error('docx 结构异常：找不到 word/document.xml');
    const text = decodeEntities(
      xml
        .replace(/<w:tab[^>]*\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n\n')
        .replace(/<[^>]+>/g, ''),
    )
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, pages: [], format: 'docx' };
  }

  if (ext === '.html' || ext === '.htm') {
    return { text: htmlToText(buffer.toString('utf8')), pages: [], format: 'html' };
  }

  // txt / md / 其它纯文本
  return { text: buffer.toString('utf8').replace(/\r\n?/g, '\n'), pages: [], format: ext.replace('.', '') || 'txt' };
}

/** PDF 抽取出来的是视觉行：需要把断行接回自然段，并修复被切断的单词 */
function reflowLines(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, '').trim())
    .filter((line) => line.length > 0);

  const paragraphs: string[] = [];
  let current = '';
  for (const line of lines) {
    if (HEADING_RE.test(line) && line.length <= 48) {
      if (current) paragraphs.push(current);
      paragraphs.push(line);
      current = '';
      continue;
    }
    if (!current) {
      current = line;
    } else if (/[A-Za-z]-$/.test(current) && /^[a-z]/.test(line)) {
      // 行末连字符断词：去掉连字符直接接上（govern- / ment → government）
      current = `${current.slice(0, -1)}${line}`;
    } else if (/[A-Za-z]$/.test(current) && /^[a-z]/.test(line)) {
      // 只是换行、并非断词：必须补一个空格，否则 ice + was 会粘成 icewas
      current += ` ${line}`;
    } else if (/[\u3040-\u30ff\u4e00-\u9fff]$/.test(current) || /^[\u3040-\u30ff\u4e00-\u9fff]/.test(line)) {
      current += line;
    } else {
      current = `${current} ${line}`;
    }
    if (/[.!?。！？][)"'”’]*$/.test(current) && current.length > 120) {
      paragraphs.push(current);
      current = '';
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.join('\n\n');
}

// ---------------------------------------------------------------- 切分章节

const HEADING_RE =
  /^(?:第\s*[0-9一二三四五六七八九十百零]+\s*[章節节課课講讲部篇]|Chapter\s+[0-9IVXLC]+|UNIT\s+[0-9]+|Unit\s+[0-9]+|Part\s+[0-9IVX]+|Lesson\s+[0-9]+|レッスン\s*[0-9０-９]+|제\s*[0-9]+\s*[과장])(?![\p{L}\p{N}])/iu;

/** 「PASSAGE 12」这类行内篇目标记（老托福精读、托福阅读真题常见），用来按篇切章 */
const PASSAGE_RE = /\bPASSAGE\s+([0-9]{1,3})\b/gi;

/**
 * 按「PASSAGE n」标记切篇：标记可能藏在段落中间、也可能落在页首页尾，
 * 所以逐页扫描偏移量再跨页拼接，避免一篇被页边界劈成两半。
 */
function splitByPassages(pages: string[]): ParsedUnit[] | null {
  const cleaned = pages.map((page, index) => ({ page: index + 1, text: reflowLines(stripPromo(page)) }));
  const marks: Array<{ no: string; page: number; offset: number }> = [];
  for (const { page, text } of cleaned) {
    for (const match of text.matchAll(PASSAGE_RE)) {
      marks.push({ no: match[1], page, offset: match.index ?? 0 });
    }
  }
  if (marks.length < 5) return null;

  const units: ParsedUnit[] = [];
  marks.forEach((mark, i) => {
    const startIdx = mark.page - 1;
    const next = marks[i + 1];
    const endIdx = next ? next.page - 1 : cleaned.length - 1;
    let body = '';
    for (let p = startIdx; p <= endIdx; p += 1) {
      const from = p === startIdx ? mark.offset : 0;
      const to = p === endIdx ? (next ? next.offset : cleaned[p].text.length) : cleaned[p].text.length;
      body += `${cleaned[p].text.slice(from, to)}\n\n`;
    }
    body = body
      .replace(PASSAGE_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body.length < 200) return;
    units.push({
      idx: units.length,
      title: `Passage ${mark.no}`,
      body,
      charCount: body.length,
      pageFrom: mark.page,
      pageTo: cleaned[endIdx].page,
    });
  });
  return units.length >= 3 ? units : null;
}

/** 按「页」切：一页一章，短页合并；再按标题/长度二次切分 */
export function splitIntoUnits(doc: ExtractedDoc): ParsedUnit[] {
  if (doc.pages.length > 0) {
    const byPassage = splitByPassages(doc.pages);
    if (byPassage) return byPassage;
  }

  const chunks: Array<{ text: string; pageFrom: number | null; pageTo: number | null }> = [];

  if (doc.pages.length > 0) {
    // 先剥推广尾巴再拼接：页脚广告夹在段中间会把句子劈断
    doc = { ...doc, pages: doc.pages.map((page) => reflowLines(stripPromo(page))) };
    let buffer = '';
    let startPage: number | null = null;
    let endPage: number | null = null;
    doc.pages.forEach((page, index) => {
      const pageNo = index + 1;
      buffer += `${page.trim()}\n\n`;
      if (startPage === null) startPage = pageNo;
      endPage = pageNo;
      if (buffer.length >= 4200) {
        chunks.push({ text: buffer.trim(), pageFrom: startPage, pageTo: endPage });
        buffer = '';
        startPage = null;
        endPage = null;
      }
    });
    if (buffer.trim()) chunks.push({ text: buffer.trim(), pageFrom: startPage, pageTo: endPage });
  } else {
    chunks.push({ text: stripPromo(doc.text), pageFrom: null, pageTo: null });
  }

  const units: ParsedUnit[] = [];
  for (const chunk of chunks) {
    const paragraphs = stripPromo(chunk.text).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    let current: string[] = [];
    let currentTitle = '';
    const flush = () => {
      const body = current.join('\n\n').trim();
      if (body.length < 60) {
        current = [];
        return;
      }
      units.push({
        idx: units.length,
        title: currentTitle ? stripPromoTitle(currentTitle) : `第 ${units.length + 1} 节`,
        body,
        charCount: body.length,
        pageFrom: chunk.pageFrom,
        pageTo: chunk.pageTo,
      });
      current = [];
      currentTitle = '';
    };

    for (const paragraph of paragraphs) {
      const firstLine = paragraph.split('\n')[0].trim();
      const isHeading = firstLine.length > 0 && firstLine.length <= 40 && HEADING_RE.test(firstLine);
      if (isHeading) {
        flush();
        currentTitle = firstLine.replace(/\s+/g, ' ');
        current.push(paragraph.slice(firstLine.length).trim());
        continue;
      }
      current.push(paragraph);
      if (current.join('\n\n').length > 5200) flush();
    }
    flush();
  }

  if (units.length === 0 && doc.text.trim().length > 0) {
    const text = doc.text.trim();
    for (let i = 0; i < text.length; i += 5000) {
      const body = text.slice(i, i + 5000);
      units.push({
        idx: units.length,
        title: `第 ${units.length + 1} 节`,
        body,
        charCount: body.length,
        pageFrom: null,
        pageTo: null,
      });
    }
  }
  return units.map((unit, index) => ({ ...unit, idx: index }));
}

// ---------------------------------------------------------------- 词条抽取

const EN_STOP = new Set(
  `the a an and or but if while of to in on at for with from by as is are was were be been being it its this that these those
  you your we our they their he she his her him them i me my not no do does did done have has had will would can could
  should may might must there here what which who whom whose when where why how than then so such very more most much
  many some any all both each other another into over under about after before during between through because although
  however therefore thus also just only even still yet per via within without upon among across behind beyond`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * 托福/雅思阅读题干里的套话：passage、according、author 这类词在全书的题干里高频出现，
 * 会挤掉真正的生词名额，抽词时直接跳过。
 */
const EXAM_STEM = new Set(
  `passage passages author authors according states stated statement statements closest following meaning
  except select sentence sentences paragraph paragraphs mentioned mention implies imply suggests suggest
  probably primarily purpose discusses discuss indicates indicate infer choose answer answers question questions
  refers refer describe main mainly chiefly least best`
    .split(/\s+/)
    .filter(Boolean),
);

const JA_PARTICLES = new Set([
  'の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し', 'れ', 'さ', 'ある', 'いる', 'する', 'から', 'まで', 'より',
  'など', 'こと', 'もの', 'ため', 'よう', 'そう', 'この', 'その', 'あの', 'という', 'について', 'によって',
]);

const KO_STOP = new Set([
  '그리고', '그러나', '하지만', '그래서', '또는', '때문에', '있습니다', '합니다', '하는', '있는', '것은', '것을', '수가',
  '이는', '이런', '저런', '그런', '우리', '여러분', '그것', '이것', '저것', '때문', '위해', '대해', '통해',
]);

const sentenceOf = (text: string, term: string): string | null => {
  const index = text.indexOf(term);
  if (index < 0) return null;
  const boundaries = /[.!?。！？\n]/;
  let start = index;
  while (start > 0 && !boundaries.test(text[start - 1])) start -= 1;
  let end = index + term.length;
  while (end < text.length && !boundaries.test(text[end])) end += 1;
  const sentence = text.slice(start, Math.min(end + 1, start + 180)).trim();
  return sentence.length > 12 ? sentence : null;
};

const JA_ACCENT_RE = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⓪]/;
const JA_POS_RE =
  /(名詞|名|動詞|動|动|形動|形动|形容詞|形|副詞|副|助詞|助|接続詞|接|感動詞|感|連体詞|连|数詞|数|量詞|量|代名詞|代|他動|自動|サ変|スル)/;

/**
 * 教材「生词表」行解析：标日一类教材的排版是
 *   食べる（たべる） ② 动1 吃
 *   スペース ② 名 空间
 * 认不出来就返回 null —— 宁可漏收，也不要把正文句子当成词条。
 */
function parseJaVocabLine(line: string, unitIdx: number): ParsedWord | null {
  const trimmed = line.trim();
  if (trimmed.length < 4 || trimmed.length > 46) return null;
  if (/[。！？!?]$/.test(trimmed)) return null;

  const rest = trimmed.replace(/^\d{1,3}\s*[.、．)）]?\s*/, '');
  const match = rest.match(
    /^([\u4e00-\u9fff\u3040-\u30ffー]{1,12})(?:\s*[（(]([\u3040-\u30ff\u4e00-\u9fffー]{1,20})[）)])?\s*(.*)$/,
  );
  if (!match) return null;

  let term = match[1];
  let reading = match[2] ?? null;
  // 标日式排版会把汉字词写成「であう（出会う）」：括号里是汉字，外面是假名，这里对调回来
  if (reading && /[\u4e00-\u9fff]/.test(reading) && !/[\u4e00-\u9fff]/.test(term)) {
    [term, reading] = [reading, term];
  }
  let tail = match[3].replace(new RegExp(JA_ACCENT_RE.source, 'g'), ' ').trim();

  // 必须带假名或词性标记，否则很可能只是正文句子
  const posMatch = tail.match(JA_POS_RE);
  if (!reading && !posMatch) return null;
  if (posMatch?.index !== undefined) {
    tail = `${tail.slice(0, posMatch.index)}${tail.slice(posMatch.index + posMatch[0].length)}`;
  }

  const meaning = tail
    // 「名・动」「动1」这类词性尾巴一起吃掉，避免混进释义
    .replace(/^[\s・·/]*(?:(?:名|动|動|形|副|助|连|連|接|感|数|量|代|他|自)[0-9]?[\s・·/]*)+/, '')
    .replace(/^[0-9]+\s*/, '')
    .replace(/^[-–—:：·\s]+/, '')
    .trim();
  if (!meaning || meaning.length > 24) return null;
  if (!/[\u4e00-\u9fff]/.test(meaning)) return null;

  return {
    term,
    reading: reading ?? (/^[\u3040-\u30ffー]+$/.test(term) ? term : null),
    pos: posMatch?.[1] ?? null,
    meaning,
    example: null,
    unitIdx,
    freq: 1,
    inLexicon: true,
  };
}

/** 扫描所有章节里的生词表行，得到「可背诵」的词条（带读音与中文释义） */
function parseJaVocabTables(units: ParsedUnit[]): ParsedWord[] {
  const words: ParsedWord[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    for (const line of unit.body.split('\n')) {
      const word = parseJaVocabLine(line, unit.idx);
      if (!word || seen.has(word.term)) continue;
      seen.add(word.term);
      word.example = sentenceOf(unit.body, word.term);
      words.push(word);
    }
  }
  return words;
}

export function extractWords(units: ParsedUnit[], language: LexLanguage): ParsedWord[] {
  const lexicon = listLexEntries(language);
  const byTerm = new Map(lexicon.map((entry) => [entry.term.toLowerCase(), entry]));
  const result = new Map<string, ParsedWord>();

  const push = (term: string, unitIdx: number, inLexicon: boolean) => {
    const key = term.toLowerCase();
    const existing = result.get(key);
    if (existing) {
      existing.freq += 1;
      return;
    }
    const entry = byTerm.get(key);
    result.set(key, {
      term: inLexicon && entry ? entry.term : term,
      reading: entry?.reading ?? null,
      pos: entry?.pos ?? null,
      meaning: entry?.cn ?? null,
      example: sentenceOf(units[unitIdx]?.body ?? '', inLexicon && entry ? entry.term : term),
      unitIdx,
      freq: 1,
      inLexicon,
    });
  };

  if (language === 'en') {
    for (const unit of units) {
      const tokens = unit.body.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
      const counts = new Map<string, number>();
      for (const token of tokens) {
        const clean = token.replace(/^[-']+|[-']+$/g, '');
        if (!clean || EN_STOP.has(clean) || EXAM_STEM.has(clean)) continue;
        counts.set(clean, (counts.get(clean) ?? 0) + 1);
      }
      for (const [term, freq] of counts) {
        const existing = result.get(term);
        if (existing) {
          existing.freq += freq;
          continue;
        }
        const entry = byTerm.get(term);
        result.set(term, {
          term: entry?.term ?? term,
          reading: entry?.reading ?? null,
          pos: entry?.pos ?? null,
          meaning: entry?.cn ?? null,
          example: sentenceOf(unit.body, term),
          unitIdx: unit.idx,
          freq,
          inLexicon: Boolean(entry),
        });
      }
    }
    // 英文在没有词典释义时也保留高频词，供界面标记「待补释义」
    return [...result.values()]
      .filter((word) => word.inLexicon || (word.freq >= 2 && word.term.length >= 6))
      .sort((a, b) => b.freq - a.freq)
      .slice(0, 1200);
  }

  // 日语 / 韩语：以「词库中确实出现过的词」为准（有假名/释义，才可直接用于背诵）
  // 日语额外先扫一遍教材自带的生词表：书里给了读音+释义的词，比词库覆盖率更重要
  if (language === 'ja') {
    for (const word of parseJaVocabTables(units)) {
      if (!result.has(word.term)) result.set(word.term, word);
    }
  }

  for (const entry of lexicon) {
    let total = 0;
    let firstUnit = -1;
    let example: string | null = null;
    for (const unit of units) {
      const occurrences = unit.body.split(entry.term).length - 1;
      if (occurrences <= 0) continue;
      total += occurrences;
      if (firstUnit < 0) {
        firstUnit = unit.idx;
        example = sentenceOf(unit.body, entry.term);
      }
    }
    if (total === 0) continue;

    const existing = result.get(entry.term);
    if (existing) {
      existing.freq += total;
      existing.meaning = existing.meaning ?? entry.cn;
      existing.reading = existing.reading ?? entry.reading ?? null;
      existing.example = existing.example ?? example;
      continue;
    }

    result.set(entry.term, {
      term: entry.term,
      reading: entry.reading ?? null,
      pos: entry.pos ?? null,
      meaning: entry.cn,
      example,
      unitIdx: firstUnit,
      freq: total,
      inLexicon: true,
    });
  }

  // 再补一层：书中反复出现、但词库没收录的「汉字词 / 语节」，只在韩语里保留频率信息
  if (language === 'ko') {
    for (const unit of units) {
      const tokens = unit.body.match(/[가-힣]{2,}/g) ?? [];
      for (const token of tokens) {
        if (KO_STOP.has(token)) continue;
        const entry = result.get(token);
        if (entry) {
          if (!entry.inLexicon) entry.freq += 1;
          continue;
        }
        if (token.length < 3) continue;
        result.set(token, {
          term: token,
          reading: null,
          pos: null,
          meaning: null,
          example: sentenceOf(unit.body, token),
          unitIdx: unit.idx,
          freq: 1,
          inLexicon: false,
        });
      }
    }
  }

  return [...result.values()]
    .filter((word) => word.inLexicon ? true : word.freq >= 3 && !JA_PARTICLES.has(word.term))
    .sort((a, b) => b.freq - a.freq);
}

// ---------------------------------------------------------------- 级别 / 类型识别

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };

/**
 * 从文件名猜级别：N2／二级／2級／零基础 都能认出来。
 * 认不出就返回 null（教材仍可导入，只是不参与分级推进）。
 */
export function detectMaterialLevel(fileName: string, language: LexLanguage): string | null {
  const name = fileName.replace(/[+＋]/g, ' ');

  if (language === 'ja') {
    const direct = name.match(/N\s*([1-5])(?![0-9])/i);
    if (direct) return `n${direct[1]}`;
    const cn = name.match(/([一二三四五1-5])\s*级/);
    if (cn) {
      const num = CN_NUM[cn[1]] ?? Number(cn[1]);
      if (num >= 1 && num <= 5) return `n${num}`;
    }
    if (/零基础|0\s*基础|入门/.test(name)) return 'n5';
    return null;
  }

  if (language === 'ko') {
    const match = name.match(/([1-6])\s*级/);
    if (match) return `ko${match[1]}`;
    if (/初级|入门/.test(name)) return 'ko1';
    if (/中级/.test(name)) return 'ko3';
    if (/高级/.test(name)) return 'ko5';
    return null;
  }

  if (/advanced|进阶|高分/i.test(name)) return 'advanced';
  if (/core|核心/i.test(name)) return 'core';
  if (/basic|基础|入门/i.test(name)) return 'basic';
  return null;
}

/** 从文件名猜类型：词表 / 答疑 → 不进精读，只做词汇或纯参考 */
export function detectMaterialKind(fileName: string): 'textbook' | 'vocab' | 'notes' {
  if (/語彙|語汇|词汇|单词|词组|短语|单词表|word\s*list/i.test(fileName)) return 'vocab';
  if (/答疑|问答|整理|笔记|讲义|tips|まとめ/i.test(fileName)) return 'notes';
  return 'textbook';
}

/** 去掉下载站前缀与扩展名，得到干净的教材标题 */
export function cleanMaterialTitle(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/^\s*\[[^\]]+\]\s*[+＋]?\s*/, '')
    .replace(/[_]+/g, ' ')
    .trim();
}
