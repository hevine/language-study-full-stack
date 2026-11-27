export type Language = 'en' | 'ja' | 'ko';
export type TaskKind =
  | 'vocab'
  | 'read'
  | 'speak'
  | 'listen'
  | 'write'
  | 'grammar'
  | 'mock'
  | 'review'
  | 'admin';
export type PhaseKey = 'foundation' | 'build' | 'sprint';

export interface CatalogSection {
  id: string;
  name: string;
  minutes: number;
  format: string;
}

export interface CatalogTarget {
  score: number;
  label: string;
  sections: Record<string, number>;
  vocabNeed: number;
  note?: string;
}

export interface CatalogExam {
  id: string;
  name: string;
  provider: string;
  scaleLabel: string;
  scaleNote?: string;
  sections: CatalogSection[];
  targets: CatalogTarget[];
  syllabus: string[];
}

export interface CatalogLevel {
  id: string;
  name: string;
  cefr: string;
  vocab: number;
  note?: string;
}

export interface CatalogLanguage {
  id: Language;
  name: string;
  nativeName: string;
  speechLang: string;
  levels: CatalogLevel[];
  exams: CatalogExam[];
}

export interface Catalog {
  languages: CatalogLanguage[];
  llm: { configured: boolean; baseUrl: string; model: string; source: string };
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  minutes: number;
  done: boolean;
  score?: number;
  ref?: { type: 'article' | 'vocab' | 'none'; articleKind?: 'intensive' | 'extensive' };
}

export interface VocabEntry {
  term: string;
  reading?: string;
  pos?: string;
  meaning: string;
  example?: string;
}

export interface Question {
  prompt: string;
  options: string[];
  answer: number;
  explain?: string;
}

/** 解题答疑视频（与 @waiyubaodian/explain-video 的 ExplainVideo 结构兼容） */
export interface ExplainVideoLike {
  id: string;
  articleId: string;
  language: 'en' | 'ja' | 'ko';
  narrationLanguage: 'target' | 'zh';
  voice: string;
  title: string;
  totalMs: number;
  shots: Array<{
    id: string;
    kind: string;
    narration: string;
    /** 中文讲师口播稿；有它才说明这条片带母语轨 */
    narrationZh?: string;
    caption: string;
    questionNo?: number;
    prompt?: string;
    options?: string[];
    highlight?: { paragraph?: number; sentence?: string; options?: number[]; picked?: number };
    grammar?: { sentence: string; structure: string; explanation: string; translation?: string };
    point?: { label: string; text: string };
    audio: {
      url: string;
      durationMs: number;
      boundaries?: Array<{ text: string; offsetMs: number; durationMs: number }>;
      /** 母语讲师轨；缺省表示只有目标语轨 */
      native?: { url: string; durationMs: number; boundaries?: Array<{ text: string; offsetMs: number; durationMs: number }> };
    };
  }>;
  cues: Array<{
    id: string;
    shotIndex: number;
    text: string;
    narration: string;
    startMs: number;
    endMs: number;
    edited?: boolean;
  }>;
  createdAt: string;
  updatedAt?: string;
  /** 讲师轨形态：target 只有目标语；bilingual 带中文讲师轨 */
  coach?: ExplainCoachMode;
  meta?: {
    model: string | null;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    scriptVersion: number;
    /** 生成时选的讲解深度（short/medium/long） */
    depth?: ExplainDepth;
    /** 教案档位（n5…n1 / toefl / cet …）：共享缓存按它隔离 */
    band?: string;
    /** 首个生成者 */
    ownerId?: string;
    /** 母语轨单独记账的 token */
    nativeUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    /** 重配音记录（只跑 TTS、不调大模型，所以不计 token） */
    revoice?: { at: string; voice: string; by: string };
    /** 脚本质量留痕：模型输出不干净时前端要如实提示，而不是假装一切正常 */
    quality?: { salvage: boolean; truncated: boolean; autoFilledShots: number };
  };
}

/** 讲师轨形态：目标语单轨 / 双向双语 */
export type ExplainCoachMode = 'target' | 'bilingual';

/**
 * 导出音轨：
 *  - target 原文音轨
 *  - native 中文讲师音轨
 *  - both   同一容器两条音轨（剪辑软件/播放器可切语言）
 */
export type ExplainExportTrack = 'target' | 'native' | 'both';

/** 历史讲解条目（含跨用户共享的片子） */
export interface ExplainVideoSummary {
  id: string;
  articleId: string;
  title: string;
  totalMs: number;
  createdAt: string;
  depth?: string;
  band?: string;
  coach?: string;
  shots: number;
  /** shared = 别人生成、你直接复用；personal = 你自己生成，或你在共享片基础上改过 */
  source: 'shared' | 'personal';
  mine: boolean;
  /** 共享片的个人副本（改过逐字稿或换过音色）：不是我的，但我改过 */
  revised?: boolean;
}

/** 讲解深度：短=每题3镜、中=5镜、长=6–7镜；影响时长与 token */
export type ExplainDepth = 'short' | 'medium' | 'long';

/** 服务端算好的单档预估（时长 / token / 是否已生成） */
export interface ExplainDepthEstimate {
  id: ExplainDepth;
  label: string;
  blurb: string;
  shots: number;
  /** 成片时长（秒） */
  secLow: number;
  secHigh: number;
  /** 生成等待（秒）：写脚本 + 配音 + 组装 */
  genSecLow: number;
  genSecHigh: number;
  tokenLow: number;
  tokenHigh: number;
  cached: boolean;
  videoId?: string;
  /** 缓存来自共享层还是自己的副本 */
  source?: 'shared' | 'personal';
  /** 已缓存的这条片是否带母语讲师轨 */
  hasNative?: boolean;
}

/** 三档预估 + 教案级别 + 补母语轨的单独成本 */
export interface ExplainEstimateResponse {
  depths: ExplainDepthEstimate[];
  level: { label: string; examLabel: string | null; band: string };
  /** 给已有视频补一条中文讲师轨的估算（不重跑脚本，只转述 + 配音） */
  nativeCost: { tokenLow: number; tokenHigh: number; minutesLow: number; minutesHigh: number };
}

export interface ReadingSegment {
  text: string;
  translation?: string | null;
  tips?: string[];
}

export interface Article {
  id: string;
  kind: 'intensive' | 'extensive';
  title: string;
  body: string;
  translation: string;
  vocab: VocabEntry[];
  questions: Question[];
  readingScript: { segments: ReadingSegment[] };
  estMinutes: number;
  source: 'llm' | 'library';
  model: string | null;
}

export interface Day {
  id: string;
  date: string;
  weekIndex: number;
  dayIndex: number;
  phase: PhaseKey;
  phaseName: string;
  theme: string;
  focus: string[];
  tasks: Task[];
  status: 'pending' | 'partial' | 'done';
}

export interface SectionTarget {
  id: string;
  name: string;
  from: number;
  target: number;
}

export interface RoadmapPhase {
  key: PhaseKey;
  name: string;
  startWeek: number;
  endWeek: number;
  goal: string;
  focus: string[];
}

export interface Roadmap {
  totalWeeks: number;
  totalHours: number;
  weeklyHours: number;
  dailyMinutes: number;
  vocabGap: number;
  newWordsPerDay: number;
  sectionTargets: SectionTarget[];
  phases: RoadmapPhase[];
  syllabus: string[];
}

export interface Milestone {
  label: string;
  weeks: number;
  detail: string;
}

export interface Feasibility {
  availableHours: number;
  effectiveHours: number;
  requiredHours: number;
  ratio: number;
  level: 'comfortable' | 'tight' | 'aggressive' | 'unrealistic';
  probability: number;
  recommendedWeeks: number;
  messages: string[];
  suggestions: string[];
  milestones: Milestone[];
}

export interface Plan {
  id: string;
  language: Language;
  examId: string;
  examName: string;
  currentLevelId: string;
  currentLevelName: string;
  targetScore: number;
  targetLabel: string;
  startDate: string;
  examDate: string;
  weeks: number;
  hoursPerWeek: number;
  dailyMinutes: number;
  status: string;
  feasibility: Feasibility;
  roadmap: Roadmap;
  createdAt: string;
}

export interface DaySummary {
  id: string;
  date: string;
  weekIndex: number;
  dayIndex: number;
  phase: PhaseKey;
  phaseName: string;
  theme: string;
  focus: string[];
  status: 'pending' | 'partial' | 'done';
  taskCount: number;
  doneCount: number;
  totalMinutes: number;
}

export interface ActivePlanResponse {
  plan: Plan | null;
  progress?: { total: number; done: number; partial: number };
  days?: DaySummary[];
}

export interface DayResponse {
  day: Day;
  articles: Article[];
  source: 'llm' | 'library' | 'cached';
  notice: string | null;
  plan: { id: string; language: Language; examName: string; targetLabel: string; phaseName: string };
}

export interface Stats {
  streak: number;
  totalMinutes: number;
  activeDays: number;
  vocabulary: { total: number; due: number; mastered: number };
  activity: Array<{ date: string; minutes: number; tasks: number }>;
  practice: PracticeStats;
  plan: null | {
    id: string;
    examName: string;
    targetLabel: string;
    daysLeft: number;
    totalDays: number;
    completionRate: number;
    doneDays: number;
    totalPlanDays: number;
    readiness: number;
    feasibilityLevel: string;
    phaseName: string | null;
  };
}

export interface VocabWord {
  id: string;
  language: string;
  term: string;
  reading: string | null;
  pos: string | null;
  meaning: string;
  example: string | null;
  exampleCn: string | null;
  mnemonic: string | null;
  theme: string | null;
  level: string | null;
  syn: string[];
  source: string | null;
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  dueDate: string;
}

/* ---------- 分级词库 ---------- */

export interface LexLevel {
  id: string;
  name: string;
  short: string;
  description: string;
  /** 本库该级别收录量 */
  total: number;
  inBook: number;
  due: number;
  mastered: number;
}

export interface LexWord {
  term: string;
  reading: string | null;
  pos: string;
  cn: string;
  mnemonic: string;
  example: string;
  exampleCn: string;
  syn: string[];
  theme: string;
  level: string;
  inBook: boolean;
  /** 分级词表字段：编码、词形变化、近义/反义/派生、频段；精讲词可能没有 */
  code?: string;
  forms?: string;
  relations?: string;
  band?: string;
  /** 来自分级词表、中文释义与例句尚待补充 */
  pending?: boolean;
}

export interface LexiconResponse {
  language: string;
  source: string;
  planLevelId: string | null;
  levels: LexLevel[];
  words: LexWord[];
  stats: { total: number; due: number; mastered: number };
}

/** 内置语法库的一个级别档：id 是该语种刻度（A2 / N5 / 3），label 是教研原始写法（T1/A2 / N5 / TOPIK 1） */
export interface GrammarLevel {
  id: string;
  label: string;
  short: string;
  total: number;
  catalogLevels: Array<{ id: string; name: string }>;
}

export interface GrammarPoint {
  ref: string;
  code: string;
  name: string;
  level: string;
  levelLabel: string;
  structure: string;
  meaning: string;
  synonym: string;
  example: string;
  translation: string;
  note: string;
  errorRule: { ref: string; code: string; name: string } | null;
}

/** 错因规则：一种典型错误的触发 / 表现 / 判定，可被多个语法点共用 */
export interface GrammarRule {
  ref: string;
  code: string;
  name: string;
  trigger: string;
  symptom: string;
  judgement: string;
  pointCount: number;
  pointRefs: string[];
}

export interface GrammarLibraryResponse {
  language: string;
  source: string;
  examId: string;
  examName: string;
  levels: GrammarLevel[];
  /** 已按级别 / 搜索筛选过的语法点 */
  points: GrammarPoint[];
  /** 已按搜索筛选过的错因规则 */
  rules: GrammarRule[];
  stats: {
    points: number;
    rules: number;
    linkedPoints: number;
    linkedRules: number;
    /** 图谱里还没有这个语种的语法节点 */
    seeded: boolean;
  };
}

export interface LlmModelOption {
  id: string;
  label: string;
  note?: string;
  free?: boolean;
}

export interface LlmProviderOption {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  defaultModel: string;
  models: LlmModelOption[];
  freeNote: string;
  applyUrl: string;
  applyLabel: string;
  keyHint: string;
  jsonMode: boolean;
}

export type LlmKeyStatus = 'ready' | 'cooling' | 'exhausted' | 'invalid' | 'unset';

export interface LlmPoolKey {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  baseUrl: string;
  model: string;
  /** 掩码，形如 sk-••••abcd；服务端从不回传明文 */
  maskedKey: string;
  fingerprint: string;
  /** false = 只放内存，重启后需要重填 */
  persist: boolean;
  enabled: boolean;
  priority: number;
  status: LlmKeyStatus;
  cooldownUntil: string | null;
  cooldownSeconds: number;
  failCount: number;
  successCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastUsedAt: string | null;
  needsKey: boolean;
  source: 'db' | 'env';
  jsonMode: boolean;
}

export interface LlmPoolSummary {
  total: number;
  enabled: number;
  ready: number;
  cooling: number;
  needsKey: number;
  activeLabel: string | null;
  activeModel: string | null;
}

/** 语音识别号池里的一条线路；maskedKey 永远是掩码 */
export interface AsrPoolKey {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  maskedKey: string;
  fingerprint: string;
  persist: boolean;
  enabled: boolean;
  priority: number;
  status: LlmKeyStatus;
  cooldownUntil: string | null;
  cooldownSeconds: number;
  failCount: number;
  successCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastUsedAt: string | null;
  needsKey: boolean;
  source: 'db' | 'env';
}

/** 语音识别（录音转写）号池视图 */
export interface AsrSettingsView {
  configured: boolean;
  source: 'env' | 'pool' | 'none';
  suggestion: { baseUrl: string; model: string; note: string };
  keys: AsrPoolKey[];
  summary: LlmPoolSummary;
}

/** 本地兜底 ASR 服务（SenseVoiceSmall）的实时状态 */
export interface LocalAsrStatus {
  /** venv 与模型是否已装好 */
  installed: boolean;
  baseUrl: string;
  running: boolean;
  /** 模型此刻是否驻留内存 */
  loaded: boolean;
  loading: boolean;
  model: string | null;
  device: string | null;
  idleUnloadSec: number | null;
  idleSec: number | null;
  uptimeSec: number | null;
  loadMs: number | null;
  total: number;
  failed: number;
  last: {
    atMs: number;
    elapsedMs: number;
    language: string;
    chars: number;
    bytes: number;
    coldStart: boolean;
  } | null;
  error: string | null;
  checkedAt: number;
}

/** 线路连通测试结果 */
export interface AsrPingResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  status?: number;
  snippet?: string;
  text?: string;
}

/** POST /asr 的识别结果 */
export interface TranscribeResult {
  text: string;
  language: Language;
  model: string;
  source: AsrSettingsView['source'];
  line: string;
}

export interface SettingsResponse {
  profile: { userId: string; displayName: string; goalNote: string | null };
  asr: AsrSettingsView;
  llm: {
    configured: boolean;
    availableNow: number;
    summary: LlmPoolSummary;
    baseUrl: string;
    model: string;
    source: string;
    apiKeyMasked: string;
    providerId: string | null;
    providerName: string;
    jsonMode: boolean;
    storage: {
      encrypted: boolean;
      algorithm: string;
      masterKeySource: 'env' | 'file' | 'generated';
      masterKeyPath: string;
      dataDir: string;
      dbFile: string;
      envKeyActive: boolean;
    };
    providers: LlmProviderOption[];
    keys: LlmPoolKey[];
  };
}

/* ---------- 写作 / 口语批改 ---------- */

export type PracticeKind = 'write' | 'speak';

export interface PracticePrompt {
  /** 出题时所用的语种：后端据此判断旧题是否作废 */
  language?: Language;
  kind: PracticeKind;
  formatLabel: string;
  taskType: string;
  title: string;
  scenario: string;
  stimulus?: { a: string; b: string };
  question: string;
  hints: string[];
  checklist: string[];
  minutes: number;
  wordRange?: [number, number];
  prepSeconds?: number;
  responseSeconds?: number;
  dimensions: Array<{ id: string; name: string; weight: number; criteria: string }>;
  scale: { max: number; step: number; label: string; note: string };
  remarks: string[];
  source: 'llm' | 'library';
  model: string | null;
}

export interface GradeDimension {
  id: string;
  name: string;
  weight: number;
  score: number;
  comment: string;
}

export interface GradeIssue {
  quote: string;
  kind: string;
  problem: string;
  fix: string;
  reason: string;
}

export interface GradeFeedback {
  verdict: string;
  strengths: string[];
  issues: GradeIssue[];
  rewrite: { text: string; note: string } | null;
  upgrades: Array<{ from: string; to: string; note: string }>;
  drills: string[];
}

export interface GradeStats {
  unit: 'words' | 'chars';
  length: number;
  sentences: number;
  paragraphs: number;
  avgSentence: number;
  uniqueRatio: number;
  fillerCount: number;
  durationSeconds: number | null;
  wpm: number | null;
  targetMin: number | null;
}

export interface PracticeAttempt {
  id: string;
  dayId: string;
  taskId: string;
  kind: PracticeKind;
  promptTitle: string;
  submission: string;
  submissionSource: 'typed' | 'speech';
  overall: number;
  band: { value: number; max: number; label: string; note: string };
  dimensions: GradeDimension[];
  feedback: GradeFeedback;
  stats: GradeStats;
  source: 'llm' | 'heuristic';
  model: string | null;
  createdAt: string;
  notice: string | null;
}

export interface PracticeTaskBrief {
  taskId: string;
  kind: PracticeKind;
  title: string;
  minutes: number;
  done: boolean;
  score: number | null;
  attemptCount: number;
  best: number | null;
  last: { overall: number; bandLabel: string; createdAt: string } | null;
}

export interface AttemptSummary {
  id: string;
  dayId: string;
  taskId: string;
  kind: PracticeKind;
  promptTitle: string;
  overall: number;
  bandLabel: string;
  bandValue: number;
  source: 'llm' | 'heuristic';
  createdAt: string;
  date: string;
  /** 该次批改所属计划的语种，跨计划回看时用于标注 */
  language?: Language;
}

export interface PracticeStats {
  attempts: number;
  lastOverall: number | null;
  avgOverall: number | null;
  write: { attempts: number; avg: number | null };
  speak: { attempts: number; avg: number | null };
  trend: Array<{ date: string; overall: number; bandLabel: string; kind: PracticeKind; title: string }>;
}

export interface PracticeBriefResponse {
  task: {
    id: string;
    kind: PracticeKind;
    title: string;
    detail: string;
    minutes: number;
    done: boolean;
    score: number | null;
  };
  prompt: PracticePrompt;
  attempts: PracticeAttempt[];
  notice: string | null;
  date: string;
  language: Language;
  examName: string;
  targetLabel: string;
  /** 该日期不在当前计划范围内（来自历史计划 / 旧日期），只做回看 */
  historical?: boolean;
  planStartDate?: string;
  planExamDate?: string;
}

export interface PracticeOverview {
  date: string;
  tasks: PracticeTaskBrief[];
  pending: number;
  hasDay: boolean;
  attempts: AttemptSummary[];
  summary: PracticeStats;
}

export interface GradeResponse {
  attempt: PracticeAttempt;
  day: Day;
  attempts: PracticeAttempt[];
  summary: PracticeStats;
}


/* ---------- 任务完成页 ---------- */

export interface TaskWord {
  id: string | null;
  term: string;
  ipa: string | null;
  reading: string | null;
  pos: string | null;
  cn: string;
  mnemonic: string;
  example: string | null;
  exampleCn: string | null;
  syn: string[];
  theme: string;
  tier: 'basic' | 'core' | 'advanced' | null;
  level: string | null;
  levelName: string | null;
  /** 当前计划级别之外的进阶词（日语 N3 计划里混入的 N2 词） */
  stretch: boolean;
  /** true = 到期复习词（词汇本里已学过、今天回炉），不在「今日新词」里计数 */
  review?: boolean;
}

export type TaskDetail =
  | {
      kind: 'vocab';
      payload: {
        words: TaskWord[];
        /** 本次新学词量（与任务标题里的数字一致） */
        newCount?: number;
        /** 计划承诺的每日新词量 */
        newTarget?: number;
        /** 词库见底时的说明；正常为空 */
        shortNote?: string;
        /** 本次安排的到期复习词量 */
        reviewCount?: number;
        /** 词汇本里到期复习词的总数（可能大于本次安排量） */
        dueCount?: number;
        source: string;
        levelName: string;
        targetLabel: string;
        tierNote: string;
      };
    }
  | {
      kind: 'reading';
      payload: {
        mode: 'read' | 'listen' | 'speak';
        article: Article;
        secondary: Article | null;
        notice: string | null;
      };
    }
  | {
      kind: 'grammar';
      payload: {
        sentences: Array<{ text: string; translation: string | null; tips: string[] }>;
        note: string;
      };
    }
  | { kind: 'practice'; payload: { path: string; note: string } }
  | {
      kind: 'review';
      payload: { tasks: Task[]; theme: string; focus: string[]; advice: string[] };
    }
  | { kind: 'admin'; payload: AdminPayload };

/* ---------- 报考日历 ---------- */

export interface ExamEvent {
  id: string;
  offsetDays: number;
  date: string;
  title: string;
  tag: string;
  what: string;
  tips: string[];
  url: string | null;
  isTask: boolean;
  taskMinutes: number;
}

export interface ExamFee {
  item: string;
  amount: string;
  note: string;
}

export interface ExamLink {
  label: string;
  url: string;
  note: string;
}

export interface ExamCalendar {
  examId: string;
  examName: string;
  examDate: string;
  scheduleNote: string;
  events: ExamEvent[];
  fees: ExamFee[];
  feesNote: string;
  links: ExamLink[];
  planId?: string;
}

/* ---------- 真实考试场次 ---------- */

export interface ExamSession {
  id: string;
  examId: string;
  examName: string;
  date: string;
  year: number;
  month: number;
  weekday: string;
  dateLabel: string;
  roundLabel: string;
  daysAhead: number;
  weeksAhead: number;
  estimated: boolean;
  note: string;
}

export interface ExamSessionsResponse {
  examId: string;
  examName: string;
  scheduleNote: string;
  links: ExamLink[];
  sessions: ExamSession[];
}

export interface AdminPayload {
  event: ExamEvent;
  calendar: ExamCalendar;
  eventDate: string;
  planExamDate: string;
}

export interface TaskDetailResponse {
  date: string;
  task: Task;
  day: Day;
  plan: {
    language: Language;
    examId: string;
    examName: string;
    targetLabel: string;
    targetScore: number;
    currentLevelName: string;
  };
  detail: TaskDetail;
}

/* ---------- 学习之路 ---------- */

export type PathStepStatus = 'done' | 'current' | 'next' | 'future';

export interface PathStep {
  levelId: string;
  index: number;
  levelName: string;
  cefr: string;
  targetLabel: string;
  vocab: number;
  vocabGain: number;
  hours: number;
  weeks: number;
  weeklyVocab: number;
  passLine: string;
  examShape: string;
  focus: string[];
  method: string[];
  pitfalls: string[];
  checkpoint: string;
  motto: string;
  status: PathStepStatus;
}

export interface LearningPath {
  language: Language;
  languageName: string;
  nativeName: string;
  headline: string;
  intro: string;
  note: string;
  weeklyHours: number;
  currentIndex: number;
  steps: PathStep[];
  plan: null | {
    id: string;
    targetLabel: string;
    currentLevelName: string;
    weeks: number;
    dailyMinutes: number;
    examDate: string;
    daysLeft: number;
    completionRate: number;
    isActive: boolean;
  };
}


/** 听力库条目：音频本体在服务端 DATA_DIR/listening/<user>/，这里只是元数据 */
export interface ListeningMaterial {
  id: string;
  language: Language;
  title: string;
  fileName: string;
  fileSize: number;
  mime: string;
  ext: string;
  durationSec: number;
  note: string | null;
  createdAt: string;
}

export interface ListeningMaterialsResponse {
  materials: ListeningMaterial[];
}

export interface ListeningMaterialUploadResponse {
  material: ListeningMaterial;
}

export interface MaterialSummary {
  id: string;
  language: Language;
  title: string;
  format: string;
  fileName: string;
  fileSize: number;
  unitCount: number;
  wordCount: number;
  charCount: number;
  status: string;
  note: string | null;
  /** 对应考纲级别（n5–n1 / ko1–ko6 / basic…），未分级为 null */
  level: string | null;
  /** textbook 教科书 · vocab 词表包 · grammar 语法书 · notes 参考资料 */
  kind: 'textbook' | 'vocab' | 'grammar' | 'notes';
  origin: string;
  createdAt: string;
  active: boolean;
}

export interface MaterialsResponse {
  materials: MaterialSummary[];
  activeId: string | null;
}

export interface MaterialUploadResponse {
  material: MaterialSummary;
  active: boolean;
  preview: {
    units: Array<{ idx: number; title: string; charCount: number; pageFrom: number | null }>;
    words: Array<{ term: string; reading: string | null; meaning: string | null; unitIdx: number }>;
    inLexicon: number;
  };
}

/* ---------- AI 加练（按任务生成，落本地题库） ---------- */

export interface AiQuizItem {
  type: 'quiz';
  prompt: string;
  options: string[];
  answer: number;
  explain: string;
}

export interface AiWordItem {
  type: 'word';
  term: string;
  reading: string;
  pos: string;
  meaning: string;
  example: string;
  exampleCn: string;
}

export interface AiSentenceItem {
  type: 'sentence';
  text: string;
  translation: string;
  tips: string[];
}

export interface AiPromptItem {
  type: 'prompt';
  title: string;
  scenario: string;
  outline: string[];
  phrases: string[];
  sample: string;
}

export type AiItem = AiQuizItem | AiWordItem | AiSentenceItem | AiPromptItem;

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiGenerateResponse {
  cached: boolean;
  runId: string;
  language: string;
  kind: string;
  topic: string;
  model: string;
  provider: string;
  /** 本次真实消耗；命中 5 分钟缓存时全为 0 */
  usage: AiUsage;
  /** 命中缓存时省下的 token */
  savedTokens: number;
  latencyMs: number;
  itemCount: number;
  newCount: number;
  duplicateCount: number;
  /** 返回格式歪了、靠本地修复/字段抢救才救回来 */
  repaired?: boolean;
  /** 抢救后仍丢弃的条数 */
  dropped?: number;
  items: AiItem[];
  note: string | null;
  createdAt: string;
  taskKind: string;
  taskTitle: string;
}

export interface AiBankItem {
  id: string;
  language: string;
  kind: string;
  levelId: string;
  topic: string;
  itemType: AiItem['type'];
  payload: AiItem;
  model: string | null;
  provider: string | null;
  createdAt: string;
}

export interface AiStats {
  today: { runs: number; tokens: number; items: number };
  total: { runs: number; tokens: number; items: number };
  byModel: Array<{ model: string; provider: string | null; runs: number; tokens: number }>;
  ready: boolean;
  activeModel: string;
  activeProvider: string;
}

/* ---------------- 升级自测（完整分项卷） ---------------- */

export type ExamSectionKey = 'listening' | 'vocab' | 'grammar' | 'reading' | 'writing';
export type ExamPaperType = 'real' | 'mock' | 'ai';
/** 科目：笔答与听力分开计时 */
export type ExamStage = 'written' | 'oral';
/** 答案来源 */
export type ExamAnswerSource = 'key' | 'explain' | 'solve' | 'none';

export interface ExamSectionPlan {
  key: ExamSectionKey;
  label: string;
  count: number;
  minutes: number;
  /** 原卷大题号（問題N） */
  no?: number;
  stage?: ExamStage;
}

export interface ExamPaper {
  id: string;
  language: Language;
  year: number;
  examName: string;
  levelLabel: string;
  title: string;
  paperType: ExamPaperType;
  sourceNote: string;
  originUrl: string;
  durationMin: number;
  sortIdx: number;
  sections: ExamSectionPlan[];
  /** 从设置页导入的卷子才有：原始文件名与解析元信息 */
  importFile?: string;
  importMeta?: ExamImportMeta;
}

export interface ExamImportMeta {
  ocr?: boolean;
  pages?: number;
  chars?: number;
  model?: string | null;
  warnings?: string[];
  importedAt?: string;
  hasAnswerKey?: boolean;
  answerStats?: { fromKey: number; fromExplain: number; fromSolve: number };
  coverage?: Array<{ label: string; no: number; count: number; answerKey: number; missing: number }>;
}

export type ExamImportStage = 'read' | 'ocr' | 'structure' | 'save' | 'done';

export interface ExamImportResult {
  paperId: string;
  title: string;
  year: number;
  itemCount: number;
  choiceCount: number;
  writingCount: number;
  sections: string[];
  durationMin: number;
  ocr: boolean;
  pages: number;
  chars: number;
  model: string | null;
  skipped: number;
  blocks?: number;
  answerStats?: { fromKey: number; fromExplain: number; fromSolve: number };
}

export interface ExamImportJob {
  id: string;
  language: Language;
  fileName: string;
  status: 'running' | 'done' | 'error';
  stage: ExamImportStage;
  percent: number;
  message: string;
  detail: string;
  warnings: string[];
  startedAt: string;
  finishedAt?: string;
  result?: ExamImportResult;
  error?: string;
}

export interface ExamPaperSummary extends Omit<ExamPaper, 'sections'> {
  itemCount: number;
  /** 分项名，按卷内顺序 */
  sections: string[];
  hasListening: boolean;
  hasWriting: boolean;
  attemptCount: number;
  bestCorrect: number | null;
  bestPercent: number | null;
  lastAttemptAt: string | null;
}

export interface ExamItem {
  id: string;
  idx: number;
  section: string;
  sectionKey: ExamSectionKey;
  /** 原卷大题号（問題N）；0 表示老卷子没记 */
  questionNo: number;
  kind: 'choice' | 'writing';
  stem: string;
  passage: string;
  /** 听力朗读稿：作答时只播放、不显示 */
  audioText: string;
  audioUrl: string;
  options: string[];
  minWords: number;
}

export interface ExamItemDetail extends ExamItem {
  answer: number;
  /** 答案来源：原卷 / 据解析推导 / 模型作答 */
  answerSource: ExamAnswerSource;
  chosen: number | null;
  /** 写作题的作答原文 */
  text: string;
  correct: boolean;
  explanation: string;
  sampleAnswer: string;
}

export interface ExamAttempt {
  id: string;
  paperId: string;
  language: Language;
  startedAt: string;
  submittedAt: string | null;
  seconds: number;
  answers: Array<number | null>;
  writing: Record<string, string>;
  correct: number;
  total: number;
  status: 'active' | 'done';
}

export interface ExamAttemptSummary extends ExamAttempt {
  paperTitle: string;
  paperYear: number;
  examName: string;
  levelLabel: string;
  paperType: ExamPaperType;
}

export interface ExamScore {
  correct: number;
  total: number;
  percent: number;
}

export interface ExamResultResponse {
  attempt: ExamAttempt;
  paper: ExamPaper;
  details: ExamItemDetail[];
  score: ExamScore;
}

/* ───────────────────────── 音色系统 ───────────────────────── */

export type VoiceScene = 'word' | 'sentence' | 'article' | 'listening';
export type VoiceProvider = 'browser' | 'cloud';
export type VoiceSource = 'system' | 'preset' | 'ai' | 'custom';

/** 应用音色库里的一条音色（后端不会回传明文 Key） */
/** 本地 Edge Neural 引擎自检结果 */
export interface EdgeTtsStatus {
  available: boolean;
  python: string;
  version: string | null;
  hint: string;
}

export interface VoiceItem {
  id: string;
  language: Language;
  name: string;
  provider: VoiceProvider;
  engineVoice: string;
  matchHint: string;
  model: string;
  baseUrl: string;
  voiceId: string;
  style: string;
  persona: string;
  tags: string[];
  rate: number;
  pitch: number;
  volume: number;
  source: VoiceSource;
  isDefault: boolean;
  hasKey: boolean;
  maskedKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoicePreset {
  key: string;
  name: string;
  provider: VoiceProvider;
  engineVoice: string;
  matchHint: string;
  model: string;
  baseUrl: string;
  voiceId: string;
  style: string;
  persona: string;
  tags: string[];
  rate: number;
  pitch: number;
  volume: number;
  source: VoiceSource;
  highlight?: boolean;
}

export type VoiceAssignmentMap = Record<VoiceScene, string | null>;

export interface VoicePrefs {
  sampleText: string;
  globalRate: number;
}

export interface VoicesResponse {
  language: Language;
  bcp47: string;
  voices: VoiceItem[];
  assignments: VoiceAssignmentMap;
  prefs: VoicePrefs;
  scenes: Array<{ id: VoiceScene; label: string }>;
  presets: VoicePreset[];
}

/** 大模型 / 内置目录给出的候选，勾选后才落库 */
export interface VoiceCandidate {
  key: string;
  name: string;
  persona: string;
  provider: VoiceProvider;
  matchHint: string;
  voiceId: string;
  model: string;
  style: string;
  tags: string[];
  rate: number;
}

export interface VoiceDiscoverResponse {
  items: VoiceCandidate[];
  source: 'ai' | 'builtin';
  notice: string | null;
  model: string | null;
}

// ---------------------------------------------------------------- 用户与鉴权

export type AuthRole = 'admin' | 'user' | 'student' | 'teacher';
export type PublicRegisterRole = 'student' | 'teacher';
export type JlptLevel = 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
export type UserStatus = 'active' | 'pending' | 'disabled';
export type AuthProviderId = 'wechat' | 'dingtalk';

export interface AuthUser {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: AuthRole;
  status: UserStatus;
  providerHint: string | null;
  jlptLevel: JlptLevel | null;
  email: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  identities: Array<{ provider: AuthProviderId; displayName: string | null }>;
}

export interface RegisterInput {
  username: string;
  password: string;
  displayName?: string;
  role?: PublicRegisterRole;
  jlptLevel?: JlptLevel;
}

export type RegisterResponse = TokenResponse | { pending: true; user: AuthUser };

export interface ClaimTableCount {
  table: string;
  count: number;
}

export interface AuthProviderInfo {
  id: AuthProviderId;
  label: string;
  enabled: boolean;
  redirectUri: string;
  hint: string;
}

export interface AuthConfig {
  required: boolean;
  guestAllowed: boolean;
  passwordEnabled: boolean;
  allowRegister: boolean;
  newUserStatus: 'active' | 'pending';
  providers: AuthProviderInfo[];
  publicBaseUrl: string;
  accessTtlSec: number;
  user: AuthUser | null;
  guestUserId: string;
}

/** 登录成功响应：accessToken 只进内存，refreshToken 只在 HttpOnly Cookie 里 */
export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

export interface QrStartResponse {
  ticketId: string;
  ticketSecret: string;
  provider: AuthProviderId;
  authorizeUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
}

export interface QrPollResponse {
  status: 'pending' | 'confirmed' | 'failed' | 'expired' | 'consumed';
  provider: AuthProviderId;
  expiresAt: string;
  message: string | null;
}

export interface AuthSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** 新建 / 编辑音色的表单数据；apiKey 只在提交时带，服务端返回体永远不含明文 */
export interface VoiceDraft {
  language?: Language;
  name: string;
  provider: VoiceProvider;
  engineVoice: string;
  matchHint: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  voiceId: string;
  style: string;
  persona: string;
  tags: string[];
  rate: number;
  pitch: number;
  volume: number;
  source: VoiceSource;
}
