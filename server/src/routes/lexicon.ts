import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { ValidationError } from '../lib/errors';
import { LEX_SOURCE, lexLevels, listLexEntries, type LexLanguage } from '../content/lexicon';
import {
  listTerms,
  upsertWords,
  vocabLevelStats,
  vocabStats,
  type VocabInput,
} from '../repositories/vocab';
import { getActivePlan } from '../repositories/plans';
import { currentUserId } from '../auth/requestScope';

export const lexiconRouter = Router();

const ImportInput = z.object({
  language: z.enum(['en', 'ja', 'ko']),
  level: z.string().min(1).max(16),
  limit: z.number().int().min(1).max(500).optional(),
});

function assertLevel(language: LexLanguage, levelId: string): void {
  const exists = lexLevels(language).some((item) => item.id === levelId);
  if (!exists) throw new ValidationError(`词库级别 ${levelId} 不存在`);
}

function toInput(entry: ReturnType<typeof listLexEntries>[number]): VocabInput {
  return {
    term: entry.term,
    reading: entry.reading ?? undefined,
    pos: entry.pos,
    meaning: entry.cn,
    example: entry.example,
    exampleCn: entry.exampleCn,
    mnemonic: entry.mnemonic,
    theme: entry.theme,
    level: entry.level,
    syn: entry.syn,
  };
}

/** 分级词库总览：每个级别收多少词、已进词汇本多少、今日到期多少 */
lexiconRouter.get(
  '/lexicon',
  asyncHandler(async (req, res) => {
    const languageRaw = typeof req.query.language === 'string' ? req.query.language : null;
    const language: LexLanguage =
      languageRaw === 'ja' ? 'ja' : languageRaw === 'ko' ? 'ko' : 'en';
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    if (level) assertLevel(language, level);

    const entries = listLexEntries(language, { level, query });
    const inBook = listTerms(currentUserId(), language);
    const statMap = new Map(vocabLevelStats(currentUserId(), language).map((row) => [row.level, row]));
    const plan = getActivePlan();

    res.json({
      language,
      source: LEX_SOURCE[language],
      planLevelId:
        plan && plan.language === language ? plan.currentLevelId : null,
      levels: lexLevels(language).map((item) => {
        const stat = statMap.get(item.id);
        return {
          ...item,
          inBook: stat?.total ?? 0,
          due: stat?.due ?? 0,
          mastered: stat?.mastered ?? 0,
        };
      }),
      words: (level ? entries : entries.slice(0, 200)).map((entry) => ({
        ...entry,
        inBook: inBook.has(entry.term),
      })),
      stats: vocabStats(currentUserId(), language),
    });
  }),
);

/** 把某一级别的词一次加入词汇本（走 SM-2；已存在的不覆盖复习进度） */
lexiconRouter.post(
  '/lexicon/import',
  asyncHandler(async (req, res) => {
    const { language, level, limit } = parseBody(ImportInput, req.body);
    assertLevel(language as LexLanguage, level);

    const entries = listLexEntries(language as LexLanguage, { level });
    const picked = entries.slice(0, limit ?? entries.length);
    const added = upsertWords(
      currentUserId(),
      language,
      picked.map(toInput),
      language === 'ja' ? 'ja-lexicon' : language === 'ko' ? 'ko-lexicon' : 'toefl-lexicon',
    );

    res.json({
      language,
      level,
      added,
      skipped: picked.length - added,
      stats: vocabStats(currentUserId(), language),
      levels: vocabLevelStats(currentUserId(), language),
    });
  }),
);
