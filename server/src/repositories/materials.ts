import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { getSetting, setSetting } from './misc';
import { currentUserId } from '../auth/requestScope';
import type { Language } from '../domain/language';
import type { ParsedUnit, ParsedWord } from '../services/materialParse';

/**
 * 教材类型：教科书（供精读/听力/朗读）、词表包（只供词汇）、语法书（句型手册，供拆句出题）、
 * 参考资料（只在教材库查看）
 */
export type MaterialKind = 'textbook' | 'vocab' | 'grammar' | 'notes';

export interface MaterialRecord {
  id: string;
  language: Language;
  title: string;
  format: string;
  fileName: string;
  fileSize: number;
  unitCount: number;
  wordCount: number;
  charCount: number;
  status: string;
  note: string | null;
  /** 对应考纲级别（ja: n5–n1 / ko: ko1–ko6 / en: basic…）；为空表示未分级 */
  level: string | null;
  kind: MaterialKind;
  origin: string;
  createdAt: string;
}

export interface MaterialUnitRecord {
  id: string;
  idx: number;
  title: string;
  body: string;
  charCount: number;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface MaterialWordRecord {
  id: string;
  term: string;
  reading: string | null;
  pos: string | null;
  meaning: string | null;
  example: string | null;
  unitIdx: number;
  freq: number;
  inLexicon: boolean;
}

interface MaterialRow {
  id: string;
  language: string;
  title: string;
  format: string;
  file_name: string;
  file_size: number;
  unit_count: number;
  word_count: number;
  char_count: number;
  status: string;
  note: string | null;
  level: string | null;
  kind: string;
  origin: string;
  created_at: string;
}

const mapMaterial = (row: MaterialRow): MaterialRecord => ({
  id: row.id,
  language: row.language as Language,
  title: row.title,
  format: row.format,
  fileName: row.file_name,
  fileSize: row.file_size,
  unitCount: row.unit_count,
  wordCount: row.word_count,
  charCount: row.char_count,
  status: row.status,
  note: row.note,
  level: row.level ?? null,
  kind: (row.kind ?? 'textbook') as MaterialKind,
  origin: row.origin ?? 'upload',
  createdAt: row.created_at,
});

export function activeMaterialId(language: Language): string | null {
  return getSetting(`material.active.${language}`);
}

export function setActiveMaterial(language: Language, materialId: string | null): void {
  setSetting(`material.active.${language}`, materialId ?? '');
}

export function listMaterials(
  language?: Language,
  options: { kind?: MaterialKind } = {},
): MaterialRecord[] {
  const clauses = ['user_id = ?'];
  const params: unknown[] = [currentUserId()];
  if (language) {
    clauses.push('language = ?');
    params.push(language);
  }
  if (options.kind) {
    clauses.push('kind = ?');
    params.push(options.kind);
  }
  const rows = db
    .prepare(`SELECT * FROM materials WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`)
    .all(...params) as MaterialRow[];
  return rows.map(mapMaterial);
}

export function getMaterial(id: string): MaterialRecord | null {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as MaterialRow | undefined;
  return row ? mapMaterial(row) : null;
}

export function saveMaterial(params: {
  language: Language;
  title: string;
  format: string;
  fileName: string;
  fileSize: number;
  charCount: number;
  level?: string | null;
  kind?: MaterialKind;
  origin?: string;
  note?: string | null;
  units: ParsedUnit[];
  words: ParsedWord[];
}): MaterialRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const insertMaterial = db.prepare(
    `INSERT INTO materials (id, user_id, language, title, format, file_name, file_size, unit_count, word_count, char_count, status, note, level, kind, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`,
  );
  const insertUnit = db.prepare(
    `INSERT INTO material_units (id, material_id, idx, title, body, char_count, page_from, page_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertWord = db.prepare(
    `INSERT INTO material_words (id, material_id, term, reading, pos, meaning, example, unit_idx, freq, in_lexicon, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    insertMaterial.run(
      id,
      currentUserId(),
      params.language,
      params.title,
      params.format,
      params.fileName,
      params.fileSize,
      params.units.length,
      params.words.length,
      params.charCount,
      params.note ?? null,
      params.level ?? null,
      params.kind ?? 'textbook',
      params.origin ?? 'upload',
      now,
    );
    params.units.forEach((unit) => {
      insertUnit.run(
        randomUUID(),
        id,
        unit.idx,
        unit.title,
        unit.body,
        unit.charCount,
        unit.pageFrom,
        unit.pageTo,
      );
    });
    params.words.forEach((word) => {
      insertWord.run(
        randomUUID(),
        id,
        word.term,
        word.reading,
        word.pos,
        word.meaning,
        word.example,
        word.unitIdx,
        word.freq,
        word.inLexicon ? 1 : 0,
        now,
      );
    });
  });
  run();
  return getMaterial(id)!;
}

export function listUnits(materialId: string): MaterialUnitRecord[] {
  const rows = db
    .prepare('SELECT * FROM material_units WHERE material_id = ? ORDER BY idx')
    .all(materialId) as Array<{
    id: string;
    idx: number;
    title: string;
    body: string;
    char_count: number;
    page_from: number | null;
    page_to: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    idx: row.idx,
    title: row.title,
    body: row.body,
    charCount: row.char_count,
    pageFrom: row.page_from,
    pageTo: row.page_to,
  }));
}

export function getUnit(materialId: string, idx: number): MaterialUnitRecord | null {
  return listUnits(materialId).find((unit) => unit.idx === idx) ?? null;
}

export function listMaterialWords(
  materialId: string,
  options: { unitIdx?: number; limit?: number; onlyLexicon?: boolean } = {},
): MaterialWordRecord[] {
  const { unitIdx, limit = 500, onlyLexicon = false } = options;
  const clauses = ['material_id = ?'];
  const params: unknown[] = [materialId];
  if (typeof unitIdx === 'number') {
    clauses.push('unit_idx = ?');
    params.push(unitIdx);
  }
  if (onlyLexicon) clauses.push('in_lexicon = 1');
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM material_words WHERE ${clauses.join(' AND ')}
       ORDER BY unit_idx, freq DESC LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    term: string;
    reading: string | null;
    pos: string | null;
    meaning: string | null;
    example: string | null;
    unit_idx: number;
    freq: number;
    in_lexicon: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    term: row.term,
    reading: row.reading,
    pos: row.pos,
    meaning: row.meaning,
    example: row.example,
    unitIdx: row.unit_idx,
    freq: row.freq,
    inLexicon: row.in_lexicon === 1,
  }));
}

export function deleteMaterial(id: string): void {
  db.prepare('DELETE FROM materials WHERE id = ?').run(id);
  // 清理指向它的「启用」标记
  (['en', 'ja', 'ko'] as Language[]).forEach((language) => {
    if (activeMaterialId(language) === id) setActiveMaterial(language, null);
  });
}

/** 批量补全释义（大模型回填），同时把 in_lexicon 标 1，方便词汇任务直接使用 */
export function updateMaterialWordMeanings(
  materialId: string,
  items: Array<{ term: string; meaning: string; pos?: string; reading?: string }>,
): number {
  const update = db.prepare(
    `UPDATE material_words SET meaning = ?, pos = COALESCE(NULLIF(?, ''), pos), reading = COALESCE(NULLIF(?, ''), reading), in_lexicon = 1
     WHERE material_id = ? AND term = ?`,
  );
  let updated = 0;
  const run = db.transaction(() => {
    items.forEach((item) => {
      const result = update.run(item.meaning, item.pos ?? '', item.reading ?? '', materialId, item.term);
      updated += result.changes;
    });
  });
  run();
  return updated;
}
