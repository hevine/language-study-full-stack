/**
 * TaskPort 的进程内实现：把 Agent 产物挂回今日任务。
 *
 * 复用既有 plans 仓储，不新建表 —— 任务本来就存在 plan_days.tasks 这个 JSON 列里，
 * 产物是任务的附件，跟着任务一起读、一起备份、一起迁移，是最省事的形态。
 *
 * 拆分进程时，这个文件会换成一组 HTTP 调用；接口不变，调用方（routes / tools）不改。
 */
import { currentUserId } from '../../auth/requestScope';
import type { TaskKind } from '../../catalog/types';
import type { GeneratedDay, PlanRecord, Task } from '../../domain/types';
import { logger } from '../../lib/logger';
import { getActivePlan, getDayByDate, listDayContexts, saveDayTasks } from '../../repositories/plans';
import type { TaskPort } from '../ports';
import type { SceneCategory } from '../types';

/**
 * 垂类 → 任务种类，按优先级排列。
 *
 * 为什么需要这张表：用户可能只说了「帮我改改这篇作文」，没指定挂到哪条任务上。
 * 挂错位置比不挂更糟 —— 批改结果躺在背单词卡片里，用户会以为系统坏了。
 * 所以匹配不到就如实返回 attached=false，不硬塞。
 */
const CATEGORY_TO_KINDS: Record<SceneCategory, TaskKind[]> = {
  writing: ['write'],
  sentence: ['grammar', 'read'],
  grammar: ['grammar', 'write'],
  reading: ['read', 'listen'],
  speaking: ['speak'],
  vocab: ['vocab'],
  exam: ['mock', 'admin'],
  translation: ['write', 'grammar'],
  // 周边（文化 / 学习方法）没有对应的每日任务，只能挂在阅读上做延伸
  peripheral: ['read'],
};

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 找到某一天所属的计划。
 * 先试当前在跑的计划；找不到再跨计划回看 —— 用户可能正在补昨天的作业，
 * 那天的任务挂在上一份计划里。
 */
function resolveDay(userId: string, date: string): { plan: PlanRecord; day: GeneratedDay } | null {
  const active = getActivePlan(userId);
  if (active) {
    const day = getDayByDate(active.id, date);
    if (day) return { plan: active, day };
  }
  const contexts = listDayContexts(date, userId);
  return contexts[0] ?? null;
}

function pickTask(tasks: Task[], taskId?: string, category?: SceneCategory): Task | null {
  if (taskId) return tasks.find((task) => task.id === taskId) ?? null;
  if (!category) return null;
  for (const kind of CATEGORY_TO_KINDS[category] ?? []) {
    const hit = tasks.find((task) => task.kind === kind);
    if (hit) return hit;
  }
  return null;
}

export function createTaskPort(): TaskPort {
  return {
    async attachArtifact(input) {
      const date = input.date?.trim() || today();
      const userId = input.userId || currentUserId();

      const target = resolveDay(userId, date);
      if (!target) {
        return { attached: false, reason: `${date} 没有学习计划，先把计划建起来再挂产物` };
      }

      const { plan, day } = target;
      const task = pickTask(day.tasks, input.taskId, input.category);
      if (!task) {
        return {
          attached: false,
          reason: input.taskId
            ? `${date} 的任务里没有 ${input.taskId}`
            : `${date} 没有和这个场景对应的任务（今天的任务类型：${day.tasks.map((item) => item.kind).join('、') || '空'}）`,
        };
      }

      const existing = task.artifacts ?? [];
      // 幂等：同一份产物重复采纳（用户连点、网络重试）不应该产生两条记录
      const duplicate = existing.some((item) => item.artifactId === input.artifact.artifactId);
      if (duplicate) {
        return { attached: true, taskId: task.id, taskTitle: task.title, reason: '已挂载过，未重复写入' };
      }

      // 预览：落点算出来了，但一个字都不写
      if (input.dryRun) {
        return {
          attached: false,
          taskId: task.id,
          taskTitle: task.title,
          reason: `确认后会挂到「${task.title}」`,
        };
      }

      const ref = {
        artifactId: input.artifact.artifactId,
        type: input.artifact.type,
        title: input.artifact.title,
        scene: input.artifact.scene,
        runId: input.artifact.runId,
        createdAt: new Date().toISOString(),
      };

      const nextTasks = day.tasks.map((item) =>
        item.id === task.id ? { ...item, artifacts: [...existing, ref] } : item,
      );

      // 走 saveDayTasks 而不是自己 UPDATE：它顺带重算 day 的 pending/partial/done，
      // 直接写 tasks 列会让今日进度停在旧状态。
      saveDayTasks(day.id, nextTasks);

      logger.info('agent 产物已挂到任务', {
        planId: plan.id,
        dayId: day.id,
        taskId: task.id,
        artifactId: ref.artifactId,
        type: ref.type,
      });

      return { attached: true, taskId: task.id, taskTitle: task.title };
    },
  };
}
