/**
 * 母语（中文）讲师轨：把目标语旁白改写成中文口播，再逐镜合成中文音频。
 *
 * 为什么要单独一次调用，而不是让主脚本一次吐双语：
 *   - 主脚本已经 8–11k token，再翻一倍会把输出预算撑爆（v5 就是这么被截断的）；
 *   - 中文稿是「转述」不是「创作」，任务简单、可用更小预算、更稳的模型；
 *   - 最重要的是可以「按需补」：先出目标语版，用户真去切中文讲师时才花这笔钱。
 *
 * 铁律：中文稿只能转述，不得新增断言、不得改变结论、不得替学生做题。
 * 它和主轨讲的是同一件事，只是换了个人用母语讲。
 */
import { z } from 'zod';
import type { Language } from '../domain/language';
import type { Shot } from '../domain/explainVideo';
import { logger } from '../lib/logger';
import { UpstreamError } from '../lib/errors';
import { chatJson, resolveLlmConfig, type TokenUsage } from './llm';

const LANG_LABEL: Record<Language, string> = { en: 'English', ja: '日本語', ko: '한국어' };

const NativeSchema = z.object({
  lines: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        zh: z.string().min(1).max(800),
      }),
    )
    .min(1)
    .max(80),
});

export interface NativeNarration {
  /** shot.id → 中文口播 */
  texts: Map<string, string>;
  usage?: TokenUsage;
  model: string | null;
}

/** 汉字占比：中文稿应 > 0.25；模型若又写成目标语，这条就会掉到 0.05 以下 */
function hanRatio(text: string): number {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length === 0) return 0;
  const han = chars.filter((ch) => /[\u4e00-\u9fff]/.test(ch)).length;
  return han / chars.length;
}

const SYSTEM = `你是中文讲师，给中国学生补一段讲解。给你的是另一位老师用外语讲的内容（旁白）和对应的中文字幕，你要用中文口语把它重讲一遍，让没听懂外语的学生也能跟上。

规则：
1. 只转述，不新增。不得加入原文里没有的事实、数据、作者、出处；不得改变结论；不得替学生改答案。
2. 保留引文。原文里的外语原句用「」原样括起来，不要翻译它——那是学生要回原文核对的锚点。
3. 说人话。短句，口语，可以有「你看」「其实」，不要「首先/其次/综上所述」，不要复述题干。
4. 长度：每条 1–3 句，约等于原旁白的 1.2–1.8 倍信息量；宁短勿水。
5. 语法术语用通行中文译名（如「被动形」「て形」「定语从句」），不要生造。
6. 输出 JSON：{"lines":[{"id":"原样带回","zh":"中文口播"}]}，顺序与输入一致，一条不少。`;

/**
 * 生成中文讲稿。失败时抛 UpstreamError —— 调用方要么整片降级为「只有目标语轨」，
 * 要么把 job 标成失败；绝不拿半份中文稿去配音，那会比没有更糟。
 */
export async function generateNativeNarration(
  shots: Shot[],
  language: Language,
): Promise<NativeNarration> {
  const { config } = resolveLlmConfig();
  if (!config) throw new UpstreamError('未配置大模型，暂时无法生成中文讲解');

  const payload = shots.map((shot) => ({
    id: shot.id,
    kind: shot.kind,
    target: shot.narration,
    caption: shot.caption,
  }));

  // 每镜中文口播 1–3 句，实测约 200–260 字；给 280 留余量。
  // 曾经按 160 给，11 镜就被截断一次（2160 → 6000），白花一次双倍预算。
  const budget = Math.min(9_000, 600 + shots.length * 280);
  let parsed: z.infer<typeof NativeSchema>;
  try {
    parsed = await chatJson(
      config,
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `讲解语言：${LANG_LABEL[language]}\n\n${JSON.stringify({ lines: payload })}`,
        },
      ],
      NativeSchema,
      { maxTokens: budget, temperature: 0.3, retries: 1, timeoutMs: 150_000 },
    );
  } catch (err) {
    throw new UpstreamError(`中文讲解稿生成失败：${(err as Error).message}`);
  }

  const byId = new Map(parsed.lines.map((line) => [line.id, line.zh.trim()]));
  const texts = new Map<string, string>();
  let bad = 0;
  for (const shot of shots) {
    const text = byId.get(shot.id);
    if (text && hanRatio(text) >= 0.25) {
      texts.set(shot.id, text);
    } else {
      bad += 1;
    }
  }
  // 超过三成不合格就整批作废：这说明模型又在写外语，或者根本没按 id 回填
  if (texts.size < Math.ceil(shots.length * 0.7)) {
    throw new UpstreamError(
      `中文讲解稿不合格（${shots.length - texts.size}/${shots.length} 条未通过语种校验），请稍后重试`,
    );
  }
  if (bad > 0) {
    logger.warn('native narration partially rejected', { total: shots.length, rejected: bad });
  }

  const usage = config.usage ? { ...config.usage } : undefined;
  logger.info('explain native narration generated', {
    shots: shots.length,
    kept: texts.size,
    tokTotal: usage?.totalTokens ?? 0,
  });
  return { texts, usage, model: config.usedModel ?? config.model ?? null };
}

/** 中文讲师音色：可用 EXPLAIN_ZH_VOICE 覆盖；只认 Edge Neural 名 */
export function resolveNativeVoice(): string {
  const override = process.env.EXPLAIN_ZH_VOICE?.trim();
  if (override && /^zh-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(override)) return override;
  return 'zh-CN-XiaoxiaoNeural';
}
