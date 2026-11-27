/**
 * 背词任务的「词量模型」。
 *
 * 计划页承诺的「每日新学 N 个词」必须真的落到今天的词卡上。历史上两处口径不一致：
 * planner 生成标题时按计划的 N（例如 60）写，tasks 生成词卡时却用
 * `min(16, minutes / 3)` 截断——44 分钟的词汇任务只给 15 个词，
 * 用户点进去看到「新词 60 个」却只有 15 张卡，复习到期词一张都没有。
 *
 * 这里把「分钟 → 词量」的换算收敛到一处，planner（写标题）与 tasks（出词卡）
 * 共用同一个函数，标题与实物永远一致。0.7 分钟/词沿用 planner 分配词汇任务时长
 * 时用的口径（`newWordsPerDay * 0.7 + 5`），两边不会再漂移。
 */

/** 认读 + 拼写自测的平均节奏：约 42 秒一个词 */
export const MINUTES_PER_NEW_WORD = 0.7;
/** 单次会话的新词上限：与 planner 的 60 上限一致，再多就记不住了 */
export const MAX_NEW_WORDS_PER_SESSION = 60;
/** 下限：低于 6 个词就不像一次完整的背词 */
export const MIN_NEW_WORDS_PER_SESSION = 6;
/** 到期复习词最多占新词量的四分之一 */
export const REVIEW_RATIO = 0.25;
/** 复习词单次上限，避免积压时一次堆上百张卡 */
export const MAX_REVIEW_WORDS = 20;

/**
 * 本次背词会话的新词量：取「计划每日目标」与「任务时长能装下的量」的较小值。
 * 计划目标缺失（旧计划的 roadmap 没有这个字段）时按时长上限算。
 */
export function sessionNewWordCount(dailyTarget: number | undefined, minutes: number): number {
  const byTime = Math.floor(Math.max(0, minutes) / MINUTES_PER_NEW_WORD);
  const target =
    dailyTarget && dailyTarget > 0 ? Math.round(dailyTarget) : MAX_NEW_WORDS_PER_SESSION;
  return Math.max(
    MIN_NEW_WORDS_PER_SESSION,
    Math.min(MAX_NEW_WORDS_PER_SESSION, Math.min(target, byTime)),
  );
}

/** 本次会话安排多少到期复习词：有积压就按新词量的 1/4 抽，最少 5 个 */
export function sessionReviewCount(dueAvailable: number, newCount: number): number {
  if (dueAvailable <= 0) return 0;
  const share = Math.min(MAX_REVIEW_WORDS, Math.max(5, Math.round(newCount * REVIEW_RATIO)));
  return Math.min(dueAvailable, share);
}
