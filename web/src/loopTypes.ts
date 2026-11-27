export type LoopCardKind = 'error' | 'sentence' | 'word';
export type LoopCardStatus = 'active' | 'suspended' | 'mastered';

export interface LoopCard {
  id: string;
  userId: string;
  documentId: string;
  artifactId: string;
  runId: string | null;
  lang: string;
  kind: LoopCardKind;
  front: string;
  back: string;
  context: string | null;
  ruleId: string | null;
  sourceRef: string | null;
  status: LoopCardStatus;
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  goodStreak: number;
  dueDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoopDocument {
  id: string;
  userId: string;
  lang: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  runId: string | null;
  createdAt: string;
  cardCount: number;
  activeCount: number;
}

export interface LoopArtifact {
  id: string;
  userId: string;
  runId: string;
  documentId: string;
  type: string;
  title: string;
  state: 'draft' | 'adopted' | 'dismissed';
  createdAt: string;
  adoptedAt: string | null;
  parentArtifactId: string | null;
  cardCount: number;
}

export interface LoopStats {
  closed: number;
  quality: number;
  retention: number;
  streak: number;
  due: number;
  reviewedToday: number;
}

export interface LoopToday {
  due: number;
  minutes: number;
  reviewedToday: number;
  cards: LoopCard[];
  recent: LoopArtifact[];
  stats: LoopStats;
}

export interface LoopCardPreview {
  kind: LoopCardKind;
  front: string;
  back: string;
  context?: string;
  ruleId?: string;
  sourceRef?: string;
}
