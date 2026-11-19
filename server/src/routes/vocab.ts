import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { ConflictError, NotFoundError } from '../lib/errors';
import {
  getWord,
  listDue,
  listWords,
  updateSchedule,
  vocabLevelStats,
  vocabStats,
} from '../repositories/vocab';
import { scheduleNext, type Grade } from '../services/srs';
import { getActivePlan } from '../repositories/plans';
import { currentUserId } from '../auth/requestScope';
import { isLanguage, type Language } from '../domain/language';

export const vocabRouter = Router();

const ReviewInput = z.object({
  grade: z.number().int().min(0).max(3),
  language: z.enum(['en', 'ja', 'ko']).optional(),
});

/**
 * 语言维度统一在这里解析：显式传参优先，其次取当前在学计划的语言。
 * 词汇查询与复习都不允许「不指定语言就查全部」，否则英语和日语会串在一起。
 */
function resolveLanguage(value: unknown): Language {
  if (isLanguage(value)) return value;
  const plan = getActivePlan();
  if (plan && isLanguage(plan.language)) return plan.language;
  return 'en';
}

vocabRouter.get(
  '/vocab',
  asyncHandler(async (req, res) => {
    const language = resolveLanguage(req.query.language);
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    const limit = Number(req.query.limit ?? 200);

    res.json({
      language,
      words: listWords(currentUserId(), language, { query, level, limit }),
      stats: vocabStats(currentUserId(), language),
      levels: vocabLevelStats(currentUserId(), language),
    });
  }),
);

vocabRouter.get(
  '/vocab/due',
  asyncHandler(async (req, res) => {
    const language = resolveLanguage(req.query.language);
    const limit = Number(req.query.limit ?? 30);
    res.json({ language, words: listDue(currentUserId(), language, { limit }) });
  }),
);

vocabRouter.get(
  '/vocab/levels',
  asyncHandler(async (req, res) => {
    const language = resolveLanguage(req.query.language);
    res.json({ language, levels: vocabLevelStats(currentUserId(), language) });
  }),
);

vocabRouter.post(
  '/vocab/:id/review',
  asyncHandler(async (req, res) => {
    const { grade, language } = parseBody(ReviewInput, req.body);
    const word = getWord(req.params.id);
    if (!word) throw new NotFoundError('该词条不存在');
    // 跨语种复习直接拒绝：英语词只能在英语册里复习，日语同理
    if (language && word.language !== language) {
      throw new ConflictError('该词条不属于当前语种的词汇本');
    }

    const next = scheduleNext(word, grade as Grade);
    updateSchedule(word.id, next);

    res.json({
      word: { ...word, ...next },
      next,
    });
  }),
);
