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

export interface LevelDef {
  id: string;
  name: string;
  cefr: string;
  /** 估算词汇量 */
  vocab: number;
  /** 从零到该级别累计学习小时（用于可行性测算） */
  hoursFromZero: number;
  /** 在该考试上的等效分数 */
  equiv: Record<string, number>;
  note?: string;
}

export interface ScoreTarget {
  score: number;
  label: string;
  /** 各单项目标分 */
  sections: Record<string, number>;
  /** 达标所需词汇量 */
  vocabNeed: number;
  note?: string;
}

export interface ExamSection {
  id: string;
  name: string;
  minutes: number;
  format: string;
}

export interface PhaseDef {
  key: PhaseKey;
  name: string;
  /** 起始进度比例 0~1 */
  startRatio: number;
  /** 阶段一句话目标 */
  goal: string;
  focus: string[];
  mix: Partial<Record<TaskKind, number>>;
}

export interface HoursModel {
  /** 默认按分差换算：1 分 ≈ N 小时 */
  mode: 'perPoint' | 'levelHours';
  perPoint: number;
}

export interface ExamDef {
  id: string;
  language: Language;
  name: string;
  provider: string;
  /** 分数单位说明，例如 “0–120 分” */
  scaleLabel: string;
  scaleNote?: string;
  sections: ExamSection[];
  targets: ScoreTarget[];
  syllabus: string[];
  topicPool: string[];
  hoursModel: HoursModel;
  phases: PhaseDef[];
  /** 每日产出材料偏好的文本长度（词/字） */
  textLength: { intensive: number; extensive: number };
}
