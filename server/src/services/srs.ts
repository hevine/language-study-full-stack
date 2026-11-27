import { addDays, todayISO } from '../lib/date';

/** 0 忘记 / 1 模糊 / 2 记得 / 3 熟练 */
export type Grade = 0 | 1 | 2 | 3;

export interface NextSchedule {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  dueDate: string;
}

/** 只要求调度需要的四个字段：词汇本和复习卡共用同一套算法 */
export type Schedulable = Pick<NextSchedule, 'ease' | 'intervalDays' | 'reps' | 'lapses'>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** SM-2 简化版：只保留对自学最有效的四个档位 */
export function scheduleNext(current: Schedulable, grade: Grade): NextSchedule {
  let ease = current.ease;
  let intervalDays = current.intervalDays;
  let reps = current.reps;
  let lapses = current.lapses;

  reps += 1;

  if (grade === 0) {
    lapses += 1;
    ease = clamp(ease - 0.2, 1.3, 2.8);
    intervalDays = 1;
  } else if (grade === 1) {
    ease = clamp(ease - 0.1, 1.3, 2.8);
    intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
  } else if (grade === 2) {
    intervalDays = intervalDays <= 1 ? 3 : Math.round(intervalDays * ease);
  } else {
    ease = clamp(ease + 0.1, 1.3, 2.8);
    intervalDays = intervalDays <= 1 ? 5 : Math.round(intervalDays * ease * 1.25);
  }

  intervalDays = clamp(intervalDays, 1, 180);

  return {
    ease: Math.round(ease * 100) / 100,
    intervalDays,
    reps,
    lapses,
    dueDate: addDays(todayISO(), intervalDays),
  };
}
