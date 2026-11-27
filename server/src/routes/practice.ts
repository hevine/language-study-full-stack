import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../lib/errors';
import { asyncHandler, parseBody } from '../lib/http';
import { todayISO } from '../lib/date';
import {
  getActivePlan,
  getDayById,
  getDayByDate,
  getPlan,
  listDayContexts,
} from '../repositories/plans';
import {
  attemptSummaries,
  findAttemptDay,
  getAttempt,
  listAttemptsByDateTask,
  practiceSummary,
} from '../repositories/practice';
import { buildPracticeBrief, gradePractice, isPracticeTask, practiceTasksForDay } from '../services/practice';
import type { GeneratedDay, PlanRecord } from '../domain/types';
import { assertRequestLanguage } from '../lib/languageGuard';

export const practiceRouter = Router();

const GradeInput = z.object({
  text: z.string().min(1).max(12000),
  durationSeconds: z.number().min(0).max(7200).nullable().optional(),
  submissionSource: z.enum(['typed', 'speech']).optional(),
  recognitionConfidence: z.number().min(0).max(1).nullable().optional(),
});

function resolveDate(raw: string): string {
  return raw === 'today' ? todayISO() : raw;
}

interface PracticeTarget {
  plan: PlanRecord;
  day: GeneratedDay;
  /** 不在当前 active 计划范围内：只回看，不主动发起新的命题请求 */
  historical: boolean;
}

/**
 * 定位「某一天的那道题」：
 * 1. 先找当前计划——正常路径；
 * 2. 再优先找「这一天真正有批改记录」的那一天——切语种/重建计划后回看旧记录时，
 *    题目与原作答才对得上（题目缓存与批改都挂在各自的 day 上）；
 * 3. 以上都按「与当前计划同语种」优先；别的语种只作为最后的只读兜底，
 *    否则左侧写着英语、右侧却打开一份日语旧作答，正是串台的观感来源。
 * 因此「该日期不在当前计划范围内」不再阻断查看。
 */
function resolveTarget(date: string, taskId: string): PracticeTarget {
  const active = getActivePlan();
  let sameDateFallback: PracticeTarget | null = null;
  /** 其它语种的记录：只有当前语种完全找不到时才用，且一定是只读 */
  let otherLanguageFallback: PracticeTarget | null = null;

  if (active) {
    const day = getDayByDate(active.id, date);
    if (day) {
      if (day.tasks.some((task) => task.id === taskId)) {
        return { plan: active, day, historical: false };
      }
      // 同一天但题目对不上：先留着兜底，继续找真正有这条记录的那一天
      sameDateFallback = { plan: active, day, historical: false };
    }
  }

  const ref = findAttemptDay(date, taskId);
  if (ref) {
    const day = getDayById(ref.dayId);
    const plan = getPlan(ref.planId);
    if (day && plan) {
      // 同一语种的记录优先：否则左侧写着英语、右侧却打开一份日语旧作答
      if (!active || plan.language === active.language) return { plan, day, historical: true };
      otherLanguageFallback = { plan, day, historical: true };
    }
  }

  const contexts = listDayContexts(date);
  if (contexts.length > 0) {
    const hit = contexts
      .filter((item) => !active || item.plan.language === active.language)
      .find((item) => item.day.tasks.some((task) => task.id === taskId));
    if (hit) return { plan: hit.plan, day: hit.day, historical: true };
  }

  if (sameDateFallback) return sameDateFallback;
  if (otherLanguageFallback) return otherLanguageFallback;

  if (contexts.length > 0) {
    const hit = contexts.find((item) => item.day.tasks.some((task) => task.id === taskId));
    if (hit) return { plan: hit.plan, day: hit.day, historical: true };
  }

  if (contexts.length > 0) {
    return { plan: contexts[0].plan, day: contexts[0].day, historical: true };
  }

  throw new NotFoundError('这一天没有可查看的练习记录（可能来自已删除的计划）');
}

practiceRouter.get(
  '/practice/overview',
  asyncHandler(async (_req, res) => {
    const plan = getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划，请先创建计划');

    const day = getDayByDate(plan.id, todayISO());
    const tasks = day ? practiceTasksForDay(plan, day) : [];
    const pending = day ? day.tasks.filter((task) => isPracticeTask(task) && !task.done).length : 0;

    res.json({
      date: todayISO(),
      tasks,
      pending,
      hasDay: Boolean(day),
      // 跨计划列出全部批改记录：切换语种或重建计划后，过去的批改依然能回看
      attempts: attemptSummaries(24),
      summary: practiceSummary(40, plan.language),
    });
  }),
);

practiceRouter.get(
  '/practice/attempts',
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
    const plan = getActivePlan();
    const language = typeof req.query.language === 'string' ? req.query.language : plan?.language;
    res.json({
      attempts: attemptSummaries(limit, language),
      summary: practiceSummary(40, language),
    });
  }),
);

practiceRouter.get(
  '/practice/attempts/:id',
  asyncHandler(async (req, res) => {
    const attempt = getAttempt(req.params.id);
    if (!attempt) throw new NotFoundError('这条批改记录不存在');
    res.json({ attempt });
  }),
);

practiceRouter.get(
  '/practice/:date/:taskId',
  asyncHandler(async (req, res) => {
    const date = resolveDate(req.params.date);
    const target = resolveTarget(date, req.params.taskId);
    // 当前计划范围内的题必须与请求语种一致；历史记录只读，允许跨语种回看
    if (!target.historical) assertRequestLanguage(target.plan, req.query.language);

    const brief = await buildPracticeBrief(target.plan, target.day, req.params.taskId, {
      allowLlm: !target.historical,
      historical: target.historical,
    });

    res.json({
      ...brief,
      // 跨计划按「日期 + 题目」聚合：换计划后旧批改依然在这里
      attempts: listAttemptsByDateTask(date, req.params.taskId, 8),
      date,
      language: target.plan.language,
      examName: target.plan.examName,
      targetLabel: target.plan.targetLabel,
      historical: target.historical,
      planStartDate: target.plan.startDate,
      planExamDate: target.plan.examDate,
    });
  }),
);

practiceRouter.post(
  '/practice/:date/:taskId/grade',
  asyncHandler(async (req, res) => {
    const date = resolveDate(req.params.date);
    const target = resolveTarget(date, req.params.taskId);
    if (!target.historical) assertRequestLanguage(target.plan, req.query.language);

    const body = parseBody(GradeInput, req.body);
    const result = await gradePractice({
      plan: target.plan,
      day: target.day,
      taskId: req.params.taskId,
      text: body.text,
      durationSeconds: body.durationSeconds ?? null,
      submissionSource: body.submissionSource ?? 'typed',
      recognitionConfidence: body.recognitionConfidence ?? null,
    });

    res.json({
      attempt: result.attempt,
      day: result.day,
      attempts: listAttemptsByDateTask(date, req.params.taskId, 8),
      summary: practiceSummary(40),
      historical: target.historical,
    });
  }),
);
