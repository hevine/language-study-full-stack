import type { Artifact, AgentRun } from '../agent/protocols';

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

export interface DerivedCard {
  kind: LoopCardKind;
  front: string;
  back: string;
  context?: string;
  ruleId?: string;
  sourceRef?: string;
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

export interface AdoptLoopResult {
  preview: DerivedCard[];
  created: number;
}

export function documentKindForScene(scene: string): 'essay' | 'sentence' | 'note' {
  if (scene.startsWith('writing')) return 'essay';
  if (scene.startsWith('sentence')) return 'sentence';
  return 'note';
}

export function sceneOf(run: AgentRun): string {
  return run.scene.split('@')[0] ?? run.scene;
}

export type { Artifact, AgentRun };
