/**
 * 四个协议 —— 内核、工具、界面、档案之间的接口契约（设计文档 §5）。
 *
 * 为什么这四个东西值得单独定义：它们一旦定下来，场景包、渲染器、评测集
 * 就可以并行开发；它们一旦反复变，所有下游都要跟着改。改协议比加功能贵得多。
 */
import { z } from 'zod';
import type { SyntaxNode } from './types';

export const HELP_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export const RUN_MODES = ['ask', 'craft', 'coach'] as const;
export const ARTIFACT_TYPES = [
  'annotated-diff',
  'score-report',
  'explain-video',
  'reading-pack',
  'quiz-set',
  'speaking-report',
  'plan-patch',
  'card-deck',
  'syntax-tree',
] as const;
export const RENDERERS = [
  'diff-pane',
  'score-pane',
  'video-pane',
  'reader-pane',
  'quiz-pane',
  'speaking-pane',
  'plan-pane',
  'deck-pane',
  'syntax-pane',
] as const;

export const ProvenanceSchema = z.object({
  field: z.string(),
  source: z.enum(['rule-engine', 'llm', 'dictionary', 'exam-bank', 'srs', 'user', 'file']),
  ref: z.string().optional(),
});

/** 5.3 Artifact：界面靠它决定怎么渲染，采纳靠 actions */
export const ArtifactSchema = z.object({
  artifactId: z.string(),
  type: z.enum(ARTIFACT_TYPES),
  renderer: z.enum(RENDERERS),
  title: z.string(),
  /** 各类型的 payload 结构不同，由 verifier 里的分类型 schema 兜底（G1） */
  data: z.unknown(),
  actions: z.array(z.string()).default([]),
  /** 若采纳，会写到哪里（供前端提示「这会改我的错因库」） */
  writes: z.array(z.object({ target: z.string(), summary: z.string() })).default([]),
  confidence: z.number().min(0).max(1).optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** 5.1 AgentRun 的一步 */
export const RunStepSchema = z.object({
  n: z.number().int().positive(),
  tool: z.string(),
  status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']),
  ms: z.number().nonnegative().default(0),
  tokens: z.number().nonnegative().default(0),
  ok: z.boolean().default(true),
  /** 失败原因（含 PortNotWiredError 的标记），便于区分「没接线」与「模型挂了」 */
  error: z.string().optional(),
  /** 这一步产出了什么（简短摘要，完整数据在 artifact 里） */
  summary: z.string().optional(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

/** Lingua CI 五关的结果（设计文档 §3.5） */
export const VerifyReportSchema = z.object({
  gates: z.array(
    z.object({
      id: z.enum(['G1', 'G2', 'G3', 'G4', 'G5']),
      verdict: z.enum(['pass', 'fail', 'skip']),
      detail: z.string().default(''),
    }),
  ),
  /** 综合置信度：任一关 fail 会显著压低它，界面据此标「待复核」 */
  confidence: z.number().min(0).max(1),
  /** 需要人复核的原因，逐条给 */
  review: z.array(z.string()).default([]),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

/** 5.1 AgentRun：一次执行的可回放记录 */
export const AgentRunSchema = z.object({
  runId: z.string(),
  mode: z.enum(RUN_MODES),
  scene: z.string(),
  lang: z.string(),
  userId: z.string(),
  input: z.record(z.unknown()),
  /** 送进模型的上下文摘要（不是全文），用于解释「它为什么这么判断」 */
  contextDigest: z
    .object({
      level: z.string().optional(),
      daysLeft: z.number().optional(),
      topErrors: z.array(z.string()).default([]),
      helpLevel: z.enum(HELP_LEVELS).optional(),
    })
    .default({ topErrors: [] }),
  steps: z.array(RunStepSchema).default([]),
  verify: VerifyReportSchema.optional(),
  /**
   * 存的是完整产物，不是 id 数组。
   * 只存 id 的话 trace 就只剩「跑过哪些步骤」，点开看不到批注内容 —— 那不叫回放。
   * 采纳接口也依赖这里的 payload，否则只能让前端把产物传回来，等于允许伪造。
   */
  artifacts: z.array(ArtifactSchema).default([]),
  budget: z.object({
    usedTokens: z.number().nonnegative().default(0),
    limit: z.number().positive(),
  }),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  ok: z.boolean().default(true),
  error: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

/** 5.2 ToolCall：调用信封。idempotent + cacheKey 支撑断点续跑与成本复用 */
export const ToolCallSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
  meta: z.object({
    idempotent: z.boolean(),
    cacheKey: z.string().optional(),
    timeoutMs: z.number().positive().default(30_000),
    costHint: z.number().nonnegative().default(0),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** 5.4 LearnerPatch：档案变更必须可审可回滚，所以是「操作列表」而不是「新档案」 */
export const LearnerPatchSchema = z.object({
  patchId: z.string(),
  userId: z.string(),
  /** 语种必须带上：英语与日语的错因库物理隔离，绝不允许跨语种写入 */
  lang: z.string(),
  scope: z.enum(['errors', 'preferences', 'style']),
  ops: z
    .array(
      z.discriminatedUnion('op', [
        z.object({
          op: z.literal('inc'),
          ruleId: z.string(),
          evidence: z.string(),
          quote: z.string().optional(),
        }),
        z.object({
          op: z.literal('promote'),
          ruleId: z.string(),
          from: z.enum(['candidate', 'long-term']),
          to: z.enum(['long-term', 'resolved']),
        }),
        z.object({
          op: z.literal('set'),
          key: z.string(),
          value: z.string(),
        }),
      ]),
    )
    .min(1),
  requiresConfirm: z.boolean().default(true),
  reversible: z.literal(true).default(true),
});
export type LearnerPatch = z.infer<typeof LearnerPatchSchema>;

// ---------------------------------------------------------------------------
// 分类型 payload（G1 结构校验用；也是前端渲染器的输入契约）
// ---------------------------------------------------------------------------

export const AnnotatedDiffSchema = z.object({
  items: z
    .array(
      z.object({
        before: z.string(),
        after: z.string(),
        ruleId: z.string().default(''),
        reason: z.string().default(''),
        severity: z.enum(['must-fix', 'should-fix', 'style']).default('should-fix'),
        accept: z.boolean().nullable().default(null),
      }),
    )
    .default([]),
  /** 双通道分：规则引擎与 LLM 各一份，G3 比对的就是这两个 */
  score: z
    .object({
      dimensions: z
        .array(z.object({ id: z.string(), name: z.string(), score: z.number(), weight: z.number() }))
        .default([]),
      ruleOverall: z.number().optional(),
      llmOverall: z.number().optional(),
      band: z.string().optional(),
    })
    .optional(),
  rewrite: z.string().optional(),
  /**
   * 降级说明。有值就表示这份批改不完整（例如模型超时，只剩规则通道）。
   * 不写这一条，降级结果会被当成完整结论用 —— 这比不返回更危险。
   */
  note: z.string().optional(),
});
export type AnnotatedDiff = z.infer<typeof AnnotatedDiffSchema>;

/** G1 只看「有结构」，不看内容质量 —— 内容靠 G2–G5 */

/** 递归的句法 IR schema：英语填成分树，日语填文节 + 助词，结构同一份 */
/**
 * 句法节点。id 与 children 都不要求模型给：
 * - id 由适配器编号（模型生成的 id 会重号，前端 key 冲突整棵树重渲染）；
 * - children 缺省为空数组（叶子节点不写 children 是最自然的输出，不该因此判失败）。
 */
export const SyntaxNodeSchema: z.ZodType<SyntaxNode> = z.lazy(() =>
  z.object({
    id: z.string().optional(),
    role: z.enum(['head', 'modifier', 'subject', 'predicate', 'object', 'particle', 'clause', 'other']),
    text: z.string(),
    surface: z.string().optional(),
    note: z.string().optional(),
    children: z.array(SyntaxNodeSchema).default([]),
  }),
) as z.ZodType<SyntaxNode>;

export const SyntaxTreeSchema = z.object({
  nodes: z.array(SyntaxNodeSchema).min(1),
  summary: z.string().default(''),
  /** 0–10，供阅读难度与「这句要不要讲」判断 */
  difficulty: z.number().min(0).max(10).default(0),
});

/**
 * 讲解视频产物：只承诺「作业已起 + 去哪看进度」。
 * 真视频是异步产出的，产物里塞一个还没生成的 videoRef 就是在骗渲染层。
 */
export const ExplainVideoPayloadSchema = z.object({
  articleId: z.string(),
  depth: z.enum(['short', 'medium', 'long']),
  coach: z.enum(['target', 'bilingual']),
  jobId: z.string().nullable(),
  videoId: z.string().nullable(),
  videoRef: z.string().nullable().default(null),
  state: z.enum(['running', 'done']),
  pollUrl: z.string().nullable().default(null),
});

export const ARTIFACT_PAYLOAD: Partial<Record<(typeof ARTIFACT_TYPES)[number], z.ZodTypeAny>> = {
  'annotated-diff': AnnotatedDiffSchema,
  'syntax-tree': SyntaxTreeSchema,
  'explain-video': ExplainVideoPayloadSchema,
};
