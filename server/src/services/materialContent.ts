import type { Language } from '../domain/language';
import type { ArticlePayload, GeneratedDay, PlanRecord } from '../domain/types';
import type { ArticleRecord } from '../repositories/content';
import {
  activeMaterialId,
  getMaterial,
  listMaterialWords,
  listUnits,
  type MaterialRecord,
  type MaterialUnitRecord,
  type MaterialWordRecord,
} from '../repositories/materials';
import type { LexEntry } from '../content/lexicon';
import { DAYS_PER_UNIT, textbookContextFor, vocabPacksFor } from './curriculum';
import { stripPromo } from './sanitize';

/** 精读页正文节选上限（其余请对照原书阅读，避免整本复制到界面） */
const EXCERPT_LIMIT = 2400;

export interface MaterialContext {
  material: MaterialRecord;
  unit: MaterialUnitRecord;
  unitCount: number;
  levelName: string;
  bookIndex: number;
  bookCount: number;
}

export function activeMaterial(language: Language): MaterialRecord | null {
  const id = activeMaterialId(language);
  if (!id) return null;
  const material = getMaterial(id);
  return material && material.language === language ? material : null;
}

/**
 * 今天该用哪本教材的哪一章。
 * 分级教材按计划进度自动推进（0 → N2 一本本往上走）；没有分级教材时沿用「手动启用的那本」。
 */
export function materialContextFor(plan: PlanRecord, day: GeneratedDay): MaterialContext | null {
  const ctx = textbookContextFor(plan, day);
  if (!ctx) return null;
  return {
    material: ctx.material,
    unit: ctx.unit,
    unitCount: ctx.unitCount,
    levelName: ctx.levelName,
    bookIndex: ctx.bookIndex,
    bookCount: ctx.bookCount,
  };
}

/** 词表包（kind = vocab）里的词：只进词汇任务，按日期打散，优先没学过的 */
export function vocabPackEntries(params: {
  plan: PlanRecord;
  date: string;
  exclude: Set<string>;
  count: number;
}): { entries: LexEntry[]; packs: string[] } {
  const { plan, date, exclude, count } = params;
  if (count <= 0) return { entries: [], packs: [] };
  const packs = vocabPacksFor(plan);
  if (packs.length === 0) return { entries: [], packs: [] };

  const buckets = packs.map((pack) => {
    const words = listMaterialWords(pack.id, { limit: 600 }).filter((word) => word.meaning);
    const fresh = words.filter((word) => !exclude.has(word.term));
    const seen = words.filter((word) => exclude.has(word.term));
    const rank = (word: MaterialWordRecord) => hash(`${date}-${word.term}`);
    return { pack, queue: [...fresh.sort((a, b) => rank(a) - rank(b)), ...seen.sort((a, b) => rank(a) - rank(b))] };
  });

  const entries: LexEntry[] = [];
  const usedPacks = new Set<string>();
  const usedTerms = new Set<string>();
  for (let round = 0; entries.length < count && round < 800; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      const word = bucket.queue[round];
      if (!word || usedTerms.has(word.term)) continue;
      usedTerms.add(word.term);
      entries.push({
        term: word.term,
        reading: word.reading ?? '',
        pos: word.pos ?? '',
        cn: word.meaning ?? '',
        mnemonic: `出自你的资料《${bucket.pack.title}》，属于 ${
          bucket.pack.level ? bucket.pack.level.toUpperCase() : '通用'
        } 级别词表。`,
        example: word.example ?? '',
        exampleCn: '',
        syn: [],
        theme: `词表 · ${bucket.pack.title}`.slice(0, 40),
        level: bucket.pack.level ?? 'core',
      });
      usedPacks.add(bucket.pack.title);
      added = true;
      if (entries.length >= count) break;
    }
    if (!added) break;
  }
  return { entries, packs: [...usedPacks] };
}

function hash(input: string): number {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** 把教材词条转成考纲词条结构，供词汇任务复用（释义来自内置词库对齐，未收录的标空） */
export function materialEntries(ctx: MaterialContext, exclude: Set<string>, count: number): LexEntry[] {
  const words = listMaterialWords(ctx.material.id, { unitIdx: ctx.unit.idx, onlyLexicon: true, limit: 200 });
  const picked = words.filter((word) => word.meaning && !exclude.has(word.term)).slice(0, count);
  return picked.map((word: MaterialWordRecord) => ({
    term: word.term,
    reading: word.reading ?? '',
    pos: word.pos ?? '',
    cn: word.meaning ?? '',
    mnemonic: `出自《${ctx.material.title}》第 ${ctx.unit.idx + 1} 章，原文高频出现 ${word.freq} 次。`,
    example: word.example ?? '',
    exampleCn: '',
    syn: [],
    theme: `教材 · ${ctx.unit.title}`.slice(0, 40),
    level: ctx.unit.idx === 0 ? 'basic' : 'core',
  }));
}

const splitSentences = (text: string, language: Language): string[] => {
  const normalized = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (language === 'en') {
    return normalized.split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((item) => item.trim()).filter((item) => item.length > 20);
  }
  if (language === 'ja') {
    return normalized
      .split(/(?<=[。！？])/)
      .map((item) => item.trim())
      // 只留真正的句子：生词表那种「单词＋读音＋词性＋释义」的整行要排掉
      .filter((item) => item.length > 8 && /[。！？]$/.test(item) && !/[①-⑳⓪]/.test(item));
  }
  return normalized
    .split(/(?<=[.?!。！？])\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length > 8 && !/[①-⑳⓪]/.test(item));
};

/** 从章节词条自动生成选词填空题：选项来自同章其它词，答案唯一 */
function buildQuestions(ctx: MaterialContext, words: MaterialWordRecord[], language: Language): ArticlePayload['questions'] {
  const withExample = words.filter((word) => word.example && word.example.includes(word.term)).slice(0, 6);
  const questions: ArticlePayload['questions'] = [];
  withExample.forEach((word, index) => {
    const distractors = words
      .filter((item) => item.term !== word.term && item.meaning)
      .slice(index + 1, index + 4)
      .map((item) => item.term);
    if (distractors.length < 2) return;
    const blanked = (word.example ?? '').replace(word.term, '______');
    const options = [word.term, ...distractors];
    // 固定顺序打散：用词条长度做简单置换，避免正确答案总在第一位
    const rotate = (index + word.term.length) % options.length;
    const rotated = [...options.slice(rotate), ...options.slice(0, rotate)];
    questions.push({
      prompt: `选出原文中应填入空格的词：${blanked}`,
      options: rotated,
      answer: rotated.indexOf(word.term),
      explain: `${word.term}${word.reading ? `（${word.reading}）` : ''}：${word.meaning ?? '见词表'}${
        language === 'en' ? '' : '。'
      }`,
    });
  });
  return questions.slice(0, 3);
}

export function buildMaterialArticle(params: {
  ctx: MaterialContext;
  language: Language;
  mode: 'read' | 'listen' | 'speak';
}): { article: ArticleRecord; notice: string } {
  const { ctx, language, mode } = params;
  const lexiconWords = listMaterialWords(ctx.material.id, { unitIdx: ctx.unit.idx, onlyLexicon: true, limit: 40 });
  // 词库没覆盖到的生词也带上，标注「待补释义」，方便对照原书或配好模型后补全
  const extraWords = listMaterialWords(ctx.material.id, { unitIdx: ctx.unit.idx, limit: 40 }).filter(
    (word) => !word.inLexicon,
  );
  const words = [...lexiconWords, ...extraWords].slice(0, 20);
  // 兜底再洗一遍：老数据入库时没清过，界面上也不该出现「沪江网校」这类推广
  const source = stripPromo(ctx.unit.body);
  const body = source.length > EXCERPT_LIMIT ? `${source.slice(0, EXCERPT_LIMIT)}……` : source;
  const sentences = splitSentences(source, language);
  const segments = sentences.slice(0, 12).map((text) => ({ text, translation: '', tips: [] as string[] }));

  const pageNote =
    ctx.unit.pageFrom !== null
      ? `，原书约第 ${ctx.unit.pageFrom}${ctx.unit.pageTo && ctx.unit.pageTo !== ctx.unit.pageFrom ? `–${ctx.unit.pageTo}` : ''} 页`
      : '';

  return {
    article: {
      id: `material-${ctx.material.id}-${ctx.unit.idx}-${mode}`,
      language,
      kind: 'intensive',
      title: `${ctx.unit.title}`,
      body,
      translation: '',
      readingScript: { segments },
      vocab: words.map((word) => ({
        term: word.term,
        reading: word.reading ?? '',
        pos: word.pos ?? '',
        meaning: word.meaning ?? '生词（待补释义）',
        example: word.example ?? '',
      })),
      questions: buildQuestions(ctx, words, language),
      estMinutes: 25,
      source: 'material',
      model: null,
    } satisfies ArticleRecord,
    notice: `本日材料取自你的教材《${ctx.material.title}》${ctx.levelName ? `（${ctx.levelName}）` : ''}第 ${ctx.unit.idx + 1} / ${ctx.unitCount} 章「${ctx.unit.title}」${pageNote}。正文为节选（约 ${Math.min(source.length, EXCERPT_LIMIT)} 字），其余段落请对照原书阅读。`,
  };
}

/** 拆句任务：取章节里最长的几句，保留原句做结构分析 */
export function materialSentences(ctx: MaterialContext, language: Language, limit = 6): string[] {
  return splitSentences(stripPromo(ctx.unit.body), language)
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

/** 词汇来源描述，用于任务卡片上的来源说明 */
export function materialSourceLabel(ctx: MaterialContext): string {
  const level = ctx.levelName && ctx.levelName !== '未分级' ? `${ctx.levelName} · ` : '';
  const book = ctx.bookCount > 1 ? `（第 ${ctx.bookIndex + 1}/${ctx.bookCount} 本）` : '';
  return `${level}教材《${ctx.material.title}》${book}第 ${ctx.unit.idx + 1} / ${ctx.unitCount} 章`;
}
