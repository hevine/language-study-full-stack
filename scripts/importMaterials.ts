/**
 * 教材 / 资料批量入库脚本
 *
 *   npm run import:material -- --lang ja --file ~/Downloads/某教材.pdf --level n2
 *   npm run import:material -- --lang ja --dir ~/Downloads --match "N2" --kind textbook
 *   npm run import:material -- --lang ja --preset lvbao-n2 --dir ~/Downloads
 *
 * 规则：
 * · 级别优先取 --level，其次从文件名识别（N2 / 二级 / 零基础 …）；
 * · 类型 priority：--kind > 词表/答疑关键词 > textbook；
 * · 词表（vocab）用 gloss 表补假名与释义 —— 资料本身只有词形，不补就没法背；
 * · 已在库里的同名文件默认跳过，--force 可重导。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { closeDb, runMigrations } from '../server/src/db';
import type { ExtractedDoc } from '../server/src/services/materialParse';
import {
  cleanMaterialTitle,
  detectMaterialKind,
  detectMaterialLevel,
  extractDocument,
  extractWords,
  splitIntoUnits,
  type ParsedUnit,
  type ParsedWord,
} from '../server/src/services/materialParse';
import type { LexLanguage } from '../server/src/content/lexicon';
import { listMaterials, saveMaterial, type MaterialKind } from '../server/src/repositories/materials';
import {
  JA_N2_ADJECTIVES,
  JA_N2_LISTENING,
  JA_N2_LISTENING_QUESTIONS,
  type GlossRow,
} from '../server/src/content/jaHandoutGloss';

interface Args {
  dir?: string;
  file?: string;
  lang: LexLanguage;
  level?: string;
  kind?: MaterialKind;
  match?: string;
  preset?: string;
  origin: string;
  force: boolean;
  dry: boolean;
  ocr: boolean;
  pages?: string;
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
  return {
    dir: map.get('dir'),
    file: map.get('file'),
    lang: (map.get('lang') ?? 'ja') as LexLanguage,
    level: map.get('level'),
    kind: map.get('kind') as MaterialKind | undefined,
    match: map.get('match'),
    preset: map.get('preset'),
    origin: map.get('origin') ?? 'local-book',
    force: flags.has('force'),
    dry: flags.has('dry'),
    ocr: flags.has('ocr'),
    pages: map.get('pages'),
  };
}

/** 词表转章节：每 25 词一节，正文用「词形（假名）释义」便于回看，也给出例句空缺 */
function glossUnits(rows: GlossRow[], groupSize = 25): ParsedUnit[] {
  const units: ParsedUnit[] = [];
  for (let i = 0; i < rows.length; i += groupSize) {
    const slice = rows.slice(i, i + groupSize);
    const body = slice.map(([term, kana, pos, cn]) => `${term}（${kana}）【${pos}】${cn}`).join('\n');
    units.push({
      idx: units.length,
      title: `词表 ${i + 1}–${i + slice.length}`,
      body,
      charCount: body.length,
      pageFrom: null,
      pageTo: null,
    });
  }
  return units;
}

function glossWords(rows: GlossRow[], body: string): ParsedWord[] {
  return rows.map(([term, kana, pos, cn]) => {
    const freq = body.split(term).length - 1;
    return {
      term,
      reading: kana,
      pos,
      meaning: cn,
      example: null,
      unitIdx: 0,
      freq: Math.max(1, freq),
      inLexicon: true,
    };
  });
}

/** 答疑 PDF：按「N 问题：」切成一问一节，标题取问题首句 */
function questionUnits(text: string): ParsedUnit[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const starts = [...normalized.matchAll(/(?:^|\n)\s*(\d{1,2})\s*[、.．]?\s*问题[:：]/g)];
  const units: ParsedUnit[] = [];
  starts.forEach((match, index) => {
    const from = match.index ?? 0;
    const to = index + 1 < starts.length ? starts[index + 1].index ?? normalized.length : normalized.length;
    const body = normalized.slice(from, to).trim();
    if (body.length < 40) return;
    const titleLine = body.split('\n')[0].replace(/\s+/g, ' ').trim();
    units.push({
      idx: units.length,
      title: titleLine.slice(0, 36),
      body,
      charCount: body.length,
      pageFrom: null,
      pageTo: null,
    });
  });
  return units;
}

/** 资料自带级别：词表与听力资料都是 N2 篇；答疑整理贯穿 0–N2，不做级别绑定 */
function presetLevel(preset: string | undefined, fileName: string): string | null | undefined {
  if (preset !== 'lvbao-n2') return undefined;
  if (/答疑整理/.test(fileName)) return null;
  return 'n2';
}

function presetUnits(preset: string, fileName: string, text: string): { units: ParsedUnit[]; words: ParsedWord[] } | null {
  if (preset !== 'lvbao-n2') return null;
  if (/二级重要語彙/.test(fileName)) {
    const units = glossUnits(JA_N2_ADJECTIVES);
    return { units, words: glossWords(JA_N2_ADJECTIVES, units.map((u) => u.body).join('\n')) };
  }
  if (/听力必备词汇・短语3|听力必备词汇与短语3/.test(fileName)) {
    const units = glossUnits(JA_N2_LISTENING);
    return { units, words: glossWords(JA_N2_LISTENING, units.map((u) => u.body).join('\n')) };
  }
  if (/听力必备词汇与短语5/.test(fileName)) {
    const body = JA_N2_LISTENING_QUESTIONS.join('\n');
    return {
      units: [
        {
          idx: 0,
          title: '听力提问方式速查（内容总结篇）',
          body,
          charCount: body.length,
          pageFrom: null,
          pageTo: null,
        },
      ],
      words: [],
    };
  }
  if (/答疑整理/.test(fileName)) {
    return { units: questionUnits(text), words: [] };
  }
  return null;
}


/** 扫描件走本机 Vision OCR：输出带页码的文本，再按页清洗页眉页脚与纯数字行 */
async function ocrDocument(filePath: string, pageRange?: string): Promise<ExtractedDoc> {
  const out = path.join(os.tmpdir(), `ocr-${path.basename(filePath, path.extname(filePath))}-${Date.now()}.txt`);
  const range = pageRange?.split('-').map((value) => Number(value)).filter((value) => Number.isFinite(value)) ?? [];
  execFileSync('swift', [path.join('scripts', 'ocrPdf.swift'), filePath, out, ...range.map(String)], {
    stdio: 'inherit',
    env: { ...process.env, OCR_SCALE: process.env.OCR_SCALE ?? '2', OCR_LANGS: process.env.OCR_LANGS ?? 'ja-JP,zh-Hans' },
  });
  const raw = fs.readFileSync(out, 'utf8');
  fs.rmSync(out, { force: true });
  const pages = raw
    .split(/\n===== PAGE \d+ =====\n/)
    .slice(1)
    .map((page) => page.trim())
    .filter(Boolean);
  return { text: pages.join('\n\n'), pages: stripRunningHeads(pages), format: 'pdf-ocr' };
}

/** 页眉页脚在多数页面重复出现，按「出现在 30% 以上页面且不长」判掉；纯页码一行也去掉 */
function stripRunningHeads(pages: string[]): string[] {
  const freq = new Map<string, number>();
  for (const page of pages) {
    for (const line of new Set(page.split('\n').map((item) => item.trim()))) {
      if (!line) continue;
      freq.set(line, (freq.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.round(pages.length * 0.3));
  return pages.map((page) =>
    page
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/^[\d\s\-–—·.]+$/.test(line)) return false;
        return !((freq.get(line) ?? 0) >= threshold && line.length <= 40);
      })
      .join('\n'),
  );
}

async function importOne(args: Args, filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  if (!['.pdf', '.epub', '.docx', '.txt', '.md', '.html', '.htm'].includes(ext)) return;

  const existing = listMaterials(args.lang).find((item) => item.fileName === fileName);
  if (existing && !args.force) {
    console.log(`跳过（已入库）：${fileName} → ${existing.title}`);
    return;
  }

  const buffer = fs.readFileSync(filePath);
  const doc = args.ocr && ext === '.pdf' ? await ocrDocument(filePath, args.pages) : await extractDocument(buffer, fileName);
  const preset = presetUnits(args.preset ?? '', fileName, doc.text);

  const kind: MaterialKind =
    args.kind ?? (preset ? (preset.words.length > 0 ? 'vocab' : 'notes') : detectMaterialKind(fileName));
  const presetLevelValue = presetLevel(args.preset, fileName);
  const level =
    args.level ?? (presetLevelValue !== undefined ? presetLevelValue : detectMaterialLevel(fileName, args.lang));
  const title = cleanMaterialTitle(fileName) || fileName;

  const units = preset?.units.length ? preset.units : splitIntoUnits(doc);
  if (units.length === 0) {
    console.log(`跳过（切不出章节，可能是扫描版）：${fileName}`);
    return;
  }
  const words = preset ? preset.words : extractWords(units, args.lang);

  if (args.dry) {
    console.log(
      `[dry] ${fileName} → 《${title}》 ${kind}/${level ?? '未分级'} · ${units.length} 章 · ${words.length} 词`,
    );
    return;
  }

  const material = saveMaterial({
    language: args.lang,
    title,
    format: doc.format,
    fileName,
    fileSize: buffer.length,
    charCount: doc.text.length,
    level: level ?? null,
    kind,
    origin: args.origin,
    note: preset
      ? '按资料原始结构整理，释义由本项目逐条补齐'
      : args.ocr
        ? '扫描版经本机 OCR 转写，个别汉字/假名可能识别有误，请对照原书；不建议直接用于精读背诵'
        : null,
    units,
    words,
  });

  const withMeaning = words.filter((word) => word.meaning).length;
  console.log(
    `入库：《${material.title}》 ${kind}/${level ?? '未分级'} · ${material.unitCount} 章 · ${material.wordCount} 词（释义 ${withMeaning}）`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  runMigrations();

  const files: string[] = [];
  if (args.file) {
    files.push(path.resolve(args.file.replace(/^~/, process.env.HOME ?? '~')));
  }
  if (args.dir) {
    const dir = path.resolve(args.dir.replace(/^~/, process.env.HOME ?? '~'));
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(pdf|epub|docx|txt|md|html?)$/i.test(name)) continue;
      if (args.match && !name.includes(args.match)) continue;
      if (args.preset === 'lvbao-n2' && !/lv宝书/.test(name)) continue;
      files.push(path.join(dir, name));
    }
  }
  if (files.length === 0) {
    console.error('没有找到待导入文件，请用 --file 或 --dir 指定。');
    process.exit(1);
  }

  for (const file of files.sort()) {
    await importOne(args, file);
  }
  closeDb();
}

main().catch((error) => {
  console.error('导入失败：', (error as Error).message);
  process.exit(1);
});
