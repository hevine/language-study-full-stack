import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Language } from '../../domain/language';
import type { LevelDef } from '../../catalog/types';
import type { KnowledgeEdgeDef, KnowledgeNodeDef } from '../knowledge/types';

/**
 * 内置语法库 · 内容层
 *
 * 数据：同目录下每个语种一个 JSON（en.json / ja.json / ko.json），
 *       由 `npm run import:grammar-table -- <教研表格.md>` 生成，手工增补时直接改文件。
 * 这里只做三件事：加载并校验、提供查询、派生知识图谱的节点与关系边。不含数据库操作。
 *
 * 三个概念的关系：
 *   语法点（point）  一个具体的语言结构，带级别、接续、释义、类义、例句、考点备注
 *   错因规则（rule） 独立的诊断单元，描述「什么时候错 / 错成什么样 / 怎么判」，可被多个语法点共用
 *   级别（level）    该语种刻度上的一个档位；id 是刻度本身（A2 / N5 / 3），label 是教研的原始写法
 *
 * 约定：
 *   · 编码稳定不改义：语法点 EN-001 永远是「be 动词现在时」，增补只续号；
 *   · 知识图谱节点编码由本文件的 codeOf / ruleCodeOf 统一生成，别处不要自己拼。
 */

const REF_PREFIX: Record<Language, string> = { en: 'EN', ja: 'JP', ko: 'KR' };
const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// ------------------------------------------------------------------ schema

const LevelSchema = z
  .object({ id: z.string().regex(/^[A-Za-z0-9]+$/), label: z.string().min(1) })
  .strict();

const PointSchema = z
  .object({
    ref: z.string().regex(/^[A-Z]{2}-\d{3}$/),
    name: z.string().min(1),
    /** 级别 id，必须在 levels 里声明过 */
    level: z.string().min(1),
    /** 接续（结构） */
    structure: z.string().min(1),
    /** 中文释义 */
    meaning: z.string().min(1),
    /** 类义 / 易混（自由文本，可为空） */
    synonym: z.string(),
    example: z.string().min(1),
    translation: z.string(),
    /** 对应的错因规则编码；没有就写 null */
    errorRule: z.string().regex(/^[A-Z]{2}-ER-\d{2}$/).nullable(),
    /** 考点备注 */
    note: z.string(),
  })
  .strict();

const RuleSchema = z
  .object({
    ref: z.string().regex(/^[A-Z]{2}-ER-\d{2}$/),
    name: z.string().min(1),
    /** 触发条件：什么时候会出这个错 */
    trigger: z.string().min(1),
    /** 典型错误表现 */
    symptom: z.string().min(1),
    /** 纠错判定 */
    judgement: z.string().min(1),
  })
  .strict();

const LibrarySchema = z
  .object({
    language: z.enum(['en', 'ja', 'ko']),
    /** 来源说明，界面展示用 */
    source: z.string().min(1),
    /** 这套语法点面向的考试 */
    examId: z.string().min(1),
    levels: z.array(LevelSchema).min(1),
    points: z.array(PointSchema).min(1),
    rules: z.array(RuleSchema),
  })
  .strict();

export type GrammarPoint = z.infer<typeof PointSchema>;
export type GrammarRule = z.infer<typeof RuleSchema>;
export type GrammarLevel = z.infer<typeof LevelSchema>;
export type GrammarLibrary = z.infer<typeof LibrarySchema>;

/**
 * 校验一份语法库数据（加载与导入脚本共用）。
 * 除了字段形状，还查四件一旦破坏就会让图谱断链的事：
 *   编码前缀与语种一致、编码不重复、级别都已声明、引用的错因规则都存在。
 * 失败抛 Error，信息里带第一条问题的位置。
 */
export function validateGrammarLibrary(input: unknown, label = '语法库'): GrammarLibrary {
  const shape = LibrarySchema.safeParse(input);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    if (!issue) throw new Error(`${label}字段不合法`);
    // invalid_type 时 input 不是对象，不能 JSON 化；其它情况给出出错字段的当前值
    const current =
      issue.code === 'invalid_type' || !input || typeof input !== 'object'
        ? ''
        : `（当前值：${JSON.stringify((input as Record<string, unknown>)[issue.path[0] ?? ''])?.slice(0, 60)}）`;
    throw new Error(
      `${label}字段不合法：第 ${issue.path.join('.')} 项 ${issue.message}${current}`,
    );
  }
  const library = shape.data;
  const prefix = REF_PREFIX[library.language];
  const fail = (message: string): never => {
    throw new Error(`${label}不合法：${message}`);
  };

  const levelIds = new Set<string>();
  for (const level of library.levels) {
    if (levelIds.has(level.id)) fail(`级别 id「${level.id}」重复`);
    levelIds.add(level.id);
  }

  const pointRefs = new Set<string>();
  for (const point of library.points) {
    if (!point.ref.startsWith(`${prefix}-`)) fail(`语法点 ${point.ref} 的编码前缀应为 ${prefix}`);
    if (pointRefs.has(point.ref)) fail(`语法点编码重复：${point.ref}`);
    pointRefs.add(point.ref);
    if (!levelIds.has(point.level)) fail(`语法点 ${point.ref} 的级别「${point.level}」没有在 levels 里声明`);
  }

  const ruleRefs = new Set<string>();
  for (const rule of library.rules) {
    if (!rule.ref.startsWith(`${prefix}-ER-`)) fail(`错因规则 ${rule.ref} 的编码前缀应为 ${prefix}-ER`);
    if (ruleRefs.has(rule.ref)) fail(`错因规则编码重复：${rule.ref}`);
    ruleRefs.add(rule.ref);
  }

  for (const point of library.points) {
    if (point.errorRule && !ruleRefs.has(point.errorRule)) {
      fail(`语法点 ${point.ref} 引用了不存在的错因规则 ${point.errorRule}`);
    }
  }
  return library;
}

/** 供导入脚本用：校验一份即将落盘的数据 */
export function loadGrammarLibraryFile(input: unknown, label: string): GrammarLibrary {
  return validateGrammarLibrary(input, label);
}

// ------------------------------------------------------------------ 加载

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<Language, GrammarLibrary | null>();
export const GRAMMAR_LANGUAGES: Language[] = ['en', 'ja', 'ko'];

function load(language: Language): GrammarLibrary | null {
  const file = path.join(DIR, `${language}.json`);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`内置语法库 ${path.basename(file)} 不是合法的 JSON：${(err as Error).message}`);
  }
  return validateGrammarLibrary(raw, `内置语法库 ${language}.json `);
}

/** 某语种的内置语法库；没有数据文件返回 null */
export function grammarLibrary(language: string): GrammarLibrary | null {
  const lang = language as Language;
  if (!GRAMMAR_LANGUAGES.includes(lang)) return null;
  if (!cache.has(lang)) cache.set(lang, load(lang));
  return cache.get(lang) ?? null;
}

/** 级别表：id、原始名称，以及在该语种刻度上的先后次序（越小越基础） */
export function grammarLevelRank(language: Language, levelId: string): number {
  if (language === 'en') {
    const at = CEFR_ORDER.indexOf(levelId);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  }
  if (language === 'ja') {
    const match = /^N([1-5])$/.exec(levelId);
    return match ? 6 - Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }
  const match = /^([1-6])$/.exec(levelId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** 目录里某个级别覆盖了哪些 CEFR 档：hs 是 A2–B1，cet6plus 是 B2+ */
export function catalogCefrCodes(level: LevelDef): string[] {
  const codes: string[] = [];
  for (const token of level.cefr.split(/[–\-]/)) {
    const code = token.replace(/\+$/, '').trim().toUpperCase();
    if (CEFR_ORDER.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * 一个语法级别对应目录里的哪些学习级别（id）。用来把「计划的级别窗口」换算成「该学哪些语法」。
 * 英语按 CEFR 对应（目录级别没有 CEFR 编号，只有 CEFR 区间），日语 / 韩语的级别编号一一对应。
 */
export function catalogLevelIdsForGrammarLevel(
  language: Language,
  levelId: string,
  levels: LevelDef[],
): string[] {
  if (language === 'en') return levels.filter((level) => catalogCefrCodes(level).includes(levelId)).map((l) => l.id);
  if (language === 'ja') return levels.filter((level) => level.id === levelId.toLowerCase()).map((l) => l.id);
  return levels.filter((level) => level.id === `ko${levelId}`).map((l) => l.id);
}

// ------------------------------------------------------------------ 图谱编码

/** 语法技能节点：语法点都挂在它下面 */
export function grammarSkillCode(language: Language): string {
  return `${language}.grammar`;
}

/** 语法点节点编码：en.grammar.en-001 */
export function grammarPointCode(language: Language, ref: string): string {
  return `${language}.grammar.${ref.toLowerCase()}`;
}

/** 错因规则节点编码：en.error-rule.er-01 */
export function grammarRuleCode(language: Language, ref: string): string {
  return `${language}.error-rule.${ref.toLowerCase()}`;
}

/**
 * 类义边：某个语法点的「类义」一栏恰好写的是另一个语法点的名字，就连一条 similar 边。
 * 只认完全相等 —— 「定语从句（关系代词作主语）」不等于「定语从句」，含糊的归并留给人工。
 */
type RefPair = [string, string];

export function similarGrammarPairs(points: GrammarPoint[]): RefPair[] {
  const refByName = new Map(points.map((point) => [point.name, point.ref]));
  const pairs = new Set<string>();
  for (const point of points) {
    if (!point.synonym) continue;
    const target = refByName.get(point.synonym);
    if (!target || target === point.ref) continue;
    pairs.add([point.ref, target].sort().join('|'));
  }
  return [...pairs].map((key) => key.split('|') as RefPair);
}

interface GrammarKnowledge {
  nodes: KnowledgeNodeDef[];
  edges: KnowledgeEdgeDef[];
}

/** 某语种的语法库在知识图谱里的节点与关系边；没有数据返回 null */
export function grammarKnowledge(language: Language): GrammarKnowledge | null {
  const library = grammarLibrary(language);
  if (!library) return null;

  const labelOf = new Map(library.levels.map((level) => [level.id, level.label]));
  const nodes: KnowledgeNodeDef[] = [
    { code: grammarSkillCode(language), kind: 'skill', name: '语法', sectionKey: 'grammar', sort: 3 },
  ];
  const edges: KnowledgeEdgeDef[] = [];

  library.rules.forEach((rule, index) => {
    nodes.push({
      code: grammarRuleCode(language, rule.ref),
      kind: 'error_rule',
      name: rule.name,
      examId: library.examId,
      sectionKey: 'grammar',
      sort: index + 1,
      meta: { ref: rule.ref, trigger: rule.trigger, symptom: rule.symptom, judgement: rule.judgement },
    });
  });

  library.points.forEach((point, index) => {
    nodes.push({
      code: grammarPointCode(language, point.ref),
      kind: 'grammar',
      name: point.name,
      parent: grammarSkillCode(language),
      examId: library.examId,
      sectionKey: 'grammar',
      levelBand: point.level,
      sort: index + 1,
      meta: {
        ref: point.ref,
        levelLabel: labelOf.get(point.level) ?? point.level,
        structure: point.structure,
        meaning: point.meaning,
        synonym: point.synonym,
        example: point.example,
        translation: point.translation,
        note: point.note,
        errorRule: point.errorRule,
      },
    });
  });

  for (const point of library.points) {
    if (!point.errorRule) continue;
    edges.push({
      from: grammarPointCode(language, point.ref),
      to: grammarRuleCode(language, point.errorRule),
      type: 'explains',
    });
  }
  for (const [a, b] of similarGrammarPairs(library.points)) {
    edges.push({ from: grammarPointCode(language, a), to: grammarPointCode(language, b), type: 'similar', confidence: 0.8 });
  }

  return { nodes, edges };
}
