import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError } from '../lib/errors';
import { getActivePlan, getDayByDate, saveDayTasks } from '../repositories/plans';
import { logStudy, removeTaskLogs } from '../repositories/misc';
import { ensureDayContent } from '../services/content';
import { ensureExamTasks } from '../services/examTasks';
import { todayISO } from '../lib/date';
import { assertRequestLanguage } from '../lib/languageGuard';

export const daysRouter = Router();

const TaskUpdate = z.object({
  done: z.boolean(),
  minutes: z.number().min(0).max(600).optional(),
  score: z.number().min(0).max(100).optional(),
});

daysRouter.get(
  '/days/:date',
  asyncHandler(async (req, res) => {
    const plan = getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划，请先创建计划');
    // 切换语种后仍在路上的旧请求会被这里挡住，不返回错语种内容
    assertRequestLanguage(plan, req.query.language);

    const date = req.params.date === 'today' ? todayISO() : req.params.date;
    const raw = getDayByDate(plan.id, date);
    if (!raw) throw new NotFoundError('该日期不在当前计划范围内');
    const day = ensureExamTasks(plan, raw);

    if (req.query.brief === '1') {
      res.json({
        day,
        articles: [],
        source: 'cached',
        notice: null,
        plan: {
          id: plan.id,
          language: plan.language,
          examName: plan.examName,
          targetLabel: plan.targetLabel,
          phaseName: day.phaseName,
        },
      });
      return;
    }

    const content = await ensureDayContent(plan, day);

    res.json({
      day,
      articles: content.articles,
      source: content.source,
      notice: content.notice,
      plan: {
        id: plan.id,
        language: plan.language,
        examName: plan.examName,
        targetLabel: plan.targetLabel,
        phaseName: day.phaseName,
      },
    });
  }),
);

daysRouter.post(
  '/days/:date/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const plan = getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划');

    const date = req.params.date === 'today' ? todayISO() : req.params.date;
    const raw = getDayByDate(plan.id, date);
    if (!raw) throw new NotFoundError('该日期不在当前计划范围内');
    const day = ensureExamTasks(plan, raw);

    const body = parseBody(TaskUpdate, req.body);
    const tasks = day.tasks.map((task) =>
      task.id === req.params.taskId
        ? {
            ...task,
            done: body.done,
            ...(body.score !== undefined ? { score: body.score } : {}),
          }
        : task,
    );

    if (!tasks.some((task) => task.id === req.params.taskId)) {
      throw new NotFoundError('任务不存在');
    }

    const updated = saveDayTasks(day.id, tasks);
    const target = tasks.find((task) => task.id === req.params.taskId)!;

    removeTaskLogs(day.id, target.id);
    if (body.done) {
      logStudy({
        planId: plan.id,
        dayId: day.id,
        taskId: target.id,
        kind: target.kind,
        minutes: body.minutes ?? target.minutes,
        score: body.score ?? null,
      });
    }

    res.json({ day: updated });
  }),
);

daysRouter.post(
  '/days/:date/reset',
  asyncHandler(async (req, res) => {
    const plan = getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划');
    const date = req.params.date === 'today' ? todayISO() : req.params.date;
    const day = getDayByDate(plan.id, date);
    if (!day) throw new NotFoundError('该日期不在当前计划范围内');

    const tasks = day.tasks.map((task) => ({ ...task, done: false }));
    const updated = saveDayTasks(day.id, tasks);
    for (const task of day.tasks) removeTaskLogs(day.id, task.id);

    res.json({ day: updated });
  }),
);
