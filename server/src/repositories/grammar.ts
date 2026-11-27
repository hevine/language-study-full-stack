/**
 * 内置语法库 · 读路径
 *
 * 语法点与错因规则都是知识图谱里的节点（knowledge_points），
 * 「语法点 → 它对应的错因规则」是 explains 边，所以这里全部从图谱读，
 * 而不是直接读内容文件 —— 这样以后人工补的、模型抽取的语法点，
 * 只要写进了图谱，就会和内置的一起出现在语法库里，走同一条读取路径。
 *
 * 只读；写入发生在启动期（services/knowledgeSeed.ts → upsertKnowledgeTree）。
 */
import { CATALOG, findExam } from '../catalog';
import type { LevelDef } from '../catalog/types';
import {
  catalogCefrCodes,
  catalogLevelIdsForGrammarLevel,
  grammarLevelRank,
  grammarLibrary,
} from '../content/grammar';
import { db } from '../db';
import type { Language } from '../domain/language';

export interface GrammarPointView {
  /** 教研编码，如 EN-001 */
  ref: string;
  /** 知识图谱节点编码，如 en.grammar.en-001 */
  code: string;
  name: string;
  /** 级别 id（A2 / N5 / 3）与教研原始写法（T1/A2 / N5 / TOPIK 1） */
  level: string;
  levelLabel: string;
  structure: string;
  meaning: string;
  synonym: string;
  example: string;
  translation: string;
  note: string;
  errorRule: { ref: string; code: string; name: string } | null;
}

export interface GrammarRuleView {
  ref: string;
  code: string;
  name: string;
  trigger: string;
  symptom: string;
  judgement: string;
  /** 共用这条规则的语法点数 */
  pointCount: number;
  /** 共用这条规则的语法点（教研编码，按收录顺序） */
  pointRefs: string[];
}

export interface GrammarLevelView {
  id: string;
  label: string;
  /** 卡片上的短标签：A2 / N5 / 3级 */
  short: string;
  total: number;
  /** 目录里对应的学习级别，用来和计划的级别对上 */
  catalogLevels: Array<{ id: string; name: string }>;
}

export interface GrammarLibraryView {
  language: Language;
  source: string;
  examId: string;
  examName: string;
  levels: GrammarLevelView[];
  points: GrammarPointView[];
  rules: GrammarRuleView[];
  stats: {
    points: number;
    rules: number;
    /** 挂了错因规则的语法点数 */
    linkedPoints: number;
    /** 至少被一个语法点引用的规则数 */
    linkedRules: number;
    /** 图谱里还没有这个语种的语法节点（启动期写入失败，或服务还没重启） */
    seeded: boolean;
  };
}

export interface GrammarLibraryQuery {
  /** 只看某个级别 */
  level?: string;
  /** 搜索：名称、接续、释义、类义、例句、编码；同时作用于错因规则 */
  query?: string;
}

interface PointRow {
  code: string;
  name: string;
  level: string;
  meta_json: string;
}

interface RuleRow {
  code: string;
  name: string;
  meta_json: string;
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 某语种的内置语法库：级别表（带收录量）、语法点、错因规则。级别上的收录量不受筛选影响 */
export function getGrammarLibrary(
  language: Language,
  options: GrammarLibraryQuery = {},
): GrammarLibraryView {
  const library = grammarLibrary(language);
  const catalogLevels: LevelDef[] = CATALOG[language]?.levels ?? [];

  const pointRows = db
    .prepare(
      `SELECT id AS code, name, level_band AS level, meta_json
         FROM knowledge_points
        WHERE language = ? AND kind = 'grammar'
        ORDER BY sort_idx, id`,
    )
    .all(language) as PointRow[];
  const ruleRows = db
    .prepare(
      `SELECT id AS code, name, meta_json
         FROM knowledge_points
        WHERE language = ? AND kind = 'error_rule'
        ORDER BY sort_idx, id`,
    )
    .all(language) as RuleRow[];
  // 语法点 → 错因规则：explains 边
  const linkRows = db
    .prepare(
      `SELECT f.id AS point_id, e.to_id AS rule_id
         FROM kp_edges e
         JOIN knowledge_points f ON f.id = e.from_id
        WHERE e.type = 'explains' AND f.language = ? AND f.kind = 'grammar'`,
    )
    .all(language) as Array<{ point_id: string; rule_id: string }>;
  const ruleByPoint = new Map(linkRows.map((row) => [row.point_id, row.rule_id]));

  const pointMetas = pointRows.map((row) => parseMeta(row.meta_json));
  // 节点编码 → 教研编码
  const refByCode = new Map(pointRows.map((row, index) => [row.code, text(pointMetas[index].ref) || row.code]));

  const rules: GrammarRuleView[] = ruleRows.map((row) => {
    const meta = parseMeta(row.meta_json);
    const covered = pointRows.filter((point) => ruleByPoint.get(point.code) === row.code);
    return {
      ref: text(meta.ref),
      code: row.code,
      name: row.name,
      trigger: text(meta.trigger),
      symptom: text(meta.symptom),
      judgement: text(meta.judgement),
      pointCount: covered.length,
      pointRefs: covered.map((point) => refByCode.get(point.code) ?? point.code),
    };
  });
  const ruleByCode = new Map(rules.map((rule) => [rule.code, rule]));

  const labelOf = new Map((library?.levels ?? []).map((level) => [level.id, level.label]));
  const allPoints: GrammarPointView[] = pointRows
    .map((row, index) => {
      const meta = pointMetas[index];
      const rule = ruleByPoint.has(row.code) ? ruleByCode.get(ruleByPoint.get(row.code)!) : undefined;
      return {
        ref: refByCode.get(row.code) ?? row.code,
        code: row.code,
        name: row.name,
        level: row.level,
        levelLabel: text(meta.levelLabel) || labelOf.get(row.level) || row.level,
        structure: text(meta.structure),
        meaning: text(meta.meaning),
        synonym: text(meta.synonym),
        example: text(meta.example),
        translation: text(meta.translation),
        note: text(meta.note),
        errorRule: rule ? { ref: rule.ref, code: rule.code, name: rule.name } : null,
      };
    })
    // 级别由浅入深；同一级别内保持收录顺序（稳定排序）
    .sort((a, b) => grammarLevelRank(language, a.level) - grammarLevelRank(language, b.level));

  // 级别表以内容文件为准（那里有教研的原始名称）；图谱里多出来的级别（人工补的）追加在后
  const totals = new Map<string, number>();
  for (const point of allPoints) totals.set(point.level, (totals.get(point.level) ?? 0) + 1);
  const levelIds = [...labelOf.keys(), ...[...totals.keys()].filter((id) => !labelOf.has(id))];
  const catalogName = new Map(catalogLevels.map((level) => [level.id, level.name]));
  const levels: GrammarLevelView[] = levelIds.map((id) => ({
    id,
    label: labelOf.get(id) ?? allPoints.find((point) => point.level === id)?.levelLabel ?? id,
    short: language === 'ko' ? `${id}级` : id,
    total: totals.get(id) ?? 0,
    catalogLevels: catalogLevelIdsForGrammarLevel(language, id, catalogLevels).map((levelId) => ({
      id: levelId,
      name: catalogName.get(levelId) ?? levelId,
    })),
  }));

  const needle = options.query?.trim().toLowerCase() ?? '';
  const hit = (fields: string[]): boolean => fields.some((field) => field.toLowerCase().includes(needle));
  const points = allPoints.filter((point) => {
    if (options.level && point.level !== options.level) return false;
    return (
      !needle ||
      hit([
        point.name,
        point.ref,
        point.structure,
        point.meaning,
        point.synonym,
        point.example,
        point.translation,
        point.note,
      ])
    );
  });
  const matchedRules = needle
    ? rules.filter((rule) => hit([rule.name, rule.ref, rule.trigger, rule.symptom, rule.judgement]))
    : rules;

  let examName = library?.examId ?? '';
  if (examName) {
    try {
      examName = findExam(examName).name;
    } catch {
      examName = library?.examId ?? '';
    }
  }

  return {
    language,
    source: library?.source ?? '',
    examId: library?.examId ?? '',
    examName,
    levels,
    points,
    rules: matchedRules,
    stats: {
      points: allPoints.length,
      rules: rules.length,
      linkedPoints: allPoints.filter((point) => point.errorRule).length,
      linkedRules: rules.filter((rule) => rule.pointCount > 0).length,
      seeded: allPoints.length > 0 || rules.length > 0,
    },
  };
}

/**
 * 计划的级别窗口对应内置语法库的哪些级别。
 * 窗口内一个都对不上时（比如英语目录的六级是 B2，而语法表没有 B2 档），
 * 取离窗口起点最近的那个档；一样近时取较低的 —— 句型偏易只是练得浅，偏难会练不动。
 */
export function grammarLevelsForPlan(language: Language, windowLevels: LevelDef[]): string[] {
  const library = grammarLibrary(language);
  if (!library) return [];
  const inWindow = library.levels
    .filter((level) => catalogLevelIdsForGrammarLevel(language, level.id, windowLevels).length > 0)
    .map((level) => level.id);
  if (inWindow.length > 0 || windowLevels.length === 0) return inWindow;

  const first = windowLevels[0];
  const startRank =
    language === 'ja'
      ? grammarLevelRank(language, first.id.toUpperCase())
      : language === 'ko'
        ? grammarLevelRank(language, first.id.replace(/^ko/, ''))
        : Math.max(...catalogCefrCodes(first).map((code) => grammarLevelRank(language, code)));
  const ranked = library.levels
    .map((level) => ({ id: level.id, rank: grammarLevelRank(language, level.id) }))
    .sort(
      (a, b) => Math.abs(a.rank - startRank) - Math.abs(b.rank - startRank) || a.rank - b.rank,
    );
  return ranked.length > 0 ? [ranked[0].id] : [];
}
