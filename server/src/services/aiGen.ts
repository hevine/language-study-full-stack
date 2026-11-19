import { createHash } from 'node:crypto';
import { z } from 'zod';
import { findExam, getLanguage } from '../catalog';
import type { GeneratedDay, PlanRecord, Task } from '../domain/types';
import { requireLanguage, type Language } from '../domain/language';
import { ConflictError, UpstreamError } from '../lib/errors';
import { logger } from '../lib/logger';
import { listDayContents } from '../repositories/content';
import {
  bankStats,
  deleteBankItem,
  findRecentRun,
  insertBankItems,
  insertRun,
  listBank,
  recentStems,
  updateRunNewCount,
  type AiBankItemView,
  type AiBankStats,
  type AiItem,
  type AiItemType,
  type AiNewItem,
} from '../repositories/aiBank';
import { currentUserId } from '../auth/requestScope';
import { listWords, upsertWords } from '../repositories/vocab';
import { providerForBaseUrl } from '../content/llmProviders';
import { chatJson, resolveLlmConfig, type TokenUsage } from './llm';
import { formatPatternForPrompt, grammarPatternsFor } from './grammarBook';

/** 支持 AI 加练的任务类型：复习、事务类任务没有可生成的练习 */
export const AI_KINDS = ['vocab', 'read', 'listen', 'speak', 'grammar', 'write'] as const;
export type AiKind = (typeof AI_KINDS)[number];

export function isAiKind(kind: string): kind is AiKind {
  return (AI_KINDS as readonly string[]).includes(kind);
}

/** 5 分钟内同一批次直接复用，避免手滑连点把额度烧掉 */
export const AI_CACHE_MS = 5 * 60 * 1000;

export const AI_KIND_LABEL: Record<AiKind, string> = {
  vocab: '词汇',
  read: '精读',
  listen: '精听',
  speak: '口语',
  grammar: '拆句',
  write: '写作',
};

interface KindPlan {
  /** 出多少条、每条什么类型 */
  count: number;
  types: AiItemType[];
  /** 单次生成的 token 预算 */
  maxTokens: number;
  /** 给模型看的具体要求 */
  brief: string;
}

const KIND_PLAN: Record<AiKind, KindPlan> = {
  vocab: {
    count: 8,
    types: ['word'],
    maxTokens: 1400,
    brief: `- 出 8 个词汇，type 全部为 "word"。
- 词必须与今日主题相关、级别匹配，且不在「已知词表」里。
- 每个词给：term（词或短语）、reading（英语音标 / 日语假名 / 韩语罗马字）、pos（词性）、meaning（中文释义）、example（用该词写的例句，目标语言）、exampleCn（例句的中文翻译）。`,
  },
  read: {
    count: 7,
    types: ['quiz', 'sentence'],
    maxTokens: 2200,
    brief: `- 出 5 道阅读理解选择题，type 为 "quiz"：分别考主旨、细节、推断、词义、作者态度各一道，每题 4 个选项。
- 再出 2 个长难句，type 为 "sentence"：从今日材料里挑，给 text（原句）、translation（中文译文）、tips（2–3 条中文拆解提示：主干、从句、修饰关系）。`,
  },
  listen: {
    count: 6,
    types: ['quiz', 'sentence'],
    maxTokens: 2000,
    brief: `- 出 4 道听力理解选择题，type 为 "quiz"：围绕今日材料的场景与观点，考主旨、细节、说话人态度、推断各一道，每题 4 个选项。
- 再出 2 个听辨难点句，type 为 "sentence"：给 text（原句）、translation（中文译文）、tips（2–3 条中文提示：连读、弱读、停顿位置或易混淆音）。`,
  },
  speak: {
    count: 4,
    types: ['prompt'],
    maxTokens: 2400,
    brief: `- 出 4 个口语任务，type 全部为 "prompt"。
- 每个任务给：title（目标语言，12 字以内）、scenario（目标语言，2–3 句场景设定）、outline（中文提纲 3 条：先说什么、举什么例子、怎么收尾）、phrases（目标语言可直接套用的句型 4–5 条）、sample（目标语言范例回答 60–90 词/字）。`,
  },
  grammar: {
    count: 6,
    types: ['sentence'],
    maxTokens: 1800,
    brief: `- 出 6 个句子，type 全部为 "sentence"。
- 优先从今日材料里挑长难句，不够再用同主题、同难度的句子补齐。
- 每句给：text（原句）、translation（中文译文）、tips（2–3 条中文提示：主干是什么、从句/倒装/固定搭配在哪、容易译错的地方）。`,
  },
  write: {
    count: 1,
    types: ['prompt'],
    maxTokens: 1800,
    brief: `- 出 1 个写作任务，type 为 "prompt"。
- 给：title（目标语言，15 字以内）、scenario（目标语言，2–3 句题目情境与写作要求）、outline（中文提纲 3–4 条）、phrases（目标语言高分表达 5 条）、sample（目标语言范例段落 80–120 词/字）。`,
  },
};

const SYSTEM: Record<Language, string> = {
  en: `You are a senior English exam item writer for TOEFL iBT / IELTS Academic / CET / postgraduate entrance exams.
You write original practice material that matches the target level and exam style — never copy real test items or textbook passages.
You always reply with a single JSON object and nothing else: no prose, no markdown fences.`,
  ja: `あなたは日本語能力試験（JLPT）と日本留学試験の作問者です。
指定されたレベルと出題形式に合ったオリジナルの練習問題を作成します。過去問や教科書の本文をそのまま使ってはなりません。
返答は JSON オブジェクト 1 つのみ。説明文やマークダウンのコードブロックは付けません。`,
  ko: `당신은 한국어능력시험(TOPIK)의 출제자입니다.
지정된 급수와 출제 형식에 맞는 오리지널 연습 문제를 만듭니다. 기출문제나 교재 본문을 그대로 사용해서는 안 됩니다.
답변은 JSON 객체 하나만. 설명이나 마크다운 코드 블록은 붙이지 않습니다.`,
};

const NATIVE: Record<Language, string> = { en: '英语', ja: '日语', ko: '韩语' };

/** 把模型给的顶层结构整理成 { items, note }：容忍裸数组、别的 key 名、甚至单条对象 */
function extractBatch(value: unknown): { items: unknown[]; note: string } | null {
  if (Array.isArray(value)) return { items: value, note: '' };
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const key of ['items', 'questions', 'words', 'sentences', 'exercises', 'quizzes', 'vocab', 'data', 'result', 'results', 'list']) {
    const arr = obj[key];
    if (Array.isArray(arr) && arr.length > 0) {
      return { items: arr, note: asText(obj.note ?? obj.summary) };
    }
  }
  // 只回了单条也接住，别浪费这次调用
  if ('type' in obj || 'prompt' in obj || 'term' in obj || 'text' in obj || 'title' in obj) {
    return { items: [obj], note: '' };
  }
  return null;
}

/** 传给 chatJson 的宽容解析器：结构再歪也先接住，交给 normalizeItems 逐条抢救 */
const TolerantBatch = {
  safeParse: (value: unknown) => {
    const extracted = extractBatch(value);
    if (extracted) return { success: true as const, data: extracted };
    return {
      success: false as const,
      error: { issues: [{ path: [] as (string | number)[], message: '返回内容里找不到可用的条目数组' }] },
    };
  },
};

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    // 有的模型把数组写成「提示1；提示2」这种一句话，按常见分隔符拆开
    return value
      .split(/[；;\n]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

const QuizSchema = z.object({
  prompt: z.string().min(4),
  options: z.array(z.string().min(1)).min(2).max(6),
  answer: z.number().int().min(0),
  explain: z.string().optional().default(''),
});

const WordSchema = z.object({
  term: z.string().min(1),
  reading: z.string().optional().default(''),
  pos: z.string().optional().default(''),
  meaning: z.string().min(1),
  example: z.string().optional().default(''),
  exampleCn: z.string().optional().default(''),
});

const SentenceSchema = z.object({
  text: z.string().min(4),
  translation: z.string().min(1),
  tips: z.array(z.string()).optional().default([]),
});

const PromptSchema = z.object({
  title: z.string().min(2),
  scenario: z.string().min(4),
  outline: z.array(z.string()).optional().default([]),
  phrases: z.array(z.string()).optional().default([]),
  sample: z.string().optional().default(''),
});

/**
 * 模型经常忘写 type 或写错字段名。这里按字段形状推断类型，再把常见别名
 * （correct/answerIndex、choices、definition、tips 写成一句话……）归到标准字段。
 * 抢救出来后仍走一遍严格 schema，保证入库的东西一定是干净的。
 */
function inferItemType(entry: Record<string, unknown>): string {
  const t = typeof entry.type === 'string' ? entry.type.toLowerCase().trim() : '';
  if (['quiz', 'mcq', 'question', 'choice', '选择题'].includes(t)) return 'quiz';
  if (['word', 'vocab', 'vocabulary', 'term', '词汇'].includes(t)) return 'word';
  if (['sentence', 'grammar', '句子', '长难句'].includes(t)) return 'sentence';
  if (['prompt', 'writing', 'speaking', 'task', '写作', '口语'].includes(t)) return 'prompt';
  if ('options' in entry || 'choices' in entry || 'answer' in entry || 'correct' in entry) return 'quiz';
  if ('term' in entry || 'reading' in entry || 'definition' in entry) return 'word';
  if ('scenario' in entry || 'outline' in entry || 'phrases' in entry) return 'prompt';
  if ('translation' in entry || 'tips' in entry || 'text' in entry) return 'sentence';
  return '';
}

function answerToIndex(raw: unknown, options: string[]): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (raw >= 0 && raw < options.length) return raw;
    if (raw >= 1 && raw <= options.length) return raw - 1; // 模型按 1 开始编号
    return -1;
  }
  const text = asText(raw);
  if (!text) return -1;
  if (/^[0-9]+$/.test(text)) {
    const n = parseInt(text, 10);
    if (n < options.length) return n;
    if (n >= 1 && n <= options.length) return n - 1;
    return -1;
  }
  if (/^[A-Ha-h]$/.test(text)) {
    const idx = text.toUpperCase().charCodeAt(0) - 65;
    return idx < options.length ? idx : -1;
  }
  const key = normalizeKey(text);
  const exact = options.findIndex((option) => normalizeKey(option) === key);
  if (exact >= 0) return exact;
  // 「B. xxx」形式：剥掉字母前缀再匹配
  const stripped = text.match(/^[A-Ha-h][.、)）]\s*(.+)$/);
  if (stripped) {
    const found = options.findIndex((option) => normalizeKey(option) === normalizeKey(stripped[1]));
    if (found >= 0) return found;
  }
  return -1;
}

function coerceQuiz(entry: Record<string, unknown>): unknown | null {
  const prompt = asText(entry.prompt ?? entry.question ?? entry.stem ?? entry.title);
  if (!prompt) return null;
  const rawOptions = entry.options ?? entry.choices ?? entry.optionsList;
  let options: string[] = [];
  if (Array.isArray(rawOptions)) {
    options = rawOptions
      .map((option) =>
        typeof option === 'string'
          ? option.trim()
          : asText((option as { text?: unknown })?.text ?? (option as { label?: unknown })?.label ?? (option as { value?: unknown })?.value),
      )
      .filter(Boolean);
  } else if (rawOptions && typeof rawOptions === 'object') {
    // { A: '…', B: '…' } 形式
    options = Object.entries(rawOptions as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => asText(value))
      .filter(Boolean);
  } else if (typeof rawOptions === 'string' && rawOptions.includes('\n')) {
    options = rawOptions
      .split('\n')
      .map((line) => line.replace(/^\s*[A-Da-d1-4][.、)]\s*/, '').trim())
      .filter(Boolean);
  }
  if (options.length < 2) return null;
  const answerRaw = entry.answer ?? entry.correct ?? entry.correctIndex ?? entry.answerIndex ?? entry.correctAnswer;
  const answer = answerToIndex(answerRaw, options);
  if (answer < 0) return null;
  return {
    prompt,
    options,
    answer,
    explain: asText(entry.explain ?? entry.explanation ?? entry.analysis ?? entry.reason ?? entry['解析']),
  };
}

function coerceWord(entry: Record<string, unknown>): unknown | null {
  const term = asText(entry.term ?? entry.word ?? entry.vocab ?? entry.headword);
  if (!term) return null;
  const meaning = asText(entry.meaning ?? entry.definition ?? entry.gloss ?? entry.cn ?? entry.chinese ?? entry.zh);
  if (!meaning) return null;
  return {
    term,
    reading: asText(entry.reading ?? entry.pronunciation ?? entry.kana ?? entry.phonetic ?? entry.yomi ?? entry.romaji),
    pos: asText(entry.pos ?? entry.partOfSpeech ?? entry.class),
    meaning,
    example: asText(entry.example ?? entry.exampleSentence ?? entry.sentence ?? entry.sample),
    exampleCn: asText(entry.exampleCn ?? entry.exampleTranslation ?? entry.exampleZh ?? entry.exampleCnTranslation),
  };
}

function coerceSentence(entry: Record<string, unknown>): unknown | null {
  const text = asText(entry.text ?? entry.sentence ?? entry.original ?? entry.body ?? entry.jp ?? entry.ko ?? entry.en);
  if (!text) return null;
  const translation = asText(entry.translation ?? entry.translationCn ?? entry.cn ?? entry.chinese ?? entry.zh ?? entry.meaning);
  if (!translation) return null;
  return {
    text,
    translation,
    tips: asTextArray(entry.tips ?? entry.hints ?? entry.notes ?? entry.note ?? entry.analysis ?? entry.point),
  };
}

function coercePrompt(entry: Record<string, unknown>): unknown | null {
  const title = asText(entry.title ?? entry.topic ?? entry.name);
  const scenario = asText(
    entry.scenario ?? entry.situation ?? entry.description ?? entry.background ?? entry.instruction ?? entry.promptText,
  );
  if (!title && !scenario) return null;
  return {
    title: title || scenario.slice(0, 24),
    scenario: scenario || title,
    outline: asTextArray(entry.outline ?? entry.outlineCn ?? entry.steps ?? entry.points),
    phrases: asTextArray(entry.phrases ?? entry.usefulExpressions ?? entry.sentencePatterns ?? entry.expressions),
    sample: asText(entry.sample ?? entry.sampleAnswer ?? entry.modelAnswer ?? entry.example),
  };
}

/** 归一化后再做指纹：同一道题换个标点不该重复入库 */
function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'"“”‘’、。，；：！？（）()\[\]【】]/g, '');
}

function fingerprintOf(kind: string, stem: string): string {
  return createHash('sha1').update(`${kind}|${normalizeKey(stem)}`).digest('hex').slice(0, 32);
}

function normalizeItems(raw: unknown[], kind: AiKind): { items: AiItem[]; dropped: number } {
  const items: AiItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;

    const type = inferItemType(record);
    if (!type) {
      dropped += 1;
      continue;
    }

    // 先按别名/形状抢救成标准形状，再用严格 schema 把关
    const coerced =
      type === 'quiz'
        ? coerceQuiz(record)
        : type === 'word'
          ? coerceWord(record)
          : type === 'sentence'
            ? coerceSentence(record)
            : coercePrompt(record);
    if (!coerced) {
      dropped += 1;
      continue;
    }

    const parsed =
      type === 'quiz'
        ? QuizSchema.safeParse(coerced)
        : type === 'word'
          ? WordSchema.safeParse(coerced)
          : type === 'sentence'
            ? SentenceSchema.safeParse(coerced)
            : PromptSchema.safeParse(coerced);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const data = parsed.data as {
      prompt?: string;
      options?: string[];
      answer?: number;
      explain?: string;
      term?: string;
      reading?: string;
      pos?: string;
      meaning?: string;
      example?: string;
      exampleCn?: string;
      text?: string;
      translation?: string;
      tips?: string[];
      title?: string;
      scenario?: string;
      outline?: string[];
      phrases?: string[];
      sample?: string;
    };

    const item: AiItem =
      type === 'quiz'
        ? {
            type: 'quiz',
            prompt: (data.prompt ?? '').trim(),
            options: (data.options ?? []).map((option) => option.trim()),
            answer: Math.min(data.answer ?? 0, (data.options?.length ?? 1) - 1),
            explain: (data.explain ?? '').trim(),
          }
        : type === 'word'
          ? {
              type: 'word',
              term: (data.term ?? '').trim(),
              reading: (data.reading ?? '').trim(),
              pos: (data.pos ?? '').trim(),
              meaning: (data.meaning ?? '').trim(),
              example: (data.example ?? '').trim(),
              exampleCn: (data.exampleCn ?? '').trim(),
            }
          : type === 'sentence'
            ? {
                type: 'sentence',
                text: (data.text ?? '').trim(),
                translation: (data.translation ?? '').trim(),
                tips: (data.tips ?? []).map((tip) => tip.trim()).filter(Boolean),
              }
            : {
                type: 'prompt',
                title: (data.title ?? '').trim(),
                scenario: (data.scenario ?? '').trim(),
                outline: (data.outline ?? []).map((line) => line.trim()).filter(Boolean),
                phrases: (data.phrases ?? []).map((line) => line.trim()).filter(Boolean),
                sample: (data.sample ?? '').trim(),
              };

    const stem =
      item.type === 'quiz'
        ? item.prompt
        : item.type === 'word'
          ? item.term
          : item.type === 'sentence'
            ? item.text
            : item.title;
    const key = normalizeKey(stem);
    if (!key || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    items.push(item);
    if (items.length >= KIND_PLAN[kind].count + 4) break;
  }

  return { items, dropped };
}

interface PromptContext {
  articleTitle: string;
  articleBody: string;
  knownWords: string[];
  avoidStems: string[];
}

/** 今日材料节选：给「理解题/拆句」用，太长会白烧 token */
function articleContext(plan: PlanRecord, day: GeneratedDay): { title: string; body: string } {
  const contents = listDayContents(day.id);
  const article =
    contents.find((item) => item.kind === 'intensive') ?? contents[0] ?? null;
  if (!article) return { title: '', body: '' };
  return { title: article.title, body: article.body.slice(0, 1200) };
}

function buildMessages(
  plan: PlanRecord,
  day: GeneratedDay,
  kind: AiKind,
  ctx: PromptContext,
): Array<{ role: 'system' | 'user'; content: string }> {
  const exam = findExam(plan.examId);
  const language = getLanguage(plan.language);
  const level = language.levels.find((item) => item.id === plan.currentLevelId);
  const target = exam.targets.find((item) => item.score === plan.targetScore) ?? exam.targets[0];
  const native = NATIVE[plan.language as Language];
  const kp = KIND_PLAN[kind];

  const lines = [
    `请为「${native} · ${AI_KIND_LABEL[kind]}」再出一批练习，直接输出 JSON，不要任何解释文字。`,
    '',
    `【考试】${exam.name}（${exam.scaleLabel}）／目标：${target.label}`,
    `【学习阶段】第 ${day.weekIndex + 1} 周 / 共 ${plan.weeks} 周 · ${day.phaseName}`,
    `【今日主题】${day.theme}`,
    `【本阶段重点】${day.focus.join('、')}`,
    `【学习者水平】${level?.name ?? plan.currentLevelName}${level?.cefr ? `（${level.cefr}）` : ''}${level?.vocab ? ` · 词汇量约 ${level.vocab}` : ''}`,
  ];

  if (ctx.articleTitle) lines.push(`【今日材料标题】${ctx.articleTitle}`);
  if (ctx.articleBody) {
    lines.push(`【今日材料正文节选】`, ctx.articleBody);
  }

  // 拆句：本地语法书里有句型，就把今天轮到的这几个塞给模型，出的句子才会落在书上
  const grammar = kind === 'grammar' ? grammarPatternsFor(plan, day, 3) : null;
  if (grammar) {
    lines.push(
      '',
      `【今日语法点（本地资料《${grammar.materialTitle}》，按天轮换）】`,
      ...grammar.patterns.map((pattern, index) => `${index + 1}. ${formatPatternForPrompt(pattern).split('\n').join(' ／ ')}`),
    );
  }

  lines.push('', '【这批要出什么】', kp.brief);

  if (grammar) {
    lines.push(
      `- 上面 ${grammar.patterns.length} 个句型每个至少造 1 句，6 句里至少覆盖 4 句；句子要像真实场景里会说的话，不要照抄原书例句。`,
      '- tips 里要写明该句的句型接续（前面接什么形）和一个中国人容易用错的地方。',
    );
  }

  lines.push(
    '',
    '【输出 JSON】',
    '{',
    '  "items": [ ... ],',
    '  "note": "一句话说明这批练什么（中文，20 字以内）"',
    '}',
    '',
    'items 里每条都是下面四种之一：',
    '- {"type":"quiz","prompt":"题干（目标语言）","options":["A","B","C","D"],"answer":0,"explain":"中文解析"}',
    '- {"type":"word","term":"词","reading":"音标/假名/罗马字","pos":"词性","meaning":"中文释义","example":"目标语言例句","exampleCn":"例句中文翻译"}',
    '- {"type":"sentence","text":"原句","translation":"中文译文","tips":["中文提示1","中文提示2"]}',
    '- {"type":"prompt","title":"标题（目标语言）","scenario":"情境（目标语言）","outline":["中文提纲"],"phrases":["目标语言句型"],"sample":"目标语言范例"}',
    '',
    '【硬性要求】',
    `1. 题干、选项、句子、例句、范文一律用${native}；解析、译文、提纲、提示一律用中文。`,
    '2. 原创，不得照抄真题或教材原文；难度必须匹配上面的学习者水平，不要堆超纲词。',
    `3. items 数量严格按【这批要出什么】执行，不要偏离类型。answer 是正确选项下标（从 0 开始），必须真的正确。`,
    '4. 只输出 JSON 对象本身，不要 markdown 代码块，不要前后缀。',
  );

  if (ctx.knownWords.length > 0) {
    lines.push(`5. 出词时避开这些已学过的词：${ctx.knownWords.slice(0, 40).join('、')}`);
  }
  if (ctx.avoidStems.length > 0) {
    lines.push(`6. 不要与下面这些已有内容重复：${ctx.avoidStems.slice(0, 6).join(' ／ ')}`);
  }

  return [
    { role: 'system', content: SYSTEM[plan.language as Language] },
    { role: 'user', content: lines.join('\n') },
  ];
}

function topicOf(plan: PlanRecord, day: GeneratedDay, kind: AiKind, ctx: PromptContext): string {
  // 理解类任务围绕文章出题，主题里带上文章标题，换一篇就不会误命中缓存
  if ((kind === 'read' || kind === 'listen' || kind === 'grammar') && ctx.articleTitle) {
    return `${day.theme}｜${ctx.articleTitle}`.slice(0, 120);
  }
  return day.theme.slice(0, 120);
}

export interface AiGenerateResult {
  cached: boolean;
  runId: string;
  language: string;
  kind: AiKind;
  topic: string;
  model: string;
  provider: string;
  /** 本次真实消耗；命中 5 分钟缓存时全为 0 */
  usage: TokenUsage;
  /** 命中缓存时替用户省下的 token */
  savedTokens: number;
  latencyMs: number;
  itemCount: number;
  newCount: number;
  duplicateCount: number;
  /** 这次返回的格式歪了、靠本地修复或字段抢救才救回来：界面据此标注「已自动修复」 */
  repaired: boolean;
  /** 抢救后仍然丢弃的条数 */
  dropped: number;
  items: AiItem[];
  note: string | null;
  createdAt: string;
}

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export async function generateForTask(
  plan: PlanRecord,
  day: GeneratedDay,
  task: Task,
  options: { fresh?: boolean } = {},
): Promise<AiGenerateResult> {
  if (!isAiKind(task.kind)) {
    throw new ConflictError('这一项是复习或报考事务，没有需要 AI 生成的练习题。');
  }
  const kind = task.kind;

  const { config } = resolveLlmConfig();
  if (!config) {
    throw new ConflictError('还没有可用的模型线路。到「设置 → 模型 Key 池」添加一条，就能让 AI 出题了。');
  }

  const article = articleContext(plan, day);
  const baseCtx: PromptContext = {
    articleTitle: article.title,
    articleBody: article.body,
    knownWords: [],
    avoidStems: [],
  };
  const topic = topicOf(plan, day, kind, baseCtx);
  const cacheKey = [plan.language, kind, plan.currentLevelId, plan.examId, topic].join('|');

  if (!options.fresh) {
    const recent = findRecentRun(currentUserId(), cacheKey, AI_CACHE_MS);
    if (recent) {
      logger.info('ai generate cache hit', { kind, language: plan.language, saved: recent.totalTokens });
      return {
        cached: true,
        runId: recent.id,
        language: plan.language,
        kind,
        topic: recent.topic,
        model: recent.model ?? '',
        provider: recent.provider ?? '',
        usage: EMPTY_USAGE,
        savedTokens: recent.totalTokens,
        latencyMs: 0,
        itemCount: recent.items.length,
        newCount: 0,
        duplicateCount: 0,
        repaired: false,
        dropped: 0,
        items: recent.items,
        note: recent.notice,
        createdAt: recent.createdAt,
      };
    }
  }

  const knownWords =
    kind === 'vocab' ? listWords(currentUserId(), requireLanguage(plan.language), { limit: 60 }).map((w) => w.term) : [];
  const avoidStems = recentStems({
    userId: currentUserId(),
    language: plan.language,
    kind,
    topic,
    limit: 6,
  });

  const startedAt = Date.now();
  const kp = KIND_PLAN[kind];
  // meta 用来回传「这次是本地修好的还是让模型重写了一遍」，界面上据此标注
  const meta: { localRepaired?: boolean; modelRetried?: boolean } = {};
  const raw = await chatJson(
    config,
    buildMessages(plan, day, kind, { ...baseCtx, knownWords, avoidStems }),
    TolerantBatch,
    { temperature: 0.8, maxTokens: kp.maxTokens, retries: 1, meta },
  );

  const { items, dropped } = normalizeItems(raw.items, kind);
  if (items.length === 0) {
    throw new UpstreamError(
      `模型返回了 ${raw.items.length} 条内容，但一条都没法整理成可用的练习题。`,
      {
        hint: '内容已尽量抢救仍全军覆没，多半是模型结构化能力太弱——换混元/魔搭等模型，或点「再生成一批」换个思路',
        dropped,
      },
    );
  }
  const repaired = Boolean(meta.localRepaired) || Boolean(meta.modelRetried) || dropped > 0;

  const model = config.usedModel ?? config.model;
  const provider = providerForBaseUrl(config.baseUrl)?.name ?? '自定义接口';
  const usage = config.usage ?? EMPTY_USAGE;
  const latencyMs = Date.now() - startedAt;

  const newItems: AiNewItem[] = items.map((item) => ({
    itemType: item.type,
    payload: item,
    fingerprint: fingerprintOf(
      kind,
      item.type === 'quiz'
        ? item.prompt
        : item.type === 'word'
          ? item.term
          : item.type === 'sentence'
            ? item.text
            : item.title,
    ),
  }));

  const run = insertRun({
    userId: currentUserId(),
    cacheKey,
    language: plan.language,
    kind,
    levelId: plan.currentLevelId,
    topic,
    planId: plan.id,
    dayId: day.id,
    model,
    provider,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    latencyMs,
    items,
    newCount: 0,
    notice: raw.note?.trim() || null,
  });
  const runId = run.id;

  const { inserted, duplicates } = insertBankItems({
    runId,
    userId: currentUserId(),
    language: plan.language,
    kind,
    levelId: plan.currentLevelId,
    topic,
    planId: plan.id,
    dayId: day.id,
    model,
    provider,
    items: newItems,
  });

  // 词汇类顺手写进词汇本：AI 出的词能直接进入 SRS 复习，而不是只躺在题库里
  if (kind === 'vocab') {
    const words = items.filter((item) => item.type === 'word');
    upsertWords(
      currentUserId(),
      requireLanguage(plan.language),
      words.map((word) => ({
        term: word.term,
        reading: word.reading || undefined,
        pos: word.pos || undefined,
        meaning: word.meaning,
        example: word.example || undefined,
        exampleCn: word.exampleCn || undefined,
        theme: day.theme,
        level: plan.currentLevelId,
      })),
      `AI · ${model}`,
    );
  }

  // 回填这一批真正新增了多少条
  updateRunNewCount(runId, inserted);

  return {
    cached: false,
    runId,
    language: plan.language,
    kind,
    topic,
    model,
    provider,
    usage,
    savedTokens: 0,
    latencyMs,
    itemCount: items.length,
    newCount: inserted,
    duplicateCount: duplicates,
    repaired,
    dropped,
    items,
    note: raw.note?.trim() || null,
    createdAt: new Date().toISOString(),
  };
}

export function aiBankList(params: { language?: string; kind?: string; limit?: number }): AiBankItemView[] {
  return listBank({ userId: currentUserId(), ...params });
}

export function aiStats(): AiBankStats {
  return bankStats(currentUserId());
}

export function aiRemove(id: string): boolean {
  return deleteBankItem(currentUserId(), id);
}
