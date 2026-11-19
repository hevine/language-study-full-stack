import { buildExamCalendar, findExamEvent, type ExamCalendar, type ExamEvent } from '../catalog/calendar';
import type { PlanRecord, GeneratedDay, Task } from '../domain/types';
import { saveDayTasks } from '../repositories/plans';

/** 报考事务任务的 id 形如 admin-<eventId>，日期与节点日期严格一致 */
export function adminTaskId(event: ExamEvent): string {
  return `admin-${event.id}`;
}

function toTask(event: ExamEvent): Task {
  return {
    id: adminTaskId(event),
    kind: 'admin',
    title: `【报考】${event.title}`,
    detail: event.what,
    minutes: event.taskMinutes,
    done: false,
    ref: { type: 'none' },
  };
}

/**
 * 把当天的报考事务（报名、选考场、打印准考证、考前检查）合并进当日任务。
 * 幂等：已存在同 id 任务时原样返回；新增任务会立即写库，
 * 这样「切换完成状态」接口可以直接按普通任务处理。
 */
export function ensureExamTasks(plan: PlanRecord, day: GeneratedDay): GeneratedDay {
  const calendar = buildExamCalendar(plan.examId, plan.examDate);
  if (!calendar) return day;

  const due = calendar.events.filter((event) => event.isTask && event.date === day.date);
  if (due.length === 0) return day;

  const existing = new Set(day.tasks.map((task) => task.id));
  const additions = due
    .map(toTask)
    .filter((task) => !existing.has(task.id));

  if (additions.length === 0) return day;

  const tasks = [...day.tasks, ...additions];
  const updated = saveDayTasks(day.id, tasks);
  return updated ?? { ...day, tasks };
}

export interface AdminPayload {
  event: ExamEvent;
  calendar: ExamCalendar;
  /** 该任务对应节点当天的日期 */
  eventDate: string;
  planExamDate: string;
}

/** 「报考事务」任务详情：时间线 + 指引 + 链接 + 费用 */
export function buildAdminDetail(plan: PlanRecord, task: Task): AdminPayload {
  const calendar = buildExamCalendar(plan.examId, plan.examDate);
  if (!calendar) throw new Error('该考试暂不支持报考日历');

  const event = findExamEvent(calendar, task.id.replace(/^admin-/, ''));
  if (!event) throw new Error('报考节点不存在');

  return {
    event,
    calendar,
    eventDate: event.date,
    planExamDate: plan.examDate,
  };
}
