/**
 * 解题答疑脚本解析自检（不联网、不调模型）。
 *
 *   npx tsx scripts/checkExplainParse.ts
 *
 * 覆盖真实遇到过的脏输出：围栏、前置分析、全角标点、注释、尾逗号、中文键名、
 * 中文 kind、单引号、裸数组、以及最关键的「被 max_tokens 截断」。
 * 每个用例都断言：能救回多少镜、题库补镜后答案是否仍然权威。
 */
import { assembleShots, ensureCoverage, type ExplainInput } from '../server/src/services/explainShots';
import { coerceScriptValue, parseScriptText } from '../server/src/services/explainScriptSalvage';

const input: ExplainInput = {
  articleId: 'test',
  language: 'en',
  title: 'Why do leaves change color?',
  body: [
    'Autumn brings shorter days and cooler nights.',
    'Trees stop making chlorophyll, so other pigments become visible.',
    'This is why maples turn red and birches turn yellow.',
  ].join('\n\n'),
  translation: '秋天白昼变短、夜晚变凉。树叶停止制造叶绿素，其他色素就显现出来。',
  questions: [
    { prompt: 'What happens to chlorophyll in autumn?', options: ['It increases', 'It breaks down', 'It freezes', 'It turns blue'], answer: 1, explain: '树叶停止制造叶绿素，它分解后其他色素显现。' },
    { prompt: 'Why do maples look red?', options: ['Chlorophyll reflects red', 'Red pigments become visible', 'Frost paints them', 'They absorb red light'], answer: 1 },
  ],
};

const GOOD_SHOTS = [
  { kind: 'cover', narration: 'Why do leaves change color in autumn?', caption: '秋天树叶为什么会变色？' },
  { kind: 'question', questionNo: 0, narration: 'What happens to chlorophyll in autumn?', caption: '第 1 题', prompt: input.questions[0].prompt, options: input.questions[0].options },
  { kind: 'passage', questionNo: 0, narration: 'Trees stop making chlorophyll.', caption: '树叶停止制造叶绿素', evidence: 'Trees stop making chlorophyll, so other pigments become visible.', paragraph: 1 },
  { kind: 'eliminate', questionNo: 0, narration: 'It does not increase or freeze.', caption: '排除 A、C', evidence: 'Trees stop making chlorophyll, so other pigments become visible.', paragraph: 1 },
  { kind: 'answer', questionNo: 0, narration: 'The correct answer is it breaks down.', caption: '正确答案 B', picked: 1 },
  { kind: 'point', questionNo: 0, narration: 'Watch the verb phrase stop making.', caption: '考点：stop doing', pointLabel: '固定搭配', pointText: 'stop doing sth 停止做某事' },
  { kind: 'question', questionNo: 1, narration: 'Why do maples look red?', caption: '第 2 题', prompt: input.questions[1].prompt, options: input.questions[1].options },
  { kind: 'passage', questionNo: 1, narration: 'Other pigments become visible.', caption: '其他色素显现', evidence: 'This is why maples turn red and birches turn yellow.', paragraph: 2 },
  { kind: 'answer', questionNo: 1, narration: 'The correct answer is red pigments become visible.', caption: '正确答案 B', picked: 1 },
  { kind: 'takeaway', narration: 'Review the highlighted sentences and try again.', caption: '总结：抓住 stop doing 与色素变化' },
];

const full = JSON.stringify({ shots: GOOD_SHOTS }, null, 2);

interface Case {
  name: string;
  raw: string;
  /** 期望至少救回的分镜数；截断用例单独断言 */
  minShots: number;
  /** 期望 truncated 标记 */
  truncated?: boolean;
}

const cases: Case[] = [
  { name: '干净 JSON', raw: full, minShots: 10 },
  { name: 'markdown 围栏', raw: '```json\n' + full + '\n```', minShots: 10 },
  {
    name: '前置分析 + 围栏',
    raw: `好的，我先分析一下这篇文章。\n\n1. 文章讲叶子变色；\n2. 有两道题。\n\n\`\`\`json\n${full}\n\`\`\`\n希望有帮助！`,
    minShots: 10,
  },
  {
    name: '尾逗号 + 中文标点 + 注释',
    raw: `{
  // 开场
  "shots": [
    {"kind":"cover"，"narration":"Why do leaves change color in autumn?"，"caption":"秋天树叶为什么会变色？"}，
    {"kind":"takeaway"，"narration":"Review the highlighted sentences."，"caption":"总结" },
  ],
}`,
    minShots: 2,
  },
  {
    name: '中文键名 + 中文 kind',
    raw: JSON.stringify({
      分镜: [
        { 类型: '开场', 旁白: 'Why do leaves change color?', 字幕: '秋天树叶为什么变色？' },
        { 类型: '考点', 旁白: 'Pay attention to stop doing.', 字幕: '注意 stop doing' },
      ],
    }),
    minShots: 2,
  },
  {
    name: '缺 kind，靠字段推断',
    raw: JSON.stringify({
      shots: [
        { narration: 'Look at this sentence about chlorophyll.', caption: '看这句话', evidence: 'Trees stop making chlorophyll, so other pigments become visible.', paragraph: 1 },
        { narration: 'The correct answer is B.', caption: '答案 B', picked: 1 },
      ],
    }),
    minShots: 2,
  },
  {
    name: '单引号 + 裸数组',
    raw: `[{'kind':'cover','narration':'Why do leaves change color?','caption':'秋天变色'},{'kind':'takeaway','narration':'Try again next time.','caption':'下次再试'}]`,
    minShots: 2,
  },
  {
    name: '中文引号当定界符',
    raw: `{"shots":[{"kind":"cover","narration":"Why do leaves change color?","caption":"秋天变色"},{"kind":"takeaway","narration":"Try again.","caption":"结束"}]}`.replace(/"/g, '“'),
    minShots: 2,
  },
  {
    name: '截断（第 6 镜中间断掉）',
    raw: full.slice(0, Math.floor(full.length * 0.62)),
    minShots: 3,
    truncated: true,
  },
  {
    name: '截断（字符串中间断掉）',
    raw: full.slice(0, full.indexOf('Watch the verb phrase') + 8),
    minShots: 3,
    truncated: true,
  },
  { name: '纯垃圾文本', raw: '抱歉，我无法完成这个请求。', minShots: 0 },
];

let failed = 0;
const fail = (label: string, detail: string) => {
  failed += 1;
  console.error(`  ✗ ${label}：${detail}`);
};

for (const testCase of cases) {
  const parsed = parseScriptText(testCase.raw, input.questions.length);
  const covered = ensureCoverage(assembleShots(parsed.drafts, input), input);
  const answers = covered.shots.filter((shot) => shot.kind === 'answer');
  const answerOk =
    input.questions.length === 0
      ? answers.length === 0
      : input.questions.every((q, no) => {
          const hit = answers.find((shot) => shot.questionNo === no);
          return Boolean(hit && hit.highlight?.picked === q.answer);
        });

  const line = `  ${parsed.drafts.length.toString().padStart(2)} 镜 · ${parsed.stage.padEnd(22)} · 补 ${covered.autoFilled} · 总 ${covered.shots.length}`;
  const ok =
    parsed.drafts.length >= testCase.minShots &&
    answerOk &&
    (testCase.truncated === undefined || parsed.truncated === testCase.truncated);
  console.log(`${ok ? '✓' : '✗'} ${testCase.name.padEnd(22)}${line}`);
  if (parsed.drafts.length < testCase.minShots) fail(testCase.name, `只救回 ${parsed.drafts.length} 镜，期望 ≥ ${testCase.minShots}`);
  if (!answerOk) fail(testCase.name, '补镜后答案与题库不一致');
  if (testCase.truncated !== undefined && parsed.truncated !== testCase.truncated) {
    fail(testCase.name, `truncated 标记为 ${parsed.truncated}，期望 ${testCase.truncated}`);
  }
}

// 额外：coerceScriptValue 必须容忍 {shots:{shots:[]}} 这种双层嵌套
const nested = coerceScriptValue({ data: { shots: GOOD_SHOTS.slice(0, 3) } }, input.questions.length);
console.log(`${nested.length === 3 ? '✓' : '✗'} 嵌套 data.shots        ${nested.length} 镜`);
if (nested.length !== 3) failed += 1;

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
