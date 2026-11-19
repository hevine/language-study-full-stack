import type { Language, PhaseKey, TaskKind } from '../catalog/types';

export interface TaskRef {
  type: 'article' | 'vocab' | 'none';
  /** 文章类型：精读 / 泛读听力 */
  articleKind?: 'intensive' | 'extensive';
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
