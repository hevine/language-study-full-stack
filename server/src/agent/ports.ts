/**
 * Port 契约层 —— 这是「同进程但随时可拆」的全部秘密。
 *
 * 规则只有一条：**内核只依赖 Port，不依赖具体实现**。
 * - M0：adapters/inprocess.ts 直接调主项目 service（零网络开销）；
 * - 将来拆分：写一个 HTTP/gRPC adapter 替换同一接口，core/ 下不改一行。
 *
 * 同理，语言能力也全部走 Port：新增一门语言 = 新增 lang/<code>/ 数据 + 实现这 5 个 Port，
 * 不需要动 core/。这是「接入新语言不修改 core/」这条验收线的技术依据。
 */
import type { ExplainDepth } from '../domain/explainVideo';
import type {
  ErrorRecord,
  LangCode,
  LangToken,
  LearnerProfile,
  Provenance,
  SceneCategory,
  SyntaxNode,
  ToolCost,
} from './types';
import type { AgentRun, Artifact, LearnerPatch } from './protocols';

// ---------------------------------------------------------------------------
// 语言能力 Port（每门语言一套实现）
// ---------------------------------------------------------------------------

/**
 * 分词。英语按空格与标点切，日语要形态素分析。
 * 凡是「词」级的功能（生词密度、词汇本、lookup）都必须过这里，不许各自 split(' ')。
 */
export interface TokenizerPort {
  readonly lang: LangCode;
  tokenize(text: string): Promise<LangToken[]>;
  /** 词形还原；日语返回辞書形。做不到就返回原样，不要抛错 */
  lemmatize(token: LangToken): Promise<string>;
}

/**
 * 句法分析。返回统一 IR，内部实现对英语可以是成分树、对日语可以是文节 + 格助词。
 * 上层（产物渲染、讲解视频、句法树图）只消费 SyntaxNode，不关心语言。
 */
export interface SyntaxPort {
  readonly lang: LangCode;
  /**
   * 长难句拆解：主干 / 修饰 / 从句 / 助词，逐层标注。
   * opts.rules 是场景守则原文 —— Port 本身无状态，但需要知道「这次按哪套规矩讲」。
   */
  parse(
    text: string,
    opts?: { rules?: string },
  ): Promise<{ nodes: SyntaxNode[]; summary: string; difficulty: number }>;
  /**
   * 母语迁移解释：中文母语者学英语 / 学日语的典型干扰点。
   * 日语特有：汉字同形异义（勉強 / 大丈夫 / 手紙），这是中文用户的差异点。
   */
  contrast(text: string, nativeLang: 'zh'): Promise<Array<{ point: string; note: string }>>;
}

/**
 * 错误类型体系。英语 14 类、日语是助词/活用/敬语/自他/量词，
 * 规则集完全不可复用 —— 但接口必须统一，否则规则引擎会长成一棵 if-else 树。
 */
export interface ErrorTaxonomyPort {
  readonly lang: LangCode;
  /** ruleId 必须来自 lang/<code>/errors.json，G5 校验靠它判断「有据可依」 */
  scan(text: string): Promise<
    Array<{ ruleId: string; quote: string; problem: string; suggestion: string; severity: 'must-fix' | 'should-fix' | 'style' }>
  >;
  /** 该语言的全部合法 ruleId，供校验层对照 */
  ruleIds(): string[];
}

/** 发音评测。英语走 IPA 音素对齐，日语走モーラ时长 + アクセント 型比对 */
export interface PhonologyPort {
  readonly lang: LangCode;
  /** 无音频能力时返回 null，而不是编一个分数 —— 教育产品宁缺毋假 */
  score(input: { audioRef: string; transcript: string; target?: string }): Promise<null | {
    overall: number;
    dimensions: Array<{ id: string; score: number; note: string }>;
    wordLevel: Array<{ word: string; score: number; hint?: string }>;
  }>;
}

/** 等级刻度：CEFR 6 档 / JLPT 5 档 / TOPIK 6 档，必须能互相映射，否则可行性测算全错 */
export interface LevelScalePort {
  readonly lang: LangCode;
  readonly scale: string;
  readonly bands: string[];
  /** 文本 → 该刻度下的难度（用于阅读分级与 i+1 控密度） */
  estimateTextLevel(text: string): Promise<{ band: string; vocabCoverage: number; avgSentence: number }>;
  /** 跨刻度换算，用于「英语 B2 换成日语大概 N3」这类问题 */
  toCommonScore(band: string): number;
}

/** 一门语言的全部能力，由 registry 按 code 装配 */
export interface LanguagePorts {
  tokenizer: TokenizerPort;
  syntax: SyntaxPort;
  taxonomy: ErrorTaxonomyPort;
  phonology: PhonologyPort;
  level: LevelScalePort;
}

// ---------------------------------------------------------------------------
// 基础设施 Port
// ---------------------------------------------------------------------------

/**
 * 只要求「能校验」的最小结构，而不是绑定 zod ——
 * 这样内核不被某个校验库锁死，测试里塞一个手写的 safeParse 也能跑。
 */
export interface JsonSchemaLike<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } };
}

export interface LlmJsonRequest<T> {
  system: string;
  user: string;
  schema: JsonSchemaLike<T>;
  temperature?: number;
  maxTokens?: number;
  /**
   * 是否让模型先思考再答。默认 'off'（交互优先）。
   * 需要质量的深评类步骤（作文批改）由内核显式传 'on'。
   */
  thinking?: 'auto' | 'off' | 'on';
  /** 用于成本归因与日志定位，如 'write.diff_review' */
  tag: string;
}

/**
 * 模型调用。故意不暴露「用哪个模型」——号池与降级由适配器决定，
 * 内核只关心「给我结构化结果 + 花掉多少 token」。
 */
export interface LlmPort {
  json<T>(req: LlmJsonRequest<T>): Promise<{ data: T; tokens: number }>;
  text(
    req: { system: string; user: string; maxTokens?: number; thinking?: 'auto' | 'off' | 'on'; tag: string },
  ): Promise<{ text: string; tokens: number }>;
}

/**
 * 学习者档案。DB 权威、文件投影、rules/ 用户主权（设计文档 §3.6）。
 * M0 用 JSONL 落地，M0.5 换 SQLite —— 换的是这个接口的实现，不是调用方。
 */
export interface LearnerStorePort {
  read(input: { userId: string; lang: LangCode; topN?: number }): Promise<LearnerProfile>;
  /** confirm=false 时只返回「将要写什么」，不落盘（对应 UI 上逐条确认） */
  applyPatch(patch: LearnerPatch, opts: { confirm: boolean }): Promise<{
    applied: boolean;
    added: string[];
    promoted: string[];
    /** confirm=false 时的待确认摘要 */
    pending?: Array<{ op: string; detail: string }>;
  }>;
  findError(userId: string, lang: LangCode, ruleId: string): Promise<ErrorRecord | null>;
}

/**
 * 任务回写：产物采纳后落进今日任务，否则「学了一点」无法闭环。
 *
 * 这里刻意不提供「自动挂载」：挂载 = 用户采纳，是北极星指标的计数点。
 * 让 Agent 自己挂上去，等于每跑一次就算学完一次，指标立刻失去意义。
 */
export interface TaskPort {
  attachArtifact(input: {
    userId: string;
    /** YYYY-MM-DD；缺省为今天 */
    date?: string;
    /** 指定了就挂这一条；没指定则按垂类挑语义相符的任务 */
    taskId?: string;
    /** 场景垂类（writing / sentence / reading …），未指定 taskId 时用它挑任务 */
    category?: SceneCategory;
    /**
     * 只算落点、不写库。
     *
     * 采纳前必须让用户看见「会挂到哪条任务」，否则确认按钮就是个盲签：
     * 用户只能选择信或不信，而不是核对。这跟档案补丁要先给 pending 是同一个道理。
     */
    dryRun?: boolean;
    artifact: {
      artifactId: string;
      type: string;
      title: string;
      scene: string;
      runId: string;
    };
  }): Promise<{
    attached: boolean;
    taskId?: string;
    taskTitle?: string;
    /** attached=false 时给人话理由，前端直接显示 */
    reason?: string;
  }>;
}

/**
 * 媒体：TTS 与讲解视频。最贵的两件事都在这，成本核算与缓存必须走这里。
 *
 * 讲解视频为什么是 start/poll 两段式而不是一个 Promise：
 * 真实链路要写分镜脚本、逐镜 TTS、对时间轴、拼轨，几分钟起步。
 * 同步等它，SSE 会安静到被当成卡死；断了还要重跑整条流水线。
 * 起作业 + 轮询，才有「进度可看、断线可续」。
 */
export interface MediaPort {
  tts(input: {
    text: string;
    lang: LangCode;
    /** Neural 音色名；缺省按语种取默认 */
    voice?: string;
    /** 语速倍率 0.5–1.4，默认 1 */
    rate?: number;
  }): Promise<{ audioRef: string; ms: number; cached: boolean }>;

  explainVideo: {
    /** 起一个讲解作业。同一篇 + 同档位已有缓存/在跑时会复用 */
    start(input: {
      articleId: string;
      depth: ExplainDepth;
      coach: 'target' | 'bilingual';
    }): Promise<{ jobId?: string; videoId?: string; reused: boolean; ms: number }>;
    /** 查作业进度；done 时给 videoRef */
    poll(input: { jobId: string }): Promise<{
      /** canceled 单独一档：用户自己停的，不该显示成「还在跑」，也不该算失败 */
      state: 'running' | 'done' | 'canceled' | 'error';
      progress: number;
      detail: string;
      videoId?: string;
      videoRef?: string;
      error?: string;
      tokens?: number;
    }>;
  };
}

/** run trace：可回放、可中断续跑、成本可归因 */
export interface TracePort {
  save(run: AgentRun): Promise<void>;
  load(runId: string): Promise<AgentRun | null>;
  list(limit?: number): Promise<Array<{ runId: string; scene: string; startedAt: string; ok: boolean }>>;
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export interface AgentDeps {
  llm: LlmPort;
  store: LearnerStorePort;
  tasks: TaskPort;
  media: MediaPort;
  trace: TracePort;
  /** 按语种取能力；不支持的语种返回 null，由路由器在规划前裁剪 */
  language(code: LangCode): LanguagePorts | null;
  /** 共享的元信息，给 provenance 与日志用 */
  now(): Date;
}

/** 未接通的 Port 统一抛这个，便于在 run trace 里一眼看出「这步是没接线，不是模型出错」 */
export class PortNotWiredError extends Error {
  readonly port: string;
  constructor(port: string, hint = '') {
    super(`Port 未接通：${port}${hint ? `（${hint}）` : ''}`);
    this.name = 'PortNotWiredError';
    this.port = port;
  }
}

export type { Artifact, Provenance, ToolCost };
