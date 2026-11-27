/**
 * JLPT 分级词库 · 读取层
 *
 * 数据：同目录 jlpt-graded.json，由 scripts/importJlptGraded.ts 从教研词表生成。
 * 结构：N5–N1 五级共 10000 词，编码 JP-V-Nx-nnnn。
 *   2662 条带完整精讲字段（mnemonic/example/exampleCn 等），7338 条只有核心字段。
 *
 * 约定：
 *   · 编码稳定不改义，扩容只续号；
 *   · 词形 + 假名唯一（一词一级）；
 *   · detailed=true 的词必须有 mnemonic/example/exampleCn，启动时校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type JlptLevel = 'N5' | 'N4' | 'N3' | 'N2' | 'N1';

export const JLPT_LEVEL_ORDER: JlptLevel[] = ['N5', 'N4', 'N3', 'N2', 'N1'];

const WordSchema = z
  .object({
    code: z.string().regex(/^JP-V-N[1-5]-\d{4}$/),
    term: z.string().min(1),
    kana: z.string().min(1),
    pos: z.string().min(1),
    cn: z.string().min(1),
    theme: z.string().min(1),
    freq: z.string().min(1),
    level: z.enum(['N5', 'N4', 'N3', 'N2', 'N1']),
    mnemonic: z.string(),
    example: z.string(),
    exampleCn: z.string(),
    inflections: z.string(),
    syn: z.string(),
    ant: z.string(),
    derivation: z.string(),
    detailed: z.boolean(),
  })
  .strict();

const LevelSchema = z
  .object({
    id: z.enum(['N5', 'N4', 'N3', 'N2', 'N1']),
    name: z.string().min(1),
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

export type JlptWord = z.infer<typeof WordSchema>;
export type JlptLevelMeta = z.infer<typeof LevelSchema>;

/** 五档的一句话定位，与教研表的分级说明一致 */
export const JLPT_LEVEL_DESCRIPTION: Record<JlptLevel, string> = {
  N5: '最基础的生存词：问候、数字、时间、日常动作，五十音后最先接触。',
  N4: '日常会话高频词：初级动词、形容词与常用汉字词，N5 到 N3 的过渡。',
  N3: '日常话题核心词：和语动词与书面表达，N3 阅读听力的地基。',
  N2: '中高级高频词：社论、商务文书里的汉语词，N2 合格的主力。',
  N1: '高级拉分词：抽象评论与公文里的硬词，N1 阅读拉开差距。',
};

function assertData(input: unknown): { source: string; levels: JlptLevelMeta[]; words: JlptWord[] } {
  const parsed = FileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`JLPT 分级词库不合法：${issue?.path.join('.') ?? '根'} ${issue?.message ?? ''}`);
  }
  const data = parsed.data;
  const fail = (message: string): never => {
    throw new Error(`JLPT 分级词库不合法：${message}`);
  };

  const levelIds = data.levels.map((level) => level.id);
  if (levelIds.join(',') !== JLPT_LEVEL_ORDER.join(',')) {
    fail(`级别应为 ${JLPT_LEVEL_ORDER.join(' / ')}，实际 ${levelIds.join(' / ')}`);
  }

  const codes = new Set<string>();
  const forms = new Set<string>();
  const counts = new Map<string, number>();
  const serials = new Map<string, number[]>();
  for (const word of data.words) {
    if (codes.has(word.code)) fail(`编码重复：${word.code}`);
    codes.add(word.code);
    const formKey = `${word.term.toLowerCase()}|${word.kana}`;
    if (forms.has(formKey)) fail(`词形+假名重复：${word.term}(${word.kana})`);
    forms.add(formKey);
    const levelFromCode = /^JP-V-(N[1-5])-/.exec(word.code)?.[1];
    if (levelFromCode !== word.level) fail(`${word.code} 级别应为 ${levelFromCode}，实际 ${word.level}`);
    if (word.detailed && (!word.mnemonic || !word.example || !word.exampleCn)) {
      fail(`${word.code} 标记为精讲但字段不完整`);
    }
    counts.set(word.level, (counts.get(word.level) ?? 0) + 1);
    const serial = Number(/^JP-V-N[1-5]-(\d{4})$/.exec(word.code)?.[1]);
    const list = serials.get(word.level) ?? [];
    list.push(serial);
    serials.set(word.level, list);
  }

  for (const level of data.levels) {
    const actual = counts.get(level.id) ?? 0;
    if (actual !== level.count) fail(`${level.id} 标注 ${level.count} 条，实际 ${actual} 条`);
    const nums = (serials.get(level.id) ?? []).sort((a, b) => a - b);
    if (nums.length && (nums[0] !== 1 || nums[nums.length - 1] !== nums.length)) {
      fail(`${level.id} 编码不连续（${nums[0]}–${nums[nums.length - 1]}，共 ${nums.length} 条）`);
    }
  }
  return data;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'jlpt-graded.json');

let cache: { source: string; levels: JlptLevelMeta[]; words: JlptWord[] } | null = null;

function load(): { source: string; levels: JlptLevelMeta[]; words: JlptWord[] } {
  if (cache) return cache;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    throw new Error(`内置 JLPT 分级词库读取失败：${(err as Error).message}`);
  }
  cache = assertData(raw);
  return cache;
}

export const JLPT_SOURCE = (): string => load().source;
export const JLPT_LEVELS = (): JlptLevelMeta[] => load().levels;
export const JLPT_WORDS = (): JlptWord[] => load().words;

export function jlptLevel(id: string): JlptLevelMeta | undefined {
  return load().levels.find((level) => level.id === id);
}

export function isJlptLevel(value: string): value is JlptLevel {
  return (JLPT_LEVEL_ORDER as string[]).includes(value);
}

/** 按级别（可选）与关键词取分级词；关键词覆盖词形、假名、释义、主题、词形变化 */
export function listJlptWords(options: { level?: string; query?: string } = {}): JlptWord[] {
  const { level, query } = options;
  const keyword = query?.trim().toLowerCase();
  return load().words.filter((word) => {
    if (level && word.level !== level) return false;
    if (!keyword) return true;
    return [word.term, word.kana, word.cn, word.theme, word.inflections, word.syn, word.ant].some(
      (field) => field.toLowerCase().includes(keyword),
    );
  });
}

/** 词形索引：精讲词库合并时判断某个词是否已在分级表里 */
export function jlptByTerm(): Map<string, JlptWord> {
  return new Map(load().words.map((word) => [word.term.toLowerCase(), word]));
}
