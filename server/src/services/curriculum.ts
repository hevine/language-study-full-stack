import { getLanguage } from '../catalog';
import type { LevelDef } from '../catalog/types';
import type { GeneratedDay, PlanRecord } from '../domain/types';
import {
  activeMaterialId,
  getMaterial,
  listMaterials,
  listUnits,
  type MaterialRecord,
  type MaterialUnitRecord,
} from '../repositories/materials';

/** 一章教材拆成几天：与 materialContent 的节奏保持一致 */
export const DAYS_PER_UNIT = 2;

export interface LevelWindow {
  levels: LevelDef[];
  startIndex: number;
  endIndex: number;
}

export interface TextbookContext {
  material: MaterialRecord;
  unit: MaterialUnitRecord;
  unitCount: number;
  /** 本章所属考纲级别（未分级教材为 null） */
  levelId: string | null;
  levelName: string;
  /** 这本书在当前计划里排第几本 / 共几本 */
  bookIndex: number;
  bookCount: number;
}

const ready = (material: MaterialRecord): boolean => material.status === 'ready';

/** 计划覆盖的级别区间：从当前水平到目标级别（目标级别从 targetLabel 里解析） */
export function planLevelWindow(plan: PlanRecord): LevelWindow {
  const levels = getLanguage(plan.language).levels;
  const rawStart = levels.findIndex((level) => level.id === plan.currentLevelId);
  const startIndex = rawStart >= 0 ? rawStart : 0;

  let targetId: string | null = null;
  if (plan.language === 'ja') {
    const match = plan.targetLabel.match(/N\s*([1-5])/i);
    if (match) targetId = `n${match[1]}`;
  } else if (plan.language === 'ko') {
    const match = plan.targetLabel.match(/([1-6])\s*级/);
    if (match) targetId = `ko${match[1]}`;
  }
  const rawEnd = targetId ? levels.findIndex((level) => level.id === targetId) : -1;
  const endIndex = rawEnd >= startIndex ? rawEnd : levels.length - 1;
  return { levels: levels.slice(startIndex, endIndex + 1), startIndex, endIndex };
}

/** 每个级别的学习量落差（小时），用来把计划天数按级别切段 */
function levelWeights(all: LevelDef[], startIndex: number, endIndex: number): number[] {
  const weights: number[] = [];
  for (let i = startIndex; i <= endIndex; i += 1) {
    const prevHours = i === 0 ? 0 : all[i - 1].hoursFromZero;
    const delta = all[i].hoursFromZero - prevHours;
    weights.push(delta > 0 ? delta : 120);
  }
  return weights;
}

/** plan_days 里的 dayIndex 是「本周第几天」（0–6），教材推进要用全局第几天 */
export function globalDayIndex(day: GeneratedDay): number {
  return day.weekIndex * 7 + day.dayIndex;
}

function unitAt(material: MaterialRecord, dayIndex: number): TextbookContext | null {
  const units = listUnits(material.id);
  if (units.length === 0) return null;
  const unit = units[Math.floor(Math.max(0, dayIndex) / DAYS_PER_UNIT) % units.length];
  return {
    material,
    unit,
    unitCount: units.length,
    levelId: material.level,
    levelName: material.level ? levelNameFor(material.language, material.level) : '未分级',
    bookIndex: 0,
    bookCount: 1,
  };
}

export function levelNameFor(language: PlanRecord['language'], levelId: string): string {
  return getLanguage(language).levels.find((level) => level.id === levelId)?.name ?? levelId.toUpperCase();
}

/**
 * 按计划进度挑「今天该用哪本教材的第几章」。
 *
 * 规则：
 * 1. 只取 kind = textbook 且切好章节的书；
 * 2. 书的级别落在计划区间（当前水平 → 目标级别）内才参与；
 * 3. 多本时按级别学习量把计划天数切片，随天数从低级别走到高级别（0 → N2 就是这样一本本推进）；
 * 4. 没有分级教材时退回「手动启用的那本」，保持旧行为。
 */
export function textbookContextFor(plan: PlanRecord, day: GeneratedDay): TextbookContext | null {
  const books = listMaterials(plan.language, { kind: 'textbook' }).filter(ready);
  if (books.length === 0) return null;

  const window = planLevelWindow(plan);
  const order = new Map(window.levels.map((level, index) => [level.id, index]));
  const leveled = books
    .filter((book) => book.level && order.has(book.level))
    .sort((a, b) => (order.get(a.level!) ?? 0) - (order.get(b.level!) ?? 0) || a.createdAt.localeCompare(b.createdAt));

  if (leveled.length === 0) {
    // 没有分级教材时，只认「手动启用」的那一本；都不启用就走内置题库
    const activeId = activeMaterialId(plan.language);
    if (!activeId) return null;
    const active = getMaterial(activeId);
    if (!active || active.language !== plan.language || active.kind !== 'textbook') return null;
    return unitAt(active, globalDayIndex(day));
  }

  if (leveled.length === 1) return unitAt(leveled[0], globalDayIndex(day));

  const totalDays = Math.max(1, plan.weeks * 7);
  const allLevels = getLanguage(plan.language).levels;
  const weights = levelWeights(allLevels, window.startIndex, window.endIndex);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const elapsed = Math.min(Math.max(globalDayIndex(day), 0), totalDays);

  let cursor = 0;
  for (let i = 0; i < window.levels.length; i += 1) {
    const span = Math.max(1, Math.round((weights[i] / totalWeight) * totalDays));
    if (elapsed < cursor + span || i === window.levels.length - 1) {
      const levelId = window.levels[i].id;
      const candidates = leveled.filter((book) => book.level === levelId);
      // 该级别没书时顺延到下一本有书的级别，避免整段空窗
      const book =
        candidates[0] ??
        leveled.find((item) => (order.get(item.level!) ?? 0) >= i) ??
        leveled[leveled.length - 1];
      const context = unitAt(book, elapsed - cursor);
      if (!context) return null;
      return {
        ...context,
        levelName: levelNameFor(plan.language, levelId),
        bookIndex: leveled.indexOf(book),
        bookCount: leveled.length,
      };
    }
    cursor += span;
  }
  return unitAt(leveled[leveled.length - 1], elapsed);
}

/**
 * 词表包（kind = vocab）：只供词汇任务。
 *
 * 两种参与方式：
 * · 落在计划区间内的（现在 N3→N2，就是 N3/N2 词表）优先，高级别排前面；
 * · 级别低于当前级别的（比如初級词表配 N3 计划）按「补基础」参与，排在高阶词表后面：
 *   初学者手册里的基础词迟早要过一遍，但它是补漏，不该盖过当前级别的词。
 */
export function vocabPacksFor(plan: PlanRecord): MaterialRecord[] {
  const window = planLevelWindow(plan);
  const order = new Map(window.levels.map((level, index) => [level.id, index]));
  const allLevels = getLanguage(plan.language).levels.map((level) => level.id);
  const startIndex = allLevels.indexOf(window.levels[0]?.id ?? '');

  const packs = listMaterials(plan.language, { kind: 'vocab' }).filter(ready);

  const inWindow = packs
    .filter((pack) => !pack.level || order.has(pack.level))
    // 高级别的词表排在前面：冲 N2 时优先出 N2 词表
    .sort((a, b) => (order.get(b.level ?? '') ?? -1) - (order.get(a.level ?? '') ?? -1));

  const belowWindow = packs
    .filter((pack) => pack.level && !order.has(pack.level))
    .filter((pack) => {
      const index = allLevels.indexOf(pack.level!);
      // 只有「比当前级别低」的才算补基础；比目标还高的不塞进来
      return index >= 0 && startIndex >= 0 && index < startIndex;
    })
    // 越接近当前级别越先出
    .sort((a, b) => allLevels.indexOf(b.level!) - allLevels.indexOf(a.level!));

  return [...inWindow, ...belowWindow];
}
