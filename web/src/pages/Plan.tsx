import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Banner, Ring, SectionCard } from '../components/ui';
import { formatShort, useApp } from '../store';
import type { DaySummary, ExamCalendar } from '../types';
import ExamCalendarCard from '../components/ExamCalendar';

const LEVEL_TEXT: Record<string, string> = {
  comfortable: '节奏舒适 · 按计划走即可',
  tight: '时间偏紧 · 需要稳定出勤',
  aggressive: '高强度冲刺 · 容错率低',
  unrealistic: '时间明显不足 · 建议调整目标或周期',
};

const LEVEL_TONE: Record<string, 'teal' | 'gold' | 'danger'> = {
  comfortable: 'teal',
  tight: 'gold',
  aggressive: 'gold',
  unrealistic: 'danger',
};

export default function PlanPage() {
  const { plan, catalog } = useApp();
  const [days, setDays] = useState<DaySummary[]>([]);
  const [calendar, setCalendar] = useState<ExamCalendar | null>(null);

  useEffect(() => {
    api
      .activePlan()
      .then((response) => setDays(response.days ?? []))
      .catch(() => setDays([]));
  }, [plan?.id]);

  useEffect(() => {
    if (!plan) return;
    api
      .planCalendar(plan.id)
      .then(setCalendar)
      .catch(() => setCalendar(null));
  }, [plan]);

  const weeks = useMemo(() => {
    const map = new Map<number, DaySummary[]>();
    for (const day of days) {
      const list = map.get(day.weekIndex) ?? [];
      list.push(day);
      map.set(day.weekIndex, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [days]);

  if (!plan) return null;

  const exam = catalog?.languages
    .flatMap((language) => language.exams)
    .find((item) => item.id === plan.examId);

  const ratio = Math.min(1, plan.feasibility.ratio);
  const tone = LEVEL_TONE[plan.feasibility.level] ?? 'gold';

  return (
    <div className="plan-stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Plan · {plan.startDate} → {plan.examDate}</div>
          <h1>{plan.examName} · {plan.targetLabel}</h1>
          <div className="page-sub">
            {plan.currentLevelName} 起步 · {plan.weeks} 周 · 每周 {plan.hoursPerWeek} 小时 · 每日{' '}
            {plan.dailyMinutes} 分钟
          </div>
        </div>
        <span className="chip chip-accent">{LEVEL_TEXT[plan.feasibility.level]}</span>
      </div>

      <div className="grid split-rev">
        <SectionCard title="达标概率评估">
          <div className="ring-wrap">
            <Ring
              value={plan.feasibility.probability}
              size={92}
              stroke={8}
              color={plan.feasibility.level === 'comfortable' ? 'var(--ok)' : 'var(--accent)'}
            />
            <div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>
                {LEVEL_TEXT[plan.feasibility.level].split(' · ')[0]}
              </div>
              <div className="hint">按当前出勤与时长估算的通关概率</div>
              <div className="hint">
                建议周期 {plan.feasibility.recommendedWeeks} 周 · 当前 {plan.weeks} 周
              </div>
            </div>
          </div>

          <hr className="divider" />

          <div className="small">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">时间覆盖率</span>
              <span>{Math.round(plan.feasibility.ratio * 100)}%</span>
            </div>
            <div className={`bar${tone === 'teal' ? ' teal' : ''}`} style={{ marginTop: 5 }}>
              <span style={{ width: `${ratio * 100}%` }} />
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              可用 {plan.feasibility.availableHours} 小时（折算有效 {plan.feasibility.effectiveHours} 小时）
              ，考纲估算需要 {plan.feasibility.requiredHours} 小时。
            </div>
          </div>

          <hr className="divider" />

          <div className="grid grid-2">
            <div>
              <div className="stat-label">词汇缺口</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{plan.roadmap.vocabGap} 词</div>
            </div>
            <div>
              <div className="stat-label">每日新词</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>
                {plan.roadmap.newWordsPerDay} 个
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="这个目标意味着什么">
          <div className="stack" style={{ gap: 10 }}>
            {plan.feasibility.messages.map((message, index) => (
              <p key={index} className="small" style={{ lineHeight: 1.8 }}>
                · {message}
              </p>
            ))}
          </div>
          <hr className="divider" />
          <div className="stack" style={{ gap: 8 }}>
            {plan.feasibility.suggestions.map((suggestion, index) => (
              <Banner key={index} tone={index === 0 ? tone : 'teal'}>
                {suggestion}
              </Banner>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="grid grid-2">
        <SectionCard title="单项分数目标">
          {plan.roadmap.sectionTargets.map((section) => {
            const pct = section.target === 0 ? 0 : Math.min(100, (section.from / section.target) * 100);
            return (
              <div key={section.id}>
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
                  <span className="small">{section.name}</span>
                  <span className="nums small muted">
                    {section.from} → {section.target}
                  </span>
                </div>
                <div className="bar" style={{ marginTop: 5 }}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <div className="hint" style={{ marginTop: 12 }}>
            左侧深色为按当前水平估算的起点，右侧数字为本阶段要打到的目标。
          </div>
        </SectionCard>

        <SectionCard title="考纲要点">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9, color: 'var(--ink-soft)' }}>
            {plan.roadmap.syllabus.map((item) => (
              <li key={item} style={{ marginBottom: 4 }}>
                {item}
              </li>
            ))}
          </ul>
          {exam?.scaleNote ? (
            <div className="hint" style={{ marginTop: 10 }}>
              {exam.scaleNote}
            </div>
          ) : null}
        </SectionCard>
      </div>

      {calendar ? (
        <div>
          <SectionCard
            title="报考日历 · 报名 / 选考场 / 准考证"
            extra={<span className="hint">考试日期 {calendar.examDate} · 节点会自动排进当日任务</span>}
          >
            <ExamCalendarCard calendar={calendar} compact />
          </SectionCard>
        </div>
      ) : null}

      <SectionCard title="三阶段推进" extra={<span className="hint">共 {plan.weeks} 周</span>}>
        <div className="timeline">
          {plan.roadmap.phases.map((phase, index) => (
            <div key={phase.key} className="phase">
              <div className="phase-dot">{index + 1}</div>
              <div>
                <h3>
                  {phase.name}
                  <span className="chip">
                    第 {phase.startWeek}–{phase.endWeek} 周
                  </span>
                </h3>
                <div className="small muted" style={{ marginTop: 4 }}>
                  {phase.goal}
                </div>
                <div className="phase-focus">
                  {phase.focus.map((item) => (
                    <span key={item} className="chip chip-gold">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div>
        <SectionCard title="逐周安排" extra={<span className="hint">每周第 7 天为复盘日</span>}>
          {weeks.length === 0 ? (
            <div className="loading">正在载入日程…</div>
          ) : (
            weeks.map(([weekIndex, list]) => {
              const first = list[0];
              const last = list[list.length - 1];
              return (
                <div key={weekIndex} className="week-row">
                  <div className="week-label">W{weekIndex + 1}</div>
                  <div>
                    <div style={{ fontWeight: 500 }}>{first.theme}</div>
                    <div className="hint">
                      {formatShort(first.date)} – {formatShort(last.date)} · {first.phaseName}
                    </div>
                  </div>
                  <div className="dots">
                    {list.map((day) => (
                      <span key={day.id} className={`dot ${day.status}`} title={`${day.date} · ${day.status}`} />
                    ))}
                  </div>
                  <div className="hint" style={{ textAlign: 'right' }}>
                    {list.reduce((sum, day) => sum + day.doneCount, 0)}/
                    {list.reduce((sum, day) => sum + day.taskCount, 0)} 任务
                  </div>
                </div>
              );
            })
          )}
        </SectionCard>
      </div>

      <div>
        <Banner tone="teal">
          计划是底线不是上限：某个阶段提前达标，就在「设置」里把考试日期提前，让系统重算节奏；连续三天没完成，说明每日时长定高了，别硬扛。
        </Banner>
      </div>
    </div>
  );
}
