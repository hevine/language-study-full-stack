import { Router } from 'express';
import { catalogSummary } from '../catalog';
import { asyncHandler } from '../lib/http';
import { llmStatus } from '../services/llm';

export const catalogRouter = Router();

catalogRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    res.json({ ...catalogSummary(), llm: llmStatus() });
  }),
);
