import { randomUUID } from 'node:crypto';
import { db, parseJson } from '../db';
import type { Language } from '../domain/language';
import type { ArticlePayload, Question, ReadingSegment, VocabEntry } from '../domain/types';

export interface ArticleRecord extends ArticlePayload {
  id: string;
  /** 生成时的语种：缓存命中前用它校验，防止跨语种串台 */
  language: Language;
  kind: 'intensive' | 'extensive';
  source: 'llm' | 'library' | 'material';
  model: string | null;
  estMinutes: number;
  /** 所属计划的目标级别标签（如「N1 合格」「托福 100」）：解题视频用它选教学法 */
  examLabel?: string | null;
  examId?: string | null;
}

interface ContentRow {
  id: string;
  day_id: string;
  language: string;
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
  plan_exam_id?: string | null;
  plan_target_label?: string | null;
}

function mapContent(row: ContentRow): ArticleRecord {
  return {
    id: row.id,
    language: row.language as Language,
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
    examLabel: row.plan_target_label ?? null,
    examId: row.plan_exam_id ?? null,
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

/** 按稳定 id 取单篇精读材料：解题答疑视频以 article.id 为绑定键 */
export function getDayContentById(id: string): ArticleRecord | null {
  if (!id) return null;
  // 带上所属计划的目标级别：解题视频据此选 N1/N5 之类的教学法（拿不到就为 null）
  const row = db
    .prepare(
      `SELECT c.*, p.exam_id AS plan_exam_id, p.target_label AS plan_target_label
         FROM day_contents c
         LEFT JOIN plan_days d ON d.id = c.day_id
         LEFT JOIN plans p ON p.id = d.plan_id
        WHERE c.id = ?`,
    )
    .get(id) as ContentRow | undefined;
  return row ? mapContent(row) : null;
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
