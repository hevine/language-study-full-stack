import { randomUUID } from 'node:crypto';
import { db, parseJson } from '../db';
import type { ArticlePayload, Question, ReadingSegment, VocabEntry } from '../domain/types';

export interface ArticleRecord extends ArticlePayload {
  id: string;
  kind: 'intensive' | 'extensive';
  source: 'llm' | 'library' | 'material';
  model: string | null;
  estMinutes: number;
}

interface ContentRow {
  id: string;
  day_id: string;
  kind: string;
  title: string;
  body: string;
  translation: string;
  reading_script: string;
  vocab: string;
  questions: string;
  est_minutes: number;
  source: string;
  model: string | null;
}

function mapContent(row: ContentRow): ArticleRecord {
  return {
    id: row.id,
    kind: row.kind as ArticleRecord['kind'],
    title: row.title,
    body: row.body,
    translation: row.translation,
    readingScript: parseJson<{ segments: ReadingSegment[] }>(row.reading_script, { segments: [] }),
    vocab: parseJson<VocabEntry[]>(row.vocab, []),
    questions: parseJson<Question[]>(row.questions, []),
    estMinutes: row.est_minutes,
    source: row.source as ArticleRecord['source'],
    model: row.model,
  };
}

export function listDayContents(dayId: string): ArticleRecord[] {
  const rows = db
    .prepare("SELECT * FROM day_contents WHERE day_id = ? ORDER BY CASE kind WHEN 'intensive' THEN 0 ELSE 1 END")
    .all(dayId) as ContentRow[];
  return rows.map(mapContent);
}

export function deleteDayContents(dayId: string): void {
  db.prepare('DELETE FROM day_contents WHERE day_id = ?').run(dayId);
}

export function saveDayContent(
  params: {
    planId: string;
    dayId: string;
    language: string;
    kind: 'intensive' | 'extensive';
    payload: ArticlePayload;
    source: 'llm' | 'library' | 'material';
    model: string | null;
    estMinutes: number;
  },
): ArticleRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO day_contents
      (id, plan_id, day_id, language, kind, title, body, translation, reading_script, vocab, questions, est_minutes, source, model, created_at)
     VALUES
      (@id, @plan_id, @day_id, @language, @kind, @title, @body, @translation, @reading_script, @vocab, @questions, @est_minutes, @source, @model, @created_at)`,
  ).run({
    id,
    plan_id: params.planId,
    day_id: params.dayId,
    language: params.language,
    kind: params.kind,
    title: params.payload.title,
    body: params.payload.body,
    translation: params.payload.translation,
    reading_script: JSON.stringify(params.payload.readingScript),
    vocab: JSON.stringify(params.payload.vocab),
    questions: JSON.stringify(params.payload.questions),
    est_minutes: params.estMinutes,
    source: params.source,
    model: params.model,
    created_at: new Date().toISOString(),
  });

  return mapContent(db.prepare('SELECT * FROM day_contents WHERE id = ?').get(id) as ContentRow);
}

export function contentCount(planId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM day_contents WHERE plan_id = ?').get(planId) as {
    n: number;
  };
  return row.n;
}
