import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody, parseParams } from '../lib/http';
import { ValidationError } from '../lib/errors';
import { getGrammarLibrary } from '../repositories/grammar';
import { grammarLibrary } from '../content/grammar';

/**
 * 内置语法库只读接口：某语种的语法点、错因规则、级别表。
 * 数据来自知识图谱（启动期由内容文件写入），这里不提供写接口 ——
 * 要增补语法点就改 content/grammar/<语种>.json，或用导入脚本重新生成。
 *
 *   GET /grammar/:language                     全部语法点与规则
 *   GET /grammar/:language?level=N3            只看某个级别
 *   GET /grammar/:language?q=使役              搜索语法点与规则
 */
export const grammarRouter = Router();

const LanguageParams = z.object({
  language: z.enum(['en', 'ja', 'ko']),
});

const LibraryQuery = z.object({
  level: z.string().regex(/^[A-Za-z0-9]{1,8}$/).optional(),
  q: z.string().max(80).optional(),
});

grammarRouter.get(
  '/grammar/:language',
  asyncHandler(async (req, res) => {
    const { language } = parseParams(LanguageParams, req.params);
    const query = parseBody(LibraryQuery, req.query);
    const level = query.level || undefined;
    // 级别表在内容文件里，校验不必查库
    if (level && !grammarLibrary(language)?.levels.some((item) => item.id === level)) {
      throw new ValidationError(`语法库级别 ${level} 不存在`);
    }
    res.json(getGrammarLibrary(language, { level, query: query.q }));
  }),
);
