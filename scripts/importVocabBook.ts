/**
 * 词汇书入库：把《日本语精编词汇》这类「按课列词」的扫描书拆成词表包。
 *
 *   npm run import:vocab -- --file "~/Downloads/精编词汇.pdf" --level n4 --title 日本语精编词汇
 *   npm run import:vocab -- --file ... --dry                  # 只解析、只统计，不写库
 *   npm run import:vocab -- --ocr /tmp/vocab_xy.txt ...       # 复用已 OCR 的文本（OCR_XY=1 输出）
 *   npm run import:vocab -- --file ... --force                # 同名的先删再导
 *   npm run import:vocab -- --file ... --no-llm               # 不调模型，直接用 OCR 原文（错字会保留）
 *
 * 流程：本机 Vision OCR（带坐标，双栏才排得对）→ 结构解析（课号按 y 坐标切）
 * → 模型按「假名为准」校正汉字/释义并补例句 → 写 materials(kind=vocab) + 每课一单元 + 词条。
 * 校正结果缓存到 .data/vocab-clean-*.json，中断后重跑不会重复花钱。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeDb, runMigrations } from '../server/src/db';
import { chatJson, resolveLlmConfig } from '../server/src/services/llm';
import {
  buildCleanMessages,
  CleanSchema,
  isUsableRow,
  mergeClean,
  parseVocabOcr,
  type VocabBookEntry,
  type VocabBookRow,
} from '../server/src/services/vocabBook';
import { deleteMaterial, listMaterials, saveMaterial } from '../server/src/repositories/materials';
import { JA_WORDS } from '../server/src/content/jaLexicon';
import type { ParsedUnit, ParsedWord } from '../server/src/services/materialParse';
import type { LexLanguage } from '../server/src/content/lexicon';

interface Args {
  file?: string;
  ocr?: string;
  lang: LexLanguage;
  level: string;
  title?: string;
  origin: string;
  pages?: string;
  batch: number;
  concurrency: number;
  limit: number;
  force: boolean;
  dry: boolean;
  noLlm: boolean;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      map.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }
  const file = map.get('file');
  const ocr = map.get('ocr');
  if (!file && !ocr) {
    console.error('缺少 --file（要导入的 PDF）或 --ocr（已识别好的文本）');
    process.exit(1);
  }
  return {
    file: file ? path.resolve(file.replace(/^~/, os.homedir())) : undefined,
    ocr: ocr ? path.resolve(ocr.replace(/^~/, os.homedir())) : undefined,
    lang: (map.get('lang') ?? 'ja') as LexLanguage,
    level: map.get('level') ?? 'n4',
    title: map.get('title'),
    origin: map.get('origin') ?? 'local-book',
    pages: map.get('pages'),
    batch: Number(map.get('batch') ?? 26),
    concurrency: Math.max(1, Number(map.get('concurrency') ?? 3)),
    limit: Number(map.get('limit') ?? 0),
    force: flags.has('force'),
    dry: flags.has('dry'),
    noLlm: flags.has('no-llm'),
  };
}

/** 扫描件走本机 Vision OCR；OCR_XY=1 才会带坐标，双栏书必须带 */
function ocrBook(filePath: string, pageRange?: string): string {
  const out = path.join(os.tmpdir(), `vocab-${Date.now()}.txt`);
  const range = pageRange?.split('-').map(Number).filter(Number.isFinite) ?? [];
  execFileSync('swift', [path.join('scripts', 'ocrPdf.swift'), filePath, out, ...range.map(String)], {
    stdio: 'inherit',
    env: { ...process.env, OCR_XY: '1', OCR_SCALE: process.env.OCR_SCALE ?? '4', OCR_LANGS: 'ja-JP,zh-Hans' },
  });
  const text = fs.readFileSync(out, 'utf8');
  fs.rmSync(out, { force: true });
  return text;
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function cachePath(title: string): string {
  const slug = crypto.createHash('sha1').update(title).digest('hex').slice(0, 8);
  return path.join('.data', `vocab-clean-${slug}.json`);
}

function loadCache(file: string): Map<string, ReturnType<typeof mergeClean>> {
  const map = new Map<string, ReturnType<typeof mergeClean>>();
  if (!fs.existsSync(file)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      at?: string;
      items?: Array<Record<string, unknown>>;
    };
    const at = raw.at ? Date.parse(raw.at) : 0;
    if (!at || Date.now() - at > CACHE_TTL_MS) return map;
    for (const item of raw.items ?? []) {
      const key = String(item.raw ?? '');
      if (!key) continue;
      map.set(key, {
        lesson: Number(item.lesson ?? 0),
        term: String(item.term ?? ''),
        reading: String(item.reading ?? ''),
        pos: String(item.pos ?? ''),
        meaning: String(item.meaning ?? ''),
        example: String(item.example ?? ''),
        exampleCn: String(item.exampleCn ?? ''),
      });
    }
  } catch {
    // 缓存坏了就当没有，重跑一遍即可
  }
  return map;
}

function saveCache(file: string, cache: Map<string, ReturnType<typeof mergeClean>>, rawByKey: Map<string, string>): void {
  const items = [...cache.entries()].map(([key, value]) => ({
    raw: rawByKey.get(key) ?? key,
    lesson: value.lesson,
    term: value.term,
    reading: value.reading,
    pos: value.pos,
    meaning: value.meaning,
    example: value.example,
    exampleCn: value.exampleCn,
  }));
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), items }, null, 0));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  runMigrations();

  const title = args.title?.trim() || (args.file ? path.basename(args.file, path.extname(args.file)) : '词汇书');
  const fileName = args.file ? path.basename(args.file) : path.basename(args.ocr!);
  const fileSize = args.file ? fs.statSync(args.file).size : fs.statSync(args.ocr!).size;

  console.log(`OCR：${fileName}`);
  const text = args.ocr ? fs.readFileSync(args.ocr, 'utf8') : ocrBook(args.file!, args.pages);

  const parsed = parseVocabOcr(text);
  const allRows = parsed.rows.filter(isUsableRow);
  // --limit 只用于试跑：取前 N 条，验证解析与校正效果
  const rows = args.limit > 0 ? allRows.slice(0, args.limit) : allRows;
  console.log(
    `识别 ${parsed.pages} 页 · ${parsed.rows.length} 行原始行 · ${rows.length} 条可用词条 · ${parsed.lessons.length} 课` +
      (parsed.headerGaps > 0 ? `（${parsed.headerGaps} 个课号整行漏识别，按段均分补上）` : ''),
  );
  console.log(
    '每课词数：' + parsed.lessons.map((lesson) => `${lesson}:${rows.filter((row) => row.lesson === lesson).length}`).join(' '),
  );

  if (rows.length === 0) {
    console.error('一条词条都没解析出来——检查 OCR 文本是不是带坐标（OCR_XY=1）的双栏输出。');
    process.exit(1);
  }

  // ---------------------------------------------------------------- 模型校正
  const cacheFile = cachePath(title);
  const cache = args.noLlm ? new Map() : loadCache(cacheFile);
  const rawByKey = new Map<string, string>();
  for (const row of rows) rawByKey.set(row.raw, row.raw);
  const missing = rows.filter((row) => !cache.has(row.raw));
  console.log(`\n待校正 ${rows.length} 条，缓存命中 ${rows.length - missing.length} 条，需要模型 ${missing.length} 条`);

  if (missing.length > 0 && !args.noLlm) {
    const { config } = resolveLlmConfig();
    if (!config) {
      console.error('没有可用的模型线路，请先在「设置 → 模型 Key 池」里加一条，或加 --no-llm 直接导 OCR 原文。');
      process.exit(1);
    }
    console.log(`线路：${config.model} @ ${config.baseUrl} · 批量 ${args.batch} 条 / 并发 ${args.concurrency}`);

    const batches: VocabBookRow[][] = [];
    for (let i = 0; i < missing.length; i += args.batch) batches.push(missing.slice(i, i + args.batch));

    let done = 0;
    let failed = 0;
    const started = Date.now();

    const worker = async (): Promise<void> => {
      for (;;) {
        const batch = batches.shift();
        if (!batch) return;
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
          try {
            const raw = await chatJson(config, buildCleanMessages(batch), CleanSchema, {
              temperature: 0.2,
              maxTokens: 6000,
              retries: 1,
            });
            const byIndex = new Map(raw.items.map((item) => [item.i, item]));
            batch.forEach((row, index) => {
              const item = byIndex.get(index);
              if (!item) return;
              cache.set(row.raw, {
                ...mergeClean(row, item),
                // 缓存按原文去重，课号以当前解析为准
                lesson: row.lesson,
              });
              ok = true;
            });
            if (!ok) throw new Error('模型返回的条目对不上号');
          } catch (error) {
            if (attempt === 1) {
              failed += batch.length;
              console.warn(`  ! 一批 ${batch.length} 条校正失败：${(error as Error).message.slice(0, 120)}`);
            }
          }
        }
        done += batch.length;
        saveCache(cacheFile, cache, rawByKey);
        const elapsed = Math.round((Date.now() - started) / 1000);
        console.log(`  已校正 ${done}/${missing.length} · ${elapsed}s${failed > 0 ? ` · 失败 ${failed}` : ''}`);
      }
    };

    await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
    saveCache(cacheFile, cache, rawByKey);
    console.log(`校正缓存：${cacheFile}`);
  }

  // ---------------------------------------------------------------- 合并与去重
  const entries: VocabBookEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const row of rows) {
    const cleaned = cache.get(row.raw) ?? mergeClean(row, undefined);
    if (!cleaned.meaning) {
      dropped += 1;
      continue;
    }
    const key = cleaned.term.trim();
    if (!key || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    entries.push({ ...cleaned, lesson: row.lesson });
  }
  console.log(`\n可用词条 ${entries.length} 条（去重/无释义丢掉 ${dropped} 条）`);

  const sample = entries.slice(0, 8);
  console.log('\n前 8 条：');
  for (const item of sample) {
    console.log(`  L${item.lesson} ${item.term}【${item.reading}】${item.pos} ${item.meaning}`);
  }

  const withExample = entries.filter((entry) => entry.example).length;
  console.log(`\n带例句 ${withExample}/${entries.length} 条`);

  if (args.dry) {
    console.log(`\n--dry：会写入《${title}》 ${parsed.lessons.length} 课 / ${entries.length} 词（${args.level}/vocab），不写库。`);
    closeDb();
    return;
  }

  // ---------------------------------------------------------------- 写库
  const lessons = [...new Set(entries.map((entry) => entry.lesson))].sort((a, b) => a - b);
  const units: ParsedUnit[] = lessons.map((lesson, idx) => {
    const words = entries.filter((entry) => entry.lesson === lesson);
    const body = words
      .map((word) => `${word.term}${word.reading ? `【${word.reading}】` : ''}（${word.pos || '—'}）${word.meaning}`)
      .join('\n');
    return {
      idx,
      title: `第${lesson}課`,
      body,
      charCount: body.length,
      pageFrom: null,
      pageTo: null,
    };
  });

  const lexicon = new Set(JA_WORDS.map((word) => word.term));
  const unitIdxOf = new Map(lessons.map((lesson, idx) => [lesson, idx]));
  const words: ParsedWord[] = entries.map((entry) => ({
    term: entry.term,
    reading: entry.reading || null,
    pos: entry.pos || null,
    meaning: entry.meaning,
    example: entry.example || null,
    unitIdx: unitIdxOf.get(entry.lesson) ?? 0,
    freq: 1,
    inLexicon: lexicon.has(entry.term),
  }));

  const existing = listMaterials(args.lang, { kind: 'vocab' }).filter((item) => item.title === title);
  if (existing.length > 0) {
    if (!args.force) {
      console.log(`\n库里已有同名的《${title}》（${existing[0].wordCount} 词），加 --force 才会重导。`);
      closeDb();
      return;
    }
    for (const item of existing) deleteMaterial(item.id);
    console.log(`已删除同名的旧版本 ${existing.length} 份`);
  }

  const material = saveMaterial({
    language: args.lang,
    title,
    format: 'pdf-ocr',
    fileName,
    fileSize,
    charCount: text.length,
    level: args.level,
    kind: 'vocab',
    origin: args.origin,
    note: `词汇书：${lessons.length} 课 / ${entries.length} 个词条，供「词汇」任务按天取词`,
    units,
    words,
  });

  console.log(
    `\n入库：《${material.title}》 ${material.kind}/${material.level ?? '未分级'} · ${material.unitCount} 课 · ${material.wordCount} 词 · ${material.charCount} 字符`,
  );
  closeDb();
}

main().catch((error) => {
  console.error('导入失败：', (error as Error).message);
  process.exit(1);
});
