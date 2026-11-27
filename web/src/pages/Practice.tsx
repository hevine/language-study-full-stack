import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api';
import CreativeLoading from '../components/CreativeLoading';
import { Area, AudioPlayer } from '@waiyubaodian/ui-kit';
import { Banner, Ring, SectionCard, TokenIcon } from '../components/ui';
import { useSpeaking } from '../hooks/useSpeaking';
import { formatCn, todayISO, useApp } from '../store';
import type { PracticeAttempt, PracticeBriefResponse } from '../types';

function mmss(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${`${seconds}`.padStart(2, '0')}`;
}

function countUnits(text: string, language: string): number {
  if (language === 'ja') return text.replace(/\s/g, '').length;
  if (language === 'ko') return text.trim().split(/\s+/).filter(Boolean).length; // 韩语按语节
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;
}

export default function Practice() {
  const { date = 'today', taskId = '' } = useParams();
  const location = useLocation();
  const { plan, language } = useApp();

  const [data, setData] = useState<PracticeBriefResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [timing, setTiming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attempts, setAttempts] = useState<PracticeAttempt[]>([]);
  const [viewing, setViewing] = useState<PracticeAttempt | null>(null);
  // 跳转时随路由带上类型，loading 首帧就能挑对手绘场景；直接打开链接时再用当日概要兜底
  const routedKind = (location.state as { kind?: string } | null)?.kind;
  const [kind, setKind] = useState<'speak' | 'write' | null>(
    routedKind === 'speak' || routedKind === 'write' ? routedKind : null,
  );

  const asrAppliedRef = useRef('');
  const resultRef = useRef<HTMLDivElement | null>(null);

  // 回看历史记录时，语言以接口返回的为准（可能来自别的计划）
  const activeLanguage = data?.language ?? plan?.language;
  const speechLang = activeLanguage === 'ja' ? 'ja-JP' : activeLanguage === 'ko' ? 'ko-KR' : 'en-US';
  const speaking = useSpeaking(speechLang);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setViewing(null);
    api
      .practice(date, taskId)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setAttempts(response.attempts);
        setKind(response.prompt.kind);
        // 回看历史记录时直接展开最近一次批改，省掉再点一次
        if (response.historical && response.attempts.length > 0) {
          setViewing(response.attempts[0]);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [date, taskId]);

  useEffect(() => {
    let alive = true;
    api
      .dayBrief(date === 'today' ? todayISO() : date)
      .then((response) => {
        if (!alive) return;
        const found = response.day.tasks.find((item) => item.id === taskId);
        setKind(found?.kind === 'speak' || found?.kind === 'write' ? found.kind : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [date, taskId]);

  // 计时器（写作倒计时/正计时）
  useEffect(() => {
    if (!timing) return;
    const id = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [timing]);

  // 服务端 ASR 转写稿（按目标语言）到达后写进作答框；用 ref 去重，避免重复追加
  useEffect(() => {
    const result = speaking.transcript;
    if (!result || result === asrAppliedRef.current) return;
    asrAppliedRef.current = result;
    setText((prev) => (prev ? `${prev.replace(/\s+$/, '')} ${result}` : result));
  }, [speaking.transcript]);

  const submit = async () => {
    if (!data || submitting) return;
    if (text.trim().length < 20) {
      setError('内容太短了：先写完一段（至少 20 个字符）再提交批改。');
      return;
    }
    setSubmitting(true);
    setError(null);
    setTiming(false);
    speaking.stop();
    try {
      const response = await api.gradePractice(date, taskId, {
        text: text.trim(),
        durationSeconds: data.prompt.kind === 'speak' ? speaking.elapsed || null : seconds || null,
        submissionSource: data.prompt.kind === 'speak' ? 'speech' : 'typed',
        recognitionConfidence: data.prompt.kind === 'speak' ? speaking.confidence : null,
      }, language);
      setViewing(response.attempt);
      setAttempts(response.attempts);
      window.setTimeout(
        () => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        120,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ marginTop: 26 }}>
        <CreativeLoading variant="prompt" kind={kind} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="stack">
        <Banner tone="danger">{error}</Banner>
        <Link className="btn" to="/practice">
          返回批改中心
        </Link>
      </div>
    );
  }

  if (!data) return null;

  const { prompt, task } = data;
  const isSpeak = prompt.kind === 'speak';
  const units = countUnits(text, data.language);
  const target = prompt.wordRange;
  const overTime = isSpeak
    ? prompt.responseSeconds !== undefined && (speaking.elapsed > prompt.responseSeconds)
    : seconds > prompt.minutes * 60;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {formatCn(data.date)} · {prompt.formatLabel} · {prompt.taskType}
          </div>
          <h1>{prompt.title}</h1>
          <div className="page-sub">
            {data.examName} · {data.targetLabel} · {prompt.minutes} 分钟
            {target ? ` · ${target[0]}–${target[1]} ${data.language === 'ja' ? '字' : data.language === 'ko' ? '语节' : '词'}` : ''}
            {isSpeak && prompt.prepSeconds ? ` · 准备 ${prompt.prepSeconds}s / 作答 ${prompt.responseSeconds}s` : ''}
          </div>
        </div>
        <div className="row">
          {data.historical ? <span className="chip chip-gold">历史记录</span> : null}
          <span className={`chip ${prompt.source === 'llm' ? 'chip-teal' : 'chip-gold'}`}>
            {prompt.source === 'llm' ? '按考纲实时命题' : '内置题库'}
          </span>
          <Link className="btn btn-sm" to="/practice">
            批改中心
          </Link>
        </div>
      </div>

      {data.notice ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="gold">{data.notice}</Banner>
        </div>
      ) : null}

      <div className="grid practice-layout">
        <div className="stack">
          <SectionCard title="题目" extra={<span className="hint">{prompt.scale.label}</span>}>
            <div className="prompt-block">
              <p className="prompt-scenario">{prompt.scenario}</p>
              {prompt.stimulus ? (
                <div className="stimulus">
                  <div>
                    <span className="chip chip-teal">观点 A</span>
                    <p>{prompt.stimulus.a}</p>
                  </div>
                  <div>
                    <span className="chip chip-gold">观点 B</span>
                    <p>{prompt.stimulus.b}</p>
                  </div>
                </div>
              ) : null}
              <p className="prompt-question">{prompt.question}</p>
            </div>

            <hr className="divider" />

            <div className="prompt-meta">
              <span className="chip">限时 {prompt.minutes} 分钟</span>
              {target ? <span className="chip">{target[0]}–{target[1]} {data.language === 'ja' ? '字' : data.language === 'ko' ? '语节' : '词'}</span> : null}
              <span className="chip">{prompt.formatLabel}</span>
            </div>

            <div className="hints">
              <div className="hint-title">构思提示</div>
              <ul>
                {prompt.hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </div>

            {prompt.remarks.length > 0 ? (
              <div className="remarks">
                {prompt.remarks.map((remark) => (
                  <span key={remark}>※ {remark}</span>
                ))}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            title={isSpeak ? '录音与转写' : '作答'}
            extra={
              <span className={`chip ${overTime ? 'chip-warn' : ''}`}>
                {isSpeak ? (
                  <>已说 {mmss(speaking.elapsed)}{prompt.responseSeconds ? ` / ${mmss(prompt.responseSeconds)}` : ''}</>
                ) : (
                  <>用时 {mmss(seconds)}</>
                )}
              </span>
            }
          >
            {isSpeak ? (
              <div className="speak-bar">
                <button
                  className={`btn ${speaking.active ? 'btn-primary' : ''}`}
                  onClick={() => (speaking.active ? speaking.stop() : void speaking.start())}
                  disabled={submitting || speaking.transcribing}
                >
                  {speaking.active ? '■ 停止录音' : '● 开始说（自动转写）'}
                </button>
                {speaking.transcribing ? (
                  <span className="hint">正在识别录音…</span>
                ) : !speaking.recorderSupported ? (
                  <span className="hint">当前浏览器不支持录音，请在下方直接输入你说的内容。</span>
                ) : (
                  <span className="hint">需允许麦克风；停止后自动按目标语言转写，转写稿可在下方修改。</span>
                )}
                {speaking.audioUrl ? (
                  <AudioPlayer src={speaking.audioUrl} label="录音回放" />
                ) : null}
                {speaking.error ? <span className="hint" style={{ color: 'var(--danger)' }}>{speaking.error}</span> : null}
              </div>
            ) : (
              <div className="row" style={{ marginBottom: 10 }}>
                <button className="btn btn-sm" onClick={() => setTiming((value) => !value)}>
                  {timing ? '暂停计时' : seconds > 0 ? '继续计时' : '开始计时'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setTiming(false);
                    setSeconds(0);
                  }}
                >
                  归零
                </button>
                <span className="hint">建议按考试时间限时完成，中途不查词。</span>
              </div>
            )}

            <Area
              textareaClassName={`practice-input${data.language === 'ja' ? ' jp' : ''}`}
              value={text}
              onChange={setText}
              placeholder={
                isSpeak
                  ? '点击「开始说」录音，停止后自动按目标语言转写；也可以直接在这里输入。'
                  : data.language === 'ja'
                    ? '在这里写作（日本語）…'
                    : 'Type your response here…'
              }
              rows={isSpeak ? 8 : 14}
              disabled={submitting}
              block
            />

            <div className="row" style={{ marginTop: 10 }}>
              <span className="hint">
                {units} {data.language === 'ja' ? '字' : data.language === 'ko' ? '语节' : '词'}
                {target ? `（目标 ≥ ${target[0]}）` : ''}
                {!isSpeak ? ` · 段落 ${text.split(/\n\s*\n/).filter((item) => item.trim()).length}` : ''}
              </span>
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" onClick={() => { setText(''); asrAppliedRef.current = ''; }} disabled={submitting}>
                清空
              </button>
              <button className="btn btn-primary" onClick={submit} disabled={submitting || text.trim().length < 20}>
                {submitting ? '批改中…' : (
                  <>
                    <TokenIcon size={13} /> 提交批改（消耗 token）
                  </>
                )}
              </button>
            </div>

            {speaking.finalText || speaking.interim ? (
              <div className="interim">
                {speaking.finalText}{speaking.interim ? `…${speaking.interim}` : ''}
                <span className="hint"> · 实时预览，转写稿以录音识别结果为准</span>
              </div>
            ) : null}
            {submitting ? (
              <div style={{ marginTop: 12 }}>
                <CreativeLoading compact variant="grade" kind={prompt.kind} />
              </div>
            ) : null}
          </SectionCard>

          <div ref={resultRef}>
            {viewing ? <ResultPanel attempt={viewing} language={data.language} onRetry={() => {
              setViewing(null);
              setText('');
              asrAppliedRef.current = '';
              setSeconds(0);
              speaking.reset();
            }} /> : null}
          </div>
        </div>

        <div className="stack">
          <SectionCard title="评分标准" extra={<span className="hint">{prompt.scale.label}</span>}>
            <div className="rubric-list">
              {prompt.dimensions.map((dimension) => (
                <div key={dimension.id} className="rubric-item">
                  <div className="rubric-head">
                    <strong>{dimension.name}</strong>
                    <span className="hint">{Math.round(dimension.weight * 100)}%</span>
                  </div>
                  <div className="hint">{dimension.criteria}</div>
                </div>
              ))}
            </div>
            <hr className="divider" />
            <div className="hint">{prompt.scale.note}</div>
            <div className="hint" style={{ marginTop: 8 }}>
              提交前自检：
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {prompt.checklist.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </SectionCard>

          <SectionCard title="本次记录" extra={<span className="hint">同一题目可反复批改</span>}>
            {attempts.length === 0 ? (
              <div className="hint">还没有批改记录。提交后会显示分数与逐条修改建议。</div>
            ) : (
              <div className="history">
                {attempts.map((attempt, index) => (
                  <button
                    key={attempt.id}
                    className={`history-item${viewing?.id === attempt.id ? ' active' : ''}`}
                    onClick={() => setViewing(attempt)}
                  >
                    <span className="history-score">{Math.round(attempt.overall)}</span>
                    <span className="history-body">
                      <span className="history-title">
                        第 {attempts.length - index} 次 · {attempt.band.label}
                      </span>
                      <span className="hint">
                        {attempt.source === 'llm' ? '大模型批改' : '启发式批改'} ·{' '}
                        {new Date(attempt.createdAt).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="任务">
            <div className="small">{task.title}</div>
            <div className="hint" style={{ marginTop: 6 }}>{task.detail}</div>
            <hr className="divider" />
            <div className="row">
              <span className="hint">批改完成后本任务会自动标记为已完成。</span>
              <span className="spacer" />
              <Link className="btn btn-sm" to="/today">
                今日任务
              </Link>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function ResultPanel({
  attempt,
  language,
  onRetry,
}: {
  attempt: PracticeAttempt;
  language: string;
  onRetry: () => void;
}) {
  const { feedback, stats } = attempt;
  const unit = language === 'ja' ? '字' : language === 'ko' ? '语节' : '词';

  return (
    <SectionCard
      title="批改结果"
      extra={
        <span className="row" style={{ gap: 8 }}>
          <span className={`chip ${attempt.source === 'llm' ? 'chip-teal' : 'chip-gold'}`}>
            {attempt.source === 'llm' ? `大模型批改${attempt.model ? ` · ${attempt.model}` : ''}` : '启发式批改'}
          </span>
          <button className="btn btn-sm" onClick={onRetry}>
            再练一次
          </button>
        </span>
      }
    >
      <div className="result-head">
        <Ring value={attempt.overall / 100} size={92} stroke={8} label={`${Math.round(attempt.overall)}`} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="result-band">{attempt.band.label}</span>
            <span className="chip">{attempt.stats.length} {unit}</span>
            {stats.durationSeconds ? <span className="chip">{mmss(stats.durationSeconds)}</span> : null}
            {attempt.kind === 'speak' && stats.wpm ? (
              <span className="chip">
                {stats.wpm} {stats.unit === 'chars' ? '字' : '词'}/分
              </span>
            ) : null}
          </div>
          <p className="result-verdict">{feedback.verdict}</p>
          <div className="hint">{attempt.band.note}</div>
        </div>
      </div>

      {attempt.notice ? (
        <div style={{ marginTop: 14 }}>
          <Banner tone="gold">{attempt.notice}</Banner>
        </div>
      ) : null}

      <div className="dimension-grid">
        {attempt.dimensions.map((dimension) => (
          <div key={dimension.id} className="dimension">
            <div className="rubric-head">
              <strong>{dimension.name}</strong>
              <span className="dimension-score">
                {dimension.score}
                <small> /100 · {Math.round(dimension.weight * 100)}%</small>
              </span>
            </div>
            <div className="bar" style={{ margin: '6px 0 8px' }}>
              <span style={{ width: `${dimension.score}%` }} />
            </div>
            <div className="hint">{dimension.comment}</div>
          </div>
        ))}
      </div>

      <div className="metrics">
        <span>句子 {stats.sentences}</span>
        <span>段落 {stats.paragraphs}</span>
        <span>平均句长 {stats.avgSentence}</span>
        <span>去重比 {stats.uniqueRatio}</span>
        <span>填充词 {stats.fillerCount}</span>
        {stats.targetMin ? <span>目标 ≥ {stats.targetMin} {unit}</span> : null}
      </div>

      {feedback.strengths.length > 0 ? (
        <div className="result-block">
          <div className="hint-title">做对了什么</div>
          <ul className="tight-list">
            {feedback.strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {feedback.issues.length > 0 ? (
        <div className="result-block">
          <div className="hint-title">
            逐条批改 <span className="hint">（{feedback.issues.length} 条，按严重程度排序）</span>
          </div>
          <div className="issue-list">
            {feedback.issues.map((issue, index) => (
              <div key={`${issue.problem}-${index}`} className="issue">
                <div className="issue-head">
                  <span className="chip chip-warn">{issue.kind}</span>
                  <strong>{issue.problem}</strong>
                </div>
                {issue.quote ? <div className="issue-quote">“{issue.quote}”</div> : null}
                {issue.fix ? (
                  <div className="issue-fix">
                    <span className="arrow">→</span>
                    <span>{issue.fix}</span>
                  </div>
                ) : null}
                {issue.reason ? <div className="hint">{issue.reason}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="result-block">
          <div className="hint-title">逐条批改</div>
          <div className="hint">
            这次没有检出可定位的规则类错误（冠词、主谓一致、时态跳跃、标点、重复用词等）。
            {attempt.source === 'heuristic'
              ? '启发式批改只能识别规则类问题，配置大模型后可获得逐句的语义与论证批改。'
              : '润色空间仍在词汇与句式，可参考下方「表达升级」。'}
          </div>
        </div>
      )}

      {feedback.rewrite ? (
        <div className="result-block">
          <div className="hint-title">改错版（只改语言，不动你的论证）</div>
          <pre className="rewrite">{feedback.rewrite.text}</pre>
          <div className="hint">{feedback.rewrite.note}</div>
        </div>
      ) : null}

      {feedback.upgrades.length > 0 ? (
        <div className="result-block">
          <div className="hint-title">表达升级</div>
          <div className="upgrade-list">
            {feedback.upgrades.map((upgrade) => (
              <div key={`${upgrade.from}-${upgrade.to}`} className="upgrade">
                <span className="upgrade-from">{upgrade.from}</span>
                <span className="arrow">→</span>
                <span className="upgrade-to">{upgrade.to}</span>
                <span className="hint">{upgrade.note}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {feedback.drills.length > 0 ? (
        <div className="result-block">
          <div className="hint-title">下一步训练</div>
          <ol className="drill-list">
            {feedback.drills.map((drill) => (
              <li key={drill}>{drill}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </SectionCard>
  );
}
