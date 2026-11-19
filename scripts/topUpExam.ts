/**
 * 定点补抽：只对「原卷小题数 > 库内题数」的大题重抽，新结果题数更多才替换。
 *
 *   npm run topup:exam -- --paper imp-ja-2026-dfbbb792 --file "~/Documents/N3.pdf"
 *   npm run topup:exam -- --paper imp-ja-2026-dfbbb792 --file "..." --only 1,2,4,7
 *   npm run topup:exam -- --paper imp-ja-2026-dfbbb792 --file "..." --dry     # 只看差多少，不调模型
 *
 * 为什么单独做一条通道：
 *   整卷重导一次要跑 17 块、半小时，线路一抖就可能把已有好题一起覆盖掉。
 *   这里按块比对「原文几处小题 vs 库里几道题」，只补缺的那几块，
 *   并且**只有新结果题数更多才写库**，其余块与已有题目原样保留。
 *
 * 写库前会把整卷题目备份到 .data/topup-backup-<paper>-<时间>.json，出问题可以直接还原。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { closeDb, runMigrations } from '../server/src/db';
import { ensureExamBank, getPaper, listItems, upsertExternalPaper } from '../server/src/repositories/exams';
import { extractDocument } from '../server/src/services/materialParse';
import {
  countQuestionMarks,
  sectionDisplayName,
  splitExamDocument,
  type ExamBlock,
} from '../server/src/services/examStructure';
import {
  buildBlockMessages,
  sanitizeBlockItems,
  type ExamImportInput,
} from '../server/src/services/examImport';
import { chatJson, resolveLlmConfig } from '../server/src/services/llm';

const DraftSchema = z
  .object({
    sectionKey: z.unknown().optional(),
    minutes: z.unknown().optional(),
    items: z.array(z.unknown()).default([]),
  })
  .passthrough();

type BlockDraft = z.infer<typeof DraftSchema>;

function arg(name: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return '';
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * 解析「大题号=值」形式的参数，可重复或用逗号分隔：
 *   --expect 7=2,3=4        --context 7=/tmp/p20.txt
 */
function pairs(name: string): Map<number, string> {
  const out = new Map<number, string>();
  const values: string[] = [];
  process.argv.forEach((item, index) => {
    if (item.startsWith(`--${name}=`)) values.push(item.slice(name.length + 3));
    else if (item === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]);
  });
  for (const chunk of values) {
    for (const piece of chunk.split(',')) {
      const [left, ...rest] = piece.split('=');
      const no = Number(left.trim());
      if (Number.isInteger(no) && no > 0 && rest.length > 0) out.set(no, rest.join('=').trim());
    }
  }
  return out;
}

interface DraftItem {
  section: string;
  sectionKey: string;
  questionNo: number;
  kind: 'choice' | 'writing';
  stem: string;
  passage: string;
  audioText: string;
  audioUrl: string;
  options: string[];
  answer: number;
  answerSource: 'key' | 'explain' | 'solve' | 'none';
  explanation: string;
  sampleAnswer: string;
  minWords: number;
}

async function main(): Promise<void> {
  const paperId = arg('paper');
  const fileArg = arg('file');
  const only = arg('only')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  const dry = hasFlag('dry');
  // 有些大题的排版让「小题数」无从数起（情報検索的题号是「1、」，后面直接跟问句），
  // 那就允许手工指定；配图/表格是图片时，用 --context 把 OCR 文本贴进这一块的原文里。
  const expectOverride = pairs('expect');
  const contextFiles = pairs('context');
  // 配図（情報検索的表格、广告页）是图片时，用它当这一块的 passage，作答页才读得到材料
  const passageFiles = pairs('passage');

  if (!paperId || !fileArg) {
    console.error('用法：npm run topup:exam -- --paper <卷子 id> --file <原卷 pdf> [--only 1,2,4,7] [--dry]');
    process.exit(1);
  }

  const filePath = fileArg.replace(/^~/, os.homedir());
  if (!fs.existsSync(filePath)) {
    console.error(`找不到原卷文件：${filePath}`);
    process.exit(1);
  }

  runMigrations();
  ensureExamBank();

  const paper = getPaper(paperId);
  if (!paper) {
    console.error(`题库里没有这份卷子：${paperId}`);
    process.exit(1);
  }
  const rows = listItems(paperId);
  const keyOf = (sectionKey: string, questionNo: number): string => `${sectionKey}::${questionNo}`;

  const current = new Map<string, DraftItem[]>();
  for (const row of rows) {
    const key = keyOf(row.sectionKey, row.questionNo);
    const list = current.get(key) ?? [];
    list.push({
      section: row.section,
      sectionKey: row.sectionKey,
      questionNo: row.questionNo,
      kind: row.kind,
      stem: row.stem,
      passage: row.passage,
      audioText: row.audioText,
      audioUrl: row.audioUrl,
      options: row.options,
      answer: row.answer,
      answerSource: row.answerSource,
      explanation: row.explanation,
      sampleAnswer: row.sampleAnswer,
      minWords: row.minWords,
    });
    current.set(key, list);
  }

  console.log(`原卷读入：${filePath}`);
  const buffer = fs.readFileSync(filePath);
  const doc = await extractDocument(buffer, path.basename(filePath));
  const split = splitExamDocument(doc.text, doc.pages);
  console.log(`切出 ${split.blocks.length} 个大题 · 答案区 ${split.answerRegion.length} 字符`);

  const input: ExamImportInput = {
    buffer,
    fileName: path.basename(filePath),
    language: paper.language,
    year: paper.year,
    title: paper.title,
    examName: paper.examName,
    levelLabel: paper.levelLabel,
    paperType: paper.paperType,
    ocrMode: 'off',
  };

  const plan = split.blocks.map((block) => {
    const marks = countQuestionMarks(block.text);
    const override = Number(expectOverride.get(block.no) ?? 0);
    const expected = override > 0 ? override : marks.length >= 2 ? marks.length : 0;
    const key = keyOf(block.sectionKey, block.no);
    const kept = current.get(key)?.length ?? 0;
    const contextPath = contextFiles.get(block.no);
    const context = contextPath
      ? fs
          .readFileSync(contextPath.replace(/^~/, os.homedir()), 'utf8')
          .replace(/=====\s*PAGE\s*\d+\s*=====/gi, '')
          .trim()
      : '';
    return { block, key, expected, kept, context };
  });

  console.log('\n大题题量对照（原文 / 库内）：');
  for (const row of plan) {
    const gap = row.kept < row.expected ? ` ← 缺 ${row.expected - row.kept}` : '';
    console.log(
      `  問題${String(row.block.no).padStart(2)} ${sectionDisplayName(row.block.sectionKey).padEnd(6)}`
        + ` 原文 ${String(row.expected || '?').padStart(2)} / 库内 ${String(row.kept).padStart(2)}${gap}`,
    );
  }

  let targets = plan.filter((row) => row.expected > row.kept && row.kept > 0);
  const emptyBlocks = plan.filter((row) => row.kept === 0);
  if (emptyBlocks.length > 0) {
    console.log(
      `\n注意：${emptyBlocks.map((row) => `問題${row.block.no}`).join('、')} 库里一道题都没有，`
        + '补抽会把整块新增（本脚本只补「部分缺失」的块，整块为空请走重新导入）。',
    );
  }
  if (only.length > 0) targets = targets.filter((row) => only.includes(row.block.no));

  // --passage：把整块题的文字材料统一设成这份 OCR 文本（图版阅读题用）
  const passageBlocks = new Map<string, string>();
  for (const [no, file] of passageFiles) {
    const row = plan.find((entry) => entry.block.no === no);
    if (!row) continue;
    const raw = fs
      .readFileSync(file.replace(/^~/, os.homedir()), 'utf8')
      .replace(/=====\s*PAGE\s*\d+\s*=====/gi, '')
      .trim();
    // 表格后面往往跟着题号与选项，切掉：passage 只放材料本身
    const material = raw.split(/\n(?=\s*1、)/)[0].trim();
    passageBlocks.set(row.key, material);
  }

  if (targets.length === 0 && passageBlocks.size === 0) {
    console.log('\n没有需要补抽的大题（原文小题数 ≤ 库内题数）。');
    closeDb();
    return;
  }
  if (targets.length > 0) console.log(`\n需要补抽：${targets.map((row) => `問題${row.block.no}`).join('、')}`);
  if (passageBlocks.size > 0) console.log(`设置材料（passage）的大题：${passageBlocks.size} 块`);
  if (dry) {
    console.log('--dry 模式：不调用模型、不写库。');
    closeDb();
    return;
  }
  if (targets.length === 0) {
    // 只补材料，不需要模型
  }

  const config = targets.length > 0 ? resolveLlmConfig().config : null;
  if (targets.length > 0 && !config) {
    console.error('没有可用的模型线路，请先在「设置 → 模型 Key 池」里加一条。');
    process.exit(1);
  }
  if (config) console.log(`线路：${config.model} @ ${config.baseUrl}`);

  const backupPath = path.resolve(
    `.data/topup-backup-${paperId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(backupPath, JSON.stringify({ paperId, paper, items: rows }, null, 2));
  console.log(`已备份现有 ${rows.length} 题 → ${backupPath}\n`);

  const replaced = new Map<string, DraftItem[]>();
  const activeConfig = config;
  const summary: Array<{ no: number; label: string; before: number; after: number; state: string }> = [];

  for (let i = 0; i < targets.length; i += 1) {
    const { block, key, expected, kept, context } = targets[i];
    const label = `問題${block.no} · ${sectionDisplayName(block.sectionKey)}`;
    process.stdout.write(`[${i + 1}/${targets.length}] ${label}：原文 ${expected} 题 / 库内 ${kept} 题 … `);

    // 把「原文有几小题」写进原文末尾：比让模型自己数可靠得多
    // 配图型大题（情報検索的表格）另外附上本机 OCR 出来的文字，否则模型看不到表里的クラス与料金
    const contextPart = context
      ? `\n\n---------- 本大题配図・表格（本机 OCR，供读题用） ----------\n${context.slice(0, 6000)}`
      : '';
    const hinted: ExamBlock = {
      ...block,
      text: `${block.text}${contextPart}\n\n【校对提示】本大题原文共有 ${expected} 处小题（题号见上方），必须逐题输出 ${expected} 道，不要合并、不要漏题。`,
    };

    const meta: { truncated?: boolean; localRepaired?: boolean } = {};
    const deadline = Date.now() + 4 * 60 * 1000;
    let draft: BlockDraft | null = null;

    for (let attempt = 1; attempt <= 3 && Date.now() < deadline; attempt += 1) {
      const line = resolveLlmConfig().config ?? activeConfig!;
      try {
        draft = await chatJson(
          line,
          buildBlockMessages(input, hinted, split.answerRegion, true),
          DraftSchema,
          { temperature: 0.2, maxTokens: 9000, retries: 1, meta },
        );
        if (draft.items.length > 0) break;
        process.stdout.write(`第 ${attempt} 次空结果… `);
      } catch (err) {
        process.stdout.write(`第 ${attempt} 次失败（${(err as Error).message.slice(0, 40)}）… `);
      }
    }

    if (!draft || draft.items.length === 0) {
      console.log('放弃，保留原题。');
      summary.push({ no: block.no, label, before: kept, after: kept, state: '未取到新题' });
      continue;
    }

    const parsed = sanitizeBlockItems(draft.items, {
      label,
      sectionKey: block.sectionKey,
      questionNo: block.no,
      fallbackExplanation: '',
    });

    // 块内去重：听力问句高度重复，但同一块里完全不重名的才算不同题
    const seen = new Set<string>();
    const fresh: DraftItem[] = [];
    for (const item of parsed.items) {
      const stemKey = item.stem.replace(/[\s、。,.・「」『』]/g, '').slice(0, 60);
      if (seen.has(stemKey)) continue;
      seen.add(stemKey);
      fresh.push({
        section: item.section,
        sectionKey: item.sectionKey,
        questionNo: item.questionNo,
        kind: item.kind,
        stem: item.stem,
        passage: item.passage,
        audioText: item.audioText,
        audioUrl: '',
        options: item.options,
        answer: item.answer,
        answerSource: item.answerSource,
        explanation: item.explanation,
        sampleAnswer: item.sampleAnswer,
        minWords: item.minWords,
      });
    }

    if (fresh.length > kept) {
      replaced.set(key, fresh);
      console.log(`新抽 ${fresh.length} 题 › 库内 ${kept} 题，替换。`);
      summary.push({ no: block.no, label, before: kept, after: fresh.length, state: '已替换' });
    } else {
      console.log(`新抽 ${fresh.length} 题 ≤ 库内 ${kept} 题，保留原题。`);
      summary.push({ no: block.no, label, before: kept, after: kept, state: '保留原题' });
    }
  }

  if (replaced.size === 0 && passageBlocks.size === 0) {
    console.log('\n这一轮没有一块抽出更多题，题库未改动。');
    console.log('建议换一条线路（设置 → 模型 Key 池）后再跑；已有题目一题未动。');
    closeDb();
    return;
  }

  // 按原卷顺序拼回：替换的块整块换掉，其余块保持原样与原顺序
  const rebuilt: DraftItem[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row.sectionKey, row.questionNo);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const swap = replaced.get(key);
    const material = passageBlocks.get(key);
    const items = swap ?? current.get(key) ?? [];
    rebuilt.push(...(material ? items.map((item) => ({ ...item, passage: material })) : items));
  }

  const counts = new Map<string, number>();
  for (const item of rebuilt) {
    const key = keyOf(item.sectionKey, item.questionNo);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sections = paper.sections.map((section) => {
    if (section.no === undefined) return section;
    const hit = counts.get(keyOf(section.key, section.no));
    return hit === undefined ? section : { ...section, count: hit };
  });

  const coverage = Array.isArray(paper.importMeta.coverage) ? [...paper.importMeta.coverage] : [];
  for (const section of sections) {
    if (section.no === undefined) continue;
    const row = coverage.find((entry) => entry.no === section.no && entry.label.includes(`問題${section.no}`));
    if (!row) continue;
    row.count = section.count;
  }
  const answerStats = {
    fromKey: rebuilt.filter((item) => item.answerSource === 'key').length,
    fromExplain: rebuilt.filter((item) => item.answerSource === 'explain').length,
    fromSolve: rebuilt.filter((item) => item.answerSource === 'solve').length,
  };

  upsertExternalPaper({
    id: paper.id,
    language: paper.language,
    year: paper.year,
    examName: paper.examName,
    levelLabel: paper.levelLabel,
    title: paper.title,
    paperType: paper.paperType,
    sourceNote: paper.sourceNote,
    originUrl: paper.originUrl,
    durationMin: paper.durationMin,
    sections,
    importFile: paper.importFile,
    importMeta: {
      ...paper.importMeta,
      coverage,
      answerStats,
      lastTopUp: {
        at: new Date().toISOString(),
        blocks: summary,
      },
    },
    items: rebuilt,
  });

  console.log('\n补抽结果：');
  for (const row of summary) {
    console.log(`  ${row.label}：${row.before} → ${row.after}（${row.state}）`);
  }
  console.log(`\n题库：${rows.length} → ${rebuilt.length} 题`);
  console.log(`备份：${backupPath}`);
  console.log('接口服务是长连接读库，刷新「升级自测」页面即可看到新题量。');
  closeDb();
}

main().catch((err: unknown) => {
  console.error('补抽失败：', (err as Error).message);
  process.exit(1);
});
