/**
 * 解题答疑视频 · 分镜脚本生成（LLM 一次调用 + 代码侧强校验）。
 *
 * 决策：目标语讲解 + 中文字幕（用户确认）。
 *   - narration：目标语（en/ja/ko）口语化 TTS 输入，喂给对应语种 Neural 音色；
 *   - caption：中文字幕 / 屏幕文字。
 *
 * 硬约束（HANDOVER 第 8 节）：
 *   1. 答案由 question.answer 决定，模型只讲「为什么」，不许改写选项；
 *   2. passage 镜必须给 evidence 原句，代码校验是否能在 body 精确匹配，失败降级为段号；
 *   3. 旁白禁止 markdown / 括号注释 / emoji，单句尽量 ≤ 40 字；
 *   4. 不在请求处理器里跑长任务 —— 调用方在 job 里使用本函数。
 */
import type { Language } from '../domain/language';
import { computeServerTimeline, type Shot } from '../domain/explainVideo';
import { chatJson, resolveLlmConfig, type TokenUsage } from './llm';
import { logger } from '../lib/logger';
import { UpstreamError } from '../lib/errors';
import {
  ScriptSchema,
  coerceScriptValue,
  parseScriptText,
  type ScriptParseResult,
  type ShotDraft,
} from './explainScriptSalvage';
import { assembleShots, ensureCoverage, type ExplainInput } from './explainShots';
import {
  DEPTH_PLANS,
  buildPedagogyPrompt,
  resolveLevelProfile,
  type ExplainDepth,
} from './explainPedagogy';

export type { ShotDraft, ExplainInput };
export type { ExplainDepth };

/** 本次脚本质量：是否靠抢救拿到、是否被截断、有多少镜是题库自动补的 */
export interface ScriptQuality {
  salvaged: boolean;
  truncated: boolean;
  autoFilled: number;
}

const NARRATION_LANG_LABEL: Record<Language, string> = {
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

function buildSystem(input: ExplainInput): string {
  const target = NARRATION_LANG_LABEL[input.language] ?? 'English';
  const depth: ExplainDepth = input.depth ?? 'medium';
  const plan = DEPTH_PLANS[depth];
  const profile = resolveLevelProfile({
    language: input.language,
    examLabel: input.examLabel,
    examId: input.examId,
  });
  const unit = input.language === 'en' ? 'words' : 'characters';

  return `You are an expert ${target} exam coach teaching Chinese-speaking learners. You produce a shot-by-shot script for an AI explainer video. Learner level: ${profile.label}.

OUTPUT DISCIPLINE: compact JSON (no indentation), every shot's "narration" written out in full. The last shot must be the "takeaway" — never let the script end mid-array.

LANGUAGE RULE (critical, most common failure):
- "narration" MUST be spoken ${target} only — the TTS voice is a native ${target} voice. If you write Chinese in narration, the audio becomes gibberish. Chinese is allowed ONLY inside quoted source sentences (those are ${target} text anyway).
- Self-check before output: read every narration line. If it is Chinese prose (not a ${target} sentence with a quote inside), rewrite it in ${target}.
- Good narration (${target}): ${profile.sample}
- BAD narration (must never appear): "这道题考察的是理解间接变化。" / "选项A是立即赞成，文中没有。"
- No markdown, no brackets, no emoji, no stage directions. Per-shot narration <= ${plan.charCap} ${unit}.
- "caption", "structure", "explanation", "translation", "pointLabel", "pointText" MUST be Chinese (简体中文).

BANNED OPENERS for the "question" shot: "这道题考察的是…", "本题…", "我们来看第N题", "이 문제는…". Open with a question or a scene instead, e.g. 「分別が始まったころ、町の人たちはどう感じていたと思いますか。」

ANSWER RULE (critical):
- You are GIVEN the correct answer index for each question. NEVER change it. Never say "choose X" in narration; instead explain WHY in ${target}.
- Every question MUST have exactly one "answer" shot whose "picked" equals the given answer index, and one "question" shot.
- DO NOT repeat the prompt or the options in "eliminate" / "answer" shots. The renderer takes them from the question bank; copied text is discarded and only wastes your token budget. Give "picked" (a number) and the narration.

EVIDENCE RULE:
- Each "passage" shot MUST copy one exact sentence from the article body into "evidence" (character-for-character) and give its 0-based "paragraph". If you cannot copy exactly, set "evidence" empty and only give "paragraph".
- Each "grammar" shot MUST copy one exact sentence from the body into "sentence".

SHOT FIELDS (what each kind must carry):
- cover: narration = why this article is worth 3 minutes, in one hook; caption = title + level.
- question: copy prompt + options; narration = the HOOK and what is being tested (not a second reading of the prompt).
- passage: evidence + paragraph; narration = which sentence is the proof and why it beats its neighbours.
- grammar: sentence + structure + explanation + translation; narration = dismantle the structure with the level tools.
- eliminate: "picked" = correct index (number only, no prompt/options); narration = kill distractors by NAME, pointing at the betraying word.
- answer: "picked" = correct index (number only, no prompt/options); narration = why the correct option matches the evidence.
- point: pointLabel (<=8 字) + pointText (<=40 字); narration = the transferable move.
- takeaway: narration = the memorisable anchor; caption = the same anchor in Chinese.

${buildPedagogyPrompt(profile, plan, input.language)}

OUTPUT: JSON only, no code fence, no explanation. Shape: {"shots":[...]}. Each shot has: kind, questionNo (for question-related shots), narration, caption, plus kind-specific fields.`;
}

function buildUser(input: ExplainInput): string {
  const questions = input.questions.map((q, i) => ({
    no: i,
    prompt: q.prompt,
    options: q.options,
    correctIndex: q.answer,
    correctText: q.options[q.answer] ?? '',
    existingExplanation: q.explain ?? '',
  }));
  const plan = DEPTH_PLANS[input.depth ?? 'medium'];
  const profile = resolveLevelProfile({
    language: input.language,
    examLabel: input.examLabel,
    examId: input.examId,
  });
  return JSON.stringify(
    {
      level: { band: profile.band, label: profile.label, examLabel: input.examLabel ?? null },
      depth: { id: plan.id, label: plan.label, shotsPerQuestion: plan.shotsPerQuestion },
      title: input.title,
      body: input.body,
      chineseTranslation: input.translation,
      vocab: input.vocab ?? [],
      questions,
      note: `Copy prompt/options and evidence verbatim. correctIndex is authoritative. Narration budget: ${plan.charsPerQuestion[0]}–${plan.charsPerQuestion[1]} per question, <= ${plan.charCap} per shot.`,
    },
    null,
    2,
  );
}

export interface GeneratedScript {
  shots: Shot[];
  rawShots: Shot[];
  usage?: TokenUsage;
  model: string | null;
  quality: ScriptQuality;
}

/**
 * 旁白是否真的用了目标语。
 * 用「假名 / 谚文 / 拉丁字母」占比判断：模型最常见的失败是把旁白写成中文解析
 * （中文里夹着引用的日语原句，看上去像日语，但 TTS 念出来是乱码）。
 * 阈值取 0.08：正常日语旁白假名占比通常 0.3 以上，纯中文夹日语引文往往 < 0.05。
 */
export function narrationInTargetLanguage(
  shots: Array<{ narration: string }>,
  language: Language,
): { ok: boolean; ratio: number } {
  if (shots.length === 0) return { ok: true, ratio: 1 };
  const marker = language === 'ja'
    ? /[\u3040-\u30ff]/g
    : language === 'ko'
      ? /[\uac00-\ud7af]/g
      : /[a-zA-Z]/g;
  let good = 0;
  for (const shot of shots) {
    const text = shot.narration ?? '';
    const hits = (text.match(marker) ?? []).length;
    const ratio = hits / Math.max(1, text.length);
    if (ratio >= 0.08) good += 1;
  }
  return { ok: good / shots.length >= 0.7, ratio: good / shots.length };
}

export async function generateExplainScript(input: ExplainInput): Promise<GeneratedScript> {
  const { config } = resolveLlmConfig();
  if (!config) {
    throw new UpstreamError('还没有配置大模型线路，无法生成讲解脚本。请在设置里配置后再试。');
  }
  const plan = DEPTH_PLANS[input.depth ?? 'medium'];
  const target = NARRATION_LANG_LABEL[input.language] ?? 'English';
  const meta: { localRepaired?: boolean; modelRetried?: boolean; truncated?: boolean } = {};
  /** 抢救器的最近一次结果，用于日志与质量标记 */
  let rescued: ScriptParseResult | null = null;

  /**
   * 宽松校验：严格 zod 过了就直接用；过不了就让抢救器按对象粒度再捞一遍。
   * 捞回来的草稿已经在抢救器里逐镜过了一遍 ShotDraftSchema，可信。
   */
  const scriptParser = {
    safeParse(value: unknown) {
      const strict = ScriptSchema.safeParse(value);
      if (strict.success) return strict;
      const drafts = coerceScriptValue(value, input.questions.length);
      if (drafts.length > 0) return { success: true as const, data: { shots: drafts } };
      return strict as { success: boolean; data?: { shots: ShotDraft[] }; error?: { issues: Array<{ path: (string | number)[]; message: string }> } };
    },
  };

  /**
   * 文本级抢救。捞回来的量太少时返回 null，把机会让给「加预算重生成」——
   * 只有 2 个镜的残缺脚本配不上一条要花几分钟配音的视频。
   */
  const tolerant = (raw: string): unknown | null => {
    const parsed = parseScriptText(raw, input.questions.length);
    rescued = parsed;
    logger.info('explain script parse attempt', {
      articleId: input.articleId,
      stage: parsed.stage,
      shots: parsed.drafts.length,
      rejected: parsed.rejected,
      truncated: parsed.truncated,
    });
    // 抢救回来的量太少就别用：长档要 20 镜，只捞到 6 镜等于给学生看半节课
    const q = input.questions.length;
    const minimum = plan.id === 'short'
      ? Math.min(2, q + 1)
      : plan.id === 'medium'
        ? Math.min(q + 1, 6)
        : Math.min(q * 3, 14);
    return parsed.drafts.length >= minimum ? { shots: parsed.drafts } : null;
  };

  let drafts: ShotDraft[] = [];
  let quality: ScriptQuality = { salvaged: false, truncated: false, autoFilled: 0 };
  /**
   * 脚本请求次数（含语种纠错重写）。
   * 用量不在这里逐次快照 —— llm 层已把每次调用（含换线路、加预算重发）累加到 config.usage 上，
   * 再按次求和会重复计数，成本面板就会虚高。
   */
  let scriptCalls = 0;

  /** 一次脚本请求：correction 非空时作为追加的用户消息（用于语种纠错） */
  const ask = async (correction?: string): Promise<ShotDraft[]> => {
    const messages = [
      { role: 'system' as const, content: buildSystem(input) },
      { role: 'user' as const, content: buildUser(input) },
      ...(correction ? [{ role: 'user' as const, content: correction }] : []),
    ];
    const result = await chatJson<{ shots: ShotDraft[] }>(config, messages, scriptParser, {
      // 长档 20+ 镜、每题 400+ 字，6000 必然截断；预算跟着档位走
      maxTokens: plan.maxTokens,
      // 输出体量决定生成耗时：默认 90s 会把精讲档误判成超时
      timeoutMs: plan.requestTimeoutMs,
      temperature: 0.4,
      // 脚本一次输出几千 token，单条线路重试会成倍拉长等待；失败就换下一条线路
      retries: 0,
      meta,
      tolerant,
    });
    scriptCalls += 1;
    return result.shots;
  };

  try {
    drafts = await ask();

    /**
     * 语种兜底：旁白被写成中文是最常见也最致命的失败——字幕看着像样，
     * 但 TTS 用日语/英语音色念中文就是乱码。检测到就带明确纠错再要一次；
     * 两次都不合格就中止，宁可不生成，也别产出听不了的视频。
     */
    const first = narrationInTargetLanguage(drafts, input.language);
    if (!first.ok) {
      logger.warn('explain narration not in target language, retrying with correction', {
        articleId: input.articleId,
        language: input.language,
        okRatio: first.ratio,
      });
      drafts = await ask(
        `LANGUAGE FAILURE: ${Math.round((1 - first.ratio) * 100)}% of your "narration" lines were not ${target}. Rewrite the ENTIRE script now. Every "narration" must be a spoken ${target} sentence; Chinese only in caption / structure / explanation / translation / pointLabel / pointText. Keep the same shot plan and the same correct answers.`,
      );
      const second = narrationInTargetLanguage(drafts, input.language);
      if (!second.ok) {
        const failure = new UpstreamError(
          `模型没有按${target}写旁白（仅 ${Math.round(second.ratio * 100)}% 合格），已停止生成以免配音念成乱码。请重试，或在设置里换一条更稳的模型线路。`,
          { hint: '把中文解析写进旁白是常见退化；换线路或降一档深度通常能避开' },
        );
        (failure as UpstreamError & { narrationLanguage?: boolean }).narrationLanguage = true;
        throw failure;
      }
    }

    const repairedInfo = rescued as ScriptParseResult | null;
    quality.salvaged = Boolean(meta.localRepaired || meta.modelRetried);
    quality.truncated = Boolean(repairedInfo?.truncated || meta.truncated);
  } catch (err) {
    // 语种不合格是「内容错误」，不是解析错误，不能再拿残缺原文去抢救
    if ((err as { narrationLanguage?: boolean }).narrationLanguage) throw err;
    // 最后一道：两次调用都没交出可用 JSON，但原文里也许还有写完的分镜 —— 按可用部分生成
    const rawOutput = (err as { rawOutput?: string }).rawOutput;
    const fallback = rawOutput ? parseScriptText(rawOutput, input.questions.length) : null;
    if (fallback && fallback.drafts.length > 0) {
      drafts = fallback.drafts;
      quality = { salvaged: true, truncated: fallback.truncated, autoFilled: 0 };
      logger.warn('explain script rescued from failed parse', {
        articleId: input.articleId,
        stage: fallback.stage,
        shots: fallback.drafts.length,
        rejected: fallback.rejected,
      });
    } else {
      logger.warn('explain script generation failed', {
        articleId: input.articleId,
        err: (err as Error).message,
      });
      throw new UpstreamError(`讲解脚本生成失败：${(err as Error).message}`, {
        hint: '可点「重试」；若反复失败，换一条模型线路，或缩短文章篇幅后重试',
      });
    }
  }

  const covered = ensureCoverage(assembleShots(drafts, input), input);
  quality.autoFilled = covered.autoFilled;
  const assembled = covered.shots;
  if (assembled.length === 0) throw new UpstreamError('讲解脚本没有生成任何可用分镜，请重试');

  // llm 层已累加全部调用（含换线路、加预算重发、语种纠错重写）的用量，直接取总值
  const usage: TokenUsage | undefined = config.usage ? { ...config.usage } : undefined;

  /**
   * 旁白密度：每题字数有没有落到计划区间。
   * 模型最容易的退化是写成电文体（语法对、信息在，但不像讲课），所以要把字数打进日志，
   * 才能按真实产物校准 charsPerQuestion，而不是凭感觉调提示词。
   */
  const perQuestionChars = new Map<number, number>();
  for (const shot of assembled) {
    const key = shot.questionNo ?? -1;
    perQuestionChars.set(key, (perQuestionChars.get(key) ?? 0) + (shot.narration ?? '').length);
  }
  const questionChars = [...perQuestionChars.entries()]
    .filter(([no]) => no >= 0)
    .map(([, chars]) => chars);
  const avgChars = questionChars.length
    ? Math.round(questionChars.reduce((sum, n) => sum + n, 0) / questionChars.length)
    : 0;
  const thin = questionChars.filter((chars) => chars < plan.charsPerQuestion[0] * 0.8).length;
  if (thin > 0) {
    logger.warn('explain narration thinner than planned', {
      articleId: input.articleId,
      depth: plan.id,
      questions: questionChars.length,
      thin,
      avgChars,
      floor: plan.charsPerQuestion[0],
    });
  }

  logger.info('explain script generated', {
    articleId: input.articleId,
    shots: assembled.length,
    questions: input.questions.length,
    depth: plan.id,
    model: config.usedModel ?? config.model,
    salvaged: quality.salvaged,
    truncated: quality.truncated,
    autoFilled: quality.autoFilled,
    scriptCalls,
    avgCharsPerQuestion: avgChars,
    // 字段名避开 logger 的脱敏关键词（含 "token" 会被打码成 ***），否则成本不可观测
    tokIn: usage?.promptTokens ?? 0,
    tokOut: usage?.completionTokens ?? 0,
    tokTotal: usage?.totalTokens ?? 0,
  });
  return {
    shots: assembled,
    rawShots: assembled,
    usage,
    model: config.usedModel ?? config.model ?? null,
    quality,
  };
}

export { computeServerTimeline };
