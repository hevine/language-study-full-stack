import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Field, Slider } from '@waiyubaodian/ui-kit';
import { Banner } from '../components/ui';
import { Dropdown } from '@waiyubaodian/ui-kit';
import ExamCalendarCard from '../components/ExamCalendar';
import { addDays, diffDays, formatCn, todayISO, useApp } from '../store';
import type { ExamCalendar, ExamLink, ExamSession, Language } from '../types';

export default function Setup() {
  const { catalog, plan, reload } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const preset = (location.state ?? {}) as { language?: Language; levelId?: string };

  // 从「改目标」进来且没有显式指定语种时：直接带上当前计划，
  // 这样用户看到的就是自己正在执行的目标，改完覆盖即可，不用从头选一遍。
  const fromPlan =
    !preset.language && plan
      ? {
          language: plan.language,
          levelId: plan.currentLevelId,
          examId: plan.examId,
          targetScore: plan.targetScore,
          examDate: plan.examDate,
        }
      : null;

  const languages = catalog?.languages ?? [];
  const [language, setLanguage] = useState<Language>(
    preset.language ?? fromPlan?.language ?? 'en',
  );
  const lang = languages.find((item) => item.id === language) ?? languages[0];

  const [levelId, setLevelId] = useState(fromPlan?.levelId ?? preset.levelId ?? '');
  const [examId, setExamId] = useState(fromPlan?.examId ?? '');
  const [targetScore, setTargetScore] = useState<number | null>(fromPlan?.targetScore ?? null);
  const [dailyMinutes, setDailyMinutes] = useState(90);
  const [examDate, setExamDate] = useState(fromPlan?.examDate ?? addDays(todayISO(), 91));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<ExamCalendar | null>(null);
  const [sessions, setSessions] = useState<ExamSession[]>([]);
  const [sessionYear, setSessionYear] = useState<number | null>(null);
  const [links, setLinks] = useState<ExamLink[]>([]);
  const [scheduleNote, setScheduleNote] = useState('');

  const level = lang?.levels.find((item) => item.id === levelId) ?? lang?.levels[2] ?? lang?.levels[0];
  const exam = lang?.exams.find((item) => item.id === examId) ?? lang?.exams[0];
  const target = exam?.targets.find((item) => item.score === targetScore) ?? exam?.targets[0];

  const weeks = Math.max(1, Math.ceil((diffDays(todayISO(), examDate) + 1) / 7));
  // 每周 6 个学习日 + 1 个复盘日（60% 时长），折算成每周小时数
  const hoursPerWeek = useMemo(
    () => Math.round(((dailyMinutes * 6.6) / 60) * 2) / 2,
    [dailyMinutes],
  );

  const sessionYears = useMemo(
    () => Array.from(new Set(sessions.map((item) => item.year))).sort((a, b) => a - b),
    [sessions],
  );
  const yearSessions = sessions.filter((item) => item.year === sessionYear);
  const activeSession = sessions.find((item) => item.date === examDate) ?? null;

  /**
   * 拉取真实考试场次：托福按 NEEA 全年滚动排考的月度场次，
   * JLPT 按官方固定的 7 月/12 月第一个周日，TOPIK 按 4 月/10 月的周日。
   * 默认选中第一个「至少留 6 周」的场次；从「改目标」带着当前考期进来时不覆盖。
   */
  const keepExamDateRef = useRef(Boolean(fromPlan));
  useEffect(() => {
    if (!exam) return;
    let alive = true;
    api
      .examSessions(exam.id)
      .then((data) => {
        if (!alive) return;
        setSessions(data.sessions);
        setLinks(data.links);
        setScheduleNote(data.scheduleNote);
        if (keepExamDateRef.current) return; // 保留当前计划的考试日期
        const pick = data.sessions.find((item) => item.daysAhead >= 42) ?? data.sessions[0];
        if (pick) {
          setExamDate(pick.date);
          setSessionYear(pick.year);
        }
      })
      .catch(() => {
        if (!alive) return;
        setSessions([]);
        setLinks([]);
      });
    return () => {
      alive = false;
    };
  }, [exam?.id]);

  // 按官网发布节奏预估的报考日历：随考试与日期联动刷新
  useEffect(() => {
    if (!exam || !examDate) return;
    let alive = true;
    api
      .examCalendar(exam.id, examDate)
      .then((data) => {
        if (alive) setCalendar(data);
      })
      .catch(() => {
        if (alive) setCalendar(null);
      });
    return () => {
      alive = false;
    };
  }, [exam?.id, examDate]);

  const switchLanguage = (next: Language) => {
    setLanguage(next);
    setLevelId('');
    setExamId('');
    setTargetScore(null);
    keepExamDateRef.current = false; // 主动换考试后恢复「自动挑最近场次」
  };

  const submit = async () => {
    if (!level || !exam || !target) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createPlan({
        language,
        examId: exam.id,
        currentLevelId: level.id,
        targetScore: target.score,
        startDate: todayISO(),
        examDate,
        hoursPerWeek,
        dailyMinutes,
      });
      await reload();
      navigate('/today');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Step 01 · 定目标</div>
          <h1>先把目标定准，计划才有意义</h1>
          <div className="page-sub">
            选择当前水平与目标考试，系统会按官方考纲、词汇量差距和时间预算，倒推出每一天要背什么、读什么。
          </div>
        </div>
        {plan ? (
          <button className="btn btn-sm" onClick={() => navigate('/')}>
            返回当前计划
          </button>
        ) : null}
      </div>

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      <div className="grid split">
        <div className="card card-pad">
          <div className="field">
            <label>要提升的语言</label>
            <div className="row">
              {languages.map((item) => (
                <button
                  key={item.id}
                  className={`btn${language === item.id ? ' btn-selected' : ''}`}
                  onClick={() => switchLanguage(item.id as Language)}
                >
                  {item.name}
                  <span style={{ opacity: 0.7, fontSize: 12 }}>{item.nativeName}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>当前水平（按你已有的证书或自评）</label>
            <Dropdown
              block
              value={level?.id ?? ''}
              options={(lang?.levels ?? []).map((item) => ({
                value: item.id,
                label: `${item.name} · CEFR ${item.cefr} · 约 ${item.vocab} 词`,
              }))}
              onChange={(id) => setLevelId(id)}
            />
            {level?.note ? <div className="hint">{level.note}</div> : null}
          </div>

          <div className="field">
            <label>目标考试</label>
            <Dropdown
              block
              value={exam?.id ?? ''}
              options={(lang?.exams ?? []).map((item) => ({
                value: item.id,
                label: `${item.name}（${item.scaleLabel}）`,
              }))}
              onChange={(id) => {
                setExamId(id);
                keepExamDateRef.current = false;
              }}
            />
            {exam?.scaleNote ? <div className="hint">{exam.scaleNote}</div> : null}
          </div>

          <div className="field">
            <label>目标分数</label>
            <div className="row">
              {(exam?.targets ?? []).map((item) => (
                <button
                  key={item.score}
                  className={`btn btn-sm${target?.score === item.score ? ' btn-selected' : ''}`}
                  onClick={() => setTargetScore(item.score)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {target?.note ? <div className="hint">{target.note}</div> : null}
          </div>

          <hr className="divider" />

          <div className="grid grid-2">
            <div className="field">
              <Slider
                min={30}
                max={240}
                step={15}
                value={dailyMinutes}
                onChange={setDailyMinutes}
                label={`每天能学多久：${dailyMinutes} 分钟`}
                ariaLabel="每天学习分钟数"
              />
              <div className="hint">建议 60–120 分钟；只背单词不朗读，分数涨得慢。</div>
            </div>

            <div className="field">
              <label>每周节奏</label>
              <div className="card" style={{ padding: '10px 14px' }}>
                <div className="small">6 个学习日 + 1 个复盘日</div>
                <div className="hint" style={{ marginTop: 4 }}>
                  复盘日只排 60% 时长，用来整理错题与录音回听。折算 {hoursPerWeek} 小时/周。
                </div>
              </div>
            </div>
          </div>

          <div className="field">
            <label>考试场次 · 直接选哪一年的哪一场</label>
            <div className="hint" style={{ marginBottom: 8 }}>
              {sessions.length > 0 ? scheduleNote : '正在读取官方排考节奏…'}
            </div>

            {sessionYears.length > 0 ? (
              <div className="session-years">
                {sessionYears.map((year) => (
                  <button
                    key={year}
                    className={`session-year${sessionYear === year ? ' is-active' : ''}`}
                    onClick={() => setSessionYear(year)}
                  >
                    {year} 年
                  </button>
                ))}
              </div>
            ) : null}

            <div className="session-grid">
              {yearSessions.map((session) => {
                const active = session.date === examDate;
                return (
                  <button
                    key={session.id}
                    className={`session-card${active ? ' is-active' : ''}`}
                    onClick={() => setExamDate(session.date)}
                  >
                    <span className="session-top">
                      <span className="session-date">{session.dateLabel}</span>
                      {active ? <span className="session-tick">✓</span> : null}
                    </span>
                    <span className="session-meta">
                      {session.weekday} · {session.roundLabel}
                    </span>
                    <span className="session-gap">
                      还有 {session.weeksAhead} 周 · {session.daysAhead} 天
                    </span>
                  </button>
                );
              })}
              {yearSessions.length === 0 ? (
                <div className="hint" style={{ gridColumn: '1 / -1' }}>
                  这一年没有来得及报名的场次，换一年看看。
                </div>
              ) : null}
            </div>

            <div className="hint" style={{ marginTop: 8 }}>
              已选定：<strong style={{ color: 'var(--accent-deep)' }}>{formatCn(examDate)}</strong>
              {activeSession ? ` · ${activeSession.roundLabel}` : ''}
              {activeSession?.estimated
                ? '。该场次的日期按官方排考规律推算，最终以报名网站公告为准。'
                : activeSession
                  ? '。该场次为官方固定考试日期。'
                  : ''}
            </div>

            <details className="session-manual">
              <summary>日期对不上？手动指定考试日</summary>
              <Field
                type="date"
                value={examDate}
                min={addDays(todayISO(), 21)}
                onChange={setExamDate}
                style={{ marginTop: 8 }}
                aria-label="手动指定考试日"
              />
            </details>
          </div>

          <button className="btn btn-primary btn-block" onClick={submit} disabled={submitting}>
            {submitting ? '正在生成计划…' : plan ? '覆盖当前计划并重新生成' : '生成我的备考计划'}
          </button>
          <div className="hint" style={{ marginTop: 10, textAlign: 'center' }}>
            生成后会立刻得到逐日任务表；第一天的精读与朗读材料会自动准备好。
          </div>
        </div>

        <div className="stack">
          {links.length > 0 ? (
            <div className="card card-pad">
              <div className="eyebrow">Official Links</div>
              <h2 style={{ fontSize: 17, marginBottom: 8 }}>报名官网与资讯入口</h2>
              <div className="hint" style={{ marginBottom: 10 }}>
                考位放位、报名截止、费用调整都以官网实时公告为准，随时点开核对，别只信二手信息。
              </div>
              <div className="link-list">
                {links.map((link) => (
                  <a
                    key={link.url}
                    className="link-row"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="link-body">
                      <span className="link-label">{link.label}</span>
                      <span className="link-note">{link.note}</span>
                    </span>
                    <span className="link-go">
                      {link.url.replace(/^https?:\/\//, '')} ↗
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card card-pad">
            <div className="eyebrow">Honest Estimate</div>
            <h2 style={{ fontSize: 17, marginBottom: 12 }}>你的选择意味着什么</h2>
            <div className="row" style={{ justifyContent: 'space-between', padding: '7px 0' }}>
              <span className="small muted">起点 → 目标</span>
              <span className="small">
                {level?.name ?? '—'} → {target?.label ?? '—'}
              </span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', padding: '7px 0' }}>
              <span className="small muted">可用周期</span>
              <span className="small">
                {weeks} 周 · 约 {weeks * hoursPerWeek} 小时
              </span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', padding: '7px 0' }}>
              <span className="small muted">词汇缺口</span>
              <span className="small">
                {Math.max(0, (target?.vocabNeed ?? 0) - (level?.vocab ?? 0))} 词
              </span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', padding: '7px 0' }}>
              <span className="small muted">每日新词</span>
              <span className="small">
                约{' '}
                {Math.min(
                  60,
                  Math.max(
                    8,
                    Math.round(
                      Math.max(0, (target?.vocabNeed ?? 0) - (level?.vocab ?? 0)) / (weeks * 6),
                    ),
                  ),
                )}{' '}
                个
              </span>
            </div>
            <hr className="divider" />
            <div className="hint">
              这是按官方考纲与历年提分数据做的粗算。生成计划后，系统会给出「达标概率」与「建议周期」——如果不达标，它会诚实告诉你，而不是给你一份看起来很努力的计划。
            </div>
          </div>

          {calendar ? (
            <div className="card card-pad">
              <div className="eyebrow">Exam Calendar</div>
              <h2 style={{ fontSize: 17, marginBottom: 10 }}>
                {calendar.examName} 报考日历与费用
              </h2>
              <div className="hint" style={{ marginBottom: 10 }}>
                考试日期 {formatCn(calendar.examDate)}。报名、选考场、打印准考证这些节点会在计划生成后自动排进当日任务。
              </div>
              <ExamCalendarCard calendar={calendar} compact />
            </div>
          ) : null}

          <div className="card card-pad">
            <div className="eyebrow">Syllabus</div>
            <h2 style={{ fontSize: 17, marginBottom: 10 }}>{exam?.name ?? '考纲'} 要点</h2>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.85, color: 'var(--ink-soft)' }}>
              {(exam?.syllabus ?? []).slice(0, 6).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <hr className="divider" />
            <div className="hint">
              考试结构：
              {(exam?.sections ?? []).map((section) => (
                <div key={section.id} style={{ marginTop: 6 }}>
                  <strong style={{ color: 'var(--ink)' }}>{section.name}</strong> · {section.minutes} 分钟 ·{' '}
                  {section.format}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
