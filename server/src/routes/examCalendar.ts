import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError } from '../lib/errors';
import { buildExamCalendar } from '../catalog/calendar';
import { getActivePlan, getPlan } from '../repositories/plans';

export const examCalendarRouter = Router();

const Query = z.object({
  examId: z.enum(['toefl', 'jlpt', 'topik']),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** 设置计划时的实时预览：按考试 + 考试日期给出报考节点与费用 */
examCalendarRouter.get(
  '/exam-calendar',
  asyncHandler(async (req, res) => {
    const query = parseBody(Query, req.query);
    const calendar = buildExamCalendar(query.examId, query.examDate);
    if (!calendar) throw new NotFoundError('该考试暂不支持报考日历');
    res.json(calendar);
  }),
);

/** 计划详情：按 planId 返回该计划的报考日历 */
examCalendarRouter.get(
  '/exam-calendar/plan/:planId',
  asyncHandler(async (req, res) => {
    const plan = getPlan(req.params.planId) ?? getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划');
    const calendar = buildExamCalendar(plan.examId, plan.examDate);
    if (!calendar) throw new NotFoundError('该考试暂不支持报考日历');
    res.json({ ...calendar, planId: plan.id });
  }),
);
