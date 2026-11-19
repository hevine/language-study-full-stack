import { randomUUID } from 'node:crypto';
import { db } from '../db';
import type { VocabEntry } from '../domain/types';
import type { Language } from '../domain/language';
import { todayISO } from '../lib/date';

/** 词条所属的分级词库级别：英语为 basic/core/advanced，日语为 n3/n2/n1 */
export type VocabLevel = string | null;

export interface VocabRecord {
  id: string;
  language: Language;
  term: string;
  reading: string | null;
  pos: string | null;
  meaning: string;
  example: string | null;
  exampleCn: string | null;
  mnemonic: string | null;
  theme: string | null;
  level: VocabLevel;
  syn: string[];
  source: string | null;
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  dueDate: string;
}

interface VocabRow {
  id: string;
  language: Language;
  term: string;
  reading: string | null;
  pos: string | null;
  meaning: string;
  example: string | null;
  example_cn: string | null;
  mnemonic: string | null;
  theme: string | null;
  level: string | null;
  syn: string | null;
  source: string | null;
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  due_date: string;
}

export interface VocabInput extends VocabEntry {
  level?: string;
  theme?: string;
  mnemonic?: string;
  exampleCn?: string;
  syn?: string[];
}

function parseSyn(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function map(row: VocabRow): VocabRecord {
  return {
    id: row.id,
    language: row.language,
    term: row.term,
    reading: row.reading,
    pos: row.pos,
    meaning: row.meaning,
    example: row.example,
    exampleCn: row.example_cn,
    mnemonic: row.mnemonic,
    theme: row.theme,
    level: row.level,
    syn: parseSyn(row.syn),
    source: row.source,
    ease: row.ease,
    intervalDays: row.interval_days,
    reps: row.reps,
    lapses: row.lapses,
    dueDate: row.due_date,
  };
}

/**
 * 幂等写入词表：已存在的词只补齐缺失的释义与分级信息，不覆盖复习进度。
 * language 必须由调用方显式传入（类型上就卡死），确保英语与日语各自成册。
 */
export function upsertWords(
  userId: string,
  language: Language,
  entries: VocabInput[],
  source: string,
): number {
  const statement = db.prepare(`
    INSERT INTO vocab_items (
      id, user_id, language, term, reading, pos, meaning, example, example_cn,
      mnemonic, theme, level, syn, source, due_date, created_at
    )
    VALUES (
      @id, @user_id, @language, @term, @reading, @pos, @meaning, @example, @example_cn,
      @mnemonic, @theme, @level, @syn, @source, @due_date, @created_at
    )
    ON CONFLICT(user_id, language, term) DO UPDATE SET
      meaning    = CASE WHEN vocab_items.meaning = '' THEN excluded.meaning ELSE vocab_items.meaning END,
      reading    = COALESCE(vocab_items.reading, excluded.reading),
      pos        = COALESCE(vocab_items.pos, excluded.pos),
      example    = COALESCE(vocab_items.example, excluded.example),
      example_cn = COALESCE(vocab_items.example_cn, excluded.example_cn),
      mnemonic   = COALESCE(vocab_items.mnemonic, excluded.mnemonic),
      theme      = COALESCE(vocab_items.theme, excluded.theme),
      level      = COALESCE(vocab_items.level, excluded.level),
      syn        = COALESCE(vocab_items.syn, excluded.syn)
  `);

  const exists = db.prepare(
    'SELECT 1 FROM vocab_items WHERE user_id = ? AND language = ? AND term = ?',
  );

  const now = new Date().toISOString();
  const due = todayISO();
  let added = 0;

  const tx = db.transaction(() => {
    for (const entry of entries) {
      const term = entry.term.trim();
      if (!term) continue;
      const isNew = !exists.get(userId, language, term);
      statement.run({
        id: randomUUID(),
        user_id: userId,
        language,
        term,
        reading: entry.reading ?? null,
        pos: entry.pos ?? null,
        meaning: entry.meaning,
        example: entry.example ?? null,
        example_cn: entry.exampleCn ?? null,
        mnemonic: entry.mnemonic ?? null,
        theme: entry.theme ?? null,
        level: entry.level ?? null,
        syn: entry.syn && entry.syn.length > 0 ? JSON.stringify(entry.syn) : null,
        source,
        due_date: due,
        created_at: now,
      });
      if (isNew) added += 1;
    }
  });
  tx();
  return added;
}

export function listDue(
  userId: string,
  language: Language,
  options: { limit?: number } = {},
): VocabRecord[] {
  const today = todayISO();
  const limit = Math.min(200, Math.max(1, options.limit ?? 30));
  return (
    db
      .prepare(
        'SELECT * FROM vocab_items WHERE user_id = ? AND language = ? AND due_date <= ? ORDER BY due_date ASC, created_at ASC LIMIT ?',
      )
      .all(userId, language, today, limit) as VocabRow[]
  ).map(map);
}

export function listWords(
  userId: string,
  language: Language,
  options: { query?: string; level?: string; limit?: number } = {},
): VocabRecord[] {
  const params: unknown[] = [userId, language];
  let sql = 'SELECT * FROM vocab_items WHERE user_id = ? AND language = ?';
  if (options.level) {
    sql += ' AND level = ?';
    params.push(options.level);
  }
  if (options.query) {
    sql += ' AND (term LIKE ? OR meaning LIKE ? OR reading LIKE ?)';
    const like = `%${options.query}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(500, Math.max(1, options.limit ?? 200)));
  return (db.prepare(sql).all(...params) as VocabRow[]).map(map);
}

/** 供「分级词库」判断哪些词已经进了词汇本 */
export function listTerms(userId: string, language: Language): Set<string> {
  const rows = db
    .prepare('SELECT term FROM vocab_items WHERE user_id = ? AND language = ?')
    .all(userId, language) as Array<{ term: string }>;
  return new Set(rows.map((row) => row.term));
}

export function getWord(id: string): VocabRecord | null {
  const row = db.prepare('SELECT * FROM vocab_items WHERE id = ?').get(id) as VocabRow | undefined;
  return row ? map(row) : null;
}

/** 按词面批量取记录：任务页展示词卡时需要拿到 id 才能写回 SRS */
export function findByTerms(userId: string, language: Language, terms: string[]): VocabRecord[] {
  if (terms.length === 0) return [];
  const placeholders = terms.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM vocab_items WHERE user_id = ? AND language = ? AND term IN (${placeholders})`,
    )
    .all(userId, language, ...terms) as VocabRow[];
  return rows.map(map);
}

export function updateSchedule(
  id: string,
  next: { ease: number; intervalDays: number; reps: number; lapses: number; dueDate: string },
): void {
  db.prepare(
    'UPDATE vocab_items SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due_date = ? WHERE id = ?',
  ).run(next.ease, next.intervalDays, next.reps, next.lapses, next.dueDate, id);
}

export function vocabStats(
  userId: string,
  language: Language,
): { total: number; due: number; mastered: number } {
  const today = todayISO();
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM vocab_items WHERE user_id = ? AND language = ?')
    .get(userId, language) as { n: number };
  const due = db
    .prepare(
      'SELECT COUNT(*) AS n FROM vocab_items WHERE user_id = ? AND language = ? AND due_date <= ?',
    )
    .get(userId, language, today) as { n: number };
  const mastered = db
    .prepare(
      'SELECT COUNT(*) AS n FROM vocab_items WHERE user_id = ? AND language = ? AND interval_days >= 21',
    )
    .get(userId, language) as { n: number };
  return { total: total.n, due: due.n, mastered: mastered.n };
}

export interface LevelStat {
  level: string | null;
  total: number;
  due: number;
  mastered: number;
}

/** 按级别统计，供分级词库卡片展示「本库已收 / 已进词汇本 / 今日到期」 */
export function vocabLevelStats(userId: string, language: Language): LevelStat[] {
  const today = todayISO();
  const rows = db
    .prepare(
      `SELECT level,
              COUNT(*) AS total,
              SUM(CASE WHEN due_date <= ? THEN 1 ELSE 0 END) AS due,
              SUM(CASE WHEN interval_days >= 21 THEN 1 ELSE 0 END) AS mastered
       FROM vocab_items
       WHERE user_id = ? AND language = ?
       GROUP BY level`,
    )
    .all(today, userId, language) as Array<{
    level: string | null;
    total: number;
    due: number;
    mastered: number;
  }>;
  return rows.map((row) => ({
    level: row.level,
    total: row.total,
    due: row.due ?? 0,
    mastered: row.mastered ?? 0,
  }));
}
