import { EN_POOL } from './en';
import { JA_POOL } from './ja';
import { KO_POOL } from './ko';
import type { SeedItem, SeedPaper, SeedPool, SectionKey } from './types';

/** 覆盖年份：2000 年至今（含当年），每年一份完整分项卷 */
export const EXAM_START_YEAR = 2000;
export const EXAM_END_YEAR = new Date().getFullYear();

const POOLS: SeedPool[] = [EN_POOL, JA_POOL, KO_POOL];

/** 从池中按偏移取 n 个（环形），保证同卷内不重复 */
function takeCycle<T>(pool: T[], take: number, offset: number): T[] {
  if (pool.length === 0) return [];
  const count = Math.min(take, pool.length);
  const out: T[] = [];
  for (let k = 0; k < count; k += 1) {
    out.push(pool[(((offset + k) % pool.length) + pool.length) % pool.length]);
  }
  return out;
}

/** 分项在卷内的错位量，避免各分项同步平移、年年雷同 */
const SECTION_STRIDE: Record<SectionKey, number> = {
  listening: 1,
  vocab: 3,
  grammar: 5,
  reading: 2,
  writing: 7,
};

function buildPaper(pool: SeedPool, year: number): SeedPaper {
  const yearIdx = year - EXAM_START_YEAR;
  const items: SeedItem[] = [];
  const sections: SeedPaper['sections'] = [];
  let minutes = 0;

  for (const step of pool.plan) {
    const before = items.length;

    if (step.key === 'reading') {
      const groups = takeCycle(pool.reading, step.take, yearIdx * SECTION_STRIDE.reading);
      for (const group of groups) {
        for (const question of group.items) {
          items.push({
            ...question,
            section: 'reading',
            passage: group.passage,
            label: question.label ?? group.label,
          });
        }
      }
    } else if (step.key === 'writing') {
      for (const item of takeCycle(pool.writing, step.take, yearIdx * SECTION_STRIDE.writing)) {
        items.push({ ...item, kind: 'writing', section: 'writing' });
      }
    } else {
      const source = pool[step.key];
      const picked = takeCycle(source, step.take, yearIdx * SECTION_STRIDE[step.key]);
      for (const item of picked) items.push({ ...item, section: step.key });
    }

    const count = items.length - before;
    if (count > 0) {
      sections.push({ key: step.key, label: step.label, count, minutes: step.minutes });
      minutes += step.minutes;
    }
  }

  return {
    id: `${pool.language}-${year}-full`,
    language: pool.language,
    year,
    examName: pool.examName,
    levelLabel: pool.levelLabel,
    title: `${year} 年全项卷`,
    paperType: 'mock',
    sourceNote: `仿真卷 · 按 ${year} 年 ${pool.examName} ${pool.levelLabel} 的题型与考纲编写，非原卷影印；真卷可通过导入加入`,
    durationMin: minutes,
    sections,
    items,
  };
}

function buildAll(): SeedPaper[] {
  const papers: SeedPaper[] = [];
  for (const pool of POOLS) {
    for (let year = EXAM_END_YEAR; year >= EXAM_START_YEAR; year -= 1) {
      papers.push(buildPaper(pool, year));
    }
  }
  return papers;
}

/** 内置题库：三语种 × 2000 至今年，每年一份「听力 / 词汇 / 语法 / 阅读 / 写作」全项卷 */
export const SEED_PAPERS: SeedPaper[] = buildAll();

export const EXAM_YEARS = Array.from(
  { length: EXAM_END_YEAR - EXAM_START_YEAR + 1 },
  (_, index) => EXAM_START_YEAR + index,
).reverse();

export type { SeedItem, SeedPaper, SeedPool, SectionKey } from './types';
