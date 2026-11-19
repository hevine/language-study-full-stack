import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Banner, CheckMark, PlayIcon, StopIcon } from '../components/ui';
import type { ExamItem, ExamPaper, ExamSectionKey, ExamStage } from '../types';
import { useVoicePlayer } from '../hooks/useVoicePlayer';

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

const SECTION_HINT: Record<ExamSectionKey, string> = {
  listening: '只听不看原文；播放次数有限，先听整体再抓细节。',
  vocab: '按语境判断，不要靠字面拆分硬猜。',
  grammar: '先看接续与固定搭配，再验证句意是否通顺。',
  reading: '先看题干定位，再回原文找依据句。',
  writing: '先列提纲再落笔，留 2 分钟检查语法与字数。',
};

function clock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${`${m}`.padStart(2, '0')}:${`${s}`.padStart(2, '0')}`;
}

/** 一道大题在卷内的位置 */
interface Group {
  label: string;
  key: ExamSectionKey;
  no: number;
  from: number;
  to: number;
  minutes: number;
}

/** 一个科目：真实考试里分开计时、分开收卷，交了就回不去 */
interface StageBlock {
  stage: ExamStage;
  from: number;
  to: number;
  minutes: number;
  groups: Group[];
}

export default function ExamTake() {
  const { paperId = '' } = useParams();
  const navigate = useNavigate();

  const [paper, setPaper] = useState<ExamPaper | null>(null);
  const [items, setItems] = useState<ExamItem[]>([]);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Array<number | null>>([]);
  const [writing, setWriting] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [left, setLeft] = useState(0);
  const [stageIdx, setStageIdx] = useState(0);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [plays, setPlays] = useState<Record<number, number>>({});
  const submitted = useRef(false);
  const startedAt = useRef<number>(0);
  const stageDeadline = useRef<number>(0);
  const initialized = useRef(false);
  const listeningVoice = useVoicePlayer('listening');
  /** 用 ref 拿最新的 stop，避免把取卷 / 交卷回调的依赖搅乱 */
  const stopVoiceRef = useRef<() => void>(() => {});
  stopVoiceRef.current = listeningVoice.stop;

  // 取卷 + 立刻开始计时（服务端同时记下开始时间）
  useEffect(() => {
    let alive = true;
    submitted.current = false;
    initialized.current = false;
    Promise.all([api.examPaper(paperId), api.examStart(paperId)])
      .then(([detail, started]) => {
        if (!alive) return;
        setPaper(detail.paper);
        setItems(detail.items);
        setAnswers(new Array(detail.items.length).fill(null));
        setAttemptId(started.attempt.id);
        startedAt.current = Date.now();
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
      stopVoiceRef.current();
    };
  }, [paperId]);

  /** 大题：按卷内顺序，用题型名切（同一份卷子里「問題1」会出现三次，不能只按 sectionKey 合并） */
  const groups = useMemo<Group[]>(() => {
    const minutesOf = new Map<string, number>();
    for (const step of paper?.sections ?? []) minutesOf.set(step.label, step.minutes);
    const out: Group[] = [];
    items.forEach((item, i) => {
      const last = out[out.length - 1];
      if (last && last.label === item.section) {
        last.to = i;
        return;
      }
      out.push({
        label: item.section,
        key: item.sectionKey,
        no: item.questionNo,
        from: i,
        to: i,
        minutes: minutesOf.get(item.section) ?? 0,
      });
    });
    return out;
  }, [items, paper?.sections]);

  /** 科目：同一科目的连续大题并成一段，段与段之间不可回退 */
  const stages = useMemo<StageBlock[]>(() => {
    const out: StageBlock[] = [];
    for (const group of groups) {
      const stage: ExamStage = group.key === 'listening' ? 'oral' : 'written';
      const last = out[out.length - 1];
      if (last && last.stage === stage) {
        last.to = group.to;
        last.minutes += group.minutes;
        last.groups.push(group);
        continue;
      }
      out.push({ stage, from: group.from, to: group.to, minutes: group.minutes, groups: [group] });
    }
    // 卷子没标每大题时长时，按题量把整卷时长摊到各科目（老的内置卷只有总时长）
    const declared = out.reduce((sum, block) => sum + block.minutes, 0);
    const itemCount = items.length || 1;
    if (out.some((block) => block.minutes <= 0)) {
      const totalMin = paper?.durationMin && paper.durationMin > 0 ? paper.durationMin : itemCount;
      for (const block of out) {
        block.minutes = Math.max(
          3,
          Math.round((totalMin * (block.to - block.from + 1)) / itemCount),
        );
      }
    } else if (declared <= 0) {
      for (const block of out) block.minutes = Math.max(5, block.to - block.from + 1);
    }
    return out;
  }, [groups, items.length, paper]);

  const stageLabel = useCallback(
    (stage: ExamStage): string => {
      const ja = paper?.language === 'ja';
      if (stage === 'oral') return ja ? '聴解' : '听力';
      return ja ? '言語知識・読解' : '笔试';
    },
    [paper?.language],
  );

  const currentStage = stages[stageIdx] ?? null;

  const doSubmit = useCallback(
    async (auto = false) => {
      if (!attemptId || submitted.current) return;
      submitted.current = true;
      setSubmitting(true);
      try {
        stopVoiceRef.current();
        const limit = stages.reduce((sum, block) => sum + block.minutes, 0) * 60;
        const seconds = Math.max(0, Math.round((Date.now() - (startedAt.current || Date.now())) / 1000));
        const result = await api.examSubmit(attemptId, answers, Math.min(seconds, limit || seconds), writing);
        navigate(`/exams/attempts/${result.attempt.id}`, { state: { fresh: true, auto } });
      } catch (err) {
        submitted.current = false;
        setError((err as Error).message);
        setSubmitting(false);
      }
    },
    [answers, attemptId, navigate, stages, writing],
  );

  const enterStage = useCallback(
    (next: number, auto: boolean) => {
      if (next >= stages.length) {
        void doSubmit(auto);
        return;
      }
      const block = stages[next];
      setStageIdx(next);
      setIndex(block.from);
      stageDeadline.current = Date.now() + block.minutes * 60_000;
      setLeft(block.minutes * 60);
      if (auto) setStageNotice(`「${stageLabel(stages[stageIdx]?.stage ?? 'written')}」时间到，已自动进入下一科目。`);
    },
    [doSubmit, stages, stageIdx, stageLabel],
  );

  // 卷子到位后启动第一科目的倒计时
  useEffect(() => {
    if (initialized.current || !attemptId || stages.length === 0) return;
    initialized.current = true;
    const first = stages[0];
    setStageIdx(0);
    setIndex(first.from);
    stageDeadline.current = Date.now() + first.minutes * 60_000;
    setLeft(first.minutes * 60);
  }, [attemptId, stages]);

  // 倒计时：每 250ms 校准一次；科目时间到就进下一科目，最后一科自动交卷
  useEffect(() => {
    if (!attemptId || !initialized.current || stages.length === 0) return;
    const timer = setInterval(() => {
      const rest = Math.max(0, Math.round((stageDeadline.current - Date.now()) / 1000));
      setLeft(rest);
      if (rest <= 0) {
        clearInterval(timer);
        enterStage(stageIdx + 1, true);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [attemptId, stageIdx, stages.length, enterStage]);

  const current = items[index];

  /** 听力：走音色库「听力」场景绑定的音色，最多两遍（贴近真实听解的次数限制） */
  const play = useCallback(
    (item: ExamItem) => {
      if (!paper) return;
      if (!listeningVoice.supported) {
        setError('当前浏览器不支持语音朗读，可在「设置 → 音色库」配置云端 TTS 音色。');
        return;
      }
      if (playing) {
        listeningVoice.stop();
        setPlaying(false);
        return;
      }
      const text = item.audioText;
      if (!text) return;
      setPlaying(true);
      setPlays((prev) => ({ ...prev, [item.idx]: (prev[item.idx] ?? 0) + 1 }));
      listeningVoice.speak(text, 'exam-audio', () => setPlaying(false));
    },
    [paper, playing, listeningVoice],
  );

  // 换题时停掉正在播的语音
  useEffect(() => {
    if (playing) {
      listeningVoice.stop();
      setPlaying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const answered = useMemo(
    () =>
      items.reduce((count, item, i) => {
        if (item.kind === 'writing') return count + ((writing[String(item.idx)] ?? '').trim() ? 1 : 0);
        return count + (answers[i] !== null ? 1 : 0);
      }, 0),
    [answers, items, writing],
  );

  if (error && !paper) {
    return (
      <div className="stack">
        <Banner tone="danger">{error}</Banner>
        <Link className="btn btn-sm" to="/exams">
          返回升测列表
        </Link>
      </div>
    );
  }

  if (!paper || !current) {
    return (
      <div className="card card-pad" style={{ marginTop: 24 }}>
        <div className="center">
          <div className="prepare-title">正在发卷…</div>
          <div className="hint" style={{ marginTop: 6 }}>随即开始计时，请做好准备。</div>
        </div>
      </div>
    );
  }

  const total = items.length;
  const warn = left <= 60;
  const urgent = left <= 20;
  const currentGroup = groups.find((group) => index >= group.from && index <= group.to);
  const isWriting = current.kind === 'writing';
  const text = writing[String(current.idx)] ?? '';
  const usedPlays = plays[current.idx] ?? 0;
  const canPlay = usedPlays < 2;
  const stageFrom = currentStage?.from ?? 0;
  const stageTo = currentStage?.to ?? total - 1;
  const stageItemCount = stageTo - stageFrom + 1;
  const isLastStage = stageIdx >= stages.length - 1;
  const stageAnswered = items.reduce((count, item, i) => {
    if (i < stageFrom || i > stageTo) return count;
    if (item.kind === 'writing') return count + ((writing[String(item.idx)] ?? '').trim() ? 1 : 0);
    return count + (answers[i] !== null ? 1 : 0);
  }, 0);

  const setText = (value: string) =>
    setWriting((prev) => ({ ...prev, [String(current.idx)]: value }));

  return (
    <div className="exam-take">
      <header className="exam-topbar">
        <div className="exam-topbar-left">
          <span className="exam-kicker">升级自测</span>
          <strong className="exam-topbar-title">{paper.title}</strong>
          <span className="small muted">
            {paper.year} 年 · {paper.examName} · {paper.levelLabel}
          </span>
        </div>
        <div className={`exam-clock${urgent ? ' urgent' : warn ? ' warn' : ''}`}>
          <span className="exam-clock-label">本科目剩余</span>
          <span className="exam-clock-time">{clock(left)}</span>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setConfirming(true)} disabled={submitting}>
          交卷
        </button>
      </header>

      {stages.length > 1 ? (
        <nav className="exam-sections" aria-label="科目">
          {stages.map((block, i) => {
            const locked = i > stageIdx;
            const passed = i < stageIdx;
            return (
              <button
                key={`${block.stage}-${block.from}`}
                className={`exam-section-btn${i === stageIdx ? ' active' : ''}${locked ? ' locked' : ''}${
                  passed ? ' passed' : ''
                }`}
                disabled={locked || passed}
                title={locked ? '按考试顺序，前一科目交卷后才能进入' : passed ? '本科目已交卷，不能返回' : ''}
              >
                <span className="exam-section-name">{stageLabel(block.stage)}</span>
                <span className="exam-section-meta">
                  {block.to - block.from + 1} 题 · {block.minutes} 分钟
                  {passed ? ' · 已交' : ''}
                </span>
              </button>
            );
          })}
        </nav>
      ) : null}

      {currentStage && currentStage.groups.length > 1 ? (
        <nav className="exam-sections exam-sections-sub" aria-label="大题">
          {currentStage.groups.map((group) => {
            const active = currentGroup?.from === group.from;
            return (
              <button
                key={`${group.label}-${group.from}`}
                className={`exam-section-btn${active ? ' active' : ''}`}
                onClick={() => setIndex(group.from)}
              >
                <span className="exam-section-name">{group.label}</span>
                <span className="exam-section-meta">
                  {group.to - group.from + 1} 题{group.minutes ? ` · ${group.minutes} 分钟` : ''}
                </span>
              </button>
            );
          })}
        </nav>
      ) : null}

      {stageNotice ? <Banner>{stageNotice}</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div className="exam-body">
        <main className="exam-main">
          <div className="exam-qhead">
            <span className="chip">{current.section}</span>
            <span className="exam-qhead-index">
              第 {index + 1} <span className="muted">/ {total}</span> 题
              {currentGroup ? (
                <span className="muted">
                  {' '}· 本大题 {index - currentGroup.from + 1}/{currentGroup.to - currentGroup.from + 1}
                </span>
              ) : null}
            </span>
          </div>

          {current.passage ? (
            <div className="exam-passage">
              <span className="exam-passage-tag">材料</span>
              <p>{current.passage}</p>
            </div>
          ) : null}

          {current.audioText || current.audioUrl ? (
            <div className={`exam-audio${playing ? ' playing' : ''}`}>
              <div className="exam-audio-head">
                <span className="exam-audio-label">
                  <PlayIcon size={14} />
                  听力材料
                </span>
                <span className="exam-audio-meta">
                  {canPlay ? `还可播放 ${2 - usedPlays} 次` : '播放次数已用完'}
                </span>
              </div>
              {current.audioUrl ? (
                <audio controls src={current.audioUrl} className="exam-audio-el" />
              ) : (
                <button
                  className={`btn btn-sm exam-audio-btn${playing ? ' playing' : ''}`}
                  onClick={() => play(current)}
                  disabled={!canPlay && !playing}
                >
                  {playing ? <StopIcon size={14} /> : <PlayIcon size={14} />}
                  {playing ? '停止播放' : usedPlays === 0 ? '播放录音' : '再听一遍'}
                </button>
              )}
              <p className="exam-audio-tip">
                录音只播放、不显示原文；交卷后可在解析里对照听力原文。
                {listeningVoice.currentVoice ? ` · 当前音色「${listeningVoice.currentVoice.name}」` : ''}
              </p>
              {listeningVoice.error ? (
                <div className="banner banner-danger" style={{ marginTop: 8 }}>
                  {listeningVoice.error}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="exam-stem">{current.stem}</div>

          {isWriting ? (
            <div className="exam-writing">
              <textarea
                className="exam-writing-input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={current.minWords > 0 ? `请用目标语言作答，不少于 ${current.minWords} 字/词` : '请在此作答'}
                rows={12}
              />
              <div className="exam-writing-foot">
                <span className="small muted">
                  已写 {text.trim().length} 字
                  {current.minWords > 0 ? ` · 建议不少于 ${current.minWords}` : ''}
                </span>
                <span className="small muted">写作题不参与客观判分，交卷后可对照参考范文</span>
              </div>
            </div>
          ) : (
            <div className="exam-options">
              {current.options.map((option, i) => {
                const selected = answers[index] === i;
                return (
                  <button
                    key={i}
                    className={`exam-option${selected ? ' sel' : ''}`}
                    onClick={() =>
                      setAnswers((prev) => {
                        const next = [...prev];
                        next[index] = selected ? null : i;
                        return next;
                      })
                    }
                  >
                    <span className="exam-option-key">{KEYS[i] ?? i + 1}</span>
                    <span className="exam-option-text">{option}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="exam-actions">
            <button className="btn btn-sm" disabled={index <= stageFrom} onClick={() => setIndex((v) => v - 1)}>
              上一题
            </button>
            {isWriting ? null : (
              <button
                className="btn btn-sm"
                disabled={answers[index] === null}
                onClick={() =>
                  setAnswers((prev) => {
                    const next = [...prev];
                    next[index] = null;
                    return next;
                  })
                }
              >
                清除本题
              </button>
            )}
            <div className="exam-actions-right">
              {index < stageTo ? (
                <button className="btn btn-primary btn-sm" onClick={() => setIndex((v) => v + 1)}>
                  下一题
                </button>
              ) : isLastStage ? (
                <button className="btn btn-primary btn-sm" onClick={() => setConfirming(true)}>
                  交卷并看解析
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setStageNotice(null);
                    enterStage(stageIdx + 1, false);
                  }}
                >
                  交本科目，进入{stageLabel(stages[stageIdx + 1]?.stage ?? 'oral')}
                </button>
              )}
            </div>
          </div>

          <p className="exam-section-hint">{SECTION_HINT[current.sectionKey]}</p>
        </main>

        <aside className="exam-side">
          <div className="exam-side-head">
            <strong>答题卡</strong>
            <span className="small muted">
              本科目 {stageAnswered}/{stageItemCount}
            </span>
          </div>
          <div className="exam-qnav">
            {items.map((item, i) => {
              if (i < stageFrom || i > stageTo) return null;
              const done =
                item.kind === 'writing'
                  ? Boolean((writing[String(item.idx)] ?? '').trim())
                  : answers[i] !== null;
              return (
                <button
                  key={item.id}
                  className={`exam-dot${i === index ? ' cur' : ''}${done ? ' done' : ''}`}
                  onClick={() => setIndex(i)}
                  aria-label={`第 ${i + 1} 题`}
                  title={item.section}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
          <p className="exam-side-note">
            本科目共 {stageItemCount} 题，{currentStage?.minutes ?? 0} 分钟。交卷后不能返回上一科目 —— 与真实考场一致。
          </p>
          <p className="exam-side-note">
            客观题交卷即判分并给出逐题解析；写作题保留原文，交卷后可对照范文与评分要点。
          </p>
          <p className="exam-side-note dim">来源：{paper.sourceNote}</p>
          <p className="exam-side-note dim exam-no-token">
            <CheckMark size={11} /> 全程本地判分，不消耗 token
          </p>
        </aside>
      </div>

      {confirming ? (
        <div className="exam-modal-mask" onClick={() => setConfirming(false)}>
          <div className="exam-modal" onClick={(event) => event.stopPropagation()}>
            <h3>确认交卷？</h3>
            <p className="small muted">
              已答 {answered} 题{answered < total ? `，还有 ${total - answered} 题未作答` : '，全部作答完毕'}。
              交卷后不能修改答案。
              {isLastStage ? '' : ' 现在交卷，后面的科目也不会再作答。'}
            </p>
            <div className="exam-modal-actions">
              <button className="btn btn-sm" onClick={() => setConfirming(false)}>
                继续作答
              </button>
              <button className="btn btn-primary btn-sm" disabled={submitting} onClick={() => void doSubmit(false)}>
                {submitting ? '判分中…' : '确认交卷'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
