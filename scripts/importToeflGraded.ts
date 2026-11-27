/**
 * 教研《托福分级词汇表》→ 内置分级词库 JSON。
 *
 * 用法：
 *   tsx scripts/importToeflGraded.ts <1600词.md> [--check-500 <500词.md>] [--check-1200 <1200词.md>]
 *                                    [--out <输出路径>] [--check]
 *
 * 约定：
 *   · 1600 词主表是唯一数据源；500 / 1200 只用于校验「是否为子集」，不单独入库。
 *   · 编码 EN-V-0001 ～ EN-V-1600 连续；L1–L5 各 320 条。
 *   · 表里没有中文释义、记忆法、例句——这些字段不在这里补，保持数据原样。
 */
import fs from 'node:fs';
import path from 'node:path';

type Grade = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

interface GradedWord {
  code: string;
  term: string;
  pos: string;
  ipa: string;
  theme: string;
  forms: string;
  relations: string;
  band: string;
  level: Grade;
}

interface LevelMeta {
  id: Grade;
  name: string;
  cefr: string;
  count: number;
}

const GRADE_ORDER: Grade[] = ['L1', 'L2', 'L3', 'L4', 'L5'];
const GRADE_META: Record<Grade, { name: string; cefr: string }> = {
  L1: { name: 'L1 基础', cefr: 'A2' },
  L2: { name: 'L2 核心', cefr: 'B1' },
  L3: { name: 'L3 进阶', cefr: 'B2' },
  L4: { name: 'L4 学术高频', cefr: 'C1' },
  L5: { name: 'L5 高难·低频', cefr: 'C2' },
};

const CODE_RE = /^EN-V-(\d{3,4})$/;
const HEADER_CELLS = new Set(['编码', '原形', '词性', '音标（美）', '主题', '词形变化', '近义/反义/派生', '频段']);

function parseTable(file: string): GradedWord[] {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const words: GradedWord[] = [];
  let current: Grade | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^##\s+(L[1-5])\s/.exec(line);
    if (heading) {
      current = heading[1] as Grade;
      continue;
    }
    if (!line.startsWith('|')) continue;

    const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.length !== 8) continue;
    if (HEADER_CELLS.has(cells[0]) || /^:?-+:?$/.test(cells[0])) continue;

    const [code, termRaw, pos, ipa, theme, forms, relations, band] = cells as [
      string, string, string, string, string, string, string, string,
    ];
    if (!CODE_RE.test(code)) continue;
    if (!current) throw new Error(`词条 ${code} 不在任何 L1–L5 分节下`);
    words.push({
      code,
      term: termRaw.replace(/\*\*/g, '').trim(),
      pos,
      ipa,
      theme,
      forms,
      relations,
      band,
      level: current,
    });
  }
  return words;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validate(words: GradedWord[], expectedPerLevel: number): LevelMeta[] {
  assert(words.length === expectedPerLevel * GRADE_ORDER.length, `词条总数应为 ${expectedPerLevel * 5}，实际 ${words.length}`);

  const codes = new Set<string>();
  const terms = new Set<string>();
  const counters = new Map<Grade, number>(GRADE_ORDER.map((grade) => [grade, 0]));

  let prevSerial = 0;
  for (const word of words) {
    for (const [field, value] of Object.entries(word)) {
      assert(value !== '', `${word.code} 的字段 ${field} 为空`);
    }
    assert(!codes.has(word.code), `编码重复：${word.code}`);
    codes.add(word.code);
    const key = word.term.toLowerCase();
    assert(!terms.has(key), `词形重复：${word.term}`);
    terms.add(key);

    const serial = Number(CODE_RE.exec(word.code)?.[1]);
    assert(serial === prevSerial + 1, `编码不连续：${prevSerial} 之后出现 ${serial}`);
    prevSerial = serial;

    counters.set(word.level, (counters.get(word.level) ?? 0) + 1);
  }

  return GRADE_ORDER.map((grade) => {
    const count = counters.get(grade) ?? 0;
    assert(count === expectedPerLevel, `${grade} 应为 ${expectedPerLevel} 条，实际 ${count}`);
    return { id: grade, ...GRADE_META[grade], count };
  });
}

function assertSubset(superset: GradedWord[], file: string, label: string): void {
  const pool = new Set(superset.map((word) => word.term.toLowerCase()));
  const rows = parseTable(file);
  const missing = rows.filter((word) => !pool.has(word.term.toLowerCase()));
  assert(missing.length === 0, `${label} 有 ${missing.length} 个词不在主表：${missing.slice(0, 5).map((w) => w.term).join(', ')}`);
  console.log(`  ✓ ${label}：${rows.length} 条，全部包含在主表中`);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const source = process.argv[2];
  if (!source || source.startsWith('--')) {
    throw new Error('请传入 1600 词主表的 md 路径');
  }
  const perLevel = Number(argValue('--per-level') ?? 320);
  const words = parseTable(source);
  const levels = validate(words, perLevel);

  console.log(`主表：${words.length} 条，${levels.map((level) => `${level.id} ${level.count}`).join(' / ')}`);

  const subset500 = argValue('--check-500');
  const subset1200 = argValue('--check-1200');
  if (subset500) assertSubset(words, subset500, '500 词表');
  if (subset1200) assertSubset(words, subset1200, '1200 词表');

  if (process.argv.includes('--check')) {
    console.log('校验通过（未写入）');
    return;
  }

  const out = argValue('--out') ?? path.resolve('server/src/content/toefl-graded.json');
  const payload = {
    source: '教研《托福分级词汇表》1600 词主表：L1–L5 各 320 词，编码 EN-V-0001–EN-V-1600',
    levels,
    words,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${out}（${words.length} 条，${(fs.statSync(out).size / 1024).toFixed(0)} KB）`);
}

main();
