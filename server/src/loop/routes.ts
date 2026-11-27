/**
 * /api/loop/* —— 最小学习闭环
 *
 * 与 /api/agent/* 分开：Agent 负责「产出」，Loop 负责「记住并按时再考一次」。
 * 用户身份一律取请求作用域（登录用户），不接受前端传入，避免越权读写别人的卡片。
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../auth/requestScope';
import { NotFoundError } from '../lib/errors';
import { asyncHandler, parseBody } from '../lib/http';
import {
  dismissArtifact,
  exportLoop,
  gradeCard,
  listArtifacts,
  listCards,
  listDocuments,
  loopStats,
  loopToday,
  suspendDocument,
} from './store';

export const loopRouter = Router();

loopRouter.get(
  '/loop/today',
  asyncHandler(async (_req, res) => {
    res.json(loopToday(currentUserId()));
  }),
);

loopRouter.get(
  '/loop/stats',
  asyncHandler(async (_req, res) => {
    res.json(loopStats(currentUserId()));
  }),
);

loopRouter.get(
  '/loop/documents',
  asyncHandler(async (_req, res) => {
    res.json({ documents: listDocuments(currentUserId()) });
  }),
);

loopRouter.get(
  '/loop/artifacts',
  asyncHandler(async (_req, res) => {
    res.json({ artifacts: listArtifacts(currentUserId()) });
  }),
);

loopRouter.get(
  '/loop/cards',
  asyncHandler(async (req, res) => {
    const documentId = typeof req.query.documentId === 'string' ? req.query.documentId : undefined;
    res.json({ cards: listCards(currentUserId(), documentId) });
  }),
);

const GradeSchema = z.object({
  cardId: z.string().min(1).max(80),
  grade: z.number().int().min(0).max(3),
  ms: z.number().min(0).max(600_000).default(0),
});

loopRouter.post(
  '/loop/grade',
  asyncHandler(async (req, res) => {
    const input = parseBody(GradeSchema, req.body ?? {});
    const next = gradeCard(currentUserId(), input.cardId, input.grade as 0 | 1 | 2 | 3, input.ms);
    if (!next) throw new NotFoundError('这张卡不存在，或不属于当前用户');
    res.json(next);
  }),
);

loopRouter.post(
  '/loop/documents/:id/suspend',
  asyncHandler(async (req, res) => {
    const changed = suspendDocument(currentUserId(), req.params.id);
    res.json({ ok: true, changed });
  }),
);

loopRouter.post(
  '/loop/artifacts/:id/dismiss',
  asyncHandler(async (req, res) => {
    const ok = dismissArtifact(currentUserId(), req.params.id);
    if (!ok) throw new NotFoundError('没有可忽略的草稿产物');
    res.json({ ok: true });
  }),
);

loopRouter.get(
  '/loop/export',
  asyncHandler(async (_req, res) => {
    res.json(exportLoop(currentUserId()));
  }),
);
