import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import LanguageSwitch from '../components/LanguageSwitch';
import { Banner, kindLabel, Ring, SectionCard, Stat, StatusChip, CheckMark } from '../components/ui';
import { diffDays, formatCn, formatShort, todayISO, useApp } from '../store';
import type { Day, Stats } from '../types';

const LEVEL_TEXT: Record<string, string> = {
  comfortable: '节奏舒适',
  tight: '时间偏紧',
  aggressive: '高强度冲刺',
  unrealistic: '时间明显不足',
};

function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function TodayGauge({ value, goal }: { value: number; goal: number }) {
  const pct = goal > 0 ? Math.min(1, value / goal) : 0;
  const r = 33;
  const c = 2 * Math.PI * r;
  return (
    <svg width="94" height="94" viewBox="0 0 94 94" className="dash-gauge" aria-hidden>
      <defs>
        <linearGradient id="dashGaugeStroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent-light)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <circle cx="47" cy="47" r={r} fill="none" stroke="rgba(var(--accent-rgb), 0.13)" strokeWidth="9" />
      <circle
        cx="47"
        cy="47"
        r={r}
        fill="none"
        stroke="url(#dashGaugeStroke)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${(c * pct).toFixed(1)} ${c.toFixed(1)}`}
        transform="rotate(-90 47 47)"
        style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(0.3, 0.9, 0.3, 1)' }}
      />
      <text x="47" y="46" textAnchor="middle" className="dash-gauge-num">
        {Math.round(pct * 100)}
      </text>
      <text x="47" y="60" textAnchor="middle" className="dash-gauge-unit">
        今日目标
      </text>
    </svg>
  );
}

export default function Dashboard() {
  const { plan, language } = useApp();
  const [stats, setStats] = useState<Stats | null>(null);
  const [day, setDay] = useState<Day | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const justDone = (location.state as { justDone?: string } | null)?.justDone ?? null;
  const [toast, setToast] = useState<string | null>(justDone);

  useEffect(() => {
    if (!justDone) return;
    setToast(justDone);
    const timer = window.setTimeout(() => {
      navigate(location.pathname, { replace: true, state: null });
      setToast(null);
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [justDone, location.pathname, navigate]);

  const load = useCallback(async () => {
    try {
      const [nextStats, nextDay] = await Promise.all([api.stats(language), api.dayBrief(todayISO())]);
      setStats(nextStats);
      setDay(nextDay.day);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [language]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (taskId: string, done: boolean) => {
    if (!day) return;
    const optimistic = {
      ...day,
      tasks: day.tasks.map((task) => (task.id === taskId ? { ...task, done } : task)),
    };
    setDay(optimistic);
    try {
      await api.toggleTask(day.date, taskId, done);
      const nextStats = await api.stats(language);
      setStats(nextStats);
    } catch (err) {
      setError((err as Error).message);
      load();
    }
  };

  if (!plan) return null;

  const today = todayISO();
  const daysLeft = Math.max(0, diffDays(today, plan.examDate));
  const weekNumber = Math.min(plan.weeks, Math.floor(diffDays(plan.startDate, today) / 7) + 1);
  const currentPhase =
    plan.roadmap.phases.find((phase) => weekNumber >= phase.startWeek && weekNumber <= phase.endWeek) ??
    plan.roadmap.phases[plan.roadmap.phases.length - 1];

  const doneTasks = day?.tasks.filter((task) => task.done).length ?? 0;
  const totalTasks = day?.tasks.length ?? 0;
  const doneMinutes = day?.tasks.reduce((sum, task) => (task.done ? sum + task.minutes : sum), 0) ?? 0;
  const todayMinutes = day?.tasks.reduce((sum, task) => sum + task.minutes, 0) ?? 0;
  const maxMinutes = Math.max(1, ...(stats?.activity.map((item) => item.minutes) ?? [1]));

  const goalPct = plan.dailyMinutes > 0 ? doneMinutes / plan.dailyMinutes : 0;
  const motto =
    goalPct >= 1
      ? '今日目标已达成，这个节奏保持住'
      : goalPct >= 0.6
        ? '再学一会儿今天就达标了'
        : goalPct > 0
          ? '已经起步，趁热打完铁'
          : '从第一个任务开始，今天就还来得及';

  const curvePts: Array<[number, number]> = (stats?.activity ?? []).map((item, index, arr) => [
    14 + (index * 532) / Math.max(1, arr.length - 1),
    106 - (item.minutes / maxMinutes) * 76,
  ]);
  const linePath = smoothPath(curvePts);
  const areaPath =
    curvePts.length > 1
      ? `${linePath} L ${curvePts[curvePts.length - 1][0].toFixed(1)} 106 L ${curvePts[0][0].toFixed(1)} 106 Z`
      : '';

  return (
    <div>
      {toast ? (
        <div className="toast" role="status">
          <span className="toast-dot" />
          已完成：{toast} · 任务状态已同步
        </div>
      ) : null}
      <div className="page-head">
        <div>
          <div className="eyebrow">{formatCn(today)} · 第 {weekNumber} 周 · {currentPhase?.name}</div>
          <h1>今天只做这几件事</h1>
          <div className="page-sub">
            {plan.examName} · 目标 {plan.targetLabel} · 距离考试还有 {daysLeft} 天
          </div>
        </div>
        <div className="head-side">
          <LanguageSwitch onSwitched={() => void load()} />
          <div className="row">
            <span className="chip chip-accent">{plan.currentLevelName} 起步</span>
            <span className="chip chip-teal">每日 {plan.dailyMinutes} 分钟</span>
          </div>
        </div>
      </div>

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="连续打卡" value={stats?.streak ?? 0} unit="天" hint="中断一天就从零开始算" />
        <Stat
          label="累计学习"
          value={Math.round((stats?.totalMinutes ?? 0) / 60)}
          unit="小时"
          hint={`共 ${stats?.activeDays ?? 0} 个学习日`}
        />
        <Stat
          label="词汇本"
          value={stats?.vocabulary.total ?? 0}
          unit="词"
          hint={`今日待复习 ${stats?.vocabulary.due ?? 0} 个`}
        />
        <Stat
          label="达标概率"
          value={`${Math.round((stats?.plan?.readiness ?? 0) * 100)}`}
          unit="%"
          hint={LEVEL_TEXT[plan.feasibility.level]}
        />
      </div>

      <div className="grid split" style={{ marginBottom: 16 }}>
        <SectionCard
          title={`今日任务 · ${doneTasks}/${totalTasks}`}
          extra={<span className="hint">{todayMinutes} 分钟</span>}
        >
          {day ? (
            <>
              <div className="task-list">
                {day.tasks.map((task) => (
                  <div key={task.id} className={`task${task.done ? ' done' : ''}`}>
                    <button
                      className={`task-check${task.done ? ' done' : ''}`}
                      onClick={() => toggle(task.id, !task.done)}
                      aria-label="切换完成状态"
                    >
                      <CheckMark />
                    </button>
                    <div className="task-body">
                      <div className="task-title">
                        <span className="chip">{kindLabel(task.kind)}</span>
                        {task.title}
                      </div>
                      <div className="task-detail">{task.detail}</div>
                    </div>
                    <div className="task-mins">{task.minutes}′</div>
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <Link to="/today" className="btn btn-primary btn-sm">
                  进入精读与朗读 →
                </Link>
                <span className="hint">今日主题：{day.theme}</span>
              </div>
            </>
          ) : (
            <div className="loading">正在读取今日任务…</div>
          )}
        </SectionCard>

        <div className="stack">
          <SectionCard title="整体进度">
            <div className="ring-wrap">
              <Ring value={stats?.plan?.completionRate ?? 0} size={82} stroke={7} />
              <div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 16 }}>
                  已坚持 {stats?.plan?.doneDays ?? 0} 天
                </div>
                <div className="hint">整份计划共 {stats?.plan?.totalPlanDays ?? plan.weeks * 7} 天</div>
                <div className="hint">达标概率 {Math.round((stats?.plan?.readiness ?? 0) * 100)}%</div>
              </div>
            </div>
            <hr className="divider" />
            <div className="small">
              <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span className="muted">时间覆盖率</span>
                <span>{Math.round(plan.feasibility.ratio * 100)}%</span>
              </div>
              <div className="bar" style={{ marginTop: 4 }}>
                <span style={{ width: `${Math.min(100, plan.feasibility.ratio * 100)}%` }} />
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                所需约 {plan.feasibility.requiredHours} 小时 / 可用 {plan.feasibility.availableHours} 小时
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="阶段"
            extra={<Link className="btn btn-sm" to="/path">学习之路 →</Link>}
          >
            <div className="timeline">
              {plan.roadmap.phases.map((phase, index) => {
                const isCurrent = currentPhase?.key === phase.key;
                return (
                  <div key={phase.key} className={`phase${isCurrent ? ' current' : ''}`}>
                    <div className="phase-dot">{index + 1}</div>
                    <div>
                      <h3>
                        {phase.name}
                        {isCurrent ? <span className="chip chip-accent">当前</span> : null}
                      </h3>
                      <div className="hint">
                        第 {phase.startWeek}–{phase.endWeek} 周
                      </div>
                      <div className="small muted" style={{ marginTop: 4 }}>
                        {phase.goal}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>
        </div>
      </div>

      <SectionCard
        title="输出成绩 · 近 14 天"
        extra={
          <>
            <span className="hint">曲线记录每日学习量 · 点阵标记学习密度</span>
            <Link className="btn btn-sm" to="/practice">批改中心 →</Link>
          </>
        }
      >
        <div className="dash-duo">
          <div className="dash-hero">
            <div className="dash-hero-head">
              <span className="dash-hero-label">今日学习量</span>
              <span className="chip chip-accent">{doneTasks}/{totalTasks} 任务</span>
            </div>
            <div className="dash-hero-body">
              <TodayGauge value={doneMinutes} goal={plan.dailyMinutes} />
              <div className="dash-hero-meta">
                <div className="dash-hero-big">
                  {doneMinutes}
                  <span>分钟</span>
                </div>
                <div className="hint">
                  今日规划 {todayMinutes} 分钟 · 连续 {stats?.streak ?? 0} 天
                </div>
              </div>
            </div>
            <div className="dash-motto">{motto}</div>
          </div>

          <div className="dash-duo-right">
            {stats && stats.practice.attempts > 0 ? (
              <div className="dash-scores">
                <div className="dash-score">
                  <div className="dash-score-label">写作均分</div>
                  <div className="dash-score-num">{stats.practice.write.avg ?? '—'}</div>
                  <div className="dash-score-sub">{stats.practice.write.attempts} 次批改</div>
                </div>
                <div className="dash-score">
                  <div className="dash-score-label">口语均分</div>
                  <div className="dash-score-num">{stats.practice.speak.avg ?? '—'}</div>
                  <div className="dash-score-sub">{stats.practice.speak.attempts} 次批改</div>
                </div>
                <div className="dash-score">
                  <div className="dash-score-label">最近一次</div>
                  <div className="dash-score-num">{stats.practice.lastOverall ?? '—'}</div>
                  <div className="dash-score-sub">共 {stats.practice.attempts} 次</div>
                </div>
              </div>
            ) : (
              <div className="row dash-empty">
                <span className="hint">
                  还没有批改记录。写作与口语提交后会按官方评分维度逐条批改，并计入输出成绩。
                </span>
                <Link className="btn btn-sm btn-primary" to="/practice">
                  去练第一题
                </Link>
              </div>
            )}

            <svg
              className="dash-curve"
              viewBox="0 0 560 118"
              role="img"
              aria-label="近 14 天每日学习量曲线"
            >
              <defs>
                <linearGradient id="dashCurveFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: 'rgba(var(--accent-rgb), 0.3)' }} />
                  <stop offset="100%" style={{ stopColor: 'rgba(var(--accent-rgb), 0.02)' }} />
                </linearGradient>
                <linearGradient id="dashCurveStroke" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="var(--accent-light)" />
                  <stop offset="100%" stopColor="var(--accent)" />
                </linearGradient>
              </defs>
              <line
                x1="8" y1="106" x2="552" y2="106"
                stroke="rgba(var(--accent-rgb), 0.16)"
                strokeDasharray="3 5"
                strokeWidth="1"
              />
              <path d={areaPath} fill="url(#dashCurveFill)" stroke="none" />
              <path
                d={linePath}
                fill="none"
                stroke="url(#dashCurveStroke)"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              {curvePts.map((pt, index) => {
                const item = stats?.activity[index];
                const isToday = index === curvePts.length - 1;
                if (!item || item.minutes === 0) return null;
                return (
                  <g key={item.date}>
                    {isToday ? (
                      <circle className="dash-curve-halo" cx={pt[0]} cy={pt[1]} r="7" fill="rgba(var(--accent-rgb), 0.35)" />
                    ) : null}
                    <circle
                      cx={pt[0]}
                      cy={pt[1]}
                      r={isToday ? 4.4 : 3.1}
                      fill={isToday ? 'var(--accent)' : '#fff'}
                      stroke={isToday ? '#fff' : 'var(--accent)'}
                      strokeWidth="2"
                    >
                      <title>{`${item.date}：${item.minutes} 分钟 / ${item.tasks} 个任务`}</title>
                    </circle>
                  </g>
                );
              })}
            </svg>

            <div className="dash-dots">
              {(stats?.activity ?? []).map((item, index) => {
                const intensity = item.minutes === 0 ? 0 : Math.max(0.15, item.minutes / maxMinutes);
                const isToday = index === (stats?.activity.length ?? 0) - 1;
                return (
                  <div
                    key={item.date}
                    className={`dash-dot${isToday ? ' is-today' : ''}`}
                    title={`${item.date}：${item.minutes} 分钟 / ${item.tasks} 个任务`}
                    style={{
                      background:
                        intensity === 0
                          ? 'rgba(16, 30, 60, 0.07)'
                          : `rgba(var(--accent-rgb), ${0.16 + intensity * 0.74})`,
                    }}
                  />
                );
              })}
            </div>
            <div className="row dash-dots-foot">
              <span className="hint">
                {formatShort(stats?.activity[0]?.date ?? today)} — {formatShort(today)}
              </span>
              <span className="hint">今日 {day?.status ? <StatusChip status={day.status} /> : null}</span>
            </div>
          </div>
        </div>
      </SectionCard>

      <div style={{ marginTop: 16 }}>
        <Banner tone={plan.feasibility.level === 'comfortable' ? 'teal' : 'gold'}>
          <strong>{plan.feasibility.messages[1]}</strong>
          <div style={{ marginTop: 4 }}>{plan.feasibility.suggestions[0]}</div>
        </Banner>
      </div>
    </div>
  );
}
