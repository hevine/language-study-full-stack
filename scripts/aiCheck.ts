/**
 * AI 加练自检：本地假接口，不碰真实平台、不消耗额度。
 *
 * 验证四件事：
 *   1. 生成的内容会落进本地题库，并记住「哪个模型、花了多少 token」
 *   2. 同一批次 5 分钟内再点一次，不打上游、不再花 token
 *   3. 显式要求「再生成一批」时才会真的再调一次
 *   4. 重复内容不会重复入库；不支持的任务类型会给出明确提示
 *
 *   npm run check:ai
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dataDir = path.resolve('.data/ai-check');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.LLM_API_KEY = '';
process.env.LLM_BASE_URL = '';
process.env.LLM_MODEL = '';

const BATCH = {
  note: '城市主题的高频词与理解题',
  items: [
    {
      type: 'word',
      term: 'mitigate',
      reading: '/ˈmɪtɪɡeɪt/',
      pos: 'v.',
      meaning: '减轻，缓解',
      example: 'Urban trees can mitigate the heat island effect.',
      exampleCn: '城市树木能缓解热岛效应。',
    },
    {
      type: 'word',
      term: 'albedo',
      reading: '/ælˈbiːdoʊ/',
      pos: 'n.',
      meaning: '反照率',
      example: 'Light-colored roofs raise the albedo of a city.',
      exampleCn: '浅色屋顶能提高城市反照率。',
    },
    {
      type: 'word',
      term: 'retention',
      reading: '/rɪˈtenʃn/',
      pos: 'n.',
      meaning: '滞留，保持',
      example: 'Green roofs improve rainwater retention.',
      exampleCn: '绿色屋顶能改善雨水滞留。',
    },
    {
      type: 'quiz',
      prompt: 'What is the main idea of the passage?',
      options: ['Cities are cooling down', 'Urban design can reduce heat', 'Trees are expensive', 'Albedo is irrelevant'],
      answer: 1,
      explain: '全文围绕「城市设计可以降温」展开。',
    },
    {
      type: 'quiz',
      prompt: 'The word "mitigate" in paragraph 2 is closest in meaning to',
      options: ['worsen', 'measure', 'reduce', 'predict'],
      answer: 2,
      explain: 'mitigate 在此处意为「减轻」。',
    },
    {
      type: 'sentence',
      text: 'Not until the surface temperature was mapped did planners realize how uneven the heat was.',
      translation: '直到绘制出地表温度分布，规划者才意识到热量分布有多不均衡。',
      tips: ['Not until 置于句首引起部分倒装', 'did planners realize 是倒装后的主句'],
    },
    {
      type: 'prompt',
      title: 'Describe your city in summer',
      scenario: 'You are asked to describe how your city feels in summer and what could be improved.',
      outline: ['先说体感与典型场景', '举一个具体的街区例子', '给一条改进建议'],
      phrases: ['What strikes me most is ...', 'One thing that could be improved is ...'],
      sample: 'In summer my city feels like a giant oven. Walking past the concrete plaza at noon, you can feel the heat rising from the ground. One thing that could be improved is planting more trees along the main roads.',
    },
  ],
};

const usage = { prompt_tokens: 320, completion_tokens: 180, total_tokens: 500 };
let upstreamHits = 0;

/** messy：围栏+客套话+尾逗号+中文引号；weird：字段名跑偏+裸数组；truncated：被 max_tokens 截断 */
let mode: 'clean' | 'messy' | 'weird' | 'truncated' = 'clean';

const MESSY = [
  '好的，这是您要的内容：',
  '```json',
  '{',
  '  "note": "塑料污染主题",',
  '  "items": [',
  '    {"type":"word","term":"single-use","meaning":"一次性的","example":"Single-use plastics are everywhere.","exampleCn":"一次性塑料到处都是。"},',
  '    {"type":"word","term":"landfill","meaning":"垃圾填埋场"},',
  '    {"type":"quiz","prompt":"Which is the best title for the passage?","options":["Plastic problems and solutions","Ocean fish are cute"],"answer":0,},',
  '  ],',
  '}',
  '```',
].join('\n');

const WEIRD = [
  // 没写 type、字段名全是别名、choices 是对象、answer 是字母
  { question: 'Which measure does the passage emphasize most?', choices: { A: 'Banning all plastics', B: 'Recycling and reuse', C: 'Burning waste' }, correct: 'B', explanation: '文中强调回收与重复使用。' },
  { word: 'decompose', definition: '分解', exampleSentence: 'Plastic bags take years to decompose.', exampleCn: '塑料袋要多年才能分解。' },
  { text: 'What happens after we toss a bottle into the bin?', translation: '我们把瓶子扔进垃圾桶之后会发生什么？', tips: '主语是 what 从句；after 引导时间状语' },
  { foo: '完全没法救的条目' },
];

const TRUNC_FULL = JSON.stringify({
  items: [
    { type: 'word', term: 'microplastic', meaning: '微塑料', example: 'Microplastics enter the food chain.', exampleCn: '微塑料会进入食物链。' },
    { type: 'sentence', text: 'Tiny particles, big consequences.', translation: '小颗粒，大后果。', tips: ['对比修辞'] },
  ],
  note: '微塑料主题',
});
// 模拟输出到 note 之前被 max_tokens 掐断（外层 } 还没写出来）
const TRUNC = TRUNC_FULL.slice(0, TRUNC_FULL.indexOf(',"note"'));

const server = http.createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  upstreamHits += 1;
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (mode === 'messy') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { content: MESSY } }], usage }),
      );
      return;
    }
    if (mode === 'weird') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(WEIRD) } }], usage }),
      );
      return;
    }
    if (mode === 'truncated') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { content: TRUNC }, finish_reason: 'length' }], usage }),
      );
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(BATCH) } }], usage }));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const { runMigrations, db, closeDb } = await import('../server/src/db/index.ts');
const { setRuntimeLlmConfig } = await import('../server/src/services/llm.ts');
const { generateForTask, aiBankList, aiStats } = await import('../server/src/services/aiGen.ts');

const plan = {
  id: 'plan-ai-check',
  language: 'en',
  examId: 'toefl',
  examName: 'TOEFL iBT',
  currentLevelId: 'cet6',
  currentLevelName: '六级',
  targetScore: 100,
  targetLabel: '100',
  startDate: '2026-11-01',
  examDate: '2027-01-25',
  weeks: 12,
  hoursPerWeek: 10,
  dailyMinutes: 90,
} as never;

const day = {
  id: 'day-ai-check',
  date: '2026-11-05',
  weekIndex: 0,
  dayIndex: 3,
  phase: 'base',
  phaseName: '打基础',
  theme: '城市热岛与城市规划',
  focus: ['学术词汇', '长难句'],
  tasks: [],
  status: 'pending',
} as never;

const vocabTask = { id: 't-vocab', kind: 'vocab', title: '背词', detail: '', minutes: 20, done: false } as never;
const reviewTask = { id: 't-review', kind: 'review', title: '复盘', detail: '', minutes: 10, done: false } as never;

const failures: string[] = [];
let total = 0;

/** 逐个立刻执行：有的检查依赖「此时还没配置线路」，不能攒到最后一起跑 */
async function check(name: string, run: () => Promise<string>): Promise<void> {
  total += 1;
  try {
    const note = await run();
    console.log(`✅ ${name}：${note}`);
  } catch (err) {
    failures.push(name);
    console.log(`❌ ${name}：${(err as Error).message}`);
  }
}

runMigrations();

await check('没有模型线路时给出可操作的提示', async () => {
  try {
    await generateForTask(plan, day, vocabTask);
  } catch (err) {
    const message = (err as Error).message;
    if (!/模型 Key 池/.test(message)) throw new Error(`提示不可操作：${message}`);
    return message;
  }
  throw new Error('没有线路却生成成功了');
});

setRuntimeLlmConfig({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: 'sk-test-ai-check',
  model: 'mock-model',
  providerId: 'custom',
});

await check('生成结果落库，并记住来源模型与 token', async () => {
  const result = await generateForTask(plan, day, vocabTask);
  if (result.cached) throw new Error('第一次不应该是缓存');
  if (result.items.length === 0) throw new Error('没有生成任何条目');
  if (result.model !== 'mock-model') throw new Error(`模型记错了：${result.model}`);
  if (result.usage.totalTokens !== 500) throw new Error(`token 记错了：${JSON.stringify(result.usage)}`);
  const bank = aiBankList({ language: 'en', limit: 50 });
  if (bank.length !== result.newCount) throw new Error(`题库条数 ${bank.length} 与新增 ${result.newCount} 不一致`);
  if (bank.some((item) => item.model !== 'mock-model')) throw new Error('题库里缺来源模型');
  return `${result.items.length} 条 · ${result.model} · ${result.usage.totalTokens} tokens · 入库 ${result.newCount}`;
});

await check('AI 出的单词进了词汇本，来源标注到模型', async () => {
  const rows = db
    .prepare("SELECT term, source FROM vocab_items WHERE user_id = 'local' AND language = 'en'")
    .all() as Array<{ term: string; source: string }>;
  if (rows.length === 0) throw new Error('单词没有写进词汇本');
  const bad = rows.find((row) => !row.source?.includes('AI · mock-model'));
  if (bad) throw new Error(`来源没标注：${bad.term} → ${bad.source}`);
  return `${rows.length} 个词 · source=${rows[0].source}`;
});

await check('5 分钟内再点一次：不打上游、不再花 token', async () => {
  const before = upstreamHits;
  const result = await generateForTask(plan, day, vocabTask);
  if (!result.cached) throw new Error('第二次应当命中缓存');
  if (upstreamHits !== before) throw new Error(`又调了上游 ${upstreamHits - before} 次`);
  if (result.usage.totalTokens !== 0) throw new Error('缓存命中却计了 token');
  if (result.savedTokens !== 500) throw new Error(`省下的 token 不对：${result.savedTokens}`);
  return `命中缓存 · 省下 ${result.savedTokens} tokens · 上游请求 ${upstreamHits} 次`;
});

await check('要求「再生成一批」时才真的再调一次，重复内容不重复入库', async () => {
  const beforeBank = aiBankList({ language: 'en', limit: 200 }).length;
  const beforeHits = upstreamHits;
  const result = await generateForTask(plan, day, vocabTask, { fresh: true });
  if (result.cached) throw new Error('fresh 仍然命中缓存');
  if (upstreamHits !== beforeHits + 1) throw new Error('fresh 没有真的调用上游');
  if (result.duplicateCount !== result.itemCount) throw new Error(`重复条目统计不对：${result.duplicateCount}/${result.itemCount}`);
  const afterBank = aiBankList({ language: 'en', limit: 200 }).length;
  if (afterBank !== beforeBank) throw new Error(`重复内容又入库了：${beforeBank} → ${afterBank}`);
  return `上游 +1 次 · 重复 ${result.duplicateCount} 条全部跳过 · 题库仍 ${afterBank} 条`;
});

await check('复习 / 事务类任务不会去调模型', async () => {
  const before = upstreamHits;
  try {
    await generateForTask(plan, day, reviewTask);
  } catch (err) {
    if (upstreamHits !== before) throw new Error('竟然调了上游');
    return (err as Error).message;
  }
  throw new Error('复习任务竟然生成成功');
});

await check('用量统计能按模型汇总', async () => {
  const stats = aiStats();
  if (stats.total.tokens !== 1000) throw new Error(`累计 token 不对：${stats.total.tokens}`);
  const top = stats.byModel[0];
  if (!top || top.model !== 'mock-model') throw new Error('模型汇总缺失');
  return `累计 ${stats.total.tokens} tokens · ${stats.total.runs} 次 · ${top.model} 占 ${top.tokens}`;
});

const dayMessy = { ...(day as object), id: 'day-messy', theme: '一次性塑料与白色污染' } as never;
const dayWeird = { ...(day as object), id: 'day-weird', theme: '垃圾分类与回收利用' } as never;
const dayTrunc = { ...(day as object), id: 'day-trunc', theme: '微塑料与食物链' } as never;
const grammarTask = { id: 't-grammar', kind: 'grammar', title: '拆句', detail: '', minutes: 15, done: false } as never;

await check('围栏+客套话+尾逗号的返回能本地修复，不再多花一次调用', async () => {
  mode = 'messy';
  const before = upstreamHits;
  const result = await generateForTask(plan, dayMessy, vocabTask);
  if (upstreamHits !== before + 1) throw new Error(`上游被调了 ${upstreamHits - before} 次（应为 1 次，修复不该惊动模型）`);
  if (!result.repaired) throw new Error('没标记「已自动修复」');
  if (result.items.length < 3) throw new Error(`只救回 ${result.items.length} 条`);
  const terms = result.items.filter((item) => item.type === 'word').map((item) => (item as { term: string }).term);
  if (!terms.includes('single-use') || !terms.includes('landfill')) throw new Error(`词没救全：${terms.join(',')}`);
  return `救回 ${result.items.length} 条 · 上游仅 1 次 · 0 额外 token`;
});

await check('字段名跑偏 / 裸数组 / 字母答案也能按形状抢救入库', async () => {
  mode = 'weird';
  const before = upstreamHits;
  const result = await generateForTask(plan, dayWeird, grammarTask);
  if (upstreamHits !== before + 1) throw new Error(`上游被调了 ${upstreamHits - before} 次`);
  const quiz = result.items.find((item) => item.type === 'quiz') as { answer: number; options: string[] } | undefined;
  if (!quiz) throw new Error('quiz 没抢救出来');
  if (quiz.answer !== 1) throw new Error(`字母答案 B 应转成下标 1，实际 ${quiz.answer}`);
  const word = result.items.find((item) => item.type === 'word') as { term: string; meaning: string } | undefined;
  if (!word || word.term !== 'decompose' || word.meaning !== '分解') throw new Error('word 别名字段没归位');
  const sentence = result.items.find((item) => item.type === 'sentence') as { tips: string[] } | undefined;
  if (!sentence || !Array.isArray(sentence.tips) || sentence.tips.length !== 2) throw new Error(`一句话 tips 没按分隔符拆开：${JSON.stringify(sentence?.tips)}`);
  if (result.dropped < 1) throw new Error('无法救回的条目应计入 dropped');
  return `救回 3 条（quiz/word/sentence）· 丢弃 1 条 · answer "B"→1`;
});

await check('被 max_tokens 截断的 JSON 能补全而不是整批作废', async () => {
  mode = 'truncated';
  const before = upstreamHits;
  const result = await generateForTask(plan, dayTrunc, vocabTask);
  if (upstreamHits !== before + 1) throw new Error(`上游被调了 ${upstreamHits - before} 次`);
  if (result.items.length < 2) throw new Error(`截断批只救回 ${result.items.length} 条`);
  if (!result.repaired) throw new Error('截断修复没被标记');
  const terms = result.items.filter((item) => item.type === 'word').map((item) => (item as { term: string }).term);
  if (!terms.includes('microplastic')) throw new Error('截断前的完整条目丢了');
  return `救回 ${result.items.length} 条 · 外层括号自动补全`;
});

console.log('');

closeDb();
server.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`AI 加练自检失败 ${failures.length}/${total} 项：${failures.join('、')}`);
  process.exit(1);
}
console.log(`AI 加练自检通过 ${total}/${total} 项`);
