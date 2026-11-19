import { randomUUID } from 'node:crypto';
import { db, parseJson } from '../db';
import type {
  AttemptSummary,
  GradeDimension,
  GradeFeedback,
  GradeStats,
  PracticeAttempt,
  PracticePrompt,
  SubmissionSource,
} from '../domain/practice';
import type { PracticeKind } from '../domain/rubrics';
import { currentUserId } from '../auth/requestScope';

interface PromptRow {
  id: string;
  plan_id: string;
  day_id: string;
  task_id: string;
  kind: string;
  payload: string;
  source: string;
  model: string | null;
  created_at: string;
}

interface AttemptRow {
  id: string;
  user_id: string;
  plan_id: string;
  day_id: string;
  task_id: string;
  kind: string;
  prompt_title: string;
  submission: string;
  submission_source: string;
  duration_seconds: number | null;
  overall: number;
  band_value: number;
  band_label: string;
  band_note: string;
  dimensions: string;
  feedback: string;
  stats: string;
  source: string;
  model: string | null;
  created_at: string;
}

function mapAttempt(row: AttemptRow): PracticeAttempt {
  return {
    id: row.id,
    dayId: row.day_id,
    taskId: row.task_id,
    kind: row.kind === 'speak' ? 'speak' : 'write',
    promptTitle: row.prompt_title,
    submission: row.submission,
    submissionSource: row.submission_source === 'speech' ? 'speech' : 'typed',
    overall: row.overall,
    band: {
      value: row.band_value,
      max: bandMaxFromLabel(row.band_label),
      label: row.band_label,
      note: row.band_note,
    },
    dimensions: parseJson<GradeDimension[]>(row.dimensions, []),
    feedback: parseJson<GradeFeedback>(row.feedback, {
      verdict: '',
      strengths: [],
      issues: [],
      rewrite: null,
      upgrades: [],
      drills: [],
    }),
    stats: parseJson<GradeStats>(row.stats, {
      unit: 'words',
      length: 0,
      sentences: 0,
      paragraphs: 0,
      avgSentence: 0,
      uniqueRatio: 0,
      fillerCount: 0,
      durationSeconds: null,
      wpm: null,
      targetMin: null,
    }),
    source: row.source === 'llm' ? 'llm' : 'heuristic',
    model: row.model,
    createdAt: row.created_at,
    notice: null,
  };
}

function bandMaxFromLabel(label: string): number {
  const match = label.match(/\/\s*([\d.]+)\s*$/);
  return match ? Number(match[1]) : 0;
}

export function getPrompt(dayId: string, taskId: string): PracticePrompt | null {
  const row = db
    .prepare('SELECT * FROM practice_prompts WHERE day_id = ? AND task_id = ?')
    .get(dayId, taskId) as PromptRow | undefined;
  if (!row) return null;
  const payload = parseJson<PracticePrompt | null>(row.payload, null);
  if (!payload) return null;
  return { ...payload, source: row.source === 'llm' ? 'llm' : 'library', model: row.model };
}

export function savePrompt(params: {
  planId: string;
  dayId: string;
  taskId: string;
  kind: PracticeKind;
  payload: PracticePrompt;
}): PracticePrompt {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO practice_prompts (id, plan_id, day_id, task_id, kind, payload, source, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day_id, task_id) DO UPDATE SET payload = excluded.payload, source = excluded.source, model = excluded.model`,
  ).run(
    randomUUID(),
    params.planId,
    params.dayId,
    params.taskId,
    params.kind,
    JSON.stringify(params.payload),
    params.payload.source,
    params.payload.model,
    now,
  );
  return params.payload;
}

export function insertAttempt(params: {
  planId: string;
  dayId: string;
  taskId: string;
  kind: PracticeKind;
  promptTitle: string;
  submission: string;
  submissionSource: SubmissionSource;
  durationSeconds: number | null;
  overall: number;
  band: { value: number; max: number; label: string; note: string };
  dimensions: GradeDimension[];
  feedback: GradeFeedback;
  stats: GradeStats;
  source: 'llm' | 'heuristic';
  model: string | null;
}): PracticeAttempt {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO practice_attempts
      (id, user_id, plan_id, day_id, task_id, kind, prompt_title, submission, submission_source,
       duration_seconds, overall, band_value, band_label, band_note, dimensions, feedback, stats,
       source, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    currentUserId(),
    params.planId,
    params.dayId,
    params.taskId,
    params.kind,
    params.promptTitle,
    params.submission,
    params.submissionSource,
    params.durationSeconds,
    params.overall,
    params.band.value,
    params.band.label,
    params.band.note,
    JSON.stringify(params.dimensions),
    JSON.stringify(params.feedback),
    JSON.stringify(params.stats),
    params.source,
    params.model,
    now,
  );

  return {
    id,
    dayId: params.dayId,
    taskId: params.taskId,
    kind: params.kind,
    promptTitle: params.promptTitle,
    submission: params.submission,
    submissionSource: params.submissionSource,
    overall: params.overall,
    band: params.band,
    dimensions: params.dimensions,
    feedback: params.feedback,
    stats: params.stats,
    source: params.source,
    model: params.model,
    createdAt: now,
    notice: null,
  };
}

export function getAttempt(id: string): PracticeAttempt | null {
  const row = db.prepare('SELECT * FROM practice_attempts WHERE id = ?').get(id) as
    | AttemptRow
    | undefined;
  if (!row) return null;
  const attempt = mapAttempt(row);
  attempt.band.max = bandMaxFromLabel(row.band_label);
  return attempt;
}

export function listTaskAttempts(dayId: string, taskId: string, limit = 8): PracticeAttempt[] {
  const rows = db
    .prepare(
      'SELECT * FROM practice_attempts WHERE day_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(dayId, taskId, limit) as AttemptRow[];
  return rows.map((row) => {
    const attempt = mapAttempt(row);
    attempt.band.max = bandMaxFromLabel(row.band_label);
    return attempt;
  });
}

export function taskAttemptStats(
  dayId: string,
  taskId: string,
): { count: number; best: number | null; last: PracticeAttempt | null } {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n, MAX(overall) AS best FROM practice_attempts WHERE day_id = ? AND task_id = ?',
    )
    .get(dayId, taskId) as { n: number; best: number | null };
  const last = listTaskAttempts(dayId, taskId, 1)[0] ?? null;
  return { count: row.n, best: row.best, last };
}

export function listAttempts(planId: string, limit = 30): PracticeAttempt[] {
  const rows = db
    .prepare('SELECT * FROM practice_attempts WHERE plan_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(planId, limit) as AttemptRow[];
  return rows.map((row) => {
    const attempt = mapAttempt(row);
    attempt.band.max = bandMaxFromLabel(row.band_label);
    return attempt;
  });
}

export function attemptSummaries(limit = 40, language?: string): AttemptSummary[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.day_id, a.task_id, a.kind, a.prompt_title, a.overall, a.band_label, a.band_value,
              a.source, a.created_at, d.date, p.language
       FROM practice_attempts a
       LEFT JOIN plan_days d ON d.id = a.day_id
       LEFT JOIN plans p ON p.id = a.plan_id
       WHERE a.user_id = ?
         ${language ? 'AND p.language = ?' : ''}
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(...(language ? [currentUserId(), language, limit] : [currentUserId(), limit])) as Array<{
    id: string;
    day_id: string;
    task_id: string;
    kind: string;
    prompt_title: string;
    overall: number;
    band_label: string;
    band_value: number;
    source: string;
    created_at: string;
    date: string | null;
    language: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    dayId: row.day_id,
    taskId: row.task_id,
    kind: row.kind === 'speak' ? 'speak' : 'write',
    promptTitle: row.prompt_title,
    overall: row.overall,
    bandLabel: row.band_label,
    bandValue: row.band_value,
    source: row.source === 'llm' ? 'llm' : 'heuristic',
    createdAt: row.created_at,
    date: row.date ?? row.created_at.slice(0, 10),
    language: row.language ?? 'en',
  }));
}

export function practiceSummary(limit = 40, language?: string): {
  attempts: number;
  lastOverall: number | null;
  avgOverall: number | null;
  write: { attempts: number; avg: number | null };
  speak: { attempts: number; avg: number | null };
  trend: Array<{ date: string; overall: number; bandLabel: string; kind: PracticeKind; title: string }>;
} {
  const rows = db
    .prepare(
      `SELECT a.overall, a.kind, a.created_at, a.prompt_title, a.band_label, d.date
       FROM practice_attempts a LEFT JOIN plan_days d ON d.id = a.day_id
       WHERE a.user_id = ?
         ${language ? 'AND a.plan_id IN (SELECT id FROM plans WHERE language = ?)' : ''}
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(...(language ? [currentUserId(), language, limit] : [currentUserId(), limit])) as Array<{
    overall: number;
    kind: string;
    created_at: string;
    prompt_title: string;
    band_label: string;
    date: string | null;
  }>;

  const byKind = (kind: string) => {
    const list = rows.filter((row) => row.kind === kind);
    const avg = list.length === 0 ? null : list.reduce((sum, row) => sum + row.overall, 0) / list.length;
    return { attempts: list.length, avg: avg === null ? null : Math.round(avg) };
  };

  const overalls = rows.map((row) => row.overall);
  const avg = overalls.length === 0 ? null : overalls.reduce((sum, value) => sum + value, 0) / overalls.length;

  return {
    attempts: rows.length,
    lastOverall: overalls[0] ?? null,
    avgOverall: avg === null ? null : Math.round(avg),
    write: byKind('write'),
    speak: byKind('speak'),
    trend: rows
      .slice(0, 12)
      .reverse()
      .map((row) => ({
        date: row.date ?? row.created_at.slice(0, 10),
        overall: Math.round(row.overall),
        bandLabel: row.band_label,
        kind: row.kind === 'speak' ? ('speak' as const) : ('write' as const),
        title: row.prompt_title,
      })),
  };
}

export function attemptsSince(dayId: string): PracticeAttempt[] {
  const rows = db
    .prepare('SELECT * FROM practice_attempts WHERE day_id = ? ORDER BY created_at DESC')
    .all(dayId) as AttemptRow[];
  return rows.map(mapAttempt);
}

/** 按日期 + 任务取批改记录：跨计划聚合，换计划后旧记录依然带得出来 */
export function listAttemptsByDateTask(date: string, taskId: string, limit = 6): PracticeAttempt[] {
  const rows = db
    .prepare(
      `SELECT a.*
         FROM practice_attempts a
         JOIN plan_days d ON d.id = a.day_id
        WHERE a.user_id = ? AND a.task_id = ? AND d.date = ?
        ORDER BY a.created_at DESC
        LIMIT ?`,
    )
    .all(currentUserId(), taskId, date, limit) as AttemptRow[];
  return rows.map((row) => {
    const attempt = mapAttempt(row);
    attempt.band.max = bandMaxFromLabel(row.band_label);
    return attempt;
  });
}

/** 按日期 + 任务反查历史批改所属的计划与天：计划天数被重建后依然能定位到原记录 */
export function findAttemptDay(
  date: string,
  taskId: string,
  userId = currentUserId(),
): { planId: string; dayId: string } | null {
  const row = db
    .prepare(
      `SELECT a.plan_id, a.day_id
         FROM practice_attempts a
         JOIN plan_days d ON d.id = a.day_id
        WHERE a.user_id = ? AND a.task_id = ? AND d.date = ?
        ORDER BY a.created_at DESC
        LIMIT 1`,
    )
    .get(userId, taskId, date) as { plan_id: string; day_id: string } | undefined;
  return row ? { planId: row.plan_id, dayId: row.day_id } : null;
}
