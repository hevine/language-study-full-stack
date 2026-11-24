/**
 * Lingua Agent Studio 的前端契约。
 *
 * 与 `server/src/agent/protocols.ts` 一一对应。之所以在前端再写一份、而不是从
 * server 目录直接 import：前端不能依赖服务端实现（将来拆进程后两者会分仓），
 * 而协议本身就是「跨端契约」，两处各自持有声明是正常的。
 *
 * 改这里之前先改协议。反过来会出事：界面按新字段渲染、服务端还没给。
 */

export type AgentHelpLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type AgentRunMode = 'ask' | 'craft' | 'coach';
export type AgentStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export type AgentSceneCategory =
  | 'vocab'
  | 'grammar'
  | 'sentence'
  | 'reading'
  | 'writing'
  | 'speaking'
  | 'exam'
  | 'translation'
  | 'peripheral';

export type AgentArtifactType =
  | 'annotated-diff'
  | 'score-report'
  | 'explain-video'
  | 'reading-pack'
  | 'quiz-set'
  | 'speaking-report'
  | 'plan-patch'
  | 'card-deck'
  | 'syntax-tree';

// ---------------------------------------------------------------------------
// 场景与语言能力（GET /api/agent/scenes）
// ---------------------------------------------------------------------------

export interface AgentScene {
  id: string;
  title: string;
  version: string;
  category: AgentSceneCategory;
  modes: AgentRunMode[];
  artifacts: AgentArtifactType[];
  tools: string[];
  requires: string[];
  exams: Record<string, string[]>;
  helpDefault: AgentHelpLevel;
}

export interface AgentLangPack {
  code: string;
  name: string;
  scale: string;
  bands: string[];
  supported: string[];
  unsupported: Record<string, string>;
  /** 有语言包 ≠ 有能力：日语现在只有包，没有分词与规则集 */
  ready: boolean;
}

export interface AgentScenesResponse {
  scenes: AgentScene[];
  langs: AgentLangPack[];
  tools: Array<{ name: string; cost: { tokens?: number; ms?: number }; idempotent: boolean }>;
}

// ---------------------------------------------------------------------------
// Artifact / Run / Verify
// ---------------------------------------------------------------------------

export interface AgentArtifactWrite {
  target: string;
  summary: string;
}

export interface AgentArtifact {
  artifactId: string;
  type: AgentArtifactType;
  renderer: string;
  title: string;
  /** 各类型 payload 结构不同，由渲染器各自窄化 */
  data: unknown;
  actions: string[];
  writes: AgentArtifactWrite[];
  confidence?: number;
}

export interface AgentRunStep {
  n: number;
  tool: string;
  status: AgentStepStatus;
  ms: number;
  tokens: number;
  ok: boolean;
  error?: string;
  summary?: string;
}

export type AgentGateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5';
export type AgentGateVerdict = 'pass' | 'fail' | 'skip';

export interface AgentVerifyReport {
  gates: Array<{ id: AgentGateId; verdict: AgentGateVerdict; detail: string }>;
  confidence: number;
  review: string[];
}

export interface AgentRun {
  runId: string;
  mode: AgentRunMode;
  scene: string;
  lang: string;
  userId: string;
  input: Record<string, unknown>;
  contextDigest: {
    level?: string;
    daysLeft?: number;
    topErrors: string[];
    helpLevel?: AgentHelpLevel;
  };
  steps: AgentRunStep[];
  verify?: AgentVerifyReport;
  artifacts: AgentArtifact[];
  budget: { usedTokens: number; limit: number };
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  error?: string;
}

export interface AgentRunInput {
  lang: string;
  mode: AgentRunMode;
  query?: string;
  text?: string;
  exam?: string;
  scene?: string;
  /** 阅读类场景必填：讲解视频按文章生成 */
  articleId?: string;
  helpLevel?: AgentHelpLevel;
  userId?: string;
}

/** 历史列表只给摘要（trace 文件里存全文，列表页不该把全部 payload 拉一遍） */
export interface AgentRunSummary {
  runId: string;
  scene: string;
  startedAt: string;
  ok: boolean;
}

/** SSE 事件：与服务端 AgentEvent 一致 */
export type AgentEvent =
  | { type: 'start'; runId: string; scene: string; confidence: number; steps: string[]; needsPreview: boolean }
  | { type: 'step'; step: AgentRunStep }
  | { type: 'artifact'; artifact: AgentArtifact }
  | { type: 'verify'; report: AgentVerifyReport }
  | { type: 'done'; run: AgentRun }
  | { type: 'clarify'; message: string; candidates: Array<{ id: string; title: string }> }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// 各渲染器的 payload
// ---------------------------------------------------------------------------

export interface AnnotatedDiffItem {
  before: string;
  after: string;
  ruleId: string;
  reason: string;
  severity: 'must-fix' | 'should-fix' | 'style';
  accept: boolean | null;
}

export interface AnnotatedDiffPayload {
  items: AnnotatedDiffItem[];
  score?: {
    dimensions: Array<{ id: string; name: string; score: number; weight: number }>;
    ruleOverall?: number;
    llmOverall?: number;
    band?: string;
  };
  rewrite?: string;
  /** 降级说明：有值就表示这份批改不完整（例如模型超时，只剩规则通道） */
  note?: string;
}

export type SyntaxRole =
  | 'head'
  | 'modifier'
  | 'subject'
  | 'predicate'
  | 'object'
  | 'particle'
  | 'clause'
  | 'other';

export interface SyntaxTreeNodePayload {
  id?: string;
  role: SyntaxRole;
  text: string;
  surface?: string;
  note?: string;
  children: SyntaxTreeNodePayload[];
}

export interface SyntaxTreePayload {
  nodes: SyntaxTreeNodePayload[];
  summary: string;
  difficulty: number;
}

export interface ExplainVideoPayload {
  articleId: string;
  depth: 'short' | 'medium' | 'long';
  coach: 'target' | 'bilingual';
  jobId: string | null;
  videoId: string | null;
  videoRef: string | null;
  state: 'running' | 'done';
  pollUrl: string | null;
}

/** GET /api/agent/media/explain/:jobId */
export interface ExplainJobState {
  state: 'running' | 'done' | 'canceled' | 'error';
  progress: number;
  detail: string;
  videoId?: string;
  videoRef?: string;
  error?: string;
  tokens?: number;
}

// ---------------------------------------------------------------------------
// 采纳
// ---------------------------------------------------------------------------

export interface AgentAdoptInput {
  runId: string;
  artifactId: string;
  date?: string;
  taskId?: string;
  confirm: boolean;
}

export interface AgentAdoptResult {
  confirm: boolean;
  attached: boolean;
  taskId: string | null;
  taskTitle: string | null;
  reason: string | null;
  patch: {
    applied: boolean;
    added: string[];
    promoted: string[];
    pending?: Array<{ op: string; detail: string }>;
  } | null;
  /** 产物挂进任务 + 错因进了复诊队列；只有 confirm=true 时才可能为 true */
  closedLoop: boolean;
}
