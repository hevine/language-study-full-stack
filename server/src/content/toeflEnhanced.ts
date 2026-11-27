/**
 * 托福分级词库 · 精讲增强层
 *
 * 分级表（toefl-graded.json）只有词形/词性/音标/主题/词形变化/关系/频段，
 * 没有中文释义、记忆法、例句、例句译文。这一层按稳定编码 EN-V-xxxx 为待补词
 * 补上这四项，把它们从「覆盖词」升级为「精讲词」。
 *
 * 数据放在同目录 toefl-enhanced/ 下，按批次一个 JSON 文件（batch-001.json ...），
 * 每批一个词条数组。分批的原因：1505 条内容量大，逐批撰写、逐批校验、可追溯。
 *
 * 约定：
 *   · 编码必须与分级表一一对应，不存在或重复的编码在启动时报错；
 *   · 四个字段必须非空；example 必须包含该词本身（词形或词形变化）；
 *   · 已由 toeflLexicon.ts 精讲覆盖的词不必进这一层，重复也无副作用（读取时精讲优先）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GRADED_WORDS } from './toeflGraded';

const EntrySchema = z
  .object({
    code: z.string().regex(/^EN-V-\d{4}$/),
    cn: z.string().min(1),
    mnemonic: z.string().min(1),
    example: z.string().min(1),
    exampleCn: z.string().min(1),
  })
  .strict();

export type EnhancedEntry = z.infer<typeof EntrySchema>;

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toefl-enhanced');

function batchFiles(): string[] {
  try {
    return fs
      .readdirSync(DIR)
      .filter((name) => /^batch-\d+\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

let cache: Map<string, EnhancedEntry> | null = null;

function fail(message: string): never {
  throw new Error(`托福精讲增强层不合法：${message}`);
}

function readBatch(file: string): EnhancedEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  } catch (err) {
    fail(`${file} 读取失败：${(err as Error).message}`);
  }
  const parsed = z.array(EntrySchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(`${file} ${issue?.path.join('.') ?? '根'} ${issue?.message ?? ''}`);
  }
  return parsed.data;
}

function load(): Map<string, EnhancedEntry> {
  if (cache) return cache;
  const map = new Map<string, EnhancedEntry>();
  const gradedCodes = new Set(GRADED_WORDS().map((word) => word.code));

  for (const file of batchFiles()) {
    for (const entry of readBatch(file)) {
      if (!gradedCodes.has(entry.code)) fail(`${file} 编码 ${entry.code} 不在分级表中`);
      if (map.has(entry.code)) fail(`编码重复：${entry.code}（${file}）`);
      map.set(entry.code, entry);
    }
  }
  cache = map;
  return map;
}

/** 按编码取精讲增强内容；没有则 undefined（该词仍是 pending） */
export function enhancedOf(code: string | undefined): EnhancedEntry | undefined {
  if (!code) return undefined;
  return load().get(code);
}

/** 已升级为精讲的条数，用于自检与进度展示 */
export function enhancedCount(): number {
  return load().size;
}

/** 增强层覆盖的编码集合，供脚本自检与查漏 */
export function enhancedCodes(): Set<string> {
  return new Set(load().keys());
}

/** 供导出脚本调用：清除缓存（写入新批次后重新加载） */
export function clearEnhancedCache(): void {
  cache = null;
}
