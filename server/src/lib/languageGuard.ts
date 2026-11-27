import { profileOf, isLanguage } from '../domain/language';
import type { PlanRecord } from '../domain/types';
import { AppError, ValidationError } from './errors';

export const LANGUAGE_MISMATCH = 'LANGUAGE_MISMATCH';

/**
 * 请求语种与当前激活计划不一致时直接拒绝。
 *
 * 为什么要在服务端拦：前端传的 `language` 来自当前激活计划，正常情况下必然一致。
 * 会不一致只有一种情况——「按旧语种发出的请求晚于切语种才回到服务端」：
 * 切换语言后旧请求还在路上，它带的是英语，而此刻激活的已经是日语计划。
 * 如果服务端照常返回，页面就会拿日语计划的数据渲染英语界面，
 * 或者反过来，正是「左边英语、右边日语」的来源。
 * 这里返回 409 让前端重取一次，比静默返回错语种内容安全得多。
 *
 * 未传 `language` 时不做校验（脚本、旧版客户端、内部调用）。
 */
export function assertRequestLanguage(plan: PlanRecord, requested: unknown): void {
  if (requested === undefined || requested === null || requested === '') return;
  if (!isLanguage(requested)) {
    throw new ValidationError('language 只能是 en、ja 或 ko');
  }
  if (requested === plan.language) return;

  throw new AppError(
    `当前学习计划是${profileOf(plan.language).name}，本次请求按${profileOf(requested).name}发起（通常是切换语种前发出的旧请求）。已按当前计划的语种重新取数，请稍后再看。`,
    {
      code: LANGUAGE_MISMATCH,
      status: 409,
      details: { requested, active: plan.language, planId: plan.id },
    },
  );
}
