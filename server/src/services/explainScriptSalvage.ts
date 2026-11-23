/**
 * 解题答疑脚本的「抢救式」解析。
 *
 * 现实里模型给出的东西长这样（任意组合）：
 *   - 先写一段「分析过程」，再给 JSON；
 *   - 包在 ```json 围栏里；
 *   - 字段名写成中文（"分镜"、"旁白"）或换个拼法（naration / voice_over）；
 *   - kind 写成 "题干" / "正确答案" / "选项分析"；
 *   - 数值写成字符串（"questionNo": "2"）；
 *   - 被 max_tokens 从中间截断，最后一个对象只写了一半。
 *
 * 严格 zod 校验对以上任何一种都是「整份脚本作废」，代价是一整次重新生成（时间 + token）。
 * 这里改成分层抢救：
 *   ① 严格 JSON.parse；
 *   ② repairJson（围栏 / 尾逗号 / 中文标点 / 注释 / 截断补全）；
 *   ③ 逐对象抓取：扫出每个括号配平的 { ... } 单独解析，能解析一个算一个；
 *   ④ 逐字段净化：kind 归一化、缺失字段互推、数值强转；
 *   ⑤ 单镜 zod 校验，坏镜丢弃、好镜保留。
 *
 * 结果：能救就本地救回来，绝不再花一次调用；救回来的分镜再交给上层补齐题库数据。
 */
import { z } from 'zod';
import { repairJson, stripNoise } from '../lib/jsonRepair';

export const SHOT_KINDS = [
  'cover',
  'question',
  'passage',
  'grammar',
  'eliminate',
  'answer',
  'point',
  'takeaway',
] as const;
export type ShotKindName = (typeof SHOT_KINDS)[number];

/** 模型输出的单个分镜草稿（不含音频 / 时间，由代码补齐） */
export const ShotDraftSchema = z.object({
  kind: z.enum(SHOT_KINDS),
  questionNo: z.number().int().min(0).optional(),
  narration: z.string().min(1).max(600),
  caption: z.string().min(1).max(300),
  prompt: z.string().max(600).optional(),
  options: z.array(z.string().max(300)).max(6).optional(),
  sentence: z.string().max(600).optional(),
  evidence: z.string().max(600).optional(),
  paragraph: z.number().int().min(0).optional(),
  picked: z.number().int().min(0).max(5).optional(),
  structure: z.string().max(300).optional(),
  explanation: z.string().max(600).optional(),
  translation: z.string().max(600).optional(),
  pointLabel: z.string().max(200).optional(),
  pointText: z.string().max(400).optional(),
});

export type ShotDraft = z.infer<typeof ShotDraftSchema>;

/** 下限取 1：只要还剩一个能用的镜，就允许上层用题库补齐成一条完整视频 */
export const ScriptSchema = z.object({ shots: z.array(ShotDraftSchema).min(1).max(80) });

type Dict = Record<string, unknown>;

function asRecord(value: unknown): Dict | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Dict;
}

/** 按候选键名取第一个非空字符串（大小写 / 下划线不敏感） */
function pickString(obj: Dict, keys: string[], max: number): string | undefined {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(obj)) {
    lowered.set(key.toLowerCase().replace(/[_\s-]/g, ''), value);
  }
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase().replace(/[_\s-]/g, ''));
    if (typeof value === 'string') {
      const text = cleanText(value).slice(0, max);
      if (text) return text;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  }
  return undefined;
}

/** 去掉 markdown 强调符 / 列表符 / 代码符，TTS 不该念出这些符号 */
function cleanText(input: string): string {
  return input
    .replace(/^[\s>*\-–—•·]+/, '')
    .replace(/[`*_]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LETTER_INDEX: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };

/** 数字 / "2" / "第3题" / "B" 都能转成下标 */
function toIndex(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^[A-Fa-f]$/.test(text)) return LETTER_INDEX[text.toUpperCase()];
  const digits = text.match(/-?\d+/);
  if (!digits) return undefined;
  const parsed = Number.parseInt(digits[0], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStringList(value: unknown, maxEach = 300): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value.slice(0, 6)) {
    if (typeof item === 'string') {
      const text = cleanText(item);
      if (text) out.push(text.slice(0, maxEach));
      continue;
    }
    const record = asRecord(item);
    if (record) {
      const text = pickString(record, ['text', 'label', 'content', 'option', 'value'], maxEach);
      if (text) out.push(text);
    }
  }
  return out.length > 0 ? out : undefined;
}

const KIND_ALIASES: Record<string, ShotKindName> = {
  cover: 'cover',
  intro: 'cover',
  introduction: 'cover',
  opening: 'cover',
  title: 'cover',
  hook: 'cover',
  封面: 'cover',
  开场: 'cover',
  导入: 'cover',
  引入: 'cover',
  question: 'question',
  prompt: 'question',
  stem: 'question',
  questionstem: 'question',
  题干: 'question',
  题目: 'question',
  问题: 'question',
  passage: 'passage',
  text: 'passage',
  reading: 'passage',
  evidence: 'passage',
  locate: 'passage',
  location: 'passage',
  原文: 'passage',
  定位: 'passage',
  段落: 'passage',
  句: 'passage',
  grammar: 'grammar',
  grammarpoint: 'grammar',
  syntax: 'grammar',
  structure: 'grammar',
  语法: 'grammar',
  语法点: 'grammar',
  句型: 'grammar',
  eliminate: 'eliminate',
  elimination: 'eliminate',
  eliminateoptions: 'eliminate',
  options: 'eliminate',
  distractor: 'eliminate',
  distractors: 'eliminate',
  analysis: 'eliminate',
  排除: 'eliminate',
  排除法: 'eliminate',
  选项分析: 'eliminate',
  干扰项: 'eliminate',
  answer: 'answer',
  key: 'answer',
  correct: 'answer',
  correctanswer: 'answer',
  solution: 'answer',
  答案: 'answer',
  正确答案: 'answer',
  解析: 'answer',
  point: 'point',
  tip: 'point',
  exampoint: 'point',
  keypoint: 'point',
  note: 'point',
  考点: 'point',
  要点: 'point',
  提示: 'point',
  知识点: 'point',
  takeaway: 'takeaway',
  summary: 'takeaway',
  ending: 'takeaway',
  conclusion: 'takeaway',
  outro: 'takeaway',
  总结: 'takeaway',
  小结: 'takeaway',
  结尾: 'takeaway',
  收尾: 'takeaway',
};

function normalizeKind(value: unknown): ShotKindName | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.toLowerCase().replace(/[\s_-]/g, '');
  if (KIND_ALIASES[key]) return KIND_ALIASES[key];
  // "answer_shot" / "考点镜" 这类带后缀的，退一步做包含匹配
  for (const [alias, kind] of Object.entries(KIND_ALIASES)) {
    if (alias.length >= 3 && key.includes(alias)) return kind;
  }
  return undefined;
}

/** 没有 kind（或 kind 认不出）时按字段特征反推 */
function inferKind(obj: Dict): ShotKindName {
  const has = (keys: string[]) =>
    keys.some((key) => {
      const value = obj[key];
      return value !== undefined && value !== null && value !== '';
    });
  if (has(['grammar', 'structure', 'syntax'])) return 'grammar';
  if (has(['pointText', 'pointLabel', 'point', 'label'])) return 'point';
  if (has(['picked', 'answerIndex', 'correctIndex'])) return 'answer';
  if (has(['sentence', 'evidence', 'paragraph'])) return 'passage';
  if (has(['options'])) return 'question';
  return 'point';
}

const NARRATION_KEYS = [
  'narration',
  'narrations',
  'naration',
  'voiceover',
  'voiceovertext',
  'speech',
  'spoken',
  'script',
  'text',
  'content',
  '旁白',
  '讲解',
  '口播',
];
const CAPTION_KEYS = [
  'caption',
  'captions',
  'subtitle',
  'subtitles',
  'captiontext',
  'screentext',
  'onscreentext',
  'zh',
  'chinese',
  '字幕',
  '中文',
];

/** 单个对象 → ShotDraft；救不回来返回 null（坏镜丢弃，不影响整份脚本） */
export function coerceDraft(raw: unknown, questionCount = 0): ShotDraft | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const kind = normalizeKind(obj.kind ?? obj.type ?? obj.scene ?? obj.shottype ?? obj.shot ?? obj.分镜) ?? inferKind(obj);

  const narration = pickString(obj, NARRATION_KEYS, 600);
  const caption = pickString(obj, CAPTION_KEYS, 300);
  // 旁白与字幕互为兜底：宁可让中文旁白配中文画面，也不要整镜作废
  const finalNarration = narration ?? caption;
  const finalCaption = caption ?? narration;
  if (!finalNarration || !finalCaption) return null;

  const grammarRecord = asRecord(obj.grammar);
  const grammarSentence =
    grammarRecord !== null ? pickString(grammarRecord, ['sentence', 'text', 'original'], 600) : undefined;

  const pointRecord = asRecord(obj.point);

  let questionNo = toIndex(obj.questionNo ?? obj.questionno ?? obj.no ?? obj.question ?? obj.q ?? obj.index);
  if (questionNo !== undefined) {
    if (questionNo < 0) questionNo = undefined;
    // 模型时常把第 1 题写成 1 而不是 0：越界且减一后合法，就按 0 基纠正
    else if (questionCount > 0 && questionNo >= questionCount && questionNo - 1 < questionCount) questionNo -= 1;
    else if (questionCount > 0 && questionNo >= questionCount) questionNo = questionCount - 1;
  }

  const clean: Record<string, unknown> = {
    kind,
    narration: finalNarration,
    caption: finalCaption,
  };
  if (questionNo !== undefined) clean.questionNo = questionNo;

  const prompt = pickString(obj, ['prompt', 'questiontext', 'stem', 'questionprompt', '题干'], 600);
  if (prompt) clean.prompt = prompt;

  const options = toStringList(obj.options ?? obj.choices ?? obj.选项);
  if (options) clean.options = options;

  const sentence = pickString(obj, ['sentence', 'originalsentence', 'sentenceText', '原句'], 600) ?? grammarSentence;
  if (sentence) clean.sentence = sentence;

  const evidence = pickString(obj, ['evidence', 'quote', 'citation', '原句', '依据'], 600) ?? sentence;
  if (evidence) clean.evidence = evidence;

  const paragraph = toIndex(obj.paragraph ?? obj.paragraphIndex ?? obj.para ?? obj.段号);
  if (paragraph !== undefined && paragraph >= 0) clean.paragraph = paragraph;

  const picked = toIndex(obj.picked ?? obj.correctIndex ?? obj.answerIndex ?? obj.answer ?? obj.correct);
  if (picked !== undefined && picked >= 0 && picked <= 5) clean.picked = picked;

  const structure =
    pickString(obj, ['structure', 'pattern', 'grammarStructure', '句型'], 300) ??
    (grammarRecord ? pickString(grammarRecord, ['structure', 'pattern'], 300) : undefined);
  if (structure) clean.structure = structure;

  const explanation =
    pickString(obj, ['explanation', 'analysis', 'explain', 'reason', '讲解'], 600) ??
    (grammarRecord ? pickString(grammarRecord, ['explanation', 'analysis'], 600) : undefined);
  if (explanation) clean.explanation = explanation;

  const translation =
    pickString(obj, ['translation', 'translate', 'chineseTranslation', '译文'], 600) ??
    (grammarRecord ? pickString(grammarRecord, ['translation', 'translate'], 600) : undefined);
  if (translation) clean.translation = translation;

  const pointLabel =
    pickString(obj, ['pointLabel', 'label', 'tag', '考点'], 200) ??
    (pointRecord ? pickString(pointRecord, ['label', 'tag', 'title'], 200) : undefined);
  if (pointLabel) clean.pointLabel = pointLabel;

  const pointText =
    pickString(obj, ['pointText', 'tip', 'note', 'keyPoint', '要点'], 400) ??
    (pointRecord ? pickString(pointRecord, ['text', 'content', 'body'], 400) : undefined);
  if (pointText) clean.pointText = pointText;

  const parsed = ShotDraftSchema.safeParse(clean);
  if (parsed.success) return parsed.data;
  // 最后一搏：字段都齐但某个字符串超长，截断后再试一次
  const trimmed = ShotDraftSchema.safeParse({
    ...clean,
    narration: String(clean.narration).slice(0, 600),
    caption: String(clean.caption).slice(0, 300),
    prompt: typeof clean.prompt === 'string' ? clean.prompt.slice(0, 600) : undefined,
    explanation: typeof clean.explanation === 'string' ? clean.explanation.slice(0, 600) : undefined,
    translation: typeof clean.translation === 'string' ? clean.translation.slice(0, 600) : undefined,
  });
  return trimmed.success ? trimmed.data : null;
}

/** 从任意 JSON 值里揪出分镜数组：{"shots":[]}、裸数组、{data:{shots}}、单镜对象都认 */
export function coerceScriptValue(value: unknown, questionCount = 0): ShotDraft[] {
  const collect = (input: unknown, depth = 0): unknown[] | null => {
    if (depth > 3 || input === null || input === undefined) return null;
    if (Array.isArray(input)) return input;
    const obj = asRecord(input);
    if (!obj) return null;
    for (const key of ['shots', 'scenes', 'storyboard', 'segments', 'sections', '分镜', 'script']) {
      const hit = obj[key];
      if (Array.isArray(hit)) return hit;
      if (asRecord(hit)) {
        const nested = collect(hit, depth + 1);
        if (nested) return nested;
      }
    }
    for (const key of ['data', 'result', 'video', 'payload']) {
      const nested = collect(obj[key], depth + 1);
      if (nested) return nested;
    }
    // 整个对象就是一个分镜
    if (obj.kind || obj.narration || obj.caption) return [obj];
    return null;
  };

  const list = collect(value);
  if (!list) return [];
  const out: ShotDraft[] = [];
  // 上限 60 镜：一篇文章配不出这么多镜，超了多半是模型在刷重复内容，别让它拖垮配音
  for (const item of list.slice(0, 60)) {
    const draft = coerceDraft(item, questionCount);
    if (draft) out.push(draft);
  }
  return out;
}

/**
 * 扫出文本里所有「括号配平」的 { ... } 片段并逐个解析。
 * 截断造成的半截对象会因为括号不配平被自然跳过 —— 这正是我们要的「丢掉半句、保住整镜」。
 */
function scrapeObjects(text: string): unknown[] {
  const out: unknown[] = [];
  const limit = 200;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        const parsed = tryParseObject(slice);
        if (parsed) out.push(parsed);
        start = -1;
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function tryParseObject(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairJson(text);
    return repaired.ok ? repaired.value : null;
  }
}

export interface ScriptParseResult {
  drafts: ShotDraft[];
  /** 命中的解析阶段，便于日志定位「这次是哪种脏数据」 */
  stage: string;
  /** 被丢弃的坏镜数量 */
  rejected: number;
  /** 原文看起来是被截断的（最后一个对象没写完 / 结构没闭合） */
  truncated: boolean;
}

/** 截断时最后一句常停在半句，TTS 念出来像卡带：丢掉这个尾巴 */
function dropHalfSentenceTail(drafts: ShotDraft[]): ShotDraft[] {
  if (drafts.length <= 1) return drafts;
  const last = drafts[drafts.length - 1];
  const tail = last.narration.trim();
  if (/[.!?。！？…"”'』」]$/.test(tail)) return drafts;
  return drafts.slice(0, -1);
}

export function parseScriptText(raw: string, questionCount = 0): ScriptParseResult {
  const text = stripNoise(raw);
  if (!text) return { drafts: [], stage: 'empty', rejected: 0, truncated: false };

  const looksTruncated = !/[}\]]\s*$/.test(raw.trim());

  // ① 严格
  try {
    const drafts = coerceScriptValue(JSON.parse(text), questionCount);
    return { drafts, stage: 'strict', rejected: 0, truncated: false };
  } catch {
    /* 下一层 */
  }

  // ② 通用修复（含截断补全）
  const repaired = repairJson(raw);
  if (repaired.ok) {
    const drafts = coerceScriptValue(repaired.value, questionCount);
    const stage = `repair:${repaired.stage ?? '?'}`;
    if (drafts.length > 0) {
      const truncated = Boolean(repaired.stage?.startsWith('truncated')) || looksTruncated;
      const kept = truncated ? dropHalfSentenceTail(drafts) : drafts;
      return { drafts: kept, stage, rejected: drafts.length - kept.length, truncated };
    }
  }

  // ③ 逐对象抓取：整份解析不了时，把写完的分镜一个个捞出来
  const objects = scrapeObjects(text);
  const drafts: ShotDraft[] = [];
  let rejected = 0;
  for (const obj of objects) {
    const draft = coerceDraft(obj, questionCount);
    if (draft) drafts.push(draft);
    else rejected += 1;
  }
  if (drafts.length > 0) {
    // 抓取模式下最后一个对象一定是完整的；只有文本整体没闭合才可能是半句
    const kept = looksTruncated ? dropHalfSentenceTail(drafts) : drafts;
    return { drafts: kept, stage: 'scrape', rejected: rejected + (drafts.length - kept.length), truncated: looksTruncated };
  }

  return { drafts: [], stage: 'unparseable', rejected, truncated: looksTruncated };
}
