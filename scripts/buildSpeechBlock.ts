/**
 * 重建「発話表現 / 即時応答」大题：这类题的题面全是图，文字层只有「1番 1、1 2、2 3、3」。
 *
 *   npm run build:speech -- --paper imp-ja-2026-dfbbb792 --file "~/Documents/N3.pdf" \
 *     --block 4 --answers 1,2,0,1
 *
 * 题面与三个应答选项其实都在卷末答案区的【听力原文】里，一对一对排着：
 *   大学のパソコンルームです。友達のカバンが置いてあって通れません。なんと言いますか。
 *   1.そこ、通らないで。
 *   2.あ、ちょっとカバンどけてくれる?
 *   3.ねえ。カバン置いたらどう?
 * 所以这里不调模型：按【听力原文】切开、取「有 3 个 1./2./3. 应答」的条目，原样搬过来。
 * 正解要人来定（选项里没有标答案），用 --answers 按顺序给出下标（0 起）。
 *
 * 只替换指定大题，其他块一题不动；写库前自动备份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, runMigrations } from '../server/src/db';
import { getPaper, listItems, upsertExternalPaper, type ExamItemRow } from '../server/src/repositories/exams';
import { extractDocument } from '../server/src/services/materialParse';
import { splitExamDocument, sectionDisplayName } from '../server/src/services/examStructure';

function arg(name: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return '';
}

interface SpeechItem {
  scene: string;
  question: string;
  options: string[];
}

const JUNK = /^(\d{1,3}\s*[、.]?\s*(答案|解析)|解析[:：]?|答案[:：]?|=====)/;

/** 答案区里「场景 + なんと言いますか + 三个应答」的条目，按原卷顺序 */
function parseSpeechItems(answerRegion: string): SpeechItem[] {
  const items: SpeechItem[] = [];
  for (const chunk of answerRegion.split('【听力原文】')) {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !JUNK.test(line));
    const firstOption = lines.findIndex((line) => /^1[.．、]/.test(line));
    if (firstOption < 1) continue;

    const scene = lines.slice(0, firstOption).join('').trim();
    // 「なんと言います」常被 OCR 断掉句尾，别要求「か」
    if (!/何と言います|なんと言います/.test(scene)) continue;

    const options = lines
      .slice(firstOption)
      .filter((line) => /^[123][.．、]/.test(line))
      .map((line) => line.replace(/^[123][.．、]\s*/, '').trim())
      .slice(0, 3);
    if (options.length !== 3) continue;

    // 问句就是场景的最后一小句（场景本身以「。」结尾，所以先去掉再切）
    const body = scene.replace(/[。.]\s*$/, '');
    const tail = body.slice(body.lastIndexOf('。') + 1).trim();
    const askable = tail.replace(/言います$/, '言いますか');
    const question = askable ? `${askable}。` : 'なんと言いますか。';
    const spoken = /[。.?？]$/.test(scene) ? scene : `${scene}。`;
    items.push({ scene: spoken, question, options });
  }
  return items;
}

async function main(): Promise<void> {
  const paperId = arg('paper');
  const fileArg = arg('file');
  const blockNo = Number(arg('block') || 0);
  const answers = (arg('answers') || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
  const dry = process.argv.includes('--dry');

  if (!paperId || !fileArg || blockNo <= 0) {
    console.error('用法：npm run build:speech -- --paper <id> --file <pdf> --block 4 --answers 1,2,0,1 [--dry]');
    process.exit(1);
  }

  runMigrations();
  const paper = getPaper(paperId);
  if (!paper) {
    console.error(`题库里没有这份卷子：${paperId}`);
    process.exit(1);
  }

  const doc = await extractDocument(fs.readFileSync(fileArg.replace(/^~/, os.homedir())), path.basename(fileArg));
  const split = splitExamDocument(doc.text, doc.pages);
  const block = split.blocks.find((entry) => entry.sectionKey === 'listening' && entry.no === blockNo);
  if (!block) {
    console.error(`原卷里没有「聴解 問題${blockNo}」这一块。`);
    process.exit(1);
  }

  const parsed = parseSpeechItems(split.answerRegion);
  console.log(`答案区里找到 ${parsed.length} 条「発話表現」条目：`);
  parsed.forEach((item, index) => {
    console.log(`  ${index + 1}. ${item.scene.slice(0, 46)}… (${item.options.length} 选项)`);
  });
  if (parsed.length === 0) {
    console.error('没找到可用条目，放弃。');
    closeDb();
    return;
  }
  if (answers.length !== parsed.length) {
    console.error(`需要 ${parsed.length} 个答案下标（--answers），现在给了 ${answers.length} 个。`);
    closeDb();
    return;
  }

  const rows = listItems(paperId);
  const oldCount = rows.filter((row) => row.sectionKey === 'listening' && row.questionNo === blockNo).length;
  console.log(`\n当前「問題${blockNo} · ${sectionDisplayName('listening')}」有 ${oldCount} 题，将替换为 ${parsed.length} 题。`);
  if (dry) {
    console.log('--dry：没有写库。');
    closeDb();
    return;
  }

  const backupPath = path.resolve(
    `.data/speech-backup-${paperId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(backupPath, JSON.stringify({ paperId, paper, items: rows }, null, 2));
  console.log(`已备份现有 ${rows.length} 题 → ${backupPath}`);

  const built: ExamItemRow[] = parsed.map((item, index) => {
    const answer = answers[index];
    if (answer >= item.options.length) {
      throw new Error(`第 ${index + 1} 题的答案下标 ${answer} 超出 ${item.options.length} 个选项。`);
    }
    return {
      id: '',
      paperId,
      idx: 0,
      section: `問題${blockNo} · ${sectionDisplayName('listening')}`,
      sectionKey: 'listening',
      questionNo: blockNo,
      kind: 'choice',
      stem: item.question,
      passage: '',
      audioText: item.scene,
      audioUrl: '',
      options: item.options,
      answer,
      answerSource: 'solve',
      explanation: '按场景选出最自然的应答（原卷选项为图，答案由人工核对）。',
      sampleAnswer: '',
      minWords: 0,
    };
  });

  // 按大题顺序重排：把新题插回原来的位置，其余题原样保留
  const rebuilt: ExamItemRow[] = [];
  let inserted = false;
  for (const row of rows) {
    if (row.sectionKey === 'listening' && row.questionNo === blockNo) {
      if (!inserted) {
        rebuilt.push(...built);
        inserted = true;
      }
      continue;
    }
    rebuilt.push(row);
  }
  if (!inserted) rebuilt.push(...built);

  const counts = new Map<string, number>();
  for (const item of rebuilt) {
    const key = `${item.sectionKey}::${item.questionNo}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sections = paper.sections.map((section) =>
    section.no === undefined ? section : { ...section, count: counts.get(`${section.key}::${section.no}`) ?? section.count },
  );

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
    importMeta: { ...paper.importMeta, lastSpeechBuild: { at: new Date().toISOString(), block: blockNo, count: built.length } },
    items: rebuilt,
  });

  console.log(`\n已重建「問題${blockNo}」：${oldCount} → ${built.length} 题，题库共 ${rebuilt.length} 题。`);
  closeDb();
}

main().catch((err: unknown) => {
  console.error('重建失败：', (err as Error).message);
  process.exit(1);
});
