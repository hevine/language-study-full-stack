import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError } from '../lib/errors';
import {
  activatePlan,
  archivePlan,
  createPlan,
  getActivePlan,
  getPlan,
  listDays,
  listPlans,
  planProgress,
} from '../repositories/plans';
import { buildPlan, validatePlanRequest } from '../services/planner';

export const plansRouter = Router();

const PlanInput = z.object({
  language: z.enum(['en', 'ja', 'ko']),
  examId: z.string().min(1),
  currentLevelId: z.string().min(1),
  targetScore: z.number(),
  startDate: z.string().min(8),
  examDate: z.string().min(8),
  hoursPerWeek: z.number(),
  dailyMinutes: z.number(),
});

plansRouter.post(
  '/plans',
  asyncHandler(async (req, res) => {
    const body = parseBody(PlanInput, req.body);
    const input = validatePlanRequest(body);
    const draft = buildPlan(input);
    const plan = createPlan(draft);

    const days = listDays(plan.id, { limit: 21 }).map((day) => ({
      id: day.id,
      date: day.date,
      weekIndex: day.weekIndex,
      dayIndex: day.dayIndex,
      phaseName: day.phaseName,
      theme: day.theme,
      status: day.status,
      totalMinutes: day.tasks.reduce((sum, task) => sum + task.minutes, 0),
    }));

    req.log.info('plan created', { planId: plan.id, weeks: plan.weeks, language: plan.language });
    res.status(201).json({ plan, days });
  }),
);

plansRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    res.json({ plans: listPlans() });
  }),
);

plansRouter.get(
  '/plans/active',
  asyncHandler(async (_req, res) => {
    const plan = getActivePlan();
    if (!plan) {
      res.json({ plan: null });
      return;
    }
    const progress = planProgress(plan.id);
    const days = listDays(plan.id, { limit: 400 });
    res.json({
      plan,
      progress,
      days: days.map((day) => ({
        id: day.id,
        date: day.date,
        weekIndex: day.weekIndex,
        dayIndex: day.dayIndex,
        phase: day.phase,
        phaseName: day.phaseName,
        theme: day.theme,
        focus: day.focus,
        status: day.status,
        taskCount: day.tasks.length,
        doneCount: day.tasks.filter((task) => task.done).length,
        totalMinutes: day.tasks.reduce((sum, task) => sum + task.minutes, 0),
      })),
    });
  }),
);

plansRouter.get(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const plan = getPlan(req.params.id);
    if (!plan) throw new NotFoundError('计划不存在');
    const progress = planProgress(plan.id);
    res.json({ plan, progress });
  }),
);

plansRouter.post(
  '/plans/:id/archive',
  asyncHandler(async (req, res) => {
    const plan = getPlan(req.params.id);
    if (!plan) throw new NotFoundError('计划不存在');
    archivePlan(plan.id);
    res.json({ ok: true });
  }),
);

plansRouter.post(
  '/plans/:id/activate',
  asyncHandler(async (req, res) => {
    const plan = activatePlan(req.params.id);
    if (!plan) throw new NotFoundError('计划不存在');
    req.log.info('plan activated', { planId: plan.id, language: plan.language });
    res.json({ plan });
  }),
);
