import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import AiEnrichPanel from '../components/AiEnrichPanel';
import ExplainVideoPanel from '../components/ExplainVideoPanel';
import ArticleView from '../components/ArticleView';
import Quiz from '../components/Quiz';
import ReadingPlayer from '../components/ReadingPlayer';
import WordDeck from '../components/WordDeck';
import ExamCalendarCard from '../components/ExamCalendar';
import PrepareArt from '../components/PrepareArt';
import { Banner, kindLabel, SectionCard, StatusChip, CheckMark, TokenIcon } from '../components/ui';
import { claimMediaPlayback } from '@waiyubaodian/ui-kit';
import { formatCn, todayISO } from '../store';
import type { DayResponse, TaskDetailResponse, TaskKind } from '../types';

const ACTION_LABEL: Record<TaskKind, string> = {
  vocab: '背词',
  read: '精读',
  listen: '精听',
  speak: '跟读',
  grammar: '拆句',
  write: '写作',
  mock: '模考',
  review: '复盘',
  admin: '报考事务',
};

const MODE_HINT: Record<'read' | 'listen' | 'speak', string> = {
  read: '先通读一遍不查词，再逐段精读；生词点开即看释义。',
  listen: '先只听不看原文，听完一遍再看对照稿，最后跟读。',
  speak: '逐句跟读 3 遍，注意停顿与重音，先求准再求快。',
};

/** 各任务类型的材料准备预估耗时（秒）：缓存命中时远低于此值 */
const PREPARE_ESTIMATE: Record<TaskKind, number> = {
  vocab: 5,
  read: 18,
  listen: 18,
  speak: 12,
  grammar: 14,
  write: 12,
  mock: 18,
  review: 6,
  admin: 2,
};

/** 准备阶段的来源说明：让用户知道材料从哪儿来 */
const SOURCE_HINT: Record<TaskKind, string> = {
  vocab: '正在从本地词库与教材章节里，按今天的主题和水平挑词',
  read: '正在从教材章节或内置精读库取材；配置大模型时会按今日考纲实时生成',
  listen: '正在准备精听材料：先取正文，再配上朗读稿',
  speak: '正在从今日材料里挑出适合跟读的段落',
  grammar: '正在从今日材料里挑选长难句，并配语法提示',
  write: '正在整理写作题目与范文骨架',
  mock: '正在组装模考题组',
  review: '正在汇总今天的学习清单',
  admin: '正在调取报考事项与考试日历',
};

/** 该类型的首次准备是否可能调用大模型（消耗少量 token） */
const NEEDS_LLM: Record<TaskKind, boolean> = {
  vocab: false,
  read: true,
  listen: true,
  speak: true,
  grammar: true,
  write: true,
  mock: true,
  review: false,
  admin: false,
};

/** 首次生成的大致 token 量级（写出量级而非精确值，避免误导） */
const TOKEN_ESTIMATE: Partial<Record<TaskKind, string>> = {
  read: '约 1.5k',
  listen: '约 1.8k',
  speak: '约 1.1k',
  grammar: '约 0.9k',
  write: '约 1.2k',
  mock: '约 2.2k',
};

export default function TaskPage() {
  const { date = todayISO(), taskId = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<TaskDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showText, setShowText] = useState(false);
  const [regen, setRegen] = useState<'idle' | 'busy'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [brief, setBrief] = useState<DayResponse | null>(null);
  /** 精读页签：material=材料与题目，explain=解题答疑视频（全宽独立页签） */
  const [readingTab, setReadingTab] = useState<'material' | 'explain'>('material');

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setReadingTab('material');
    api
      .taskDetail(date, taskId)
      .then((response) => {
        if (alive) setData(response);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [date, taskId]);

  /** 换一篇：清掉当日缓存材料，让大模型按当日考纲重新生成，再刷新详情 */
  /** 材料准备期间：本地拉一份当日概要（只用于知道这项任务是什么类型，秒回不耗 token），并按半秒计一次已等待时长 */
  useEffect(() => {
    if (data) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 500);
    api.dayBrief(date).then(setBrief).catch(() => undefined);
    return () => clearInterval(timer);
  }, [data, date, taskId]);

  const regenerate = async () => {
    if (regen === 'busy') return;
    setRegen('busy');
    setError(null);
    try {
      await api.regenerateDay(date);
      const response = await api.taskDetail(date, taskId);
      setData(response);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegen('idle');
    }
  };

  const complete = async () => {
    if (!data) return;
    setSaving(true);
    try {
      await api.toggleTask(data.date, data.task.id, true, data.task.minutes);
      navigate('/', { state: { justDone: data.task.title } });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="stack">
        <Banner tone="danger">{error}</Banner>
        <div className="row">
          <Link className="btn btn-sm" to="/today">
            返回今日任务
          </Link>
          <button className="btn btn-sm" onClick={() => window.location.reload()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    const briefTask = brief?.day.tasks.find((item) => item.id === taskId);
    const kind = briefTask?.kind;
    const estimate = kind ? PREPARE_ESTIMATE[kind] : 10;
    const pct = Math.min(92, Math.round((elapsed / estimate) * 88) + 4);
    const overtime = elapsed > estimate;
    const seconds = Math.floor(elapsed);
    return (
      <div className="card card-pad" style={{ marginTop: 30 }}>
        <div className="prepare-panel">
          <div className="prepare-top">
            <PrepareArt kind={kind} />
            <div className="prepare-head">
              <div className="prepare-title-row">
                <strong className="prepare-title">
                  {kind ? `正在准备${ACTION_LABEL[kind]}材料` : '正在准备材料'}
                </strong>
                <span className="prepare-timer">已等 {seconds} 秒</span>
              </div>
              <p className="prepare-sub">
                {briefTask?.title ?? '正在确认这一项要准备什么'}
              </p>
            </div>
          </div>
          <div className="prepare-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <ul className="prepare-steps">
            <li className="done">
              <span className="step-dot done"><CheckMark size={11} /></span>
              读取今日计划（本地完成，不消耗 token）
            </li>
            <li className={elapsed >= 1 ? 'done' : 'active'}>
              <span className={`step-dot ${elapsed >= 1 ? 'done' : 'active'}`}>
                {elapsed >= 1 ? <CheckMark size={11} /> : null}
              </span>
              检查当日材料缓存：命中则直接秒开
            </li>
            <li className={elapsed >= 1 ? 'active' : 'pending'}>
              <span className={`step-dot ${elapsed >= 1 ? 'active' : 'pending'}`} />
              {kind ? SOURCE_HINT[kind] : '正在确认这一项的材料来源'}
            </li>
          </ul>
          <div className="prepare-meta">
            <span className="hint">
              {overtime ? '预计还需不到半分钟' : `预计还需约 ${Math.max(1, estimate - seconds)} 秒`}
            </span>
            {kind && NEEDS_LLM[kind] ? (
              <span className="chip chip-gold prepare-token">
                <TokenIcon size={13} />
                首次生成 {TOKEN_ESTIMATE[kind] ?? '约 1k'} token · 当日仅一次
              </span>
            ) : kind ? (
              <span className="chip chip-ok prepare-token">
                <CheckMark size={12} />
                本地准备 · 不消耗 token
              </span>
            ) : null}
          </div>
          {kind ? (
            <p className="prepare-note">
              {NEEDS_LLM[kind]
                ? '生成的内容会写入本地题库：今天再打开这一项直接读缓存，不会重复消耗 token。'
                : '取材自本地词库与教材章节，不联网、不消耗 token。'}
            </p>
          ) : null}
          {overtime ? (
            <div className="hint prepare-reassure">
              大模型写一整篇材料最长可能要半分钟，正在生成中，请稍候——写完会立即显示，不会重复消耗 token。
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (data.detail.kind === 'practice') {
    const kind = data.day.tasks.find((item) => item.id === taskId)?.kind;
    return <Navigate to={data.detail.payload.path} state={{ kind }} replace />;
  }

  const { task, day, plan, detail } = data;
  const index = day.tasks.findIndex((item) => item.id === task.id);
  const doneCount = day.tasks.filter((item) => item.done).length;

  return (
    <div className="task-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            <Link to="/today" className="crumb">
              ← 今日任务
            </Link>
            <span style={{ margin: '0 8px', opacity: 0.4 }}>/</span>
            {formatCn(day.date)} · 第 {index + 1} 项 / 共 {day.tasks.length} 项
          </div>
          <h1>{task.title}</h1>
          <div className="page-sub">
            {plan.examName} · {plan.targetLabel} · 建议 {task.minutes} 分钟 · 今日已完成 {doneCount}/
            {day.tasks.length}
          </div>
        </div>
        <div className="row">
          <span className="chip chip-accent">{kindLabel(task.kind)}</span>
          <StatusChip status={task.done ? 'done' : day.status} />
          <Link className="btn btn-sm" to="/today">
            任务清单
          </Link>
        </div>
      </div>

      <AiEnrichPanel date={day.date} taskId={task.id} kind={task.kind} />

      {detail.kind === 'vocab' ? (
        <div className="stack">
          <SectionCard
            title={`今天这批词 · ${detail.payload.words.length} 个`}
            extra={<span className="hint">按当前水平与目标分挑选</span>}
          >
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="chip">{detail.payload.levelName}</span>
              <span className="chip chip-teal">目标 {detail.payload.targetLabel}</span>
            </div>
            <div className="small" style={{ color: 'var(--ink-soft)' }}>
              {detail.payload.tierNote}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {detail.payload.source}
            </div>
          </SectionCard>

          <WordDeck words={detail.payload.words} onFinish={complete} />
        </div>
      ) : null}

      {detail.kind === 'reading' ? (
        <div className="reading-tabs-layout">
          <div className="reading-tabs" role="tablist" aria-label="精读页签">
            <button
              type="button"
              role="tab"
              aria-selected={readingTab === 'material'}
              className={readingTab === 'material' ? 'active' : ''}
              onClick={() => {
                setReadingTab('material');
                if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                  window.speechSynthesis.cancel();
                }
              }}
            >
              精读材料 · 题目
            </button>
            {detail.payload.article.questions.length > 0 ? (
              <button
                type="button"
                role="tab"
                aria-selected={readingTab === 'explain'}
                className={readingTab === 'explain' ? 'active' : ''}
                onClick={() => {
                  setReadingTab('explain');
                  // 切到讲解页签：让朗读/其他媒体停声，避免和讲解音频串台
                  claimMediaPlayback('explain');
                  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                    window.speechSynthesis.cancel();
                  }
                }}
              >
                解题答疑视频 <span className="ev-tab-badge">AI</span>
              </button>
            ) : null}
          </div>

          <div className={`reading-tab-panel${readingTab === 'material' ? '' : ' hidden'}`}>
          <div className="stack">
          <SectionCard
            title={detail.payload.mode === 'listen' ? '精听材料' : '精读材料'}
            extra={
              <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="hint">{MODE_HINT[detail.payload.mode]}</span>
                <button
                  className="btn btn-sm"
                  onClick={regenerate}
                  disabled={regen === 'busy'}
                  title="用大模型按今日考纲重新生成材料"
                >
                  {regen === 'busy' ? '生成中…' : '换一篇'}
                </button>
              </span>
            }
          >
            {detail.payload.notice ? (
              <div style={{ marginBottom: 12 }}>
                <Banner tone="gold">{detail.payload.notice}</Banner>
              </div>
            ) : null}

            {detail.payload.mode === 'listen' && !showText ? (
              <div className="listen-cover">
                <div className="listen-glyph">◍</div>
                <div className="small" style={{ marginBottom: 4 }}>
                  先不看原文，听两遍，判断主旨与态度
                </div>
                <div className="hint" style={{ marginBottom: 12 }}>
                  这套材料约 {detail.payload.article.estMinutes} 分钟
                </div>
                <button className="btn btn-primary" onClick={() => setShowText(true)}>
                  看原文对照
                </button>
              </div>
            ) : null}

            {detail.payload.mode !== 'listen' || showText ? (
              <ArticleView article={detail.payload.article} language={plan.language} />
            ) : null}

            {detail.payload.article.readingScript.segments.length > 0 ? (
              <>
                <hr className="divider" />
                <ReadingPlayer
                  segments={detail.payload.article.readingScript.segments}
                  language={plan.language}
                  scene={detail.payload.mode === 'listen' ? 'listening' : 'article'}
                />
              </>
            ) : null}
          </SectionCard>

          {detail.payload.article.questions.length > 0 ? (
            <SectionCard title="理解检测" extra={<span className="hint">先做题，再看解析</span>}>
              <Quiz questions={detail.payload.article.questions} />
            </SectionCard>
          ) : null}

          {detail.payload.secondary ? (
            <SectionCard
              title="泛读对照"
              extra={<span className="hint">同一主题的补充材料，用来做快速阅读</span>}
            >
              <ArticleView article={detail.payload.secondary} language={plan.language} compact />
            </SectionCard>
          ) : null}
          </div>

          </div>

          <div className={`reading-tab-panel${readingTab === 'explain' ? '' : ' hidden'}`}>
            {detail.payload.article.questions.length > 0 ? (
              <div className="ev-tab-stage">
                <ExplainVideoPanel
                  articleId={detail.payload.article.id}
                  article={detail.payload.article}
                  language={plan.language}
                  wide
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {detail.kind === 'admin' ? (
        <div className="stack">
          <SectionCard
            title={`今天要办：${detail.payload.event.title}`}
            extra={<span className="hint">距离考试 {detail.payload.event.offsetDays === 0 ? '就是今天' : `${-detail.payload.event.offsetDays} 天`}</span>}
          >
            <div className="small" style={{ lineHeight: 1.8 }}>{detail.payload.event.what}</div>
            <ul className="tight-list" style={{ marginTop: 8, marginBottom: 0 }}>
              {detail.payload.event.tips.map((tip) => (
                <li key={tip} style={{ marginBottom: 5, fontSize: 13, color: 'var(--ink-soft)' }}>
                  {tip}
                </li>
              ))}
            </ul>
            {detail.payload.event.url ? (
              <div style={{ marginTop: 10 }}>
                <a className="cal-link" href={detail.payload.event.url} target="_blank" rel="noreferrer">
                  前往报名/查询入口：{detail.payload.event.url.replace('https://', '')} ↗
                </a>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            title={`${detail.payload.calendar.examName} 报考日历`}
            extra={<span className="hint">考试日期 {detail.payload.planExamDate}</span>}
          >
            <ExamCalendarCard calendar={detail.payload.calendar} highlightEventId={detail.payload.event.id} />
          </SectionCard>
        </div>
      ) : null}

      {detail.kind === 'grammar' ? (
        <SectionCard
          title={`长难句拆解 · ${detail.payload.sentences.length} 句 · 可听`}
          extra={<span className="hint">{detail.payload.note}</span>}
        >
          <div className="hint" style={{ marginBottom: 10 }}>
            边听边学：先放整段磨耳朵，再逐句听——听的时候自己先划主干，再看语法提示与译文对照。
          </div>
          <ReadingPlayer segments={detail.payload.sentences} language={plan.language} scene="sentence" />
        </SectionCard>
      ) : null}

      {detail.kind === 'review' ? (
        <div className="stack">
          <SectionCard
            title="今日复盘"
            extra={<span className="hint">先看清单，再回答三个问题</span>}
          >
            <div className="task-list">
              {detail.payload.tasks.map((item) => (
                <div key={item.id} className={`task${item.done ? ' done' : ''}`}>
                  <div className="task-check done" style={{ pointerEvents: 'none' }}>
                    {item.done ? <CheckMark /> : null}
                  </div>
                  <div className="task-body">
                    <div className="task-title">
                      <span className="chip">{kindLabel(item.kind)}</span>
                      {item.title}
                    </div>
                    <div className="task-detail">{item.detail}</div>
                  </div>
                  <div className="task-side">
                    <span className="task-mins">{item.minutes}′</span>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="三个问题，各写一句话">
            <ol className="tight-list">
              {detail.payload.advice.map((item) => (
                <li key={item} style={{ marginBottom: 6 }}>
                  {item}
                </li>
              ))}
            </ol>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="hint">本阶段重点</span>
              {detail.payload.focus.map((item) => (
                <span key={item} className="chip chip-gold">
                  {item}
                </span>
              ))}
            </div>
          </SectionCard>
        </div>
      ) : null}

      <div className="finish-bar">
        <div className="finish-bar-text">
          <strong>做完了？</strong>
          <span className="hint">
            {task.done ? '这一项已标记完成，可以再来一遍。' : '点右侧按钮，任务状态会同步到首页与学习日志。'}
          </span>
        </div>
        <div className="row">
          <Link className="btn btn-sm btn-ghost" to="/today">
            返回清单
          </Link>
          <button className="btn btn-primary" onClick={complete} disabled={saving}>
            {saving ? '同步中…' : task.done ? '返回首页' : '完成并返回首页'}
          </button>
        </div>
      </div>

      <div className="hint" style={{ marginTop: 10, textAlign: 'center' }}>
        {task.kind === 'admin'
          ? '这一项是报考事务，办完记得回来标记完成。'
          : `当前为「${ACTION_LABEL[task.kind]}」环节 · ${day.phaseName}`}
      </div>
    </div>
  );
}
