import { Router } from 'express';
import { asyncHandler, parseParams } from '../lib/http';
import { NotFoundError } from '../lib/errors';
import { z } from 'zod';
import { buildLearningPath } from '../services/path';

export const pathsRouter = Router();

const Params = z.object({ language: z.enum(['en', 'ja', 'ko']) });

pathsRouter.get(
  '/paths/:language',
  asyncHandler(async (req, res) => {
    const { language } = parseParams(Params, req.params);
    const path = buildLearningPath(language);
    if (!path) throw new NotFoundError('该语种暂未提供进阶路径');
    res.json(path);
  }),
);
