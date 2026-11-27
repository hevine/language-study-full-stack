/**
 * 统一分级词库出口：英语（托福词库）与日语（JLPT 词库）在数据结构上互不相干，
 * 但对外提供同一套「按级别浏览 / 按级别取词」的接口，避免两边逻辑各写一遍。
 */
import { JA_LEVEL_META, JA_LEVEL_ORDER, JA_WORDS, pickJaWords, type JaLevel } from './jaLexicon';
import { JLPT_LEVEL_DESCRIPTION, JLPT_SOURCE, listJlptWords } from './jlptGraded';
import {
  KO_LEVEL_META,
  KO_LEVEL_ORDER,
  KO_WORDS,
  pickKoWords,
  type KoLevel,
} from './koLexicon';
import {
  hash,
  LEXICON_SOURCE,
  TOEFL_WORDS,
  type LexWord,
  type WordTier,
} from './toeflLexicon';
import {
  GRADED_LEVEL_DESCRIPTION,
  GRADED_LEVELS,
  GRADED_SOURCE,
  GRADED_WORDS,
  gradedByTerm,
  isToeflGrade,
  listGradedWords,
  type ToeflGrade,
} from './toeflGraded';
import { enhancedOf } from './toeflEnhanced';

export type LexLanguage = 'en' | 'ja' | 'ko';

export interface LexEntry {
  term: string;
  /** 音标（英）或假名（日） */
  reading: string | null;
  pos: string;
  cn: string;
  mnemonic: string;
  example: string;
  exampleCn: string;
  syn: string[];
  theme: string;
  level: string;
  /** 分级词库的稳定编码（EN-V-0001）；精讲词没有 */
  code?: string;
  /** 词形变化，如 affects, affected, affecting */
  forms?: string;
  /** 近义/反义/派生原文，如「近 influence, impact；派 effect n.」 */
  relations?: string;
  /** 频段（估算）：超高频 / 高频 / 中频 / 低频 */
  band?: string;
  /** true 表示来自分级词表、中文释义与例句尚待补充 */
  pending?: boolean;
}

export interface LexLevelMeta {
  id: string;
  name: string;
  short: string;
  description: string;
  total: number;
}

export const LEX_SOURCE: Record<LexLanguage, string> = {
  en: `${LEXICON_SOURCE}；已并入${GRADED_SOURCE()}，分级词中文释义/记忆法/例句为原创撰写`,
  ja: `${JLPT_SOURCE()}；另并入 N3/N2/N1 原创精讲词`,
  ko: '按 TOPIK 官方级别范围与主题分类整理（1–6 级），释义、记忆法、例句为原创撰写',
};

/**
 * 英语分级词的档位换算。
 * 精讲词优先用它在 1600 词表里的真实档位；不在表里的按旧 tier 兜底（basic→L1 / core→L3 / advanced→L5）。
 * 旧的 basic / core / advanced 仍然接受，避免已有的词汇本与链接失效。
 */
const EN_TIER_TO_GRADE: Record<WordTier, ToeflGrade> = {
  basic: 'L1',
  core: 'L3',
  advanced: 'L5',
};
const EN_LEGACY_TO_GRADE: Record<string, ToeflGrade> = {
  basic: 'L1',
  core: 'L3',
  advanced: 'L5',
};

let gradedIndexCache: Map<string, import('./toeflGraded').GradedWord> | null = null;

function gradedIndex(): Map<string, import('./toeflGraded').GradedWord> {
  if (!gradedIndexCache) gradedIndexCache = gradedByTerm();
  return gradedIndexCache;
}

function gradedWordOf(term: string): import('./toeflGraded').GradedWord | undefined {
  return gradedIndex().get(term.toLowerCase());
}

function gradeOfWord(word: LexWord): ToeflGrade {
  return gradedWordOf(word.term)?.level ?? EN_TIER_TO_GRADE[word.tier];
}

function normalizeEnLevel(level?: string): ToeflGrade | undefined {
  if (!level) return undefined;
  if (isToeflGrade(level)) return level;
  return EN_LEGACY_TO_GRADE[level];
}

function toLexEntry(word: LexWord): LexEntry {
  return {
    term: word.term,
    reading: word.ipa,
    pos: word.pos,
    cn: word.cn,
    mnemonic: word.mnemonic,
    example: word.example,
    exampleCn: word.exampleCn,
    syn: word.syn,
    theme: word.theme,
    level: word.tier,
  };
}

export function lexLevels(language: LexLanguage): LexLevelMeta[] {
  if (language === 'ja') {
    // 数量按实际浏览列表去重后的条数统计，保证界面「共 N 词」与列表一致。
    // 口径：JLPT 总库各级别覆盖词 + 不在总库里的原创精讲词（一词只算一次）。
    return JA_LEVEL_ORDER.map((level: JaLevel) => ({
      id: level,
      name: JA_LEVEL_META[level].name,
      short: JA_LEVEL_META[level].short,
      description:
        JLPT_LEVEL_DESCRIPTION[level.toUpperCase() as keyof typeof JLPT_LEVEL_DESCRIPTION] ??
        JA_LEVEL_META[level].description,
      total: listLexEntries('ja', { level }).length,
    }));
  }
  if (language === 'ko') {
    return KO_LEVEL_ORDER.map((level: KoLevel) => ({
      id: level,
      name: KO_LEVEL_META[level].name,
      short: KO_LEVEL_META[level].short,
      description: KO_LEVEL_META[level].description,
      total: KO_WORDS.filter((word) => word.level === level).length,
    }));
  }
  const index = gradedIndex();
  const gradedWords = GRADED_WORDS();
  return GRADED_LEVELS().map((level) => {
    const gradedCount = gradedWords.filter((word) => word.level === level.id).length;
    // 精讲词若已在 1600 表里，已计入 gradedCount，不能再加一次
    const extra = TOEFL_WORDS.filter(
      (word) => !index.has(word.term.toLowerCase()) && gradeOfWord(word) === level.id,
    ).length;
    return {
      id: level.id,
      name: `${level.name} ${level.cefr}`,
      short: level.id,
      description: GRADED_LEVEL_DESCRIPTION[level.id],
      total: gradedCount + extra,
    };
  });
}

/**
 * 内置词库之外的级别短名：词表包里会出现 N5/N4 这类内置词库不收录的级别，
 * 不加这一层，界面上会直接显示「n4」。
 */
const EXTRA_LEVEL_NAME: Record<string, string> = {
  n5: 'N5 入门词',
  n4: 'N4 初级词',
  // 旧英语档位：已进词汇本的词仍可能是这些值，展示时给回对应的 L 档名称
  basic: 'L1 基础',
  core: 'L3 进阶',
  advanced: 'L5 高难·低频',
};

export function lexLevelName(language: LexLanguage, level: string): string {
  const found = lexLevels(language).find((item) => item.id === level)?.name;
  if (found) return found;
  return EXTRA_LEVEL_NAME[level] ?? level.toUpperCase();
}

/** 按级别列出词条（可带关键词），用于「分级词库」浏览 */
export function listLexEntries(
  language: LexLanguage,
  options: { level?: string; query?: string } = {},
): LexEntry[] {
  const { level, query } = options;
  const keyword = query?.trim().toLowerCase();
  if (language === 'ja') {
    const jaLevel = level?.toUpperCase();
    const entries: LexEntry[] = [];
    const seen = new Set<string>();

    // 第一层：原创精讲词（N3/N2/N1），字段完整，优先展示
    for (const word of JA_WORDS) {
      if (jaLevel && word.level.toUpperCase() !== jaLevel) continue;
      if (
        keyword &&
        ![word.term, word.kana, word.cn, word.theme].some((field) =>
          field.toLowerCase().includes(keyword),
        )
      ) {
        continue;
      }
      const key = word.term.toLowerCase();
      seen.add(key);
      entries.push({
        term: word.term,
        reading: word.kana,
        pos: word.pos,
        cn: word.cn,
        mnemonic: word.mnemonic,
        example: word.example,
        exampleCn: word.exampleCn,
        syn: [],
        theme: word.theme,
        level: word.level,
      });
    }

    // 第二层：JLPT 总库全量词。带例句的精讲词直接补全字段；只有核心字段的标 pending。
    for (const word of listJlptWords({ level: jaLevel })) {
      const key = word.term.toLowerCase();
      if (seen.has(key)) continue;
      if (
        keyword &&
        ![word.term, word.kana, word.cn, word.theme].some((field) =>
          field.toLowerCase().includes(keyword),
        )
      ) {
        continue;
      }
      seen.add(key);
      entries.push({
        term: word.term,
        reading: word.kana,
        pos: word.pos,
        cn: word.cn,
        mnemonic: word.mnemonic,
        example: word.example,
        exampleCn: word.exampleCn,
        syn: [],
        theme: word.theme,
        level: word.level.toLowerCase(),
        code: word.code,
        forms: word.inflections || undefined,
        band: word.freq,
        // 日语核心词有中文释义、可正常背诵，不标 pending（pending 专指连释义都缺的词）；
        // 是否精讲由 example 是否为空体现，取词池也只收精讲词。
      });
    }
    return entries;
  }
  if (language === 'ko') {
    return KO_WORDS.filter((word) => (level ? word.level === level : true))
      .filter((word) =>
        keyword
          ? [word.term, word.roman, word.cn, word.theme].some((field) =>
              field.toLowerCase().includes(keyword),
            )
          : true,
      )
      .map((word) => ({
        term: word.term,
        reading: word.roman,
        pos: word.pos,
        cn: word.cn,
        mnemonic: word.mnemonic,
        example: word.example,
        exampleCn: word.exampleCn,
        syn: [],
        theme: word.theme,
        level: word.level,
      }));
  }

  const grade = normalizeEnLevel(level);
  const entries: LexEntry[] = [];
  const seen = new Set<string>();

  // 第一层：精讲词，字段完整（释义 / 记忆法 / 例句），优先展示
  for (const word of TOEFL_WORDS) {
    const key = word.term.toLowerCase();
    const wordGrade = gradeOfWord(word);
    if (grade && wordGrade !== grade) continue;
    if (
      keyword &&
      ![word.term, word.cn, word.theme, word.pos].some((field) =>
        field.toLowerCase().includes(keyword),
      )
    ) {
      continue;
    }
    const graded = gradedWordOf(word.term);
    entries.push({
      ...toLexEntry(word),
      level: wordGrade,
      code: graded?.code,
      forms: graded?.forms,
      relations: graded?.relations,
      band: graded?.band,
    });
    seen.add(key);
  }

  // 第二层：分级词表补足覆盖；缺释义/例句的标 pending，界面显示占位
  for (const word of listGradedWords({ level: grade })) {
    const key = word.term.toLowerCase();
    if (seen.has(key)) continue;
    if (
      keyword &&
      ![word.term, word.theme, word.relations, word.pos].some((field) =>
        field.toLowerCase().includes(keyword),
      )
    ) {
      continue;
    }
    const enhanced = enhancedOf(word.code);
    entries.push({
      term: word.term,
      reading: word.ipa,
      pos: word.pos,
      cn: enhanced?.cn ?? '',
      mnemonic: enhanced?.mnemonic ?? '',
      example: enhanced?.example ?? '',
      exampleCn: enhanced?.exampleCn ?? '',
      syn: [],
      theme: word.theme,
      level: word.level,
      code: word.code,
      forms: word.forms,
      relations: word.relations,
      band: word.band,
      pending: !enhanced,
    });
  }

  return entries;
}

/**
 * 计划级别 → 分级词表档位。
 * 旧档位（basic/core/advanced）只有三档、精讲词 107 个，一天就要 60 个词，很快就「没词可出」；
 * 这里改成按 1600 词表的 L1–L5 连续取，供需才撑得住每日词量。
 */
const LEVEL_GRADES: Record<string, ToeflGrade[]> = {
  hs: ['L1'],
  cet4: ['L1', 'L2'],
  cet6: ['L2', 'L3'],
  cet6plus: ['L3', 'L4'],
  tem4: ['L4', 'L5'],
};

const GRADE_ORDER: ToeflGrade[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

/** 目标分越高越往上带一档：95 分加一档，100 分再加一档（最多到 L5） */
function gradesForPlan(levelId: string, targetScore: number): ToeflGrade[] {
  const grades = [...(LEVEL_GRADES[levelId] ?? ['L2', 'L3'])];
  const extra = targetScore >= 100 ? 2 : targetScore >= 95 ? 1 : 0;
  for (let i = 0; i < extra; i += 1) {
    const last = grades[grades.length - 1];
    const next = GRADE_ORDER[GRADE_ORDER.indexOf(last) + 1];
    if (next && !grades.includes(next)) grades.push(next);
  }
  return grades;
}

/** 分级词表的词 → 词卡字段；精讲词库里有同一词时优先用更完整的释义与例句 */
function gradedToEntry(word: import('./toeflGraded').GradedWord): LexEntry {
  const enhanced = enhancedOf(word.code);
  const rich = TOEFL_WORDS.find((item) => item.term.toLowerCase() === word.term.toLowerCase());
  const base = rich ? toLexEntry(rich) : null;
  return {
    term: word.term,
    reading: word.ipa,
    pos: word.pos,
    cn: base?.cn ?? enhanced?.cn ?? '',
    mnemonic: base?.mnemonic ?? enhanced?.mnemonic ?? '',
    example: base?.example ?? enhanced?.example ?? '',
    exampleCn: base?.exampleCn ?? enhanced?.exampleCn ?? '',
    syn: base?.syn ?? [],
    theme: word.theme,
    level: word.level,
    code: word.code,
    forms: word.forms,
    relations: word.relations,
    band: word.band,
    pending: !(base || enhanced?.cn),
  };
}

/**
 * 英语取词：从 1600 词分级表里按档位轮转取未被学过的词。
 * 只出「有中文释义」的词（还剩 95 个待补，出了也是空卡）；
 * 没有可出的词时宁可少给，也不拿已学过的词假装新词。
 */
function pickEnEntries(options: {
  levelId: string;
  targetScore: number;
  seed: string;
  count: number;
  exclude?: Set<string>;
}): LexEntry[] {
  const { levelId, targetScore, seed, count, exclude } = options;
  const grades = gradesForPlan(levelId, targetScore);
  const buckets = new Map<ToeflGrade, Array<import('./toeflGraded').GradedWord>>();
  for (const grade of grades) {
    const pool = listGradedWords({ level: grade })
      .filter((word) => !(exclude?.has(word.term) ?? false))
      .filter((word) => Boolean(enhancedOf(word.code)?.cn))
      .sort((a, b) => hash(seed + a.term) - hash(seed + b.term));
    buckets.set(grade, pool);
  }

  const picked: Array<import('./toeflGraded').GradedWord> = [];
  let round = 0;
  while (picked.length < count && round < 400) {
    let added = false;
    for (const grade of grades) {
      const next = buckets.get(grade)?.[round];
      if (!next) continue;
      picked.push(next);
      added = true;
      if (picked.length >= count) break;
    }
    if (!added) break;
    round += 1;
  }
  return picked.map(gradedToEntry);
}

/** 取词：英语看「当前水平 + 目标分」，日语/韩语看「当前级别 + 下一级别」 */
export function pickLexEntries(options: {
  language: LexLanguage;
  levelId: string;
  targetScore?: number;
  seed: string;
  count: number;
  exclude?: Set<string>;
}): LexEntry[] {
  const { language, levelId, targetScore = 100, seed, count, exclude } = options;
  if (language === 'ja') {
    return pickJaWords({ levelId, seed, count, exclude }).map((word) => ({
      term: word.term,
      reading: word.kana,
      pos: word.pos,
      cn: word.cn,
      mnemonic: word.mnemonic,
      example: word.example,
      exampleCn: word.exampleCn,
      syn: [],
      theme: word.theme,
      level: word.level,
    }));
  }
  if (language === 'ko') {
    return pickKoWords({ levelId, seed, count, exclude }).map((word) => ({
      term: word.term,
      reading: word.roman,
      pos: word.pos,
      cn: word.cn,
      mnemonic: word.mnemonic,
      example: word.example,
      exampleCn: word.exampleCn,
      syn: [],
      theme: word.theme,
      level: word.level,
    }));
  }
  return pickEnEntries({ levelId, targetScore, seed, count, exclude });
}

/** 日语/韩语词库的「下一篇」提示：低级别计划里出现高级别词时，界面上要说清楚 */
export function isStretchWord(language: LexLanguage, levelId: string, level: string): boolean {
  if (language !== 'ja' && language !== 'ko') return false;
  const order = (language === 'ja' ? JA_LEVEL_ORDER : KO_LEVEL_ORDER) as string[];
  const base = order.indexOf(levelId);
  if (base < 0) return false; // 零基础/未收录的级别不标进阶
  return order.indexOf(level) > base;
}
