import type { Language, PhaseKey, TaskKind } from '../catalog/types';

export interface TaskRef {
  type: 'article' | 'vocab' | 'none';
  /** 文章类型：精读 / 泛读听力 */
  articleKind?: 'intensive' | 'extensive';
}

/**
 * Agent 产物挂载记录。
 *
 * 为什么挂在任务里而不是新开一张表：产物是任务的附件，不是独立实体。
 * 用户打开「今日任务」就该看到昨天的批改结果，多一张关联表只会让这个入口多一次 join。
 * type 用 string 而不是 ArtifactType：domain 层不该反向依赖 agent 层。
 */
export interface TaskArtifactRef {
  artifactId: string;
  /** annotated-diff / score-report / explain-video / syntax-tree … */
  type: string;
  title: string;
  /** 产出它的场景 id 与 run，供「这条批注是怎么来的」追溯 */
  scene: string;
  runId: string;
  createdAt: string;
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  minutes: number;
  done: boolean;
  /** 完成时记录得分（0–100），可为空 */
  score?: number;
  ref?: TaskRef;
  /**
   * Agent 产出的批注、报告、讲解视频。
   * 旧数据的 tasks JSON 里没有该字段，所有读取端必须按 `task.artifacts ?? []` 处理。
   */
  artifacts?: TaskArtifactRef[];
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

export interface ReadingSegment {
  text: string;
  translation?: string;
  tips?: string[];
}

export interface ArticlePayload {
  title: string;
  body: string;
  translation: string;
  vocab: VocabEntry[];
  questions: Question[];
  readingScript: { segments: ReadingSegment[] };
}

export interface DayPayload {
  intensive: ArticlePayload;
  extensive: ArticlePayload;
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

export type FeasibilityLevel = 'comfortable' | 'tight' | 'aggressive' | 'unrealistic';

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
  level: FeasibilityLevel;
  /** 0–1 的达标概率估计 */
  probability: number;
  recommendedWeeks: number;
  messages: string[];
  suggestions: string[];
  milestones: Milestone[];
}

export interface GeneratedDay {
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

export interface PlanRecord {
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
