import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError } from '../lib/errors';
import { todayISO } from '../lib/date';
import { getActivePlan, getDayByDate } from '../repositories/plans';
import { ensureExamTasks } from '../services/examTasks';
import { AI_KINDS, aiBankList, aiRemove, aiStats, generateForTask, isAiKind } from '../services/aiGen';
import { llmStatus } from '../services/llm';

export const aiRouter = Router();

const GenerateInput = z.object({
  taskId: z.string().min(1),
  date: z.string().min(1).optional(),
  /** true = 忽略 5 分钟缓存，强制再生成一批（会真的消耗 token） */
  fresh: z.boolean().optional(),
});

/** 任务页「AI 加练」：按今日任务由用户手动触发生成，结果落本地题库 */
aiRouter.post(
  '/ai/generate',
  asyncHandler(async (req, res) => {
    const input = parseBody(GenerateInput, req.body ?? {});
    const plan = getActivePlan();
    if (!plan) throw new NotFoundError('还没有备考计划，请先创建计划');

    const date = !input.date || input.date === 'today' ? todayISO() : input.date;
    const raw = getDayByDate(plan.id, date);
    if (!raw) throw new NotFoundError('该日期不在当前计划范围内');
    const day = ensureExamTasks(plan, raw);

    const task = day.tasks.find((item) => item.id === input.taskId);
    if (!task) throw new NotFoundError('任务不存在');
    if (!isAiKind(task.kind)) throw new NotFoundError('这一项没有可生成的练习');

    const result = await generateForTask(plan, day, task, { fresh: input.fresh });
    res.json({
      ...result,
      taskKind: task.kind,
      taskTitle: task.title,
      supportedKinds: AI_KINDS,
    });
  }),
);

/** 本地 AI 题库：按语种 / 任务类型浏览已经生成并入库的内容 */
aiRouter.get(
  '/ai/bank',
  asyncHandler(async (req, res) => {
    const language = typeof req.query.language === 'string' ? req.query.language : undefined;
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const limit = Number(req.query.limit ?? 60);
    const items = aiBankList({
      ...(language ? { language } : {}),
      ...(kind ? { kind } : {}),
      limit: Number.isFinite(limit) ? limit : 60,
    });
    res.json({ items, stats: aiStats() });
  }),
);

/** 用量统计：今天用了多少 token、哪个模型用得多 —— 用于界面「今日累计」提示 */
aiRouter.get(
  '/ai/stats',
  asyncHandler(async (_req, res) => {
    const status = llmStatus();
    res.json({
      ...aiStats(),
      ready: status.configured,
      activeModel: status.model,
      activeProvider: status.providerName,
    });
  }),
);

aiRouter.delete(
  '/ai/items/:id',
  asyncHandler(async (req, res) => {
    const removed = aiRemove(req.params.id);
    res.json({ ok: removed });
  }),
);
