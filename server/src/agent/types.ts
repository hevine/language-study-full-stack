/**
 * Agent 内核的公共类型。
 *
 * 这里只放「跨边界」的东西（Port、协议、内核之间传的），
 * 具体场景的业务类型留在各自的 tools 里 —— 别把内核做成万金油类型库。
 */
import type { Language } from '../domain/language';

/** 语言标识直接复用主项目的 Language，避免两套枚举互相转换（多语种靠 Language Pack 数据扩展，不靠改类型） */
export type LangCode = Language;

/** 三种模式决定「能不能动手」，见设计文档 §2.3 */
export type RunMode = 'ask' | 'craft' | 'coach';

/** 最小帮助原则的四档，见设计文档 §3.7 */
export type HelpLevel = 'L0' | 'L1' | 'L2' | 'L3';

export const HELP_ORDER: HelpLevel[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * 九个垂类。Language Pack 按垂类声明「这门语言支不支持」，
 * 而不是按场景包 id —— 同一垂类可以有多个场景包（如写作有考试批改、邮件、留学文书）。
 */
export const SCENE_CATEGORIES = [
  'vocab',
  'grammar',
  'sentence',
  'reading',
  'writing',
  'speaking',
  'exam',
  'translation',
  'peripheral',
] as const;
export type SceneCategory = (typeof SCENE_CATEGORIES)[number];

/** 产物类型决定前端用哪个渲染器，见设计文档 §5.3 */
export type ArtifactType =
  | 'annotated-diff'
  | 'score-report'
  | 'explain-video'
  | 'reading-pack'
  | 'quiz-set'
  | 'speaking-report'
  | 'plan-patch'
  | 'card-deck'
  | 'syntax-tree';

export type ProvenanceSource =
  | 'rule-engine'
  | 'llm'
  | 'dictionary'
  | 'exam-bank'
  | 'srs'
  | 'user'
  | 'file';

/** 每个结论都要能说清「凭什么」，这是 G5 校验与界面标注的依据 */
export interface Provenance {
  /** 来源覆盖的字段路径，如 items[].reason */
  field: string;
  source: ProvenanceSource;
  /** 补充指向：词典名 / 语法点 id / 真题卷号 */
  ref?: string;
}

/** 工具成本声明：Planner 用它做预算裁剪，lingua-ops 用它做成本归因 */
export interface ToolCost {
  tokens?: number;
  ms?: number;
  tts?: boolean;
}

/** 分词结果：日语是形态素、英语是词；结构统一，上层不关心怎么切的 */
export interface LangToken {
  surface: string;
  /** 原形（英语 lemma / 日语辞書形） */
  base?: string;
  /** 读音（日语假名、英语音标可选） */
  reading?: string;
  /** 词性（UPOS 或简写） */
  pos?: string;
  start: number;
  end: number;
}

/**
 * 句法统一中间表示（IR）。
 *
 * 这是多语种扩展的关键：英语填 subject/predicate/object/clause，
 * 日语填 particle/clause，渲染器只认 role、不认语言。
 * 约定：渲染层与产物层禁止出现 if (lang === 'ja')。
 */
export interface SyntaxNode {
  /**
   * 渲染主键，由适配器按深度优先统一编号（n1 / n1.1 …）。
   * 不让模型生成：它会重号或编出不稳定的 id，前端 key 一冲突就整棵树重渲染。
   */
  id: string;
  role: 'head' | 'modifier' | 'subject' | 'predicate' | 'object' | 'particle' | 'clause' | 'other';
  text: string;
  /** 注音 / 原形（日语 furigana 走这里） */
  surface?: string;
  /** 该成分的教学提示 */
  note?: string;
  children: SyntaxNode[];
}

/** 错因状态：候选 → 长期 → 已攻克，只允许单向流转（见设计文档 §3.6 三振升级） */
export type ErrorStatus = 'candidate' | 'long-term' | 'resolved';

export interface ErrorRecord {
  /** 与 Language Pack 的 errors.json 中 ruleId 对应 */
  ruleId: string;
  status: ErrorStatus;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 证据 runId 列表，供「为什么认为我冠词弱」追溯 */
  evidence: string[];
  /** Loop 复习中该错因的遗忘次数（grade <= 1），由 storage 层聚合 */
  lapseCount?: number;
}

/** 组装上下文用的档案切片（L1 + L2 层，设计文档 §3.2） */
export interface LearnerProfile {
  userId: string;
  lang: LangCode;
  /** 抽象刻度 + 语言映射，见 LevelScalePort */
  level: { scale: string; band: string };
  targetExam?: string;
  examDate?: string;
  daysLeft?: number;
  dailyMinutes?: number;
  /** 按 count 倒序的 Top-N 错因 */
  topErrors: ErrorRecord[];
  /** 写作风格 / 口音等自由文本偏好 */
  style: string[];
  /** 用户守则（rules/*.md 的合并结果），Agent 只读 */
  rules: string[];
}

/** 工具执行期间的黑板：M0 用共享袋传参，M1 换成显式参数槽绑定 */
export type Bag = Record<string, unknown>;
