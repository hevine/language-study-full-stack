/**
 * JLPT 分级词汇总库导入脚本
 *
 * 数据源（教研提供，md 与 xlsx 已逐行核对一致）：
 *   - JLPT分级词汇总库_N1_全量10000条.md —— 权威主源
 *       · 核心表 10000 条（N5 800 / N4 1500 / N3 1400 / N2 2300 / N1 4000）
 *       · 「精讲层与分轮补充」表 10000 条 16 列全字段（2026-11-27 补充版，全库已精讲化）
 *   - 旧版回退：若 N1 文件没有全量精讲表，则从 N5/N4 精讲库 + N3/N2/N1 各自的精讲层补
 *   - scripts/jlpt-supplement.json —— 主表漏收、按题目考点回补的词（当前 10 条）。
 *       独立成文件，教研主表将来重导时不会把它们冲掉；只续号，不改主表已有编码。
 *
 * 产出：server/src/content/jlpt-graded.json
 *   结构 { source, levels:[{id,name,count}], words:[...] }
 *   每条 word：
 *     基础字段 code/term/kana/pos/cn/theme/freq/level（10000 条都有）
 *     精讲字段 mnemonic/example/exampleCn/inflections/syn/ant/derivation（detailed 为 true 时完整）
 *     detailed: boolean —— 是否有完整精讲字段
 *
 * 用法：
 *   tsx scripts/importJlptGraded.ts --check   # 只校验源数据
 *   tsx scripts/importJlptGraded.ts --out server/src/content/jlpt-graded.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const checkOnly = process.argv.includes('--check');

const BASE = '/Users/zhua/Doubao/chats/2026-11-26/new-chat';
const MAIN = `${BASE}/JLPT分级词汇总库_N1_全量10000条.md`;
const N3FILE = `${BASE}/JLPT分级词汇总库_N3_全量3700条.md`;
const N2FILE = `${BASE}/JLPT分级词汇总库_N2_全量6000条.md`;
const N5DETAIL = `${BASE}/JLPT分级词汇精讲库_全量_N5_800条.md`;
const N4DETAIL = `${BASE}/JLPT分级词汇精讲库_全量_N4_1500条.md`;
const SUPPLEMENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jlpt-supplement.json');

const LEVEL_NAME: Record<string, string> = {
  N5: 'N5 入门词',
  N4: 'N4 基础词',
  N3: 'N3 核心词',
  N2: 'N2 高频词',
  N1: 'N1 拉分词',
};
const LEVEL_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];
const clean = (s: string): string => s.replace(/\*\*/g, '').trim();

type Word = {
  code: string;
  term: string;
  kana: string;
  pos: string;
  cn: string;
  theme: string;
  freq: string;
  level: string;
  mnemonic: string;
  example: string;
  exampleCn: string;
  inflections: string;
  syn: string;
  ant: string;
  derivation: string;
  detailed: boolean;
};

const DETAIL_KEYS = ['mnemonic', 'example', 'exampleCn', 'inflections', 'syn', 'ant', 'derivation'] as const;

function parseMarkdown(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n');
}

function cellsOf(line: string): string[] {
  return line.trim().slice(1, -1).split('|').map(clean);
}

/** 解析核心表（9 列）：从「## 全量词表」到下一个 ## */
function parseCore(lines: string[]): Word[] {
  const rows: Word[] = [];
  let header: string[] | null = null;
  let inSection = false;
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('## 全量词表')) {
      inSection = true;
      header = null;
      continue;
    }
    if (inSection && /^## /.test(s)) {
      inSection = false;
      continue;
    }
    if (!inSection || !s.startsWith('|')) continue;
    const cells = cellsOf(line);
    if (cells[0] === 'code') {
      header = cells;
      continue;
    }
    if (!header || cells.length !== header.length) continue;
    if (!/^JP-V-N[1-5]-\d{4}$/.test(cells[0])) continue;
    const r = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    rows.push(blankWord(r));
  }
  return rows;
}

function blankWord(r: Record<string, string>): Word {
  return {
    code: r.code,
    term: r.term,
    kana: r.kana,
    pos: r.pos,
    cn: r.cn,
    theme: r.theme,
    freq: r.freq,
    level: r.level,
    mnemonic: '',
    example: '',
    exampleCn: '',
    inflections: '',
    syn: '',
    ant: '',
    derivation: '',
    detailed: false,
  };
}

function fillDetail(target: Word, r: Record<string, string>): void {
  target.mnemonic = r.mnemonic ?? '';
  target.example = r.example ?? '';
  target.exampleCn = r.exampleCn ?? '';
  target.inflections = r.infl ?? r.inflections ?? '';
  target.syn = r.syn ?? '';
  target.ant = r.ant ?? '';
  target.derivation = r.deriv ?? r.derivation ?? '';
  target.detailed = true;
}

/**
 * 解析 16 列全字段表。返回 Map<code, 行数据>。
 * marker 为 null 时解析整个文件（用于 N5/N4 独立精讲库那种没有明确章节标题的情况）。
 */
function parseDetailTable(lines: string[], marker: RegExp | null): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  let header: string[] | null = null;
  let inSection = marker === null;
  for (const line of lines) {
    const s = line.trim();
    if (marker && marker.test(s)) {
      inSection = true;
      header = null;
      continue;
    }
    if (inSection && /^## /.test(s) && !(marker && marker.test(s))) {
      if (marker) {
        inSection = false;
        continue;
      }
    }
    if (!inSection || !s.startsWith('|')) continue;
    const cells = cellsOf(line);
    if (cells[0] === 'code' && cells.length >= 14) {
      header = cells;
      continue;
    }
    if (!header || cells.length !== header.length) continue;
    if (!/^JP-V-N[1-5]-\d{4}$/.test(cells[0])) continue;
    out.set(cells[0], Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  }
  return out;
}

function fail(msg: string): never {
  throw new Error(`JLPT 词库导入失败：${msg}`);
}

// ---------- 组装 ----------
const mainLines = parseMarkdown(MAIN);
const core = parseCore(mainLines);
if (core.length !== 10000) fail(`主源核心表应为 10000 条，实际 ${core.length}`);
const coreByCode = new Map(core.map((w) => [w.code, w]));
if (coreByCode.size !== 10000) fail(`主源编码重复：10000 条里只有 ${coreByCode.size} 个唯一编码`);

const counts: Record<string, number> = { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0 };
for (const w of core) counts[w.level] = (counts[w.level] ?? 0) + 1;
const expect: Record<string, number> = { N5: 800, N4: 1500, N3: 1400, N2: 2300, N1: 4000 };
for (const lv of LEVEL_ORDER) {
  if (counts[lv] !== expect[lv]) fail(`${lv} 应为 ${expect[lv]} 条，实际 ${counts[lv]}`);
}

// 精讲字段来源：N1 文件里的「精讲层与分轮补充」全量表（新版）；没有则回退到分散精讲层
const fullDetail = parseDetailTable(mainLines, /^## 精讲层与分轮补充/);
let detailSource = 'N1全量精讲表';
let details: Map<string, Record<string, string>> = fullDetail;

if (fullDetail.size === 0) {
  detailSource = '分散精讲层回退';
  details = new Map();
  const sources: Array<[string, RegExp | null]> = [
    [N5DETAIL, null],
    [N4DETAIL, null],
    [N3FILE, /^## N3 精讲层/],
    [N2FILE, /^## N2 精讲层/],
    [MAIN, /^## N1 精讲层/],
  ];
  for (const [file, marker] of sources) {
    for (const [code, row] of parseDetailTable(parseMarkdown(file), marker)) {
      if (details.has(code)) fail(`精讲层编码重复：${code}`);
      details.set(code, row);
    }
  }
}

let applied = 0;
let skipped = 0;
for (const [code, row] of details) {
  const target = coreByCode.get(code);
  if (!target) {
    skipped += 1;
    continue;
  }
  fillDetail(target, row);
  applied += 1;
}

// 校验精讲字段完整
for (const w of core) {
  if (!w.detailed) continue;
  if (!w.mnemonic || !w.example || !w.exampleCn) fail(`${w.code} 标记为精讲但字段不完整`);
}
if (details.size !== applied) {
  fail(`精讲表 ${details.size} 条，成功应用 ${applied} 条，存在 ${skipped} 个不匹配编码`);
}

// ---------- 合并题目考点回补词 ----------
// 主表 10000 条保持原样，补充词按各档末尾续号追加。校验续号连续、编码与词形不撞主表，
// 保证 jlptGraded.ts 的「编码连续 + 词形假名唯一 + 级别与编码一致」三道校验仍然成立。
const supplement: Word[] = JSON.parse(fs.readFileSync(SUPPLEMENT, 'utf8')) as Word[];
const coreForms = new Set(core.map((w) => `${w.term.toLowerCase()}|${w.kana}`));
const serialOf = (code: string): number => Number(/^JP-V-N[1-5]-(\d{4})$/.exec(code)?.[1]);
// 主表编码在前面已按 0001..count 校验连续，续号直接取「条数 + 1」。
const nextSerial: Record<string, number> = {};
for (const lv of LEVEL_ORDER) nextSerial[lv] = counts[lv] + 1;
const supplementByLevel: Record<string, number> = {};
for (const w of supplement) {
  if (!/^JP-V-N[1-5]-\d{4}$/.test(w.code)) fail(`补充词编码不合法：${w.code}`);
  if (coreByCode.has(w.code)) fail(`补充词编码撞主表：${w.code}`);
  const formKey = `${w.term.toLowerCase()}|${w.kana}`;
  if (coreForms.has(formKey)) fail(`补充词词形+假名撞主表：${w.term}(${w.kana})`);
  coreForms.add(formKey);
  const levelFromCode = /^JP-V-(N[1-5])-/.exec(w.code)?.[1];
  if (levelFromCode !== w.level) fail(`${w.code} 级别应为 ${levelFromCode}，实际 ${w.level}`);
  if (serialOf(w.code) !== nextSerial[w.level]) {
    fail(`${w.level} 补充词编码应续 ${nextSerial[w.level]}，实际 ${w.code}（必须逐号连续，不可跳号）`);
  }
  nextSerial[w.level] += 1;
  supplementByLevel[w.level] = (supplementByLevel[w.level] ?? 0) + 1;
  if (w.detailed && (!w.mnemonic || !w.example || !w.exampleCn)) {
    fail(`补充词 ${w.code} 标记为精讲但字段不完整`);
  }
  core.push(w);
  coreByCode.set(w.code, w);
  counts[w.level] += 1;
}

const detailedCount = core.filter((w) => w.detailed).length;
const byLevel: Record<string, number> = {};
for (const w of core) if (w.detailed) byLevel[w.level] = (byLevel[w.level] ?? 0) + 1;

const out = {
  source:
    'JLPT 分级词汇总库（教研编制，N1 全量 10000 条为权威主源；全库 10000 条已精讲化）；md 与 xlsx 已逐行核对一致；另含 10 条题目考点回补词（jlpt-supplement.json）',
  levels: LEVEL_ORDER.map((id) => ({ id, name: LEVEL_NAME[id], count: counts[id] })),
  words: core,
};

console.log(
  JSON.stringify(
    {
      total: core.length,
      byLevel: counts,
      detailSource,
      detailRows: details.size,
      applied,
      detailed: detailedCount,
      detailedByLevel: byLevel,
      supplement: supplement.length,
      supplementByLevel,
      coreOnly: core.length - detailedCount,
      bytes: Buffer.byteLength(JSON.stringify(out)),
    },
    null,
    2,
  ),
);

if (!checkOnly) {
  const outFile = arg('out') ?? 'server/src/content/jlpt-graded.json';
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out), 'utf8');
  console.log(`已写入 ${outFile}`);
}
