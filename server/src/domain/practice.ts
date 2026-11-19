import type { DimensionId, PracticeKind } from './rubrics';

export interface PracticePrompt {
  kind: PracticeKind;
  formatLabel: string;
  taskType: string;
  title: string;
  /** 题干情境（考试语言） */
  scenario: string;
  stimulus?: { a: string; b: string };
  /** 具体任务要求（考试语言） */
  question: string;
  /** 中文构思提示 */
  hints: string[];
  /** 提交前自检清单 */
  checklist: string[];
  minutes: number;
  wordRange?: [number, number];
  prepSeconds?: number;
  responseSeconds?: number;
  dimensions: Array<{ id: DimensionId; name: string; weight: number; criteria: string }>;
  scale: { max: number; step: number; label: string; note: string };
  remarks: string[];
  source: 'llm' | 'library';
  model: string | null;
}

export interface GradeDimension {
  id: string;
  name: string;
  weight: number;
  /** 0–100 */
  score: number;
  comment: string;
}

export interface GradeIssue {
  /** 原文片段，可能为空（针对全篇的问题） */
  quote: string;
  /** 语法 / 用词 / 结构 / 论证 / 流利度 / 发音 */
  kind: string;
  problem: string;
  /** 改后的句子或替换写法 */
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

export interface GradeResult {
  overall: number;
  band: { value: number; max: number; label: string; note: string };
  dimensions: GradeDimension[];
  feedback: GradeFeedback;
  stats: GradeStats;
  source: 'llm' | 'heuristic';
  model: string | null;
  notice: string | null;
}

export type SubmissionSource = 'typed' | 'speech';

export interface PracticeAttempt extends GradeResult {
  id: string;
  dayId: string;
  taskId: string;
  kind: PracticeKind;
  promptTitle: string;
  submission: string;
  submissionSource: SubmissionSource;
  createdAt: string;
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
  /** 该次批改所属计划的语种：跨计划回看时用来标注 */
  language: string;
}
