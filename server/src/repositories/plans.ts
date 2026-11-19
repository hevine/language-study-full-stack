import { currentUserId } from '../auth/requestScope';
import { randomUUID } from 'node:crypto';
import { db, parseJson } from '../db';
import type { Feasibility, GeneratedDay, PlanRecord, Roadmap, Task } from '../domain/types';
import type { PlanDraft } from '../services/planner';


interface PlanRow {
  id: string;
  user_id: string;
  language: string;
  exam_id: string;
  exam_name: string;
  current_level_id: string;
  current_level_name: string;
  target_score: number;
  target_label: string;
  start_date: string;
  exam_date: string;
  weeks: number;
  hours_per_week: number;
  daily_minutes: number;
  status: string;
  feasibility: string;
  roadmap: string;
  created_at: string;
}

interface DayRow {
  id: string;
  plan_id: string;
  date: string;
  week_index: number;
  day_index: number;
  phase: string;
  phase_name: string;
  theme: string;
  focus: string;
  tasks: string;
  status: string;
  created_at: string;
}

function mapPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    language: row.language as PlanRecord['language'],
    examId: row.exam_id,
    examName: row.exam_name,
    currentLevelId: row.current_level_id,
    currentLevelName: row.current_level_name,
    targetScore: row.target_score,
    targetLabel: row.target_label,
    startDate: row.start_date,
    examDate: row.exam_date,
    weeks: row.weeks,
    hoursPerWeek: row.hours_per_week,
    dailyMinutes: row.daily_minutes,
    status: row.status,
    feasibility: parseJson<Feasibility>(row.feasibility, {} as Feasibility),
    roadmap: parseJson<Roadmap>(row.roadmap, {} as Roadmap),
    createdAt: row.created_at,
  };
}

function mapDay(row: DayRow): GeneratedDay {
  return {
    id: row.id,
    date: row.date,
    weekIndex: row.week_index,
    dayIndex: row.day_index,
    phase: row.phase as GeneratedDay['phase'],
    phaseName: row.phase_name,
    theme: row.theme,
    focus: parseJson<string[]>(row.focus, []),
    tasks: parseJson<Task[]>(row.tasks, []),
    status: row.status as GeneratedDay['status'],
  };
}

export function computeStatus(tasks: Task[]): GeneratedDay['status'] {
  if (tasks.length === 0) return 'pending';
  const done = tasks.filter((task) => task.done).length;
  if (done === 0) return 'pending';
  return done === tasks.length ? 'done' : 'partial';
}

export function createPlan(draft: PlanDraft, userId = currentUserId()): PlanRecord {
  const now = new Date().toISOString();
  const planId = randomUUID();

  const insertPlan = db.prepare(`
    INSERT INTO plans (
      id, user_id, language, exam_id, exam_name, current_level_id, current_level_name,
      target_score, target_label, start_date, exam_date, weeks, hours_per_week, daily_minutes,
      status, feasibility, roadmap, created_at
    ) VALUES (
      @id, @user_id, @language, @exam_id, @exam_name, @current_level_id, @current_level_name,
      @target_score, @target_label, @start_date, @exam_date, @weeks, @hours_per_week, @daily_minutes,
      'active', @feasibility, @roadmap, @created_at
    )
  `);

  const insertDay = db.prepare(`
    INSERT INTO plan_days (
      id, plan_id, date, week_index, day_index, phase, phase_name, theme, focus, tasks, status, created_at
    ) VALUES (
      @id, @plan_id, @date, @week_index, @day_index, @phase, @phase_name, @theme, @focus, @tasks, @status, @created_at
    )
  `);

  const tx = db.transaction(() => {
    db.prepare("UPDATE plans SET status = 'archived' WHERE user_id = ? AND status = 'active'").run(userId);
    insertPlan.run({
      id: planId,
      user_id: userId,
      language: draft.language,
      exam_id: draft.examId,
      exam_name: draft.examName,
      current_level_id: draft.currentLevelId,
      current_level_name: draft.currentLevelName,
      target_score: draft.targetScore,
      target_label: draft.targetLabel,
      start_date: draft.startDate,
      exam_date: draft.examDate,
      weeks: draft.weeks,
      hours_per_week: draft.hoursPerWeek,
      daily_minutes: draft.dailyMinutes,
      feasibility: JSON.stringify(draft.feasibility),
      roadmap: JSON.stringify(draft.roadmap),
      created_at: now,
    });

    for (const day of draft.days) {
      insertDay.run({
        id: day.id,
        plan_id: planId,
        date: day.date,
        week_index: day.weekIndex,
        day_index: day.dayIndex,
        phase: day.phase,
        phase_name: day.phaseName,
        theme: day.theme,
        focus: JSON.stringify(day.focus),
        tasks: JSON.stringify(day.tasks),
        status: day.status,
        created_at: now,
      });
    }
  });

  tx();
  return getPlan(planId)!;
}

export function getPlan(id: string): PlanRecord | null {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
  return row ? mapPlan(row) : null;
}

export function getActivePlan(userId = currentUserId()): PlanRecord | null {
  const row = db
    .prepare("SELECT * FROM plans WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(userId) as PlanRow | undefined;
  return row ? mapPlan(row) : null;
}

export function listPlans(userId = currentUserId()): PlanRecord[] {
  const rows = db
    .prepare('SELECT * FROM plans WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as PlanRow[];
  return rows.map(mapPlan);
}

export function archivePlan(id: string): void {
  db.prepare("UPDATE plans SET status = 'archived' WHERE id = ?").run(id);
}

/** 切换当前计划：同一时刻只保留一个 active，其余归档但数据完整保留 */
export function activatePlan(id: string, userId = currentUserId()): PlanRecord | null {
  const plan = getPlan(id);
  if (!plan) return null;
  const tx = db.transaction(() => {
    db.prepare("UPDATE plans SET status = 'archived' WHERE user_id = ? AND status = 'active' AND id <> ?").run(
      userId,
      id,
    );
    db.prepare("UPDATE plans SET status = 'active' WHERE id = ?").run(id);
  });
  tx();
  return getPlan(id);
}

export function getDayByDate(planId: string, date: string): GeneratedDay | null {
  const row = db
    .prepare('SELECT * FROM plan_days WHERE plan_id = ? AND date = ?')
    .get(planId, date) as DayRow | undefined;
  return row ? mapDay(row) : null;
}

export function getDayById(id: string): GeneratedDay | null {
  const row = db.prepare('SELECT * FROM plan_days WHERE id = ?').get(id) as DayRow | undefined;
  return row ? mapDay(row) : null;
}

/** 跨计划查找同一天：用于回看当前计划范围之外的旧记录（新计划在前） */
export function listDayContexts(
  date: string,
  userId = currentUserId(),
): Array<{ plan: PlanRecord; day: GeneratedDay }> {
  const rows = db
    .prepare(
      `SELECT d.* FROM plan_days d
         JOIN plans p ON p.id = d.plan_id
        WHERE d.date = ? AND p.user_id = ?
        ORDER BY p.created_at DESC`,
    )
    .all(date, userId) as DayRow[];

  const contexts: Array<{ plan: PlanRecord; day: GeneratedDay }> = [];
  for (const row of rows) {
    const plan = getPlan(row.plan_id);
    if (plan) contexts.push({ plan, day: mapDay(row) });
  }
  return contexts;
}

export function listDays(planId: string, options: { from?: string; to?: string; limit?: number } = {}): GeneratedDay[] {
  const clauses = ['plan_id = ?'];
  const params: unknown[] = [planId];
  if (options.from) {
    clauses.push('date >= ?');
    params.push(options.from);
  }
  if (options.to) {
    clauses.push('date <= ?');
    params.push(options.to);
  }
  const limit = options.limit ? ` LIMIT ${Math.min(400, Math.max(1, options.limit))}` : '';
  const rows = db
    .prepare(`SELECT * FROM plan_days WHERE ${clauses.join(' AND ')} ORDER BY date ASC${limit}`)
    .all(...params) as DayRow[];
  return rows.map(mapDay);
}

export function listDaysAround(planId: string, date: string, before: number, after: number): GeneratedDay[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM plan_days WHERE plan_id = ? AND date <= ? ORDER BY date DESC LIMIT ?
       ) UNION ALL
       SELECT * FROM (
         SELECT * FROM plan_days WHERE plan_id = ? AND date > ? ORDER BY date ASC LIMIT ?
       ) ORDER BY date ASC`,
    )
    .all(planId, date, before, planId, date, after) as DayRow[];
  return rows.map(mapDay);
}

export function saveDayTasks(dayId: string, tasks: Task[]): GeneratedDay | null {
  const status = computeStatus(tasks);
  db.prepare('UPDATE plan_days SET tasks = ?, status = ? WHERE id = ?').run(
    JSON.stringify(tasks),
    status,
    dayId,
  );
  return getDayById(dayId);
}

export function planProgress(planId: string): { total: number; done: number; partial: number; minutes: number } {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial
       FROM plan_days WHERE plan_id = ?`,
    )
    .get(planId) as { total: number; done: number | null; partial: number | null };

  return {
    total: row.total ?? 0,
    done: row.done ?? 0,
    partial: row.partial ?? 0,
    minutes: 0,
  };
}
