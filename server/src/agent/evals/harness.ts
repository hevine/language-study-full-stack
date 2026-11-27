/**
 * 离线评测 harness。
 *
 * 为什么这个文件必须先于功能存在：没有它，改一次 prompt 就没人知道是变好还是变坏。
 * 教育产品的错误是「静默」的 —— 用户看不出来，成绩不涨，最后流失。
 *
 * 它用假 LLM 跑真实内核（router / planner / executor / verifier 全是真的），
 * 所以能验证「编排对不对」，不验证「模型好不好」。后者要靠人工抽检与线上指标。
 *
 * 运行：npm run check:agent
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { enLevel, enPhonology, enTaxonomy, enTokenizer, createEnSyntax } from '../adapters/en';
import { createJaSyntax, jaLevel, jaPhonology, jaTaxonomy, jaTokenizer } from '../adapters/ja';
import { createKoSyntax, koLevel, koPhonology, koTaxonomy, koTokenizer } from '../adapters/ko';
import { runAgent, type AgentEvent, type AgentRuntime } from '../core';
import { loadLanguagePacks } from '../lang/loader';
import type { AgentDeps, LearnerStorePort, LlmPort, TracePort } from '../ports';
import type { AnnotatedDiff, AgentRun } from '../protocols';
import { loadScenePacks } from '../scenes/loader';
import { BUILTIN_TOOLS } from '../tools/builtin';
import { ToolRegistry } from '../tools/registry';
import type { LearnerProfile, LangCode } from '../types';

const CANNED_DIFF_EN: AnnotatedDiff = {
  items: [
    {
      before: 'people is',
      after: 'people are',
      ruleId: 'sva',
      reason: '主语 people 是复数，be 动词应为 are；这是近 30 天第 3 次同类错误',
      severity: 'must-fix',
      accept: null,
    },
    {
      before: 'In my opinion, I think',
      after: 'I would argue',
      ruleId: 'redundancy',
      reason: '两个观点引导语重复，删一个更利落',
      severity: 'style',
      accept: null,
    },
  ],
  score: {
    dimensions: [
      { id: 'content', name: '内容', score: 70, weight: 0.35 },
      { id: 'organization', name: '组织', score: 68, weight: 0.2 },
      { id: 'language', name: '语言', score: 62, weight: 0.25 },
      { id: 'lexical', name: '词汇', score: 66, weight: 0.2 },
    ],
  },
  rewrite: undefined,
};

/**
 * 韩语版批改样例（只补韩语，日语缺 —— 见下面 CANNED_DIFFS 的注释）：
 *
 * ruleId 必须落在 `lang/ko/errors.json` 里，否则 G5「有据可依」直接判不合规。
 * 这正是韩语写作一直没能进离线评测的原因：原来唯一的样例是英文的，
 * `sva` 不在韩语错因表里。
 *
 * 两条都刻意选**规则引擎抓不到的**（汉字词搭配、翻译腔），
 * 因为批改的价值就在「模型补规则之外的判断」，评测也该测这一层。
 */
const CANNED_DIFF_KO: AnnotatedDiff = {
  items: [
    {
      before: '이 현상의 이유를 두 가지로 봅니다',
      after: '이 현상의 원인을 두 가지로 봅니다',
      ruleId: 'sino-korean',
      reason: '현상（现象）配 이유（理由）不如 원인（原因）贴切：현상은 관찰되는 것，원인是它背后的东西',
      severity: 'should-fix',
      accept: null,
    },
    {
      before: '가족과 같이 살기가 어렵습니다',
      after: '가족과 함께 살기 어렵습니다',
      ruleId: 'translationese',
      reason: '같이 是「一起」的口语说法，书面说明文里用 함께 更自然；살기가 的 기 也偏口语化',
      severity: 'style',
      accept: null,
    },
  ],
  score: {
    // 加权 ≈ 66，与规则侧（4 处命中 → 92-28=64）差 2 分，G3 双通道一致
    dimensions: [
      { id: 'content', name: '内容与课题执行', score: 68, weight: 0.35 },
      { id: 'organization', name: '结构与连贯', score: 72, weight: 0.25 },
      { id: 'language', name: '语法与语尾', score: 58, weight: 0.25 },
      { id: 'lexical', name: '词汇与表达', score: 66, weight: 0.15 },
    ],
  },
  rewrite: undefined,
};

/**
 * 语种 → 批改样例。
 *
 * 用 Partial 而不是 Record：**缺样例时要报错，不能静默退回英文**。
 * 静默退回的后果是「评测通过、G5 通过」——因为英文样例里的 ruleId 恰好也在英文表里，
 * 于是没人发现这门语言的写作链路其实一次都没真跑过。
 * 日语（`ja`）故意留空：JLPT 不考写作，场景层直接拒绝，加了也是死代码。
 */
const CANNED_DIFFS: Partial<Record<LangCode, AnnotatedDiff>> = {
  en: CANNED_DIFF_EN,
  ko: CANNED_DIFF_KO,
};

const CANNED_TREE = {
  nodes: [
    {
      id: 'n1',
      role: 'subject' as const,
      text: 'The assumption',
      note: '主语',
      children: [],
    },
    {
      id: 'n2',
      role: 'clause' as const,
      text: 'that economic growth can be decoupled from resource consumption',
      note: '同位语从句，说明 assumption 的内容',
      children: [{ id: 'n2-1', role: 'modifier' as const, text: 'which underpins much of current policy', note: '非限制性定语从句，补充说明', children: [] }],
    },
    { id: 'n3', role: 'predicate' as const, text: 'has been challenged', note: '谓语', children: [] },
  ],
  summary: '主干是 The assumption has been challenged，中间插了两个从句',
  difficulty: 6,
};

/**
 * 假 LLM：按 `req.tag` 返回固定结果。
 *
 * 为什么需要 `lang` 参数：`write.diff_review` 这个 tag 是**工具层**发的，不带语种后缀
 * （`gra.contrast.ja` / `.ko` 之所以带，是因为 tag 由语言适配器自己发出）。
 * 与其为了测试给生产代码的 tag 加后缀 —— 那会连带改前端 `labels.ts` 的精确匹配与成本归因口径 ——
 * 不如让 harness 按用例语种造一个「会说这门语言的假模型」。
 */
function makeFakeLlm(lang: LangCode): LlmPort {
  return {
    async json(req) {
      if (req.tag === 'write.diff_review') {
        const canned = CANNED_DIFFS[lang];
        if (!canned) {
          throw new Error(`eval harness 还没有 ${lang} 的批改样例：补写作用例前先加 CANNED_DIFF_${lang.toUpperCase()}`);
        }
        return { data: canned as never, tokens: 1500 };
      }
      if (req.tag === 'gra.parse') return { data: CANNED_TREE as never, tokens: 400 };
      if (req.tag === 'gra.contrast') {
        return { data: { points: [{ point: '中文没有冠词', note: '英语单数可数名词前必须有冠词' }] } as never, tokens: 120 };
      }
      if (req.tag === 'gra.contrast.ja') {
        return { data: { points: [{ point: '助词不靠语序', note: '中文靠位置定成分，日语靠助词' }] } as never, tokens: 100 };
      }
      if (req.tag === 'gra.contrast.ko') {
        return { data: { points: [{ point: '은/는 与 이/가', note: '中文没有主题标记，韩语靠助词分已知与新信息' }] } as never, tokens: 100 };
      }
      throw new Error(`eval harness 未覆盖的模型调用：${req.tag}`);
    },
    async text() {
      return { text: '', tokens: 0 };
    },
  };
}

function memoryStore(): LearnerStorePort {
  const errors = new Map<string, { count: number }>();
  return {
    async read({ userId, lang, topN = 5 }): Promise<LearnerProfile> {
      return {
        userId,
        lang,
        level: { scale: 'cefr', band: 'B2' },
        daysLeft: 42,
        topErrors: [...errors.entries()].slice(0, topN).map(([ruleId, value]) => ({
          ruleId,
          status: 'candidate',
          count: value.count,
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          evidence: [],
        })),
        style: [],
        rules: [],
      };
    },
    async applyPatch(patch, opts) {
      if (!opts.confirm) {
        return {
          applied: false,
          added: [],
          promoted: [],
          pending: patch.ops.map((op) => ({ op: op.op, detail: 'eval 待确认' })),
        };
      }
      const added: string[] = [];
      for (const op of patch.ops) {
        if (op.op !== 'inc') continue;
        const current = errors.get(op.ruleId) ?? { count: 0 };
        current.count += 1;
        errors.set(op.ruleId, current);
        added.push(op.ruleId);
      }
      return { applied: true, added, promoted: [] };
    },
    async findError() {
      return null;
    },
  };
}

function memoryTrace(): TracePort {
  const runs = new Map<string, AgentRun>();
  return {
    async save(run) {
      runs.set(run.runId, run);
    },
    async load(runId) {
      return runs.get(runId) ?? null;
    },
    async list() {
      return [...runs.values()].map((run) => ({ runId: run.runId, scene: run.scene, startedAt: run.startedAt, ok: run.ok }));
    },
  };
}

const EvalCaseSchema = z.object({
  id: z.string(),
  note: z.string().default(''),
  input: z.object({
    lang: z.enum(['en', 'ja', 'ko']).default('en'),
    mode: z.enum(['ask', 'craft', 'coach']).default('craft'),
    query: z.string().optional(),
    text: z.string().optional(),
    exam: z.string().optional(),
    articleId: z.string().optional(),
    helpLevel: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
  }),
  expect: z.object({
    scene: z.string().optional(),
    tools: z.array(z.string()).optional(),
    artifacts: z.array(z.string()).optional(),
    maxItems: z.number().optional(),
    verifyPass: z.array(z.string()).optional(),
    minConfidence: z.number().optional(),
    error: z.string().optional(),
    clarify: z.boolean().optional(),
  }),
});
type EvalCase = z.infer<typeof EvalCaseSchema>;

function buildRuntime(lang: LangCode = 'en'): AgentRuntime {
  const fakeLlm = makeFakeLlm(lang);
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  const enPorts = {
    tokenizer: enTokenizer,
    syntax: createEnSyntax(fakeLlm),
    taxonomy: enTaxonomy,
    phonology: enPhonology,
    level: enLevel,
  };

  const jaPorts = {
    tokenizer: jaTokenizer,
    syntax: createJaSyntax(fakeLlm),
    taxonomy: jaTaxonomy,
    phonology: jaPhonology,
    level: jaLevel,
  };

  const koPorts = {
    tokenizer: koTokenizer,
    syntax: createKoSyntax(fakeLlm),
    taxonomy: koTaxonomy,
    phonology: koPhonology,
    level: koLevel,
  };

  const deps: AgentDeps = {
    llm: fakeLlm,
    store: memoryStore(),
    trace: memoryTrace(),
    tasks: {
      async attachArtifact() {
        return { attached: false, reason: 'eval 不落任务' };
      },
    },
    media: {
      async tts() {
        return { audioRef: 'eval://none', ms: 0, cached: true };
      },
      explainVideo: {
        // 假的作业池：起完立刻「完成」，让评测能验到产物的最终形态
        async start(input) {
          return { jobId: `job_eval_${input.articleId}`, videoId: `vid_eval_${input.articleId}`, reused: true, ms: 0 };
        },
        async poll(input) {
          return {
            state: 'done' as const,
            progress: 100,
            detail: 'eval',
            videoId: input.jobId.replace(/^job_eval_/, 'vid_eval_'),
            videoRef: `eval://${input.jobId}`,
          };
        },
      },
    },
    language: (code) => (code === 'en' ? enPorts : code === 'ja' ? jaPorts : code === 'ko' ? koPorts : null),
    now: () => new Date(),
  };

  return { deps, registry, scenes: loadScenePacks(), langs: loadLanguagePacks() };
}

function loadCases(): Array<{ file: string; item: EvalCase }> {
  const out: Array<{ file: string; item: EvalCase }> = [];
  for (const scene of loadScenePacks()) {
    if (!scene.evalDir) continue;
    for (const name of fs.readdirSync(scene.evalDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(scene.evalDir, name);
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const parsed = EvalCaseSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          out.push({ file: `${file}#parse`, item: { id: 'INVALID', note: parsed.error.issues[0]?.message ?? '', input: { lang: 'en', mode: 'craft' }, expect: {} } });
          continue;
        }
        out.push({ file, item: parsed.data });
      }
    }
  }
  return out;
}

async function runCase(item: EvalCase, runtime: AgentRuntime): Promise<string[]> {
  const failures: string[] = [];
  const events: AgentEvent[] = [];
  let run: AgentRun | null = null;

  for await (const event of runAgent({ ...item.input, userId: 'eval' }, runtime)) {
    events.push(event);
    if (event.type === 'done') run = event.run;
  }

  const errorEvent = events.find((event) => event.type === 'error');
  const clarifyEvent = events.find((event) => event.type === 'clarify');

  if (item.expect.error) {
    if (!errorEvent || errorEvent.type !== 'error' || !errorEvent.message.includes(item.expect.error)) {
      failures.push(`期望明确报错（含「${item.expect.error}」），实际 ${errorEvent ? '报错内容不符' : '没报错'}`);
    }
    return failures;
  }

  if (item.expect.clarify) {
    if (!clarifyEvent) failures.push('期望反问，实际直接执行了');
    return failures;
  }

  if (!run) {
    failures.push(`没有产出 run（${errorEvent?.type === 'error' ? errorEvent.message : '未知原因'}）`);
    return failures;
  }

  const finalRun: AgentRun = run;
  if (item.expect.scene && !finalRun.scene.startsWith(item.expect.scene)) {
    failures.push(`场景不符：期望 ${item.expect.scene}，实际 ${finalRun.scene}`);
  }

  if (item.expect.tools) {
    const actual = finalRun.steps.map((step) => step.tool);
    const mismatch = item.expect.tools.filter((tool, index) => actual[index] !== tool);
    if (mismatch.length) failures.push(`工具序列不符：期望 ${item.expect.tools.join(' → ')}，实际 ${actual.join(' → ')}`);
    if (finalRun.steps.some((step) => step.status === 'failed')) {
      failures.push(`有步骤失败：${finalRun.steps.filter((step) => step.status === 'failed').map((step) => `${step.tool}(${step.error})`).join('; ')}`);
    }
  }

  if (item.expect.artifacts) {
    // 用产物自身的 type，不再从 artifactId 里反解字符串 —— 后者依赖 id 命名约定，改名就静默失效
    const actual = finalRun.artifacts.map((art) => art.type as string);
    for (const type of item.expect.artifacts) {
      if (!actual.includes(type)) failures.push(`缺少产物：${type}（实际 ${actual.join('、') || '无'}）`);
    }
  }

  if (item.expect.maxItems !== undefined) {
    const diff = events.find((event) => event.type === 'artifact' && event.artifact.type === 'annotated-diff');
    const count = diff && diff.type === 'artifact' ? ((diff.artifact.data as AnnotatedDiff).items ?? []).length : 0;
    if (count > item.expect.maxItems) failures.push(`批改条目超限：${count} > ${item.expect.maxItems}`);
    if (count === 0) failures.push('批改条目为空');
  }

  if (item.expect.verifyPass) {
    for (const gate of item.expect.verifyPass) {
      const result = finalRun.verify?.gates.find((item2) => item2.id === gate);
      if (!result) failures.push(`缺少校验关卡 ${gate}`);
      else if (result.verdict !== 'pass') failures.push(`${gate} 未通过：${result.detail}`);
    }
  }

  if (item.expect.minConfidence !== undefined) {
    const confidence = finalRun.verify?.confidence ?? 0;
    if (confidence < item.expect.minConfidence) failures.push(`置信度偏低：${confidence} < ${item.expect.minConfidence}`);
  }

  return failures;
}

async function main(): Promise<void> {
  const cases = loadCases();
  let passed = 0;
  const details: string[] = [];

  for (const { item } of cases) {
    // 每条用例按自己的语种造运行时：假模型要「会说这门语言」，否则韩语用例会拿到英文批改样例
    const runtime = buildRuntime(item.input.lang);
    const failures = await runCase(item, runtime);
    if (failures.length === 0) {
      passed += 1;
      details.push(`  ✓ ${item.id}  ${item.note}`);
    } else {
      details.push(`  ✗ ${item.id}  ${item.note}`);
      for (const failure of failures) details.push(`      - ${failure}`);
    }
  }

  process.stdout.write(`\nLingua Agent 离线评测：${passed}/${cases.length} 通过\n\n${details.join('\n')}\n\n`);
  if (passed !== cases.length) process.exitCode = 1;
}

void main();
