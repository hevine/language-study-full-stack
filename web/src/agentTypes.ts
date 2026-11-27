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
  /** 口语场景：POST /agent/audio 上传后拿到的录音 id */
  audioRef?: string;
  audioName?: string;
  audioDurationMs?: number;
  audioSource?: AgentAudioSource;
  /** 文本框里的内容是手打的、录音转写的，还是转写后改过的 */
  transcriptSource?: TranscriptSource;
  helpLevel?: AgentHelpLevel;
  userId?: string;
}

export type AgentAudioSource = 'recorder' | 'file' | 'recorder-pen';

export type TranscriptSource = 'typed' | 'asr' | 'asr-edited';

/** 录音仓里的一段音频；url 可直接给 <audio src> */
export interface AgentAudio {
  audioId: string;
  name: string;
  ext: string;
  bytes: number;
  durationMs: number | null;
  source: AgentAudioSource;
  lang: string;
  createdAt: string;
  url: string;
}

/**
 * 口语评估产物。
 * basis 是这次评估的依据：录音转写 / 改过的稿 / 手打文本 —— 回看时必须能分清，
 * 否则 88 分到底是「口语实测」还是「文稿评分」就永远说不清。
 */
/**
 * 节奏实测。服务端用词级时间戳或声学停顿测出来的硬数据，
 * 与 LLM 的文本判断分开显示 —— 「停了 7 次」和「读起来不流利」是两回事。
 */
export interface ProsodyPayload {
  source: 'asr-words' | 'asr-segments' | 'vad';
  sourceLabel: string;
  note: string;
  durationMs: number;
  wordCount: number;
  wpm: number;
  articulationWpm: number;
  /** 语速口径：英语「词/分钟」，日语「モーラ/分钟」。服务端没给时按词计。 */
  paceLabel?: string;
  pauseCount: number;
  longestPauseMs: number;
  speechRatio: number;
  leadInMs: number;
  pauses: Array<{ startMs: number; endMs: number }>;
  /** 整段音高轮廓；只有从波形量得出来时才有 */
  pitch?: { medianHz: number; p10Hz: number; p90Hz: number; rangeSemitones: number; voicedRatio: number };
  /** 60–220ms 的短闭塞：促音候选，含正常闭锁，别当促音个数 */
  closures?: Array<{ startMs: number; endMs: number }>;
  dimensions: Array<{ id: string; score: number; note: string }>;
  wordLevel: Array<{ word: string; score: number; hint?: string }>;
}

export interface SpeakingReportPayload {
  dimensions: Array<{ id: 'fluency' | 'grammar' | 'coherence' | 'lexical'; score: number; note: string }>;
  overall: number;
  band?: string;
  suggestions: string[];
  summary: string;
  basis?: {
    source: TranscriptSource;
    sourceLabel: string;
    transcript: string;
    durationMs: number | null;
    audioRef: string | null;
    phonology: boolean;
  };
  /** 没有实测（手打稿 / 太短 / 解码失败）时整块缺省，界面不显示实测区 */
  prosody?: ProsodyPayload;
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
  /** 产物派生出的复习卡：confirm=false 时只有 preview */
  cards?: {
    preview: Array<{
      kind: 'error' | 'sentence' | 'word';
      front: string;
      back: string;
      context?: string;
      ruleId?: string;
      sourceRef?: string;
    }>;
    created: number;
  };
}
