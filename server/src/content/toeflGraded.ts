/**
 * 托福分级词库 · 读取层
 *
 * 数据：同目录 toefl-graded.json，由 `scripts/importToeflGraded.ts` 从教研表格生成。
 * 结构：L1–L5 五档，每档 320 词，编码 EN-V-0001–EN-V-1600 连续。
 *
 * 这份表只有「词形 / 词性 / 音标 / 主题 / 词形变化 / 近义反义派生 / 频段」，
 * 没有中文释义、记忆法、例句 —— 那三项由精讲词库（toeflLexicon.ts）提供，
 * 读取层负责把两层合并，缺失字段留空，由界面显示占位。
 *
 * 约定：
 *   · 编码稳定不改义，扩容只续号；
 *   · 词形（term，忽略大小写）唯一，导入脚本与启动校验都会查重。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type ToeflGrade = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export const GRADED_GRADE_ORDER: ToeflGrade[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

const WordSchema = z
  .object({
    code: z.string().regex(/^EN-V-\d{4}$/),
    term: z.string().min(1),
    pos: z.string().min(1),
    ipa: z.string().min(1),
    theme: z.string().min(1),
    forms: z.string().min(1),
    relations: z.string().min(1),
    band: z.string().min(1),
    level: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']),
  })
  .strict();

const LevelSchema = z
  .object({
    id: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']),
    name: z.string().min(1),
    cefr: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict();

const FileSchema = z
  .object({
    source: z.string().min(1),
    levels: z.array(LevelSchema).min(1),
    words: z.array(WordSchema).min(1),
  })
  .strict();

export type GradedWord = z.infer<typeof WordSchema>;
export type GradedLevel = z.infer<typeof LevelSchema>;

/** 五档的一句话定位，与教研表的「分级分布」一致 */
export const GRADED_LEVEL_DESCRIPTION: Record<ToeflGrade, string> = {
  L1: 'A2 基础词：日常与校园场景的高频动词、名词，托福起步层。',
  L2: 'B1 核心词：学术阅读里的常见动词与形容词，冲 60–75 分的主力。',
  L3: 'B2 进阶词：讲座与长文里的论证词、抽象名词，阅读提速的关键。',
  L4: 'C1 学术高频词：同义替换与写作替换的高频词，冲 90 分的分水岭。',
  L5: 'C2 高难低频词：出现频率低但决定上限，冲 100+ 才需要重点啃。',
};

function assertData(input: unknown): { source: string; levels: GradedLevel[]; words: GradedWord[] } {
  const parsed = FileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`托福分级词库不合法：${issue?.path.join('.') ?? '根'} ${issue?.message ?? ''}`);
  }
  const data = parsed.data;
  const fail = (message: string): never => {
    throw new Error(`托福分级词库不合法：${message}`);
  };

  const levelIds = data.levels.map((level) => level.id);
  if (levelIds.join(',') !== GRADED_GRADE_ORDER.join(',')) {
    fail(`级别应为 ${GRADED_GRADE_ORDER.join(' / ')}，实际 ${levelIds.join(' / ')}`);
  }

  const codes = new Set<string>();
  const terms = new Set<string>();
  const counts = new Map<string, number>();
  let prevSerial = 0;
  for (const word of data.words) {
    if (codes.has(word.code)) fail(`编码重复：${word.code}`);
    codes.add(word.code);
    const key = word.term.toLowerCase();
    if (terms.has(key)) fail(`词形重复：${word.term}`);
    terms.add(key);

    const serial = Number(/^EN-V-(\d{4})$/.exec(word.code)?.[1]);
    if (serial !== prevSerial + 1) {
      fail(`编码不连续：${prevSerial} 之后出现 ${serial}`);
    }
    prevSerial = serial;
    counts.set(word.level, (counts.get(word.level) ?? 0) + 1);
  }

  for (const level of data.levels) {
    const actual = counts.get(level.id) ?? 0;
    if (actual !== level.count) fail(`${level.id} 标注 ${level.count} 条，实际 ${actual} 条`);
  }
  return data;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'toefl-graded.json');

let cache: { source: string; levels: GradedLevel[]; words: GradedWord[] } | null = null;

function load(): { source: string; levels: GradedLevel[]; words: GradedWord[] } {
  if (cache) return cache;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    throw new Error(`内置托福分级词库读取失败：${(err as Error).message}`);
  }
  cache = assertData(raw);
  return cache;
}

export const GRADED_SOURCE = (): string => load().source;
export const GRADED_LEVELS = (): GradedLevel[] => load().levels;
export const GRADED_WORDS = (): GradedWord[] => load().words;

export function gradedLevel(id: string): GradedLevel | undefined {
  return load().levels.find((level) => level.id === id);
}

export function isToeflGrade(value: string): value is ToeflGrade {
  return (GRADED_GRADE_ORDER as string[]).includes(value);
}

/** 按级别（可选）与关键词取分级词；关键词覆盖词形、主题、近义反义派生 */
export function listGradedWords(options: { level?: string; query?: string } = {}): GradedWord[] {
  const { level, query } = options;
  const keyword = query?.trim().toLowerCase();
  return load().words.filter((word) => {
    if (level && word.level !== level) return false;
    if (!keyword) return true;
    return [word.term, word.theme, word.relations, word.pos].some((field) =>
      field.toLowerCase().includes(keyword),
    );
  });
}

/** 词形索引：精讲词库合并时用来判断某个词是否已在分级表里 */
export function gradedByTerm(): Map<string, GradedWord> {
  return new Map(load().words.map((word) => [word.term.toLowerCase(), word]));
}
