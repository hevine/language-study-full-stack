import { db } from '../db';
import { logger } from '../lib/logger';
import {
  backfillExamAttempts,
  seedKnowledgeTrees,
  syncExamPoolQuestions,
} from '../repositories/knowledge';

/**
 * 启动期对齐知识图谱基座（幂等）：写知识树 → 同步题池 → 回填历史作答。
 *
 * 必须排在 ensureExamBank() 之后 —— 题池同步读的是 exam_items。
 * 三步放在一个事务里：知识树写坏了（比如前置关系成环）就不该继续同步题池，
 * 否则题目会对着一棵没落库的树挂考点。
 *
 * 失败只记日志、不中断启动，下次启动重试：
 * 交卷路径不依赖这次对齐（题目不在题池里就跳过并计数），
 * 诊断缺数据比整个应用起不来轻得多。
 */
export function ensureKnowledgeBase(): void {
  try {
    const run = db.transaction(() => ({
      trees: seedKnowledgeTrees(),
      pool: syncExamPoolQuestions(),
      backfill: backfillExamAttempts(),
    }));
    const result = run();
    logger.info('knowledge base ready', {
      trees: result.trees,
      pool: result.pool,
      backfill: result.backfill,
    });
  } catch (err) {
    logger.error('knowledge base seed failed', { error: (err as Error).message });
  }
}
