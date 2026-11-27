/**
 * Session Orchestrator：在 runAgent 之上编排多任务。
 *
 * 一个 session 可包含多个不同场景的 task，按队列顺序执行。
 * sharedBag 跨 task 持久化——前序 task 的 profile.read 结果可以被后续 task 复用。
 *
 * 并发策略：同 session 内顺序执行（共享 bag + LLM token 预算）。
 * 不同 session 可并发。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger';
import type { AgentRuntime } from '../core';
import { runAgent, type AgentEvent } from '../core';
import { routeMulti } from '../core/router';
import type { Bag, LangCode } from '../types';
import type { SessionEvent, SessionState, SessionTask } from './types';

const sessions = new Map<string, SessionState>();

function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export class SessionOrchestrator {
  constructor(private runtime: AgentRuntime) {}

  createSession(userId: string, lang: LangCode): string {
    const sessionId = `sess_${randomUUID().slice(0, 12)}`;
    const state: SessionState = {
      sessionId,
      userId,
      lang,
      tasks: [],
      sharedBag: {},
      startedAt: new Date().toISOString(),
    };
    sessions.set(sessionId, state);
    logger.info('session created', { sessionId, userId, lang });
    return sessionId;
  }

  /** 将输入加入队列；routeMulti 可能产生多个 task */
  enqueue(sessionId: string, input: {
    query?: string;
    text?: string;
    mode?: 'ask' | 'craft' | 'coach';
    scene?: string;
    exam?: string;
    articleId?: string;
    helpLevel?: string;
    audioRef?: string;
  }): string[] {
    const state = sessions.get(sessionId);
    if (!state) throw new Error(`session ${sessionId} 不存在`);

    const mode = input.mode ?? 'craft';

    // 如果有 audioRef，强制走 speaking-practice
    if (input.audioRef) {
      const taskId = newTaskId();
      state.tasks.push({
        id: taskId,
        sceneId: 'speaking-practice',
        status: 'queued',
        request: {
          userId: state.userId,
          lang: state.lang,
          mode: mode as 'ask' | 'craft' | 'coach',
          text: input.audioRef,
          scene: 'speaking-practice',
          exam: input.exam,
        },
      });
      return [taskId];
    }

    // 显式指定场景时直接入队
    if (input.scene) {
      const taskId = newTaskId();
      state.tasks.push({
        id: taskId,
        sceneId: input.scene,
        status: 'queued',
        request: {
          userId: state.userId,
          lang: state.lang,
          mode: mode as 'ask' | 'craft' | 'coach',
          query: input.query,
          text: input.text,
          scene: input.scene,
          exam: input.exam,
          articleId: input.articleId,
          helpLevel: input.helpLevel as 'L0' | 'L1' | 'L2' | 'L3' | undefined,
        },
      });
      return [taskId];
    }

    // 多意图路由
    const matches = routeMulti(
      { query: input.query, text: input.text, mode },
      this.runtime.scenes,
    );

    if (matches.matches.length === 0) {
      // 无法路由时作为 clarify task
      const taskId = newTaskId();
      state.tasks.push({
        id: taskId,
        sceneId: '',
        status: 'queued',
        request: {
          userId: state.userId,
          lang: state.lang,
          mode: mode as 'ask' | 'craft' | 'coach',
          query: input.query,
          text: input.text,
        },
      });
      return [taskId];
    }

    const taskIds: string[] = [];
    for (const match of matches.matches) {
      const taskId = newTaskId();
      state.tasks.push({
        id: taskId,
        sceneId: match.scene.id,
        status: 'queued',
        request: {
          userId: state.userId,
          lang: state.lang,
          mode: mode as 'ask' | 'craft' | 'coach',
          query: input.query,
          text: input.text,
          scene: match.scene.id,
          exam: input.exam,
        },
      });
      taskIds.push(taskId);
    }
    return taskIds;
  }

  /** 按队列顺序执行所有 queued task */
  async *run(sessionId: string): AsyncGenerator<SessionEvent> {
    const state = sessions.get(sessionId);
    if (!state) {
      yield { type: 'error', message: `session ${sessionId} 不存在` };
      return;
    }

    for (const task of state.tasks) {
      if (task.status !== 'queued') continue;

      task.status = 'running';
      let currentBag: Bag = { ...state.sharedBag };

      try {
        for await (const event of runAgent(task.request, this.runtime, { initialBag: currentBag })) {
          const mapped = this.mapEvent(task.id, event);
          if (mapped) yield mapped;

          // 从 event 中提取 bag 更新
          if (event.type === 'done') {
            task.result = event.run;
            task.status = 'done';
            // 把 done 的 run 里的 contextDigest 合并进 sharedBag
            // 实际的 bag 数据无法从 event 中提取，但 profile.read 的结果已在 initialBag 里
          }
          if (event.type === 'error') {
            task.status = 'failed';
            task.error = event.message;
          }
          if (event.type === 'clarify') {
            // clarify 不算失败，但不继续执行
            task.status = 'done';
          }
        }
      } catch (err) {
        task.status = 'failed';
        task.error = (err as Error).message;
        yield { type: 'task-error', taskId: task.id, message: (err as Error).message };
      }

      // 合并 bag 到 sharedBag（profile.read 等共享数据）
      state.sharedBag = { ...state.sharedBag, ...currentBag };
    }

    yield { type: 'session-done', sessionId };
  }

  getTask(sessionId: string, taskId: string): SessionTask | undefined {
    const state = sessions.get(sessionId);
    return state?.tasks.find((t) => t.id === taskId);
  }

  getSession(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  }

  private mapEvent(taskId: string, event: AgentEvent): SessionEvent | null {
    switch (event.type) {
      case 'start':
        return { type: 'task-start', taskId, scene: event.scene, runId: event.runId };
      case 'step':
        return { type: 'task-step', taskId, step: event.step };
      case 'artifact':
        return { type: 'task-artifact', taskId, artifact: event.artifact };
      case 'verify':
        return { type: 'task-verify', taskId, report: event.report };
      case 'done':
        return { type: 'task-done', taskId, run: event.run };
      case 'clarify':
        return {
          type: 'task-clarify',
          taskId,
          message: event.message,
          candidates: event.candidates,
        };
      case 'error':
        return { type: 'task-error', taskId, message: event.message };
      default:
        return null;
    }
  }
}

export type { SessionEvent, SessionState, SessionTask };
