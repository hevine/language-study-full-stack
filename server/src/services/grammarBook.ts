/**
 * 本地语法书（《精编语法》这类句型手册）的解析与取用。
 *
 * 入库时一个句型一条 material_units（title = 句型，body = 接续/释义/类义/例句/译文），
 * 出题时按天数轮换取 2–3 条，塞进「AI 加练 · 拆句」的提示词里 —— 这样加练的句子
 * 用的是用户自己那本书里的句型，而不是模型凭感觉挑的。
 */
import type { Language } from '../domain/language';
import type { GeneratedDay, PlanRecord } from '../domain/types';
import { listMaterials, listUnits, type MaterialRecord, type MaterialUnitRecord } from '../repositories/materials';
import { planLevelWindow } from './curriculum';

export interface GrammarPattern {
  /** 句型本身，如「～あげくに（の）」 */
  pattern: string;
  /** 接续，如「［动词过去形；体言の］＋あげくに」 */
  keigu: string;
  /** 中文释义 */
  gist: string;
  /** 类义形（可能为空） */
  similar: string[];
  /** 日文例句 */
  example: string;
  /** 例句中文翻译 */
  translation: string;
  /** 原书整段（兜底给模型看） */
  raw: string;
}

const JAPANESE = /[\u3040-\u30ff]/;
const CHINESE = /[\u4e00-\u9fff]/;
const BRACKET_HEAD = /^【(.+?)】\s*(.*)$/;
const KEIGU_HEAD = /^(［|\[|接在|接续|前接|前面为|名词|动词|用言|体言)/;
const SIMILAR_HEAD = /^类义(形|语)/;

/** 日文例句：有假名、有一定长度、以句末符号收尾；接续行一律不算（「体言+さえ+…『-ば』」也以」收尾） */
function looksJapanese(line: string): boolean {
  if (KEIGU_HEAD.test(line)) return false;
  return JAPANESE.test(line) && line.replace(/\s/g, '').length >= 8 && /[。、！？…」]$/.test(line);
}

/** 中文释译：只有汉字（允许标点与「～」），且不含假名 */
function looksChinese(line: string): boolean {
  return !JAPANESE.test(line) && CHINESE.test(line) && line.replace(/\s/g, '').length >= 3;
}

/**
 * 把整本书的文本切成语法条目。
 * 文档里每条都以【句型】开头，所以先按【切块，块内再按行归类；
 * 归类失败时保留原文，出题时整段给模型看，不至于丢内容。
 *
 * 注意：不要按句末标点做「折行合并」——接续行（用言连体形+かぎり）本身不带标点，
 * 一合并就把接续和释义粘成一条，反而全废。折行只在「接在…表示…」那种一行写两件事时
 * 单独切断（见下面的 split）。
 */
export function parseGrammarBook(text: string): GrammarPattern[] {
  const patterns: GrammarPattern[] = [];
  const blocks = text.split(/(?=【)/);

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const head = lines[0].match(BRACKET_HEAD);
    if (!head) continue;

    const pattern = head[1].trim();
    const tail = head[2]?.trim();
    const body = [...(tail ? [tail] : []), ...lines.slice(1)];

    // 类义形可能占多行：从「类义形：」开始，遇到例句就停
    const similar: string[] = [];
    const rest: string[] = [];
    let inSimilar = false;
    for (const line of body) {
      if (SIMILAR_HEAD.test(line)) {
        inSimilar = true;
        similar.push(line.replace(/^类义(形|语)[：:]\s*/, '').trim());
        continue;
      }
      if (inSimilar && !looksJapanese(line) && !KEIGU_HEAD.test(line)) {
        // 「～いかんによる／取决于～」这类续行
        if (line.includes('～')) {
          similar.push(line);
          continue;
        }
        inSimilar = false;
      } else if (inSimilar && (looksJapanese(line) || KEIGU_HEAD.test(line))) {
        inSimilar = false;
      }
      rest.push(line);
    }

    let keigu = '';
    let gist = '';
    let example = '';
    let translation = '';

    // 先在「类义形」之后把例句区切出来：结构上永远是「…例句 → 中文译文」收尾，
    // 靠这个定位比靠「像不像日文」可靠——释义里常引用日文词（多接「驚く、困る」等）。
    const lastIdx = rest.length - 1;
    if (lastIdx >= 0 && looksChinese(rest[lastIdx])) {
      translation = rest[lastIdx];
    }
    const exampleEnd = translation ? lastIdx - 1 : lastIdx;
    // 例句区从第一句「像日文」的行开始；它前面的都是接续/释义
    let exampleStart = -1;
    for (let i = 0; i <= exampleEnd; i += 1) {
      if (looksJapanese(rest[i])) {
        exampleStart = i;
        break;
      }
    }
    if (exampleStart >= 0) {
      example = rest.slice(exampleStart, exampleEnd + 1).join('');
    } else {
      exampleStart = exampleEnd + 1;
    }

    const headLines = rest.slice(0, exampleStart);
    for (const line of headLines) {
      if (!keigu && (KEIGU_HEAD.test(line) || (!looksJapanese(line) && /[＋丨]/.test(line)))) {
        // 「接在…之后，表示…」一行写两件事：从中断开
        const split = line.match(/^(.{4,}?)[，,]?\s*表示(.+)$/);
        // 「［动词未然形］＋…／想～也（不）～」接续与释义用斜杠隔开
        const slash = line.match(/^(.{4,}?)[／/]\s*(.+)$/);
        if (split) {
          keigu = split[1].trim();
          if (!gist) gist = split[2].trim();
        } else if (slash && CHINESE.test(slash[2])) {
          keigu = slash[1].trim();
          if (!gist) gist = slash[2].trim();
        } else {
          keigu = line;
        }
        continue;
      }
      if (!gist && looksChinese(line)) {
        gist = line;
        continue;
      }
      // 释义写成多行（①… ②…）时接在后面
      if (gist && looksChinese(line) && !looksJapanese(line)) gist = `${gist}${line}`;
    }

    // 书里有的条目释义夹着假名（「不能不～（ず是否定）」），按中文判定会判空：
    // 兜底取接续之后的第一行，总比没有强
    if (!gist) {
      const fallback = headLines.find((line) => line !== keigu && line.length >= 3);
      if (fallback) gist = fallback;
    }

    // 接续被折行截断（「…＋ま」／「いと」）：后面那一小截纯假名的接回去
    if (keigu) {
      const at = headLines.indexOf(keigu);
      const next = at >= 0 ? headLines[at + 1] : undefined;
      if (next && next.length <= 6 && !CHINESE.test(next)) keigu = `${keigu}${next}`;
    }
    // 原书有些条目自带「接续：」「释义：」前缀，剥掉免得拼出「接续：接续：…」
    const strip = (text: string): string => text.replace(/^(接续|释义)[：:]\s*/, '').trim();
    patterns.push({
      pattern,
      keigu: strip(keigu),
      gist: strip(gist),
      similar: similar.filter(Boolean),
      example,
      translation,
      raw: block.replace(/\s*\n\s*/g, '\n').trim(),
    });
  }

  return dedupe(patterns);
}

/** 同一个句型可能在书里重复出现（续页、索引），保留信息更全的那条 */
function dedupe(patterns: GrammarPattern[]): GrammarPattern[] {
  const byName = new Map<string, GrammarPattern>();
  const score = (pattern: GrammarPattern): number =>
    (pattern.gist ? 2 : 0) + (pattern.example ? 1 : 0) + (pattern.keigu ? 1 : 0);
  for (const pattern of patterns) {
    const key = pattern.pattern.replace(/[\s～~]/g, '');
    const existing = byName.get(key);
    if (!existing || score(pattern) > score(existing)) byName.set(key, pattern);
  }
  return [...byName.values()];
}

/**
 * 能不能拿来出题：有释义最好；书里本来就没写释义的条目，只要接续和例句都在，
 * 也够模型照着造句（提示词里会说明「原书未标注释义」）。
 */
export function isUsablePattern(pattern: GrammarPattern): boolean {
  if (pattern.pattern.length <= 1) return false;
  return pattern.gist.length > 0 || (pattern.keigu.length > 0 && pattern.example.length > 0);
}

function hash(input: string): number {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** 计划里能用的语法书：级别落在这份计划的区间内（当前水平 → 目标级别） */
export function grammarBooksFor(plan: PlanRecord): MaterialRecord[] {
  const window = planLevelWindow(plan);
  const order = new Map(window.levels.map((level, index) => [level.id, index]));
  return listMaterials(plan.language as Language, { kind: 'grammar' })
    .filter((material) => material.status === 'ready')
    .filter((material) => !material.level || order.has(material.level))
    .sort((a, b) => (order.get(b.level ?? '') ?? -1) - (order.get(a.level ?? '') ?? -1));
}

export interface GrammarPick {
  materialTitle: string;
  patterns: GrammarPattern[];
}

/**
 * 今天轮到哪几个句型。
 * 同一天重复生成拿到同一批（不然「再生成一批」会跳到完全无关的句型），
 * 换一天自动往后挪，一本书用完再从头开始。
 */
export function grammarPatternsFor(plan: PlanRecord, day: GeneratedDay, count = 3): GrammarPick | null {
  const books = grammarBooksFor(plan);
  if (books.length === 0) return null;

  const picked: GrammarPattern[] = [];
  let materialTitle = '';
  const dayIndex = day.weekIndex * 7 + day.dayIndex;

  for (const book of books) {
    const patterns = listUnits(book.id)
      .map((unit: MaterialUnitRecord) => unitToPattern(unit))
      .filter(isUsablePattern);
    if (patterns.length === 0) continue;
    if (!materialTitle) materialTitle = book.title;
    const start = (dayIndex * count + hash(book.id) % 7) % patterns.length;
    // 书是按五十音排的，连着取三条会是同一个活用形的近邻句型（三个都是意志形），
    // 按等距跨步取，一天里能覆盖到书的不同章节
    const stride = Math.max(1, Math.floor(patterns.length / count));
    for (let i = 0; i < count && picked.length < count; i += 1) {
      picked.push(patterns[(start + i * stride) % patterns.length]);
    }
    if (picked.length >= count) break;
  }

  return picked.length > 0 ? { materialTitle, patterns: picked.slice(0, count) } : null;
}

/** 单元正文是按固定小标题存的，这里还原成结构；万一格式对不上，退回整段 */
export function unitToPattern(unit: MaterialUnitRecord): GrammarPattern {
  const read = (label: string): string => {
    const match = unit.body.match(new RegExp(`^${label}：(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  };
  const similarBlock = unit.body.match(/^类义：([\s\S]*?)(?:\n例句：|$)/m);
  return {
    pattern: unit.title.trim(),
    keigu: read('接续'),
    gist: read('释义'),
    similar: similarBlock
      ? similarBlock[1]
          .split(/\n/)
          .map((line) => line.replace(/^・/, '').trim())
          .filter(Boolean)
      : [],
    example: read('例句'),
    translation: read('译文'),
    raw: unit.body.trim(),
  };
}

/** 给模型看的紧凑格式：只保留造句需要的字段，避免整段原文烧 token */
export function formatPatternForPrompt(pattern: GrammarPattern): string {
  const lines = [`句型：${pattern.pattern}`];
  if (pattern.keigu) lines.push(`接续：${pattern.keigu}`);
  // 释义偶尔混进了书里的第二条释义或例句，截前 60 字足够点明意思
  if (pattern.gist) {
    const gist = pattern.gist.length > 60 ? `${pattern.gist.slice(0, 60)}…` : pattern.gist;
    lines.push(`释义：${gist}`);
  }
  if (pattern.similar.length > 0) lines.push(`类义：${pattern.similar.slice(0, 3).join('；')}`);
  if (pattern.example) lines.push(`原书例句：${pattern.example.slice(0, 90)}`);
  if (pattern.translation) lines.push(`例句译文：${pattern.translation.slice(0, 60)}`);
  return lines.join('\n');
}
