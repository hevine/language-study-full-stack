const DAY_MS = 86_400_000;

export function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map((part) => Number(part));
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function todayISO(): string {
  return toISO(new Date());
}

export function addDays(iso: string, days: number): string {
  const date = parseISO(iso);
  date.setDate(date.getDate() + days);
  return toISO(date);
}

/** b - a，单位为天 */
export function diffDays(a: string, b: string): number {
  const start = parseISO(a).getTime();
  const end = parseISO(b).getTime();
  return Math.round((end - start) / DAY_MS);
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayName(iso: string): string {
  return WEEKDAY[parseISO(iso).getDay()];
}

export function formatCn(iso: string): string {
  const date = parseISO(iso);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekdayName(iso)}`;
}

export function isStudyDay(dayIndex: number): boolean {
  return dayIndex !== 6;
}
