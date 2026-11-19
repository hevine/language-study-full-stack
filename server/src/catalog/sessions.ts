import { diffDays, todayISO, weekdayName } from '../lib/date';

/**
 * 真实考试场次：让用户直接选「哪一年哪一月的那一场」，
 * 而不是选「3 个月 / 6 个月 / 1 年」这种抽象周期。
 *
 * 数据口径：
 *  - JLPT：日本国际交流基金规定每年两次，固定在 **7 月与 12 月的第一个周日**，
 *    大陆报名约在考前 3 个月开放、窗口仅一周左右，因此只列出报名尚未关闭的场次。
 *  - 托福 iBT：ETS / NEEA 全年滚动排考，每月通常 3–5 场，以周六为主、个别周日与周三；
 *    具体日期逐年公布，这里按「当月第 2 个周六」给出示例日，并标注为预估，
 *    用户可在选中后微调到官网实际放位的那一天。
 */

export interface ExamSession {
  id: string;
  examId: string;
  examName: string;
  /** 建议考试日（JLPT 为精确日期，托福为当月代表场次） */
  date: string;
  year: number;
  month: number;
  weekday: string;
  /** 「3 月 13 日」 */
  dateLabel: string;
  /** 「3 月考次」/「第 2 回（12 月）」 */
  roundLabel: string;
  /** 距今天数 */
  daysAhead: number;
  weeksAhead: number;
  /** 日期是否按规律预估（托福 true / JLPT false） */
  estimated: boolean;
  /** 该场次的一句话说明 */
  note: string;
}

/** 某年某月的第 n 个星期 weekday（0 = 周日） */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(year, month - 1, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  const day = 1 + shift + (n - 1) * 7;
  const m = `${month}`.padStart(2, '0');
  const d = `${day}`.padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function makeSession(
  examId: string,
  examName: string,
  date: string,
  roundLabel: string,
  estimated: boolean,
  note: string,
): ExamSession {
  const [year, month] = date.split('-').map(Number);
  const day = Number(date.split('-')[2]);
  return {
    id: `${examId}-${date}`,
    examId,
    examName,
    date,
    year,
    month,
    weekday: weekdayName(date),
    dateLabel: `${month} 月 ${day} 日`,
    roundLabel,
    daysAhead: diffDays(todayISO(), date),
    weeksAhead: Math.round(diffDays(todayISO(), date) / 7),
    estimated,
    note,
  };
}

function toeflSessions(years: number): ExamSession[] {
  const today = todayISO();
  const start = new Date(today);
  const sessions: ExamSession[] = [];

  for (let offset = 0; offset < years * 12; offset += 1) {
    const cursor = new Date(start.getFullYear(), start.getMonth() + offset, 1);
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;

    // 当月第 2 个周六；若离今天太近（来不及报名+备考），换到第 4 个周六
    let date = nthWeekday(year, month, 6, 2);
    if (diffDays(today, date) < 28) date = nthWeekday(year, month, 6, 4);
    if (diffDays(today, date) < 28) continue;

    sessions.push(
      makeSession(
        'toefl',
        '托福 iBT',
        date,
        `${month} 月考次`,
        true,
        `托福每月通常排 3–5 场（周六为主，偶有周日/周三）。此处以当月第 2 个周六为例，实际考位以 NEEA 报名系统为准。`,
      ),
    );
  }

  return sessions;
}

function jlptSessions(years: number): ExamSession[] {
  const today = todayISO();
  const start = new Date(today);
  const sessions: ExamSession[] = [];

  for (let offset = 0; offset <= years; offset += 1) {
    const year = start.getFullYear() + offset;
    for (const month of [7, 12]) {
      // 官方固定：7 月 / 12 月的第一个周日
      const date = nthWeekday(year, month, 0, 1);
      const days = diffDays(today, date);
      // 大陆报名约考前 3 个月开放且窗口很短；距考试不足 90 天基本已错过报名
      if (days < 90) continue;
      sessions.push(
        makeSession(
          'jlpt',
          'JLPT 日本语能力测试',
          date,
          month === 7 ? '第 1 回（7 月）' : '第 2 回（12 月）',
          false,
          'JLPT 每年仅 7 月、12 月两次，固定为当月第一个周日；报名约考前 3 个月开抢，窗口通常一周且需 24 小时内缴费。',
        ),
      );
    }
  }

  return sessions;
}

function topikSessions(years: number): ExamSession[] {
  const today = todayISO();
  const start = new Date(today);
  const sessions: ExamSession[] = [];

  for (let offset = 0; offset <= years; offset += 1) {
    const year = start.getFullYear() + offset;
    for (const [month, nth] of [
      [4, 2],
      [10, 3],
    ] as const) {
      // 大陆惯例：4 月取第 2 个周日（2026-04-12）、10 月取第 3 个周日（2026-10-18）
      const date = nthWeekday(year, month, 0, nth);
      const days = diffDays(today, date);
      // 报名在考前约 3 个月开放、窗口一周；距考试不足 85 天基本已错过报名
      if (days < 85) continue;
      sessions.push(
        makeSession(
          'topik',
          'TOPIK 韩国语能力考试',
          date,
          `${month === 4 ? '上半年（4 月）' : '下半年（10 月）'}考次`,
          true,
          'TOPIK 大陆每年仅 4 月、10 月两个周日各一场（近年为 4 月第 2 个周日 / 10 月第 3 个周日）。具体日期以 NEEA 公告为准，报名窗口考前约 3 个月、仅一周。',
        ),
      );
    }
  }

  return sessions;
}

const SESSION_SCHEDULE_NOTE: Record<string, string> = {
  toefl:
    'ETS 与教育部教育考试院（NEEA）全年滚动排考，几乎每个周末都有场次，每月 3–5 场；全年考位一般在前一年 11 月下旬统一开放报名。热门城市建议提前 2–3 个月锁定。',
  jlpt: 'JLPT 每年两次，固定在 7 月与 12 月的第一个周日；报名约在考前 3 个月开放，窗口通常只有一周左右，需在 24 小时内完成缴费。',
  topik:
    'TOPIK 大陆纸笔考每年仅两场：4 月与 10 月中旬的周日（TOPIK I 上午、TOPIK II 下午）。报名约考前 3 个月开放（先注册个人信息，2–3 天后开报名缴费），窗口约一周，考位先到先得。',
};

export function buildExamSessions(examId: string, years = 3): ExamSession[] | null {
  if (examId === 'toefl') return toeflSessions(years);
  if (examId === 'jlpt') return jlptSessions(years);
  if (examId === 'topik') return topikSessions(years);
  return null;
}

export function sessionScheduleNote(examId: string): string {
  return SESSION_SCHEDULE_NOTE[examId] ?? '';
}
