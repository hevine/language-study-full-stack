/**
 * 语种一致性自检（npm run check:lang）。
 *
 * 背景：曾经出现「侧栏选了韩语，右侧生成的却是托福任务」——
 * 原因是若干生成点只写了 ja 与「默认英文」两条分支，韩语掉进英文兜底：
 *   · 写作/口语命题：英语命题人 + 英文题干
 *   · 评分标准：TOPIK 落到雅思 Task 2 / Part 2
 *   · 批改提示词：托福/雅思评分官，还要求 quote/fix 用英文
 *
 * 这个脚本把「同一件事在三种语种下必须各自成立」固化成断言，
 * 任何一处再退回英文兜底，CI / 本地一跑就会红。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先隔离数据目录：下面会 import 到仓储层，避免碰到真实 .data/app.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiyu-lang-check-'));
process.env.DATA_DIR = tmpDir;

const { CATALOG } = await import('../server/src/catalog');
const { rubricFor } = await import('../server/src/domain/rubrics');
const { buildPlan } = await import('../server/src/services/planner');
const { buildArticleMessages } = await import('../server/src/services/dayArticle');
const { buildPromptMessages } = await import('../server/src/services/practice');
const { buildGradePrompt } = await import('../server/src/services/grading');
const { addDays } = await import('../server/src/lib/date');

type Lang = 'en' | 'ja' | 'ko';

const MARK: Record<Lang, { own: RegExp; foreign: Array<[RegExp, string]>; label: string }> = {
  en: {
    own: /[A-Za-z]/,
    foreign: [[/[\uac00-\ud7af]/, '韩文'], [/[\u3040-\u30ff]/, '日文假名']],
    label: '英语',
  },
  ja: {
    own: /[\u3040-\u30ff\u4e00-\u9fff]/,
    foreign: [[/[\uac00-\ud7af]/, '韩文'], [/托福|雅思|TOEFL|IELTS/, '托福/雅思'], [/英文题干|英文观点/, '英文题干']],
    label: '日语',
  },
  ko: {
    own: /[\uac00-\ud7af]/,
    foreign: [[/[\u3040-\u30ff]/, '日文假名'], [/托福|雅思|TOEFL|IELTS/, '托福/雅思'], [/英文题干|英文观点/, '英文题干']],
    label: '韩语',
  },
};

const failures: string[] = [];

function check(scope: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  ✓ ${scope}`);
    return;
  }
  console.log(`  ✗ ${scope} → ${detail}`);
  failures.push(`${scope}: ${detail}`);
}

function assertLanguage(scope: string, language: Lang, text: string, extraOwn?: RegExp): void {
  const mark = MARK[language];
  const foreignHit = mark.foreign.find(([re]) => re.test(text));
  // 英语的界面文案本来就是中文，只校验「不混进日韩」，不强制出现拉丁字母
  const ownsLanguage = language === 'en' ? true : (extraOwn ?? mark.own).test(text);
  check(
    scope,
    !foreignHit && ownsLanguage,
    foreignHit ? `出现${foreignHit[1]}内容` : `没有${mark.label}内容：${text.slice(0, 80)}`,
  );
}

const today = '2026-11-24';

for (const language of Object.keys(CATALOG) as Lang[]) {
  const lang = CATALOG[language];
  console.log(`\n=== ${lang.name} (${language}) ===`);

  // 1) 评分标准：必须与本语种的考试口径一致
  for (const exam of lang.exams) {
    for (const kind of ['write', 'speak'] as const) {
      const format = rubricFor(exam.id, language, kind);
      assertLanguage(`rubric ${exam.id}/${kind}`, language, `${format.label} ${format.taskType}`);
      if (language !== 'en') {
        check(
          `rubric ${exam.id}/${kind} 未使用英语分制`,
          !/0–5 分制|0–4 分制|Band 0–9/.test(format.scale.label),
          `分制为 ${format.scale.label}`,
        );
      }
    }
  }

  // 2) 今日任务清单（planner）：任务标题必须落在本语种
  const exam = lang.exams[0];
  const target = exam.targets[Math.min(1, exam.targets.length - 1)];
  const draft = buildPlan({
    language,
    examId: exam.id,
    currentLevelId: lang.levels[0].id,
    targetScore: target.score,
    startDate: today,
    examDate: addDays(today, 90),
    hoursPerWeek: 10,
    dailyMinutes: 90,
  });
  const tasks = draft.days[0]?.tasks ?? [];
  check(`planner 产出任务数 > 0`, tasks.length > 0, '第一天没有任务');
  for (const task of tasks.slice(0, 3)) {
    assertLanguage(`planner 任务「${task.id}」`, language, task.title);
  }

  // 3) 每日材料提示词
  const day = draft.days[0];
  const article = buildArticleMessages(draft as never, day, 'intensive');
  assertLanguage(`dayArticle system`, language, article[0].content);

  // 4) 写作 / 口语命题提示词
  for (const kind of ['write', 'speak'] as const) {
    const format = rubricFor(exam.id, language, kind);
    const messages = buildPromptMessages(draft as never, day, format);
    assertLanguage(`practice ${kind} system`, language, messages[0].content);
    assertLanguage(`practice ${kind} user`, language, messages[1].content, MARK[language].own);
    check(
      `practice ${kind} 要求用本语种作答`,
      language === 'en'
        ? /必须是英文/.test(messages[1].content)
        : language === 'ja'
          ? /日本語/.test(messages[1].content)
          : /한국어/.test(messages[1].content),
      '题干语言要求缺失',
    );
  }

  // 5) 批改提示词：评分官身份与「引用原文用什么语言」
  const format = rubricFor(exam.id, language, 'write');
  const grade = buildGradePrompt(
    {
      language,
      format,
      prompt: {
        language,
        kind: 'write',
        formatLabel: format.label,
        taskType: format.taskType,
        title: 't',
        scenario: 's',
        question: 'q',
        hints: [],
        checklist: [],
        minutes: format.minutes,
        dimensions: format.dimensions.map((d) => ({ id: d.id, name: d.name, weight: d.weight, criteria: d.criteria })),
        scale: format.scale,
        remarks: [],
        source: 'library',
        model: null,
      },
      text: language === 'en' ? 'This is a test answer.' : '테스트 답안입니다. 테스트 답안입니다.',
      durationSeconds: null,
    },
    {
      stats: {
        unit: 'words',
        length: 10,
        sentences: 2,
        paragraphs: 1,
        avgSentence: 5,
        uniqueRatio: 0.8,
        fillerCount: 0,
        durationSeconds: null,
        wpm: null,
        targetMin: null,
      },
      sentences: [],
      paragraphs: [],
      connectives: 0,
      stance: 0,
      errors: [],
      endingRepeat: 0,
      styleMix: false,
      advancedRatio: 0,
    },
  );
  assertLanguage(`grade system`, language, grade[0].content);
  const expectQuoteLang = language === 'en' ? '英文' : language === 'ja' ? '日文' : '韩文';
  check(
    `grade 要求引用原文用${expectQuoteLang}`,
    grade[1].content.includes(`quote / fix / rewrite 用${expectQuoteLang}`),
    '要求引用语言的句子缺失或语种不对',
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`语种一致性检查失败 ${failures.length} 项：`);
  for (const item of failures) console.error(` - ${item}`);
  process.exit(1);
}
console.log('语种一致性检查全部通过：en / ja / ko 三套生成链路各自成立。');
