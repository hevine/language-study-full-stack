import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import ArticleView from '../components/ArticleView';
import Quiz from '../components/Quiz';
import ReadingPlayer from '../components/ReadingPlayer';
import PrepareArt from '../components/PrepareArt';
import { Banner, CheckMark, kindLabel, SectionCard, StatusChip, TokenIcon } from '../components/ui';
import { formatCn, todayISO, useApp } from '../store';
import type { DayResponse } from '../types';

export default function Today() {
  const { plan } = useApp();
  const [data, setData] = useState<DayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 今日任务属于某个计划：切语种后必须重取，否则展示的还是旧语言的任务
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    api
      .day(todayISO())
      .then((response) => alive && setData(response))
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [plan?.id]);

  const toggle = async (taskId: string, done: boolean) => {
    if (!data) return;
    setData({
      ...data,
      day: {
        ...data.day,
        tasks: data.day.tasks.map((task) => (task.id === taskId ? { ...task, done } : task)),
      },
    });
    try {
      const response = await api.toggleTask(data.day.date, taskId, done);
      setData((prev) => (prev ? { ...prev, day: response.day } : prev));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!plan) return null;

  if (loading) {
    return (
      <div className="card card-pad" style={{ marginTop: 40 }}>
        <div className="prepare-panel">
          <div className="prepare-top">
            <PrepareArt />
            <div className="prepare-head">
              <strong className="prepare-title">正在准备今天的材料</strong>
              <p className="prepare-sub">
                系统会按「{plan.examName} · {plan.targetLabel}」的考纲与今日主题生成精读文章、生词表与朗读稿；首次生成可能需要十几秒。
              </p>
            </div>
          </div>
          <div className="prepare-bar indeterminate">
            <span />
          </div>
          <p className="prepare-note">
            生成的内容会存入本地题库：今天再打开各个任务直接读缓存，不会重复消耗 token。
          </p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="stack">
        <Banner tone="danger">{error ?? '今日材料加载失败'}</Banner>
        <button className="btn" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    );
  }

  const { day, articles, notice, source } = data;
  const intensive = articles.find((article) => article.kind === 'intensive') ?? articles[0];
  const extensive = articles.find((article) => article.kind === 'extensive');
  const doneCount = day.tasks.filter((task) => task.done).length;
  const totalMinutes = day.tasks.reduce((sum, task) => sum + task.minutes, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {formatCn(day.date)} · 第 {day.weekIndex + 1} 周 · {day.phaseName}
          </div>
          <h1>今日主题：{day.theme}</h1>
          <div className="page-sub">
            {plan.examName} · {plan.targetLabel} · 今日 {totalMinutes} 分钟 · 已完成 {doneCount}/{day.tasks.length}
          </div>
        </div>
        <div className="row">
          <StatusChip status={day.status} />
          <Link className="btn btn-sm" to="/plan">
            查看整份计划
          </Link>
        </div>
      </div>

      {notice ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone={source === 'llm' ? 'teal' : 'gold'}>{notice}</Banner>
        </div>
      ) : null}

      <div className="stack">
        <SectionCard
          title="今日任务清单"
          extra={<span className="hint">按顺序做，不用跳步</span>}
        >
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
                    {task.kind === 'write' || task.kind === 'speak' ? (
                      <span className="chip chip-accent">
                        <TokenIcon /> 可自动批改
                      </span>
                    ) : null}
                    {typeof task.score === 'number' ? (
                      <span className="chip chip-ok">{Math.round(task.score)} 分</span>
                    ) : null}
                  </div>
                  <div className="task-detail">{task.detail}</div>
                </div>
                <div className="task-side">
                  <span className="task-mins">{task.minutes}′</span>
                  <Link
                    className={`btn btn-sm${task.done ? '' : ' btn-primary'}`}
                    to={`/task/${day.date}/${task.id}`}
                  >
                    {task.done ? '再做一遍' : '去完成 →'}
                  </Link>
                </div>
              </div>
            ))}
          </div>
          <hr className="divider" />
          <div className="row">
            <span className="hint">本阶段重点：</span>
            {day.focus.map((item) => (
              <span key={item} className="chip chip-gold">
                {item}
              </span>
            ))}
          </div>
        </SectionCard>

        {intensive ? (
          <SectionCard
            title="① 精读与背诵"
            extra={
              <span className="hint">
                {intensive.source === 'llm' ? '按当日考纲实时生成' : '来自内置考纲题库'}
              </span>
            }
          >
            <ArticleView article={intensive} language={plan.language} />
          </SectionCard>
        ) : null}

        {intensive && intensive.readingScript.segments.length > 0 ? (
          <SectionCard
            title="② 朗读跟读（Shadowing）"
            extra={<span className="hint">每句跟读 3 遍，先求准再求快</span>}
          >
            <ReadingPlayer segments={intensive.readingScript.segments} language={plan.language} />
          </SectionCard>
        ) : null}

        {intensive && intensive.questions.length > 0 ? (
          <SectionCard title="③ 理解检测" extra={<span className="hint">先做题，再看解析</span>}>
            <Quiz questions={intensive.questions} />
          </SectionCard>
        ) : null}

        {extensive ? (
          <SectionCard
            title="④ 泛读 / 听力材料"
            extra={<span className="hint">不查词通读一遍，再用它做精听</span>}
          >
            <ArticleView article={extensive} language={plan.language} compact />
            {extensive.readingScript.segments.length > 0 ? (
              <>
                <hr className="divider" />
                <ReadingPlayer segments={extensive.readingScript.segments} language={plan.language} />
              </>
            ) : null}
          </SectionCard>
        ) : null}

        <SectionCard>
          <div className="row">
            <span className="hint">
              今天没做完也别慌：明天打开会自动带上「到期复习」，错过的内容会以复习的形式回到你面前。
            </span>
            <span className="spacer" />
            <Link to="/vocab" className="btn btn-sm">
              去复习词汇
            </Link>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
