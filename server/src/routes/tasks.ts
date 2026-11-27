import { Router } from 'express';
import { asyncHandler } from '../lib/http';
import { ConflictError, NotFoundError } from '../lib/errors';
import { deleteDayContents } from '../repositories/content';
import { resolveLlmConfig } from '../services/llm';
import { ensureDayContent } from '../services/content';
import { getActivePlan, getDayByDate } from '../repositories/plans';
import { buildTaskDetail } from '../services/tasks';
import { ensureExamTasks } from '../services/examTasks';
import { todayISO } from '../lib/date';
import { assertRequestLanguage } from '../lib/languageGuard';

export const tasksRouter = Router();

/** 任务完成页：按任务类型返回该做什么（词汇 / 精读 / 朗读 / 语法 / 复盘 / 写作跳转） */
tasksRouter.get(
  '/tasks/:date/:taskId',
  asyncHandler(async (req, res) => {
    const plan = getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划，请先创建计划');
    assertRequestLanguage(plan, req.query.language);

    const date = req.params.date === 'today' ? todayISO() : req.params.date;
    const raw = getDayByDate(plan.id, date);
    if (!raw) throw new NotFoundError('该日期不在当前计划范围内');
    const day = ensureExamTasks(plan, raw);

    const task = day.tasks.find((item) => item.id === req.params.taskId);
    if (!task) throw new NotFoundError('任务不存在');

    res.json(await buildTaskDetail(plan, day, task));
  }),
);

/** 「换一篇」：清掉当日缓存材料，强制用大模型按当日考纲重新生成（未配置模型时给出明确提示） */
tasksRouter.post(
  '/tasks/:date/regenerate',
  asyncHandler(async (req, res) => {
    const plan = getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划，请先创建计划');
    assertRequestLanguage(plan, req.query.language);

    const date = req.params.date === 'today' ? todayISO() : req.params.date;
    const raw = getDayByDate(plan.id, date);
    if (!raw) throw new NotFoundError('该日期不在当前计划范围内');
    const day = ensureExamTasks(plan, raw);

    const { config } = resolveLlmConfig();
    if (!config) {
      throw new ConflictError('当前为内置题库演示模式，请在「设置 → 模型服务」配置大模型后，再用「换一篇」生成新材料。');
    }

    deleteDayContents(day.id);
    const content = await ensureDayContent(plan, day);
    res.json({
      source: content.source,
      notice: content.notice,
      titles: content.articles.map((item) => ({ kind: item.kind, title: item.title })),
    });
  }),
);
