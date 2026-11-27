import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { LoopArtifact, LoopCard, LoopCardPreview, LoopDocument, LoopToday } from '../loopTypes';
import '../loop.css';

type View = 'today' | 'review' | 'library';

const KIND_LABEL: Record<LoopCard['kind'], string> = {
  error: '错因',
  sentence: '句子',
  word: '词',
};

const CONTEXT_LABEL: Record<LoopCard['kind'], string> = {
  error: '为什么',
  sentence: '主干',
  word: '例句',
};

const GRADES: Array<{ grade: 0 | 1 | 2 | 3; name: string; key: string }> = [
  { grade: 0, name: '忘记', key: '1' },
  { grade: 1, name: '模糊', key: '2' },
  { grade: 2, name: '记得', key: '3' },
  { grade: 3, name: '熟练', key: '4' },
];

const DOC_KIND_LABEL: Record<string, string> = {
  essay: '作文',
  sentence: '句子',
  note: '笔记',
};

const ARTIFACT_LABEL: Record<string, string> = {
  'annotated-diff': '批注稿',
  'syntax-tree': '句法拆解',
  'card-deck': '词汇卡组',
  'score-report': '评分报告',
  'explain-video': '讲解视频',
  'reading-pack': '精读包',
  'quiz-set': '练习',
  'speaking-report': '口语报告',
  'plan-patch': '计划调整',
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败，请稍后重试';
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lp-mask" onClick={onClose}>
      <div className="lp-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="lp-modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="lp-icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="lp-modal-body">{children}</div>
        {footer ? <footer className="lp-modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export default function Loop() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 工作台首页的「开始复习」直接落到复习态，不用先落到今日再点一次
  const [view, setView] = useState<View>(() => {
    const wanted = searchParams.get('view');
    return wanted === 'review' || wanted === 'library' ? wanted : 'today';
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const openRun = (runId: string) => navigate(`/studio?run=${encodeURIComponent(runId)}`);

  return (
    <div className="lp">
      <header className="lp-page-head">
        <div>
          <p className="lp-kicker">LINGUA LOOP</p>
          <h1>学习闭环</h1>
          <p className="lp-sub">产物被采纳 → 变成卡片 → 到期再考你一次</p>
        </div>
        <nav className="lp-tabs">
          {(
            [
              ['today', '今日'],
              ['review', '复习'],
              ['library', '材料库'],
            ] as Array<[View, string]>
          ).map(([id, label]) => (
            <button key={id} className={view === id ? 'is-on' : ''} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {view === 'today' ? (
        <TodayView tick={tick} refresh={refresh} onReview={() => setView('review')} onOpenRun={openRun} />
      ) : null}
      {view === 'review' ? (
        <ReviewView
          onExit={() => {
            refresh();
            setView('today');
          }}
        />
      ) : null}
      {view === 'library' ? <LibraryView tick={tick} refresh={refresh} onOpenRun={openRun} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 今日
// ---------------------------------------------------------------------------

interface Candidate {
  runId: string;
  artifactId: string;
  title: string;
  preview: LoopCardPreview[];
}

function TodayView({
  tick,
  refresh,
  onReview,
  onOpenRun,
}: {
  tick: number;
  refresh: () => void;
  onReview: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [data, setData] = useState<LoopToday | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .loopToday()
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const analyze = async () => {
    if (!text.trim()) {
      setError('先贴一段文字');
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.agentRunSync({ lang: 'en', mode: 'craft', text: text.trim() });
      if (result.error) throw new Error(result.error);
      if (!result.run) throw new Error('这次没有跑出结果，可能需要补充一点信息');
      const artifact = result.run.artifacts.find((item) =>
        ['annotated-diff', 'syntax-tree', 'card-deck'].includes(item.type),
      );
      if (!artifact) throw new Error('这次没有可做成卡片的产物');
      const preview = await api.agentAdopt({
        runId: result.run.runId,
        artifactId: artifact.artifactId,
        confirm: false,
      });
      setCandidate({
        runId: result.run.runId,
        artifactId: artifact.artifactId,
        title: artifact.title,
        preview: preview.cards?.preview ?? [],
      });
      setText('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmAdopt = async () => {
    if (!candidate) return;
    setAdopting(true);
    try {
      const result = await api.agentAdopt({
        runId: candidate.runId,
        artifactId: candidate.artifactId,
        confirm: true,
      });
      const created = result.cards?.created ?? 0;
      setNote(created > 0 ? `已加入今日 · 生成 ${created} 张卡` : '已加入今日 · 这份产物没有新卡片');
      setCandidate(null);
      refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdopting(false);
    }
  };

  if (!data) {
    return <p className="lp-muted">{error ?? '正在读取今日安排…'}</p>;
  }

  return (
    <div className="lp-stack">
      {note ? <p className="lp-toast is-ok">{note}</p> : null}
      {error ? <p className="lp-toast is-danger">{error}</p> : null}

      {data.due > 0 ? (
        <section className="lp-card">
          <div className="lp-card-row">
            <div>
              <p className="lp-eyebrow">① 复习</p>
              <h2>{data.due} 张到期</h2>
              <p className="lp-muted">
                约 {data.minutes} 分钟 · 今天已复习 {data.reviewedToday} 张
              </p>
            </div>
            <button className="lp-btn is-primary" onClick={onReview}>
              开始复习
            </button>
          </div>
        </section>
      ) : (
        <section className="lp-card">
          <p className="lp-eyebrow">① 复习</p>
          <h2>今天没有到期的卡</h2>
          <p className="lp-muted">积压不清零，也不会催你。</p>
        </section>
      )}

      <section className="lp-card">
        <p className="lp-eyebrow">② 做一次</p>
        <h2>贴一段，让 Lingua 看看</h2>
        <p className="lp-muted">长文走批改，短句走拆解。采纳后才会生成卡片。</p>

        <textarea
          className="lp-input"
          rows={4}
          value={text}
          maxLength={8000}
          placeholder="把作文、段落或一句话贴进来…"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="lp-row lp-between lp-wrap">
          <span className="lp-muted lp-small">{text.length} / 8000</span>
          <button className="lp-btn is-primary" onClick={() => void analyze()} disabled={busy}>
            {busy ? '正在跑…（可能要半分钟）' : '让 Lingua 看看'}
          </button>
        </div>
      </section>

      {data.recent.length > 0 ? (
        <section className="lp-card">
          <p className="lp-eyebrow">③ 看一眼</p>
          <div className="lp-glance">
            {data.recent.map((artifact) => (
              <button key={artifact.id} className="lp-glance-row" onClick={() => onOpenRun(artifact.runId)}>
                <span>{artifact.title}</span>
                <span className="lp-muted lp-small">{artifact.adoptedAt?.slice(0, 10)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <footer className="lp-stats">
        <div>
          <span className="lp-num">{data.stats.closed}</span>
          <span className="lp-muted lp-small">近 7 天闭环</span>
        </div>
        <div>
          <span className="lp-num">{Math.round(data.stats.quality * 100)}%</span>
          <span className="lp-muted lp-small">闭环质量</span>
        </div>
        <div>
          <span className="lp-num">{Math.round(data.stats.retention * 100)}%</span>
          <span className="lp-muted lp-small">保持率</span>
        </div>
        <div>
          <span className="lp-num">{data.stats.streak}</span>
          <span className="lp-muted lp-small">连续天数</span>
        </div>
      </footer>

      {candidate ? (
        <Modal
          title="加入今日"
          subtitle={`${candidate.title} · 会生成 ${candidate.preview.length} 张卡`}
          onClose={() => setCandidate(null)}
          footer={
            <>
              <button className="lp-btn" onClick={() => setCandidate(null)}>
                先不加
              </button>
              <button
                className="lp-btn is-primary"
                onClick={() => void confirmAdopt()}
                disabled={adopting || candidate.preview.length === 0}
              >
                {candidate.preview.length === 0 ? '没有可生成的卡' : `确认加入 · ${candidate.preview.length} 张`}
              </button>
            </>
          }
        >
          {candidate.preview.length === 0 ? (
            <p className="lp-note">
              这份产物没有可成卡的内容（或对应的卡已经存在）。不会给你一个空的「已完成」。
            </p>
          ) : (
            <ul className="lp-preview-list">
              {candidate.preview.map((card, index) => (
                <li key={`${card.kind}-${card.front}-${index}`}>
                  <span className={`lp-badge ${card.kind === 'error' ? 'is-warn' : 'is-accent'}`}>
                    {KIND_LABEL[card.kind]}
                  </span>
                  <div>
                    <div className="lp-preview-front">{card.front}</div>
                    <div className="lp-muted lp-small">{card.back}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="lp-note">错因卡今天到期，词 / 句卡放到明天。预览阶段不写任何数据。</p>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 复习
// ---------------------------------------------------------------------------

function ReviewView({ onExit }: { onExit: () => void }) {
  const [queue, setQueue] = useState<LoopCard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askExit, setAskExit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    let alive = true;
    api
      .loopToday()
      .then((data) => {
        if (!alive) return;
        setQueue(data.cards);
        setTotal(data.due);
        shownAt.current = Date.now();
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const current = queue && index < queue.length ? queue[index] : null;
  const finished = queue !== null && queue.length > 0 && index >= queue.length;

  const gradeCard = async (grade: 0 | 1 | 2 | 3) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      await api.loopGrade({ cardId: current.id, grade, ms: Date.now() - shownAt.current });
      if (grade <= 1 && current.ruleId) {
        setError(`已记录遗忘：${current.ruleId}（下次批改会优先关注）`);
        setTimeout(() => setError(null), 3000);
      }
      setIndex((value) => value + 1);
      setFlipped(false);
      shownAt.current = Date.now();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const requestExit = () => {
    if (index === 0 || finished) onExit();
    else setAskExit(true);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (askExit) return;
      if (event.code === 'Space' && current && !flipped) {
        event.preventDefault();
        setFlipped(true);
        return;
      }
      if (flipped && current && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        void gradeCard((Number(event.key) - 1) as 0 | 1 | 2 | 3);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        requestExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) return <p className="lp-toast is-danger">{error}</p>;
  if (!queue) return <p className="lp-muted">正在取到期卡片…</p>;

  if (queue.length === 0) {
    return (
      <div className="lp-review-empty">
        <h2>今天没有到期的卡</h2>
        <p className="lp-muted">先去做一次批改，或者等明天。</p>
        <button className="lp-btn is-primary" onClick={onExit}>
          回到今日
        </button>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="lp-review-empty">
        <p className="lp-kicker">DONE</p>
        <h2>今天复习了 {index} 张</h2>
        <p className="lp-muted">记得明天再来；积压不会清零，也不会催你。</p>
        <button className="lp-btn is-primary" onClick={onExit}>
          回到今日
        </button>
      </div>
    );
  }

  if (!current) return null;

  return (
    <div className="lp-review">
      <div className="lp-review-bar">
        <button className="lp-icon-btn" onClick={requestExit} aria-label="退出复习">
          ←
        </button>
        <div className="lp-progress">
          <span className="lp-muted lp-small">
            {index + 1} / {queue.length}
            {total > queue.length ? ` · 今天先做 ${queue.length} 张` : ''}
          </span>
          <div className="lp-bar">
            <span style={{ width: `${Math.round((index / queue.length) * 100)}%` }} />
          </div>
        </div>
        <button className="lp-icon-btn" onClick={requestExit} aria-label="关闭">
          ✕
        </button>
      </div>

      <div className="lp-review-stage">
        <div className="lp-review-meta">
          <span className={`lp-badge ${current.kind === 'error' ? 'is-warn' : 'is-accent'}`}>
            {KIND_LABEL[current.kind]}
          </span>
          <span className="lp-muted lp-small">
            第 {current.reps + 1} 次 · 上次间隔 {current.intervalDays} 天
          </span>
        </div>

        <button className="lp-flip" onClick={() => setFlipped(true)}>
          <p className="lp-flip-text">{current.front}</p>
          {flipped ? (
            <div className="lp-flip-back">
              <p className="lp-flip-text is-accent">{current.back}</p>
              {current.context ? (
                <div className="lp-flip-context">
                  <span className="lp-tag">{CONTEXT_LABEL[current.kind]}</span>
                  <span className="lp-muted">{current.context}</span>
                </div>
              ) : null}
              {current.ruleId ? <span className="lp-rule">{current.ruleId}</span> : null}
            </div>
          ) : (
            <span className="lp-flip-hint">空格翻面</span>
          )}
        </button>

        {flipped ? (
          <div className="lp-grade-grid">
            {GRADES.map((item) => (
              <button
                key={item.grade}
                className={`lp-grade lp-grade-${item.grade}`}
                disabled={busy}
                onClick={() => void gradeCard(item.grade)}
              >
                <span className="lp-grade-name">{item.name}</span>
                <span className="lp-muted lp-small">按键 {item.key}</span>
              </button>
            ))}
          </div>
        ) : (
          <button className="lp-btn is-primary lp-wide" onClick={() => setFlipped(true)}>
            翻面
          </button>
        )}
      </div>

      {askExit ? (
        <Modal
          title="还剩一些没做完"
          subtitle="退出不会判失败，已评分的卡已经记下了。"
          onClose={() => setAskExit(false)}
          footer={
            <>
              <button className="lp-btn" onClick={() => setAskExit(false)}>
                继续复习
              </button>
              <button className="lp-btn" onClick={onExit}>
                明天再来
              </button>
            </>
          }
        >
          <p className="lp-muted">还剩 {queue.length - index} 张。明天做也一样。</p>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 材料库
// ---------------------------------------------------------------------------

function LibraryView({
  tick,
  refresh,
  onOpenRun,
}: {
  tick: number;
  refresh: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [tab, setTab] = useState<'docs' | 'artifacts'>('docs');
  const [documents, setDocuments] = useState<LoopDocument[]>([]);
  const [artifacts, setArtifacts] = useState<LoopArtifact[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.loopDocuments(), api.loopArtifacts()])
      .then(([docs, arts]) => {
        if (!alive) return;
        setDocuments(docs.documents);
        setArtifacts(arts.artifacts);
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const exportAll = async () => {
    try {
      const data = await api.loopExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `lingua-loop-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNote('已导出 JSON（材料 / 卡片 / 评分事件 / 产物）');
    } catch (err) {
      setError(errorText(err));
    }
  };

  const suspend = async (documentId: string) => {
    if (!window.confirm('暂停这篇材料派生出的所有卡片？暂停后不再到期。')) return;
    try {
      const result = await api.loopSuspendDocument(documentId);
      setNote(`已暂停 ${result.changed} 张卡`);
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="lp-stack">
      {note ? <p className="lp-toast is-ok">{note}</p> : null}
      {error ? <p className="lp-toast is-danger">{error}</p> : null}

      <div className="lp-row lp-between">
        <div className="lp-tabs is-sub">
          <button className={tab === 'docs' ? 'is-on' : ''} onClick={() => setTab('docs')}>
            材料 {documents.length}
          </button>
          <button className={tab === 'artifacts' ? 'is-on' : ''} onClick={() => setTab('artifacts')}>
            产物 {artifacts.length}
          </button>
        </div>
        <button className="lp-btn lp-small" onClick={() => void exportAll()}>
          导出全部
        </button>
      </div>

      {tab === 'docs' ? (
        documents.length === 0 ? (
          <p className="lp-empty">还没有材料。去「今日」贴一段，跑一次批改。</p>
        ) : (
          <div className="lp-list">
            {documents.map((doc) => (
              <article key={doc.id} className="lp-list-item">
                <div className="lp-list-row">
                  <div>
                    <div className="lp-list-title">{doc.title}</div>
                    <div className="lp-muted lp-small">
                      {DOC_KIND_LABEL[doc.kind] ?? doc.kind} · {doc.createdAt.slice(0, 10)} ·{' '}
                      {doc.activeCount} 张待复习
                      {doc.cardCount > doc.activeCount ? ` · 共 ${doc.cardCount} 张` : ''}
                    </div>
                  </div>
                  <div className="lp-row lp-gap">
                    <button
                      className="lp-btn lp-small"
                      onClick={() => setExpanded(expanded === doc.id ? null : doc.id)}
                    >
                      {expanded === doc.id ? '收起' : '原文'}
                    </button>
                    {doc.activeCount > 0 ? (
                      <button className="lp-btn lp-small" onClick={() => void suspend(doc.id)}>
                        暂停卡片
                      </button>
                    ) : null}
                  </div>
                </div>
                {expanded === doc.id ? <pre className="lp-doc-body">{doc.content}</pre> : null}
              </article>
            ))}
          </div>
        )
      ) : artifacts.length === 0 ? (
        <p className="lp-empty">还没有产物。采纳一次批改后，这里会留下可回看的记录。</p>
      ) : (
        <div className="lp-list">
          {artifacts.map((artifact) => (
            <article key={artifact.id} className="lp-list-item">
              <div className="lp-list-row">
                <div>
                  <div className="lp-list-title">
                    {artifact.title}
                    <span className={`lp-badge ${artifact.state === 'adopted' ? 'is-ok' : 'is-neutral'}`}>
                      {artifact.state === 'adopted' ? '已采纳' : artifact.state === 'draft' ? '草稿' : '已忽略'}
                    </span>
                  </div>
                  <div className="lp-muted lp-small">
                    {ARTIFACT_LABEL[artifact.type] ?? artifact.type} · {artifact.createdAt.slice(0, 10)} ·{' '}
                    {artifact.cardCount} 张卡
                  </div>
                </div>
                <div className="lp-row lp-gap">
                  <button className="lp-btn lp-small" onClick={() => onOpenRun(artifact.runId)}>
                    在 AI 学习台查看
                  </button>
                  {artifact.state === 'draft' ? (
                    <button
                      className="lp-btn lp-small"
                      onClick={async () => {
                        try {
                          await api.loopDismissArtifact(artifact.id);
                          setNote('已忽略这份产物');
                          refresh();
                        } catch (err) {
                          setError(errorText(err));
                        }
                      }}
                    >
                      忽略
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
