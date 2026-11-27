import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../auth/requestScope';
import { asyncHandler, parseParams } from '../lib/http';
import { getKnowledgeOverview } from '../repositories/knowledge';

/**
 * 知识图谱只读接口：某语种的知识树 + 当前账号的掌握度 + 覆盖率。
 * 现在只用于核查与后续诊断入口取数，不提供写接口 —— 节点与关系以内容层声明为准。
 */
export const knowledgeRouter = Router();

const LanguageParams = z.object({
  language: z.enum(['en', 'ja', 'ko']),
});

knowledgeRouter.get(
  '/knowledge/:language',
  asyncHandler(async (req, res) => {
    const { language } = parseParams(LanguageParams, req.params);
    res.json(getKnowledgeOverview(language, currentUserId()));
  }),
);
