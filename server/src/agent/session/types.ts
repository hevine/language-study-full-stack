import type { AgentRun } from '../protocols';
import type { AgentRequest } from '../core';
import type { Bag, LangCode } from '../types';

export interface SessionTask {
  id: string;
  sceneId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  request: AgentRequest;
  result?: AgentRun;
  error?: string;
}

export interface SessionState {
  sessionId: string;
  userId: string;
  lang: LangCode;
  tasks: SessionTask[];
  sharedBag: Bag;
  startedAt: string;
}

export type SessionEvent =
  | { type: 'task-start'; taskId: string; scene: string; runId: string }
  | { type: 'task-step'; taskId: string; step: unknown }
  | { type: 'task-artifact'; taskId: string; artifact: unknown }
  | { type: 'task-verify'; taskId: string; report: unknown }
  | { type: 'task-done'; taskId: string; run: AgentRun }
  | { type: 'task-error'; taskId: string; message: string }
  | { type: 'task-clarify'; taskId: string; message: string; candidates: unknown[] }
  | { type: 'session-done'; sessionId: string }
  | { type: 'error'; message: string }
