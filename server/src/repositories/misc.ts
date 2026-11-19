import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { todayISO } from '../lib/date';
import { currentUserId } from '../auth/requestScope';

export interface Profile {
  userId: string;
  displayName: string;
  goalNote: string | null;
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  goal_note: string | null;
}

export function ensureProfile(userId = currentUserId()): Profile {
  const row = db.prepare('SELECT * FROM profile WHERE user_id = ?').get(userId) as ProfileRow | undefined;
  if (row) {
    return { userId: row.user_id, displayName: row.display_name, goalNote: row.goal_note };
  }
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO profile (user_id, display_name, goal_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, '学员', null, now, now);
  return { userId, displayName: '学员', goalNote: null };
}

export function updateProfile(userId: string, patch: { displayName?: string; goalNote?: string }): Profile {
  ensureProfile(userId);
  const now = new Date().toISOString();
  if (patch.displayName !== undefined) {
    db.prepare('UPDATE profile SET display_name = ?, updated_at = ? WHERE user_id = ?').run(
      patch.displayName.slice(0, 40),
      now,
      userId,
    );
  }
  if (patch.goalNote !== undefined) {
    db.prepare('UPDATE profile SET goal_note = ?, updated_at = ? WHERE user_id = ?').run(
      patch.goalNote.slice(0, 300),
      now,
      userId,
    );
  }
  return ensureProfile(userId);
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, new Date().toISOString());
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function logStudy(params: {
  userId?: string;
  planId?: string | null;
  dayId?: string | null;
  taskId?: string | null;
  kind: string;
  minutes: number;
  score?: number | null;
}): void {
  db.prepare(
    `INSERT INTO study_logs (id, user_id, plan_id, day_id, task_id, kind, minutes, score, log_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    params.userId ?? currentUserId(),
    params.planId ?? null,
    params.dayId ?? null,
    params.taskId ?? null,
    params.kind,
    Math.max(0, Math.round(params.minutes)),
    params.score ?? null,
    todayISO(),
    new Date().toISOString(),
  );
}

export function removeTaskLogs(dayId: string, taskId: string): void {
  db.prepare('DELETE FROM study_logs WHERE day_id = ? AND task_id = ?').run(dayId, taskId);
}

export function activitySeries(
  userId: string,
  days: number,
  language?: string,
): Array<{ date: string; minutes: number; tasks: number }> {
  const rows = db
    .prepare(
      `SELECT log_date AS date, SUM(minutes) AS minutes, COUNT(*) AS tasks
       FROM study_logs
       WHERE user_id = ?
         ${language ? 'AND plan_id IN (SELECT id FROM plans WHERE language = ?)' : ''}
       GROUP BY log_date ORDER BY log_date DESC LIMIT ?`,
    )
    .all(...(language ? [userId, language, days] : [userId, days])) as Array<{
    date: string;
    minutes: number;
    tasks: number;
  }>;
  return rows.reverse();
}

export function totalMinutes(userId: string, language?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(minutes), 0) AS m FROM study_logs
       WHERE user_id = ?
         ${language ? 'AND plan_id IN (SELECT id FROM plans WHERE language = ?)' : ''}`,
    )
    .get(...(language ? [userId, language] : [userId])) as { m: number };
  return row.m;
}

export function studiedDates(userId: string, limit = 400, language?: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT log_date AS d FROM study_logs
       WHERE user_id = ?
         ${language ? 'AND plan_id IN (SELECT id FROM plans WHERE language = ?)' : ''}
       ORDER BY log_date DESC LIMIT ?`,
    )
    .all(...(language ? [userId, language, limit] : [userId, limit])) as Array<{ d: string }>;
  return rows.map((row) => row.d);
}
