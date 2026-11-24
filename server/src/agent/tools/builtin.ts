/**
 * M0 内置工具（7 个）。
 *
 * 取舍说明：
 * - 「词/句」级别的确定性能力全部走 Language Port（gra.parse / gra.contrast / gra.rules），
 *   这样日语接进来时这些工具一行不用改；
 * - 只有「需要判断与行文」的活才直接调 LLM（write.diff_review）；
 * - profile.patch 永远 confirm=false 起步 —— 档案写错会污染后续所有推理。
 */
import { z } from 'zod';
import { rubricFor, toBand } from '../../domain/rubrics';
import { AnnotatedDiffSchema, LearnerPatchSchema, type AnnotatedDiff, type LearnerPatch } from '../protocols';
import { PortNotWiredError } from '../ports';
import type { HelpLevel, LearnerProfile } from '../types';
import { artifact, defineTool, type ToolContext } from './registry';

/** 帮助档位直接改写 system prompt：这是最小帮助原则唯一的执行点 */
const HELP_HINT: Record<HelpLevel, string> = {
  L0: '只提问、给线索，不要直接给出答案或改法。',
  L1: '只指出问题所在的位置与类型，不要给出改后写法。',
  L2: '可以给出这一句的改后写法与原因，但要求学生复述一遍原因。',
  L3: '可以给出完整改写，但必须明确要求学生自己重写一遍才算完成。',
};

interface RuleError {
  ruleId: string;
  quote: string;
  problem: string;
  suggestion: string;
  severity: 'must-fix' | 'should-fix' | 'style';
}

interface RubricDigest {
  exam: string;
  label: string;
  dimensions: Array<{ id: string; name: string; weight: number; criteria: string }>;
  scale: { max: number; step: number; label: string; note: string };
}

function systemPrompt(ctx: ToolContext, extra: string): string {
  return [
    '你是「Lingua」外语学习 Agent 的内核工具，正在为一门语言学习产品工作。',
    `当前语种：${ctx.lang}；帮助档位：${ctx.helpLevel} —— ${HELP_HINT[ctx.helpLevel]}`,
    ctx.sceneRules ? `【场景守则】\n${ctx.sceneRules}` : '',
    extra,
    '只输出 JSON，不要解释文字，不要 markdown 代码块。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// profile.read —— 上下文组装的入口
// ---------------------------------------------------------------------------
export const profileReadTool = defineTool({
  name: 'profile.read',
  cost: { tokens: 0, ms: 20 },
  idempotent: true,
  args: z.object({ topN: z.number().int().min(1).max(20).default(5) }),
  async run(args, ctx) {
    const profile = await ctx.deps.store.read({ userId: ctx.userId, lang: ctx.lang, topN: args.topN });
    ctx.log('读取学习者档案', { errors: profile.topErrors.length });
    return {
      data: profile,
      provenance: [
        { field: 'topErrors', source: 'file', ref: '~/.lingua/errors.jsonl' },
        { field: 'level', source: 'user' },
      ],
      summary: `${profile.level.scale} ${profile.level.band} · 错因 ${profile.topErrors.length} 条`,
    };
  },
});

// ---------------------------------------------------------------------------
// exam.rubric —— 直接复用主项目 domain/rubrics，不重抄一份评分维度
// ---------------------------------------------------------------------------
export const examRubricTool = defineTool({
  name: 'exam.rubric',
  cost: { tokens: 0, ms: 5 },
  idempotent: true,
  args: z.object({
    exam: z.string().default('ielts'),
    kind: z.enum(['write', 'speak']).default('write'),
  }),
  async run(args, ctx) {
    const format = rubricFor(args.exam, ctx.lang, args.kind);
    const data: RubricDigest = {
      exam: args.exam,
      label: format.label,
      dimensions: format.dimensions.map((dimension) => ({
        id: dimension.id,
        name: dimension.name,
        weight: dimension.weight,
        criteria: dimension.criteria,
      })),
      scale: format.scale,
    };
    return {
      data,
      provenance: [{ field: 'dimensions', source: 'exam-bank', ref: args.exam }],
      summary: `${format.label} · ${format.dimensions.length} 个维度 / ${format.scale.label}`,
    };
  },
});

// ---------------------------------------------------------------------------
// gra.rules —— 确定性规则扫描（M0 走 Language Pack 的轻量扫描器；M1 换 14 类引擎，接口不变）
// ---------------------------------------------------------------------------
export const grammarRulesTool = defineTool({
  name: 'gra.rules',
  cost: { tokens: 0, ms: 60 },
  idempotent: true,
  args: z.object({ text: z.string().min(1) }),
  async run(args, ctx) {
    const ports = ctx.deps.language(ctx.lang);
    if (!ports) throw new PortNotWiredError(`language:${ctx.lang}`, '该语种没有 Language Pack');
    const errors = await ports.taxonomy.scan(args.text);
    ctx.log('规则引擎扫描完成', { hits: errors.length });
    return {
      data: { errors, count: errors.length },
      provenance: [{ field: 'errors[].ruleId', source: 'rule-engine' }],
      summary: `${errors.length} 处规则命中`,
    };
  },
});

// ---------------------------------------------------------------------------
// write.diff_review —— M0 的主工具
// ---------------------------------------------------------------------------
export const diffReviewTool = defineTool({
  name: 'write.diff_review',
  langs: ['en', 'ja', 'ko'],
  cost: { tokens: 3000, ms: 6000 },
  idempotent: false,
  args: z.object({
    text: z.string().min(20, '文本太短：写作批改至少要 20 个字符'),
    exam: z.string().default('ielts'),
    maxItems: z.number().int().min(1).max(12).default(8),
  }),
  async run(args, ctx) {
    const profile = ctx.bag['profile.read'] as LearnerProfile | undefined;
    const rubric = ctx.bag['exam.rubric'] as RubricDigest | undefined;
    const ruleData = ctx.bag['gra.rules'] as { errors: RuleError[] } | undefined;
    const ruleErrors = ruleData?.errors ?? [];

    const dimsText = (rubric?.dimensions ?? [])
      .map((item, index) => `${index + 1}. id="${item.id}"｜${item.name}｜权重 ${Math.round(item.weight * 100)}%｜${item.criteria}`)
      .join('\n');

    const errorHistory = (profile?.topErrors ?? [])
      .slice(0, 5)
      .map((item) => `${item.ruleId}（累计 ${item.count} 次，${item.status}）`)
      .join('、');

    const ruleHints = ruleErrors
      .slice(0, 8)
      .map((item) => `- [${item.ruleId}] ${item.severity}：「${item.quote}」${item.problem}`)
      .join('\n');

    const system = systemPrompt(
      ctx,
      [
        '你的任务：按给定维度与权重批改这篇作文，输出 annotated-diff 结构。',
        ctx.ruleIds.length
          ? `【ruleId 只能从这里选，不许自造】${ctx.ruleIds.join(' / ')}`
          : '',
        dimsText ? `【评分维度】\n${dimsText}` : '',
        errorHistory ? `【该学生近期高频错因】${errorHistory} —— 若本次再次出现，reason 里点明这是重复错误。` : '',
        rubric ? `【分制】满分 ${rubric.scale.max}，最小刻度 ${rubric.scale.step}（${rubric.scale.label}）` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );

    const user = [
      `【作文】\n${args.text}`,
      ruleHints ? `【规则引擎已命中的疑似问题（请逐条核对，不要照抄，错的要剔除）】\n${ruleHints}` : '',
      `要求：最多 ${args.maxItems} 条；按 must-fix → should-fix → style 排序；每条引用原文逐字片段。`,
      `同时给 dimensions：为每个维度打 0–100 分（score 是百分制内部分，界面会换算成考试分制）。`,
    ]
      .filter(Boolean)
      .join('\n\n');

    /**
     * 批改模型失败时降级到「只剩规则通道」。
     *
     * 触发场景很现实：池里全是思考型模型时，长作文批改经常跑不完。
     * 规则引擎已经确定性命中了几处错误，没理由因为模型超时就让用户一条都看不到。
     * 但必须如实写进 note —— 降级结果冒充完整批改，比什么都不给更危险。
     */
    let modelItems: AnnotatedDiff['items'] = [];
    let modelScore: AnnotatedDiff['score'];
    let rewrite: string | undefined;
    let tokens = 0;
    let degraded: string | null = null;

    try {
      const res = await ctx.deps.llm.json({
        system,
        user,
        schema: AnnotatedDiffSchema,
        maxTokens: 3000,
        temperature: 0.3,
        tag: 'write.diff_review',
      });
      modelItems = res.data.items;
      modelScore = res.data.score;
      rewrite = res.data.rewrite;
      tokens = res.tokens;
    } catch (err) {
      degraded = `批改模型这次没跑完（${(err as Error).message}）。下面只列规则引擎确定命中的问题，分数与示范改写暂缺，可以稍后重跑一次。`;
      ctx.log('批改模型失败，降级为规则通道', { err: (err as Error).message });
    }

    // 规则引擎命中但模型漏掉的，补回来 —— 规则是确定性的，不该被模型覆盖
    const items = [...modelItems];
    const seen = new Set(items.map((item) => item.before.trim()));
    for (const rule of ruleErrors) {
      if (items.length >= args.maxItems) break;
      if (seen.has(rule.quote.trim())) continue;
      items.push({
        before: rule.quote,
        after: rule.suggestion,
        ruleId: rule.ruleId,
        reason: rule.problem,
        severity: rule.severity,
        accept: null,
      });
    }
    const rank = { 'must-fix': 0, 'should-fix': 1, style: 2 } as const;
    const sorted = items
      .sort((a, b) => rank[a.severity] - rank[b.severity])
      .slice(0, args.maxItems);

    // 双通道：规则侧按命中数折算，LLM 侧按权重加权 —— G3 比对的就是这两个数
    const ruleOverall = Math.max(30, 92 - Math.min(60, ruleErrors.length * 7));
    const dims = modelScore?.dimensions ?? [];
    const weightSum = dims.reduce((sum, item) => sum + item.weight, 0) || 1;
    const llmOverall = dims.length
      ? Math.round(dims.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum)
      : undefined;

    /**
     * 模型既没给分、也没给批改项 —— 多半是输出被截断或直接返回了空对象。
     *
     * 必须与「作文确实没问题」区分开：一篇满是 many student / I am disagree 的作文
     * 被判定「没有命中问题」，比报错更糟，因为用户会信。
     * 有分数但没条目则是另一回事，那可能就是判断为无问题，按正常结果走。
     */
    if (!degraded && sorted.length === 0 && llmOverall === undefined) {
      degraded = '模型这次没有返回可用的批改结果（输出可能被截断）。这不代表作文没问题，建议重跑一次再下结论。';
    }

    const band =
      rubric && llmOverall !== undefined ? toBand(llmOverall, rubric.scale).label : modelScore?.band;

    const merged: AnnotatedDiff = {
      items: sorted,
      score: { dimensions: dims, ruleOverall, llmOverall, band },
      rewrite,
      note: degraded ?? undefined,
    };

    return {
      data: merged,
      artifacts: [
        artifact({
          id: ctx.nextArtifactId('annotated-diff'),
          type: 'annotated-diff',
          title: `${rubric?.label ?? args.exam} 批改${band ? ` · ${band}` : ''}`,
          data: merged,
          actions: ['accept-all', 'accept-item', 'reject-item', 'write-to-task', 'make-video'],
          writes: [{ target: 'profile.errors', summary: '把本次命中的错因计入候选（需你确认）' }],
          // 降级时把置信度压下来：界面据此标「待复核」，用户才知道这不是完整结论
          confidence: degraded ? 0.5 : 0.82,
        }),
      ],
      provenance: [
        { field: 'items[].ruleId', source: 'rule-engine' },
        { field: 'items[].reason', source: degraded ? 'rule-engine' : 'llm' },
        { field: 'score.ruleOverall', source: 'rule-engine' },
        { field: 'score.llmOverall', source: 'llm' },
      ],
      tokens,
      summary: degraded
        ? `${sorted.length} 条批改（结果不完整 · 模型未完成）`
        : `${sorted.length} 条批改 · 双通道 ${ruleOverall} / ${llmOverall ?? '—'}`,
    };
  },
});

// ---------------------------------------------------------------------------
// profile.patch —— 只产补丁，不直接改档案
// ---------------------------------------------------------------------------
export const profilePatchTool = defineTool({
  name: 'profile.patch',
  cost: { tokens: 0, ms: 30 },
  idempotent: true,
  args: z.object({
    /** 默认 false：先给用户看 diff，确认后才落盘 */
    confirm: z.boolean().default(false),
  }),
  async run(args, ctx) {
    const ruleData = ctx.bag['gra.rules'] as { errors: RuleError[] } | undefined;
    const diff = ctx.bag['write.diff_review'] as AnnotatedDiff | undefined;

    const ruleIds = new Set<string>();
    for (const item of ruleData?.errors ?? []) if (item.ruleId) ruleIds.add(item.ruleId);
    for (const item of diff?.items ?? []) if (item.ruleId) ruleIds.add(item.ruleId);

    if (ruleIds.size === 0) {
      return { data: { applied: false, reason: '本次没有可沉淀的错因' }, summary: '无错因可写入' };
    }

    const patch: LearnerPatch = LearnerPatchSchema.parse({
      patchId: `p_${ctx.runId}`,
      userId: ctx.userId,
      lang: ctx.lang,
      scope: 'errors',
      ops: [...ruleIds].map((ruleId) => ({ op: 'inc', ruleId, evidence: ctx.runId })),
      requiresConfirm: true,
      reversible: true,
    });

    const result = await ctx.deps.store.applyPatch(patch, { confirm: args.confirm });
    ctx.log('档案补丁', { ops: patch.ops.length, applied: result.applied });

    return {
      data: { patch, result },
      provenance: [{ field: 'ops[].ruleId', source: 'rule-engine' }],
      summary: result.applied
        ? `已写入 ${result.added.length} 条错因`
        : `待确认 ${patch.ops.length} 条错因`,
    };
  },
});

// ---------------------------------------------------------------------------
// gra.parse / gra.contrast —— 句法能力全部走 Language Port
// ---------------------------------------------------------------------------
export const syntaxParseTool = defineTool({
  name: 'gra.parse',
  cost: { tokens: 900, ms: 3000 },
  idempotent: false,
  args: z.object({ text: z.string().min(1, '要分析的句子不能为空') }),
  async run(args, ctx) {
    const ports = ctx.deps.language(ctx.lang);
    if (!ports) throw new PortNotWiredError(`language:${ctx.lang}`, '该语种没有 Language Pack');

    const parsed = await ports.syntax.parse(args.text, { rules: ctx.sceneRules });
    return {
      data: parsed,
      artifacts: [
        artifact({
          id: ctx.nextArtifactId('syntax-tree'),
          type: 'syntax-tree',
          title: '句子结构拆解',
          data: parsed,
          actions: ['make-video', 'add-to-vocab', 'easier-version'],
          confidence: 0.8,
        }),
      ],
      provenance: [{ field: 'nodes', source: 'llm' }],
      tokens: 900,
      summary: parsed.summary,
    };
  },
});

export const syntaxContrastTool = defineTool({
  name: 'gra.contrast',
  cost: { tokens: 400, ms: 1800 },
  idempotent: false,
  args: z.object({ text: z.string().min(1) }),
  async run(args, ctx) {
    const ports = ctx.deps.language(ctx.lang);
    if (!ports) throw new PortNotWiredError(`language:${ctx.lang}`, '该语种没有 Language Pack');

    const points = await ports.syntax.contrast(args.text, 'zh');
    return {
      data: { points },
      provenance: [{ field: 'points', source: 'llm' }],
      tokens: 400,
      summary: points.length ? `${points.length} 个母语迁移点` : '无明显迁移点',
    };
  },
});

// ---------------------------------------------------------------------------
// explain.video —— 讲解视频。只起作业，不等它跑完
// ---------------------------------------------------------------------------
/**
 * 为什么不在这里 await 到 done：
 * 一条讲解片要写分镜、逐镜配音、对时间轴、拼轨，几分钟起步。
 * 在工具里等，SSE 会安静到被当成卡死，断线还得重跑整条流水线。
 * 所以这里只返回「作业已起 + 去哪看进度」，产物里带上 jobId。
 */
export const explainVideoTool = defineTool({
  name: 'explain.video',
  cost: { tokens: 0, ms: 800 },
  idempotent: true,
  args: z.object({
    articleId: z.string().min(1, '讲解视频按文章生成，需要 articleId'),
    depth: z.enum(['short', 'medium', 'long']).default('short'),
    coach: z.enum(['target', 'bilingual']).default('target'),
  }),
  async run(args, ctx) {
    const started = await ctx.deps.media.explainVideo.start({
      articleId: args.articleId,
      depth: args.depth,
      coach: args.coach,
    });

    const data = {
      articleId: args.articleId,
      depth: args.depth,
      coach: args.coach,
      jobId: started.jobId ?? null,
      videoId: started.videoId ?? null,
      state: started.reused ? 'done' : 'running',
      pollUrl: started.jobId ? `/api/agent/media/explain/${started.jobId}` : null,
    };

    // 命中缓存 / 秒出：直接把播放地址给出来，不让用户再点一次
    const videoRef = started.videoId ? `/api/explain-videos/${started.videoId}` : null;

    ctx.log('讲解视频作业已启动', {
      articleId: args.articleId,
      depth: args.depth,
      jobId: started.jobId,
      reused: started.reused,
    });

    return {
      data: { ...data, videoRef },
      artifacts: [
        artifact({
          id: ctx.nextArtifactId('explain-video'),
          type: 'explain-video',
          title: `解题讲解 · ${args.depth === 'short' ? '精简版' : args.depth === 'long' ? '精讲版' : '标准版'}`,
          data: { ...data, videoRef },
          actions: started.reused ? ['play'] : ['watch-progress', 'cancel'],
          confidence: 0.9,
        }),
      ],
      summary: started.reused ? '命中已有讲解，可直接播放' : '讲解生成中，可边看进度',
    };
  },
});

/** M0 全部内置工具；新增场景时在这里追加，不动 core/ */
export const BUILTIN_TOOLS = [
  profileReadTool,
  examRubricTool,
  grammarRulesTool,
  diffReviewTool,
  profilePatchTool,
  syntaxParseTool,
  syntaxContrastTool,
  explainVideoTool,
];
