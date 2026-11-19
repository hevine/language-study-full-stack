import { EN_LIBRARY } from '../content/library.en';
import { EN_LIBRARY_EXTRA } from '../content/library.en.extra';
import { JA_LIBRARY } from '../content/library.ja';
import { JA_LIBRARY_EXTRA } from '../content/library.ja.extra';
import { KO_LIBRARY } from '../content/library.ko';
import { KO_LIBRARY_EXTRA } from '../content/library.ko.extra';
import type { ArticlePayload, DayPayload, GeneratedDay, PlanRecord } from '../domain/types';
import { logger } from '../lib/logger';
import { listDayContents, saveDayContent, type ArticleRecord } from '../repositories/content';
import { currentUserId } from '../auth/requestScope';
import { upsertWords } from '../repositories/vocab';
import { requireLanguage } from '../domain/language';
import { classifyLlmError, resolveLlmConfig } from './llm';
import { generateArticle, type GenerateArticleResult } from './dayArticle';

/**
 * 今日材料的编排层。
 *
 * 老版本一次请求同时生成精读 + 泛读，输出被 max_tokens 截断后加预算「从头再写一遍」，
 * 两次都失败就把两批内容一起丢掉回退内置库 —— 已经花掉的 token 全部作废。
 * 现在拆成两篇各自生成、各自抢救、各自落库：
 *   · 单次输出量减半，截断概率大幅下降；
 *   · 一篇失败不拖累另一篇；
 *   · 只要写出了正文就一定保留并入库，下次进入直接命中缓存，不会重复消耗。
 */

function libraryFallback(plan: PlanRecord, day: GeneratedDay): DayPayload {
  const pool =
    plan.language === 'ja'
      ? [...JA_LIBRARY, ...JA_LIBRARY_EXTRA]
      : plan.language === 'ko'
        ? [...KO_LIBRARY, ...KO_LIBRARY_EXTRA]
        : [...EN_LIBRARY, ...EN_LIBRARY_EXTRA];
  const seed = day.weekIndex * 3 + day.dayIndex;
  const intensive = pool[seed % pool.length];
  const extensive = pool[(seed + Math.ceil(pool.length / 2)) % pool.length];
  return { intensive, extensive };
}

function libraryOnly(article: ArticlePayload): GenerateArticleResult {
  return { payload: article, status: 'library', patched: ['whole'], salvagedBody: false };
}

/** 两篇都没抢救出内容时才用：按失败原因给可操作的中文指引 */
function fallbackNotice(err: unknown): string {
  const tail = '今日材料已回退为内置精读库。';
  switch (classifyLlmError(err)) {
    case 'timeout':
      return `模型线路网络超时或连接失败，${tail}可到「设置 → 模型 Key 池」测试线路，或稍后点「换一篇」重试。`;
    case 'truncated':
      return `模型输出被截断且未能抢救出可用正文，${tail}本次未产出可保存的内容；建议到「设置」换用输出上限更高的模型，或稍后重试。`;
    case 'config':
      return `模型 Key、权限或额度异常，${tail}请到「设置 → 模型 Key 池」检查 Key、模型名与余额。`;
    default: {
      const reason = (err as Error)?.message?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? '';
      return `大模型生成失败${reason ? `（${reason}）` : ''}，${tail}可在「设置」中检查模型配置。`;
    }
  }
}

const KIND_LABEL = { intensive: '精读', extensive: '泛读' } as const;

/**
 * 分级提示：把「已保存了什么 / 什么由内置库补齐 / 会不会再花 token」讲清楚，
 * 不再用一句「已回退」掩盖掉其实已经生成成功的内容。
 */
function buildNotice(
  configured: boolean,
  results: Array<{ kind: keyof typeof KIND_LABEL; result: GenerateArticleResult }>,
): string | null {
  if (!configured) {
    return '当前为演示模式：今日材料来自内置考纲题库。配置大模型后将按当日主题与考纲实时生成。';
  }

  const allLlm = results.every((item) => item.result.status === 'llm');
  if (allLlm) {
    // 被截断过但完整救回来了：给一条正向反馈，让用户知道这次 token 没白花
    return results.some((item) => item.result.recovered)
      ? '模型输出曾被截断，已保留已写好的正文并只补齐缺失字段，没有从头重生成；本次消耗的 token 全部用于今天的材料，已保存入库。'
      : null;
  }

  const saved = results.filter((item) => item.result.salvagedBody);
  const fromLibrary = results.filter((item) => !item.result.salvagedBody);

  if (saved.length === 0) {
    const err = results.find((item) => item.result.error)?.result.error;
    return fallbackNotice(err);
  }

  const savedText = saved.map((item) => KIND_LABEL[item.kind]).join('、');
  const patched = new Set(saved.flatMap((item) => item.result.patched.filter((field) => field !== 'whole')));
  const fieldNames: Record<string, string> = {
    title: '标题',
    translation: '译文',
    vocab: '词表',
    questions: '练习题',
    readingScript: '朗读分段',
  };
  const patchedText = [...patched].map((field) => fieldNames[field] ?? field).join('、');

  const pieces = [`已保留模型生成的${savedText}正文并入库`];
  if (patchedText) pieces.push(`缺失的${patchedText}由内置库自动补齐`);
  if (fromLibrary.length > 0) {
    pieces.push(`${fromLibrary.map((item) => KIND_LABEL[item.kind]).join('、')}暂用内置精读库`);
  }
  pieces.push('本次消耗的 token 没有作废，下次进入不会重复生成');
  return `${pieces.join('；')}。`;
}

export interface EnsureContentResult {
  articles: ArticleRecord[];
  source: 'llm' | 'mixed' | 'library' | 'cached';
  notice: string | null;
}

export async function ensureDayContent(plan: PlanRecord, day: GeneratedDay): Promise<EnsureContentResult> {
  const existing = listDayContents(day.id);
  if (existing.length > 0) {
    return { articles: existing, source: 'cached', notice: null };
  }

  const { config } = resolveLlmConfig();
  const fallback = libraryFallback(plan, day);

  let intensive: GenerateArticleResult;
  let extensive: GenerateArticleResult;

  if (config) {
    // 串行而非并发：号池里往往只有一条可用线路，两个请求同时打过去容易触发 429
    intensive = await generateArticle(config, plan, day, 'intensive', fallback.intensive);
    extensive = await generateArticle(config, plan, day, 'extensive', fallback.extensive);
  } else {
    intensive = libraryOnly(fallback.intensive);
    extensive = libraryOnly(fallback.extensive);
  }

  const results = [
    { kind: 'intensive' as const, result: intensive },
    { kind: 'extensive' as const, result: extensive },
  ];

  for (const item of results) {
    if (item.result.error) {
      logger.warn('day article fell back', {
        kind: item.kind,
        date: day.date,
        status: item.result.status,
        message: (item.result.error as Error).message,
      });
    }
  }

  const anyLlm = results.some((item) => item.result.salvagedBody);
  const allLlm = results.every((item) => item.result.status === 'llm');
  const source: EnsureContentResult['source'] = allLlm ? 'llm' : anyLlm ? 'mixed' : 'library';
  const notice = buildNotice(Boolean(config), results);

  const model = config?.usedModel ?? config?.model ?? null;
  const saved: ArticleRecord[] = results.map((item) =>
    saveDayContent({
      planId: plan.id,
      dayId: day.id,
      language: plan.language,
      kind: item.kind,
      payload: item.result.payload,
      source: item.result.salvagedBody ? 'llm' : 'library',
      model: item.result.salvagedBody ? model : null,
      estMinutes: item.kind === 'intensive' ? 25 : 15,
    }),
  );

  const words = [...intensive.payload.vocab, ...extensive.payload.vocab];
  upsertWords(currentUserId(), requireLanguage(plan.language), words, day.date);

  return { articles: saved, source, notice };
}
