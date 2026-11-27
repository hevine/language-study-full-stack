import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Banner, CheckMark, Ring, SectionCard } from '../components/ui';
import type { ExamResultResponse } from '../types';

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

function fmtSpent(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m} 分 ${`${s}`.padStart(2, '0')} 秒`;
}

/** 按正确率给一句「水位」判断，比冷冰冰的分数更有指向 */
function verdict(percent: number, levelLabel: string): { title: string; note: string } {
  if (percent >= 85)
    return { title: '状态很稳', note: `这份卷子的难度与 ${levelLabel} 相当，按现在的水平可以直接往上冲一档。` };
  if (percent >= 70)
    return { title: '基本达标', note: `过线问题不大，把错题的考点补上，余量会更舒服。` };
  if (percent >= 50)
    return { title: '差一口气', note: `题型熟悉度够了，但细节还在漏分，重点看下面错题的解析。` };
  return { title: '还需要再打基础', note: `先别急着刷题量，把错题对应的语法与词汇补一轮，再来测一次。` };
}

export default function ExamResult() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as { fresh?: boolean; auto?: boolean };

  const [data, setData] = useState<ExamResultResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let alive = true;
    api
      .examAttempt(attemptId)
      .then((res) => {
        if (alive) setData(res);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [attemptId]);

  /**
   * 分部分得分：按「大题」切，而不是按题型合并。
   * N3 卷子里 問題1 会出现三次（文字・語彙 / 文法 / 聴解），按题型合并会把
   * 三块揉成一根柱子，看不出到底是哪一块在漏分。
   */
  const sections = useMemo(() => {
    if (!data) return [];
    const rows: Array<{ key: string; name: string; total: number; correct: number; writing: number }> = [];
    for (const item of data.details) {
      const last = rows[rows.length - 1];
      const row =
        last && last.name === item.section
          ? last
          : (() => {
              const fresh = { key: `${item.section}-${rows.length}`, name: item.section, total: 0, correct: 0, writing: 0 };
              rows.push(fresh);
              return fresh;
            })();
      if (item.kind === 'writing') row.writing += 1;
      else row.total += 1;
      if (item.correct) row.correct += 1;
    }
    return rows;
  }, [data]);

  if (error) {
    return (
      <div className="stack">
        <Banner tone="danger">{error}</Banner>
        <Link className="btn btn-sm" to="/exams">
          返回升测列表
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card card-pad" style={{ marginTop: 24 }}>
        <div className="center">
          <div className="prepare-title">正在判分…</div>
        </div>
      </div>
    );
  }

  const { paper, details, score, attempt } = data;
  const judge = verdict(score.percent, paper.levelLabel);
  const wrong = details.filter((item) => item.kind === 'choice' && !item.correct);
  const writingCount = details.filter((item) => item.kind === 'writing').length;
  /** 原卷没有明确答案、靠解析或模型作答定下来的题：必须让用户知道，别把推定当标准答案 */
  const derivedCount = details.filter(
    (item) => item.kind === 'choice' && (item.answerSource === 'explain' || item.answerSource === 'solve'),
  ).length;
  const sourceText: Record<string, string> = {
    key: '原卷答案',
    explain: '据解析推导',
    solve: '按题面作答',
    none: '无答案',
  };

  return (
    <div className="stack exam-result">
      <section className="result-hero">
        <div className="result-score">
          <Ring value={score.percent / 100} size={104} stroke={8} label={`${score.percent}%`} />
          <div className="result-score-text">
            <span className="exam-kicker">{paper.year} 年 · {paper.title}</span>
            <h1>{judge.title}</h1>
            <p className="small muted">{judge.note}</p>
          </div>
        </div>
        <div className="result-stats">
          <div className="result-stat">
            <span className="result-stat-label">答对</span>
            <span className="result-stat-value">
              {score.correct}<small>/{score.total}</small>
            </span>
          </div>
          <div className="result-stat">
            <span className="result-stat-label">用时</span>
            <span className="result-stat-value small-value">{fmtSpent(attempt.seconds)}</span>
          </div>
          <div className="result-stat">
            <span className="result-stat-label">错题</span>
            <span className="result-stat-value">
              {wrong.length}<small> 题</small>
            </span>
          </div>
          {writingCount > 0 ? (
            <div className="result-stat">
              <span className="result-stat-label">写作</span>
              <span className="result-stat-value">
                {writingCount}<small> 题</small>
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {state.auto ? <Banner>时间到，已自动交卷。下面是被自动提交时的作答结果。</Banner> : null}
      {derivedCount > 0 ? (
        <Banner>
          这份卷子的 {derivedCount} 道题在原卷里没有印出明确答案，正确答案由解析推导或按题面判定，
          逐题标注了「答案来源」。分数可用来看水位，具体某题若与原卷答案不符，以原卷为准。
        </Banner>
      ) : null}

      <SectionCard title="分部分得分">
        <div className="result-sections">
          {sections.map((row) => {
            const pct = row.total > 0 ? Math.round((row.correct / row.total) * 100) : 0;
            return (
              <div key={row.key} className="result-section-row">
                <span className="result-section-name">{row.name}</span>
                <span className="result-section-bar">
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="result-section-value">
                  {row.total > 0 ? `${row.correct}/${row.total}` : '写作'}
                  {row.writing > 0 && row.total > 0 ? <em className="result-writing-dot">+写</em> : null}
                </span>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="逐题解析"
        extra={<span className="hint">点题号展开或收起；正确选项已标注</span>}
      >
        <ul className="review-list">
          {details.map((item, i) => {
            const isWriting = item.kind === 'writing';
            const expanded = open[i] ?? (isWriting ? true : !item.correct);
            return (
              <li
                key={item.idx}
                className={`review-item${isWriting ? ' writing' : item.correct ? ' ok' : ' bad'}`}
              >
                <button className="review-head" onClick={() => setOpen((prev) => ({ ...prev, [i]: !expanded }))}>
                  <span className={`review-idx${isWriting ? ' writing' : item.correct ? ' ok' : ' bad'}`}>
                    {isWriting ? (
                      <span className="review-pen-mark" aria-hidden />
                    ) : item.correct ? (
                      <CheckMark size={12} />
                    ) : (
                      <span className="review-wrong-mark" />
                    )}
                    {i + 1}
                  </span>
                  <span className="review-section">{item.section}</span>
                  <span className="review-stem-preview">{item.stem.split('\n')[0]}</span>
                  <span className="review-toggle">{expanded ? '收起' : '展开'}</span>
                </button>
                {expanded ? (
                  <div className="review-body">
                    {item.passage ? <p className="review-passage">{item.passage}</p> : null}
                    {item.audioText ? (
                      <div className="review-script">
                        <span className="review-explain-tag">听力原文</span>
                        <p>{item.audioText}</p>
                      </div>
                    ) : null}
                    <p className="review-stem">{item.stem}</p>

                    {isWriting ? (
                      <div className="review-writing">
                        <div className="review-writing-block">
                          <span className="review-explain-tag">你的作答</span>
                          {item.text.trim() ? (
                            <p className="review-writing-text">{item.text}</p>
                          ) : (
                            <p className="review-empty">这题没有作答。</p>
                          )}
                          <span className="review-writing-count">
                            {item.text.trim().length} 字
                            {item.minWords > 0 ? ` / 建议 ${item.minWords} 字以上` : ''}
                          </span>
                        </div>
                        {item.sampleAnswer ? (
                          <div className="review-writing-block sample">
                            <span className="review-explain-tag">参考范文</span>
                            <p className="review-writing-text">{item.sampleAnswer}</p>
                          </div>
                        ) : null}
                        <div className="review-explain">
                          <span className="review-explain-tag">评分要点</span>
                          <p>{item.explanation}</p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="review-options">
                          {item.options.map((option, oi) => {
                            const isAnswer = oi === item.answer;
                            const isChosen = oi === item.chosen;
                            const cls = isAnswer ? ' answer' : isChosen ? ' chosen wrong' : '';
                            return (
                              <div key={oi} className={`review-option${cls}`}>
                                <span className="review-option-key">{KEYS[oi] ?? oi + 1}</span>
                                <span>{option}</span>
                                {isAnswer ? <span className="review-tag ok">正确答案</span> : null}
                                {isChosen && !isAnswer ? <span className="review-tag bad">你的选择</span> : null}
                              </div>
                            );
                          })}
                        </div>
                        {item.chosen === null ? <p className="review-empty">这题没有作答。</p> : null}
                        <div className="review-explain">
                          <span className="review-explain-tag">解析</span>
                          <p>{item.explanation}</p>
                          <span className={`review-source-tag ${item.answerSource}`}>
                            答案来源：{sourceText[item.answerSource] ?? '原卷答案'}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <div className="result-actions">
        <button className="btn" onClick={() => navigate(`/exams/${paper.id}/take`, { replace: true })}>
          再测一次这份卷
        </button>
        <Link className="btn" to="/exams">
          换一份年份
        </Link>
        <Link className="btn btn-primary" to="/dashboard">
          回到今日概览
        </Link>
      </div>
    </div>
  );
}
