/**
 * 真题 / 自制卷导入脚本
 *
 *   npm run import:exam -- --file ~/Downloads/n1-2019-07.json
 *   npm run import:exam -- --file ./my-papers.json --dry
 *
 * 为什么要有这条通道：
 *   真题原卷受版权保护，不能内置随应用分发；你能合法拿到的原卷（买的书、官方公开的样卷、
 *   自己整理的题库）用这个脚本一次性录入，之后就能在「升级自测」里按年份选到，并享受
 *   计时、判分、逐题解析、写作范文的完整考试环境。
 *
 * 文件格式（JSON）：
 * {
 *   "papers": [{
 *     "id": "ja-2019-07-real",          // 全局唯一；重复导入会覆盖同一份卷
 *     "language": "ja",                  // en | ja | ko
 *     "year": 2019,
 *     "examName": "JLPT 日本语能力测试",
 *     "levelLabel": "N1",
 *     "title": "2019 年 7 月卷",
 *     "paperType": "real",               // real 真卷 / mock 自制 / ai 生成
 *     "sourceNote": "自购原卷录入",
 *     "originUrl": "",                   // 可选，来源链接
 *     "sections": [
 *       { "key": "listening", "label": "聴解", "minutes": 40 }
 *     ],
 *     "items": [{
 *       "section": "聴解",               // 题面上显示的题型名
 *       "sectionKey": "listening",       // listening | vocab | grammar | reading | writing
 *       "kind": "choice",                // choice（自动判分）| writing（写作题）
 *       "stem": "質問文",
 *       "passage": "",                   // 阅读材料，可空
 *       "audioText": "音声スクリプト",     // 听力题的朗读稿：作答时只播放、不显示
 *       "audioUrl": "",                  // 有真实音频时填可访问地址
 *       "options": ["A", "B", "C", "D"],
 *       "answer": 0,                     // 正确选项下标（0 起）
 *       "explanation": "解析",
 *       "sampleAnswer": "",              // 写作题参考范文
 *       "minWords": 0                    // 写作题最少字数
 *     }]
 *   }]
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, runMigrations } from '../server/src/db';
import { ensureExamBank, upsertExternalPaper } from '../server/src/repositories/exams';

const LANGS = new Set(['en', 'ja', 'ko']);
const SECTION_KEYS = new Set(['listening', 'vocab', 'grammar', 'reading', 'writing']);

interface RawItem {
  section?: unknown;
  sectionKey?: unknown;
  kind?: unknown;
  stem?: unknown;
  passage?: unknown;
  audioText?: unknown;
  audioUrl?: unknown;
  options?: unknown;
  answer?: unknown;
  explanation?: unknown;
  sampleAnswer?: unknown;
  minWords?: unknown;
}

interface RawPaper {
  id?: unknown;
  language?: unknown;
  year?: unknown;
  examName?: unknown;
  levelLabel?: unknown;
  title?: unknown;
  paperType?: unknown;
  sourceNote?: unknown;
  originUrl?: unknown;
  durationMin?: unknown;
  sections?: unknown;
  items?: unknown;
}

function argsOf(argv: string[]): { file?: string; dry: boolean } {
  const args: { file?: string; dry: boolean } = { dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') args.file = argv[i + 1];
    else if (arg === '--dry') args.dry = true;
  }
  return args;
}

function fail(message: string): never {
  throw new Error(message);
}

function normalizeItem(raw: RawItem, where: string) {
  const kind = raw.kind === 'writing' ? 'writing' : 'choice';
  const sectionKey = String(raw.sectionKey ?? '');
  if (!SECTION_KEYS.has(sectionKey)) fail(`${where}：sectionKey 必须是 listening/vocab/grammar/reading/writing`);
  const stem = String(raw.stem ?? '').trim();
  if (!stem) fail(`${where}：stem 不能为空`);

  const options = Array.isArray(raw.options) ? raw.options.map((item) => String(item)) : [];
  let answer = -1;
  if (kind === 'choice') {
    if (options.length < 2) fail(`${where}：选择题至少要 2 个选项`);
    answer = Number(raw.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
      fail(`${where}：answer 必须是 0 ~ ${options.length - 1} 之间的整数`);
    }
  }

  return {
    section: String(raw.section ?? sectionKey),
    sectionKey,
    kind: kind as 'choice' | 'writing',
    stem,
    passage: String(raw.passage ?? ''),
    audioText: String(raw.audioText ?? ''),
    audioUrl: String(raw.audioUrl ?? ''),
    options,
    answer,
    explanation: String(raw.explanation ?? ''),
    sampleAnswer: String(raw.sampleAnswer ?? ''),
    minWords: Number(raw.minWords ?? 0) || 0,
  };
}

function normalizePaper(raw: RawPaper) {
  const id = String(raw.id ?? '').trim();
  if (!id) fail('papers[].id 不能为空');
  const language = String(raw.language ?? '');
  if (!LANGS.has(language)) fail(`${id}：language 必须是 en/ja/ko`);
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year < 1990 || year > 2100) fail(`${id}：year 不合理`);

  const items = Array.isArray(raw.items) ? raw.items : [];
  if (items.length === 0) fail(`${id}：items 不能为空`);
  const normalizedItems = items.map((item, index) => normalizeItem(item as RawItem, `${id} 第 ${index + 1} 题`));

  const sections = Array.isArray(raw.sections)
    ? (raw.sections as Array<Record<string, unknown>>).map((section) => ({
        key: String(section.key ?? ''),
        label: String(section.label ?? section.key ?? ''),
        count: Number(section.count ?? 0) || 0,
        minutes: Number(section.minutes ?? 0) || 0,
      }))
    : [];

  // 没写分项配置时，按题目自动归纳，保证界面有分项导航
  const derived =
    sections.length > 0
      ? sections
      : Array.from(new Set(normalizedItems.map((item) => item.sectionKey))).map((key) => {
          const count = normalizedItems.filter((item) => item.sectionKey === key).length;
          return {
            key,
            label: normalizedItems.find((item) => item.sectionKey === key)?.section ?? key,
            count,
            minutes: Math.max(4, count * 2),
          };
        });

  const totalMinutes =
    Number(raw.durationMin) ||
    derived.reduce((sum, section) => sum + section.minutes, 0) ||
    Math.max(10, normalizedItems.length * 2);

  return {
    id,
    language: language as 'en' | 'ja' | 'ko',
    year,
    examName: String(raw.examName ?? ''),
    levelLabel: String(raw.levelLabel ?? ''),
    title: String(raw.title ?? `${year} 年卷`),
    paperType: (raw.paperType === 'real' || raw.paperType === 'ai' ? raw.paperType : 'mock') as
      | 'real'
      | 'mock'
      | 'ai',
    sourceNote: String(raw.sourceNote ?? '导入卷'),
    originUrl: String(raw.originUrl ?? ''),
    durationMin: totalMinutes,
    sections: derived,
    items: normalizedItems,
  };
}

function main(): void {
  const args = argsOf(process.argv.slice(2));
  if (!args.file) fail('请用 --file 指定 JSON 文件');
  const abs = path.resolve(args.file.replace(/^~/, process.env.HOME ?? '~'));
  if (!fs.existsSync(abs)) fail(`文件不存在：${abs}`);

  const payload = JSON.parse(fs.readFileSync(abs, 'utf8')) as { papers?: RawPaper[] } | RawPaper[];
  const rawPapers = Array.isArray(payload) ? payload : payload.papers ?? [];
  if (rawPapers.length === 0) fail('文件里没有 papers');

  const papers = rawPapers.map(normalizePaper);

  for (const paper of papers) {
    const choice = paper.items.filter((item) => item.kind === 'choice').length;
    const writing = paper.items.length - choice;
    console.log(
      `· ${paper.language} ${paper.year} ${paper.title} — ${paper.items.length} 题` +
        `（选择 ${choice}${writing > 0 ? ` / 写作 ${writing}` : ''}）· ${paper.durationMin} 分钟`,
    );
  }

  if (args.dry) {
    console.log('\n--dry：只校验，不写库。');
    closeDb();
    return;
  }

  runMigrations();
  ensureExamBank();
  for (const paper of papers) upsertExternalPaper(paper);
  console.log(`\n已导入 ${papers.length} 份卷子。打开「升级自测」即可按年份选到。`);
  closeDb();
}

try {
  main();
} catch (error) {
  console.error('导入失败：', (error as Error).message);
  closeDb();
  process.exit(1);
}
