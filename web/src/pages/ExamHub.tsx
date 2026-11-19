import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Banner, CheckMark, Ring, SectionCard } from '../components/ui';
import { useApp } from '../store';
import type { ExamAttemptSummary, ExamPaperSummary } from '../types';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}`;
}

const TYPE_LABEL: Record<string, string> = {
  real: '真卷',
  mock: '仿真卷',
  ai: '模型生成',
};

function fmtSpent(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} 分 ${`${s}`.padStart(2, '0')} 秒` : `${s} 秒`;
}

/** 手绘秒表：卷面 + 环形计时，用于首屏说明「全程计时」 */
function StopwatchArt() {
  return (
    <svg viewBox="0 0 96 96" className="exam-art-svg" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 26c7-5 17-7 25-7s18 2 25 7v34c0 6-4 10-9 12-5 2-11 3-16 3s-11-1-16-3c-5-2-9-6-9-12z" className="ea-sheet" />
      <path d="M32 32h32M32 41h24M32 50h18" className="ea-line" />
      <circle cx="66" cy="66" r="16" className="ea-ring" />
      <path d="M66 58v8l6 3.4" className="ea-hand" />
      <path d="M66 47v3M85 66h-3M66 85v-3M47 66h3" className="ea-tick" />
    </svg>
  );
}

export default function ExamHub() {
  const { language, plan } = useApp();
  const navigate = useNavigate();
  const [papers, setPapers] = useState<ExamPaperSummary[] | null>(null);
  const [history, setHistory] = useState<ExamAttemptSummary[]>([]);
  const [year, setYear] = useState<number | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  // 删除导入卷：记下正在删的那份，按钮就地转成「删除中…」
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [paperRes, historyRes] = await Promise.all([
      api.examPapers(language),
      api.examHistory(language),
    ]);
    setPapers(paperRes.papers);
    setHistory(historyRes.attempts);
  }, [language]);

  useEffect(() => {
    let alive = true;
    setPapers(null);
    setError(null);
    load().catch((err: Error) => {
      if (alive) setError(err.message);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  const removePaper = async (paper: ExamPaperSummary) => {
    const extra = paper.attemptCount > 0 ? `，连同 ${paper.attemptCount} 次作答记录` : '';
    const ok = window.confirm(
      `删除「${paper.title}」？题目${extra}会一起清掉，删除后无法恢复。`,
    );
    if (!ok) return;
    setDeletingId(paper.id);
    setNotice(null);
    try {
      await api.examDelete(paper.id);
      setPapers((prev) => (prev ?? []).filter((row) => row.id !== paper.id));
      // 作答记录里也可能有这份卷子的，一起重新取
      await load();
      setNotice(`已删除「${paper.title}」。`);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const years = useMemo(() => {
    const set = Array.from(new Set((papers ?? []).map((paper) => paper.year)));
    return set.sort((a, b) => b - a);
  }, [papers]);

  const visible = useMemo(
    () => (papers ?? []).filter((paper) => year === 'all' || paper.year === year),
    [papers, year],
  );

  const latest = history[0] ?? null;
  const bestPercent = history.reduce((best, item) => {
    const pct = item.total > 0 ? Math.round((item.correct / item.total) * 100) : 0;
    return Math.max(best, pct);
  }, 0);

  if (error) {
    return (
      <div className="stack">
        <Banner tone="danger">{error}</Banner>
        <button className="btn" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="stack exam-hub">
      <section className="exam-hero">
        <div className="exam-hero-text">
          <span className="exam-kicker">升级自测</span>
          <h1>按年份取卷，掐着表量一遍水位</h1>
          <p className="exam-hero-desc">
            {plan ? `${plan.examName} · ${plan.targetLabel}` : '按当前语种'}　
            导入的原卷会按它自己的大题（問題1 文字・語彙 → 文法 → 読解 → 聴解）拆开，
            笔试与听力分开计时、交卷后不能回退 —— 与真实考场的顺序一致。交卷即判分，客观题逐题解析。
          </p>
          <div className="exam-hero-facts">
            <span className="exam-fact">
              <CheckMark size={12} /> 2000–{new Date().getFullYear()} 每年可选
            </span>
            <span className="exam-fact">
              <CheckMark size={12} /> 按大题顺序作答，科目间不可回退
            </span>
            <span className="exam-fact">
              <CheckMark size={12} /> 本地判分，不消耗 token
            </span>
          </div>
        </div>
        <div className="exam-hero-side">
          <div className="exam-art">
            <StopwatchArt />
          </div>
          {latest ? (
            <div className="exam-hero-last">
              <Ring
                value={(latest.correct / Math.max(1, latest.total))}
                size={58}
                stroke={5}
                label={`${Math.round((latest.correct / Math.max(1, latest.total)) * 100)}%`}
              />
              <div className="exam-hero-last-text">
                <div className="small muted">最近一次 · {fmtDate(latest.submittedAt)}</div>
                <div className="exam-hero-last-score">
                  {latest.correct}/{latest.total} 正确
                </div>
                <Link className="exam-mini-link" to={`/exams/attempts/${latest.id}`}>
                  看解析
                </Link>
              </div>
            </div>
          ) : (
            <div className="exam-hero-last empty">
              <div className="small muted">还没有测过</div>
              <div className="exam-hero-last-score">先挑一份卷子试试</div>
            </div>
          )}
        </div>
      </section>

      {bestPercent > 0 ? (
        <div className="exam-best">
          历史最好成绩 <strong>{bestPercent}%</strong>　共测过 {history.length} 次
        </div>
      ) : null}

      <div className="exam-legend">
        <span className="exam-legend-item">
          <span className="exam-type-badge real">真卷</span>你导入的原卷，年份与场次与原件一致
        </span>
        <span className="exam-legend-item">
          <span className="exam-type-badge mock">仿真卷</span>按该年份题型与考纲编写，非原卷影印
        </span>
        <span className="exam-legend-hint">
          真卷导入：<code>npm run import:exam -- --file 你的卷子.json</code>
        </span>
      </div>

      <SectionCard title="选一份真题">
        {notice ? (
          <div className="paper-notice" role="status">
            <span>{notice}</span>
            <button className="paper-notice-close" onClick={() => setNotice(null)} aria-label="关闭提示">
              ×
            </button>
          </div>
        ) : null}
        {papers === null ? (
          <div className="hint">正在取卷…</div>
        ) : visible.length === 0 ? (
          <div className="hint">这个语种暂时还没有题库，稍后再来看看。</div>
        ) : (
          <>
            {years.length > 1 ? (
              <div className="exam-years-wrap">
                <div className="exam-years" role="tablist" aria-label="按年份筛选">
                  <button
                    role="tab"
                    aria-selected={year === 'all'}
                    className={`exam-year${year === 'all' ? ' active' : ''}`}
                    onClick={() => setYear('all')}
                  >
                    全部
                  </button>
                  {years.map((item) => (
                    <button
                      key={item}
                      role="tab"
                      aria-selected={year === item}
                      className={`exam-year${year === item ? ' active' : ''}`}
                      onClick={() => setYear(item)}
                    >
                      {item} 年
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="paper-grid">
              {visible.map((paper) => (
              <article key={paper.id} className="paper-card">
                <div className="paper-card-top">
                  <span className="paper-year">{paper.year}</span>
                  <span className={`exam-type-badge ${paper.paperType}`}>
                    {TYPE_LABEL[paper.paperType] ?? '仿真卷'}
                  </span>
                  <span className="paper-level">{paper.levelLabel}</span>
                </div>
                <h3 className="paper-title">{paper.title}</h3>
                <div className="paper-meta">
                  {paper.examName} · {paper.itemCount} 题 · {paper.durationMin} 分钟
                  {paper.sections.length > 1 ? ` · ${paper.sections.length} 个大题` : ''}
                </div>
                <div className="paper-sections">
                  {paper.sections.slice(0, 5).map((section) => (
                    <span key={section} className="chip paper-chip">
                      {section}
                    </span>
                  ))}
                  {paper.sections.length > 5 ? (
                    <span className="chip paper-chip ghost">+{paper.sections.length - 5} 个大题</span>
                  ) : null}
                </div>
                {paper.importMeta?.answerStats && paper.importMeta.answerStats.fromSolve > 0 ? (
                  <div className="paper-answer-note">
                    {paper.importMeta.answerStats.fromSolve} 题答案由模型按题面作答，结果页逐题标注
                  </div>
                ) : null}
                <div className="paper-foot">
                  {paper.bestPercent === null ? (
                    <span className="paper-best empty">未测</span>
                  ) : (
                    <span className="paper-best">
                      最好 {paper.bestCorrect}/{paper.itemCount} · {paper.bestPercent}%
                    </span>
                  )}
                  <span className="paper-foot-actions">
                    {/* 只有自己导入的卷子能删：内置题库删了也会被重新播种 */}
                    {paper.importFile ? (
                      <button
                        className="btn btn-sm btn-danger-ghost paper-del"
                        onClick={() => removePaper(paper)}
                        disabled={deletingId === paper.id}
                        title="删除这份导入的卷子（含作答记录）"
                      >
                        {deletingId === paper.id ? '删除中…' : '删除'}
                      </button>
                    ) : null}
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => navigate(`/exams/${paper.id}/take`)}
                    >
                      {paper.attemptCount > 0 ? '再测一次' : '开始自测'}
                    </button>
                  </span>
                </div>
              </article>
              ))}
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard title="自测记录" extra={<span className="hint">保留逐题解析，可随时回看</span>}>
        {history.length === 0 ? (
          <div className="hint">还没有记录。测完一份就会出现在这里。</div>
        ) : (
          <ul className="exam-history">
            {history.map((item) => {
              const pct = item.total > 0 ? Math.round((item.correct / item.total) * 100) : 0;
              return (
                <li key={item.id} className="exam-history-row">
                  <div className="exam-history-main">
                    <div className="exam-history-title">
                      {item.paperYear} 年 · {item.paperTitle}
                    </div>
                    <div className="small muted">
                      {fmtDate(item.submittedAt)} · 用时 {fmtSpent(item.seconds)}
                    </div>
                  </div>
                  <div className={`exam-history-score${pct >= 80 ? ' good' : pct >= 60 ? ' mid' : ' low'}`}>
                    {item.correct}/{item.total}
                    <span>{pct}%</span>
                  </div>
                  <Link className="btn btn-sm" to={`/exams/attempts/${item.id}`}>
                    看解析
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
