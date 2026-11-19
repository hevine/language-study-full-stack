import { addDays, diffDays, todayISO } from '../lib/date';
import { activitySeries, studiedDates, totalMinutes } from '../repositories/misc';
import { getActivePlan, planProgress } from '../repositories/plans';
import { currentUserId } from '../auth/requestScope';
import { practiceSummary } from '../repositories/practice';
import { vocabStats } from '../repositories/vocab';
import { isLanguage, type Language } from '../domain/language';

export interface PracticeStats {
  attempts: number;
  lastOverall: number | null;
  avgOverall: number | null;
  write: { attempts: number; avg: number | null };
  speak: { attempts: number; avg: number | null };
  trend: Array<{ date: string; overall: number; bandLabel: string; kind: 'write' | 'speak'; title: string }>;
}

export interface DashboardStats {
  streak: number;
  totalMinutes: number;
  activeDays: number;
  vocabulary: { total: number; due: number; mastered: number };
  activity: Array<{ date: string; minutes: number; tasks: number }>;
  practice: PracticeStats;
  plan: null | {
    id: string;
    examName: string;
    targetLabel: string;
    daysLeft: number;
    totalDays: number;
    completionRate: number;
    doneDays: number;
    totalPlanDays: number;
    readiness: number;
    feasibilityLevel: string;
    phaseName: string | null;
  };
}

function computeStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  const today = todayISO();
  const sorted = [...dates].sort().reverse();
  const first = sorted[0];
  if (first !== today && first !== addDays(today, -1)) return 0;

  let streak = 1;
  let cursor = first;
  for (let index = 1; index < sorted.length; index += 1) {
    const expected = addDays(cursor, -1);
    if (sorted[index] === expected) {
      streak += 1;
      cursor = expected;
    } else if (sorted[index] === cursor) {
      continue;
    } else {
      break;
    }
  }
  return streak;
}

export function buildStats(userId = currentUserId(), requestedLanguage?: string): DashboardStats {
  const plan = getActivePlan(userId);
  // 语言维度：显式传入优先（前端切语种时立刻按目标语种取数），否则跟当前激活计划
  const language: Language = isLanguage(requestedLanguage) ? requestedLanguage : plan?.language ?? 'en';

  const dates = studiedDates(userId, 400, language);
  const vocabulary = vocabStats(userId, language);

  const recent = activitySeries(userId, 40, language);
  const byDate = new Map(recent.map((row) => [row.date, row]));

  const today = todayISO();
  const activity: DashboardStats['activity'] = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const row = byDate.get(date);
    activity.push({ date, minutes: row?.minutes ?? 0, tasks: row?.tasks ?? 0 });
  }

  let planSummary: DashboardStats['plan'] = null;
  // 计划概要只描述「当前语种」的计划，避免切语种时首页还挂着别的语言的备考进度
  if (plan && plan.language === language) {
    const progress = planProgress(plan.id);
    const totalDays = diffDays(plan.startDate, plan.examDate) + 1;
    const daysLeft = Math.max(0, diffDays(today, plan.examDate));
    const completionRate = progress.total === 0 ? 0 : progress.done / progress.total;
    const readiness = Math.min(
      0.97,
      Math.max(0.03, plan.feasibility.probability * (0.62 + 0.38 * completionRate)),
    );

    planSummary = {
      id: plan.id,
      examName: plan.examName,
      targetLabel: plan.targetLabel,
      daysLeft,
      totalDays,
      completionRate: Math.round(completionRate * 100) / 100,
      doneDays: progress.done,
      totalPlanDays: progress.total,
      readiness: Math.round(readiness * 100) / 100,
      feasibilityLevel: plan.feasibility.level,
      phaseName: plan.roadmap.phases[0]?.name ?? null,
    };
  }

  return {
    streak: computeStreak(dates),
    totalMinutes: totalMinutes(userId, language),
    activeDays: dates.length,
    vocabulary,
    activity,
    practice: practiceSummary(40, language),
    plan: planSummary,
  };
}
