import { Router } from 'express';
import { asyncHandler } from '../lib/http';
import { buildStats } from '../services/stats';
import { db } from '../db';

export const statsRouter = Router();

const LANGS = new Set(['en', 'ja', 'ko']);

statsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.language === 'string' ? req.query.language : '';
    // 只接受已知语种，其它值退回「跟随当前激活计划」
    const language = LANGS.has(raw) ? raw : undefined;
    res.json(buildStats(undefined, language));
  }),
);

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
});

healthRouter.get('/ready', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', message: (err as Error).message });
  }
});
