/**
 * 语法书入库：把《精编语法》这类句型手册拆成「一个句型一条」的教材单元。
 *
 *   npm run import:grammar -- --file "~/Documents/精编语法.pdf" --level n2
 *   npm run import:grammar -- --file ... --title 精编语法 --dry    # 只看解析结果，不写库
 *   npm run import:grammar -- --file ... --force                  # 同名的先删再导
 *
 * 与 import:material 的区别：教材按 4200 字符切章，语法书要按句型切；
 * 每条单元存成「接续/释义/类义/例句/译文」五段，出题时直接取字段，不用再猜。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, runMigrations } from '../server/src/db';
import {
  cleanMaterialTitle,
  extractDocument,
  detectMaterialLevel,
} from '../server/src/services/materialParse';
import { formatPatternForPrompt, parseGrammarBook, isUsablePattern } from '../server/src/services/grammarBook';
import { deleteMaterial, listMaterials, saveMaterial } from '../server/src/repositories/materials';
import type { ParsedUnit } from '../server/src/services/materialParse';
import type { LexLanguage } from '../server/src/content/lexicon';

interface Args {
  file: string;
  lang: LexLanguage;
  level?: string;
  title?: string;
  origin: string;
  force: boolean;
  dry: boolean;
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
  if (!file) {
    console.error('缺少 --file（要导入的 PDF/DOCX/TXT）');
    process.exit(1);
  }
  return {
    file: path.resolve(file.replace(/^~/, os.homedir())),
    lang: (map.get('lang') ?? 'ja') as LexLanguage,
    level: map.get('level'),
    title: map.get('title'),
    origin: map.get('origin') ?? 'local-book',
    force: flags.has('force'),
    dry: flags.has('dry'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  runMigrations();

  const fileName = path.basename(args.file);
  const buffer = fs.readFileSync(args.file);
  const doc = await extractDocument(buffer, fileName);
  const patterns = parseGrammarBook(doc.text);
  const usable = patterns.filter(isUsablePattern);

  console.log(`原文 ${doc.pages.length} 页 / ${doc.text.length} 字符`);
  console.log(`识别出 ${patterns.length} 个句型，其中 ${usable.length} 条有接续或释义`);

  if (usable.length === 0) {
    console.error('一条句型都没解析出来——检查一下 PDF 是不是纯图片（需要先 OCR）。');
    process.exit(1);
  }

  const level = args.level ?? detectMaterialLevel(fileName, args.lang) ?? null;
  const title = args.title?.trim() || cleanMaterialTitle(fileName) || '语法书';

  console.log('\n前 3 条预览：');
  usable.slice(0, 3).forEach((pattern) => {
    console.log('· ' + formatPatternForPrompt(pattern).split('\n').join(' ｜ '));
  });

  const units: ParsedUnit[] = usable.map((pattern, idx) => {
    const body = [
      `接续：${pattern.keigu || '（原书未单独标注）'}`,
      `释义：${pattern.gist || '（原书未单独标注）'}`,
      pattern.similar.length > 0 ? `类义：\n${pattern.similar.map((line) => `・${line}`).join('\n')}` : '',
      pattern.example ? `例句：${pattern.example}` : '',
      pattern.translation ? `译文：${pattern.translation}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {
      idx,
      title: pattern.pattern.slice(0, 60),
      body,
      charCount: body.length,
      pageFrom: null,
      pageTo: null,
    };
  });

  if (args.dry) {
    console.log(`\n--dry：会写入《${title}》 ${units.length} 章（${level ?? '未分级'}/grammar），不写库。`);
    closeDb();
    return;
  }

  const existing = listMaterials(args.lang, { kind: 'grammar' }).filter((item) => item.title === title);
  if (existing.length > 0) {
    if (!args.force) {
      console.log(`\n库里已有同名的《${title}》（${existing[0].unitCount} 章），加 --force 才会重导。`);
      closeDb();
      return;
    }
    for (const item of existing) deleteMaterial(item.id);
    console.log(`已删除同名的旧版本 ${existing.length} 份`);
  }

  const material = saveMaterial({
    language: args.lang,
    title,
    format: path.extname(fileName).replace('.', '') || 'txt',
    fileName,
    fileSize: buffer.length,
    charCount: doc.text.length,
    level,
    kind: 'grammar',
    origin: args.origin,
    note: `句型手册：${units.length} 个句型，供「AI 加练 · 拆句」按天轮换出题`,
    units,
    words: [],
  });

  console.log(
    `\n入库：《${material.title}》 ${material.kind}/${material.level ?? '未分级'} · ${material.unitCount} 个句型 · ${material.charCount} 字符`,
  );
  closeDb();
}

main().catch((error) => {
  console.error('导入失败：', (error as Error).message);
  process.exit(1);
});
