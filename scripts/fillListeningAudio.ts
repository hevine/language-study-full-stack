/**
 * 听力题补朗读稿：只给「没有 audioText」的听力题补，不动已有题目。
 *
 *   npm run fill:audio -- --paper imp-ja-2026-dfbbb792 --file "~/Documents/N3.pdf"
 *   npm run fill:audio -- --paper ... --file ... --from-backup .data/topup-backup-xxx.json --dry
 *
 * 两个来源，按优先级：
 *   1. 同卷已有的题（--from-backup 或库里其他听力题）：选项集合完全一致的，直接接过来 ——
 *      朗读稿和选项顺序无关，接过来最可靠；老题的答案来自答案区解析时，答案也一起接。
 *   2. 卷末答案区：听力原文与问句在答案区里是「脚本 + 问句」成对出现的，
 *      按问句定位，再往回收集到上一个脚本边界，就是这一题的朗读稿。
 *
 * 为什么不重抽：重抽会把整块题换掉，模型常常只给题干不给朗读稿，
 * 于是「题数对了、点播放却没声音」——听力题没有朗读稿等于没法做。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, runMigrations } from '../server/src/db';
import { getPaper, listItems, upsertExternalPaper, type ExamItemRow } from '../server/src/repositories/exams';
import { extractDocument } from '../server/src/services/materialParse';
import { splitExamDocument } from '../server/src/services/examStructure';

function arg(name: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return '';
}

const squash = (text: string): string => text.replace(/[\s、。,.・「」『』?？!！:：()（）]/g, '');

/** 选项集合一致就认为是同一道题：听力选项短、区分度高，比题干稳 */
function optionKey(options: string[]): string {
  return options.map((option) => squash(option)).sort().join('|');
}

interface ScriptHit {
  audio: string;
  score: number;
}

const JUNK = /^(\d{1,3}\s*[、.]?\s*(答案|解析)|解析[:：]?|答案[:：]?|【听力原文】|[-－—]{2,})/;

/** 从答案区里按问句找回朗读稿：脚本紧挨在问句前面 */
function locateScript(answerRegion: string, stem: string): ScriptHit | null {
  const lines = answerRegion.split(/\r?\n/);
  const needle = squash(stem).replace(/[?？]$/, '');
  if (needle.length < 6) return null;
  // 用问句尾部当指纹：开头常被 OCR 断行，尾部更稳定
  const tail = needle.slice(-14);

  let bestAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = squash(lines[i]);
    if (line.includes(tail)) bestAt = i;
  }
  if (bestAt < 0) return null;

  // 往回收集到上一个脚本边界。答案区里「【听力原文】」是每段脚本的分隔符，
  // 比「上一句问句」可靠：表格里的「N、答案：」会插进脚本中间，不能当成边界。
  const collected: string[] = [];
  for (let i = bestAt - 1; i >= 0 && collected.length < 40; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (/^=====\s*PAGE/i.test(raw)) break;
    if (/^【听力原文】$/.test(raw)) break;
    if (JUNK.test(raw)) continue;
    collected.push(raw);
  }
  // 问句有时和脚本最后一句挤在同一行（OCR 少了个换行），把问句前面那半句接回去
  const stemBody = stem.trim().replace(/[?？]$/, '');
  const rawBest = lines[bestAt];
  const cut = stemBody.length >= 4 ? rawBest.lastIndexOf(stemBody) : -1;
  const prefix = cut > 0 ? rawBest.slice(0, cut).trim() : '';

  // 逆序后，开头若是上一题的问句，说明多收了一行
  collected.reverse();
  if (prefix.length >= 8) collected.push(prefix);
  // 上一题的问句要丢掉，但「场景＋问句」连在一起的开场句不能丢
  while (
    collected.length > 0
    && /[?？]$/.test(collected[0])
    && collected[0].length > 8
    && !/(話しています|言っています)/.test(collected[0])
  ) {
    collected.shift();
  }
  if (collected.length < 3) return null;
  const audio = collected.join('\n');
  if (audio.length < 60) return null;
  return { audio, score: audio.length };
}

/** 朗读稿是否完整：有场景开场句、结尾是句号/问号 */
function looksComplete(audio: string): boolean {
  const head = audio.slice(0, 80);
  const tail = audio.trim().slice(-1);
  return /(話しています|言っています|言います|話します)/.test(head) && /[。.?？]/.test(tail);
}

async function main(): Promise<void> {
  const paperId = arg('paper');
  const fileArg = arg('file');
  const backupArg = arg('from-backup');
  const dry = process.argv.includes('--dry');
  if (!paperId || !fileArg) {
    console.error('用法：npm run fill:audio -- --paper <卷子 id> --file <原卷 pdf> [--from-backup <json>] [--dry]');
    process.exit(1);
  }

  runMigrations();
  const paper = getPaper(paperId);
  if (!paper) {
    console.error(`题库里没有这份卷子：${paperId}`);
    process.exit(1);
  }
  const rows = listItems(paperId);
  const redo = process.argv.includes('--redo');
  // --only 1,2 = 只处理这些库内序号（idx），用于重建个别题
  const only = (arg('only') || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
  const blank = rows.filter((row) =>
    row.sectionKey === 'listening'
    && (only.length > 0
      ? only.includes(row.idx)
      // 空的一律补；--redo 只补「长但明显被截断」的（短句型的即時応答本来就只有一句话）
      : redo
        ? row.audioText.trim().length === 0 || (row.audioText.trim().length >= 100 && !looksComplete(row.audioText))
        : row.audioText.trim().length === 0),
  );
  if (blank.length === 0) {
    console.log('所有听力题都已有朗读稿，无需补齐。');
    closeDb();
    return;
  }
  console.log(`听力题 ${rows.filter((row) => row.sectionKey === 'listening').length} 道，其中 ${blank.length} 道缺朗读稿。`);

  // 候选：库里其他已有朗读稿的听力题 + 备份里的旧题
  const donors: Array<{ options: string[]; stem: string; audioText: string; answer: number; answerSource: string; explanation: string }> = [];
  for (const row of rows) {
    if (row.sectionKey !== 'listening' || row.audioText.trim().length === 0) continue;
    if (blank.some((item) => item.id === row.id)) continue;
    donors.push({
      options: row.options,
      stem: row.stem,
      audioText: row.audioText,
      answer: row.answer,
      answerSource: row.answerSource,
      explanation: row.explanation,
    });
  }
  if (backupArg) {
    const backup = JSON.parse(fs.readFileSync(backupArg.replace(/^~/, os.homedir()), 'utf8')) as {
      items: Array<{ sectionKey: string; options: string[]; stem: string; audioText: string; answer: number; answerSource: string; explanation: string }>;
    };
    for (const item of backup.items) {
      if (item.sectionKey === 'listening' && item.audioText.trim().length > 0) {
        donors.push({
          options: item.options,
          stem: item.stem,
          audioText: item.audioText,
          answer: item.answer,
          answerSource: item.answerSource,
          explanation: item.explanation,
        });
      }
    }
  }
  console.log(`可用作朗读稿来源的旧题：${donors.length} 道`);

  const doc = await extractDocument(fs.readFileSync(fileArg.replace(/^~/, os.homedir())), path.basename(fileArg));
  const split = splitExamDocument(doc.text, doc.pages);

  const byOptions = new Map<string, typeof donors>();
  for (const donor of donors) {
    if (donor.options.length < 2) continue;
    const key = optionKey(donor.options);
    const list = byOptions.get(key) ?? [];
    list.push(donor);
    byOptions.set(key, list);
  }

  const patched = new Map<string, ExamItemRow>();
  const summary: Array<{ idx: number; stem: string; source: string; chars: number }> = [];

  for (const row of blank) {
    let audio = '';
    let source = '';
    let stem = row.stem;
    let answer = row.answer;
    let answerSource = row.answerSource;
    let explanation = row.explanation;

    const hit = byOptions.get(optionKey(row.options));
    const donor = hit && hit.length === 1 ? hit[0] : null;
    const candidates: Array<{ audio: string; source: string }> = [];
    if (donor) {
      candidates.push({ audio: donor.audioText, source: '同卷旧题（选项一致）' });
      // 老题的答案来自答案区解析时更可信；选项完全一致，下标可以直接搬
      if (donor.answerSource === 'key' || donor.answerSource === 'explain') {
        answer = donor.answer;
        answerSource = donor.answerSource;
        explanation = donor.explanation;
      }
    }
    const located = locateScript(split.answerRegion, row.stem);
    if (located) candidates.push({ audio: located.audio, source: '答案区（按问句定位）' });

    // 完整的优先，完整的里面取最长的（多出来的通常是开场句）
    const ranked = candidates
      .filter((item) => looksComplete(item.audio))
      .sort((a, b) => b.audio.length - a.audio.length);
    const pick = ranked[0] ?? candidates.sort((a, b) => b.audio.length - a.audio.length)[0];
    if (pick) {
      audio = pick.audio;
      source = pick.source;
      // 题干和朗读稿对不上（模型按选项猜了个问句），就把老题的问句接过来
      if (!squash(audio).includes(squash(stem))) {
        // 考场上是「场景 → 问句」，脚本里没有问句时补在末尾，点播放才听得到问题
        const fromAudio = (audio.match(/[^。？?\n]{6,}(?:何と言いますか|何をしますか|何ですか|どうしますか|と言っていますか)[。？?]?/g) ?? []).pop();
        if (donor && donor.stem) {
          stem = donor.stem;
        } else if (fromAudio) {
          stem = fromAudio.trim();
        }
      }
      if (!squash(audio).includes(squash(stem))) audio = `${audio.trimEnd()}\n${stem}`;
    }

    if (!audio) {
      summary.push({ idx: row.idx, stem: row.stem.slice(0, 24), source: '未找到', chars: 0 });
      continue;
    }
    patched.set(row.id, { ...row, stem, audioText: audio, answer, answerSource, explanation });
    summary.push({ idx: row.idx, stem: row.stem.slice(0, 24), source, chars: audio.length });
  }

  console.log('\n补齐情况：');
  for (const row of summary) {
    console.log(`  #${String(row.idx).padStart(2)} ${row.stem.padEnd(26)} ${row.source}${row.chars ? ` · ${row.chars} 字` : ''}`);
  }

  if (dry) {
    console.log('\n--dry：没有写库。');
    closeDb();
    return;
  }
  if (patched.size === 0) {
    console.log('\n没有可补的朗读稿，题库未改动。');
    closeDb();
    return;
  }

  const rebuilt: Array<Omit<ExamItemRow, 'id' | 'paperId'>> = rows.map((row) => {
    const next = patched.get(row.id) ?? row;
    return {
      idx: next.idx,
      section: next.section,
      sectionKey: next.sectionKey,
      questionNo: next.questionNo,
      kind: next.kind,
      stem: next.stem,
      passage: next.passage,
      audioText: next.audioText,
      audioUrl: next.audioUrl,
      options: next.options,
      answer: next.answer,
      answerSource: next.answerSource,
      explanation: next.explanation,
      sampleAnswer: next.sampleAnswer,
      minWords: next.minWords,
    };
  });

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
    sections: paper.sections,
    importFile: paper.importFile,
    importMeta: { ...paper.importMeta, answerStats, lastAudioFill: { at: new Date().toISOString(), filled: patched.size } },
    items: rebuilt.map((item) => ({ ...item, questionNo: item.questionNo })),
  });

  console.log(`\n已补 ${patched.size} 道听力题的朗读稿（题库仍为 ${rows.length} 题）。`);
  closeDb();
}

main().catch((err: unknown) => {
  console.error('补朗读稿失败：', (err as Error).message);
  process.exit(1);
});
