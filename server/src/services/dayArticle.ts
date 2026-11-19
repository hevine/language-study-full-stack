import { findExam, getLanguage } from '../catalog';
import type { ArticlePayload, GeneratedDay, PlanRecord, Question, ReadingSegment, VocabEntry } from '../domain/types';
import { repairJson } from '../lib/jsonRepair';
import { logger } from '../lib/logger';
import { chat, type LlmConfig } from './llm';

/**
 * 单篇今日材料的生成、抢救与拼装。
 *
 * 旧实现一次要模型吐出「精读 + 泛读」两整套文章（正文 / 译文 / 词表 / 题目 / 朗读分段），
 * 6000 → 10000 token 仍常在 JSON 中途被 length 掐断；更糟的是重试等于从头再写一遍，
 * 两次调用的产出一起被丢掉，token 全白花。
 *
 * 现在的策略：
 * 1. 一次只生成一篇文章，且字段顺序按「正文 → 译文 → 词表 → 题目 → 朗读分段」排列，
 *    越靠前越值钱，截断时前面的内容仍然完整；
 * 2. 输出不完整时先用 repairJson 把残缺 JSON 救成对象，逐字段抽出已经写完的部分；
 * 3. 只对缺失字段发一次「补丁」小请求，不再重复生成已有正文；
 * 4. 补丁也失败就用内置库补齐缺失字段，但模型已经写出的正文一定保留并落库。
 */

export type ArticleKind = 'intensive' | 'extensive';

/** 宽松草稿：任何字段都可能因截断而缺失，逐字段独立校验、互不牵连 */
export interface ArticleDraft {
  title?: string;
  body?: string;
  translation?: string;
  vocab: VocabEntry[];
  questions: Question[];
  segments: ReadingSegment[];
}

export type ArticleStatus = 'llm' | 'partial' | 'library';

export interface GenerateArticleResult {
  payload: ArticlePayload;
  status: ArticleStatus;
  /** 哪些字段不是模型本次写出来的（内置库补齐或本地切分） */
  patched: string[];
  /** 第一次调用是否确实拿到了模型写的正文——决定「token 有没有白花」 */
  salvagedBody: boolean;
  /** 这次是否发生过「截断抢救 / 只补缺字段」，用于给一条正向反馈 */
  recovered?: boolean;
  error?: unknown;
}

interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

const EN_SYSTEM = `你是一位资深英语考试教研员，熟悉托福 iBT、雅思 Academic、大学英语四六级与考研英语的官方考纲、评分标准以及近五年真题的命题规律。
你的任务是按给定参数产出可以直接用于「背诵 + 朗读」的教学材料：文章必须是原创，不得复制真题或教材原文；题型与话题分布必须贴合目标考试。
你只输出 JSON，不输出任何解释性文字、不使用 markdown 代码块。`;

const JA_SYSTEM = `あなたは日本語教育の専門家で、JLPT の出題基準・語彙表・過去問の傾向に詳しい。
与えられた条件に従い、「暗唱」と「音読」にそのまま使える学習教材を作成する。文章はオリジナルとし、過去問や教科書の本文をそのまま使ってはならない。
出力は JSON のみ。説明文や markdown のコードブロックは一切付けない。`;

const KO_SYSTEM = `당신은 한국어교육 전문가이며, TOPIK의 출제 기준·어휘 범위·기출문제 경향에 정통하다.
주어진 조건에 따라 '암송'과 '읽기 연습'에 바로 쓸 수 있는 학습 자료를 작성한다. 글은 반드시 오리지널이어야 하며 기출문제나 교재의 본문을 그대로 가져와서는 안 된다.
중국어 학습자를 위해 본문은 한국어로, 번역·해설·tips는 중국어로 작성한다.
출력은 JSON만. 설명이나 마크다운 코드블록은 절대 붙이지 않는다.`;

const SYSTEM: Record<string, string> = { en: EN_SYSTEM, ja: JA_SYSTEM, ko: KO_SYSTEM };

const LABEL: Record<string, { article: string; body: string; translation: string; term: string; example: string }> = {
  en: { article: '英文标题', body: '正文', translation: '中文译文', term: '单词或短语', example: '原文中的例句' },
  ja: { article: '日本語のタイトル', body: '本文', translation: '中国語訳', term: '単語・表現', example: '本文中の例文' },
  ko: { article: '한국어 제목', body: '본문', translation: '중국어 번역', term: '단어·표현', example: '본문 속 예문' },
};

interface ArticleSpec {
  /** 写进提示词的期望条数 */
  vocabMin: number;
  vocabMax: number;
  questionMin: number;
  questionMax: number;
  segmentMin: number;
  segmentMax: number;
  /** 低于这条线才算「缺字段」，才值得再发一次补丁请求 */
  acceptVocab: number;
  acceptQuestions: number;
  bodyChars: number;
  maxTokens: number;
}

/** 泛读比精读短得多，单独给预算，别让两篇挤在一次输出里 */
function specFor(kind: ArticleKind, textLength: { intensive: number; extensive: number }): ArticleSpec {
  const isIntensive = kind === 'intensive';
  return {
    vocabMin: isIntensive ? 5 : 3,
    vocabMax: isIntensive ? 8 : 5,
    questionMin: isIntensive ? 2 : 0,
    questionMax: isIntensive ? 3 : 1,
    segmentMin: 3,
    segmentMax: 5,
    // 期望值 ≠ 可用下限：模型少给一两个词就直接收下，别为凑数再烧一次调用
    acceptVocab: 3,
    acceptQuestions: isIntensive ? 2 : 0,
    bodyChars: isIntensive ? textLength.intensive : textLength.extensive,
    maxTokens: isIntensive ? 3200 : 2400,
  };
}

function contextBlock(plan: PlanRecord, day: GeneratedDay, kind: ArticleKind): string {
  const exam = findExam(plan.examId);
  const lang = getLanguage(plan.language);
  const level = lang.levels.find((item) => item.id === plan.currentLevelId);
  const target = exam.targets.find((item) => item.score === plan.targetScore) ?? exam.targets[0];
  const spec = specFor(kind, exam.textLength);
  return [
    `【考试】${exam.name}（${exam.scaleLabel}）／ 目标：${target.label}`,
    `【备考阶段】第 ${day.weekIndex + 1} 周 / 共 ${plan.weeks} 周 · ${day.phaseName}`,
    `【今日主题】${day.theme}`,
    `【本阶段重点】${day.focus.join('、')}`,
    `【考生水平】${level?.name ?? plan.currentLevelName}，词汇量约 ${level?.vocab ?? 0}`,
    `【考纲要点】${exam.syllabus.join('；')}`,
    `【本篇】${kind === 'intensive' ? '精读（篇幅较长、需附理解题）' : '泛读 / 听力（篇幅更短、更口语化）'}`,
    `【篇幅】正文约 ${spec.bodyChars} ${plan.language === 'en' ? '词' : '字'}`,
  ].join('\n');
}

/**
 * 单篇文章的提示词。字段顺序是刻意设计的：正文与译文排在前面，
 * 词表、题目、朗读分段排在后面——真被截断时，最值钱的部分已经写完了。
 */
export function buildArticleMessages(plan: PlanRecord, day: GeneratedDay, kind: ArticleKind): PromptMessage[] {
  const exam = findExam(plan.examId);
  const spec = specFor(kind, exam.textLength);
  const l = LABEL[plan.language] ?? LABEL.en;
  const context = contextBlock(plan, day, kind);

  const shape = `{
  "title": "${l.article}",
  "body": "${l.body}（段落之间用空行分隔）",
  "translation": "${l.translation}（与原文逐段对应）",
  "vocab": [{"term":"${l.term}","reading":"读音或音标","pos":"词性","meaning":"中文释义","example":"${l.example}"}],
  "questions": [{"prompt":"题干","options":["选项1","选项2","选项3"],"answer":0,"explain":"中文解析"}],
  "readingScript": {"segments":[{"text":"重点句群","translation":"该句群译文","tips":["停顿或语调提示"]}]}
}`;

  const rules = [
    `1. 输出且只输出一个 JSON 对象，不要包在 intensive / extensive 里，不要 markdown 代码块。`,
    `2. 严格按上面字段顺序写：title → body → translation → vocab → questions → readingScript。`,
    `3. 题材围绕「${day.theme}」，贴合 ${exam.name} 的典型文体，文章必须原创。`,
    `4. vocab 给 ${spec.vocabMin}–${spec.vocabMax} 个，必须出现在正文中。`,
    `5. questions 给 ${spec.questionMin}–${spec.questionMax} 题，answer 是正确选项下标（从 0 开始）；若为 0 题就给空数组 []。`,
    `6. readingScript.segments 只挑 ${spec.segmentMin}–${spec.segmentMax} 个重点句群，不要重复抄写整篇正文，tips 每条不超过一句。`,
    `7. 译文要地道，不要逐字硬译。`,
    `8. 最重要：篇幅不够时宁可少给词表项和分段，也必须把 JSON 完整闭合；绝不要在字符串中途停下。`,
  ].join('\n');

  const user = `请生成 ${day.date} 的${kind === 'intensive' ? '精读' : '泛读'}材料。\n\n${context}\n\nJSON 结构：\n${shape}\n\n要求：\n${rules}`;

  return [
    { role: 'system', content: SYSTEM[plan.language] ?? EN_SYSTEM },
    { role: 'user', content: user },
  ];
}

/** 缺什么补什么：只把已生成正文的节选传回去，让模型输出一个很短的补丁 JSON */
export function buildPatchMessages(
  plan: PlanRecord,
  day: GeneratedDay,
  draft: ArticleDraft,
  missing: string[],
  kind: ArticleKind,
): PromptMessage[] {
  const exam = findExam(plan.examId);
  const spec = specFor(kind, exam.textLength);
  const wanted: string[] = [];
  if (missing.includes('translation')) {
    wanted.push(`"translation": "把下面正文逐段译成自然的中文"`);
  }
  if (missing.includes('vocab')) {
    const need = Math.max(1, spec.acceptVocab - draft.vocab.length);
    wanted.push(
      `"vocab": [{"term":"词","reading":"读音","pos":"词性","meaning":"中文释义","example":"正文中的例句"}]（再给 ${need} 个）`,
    );
  }
  if (missing.includes('questions')) {
    const need = Math.max(1, spec.acceptQuestions - draft.questions.length);
    wanted.push(
      `"questions": [{"prompt":"题干","options":["A","B","C"],"answer":0,"explain":"中文解析"}]（再给 ${need} 题）`,
    );
  }
  if (missing.includes('segments')) {
    wanted.push(
      `"readingScript": {"segments":[{"text":"正文中的重点句群","translation":"译文","tips":["朗读提示"]}]}（${spec.segmentMin} 段）`,
    );
  }

  const excerpt = (draft.body ?? '').slice(0, 1400);
  const user = [
    `下面是一篇围绕「${day.theme}」的${kind === 'intensive' ? '精读' : '泛读'}正文，词表 / 题目 / 朗读分段还没来得及输出就被截断了。`,
    `请只输出一个 JSON 补丁对象，补齐以下字段，不要重复正文、不要重写整篇文章、不要任何解释文字：`,
    `{`,
    wanted.join(',\n'),
    `}`,
    ``,
    `正文节选：`,
    `"""${excerpt}"""`,
  ].join('\n');

  return [
    { role: 'system', content: (SYSTEM[plan.language] ?? EN_SYSTEM) + '\n本次只输出补丁 JSON 对象，字段越少越好。' },
    { role: 'user', content: user },
  ];
}

function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

/** 截断常停在句子中间：裁到最后一个完整句末标点，别把半句话当正文保存 */
export function trimToSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/[.!?。！？…；;”"』」）)\]]\s*$/.test(trimmed)) return trimmed;
  const match = [...trimmed.matchAll(/[.!?。！？…；;]/g)];
  const last = match[match.length - 1];
  if (!last || (last.index ?? 0) < trimmed.length * 0.5) return trimmed;
  return trimmed.slice(0, (last.index ?? 0) + last[0].length).trim();
}

function pickVocab(value: unknown): VocabEntry[] {
  if (!Array.isArray(value)) return [];
  const out: VocabEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const term = asString(item.term);
    const meaning = asString(item.meaning);
    if (!term || !meaning) continue;
    out.push({
      term,
      reading: asString(item.reading) ?? '',
      pos: asString(item.pos) ?? '',
      meaning,
      example: asString(item.example) ?? '',
    });
  }
  return out;
}

function pickQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  const out: Question[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const prompt = asString(item.prompt);
    const options = Array.isArray(item.options)
      ? item.options.map((option) => asString(option) ?? '').filter(Boolean)
      : [];
    if (!prompt || options.length < 2) continue;
    const answer = Number.isInteger(item.answer) ? Math.max(0, Number(item.answer)) : 0;
    out.push({ prompt, options, answer: Math.min(answer, options.length - 1), explain: asString(item.explain) ?? '' });
  }
  return out;
}

function pickSegments(value: unknown): ReadingSegment[] {
  if (!Array.isArray(value)) return [];
  const script = Array.isArray(value) ? { segments: value } : (value as { segments?: unknown } | null);
  const list = script && typeof script === 'object' && 'segments' in script ? script.segments : value;
  if (!Array.isArray(list)) return [];
  const out: ReadingSegment[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const text = asString(item.text);
    if (!text) continue;
    out.push({
      text: trimToSentence(text),
      translation: asString(item.translation) ?? '',
      tips: Array.isArray(item.tips) ? item.tips.map((tip) => asString(tip) ?? '').filter(Boolean) : [],
    });
  }
  return out;
}

/** 从任意形状的对象里逐字段抽取：顶层文章 / 旧版 {intensive,extensive} / 补丁对象都兼容 */
export function draftFromUnknown(value: unknown, kind: ArticleKind = 'intensive'): ArticleDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let obj = value as Record<string, unknown>;
  // 模型偶尔仍按老格式包一层，取对应那篇，别让整批内容作废
  if (!asString(obj.body) && (obj.intensive || obj.extensive)) {
    const nested = kind === 'intensive' ? obj.intensive : obj.extensive;
    if (nested && typeof nested === 'object') obj = nested as Record<string, unknown>;
  }
  const draft: ArticleDraft = {
    title: asString(obj.title),
    body: trimToSentence(asString(obj.body) ?? ''),
    translation: asString(obj.translation),
    vocab: pickVocab(obj.vocab),
    questions: pickQuestions(obj.questions),
    segments: pickSegments(obj.readingScript ?? obj.segments ?? []),
  };
  if (!draft.title && !draft.body && !draft.translation && draft.vocab.length === 0 && draft.segments.length === 0) {
    return null;
  }
  return draft;
}

/** 严格解析失败时走这里：repairJson 补齐 / 裁切后再逐字段抢救 */
export function salvageDraft(raw: string, kind: ArticleKind = 'intensive'): ArticleDraft | null {
  const text = stripFence(raw);
  if (!text) return null;
  try {
    return draftFromUnknown(JSON.parse(text), kind);
  } catch {
    const repaired = repairJson(text);
    if (!repaired.ok) return null;
    return draftFromUnknown(repaired.value, kind);
  }
}

function missingFields(draft: ArticleDraft, spec: ArticleSpec): string[] {
  const missing: string[] = [];
  if (!draft.translation) missing.push('translation');
  if (draft.vocab.length < spec.acceptVocab) missing.push('vocab');
  if (spec.acceptQuestions > 0 && draft.questions.length < spec.acceptQuestions) missing.push('questions');
  // 朗读分段不值得再调模型：本地按句切就能保证可朗读
  return missing;
}

function mergeDraft(target: ArticleDraft, patch: ArticleDraft): void {
  if (!target.title && patch.title) target.title = patch.title;
  if (!target.translation && patch.translation) target.translation = patch.translation;
  if (patch.vocab.length) {
    const seen = new Set(target.vocab.map((item) => item.term.toLowerCase()));
    for (const item of patch.vocab) {
      if (!seen.has(item.term.toLowerCase())) {
        target.vocab.push(item);
        seen.add(item.term.toLowerCase());
      }
    }
  }
  if (patch.questions.length) {
    const seen = new Set(target.questions.map((item) => item.prompt));
    for (const item of patch.questions) {
      if (!seen.has(item.prompt)) {
        target.questions.push(item);
        seen.add(item.prompt);
      }
    }
  }
  if (patch.segments.length) {
    const seen = new Set(target.segments.map((item) => item.text));
    for (const item of patch.segments) {
      if (!seen.has(item.text)) {
        target.segments.push(item);
        seen.add(item.text);
      }
    }
  }
}

/** 没有朗读分段时，本地按句切，保证「朗读全文 / 长难句」仍然可用 */
export function localSegments(body: string, language: string): ReadingSegment[] {
  const paragraphs = body.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const paragraph of paragraphs) {
    // 英语靠句末空格断句；日韩语句末标点后通常没有空格，直接按标点切
    const splitter = language === 'en' ? /(?<=[.!?…])\s+/ : /(?<=[。！？…])/;
    const pieces = paragraph
      .split(splitter)
      .map((item) => item.trim())
      .filter(Boolean);
    sentences.push(...pieces);
  }
  if (sentences.length === 0 && body.trim()) sentences.push(body.trim());

  const segments: ReadingSegment[] = [];
  for (let i = 0; i < sentences.length && segments.length < 8; i += 2) {
    const text = sentences.slice(i, i + 2).join(language === 'en' ? ' ' : '').trim();
    if (!text) continue;
    segments.push({
      text,
      translation: '',
      tips: [language === 'en' ? '按意群停顿，句末降调' : '按文节停顿，注意句末语调'],
    });
  }
  return segments;
}

/** 把抢救出的草稿与内置库文章拼成一份完整、可直接上课的材料 */
export function composeArticle(
  draft: ArticleDraft | null,
  fallback: ArticlePayload,
  plan: PlanRecord,
  kind: ArticleKind,
): GenerateArticleResult {
  const exam = findExam(plan.examId);
  const spec = specFor(kind, exam.textLength);
  const patched: string[] = [];

  // 正文太短说明截在开头，抢救价值不大，整篇用内置库
  const hasBody = Boolean(draft?.body && draft.body.length >= 40);
  if (!hasBody) {
    return {
      payload: fallback,
      status: 'library',
      patched: ['whole'],
      salvagedBody: false,
    };
  }

  const body = draft!.body!;
  const title = draft!.title || fallback.title;
  if (!draft!.title) patched.push('title');

  let translation = draft!.translation ?? '';
  if (!translation) patched.push('translation');

  let vocab = draft!.vocab.slice();
  if (vocab.length < spec.acceptVocab) {
    const seen = new Set(vocab.map((item) => item.term.toLowerCase()));
    for (const item of fallback.vocab) {
      if (vocab.length >= spec.acceptVocab) break;
      if (seen.has(item.term.toLowerCase())) continue;
      vocab.push(item);
      seen.add(item.term.toLowerCase());
    }
    patched.push('vocab');
  }

  let questions = draft!.questions.slice();
  if (spec.acceptQuestions > 0 && questions.length < spec.acceptQuestions) {
    const seen = new Set(questions.map((item) => item.prompt));
    for (const item of fallback.questions) {
      if (questions.length >= spec.acceptQuestions) break;
      if (seen.has(item.prompt)) continue;
      questions.push(item);
      seen.add(item.prompt);
    }
    patched.push('questions');
  }
  if (spec.questionMin === 0) questions = questions.slice(0, spec.questionMax);

  let segments = draft!.segments.slice(0, 8);
  if (segments.length === 0) {
    // 本地按句切是常规兜底，不算「材料被内置库替换」，不必惊动用户
    segments = localSegments(body, plan.language);
  }

  const payload: ArticlePayload = {
    title,
    body,
    translation,
    vocab,
    questions,
    readingScript: { segments },
  };

  return {
    payload,
    status: patched.length === 0 ? 'llm' : 'partial',
    patched,
    salvagedBody: true,
  };
}

/**
 * 生成一篇文章：完整 → 直接返回；不完整 → 抢救 + 只补缺字段 → 仍缺的用内置库补齐。
 * 只要第一次调用写出了正文，这份正文就一定会被返回并落库。
 */
export async function generateArticle(
  config: LlmConfig,
  plan: PlanRecord,
  day: GeneratedDay,
  kind: ArticleKind,
  fallback: ArticlePayload,
): Promise<GenerateArticleResult> {
  const exam = findExam(plan.examId);
  const spec = specFor(kind, exam.textLength);
  const messages = buildArticleMessages(plan, day, kind);

  let raw = '';
  const meta: { truncated?: boolean } = {};
  try {
    raw = await chat(config, messages, {
      temperature: 0.75,
      maxTokens: spec.maxTokens,
      retries: 1,
      meta,
    });
    const draft = salvageDraft(raw, kind);
    if (!draft) throw new Error('JSON 无法解析，也没有可抢救的字段');
    const missing = missingFields(draft, spec);
    if (missing.length === 0) {
      logger.info('day article generated in one pass', { kind, date: day.date });
      return composeArticle(draft, fallback, plan, kind);
    }

    logger.warn('day article incomplete, requesting patch instead of regenerating', {
      kind,
      date: day.date,
      missing,
      chars: raw.length,
      truncated: Boolean(meta.truncated),
    });

    // 只补缺字段：输出量很小，几乎不会再被截断；也不重复生成已经写好的正文
    try {
      const patchRaw = await chat(config, buildPatchMessages(plan, day, draft, missing, kind), {
        temperature: 0.5,
        maxTokens: 2000,
        retries: 0,
      });
      const patch = salvageDraft(patchRaw, kind);
      if (patch) mergeDraft(draft, patch);
    } catch (patchErr) {
      logger.warn('day article patch failed, filling from library', {
        kind,
        message: (patchErr as Error).message,
      });
    }
    const result = composeArticle(draft, fallback, plan, kind);
    result.status = result.patched.length === 0 ? 'llm' : 'partial';
    result.recovered = true;
    return result;
  } catch (err) {
    // 网络 / Key 错误时 raw 可能为空；若已有正文，仍抢救出来，别让额度白花
    const draft = raw ? salvageDraft(raw, kind) : null;
    if (draft) {
      logger.warn('day article request failed but body salvaged', { kind, message: (err as Error).message });
      const result = composeArticle(draft, fallback, plan, kind);
      result.error = err;
      result.recovered = true;
      return result;
    }
    // 截断但连正文都没写出来：把标记带上，上层才能给出「输出被截断」而不是笼统的「生成失败」
    if (meta.truncated) (err as { truncatedOutput?: boolean }).truncatedOutput = true;
    return { payload: fallback, status: 'library', patched: ['whole'], salvagedBody: false, error: err };
  }
}
