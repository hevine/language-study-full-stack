/**
 * 右栏：产物渲染。
 *
 * 按 `artifact.type` 分派 —— 这是 Agent 与界面之间唯一的耦合点，
 * 加一种产物类型只需加一个渲染器，内核与场景包都不用动。
 *
 * 三条约定：
 * 1. 渲染器只读。承诺「可逐条接受」但后端只支持整份采纳的话，就是在骗用户点。
 * 2. 数据缺字段就少显示一块，不抛错。产物是模型参与生成的，不能假设完美。
 * 3. 视频这类异步产物只承诺「进度 + 去哪看」，不假装已经有片子。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { useApp } from '../../store';
import { claimMediaPlayback, stopAllSpeech, AudioPlayer } from '@waiyubaodian/ui-kit';
import { videoThemeFor } from '@waiyubaodian/ui-kit/theme';
import type {
  AnnotatedDiffPayload,
  AgentArtifact,
  ExplainJobState,
  ExplainVideoPayload,
  SpeakingReportPayload,
  SyntaxTreeNodePayload,
  SyntaxTreePayload,
} from '../../agentTypes';
import type { ExplainVideoLike } from '../../types';
import { ROLE_LABEL, SEVERITY_LABEL } from './labels';

const ExplainVideoPlayer = lazy(() =>
  import('@waiyubaodian/explain-video/react').then((m) => ({ default: m.ExplainVideoPlayer })),
);

export default function ArtifactView({ artifact }: { artifact: AgentArtifact }) {
  switch (artifact.type) {
    case 'annotated-diff':
      return <DiffPane data={artifact.data as AnnotatedDiffPayload} />;
    case 'syntax-tree':
      return <SyntaxPane data={artifact.data as SyntaxTreePayload} />;
    case 'explain-video':
      return <VideoPane data={artifact.data as ExplainVideoPayload} />;
    case 'speaking-report':
      return <SpeakingPane data={artifact.data as SpeakingReportPayload} />;
    default:
      return <GenericPane artifact={artifact} />;
  }
}

// ---------------------------------------------------------------------------
// 写作批改
// ---------------------------------------------------------------------------

function DiffPane({ data }: { data: AnnotatedDiffPayload }) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const score = data?.score;
  const [rewriteOpen, setRewriteOpen] = useState(false);

  const rules = score?.ruleOverall;
  const llm = score?.llmOverall;
  const gap = rules !== undefined && llm !== undefined ? Math.abs(rules - llm) : null;

  return (
    <div className="diff-pane">
      {/* 降级必须写在最显眼的位置：把不完整的批改当成完整结论，比不给结果更伤人 */}
      {data?.note ? <div className="banner diff-degraded">{data.note}</div> : null}
      {score ? (
        <div className="diff-score">
          <div className="diff-score-top">
            {score.band ? <span className="chip chip-accent">{score.band}</span> : null}
            <div className="diff-score-nums">
              <div>
                <span className="hint">规则引擎</span>
                <strong>{rules ?? '—'}</strong>
              </div>
              <div>
                <span className="hint">模型</span>
                <strong>{llm ?? '—'}</strong>
              </div>
            </div>
          </div>
          {score.dimensions.length > 0 ? (
            <div className="diff-dims">
              {score.dimensions.map((dim) => {
                const max = Math.max(...score.dimensions.map((item) => item.score), 1);
                return (
                  <div key={dim.id} className="diff-dim">
                    <span className="diff-dim-name">{dim.name}</span>
                    <span className="diff-dim-bar">
                      <span style={{ width: `${Math.round((dim.score / max) * 100)}%` }} />
                    </span>
                    <span className="diff-dim-score">{dim.score}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {gap !== null ? (
            <p className={`diff-gap${gap >= 10 ? ' is-wide' : ''}`}>
              双通道分差 {gap.toFixed(0)} 分{gap >= 10 ? ' —— 两个引擎判断不一致，这份结论需要你复核' : '，两条通道判断一致'}
            </p>
          ) : null}
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="hint">
          {data?.note
            ? '这次没有可展示的批改条目 —— 原因见上方提示，别当成「作文没问题」。'
            : '这次没有命中明确的问题。没有错不等于写得好，可以让它按更高标准再看一遍。'}
        </p>
      ) : (
        <ul className="diff-items">
          {items.map((item, index) => (
            <li key={`${item.ruleId}-${index}`} className={`diff-item is-${item.severity}`}>
              <div className="diff-item-head">
                <span className={`diff-sev is-${item.severity}`}>{SEVERITY_LABEL[item.severity] ?? item.severity}</span>
                {item.ruleId ? <span className="chip">{item.ruleId}</span> : null}
              </div>
              <div className="diff-lines">
                <div className="diff-line is-before">
                  <span className="diff-tag">改前</span>
                  <span>{item.before || '（空）'}</span>
                </div>
                <div className="diff-line is-after">
                  <span className="diff-tag">改后</span>
                  <span>{item.after || '（删去）'}</span>
                </div>
              </div>
              {item.reason ? <p className="diff-reason">{item.reason}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {data?.rewrite ? (
        <div className="diff-rewrite">
          <button className="btn btn-sm" onClick={() => setRewriteOpen((open) => !open)}>
            {rewriteOpen ? '收起示范版本' : '看一版示范改写'}
          </button>
          {rewriteOpen ? <div className="diff-rewrite-body">{data.rewrite}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 句法拆解
// ---------------------------------------------------------------------------

function SyntaxNodeRow({ node, depth }: { node: SyntaxTreeNodePayload; depth: number }) {
  const children = Array.isArray(node.children) ? node.children : [];
  return (
    <li className="syn-node">
      <div className={`syn-line${depth === 0 ? ' is-root' : ''}`}>
        <span className={`syn-role is-${node.role}`}>{ROLE_LABEL[node.role] ?? node.role}</span>
        <span className="syn-text">{node.text}</span>
        {node.surface ? <span className="syn-surface">{node.surface}</span> : null}
      </div>
      {node.note ? <p className="syn-note">{node.note}</p> : null}
      {children.length > 0 ? (
        <ul className="syn-children">
          {children.map((child, index) => (
            <SyntaxNodeRow key={child.id ?? `${child.role}-${index}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SyntaxPane({ data }: { data: SyntaxTreePayload }) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const difficulty = typeof data?.difficulty === 'number' ? data.difficulty : 0;

  return (
    <div className="syntax-pane">
      <div className="syn-difficulty">
        <span className="hint">难度</span>
        <span className="syn-difficulty-bar">
          <span style={{ width: `${Math.min(100, Math.max(0, difficulty * 10))}%` }} />
        </span>
        <span className="syn-difficulty-num">{difficulty.toFixed(1)} / 10</span>
      </div>
      {data?.summary ? <p className="syn-summary">{data.summary}</p> : null}
      {nodes.length === 0 ? (
        <p className="hint">没有解析出结构，可能是句子太短或者模型这次没给对格式。</p>
      ) : (
        <ul className="syn-tree">
          {nodes.map((node, index) => (
            <SyntaxNodeRow key={node.id ?? index} node={node} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 口语评估
//
// 口语报告最容易出的问题不是「分不准」，而是「说不清评的是什么」：
// 一段手打稿拿到 7 分，被当成口语实测，后面所有练习强度都会按错的标准排。
// 所以依据（录音 / 改过的稿 / 手打）必须和分数长在一起，音频能当场回听。
// ---------------------------------------------------------------------------

const SPEAK_DIM_LABEL: Record<string, string> = {
  fluency: '流利度',
  grammar: '语法',
  coherence: '连贯性',
  lexical: '词汇',
};

/** 节奏实测的分项：这三个是量出来的，不是模型判断的，所以单独一组 */
const RHYTHM_LABEL: Record<string, string> = {
  pace: '语速',
  pausing: '停顿',
  continuity: '连贯',
  // 日语专有：整段音高跨度，不指向具体词
  pronunciation: '发音·抑扬',
};

function formatSpeakDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  return total >= 60 ? `${Math.floor(total / 60)} 分 ${total % 60} 秒` : `${total} 秒`;
}

/** 停顿用一位小数：1.4 秒和 1 秒在听感上是两回事，四舍五入会把差别抹掉 */
function prosodyPause(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms >= 10_000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

function SpeakingPane({ data }: { data: SpeakingReportPayload }) {
  const dims = Array.isArray(data?.dimensions) ? data.dimensions : [];
  const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
  const basis = data?.basis;
  const prosody = data?.prosody;
  const rhythmDims = Array.isArray(prosody?.dimensions) ? prosody!.dimensions : [];
  const [notesOpen, setNotesOpen] = useState(false);

  // 主维度与节奏分项共用一次「展开点评」，两个按钮会让人以为各有各的折叠
  const hasLongNote =
    dims.some((dim) => (dim.note?.length ?? 0) > 60) || rhythmDims.some((dim) => (dim.note?.length ?? 0) > 60);

  return (
    <div className="speak-pane">
      <div className="speak-head">
        <div className="speak-score">
          <strong>{Number.isFinite(data?.overall) ? Math.round(data.overall) : '—'}</strong>
          <span className="hint">/ 100</span>
          {data?.band ? <span className="chip chip-accent">{data.band}</span> : null}
        </div>
        <div className="speak-basis">
          <span className="hint">评估依据</span>
          <span className="chip">{basis?.sourceLabel ?? '未知来源'}</span>
          {basis?.durationMs ? <span className="hint">录音 {formatSpeakDuration(basis.durationMs)}</span> : null}
          {basis?.phonology ? <span className="chip">含节奏实测</span> : null}
        </div>
      </div>

      {data?.summary ? <p className="speak-summary">{data.summary}</p> : null}

      {/* 手打稿与录音实测的可信度不同，必须在分数旁边说清，别藏在文末 */}
      {basis && basis.source !== 'asr' ? (
        <p className="speak-caveat">
          {basis.source === 'asr-edited'
            ? '这份报告按你改过的转写稿评：语法、用词、连贯可靠，流利度只能按文本特征推测，不代表真实口播。'
            : '这份报告按文本评：没有录音，流利度与发音只能推测。想测真实口语，录一段再评一次。'}
        </p>
      ) : null}

      {/* 有录音却没测出节奏：太短、太吵或解码失败。不说清楚，用户会以为这一栏只是没做 */}
      {basis?.audioRef && !prosody ? (
        <p className="speak-caveat">
          这段录音没测出节奏（太短、环境太吵，或格式解不开），流利度只能按文本推测。换个安静地方重录一次就能测。
        </p>
      ) : null}

      {dims.length === 0 ? (
        <p className="hint">没有解析出评分维度，这次报告可能不完整 —— 重跑一次通常就好。</p>
      ) : (
        <div className="speak-dims">
          {dims.map((dim) => (
            <div key={dim.id} className="speak-dim">
              <span className="speak-dim-name">{SPEAK_DIM_LABEL[dim.id] ?? dim.id}</span>
              <span className="speak-dim-bar">
                <span style={{ width: `${Math.min(100, Math.max(0, dim.score))}%` }} />
              </span>
              <span className="speak-dim-score">{Math.round(dim.score)}</span>
              {dim.note ? (
                <p className="speak-dim-note">{notesOpen ? dim.note : dim.note.slice(0, 60) + (dim.note.length > 60 ? '…' : '')}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* 实测区：与上面四个维度分开 —— 这些数字是量出来的，模型评的是文本 */}
      {prosody ? (
        <div className="speak-prosody">
          <div className="speak-prosody-head">
            <span className="speak-prosody-title">节奏实测</span>
            <span className="chip">{prosody.sourceLabel}</span>
          </div>

          <div className="speak-stats">
            <div className="speak-stat">
              <strong>{Math.round(prosody.wpm)}</strong>
              <span>{prosody.paceLabel ?? '词/分钟'}</span>
            </div>
            <div className="speak-stat">
              <strong>{prosody.pauseCount}</strong>
              <span>停顿次数</span>
            </div>
            <div className="speak-stat">
              <strong>{prosodyPause(prosody.longestPauseMs)}</strong>
              <span>最长停顿</span>
            </div>
            <div className="speak-stat">
              <strong>{Math.round(prosody.speechRatio * 100)}%</strong>
              <span>发声占比</span>
            </div>
            {prosody.pitch ? (
              <div className="speak-stat">
                <strong>{prosody.pitch.rangeSemitones}</strong>
                <span>半音跨度</span>
              </div>
            ) : null}
            {prosody.closures && prosody.closures.length > 0 ? (
              <div className="speak-stat">
                <strong>{prosody.closures.length}</strong>
                <span>短闭塞</span>
              </div>
            ) : null}
          </div>

          {rhythmDims.length > 0 ? (
            <div className="speak-rhythm-dims">
              {rhythmDims.map((dim) => (
                <div key={dim.id} className="speak-rhythm-dim">
                  <span className="speak-rhythm-name">{RHYTHM_LABEL[dim.id] ?? dim.id}</span>
                  <span className="speak-rhythm-bar">
                    <span style={{ width: `${Math.min(100, Math.max(0, dim.score))}%` }} />
                  </span>
                  <span className="speak-rhythm-score">{Math.round(dim.score)}</span>
                  {dim.note ? (
                    <p className="speak-rhythm-note">
                      {notesOpen ? dim.note : dim.note.slice(0, 60) + (dim.note.length > 60 ? '…' : '')}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {prosody.wordLevel.length > 0 ? (
            <div className="speak-flags">
              <span className="hint">念得明显偏慢的词</span>
              <div className="speak-flag-list">
                {prosody.wordLevel.map((item, index) => (
                  <span key={`${item.word}-${index}`} className="speak-flag" title={item.hint}>
                    {item.word}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <p className="speak-prosody-note">{prosody.note}</p>
          <p className="speak-prosody-limit">
            {prosody.pitch
              ? '节奏与抑扬都是从波形实测的，但不指向具体词：长音、促音、アクセント 的位置对不对，需要强制对齐才判得了，这一版不评 —— 别把它当发音总分看。'
              : '只评节奏。音素读得准不准（θ 读成 s、重音放错）需要音素级对齐，这一版不评 —— 别把它当发音总分看。'}
          </p>
        </div>
      ) : null}

      {hasLongNote ? (
        <button className="btn btn-sm speak-notes-toggle" onClick={() => setNotesOpen((open) => !open)}>
          {notesOpen ? '收起详细点评' : '展开详细点评'}
        </button>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="speak-advice">
          <span className="speak-advice-title">下一次先改这三处</span>
          <ul>
            {suggestions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {basis?.transcript ? (
        <div className="speak-transcript">
          <div className="speak-transcript-head">
            <span className="hint">这次评的原文</span>
            <span className="hint">{basis.transcript.length} 字</span>
          </div>
          <p>{basis.transcript}</p>
          {basis.audioRef ? (
            <AudioPlayer src={`/api/agent/audio/${basis.audioRef}`} label="原音回放" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 讲解视频（异步作业）
// ---------------------------------------------------------------------------

function VideoPane({ data }: { data: ExplainVideoPayload }) {
  const { theme } = useApp();
  const videoTheme = useRef(videoThemeFor(theme)).current;

  const [job, setJob] = useState<ExplainJobState | null>(() =>
    data?.state === 'done' && data.videoId
      ? { state: 'done', progress: 100, detail: '已生成', videoId: data.videoId }
      : null,
  );
  const [video, setVideo] = useState<ExplainVideoLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [canceled, setCanceled] = useState(false);
  const blobUrls = useRef<Map<string, string>>(new Map());

  // 轮询：用 setTimeout 自排而不是 setInterval —— 网络慢时不会堆积请求
  useEffect(() => {
    const jobId = data?.jobId;
    if (!jobId || canceled) return undefined;

    let alive = true;
    let timer = 0;

    const tick = async () => {
      try {
        const next = await api.agentExplainPoll(jobId);
        if (!alive) return;
        setJob(next);
        if (next.state === 'running') timer = window.setTimeout(tick, 3000);
      } catch (err) {
        if (!alive) return;
        // 回放历史 run 时作业早就没了（进程重启 / 被取消）。这不是故障，
        // 说成「加载失败」只会让人以为系统坏了。
        if (err instanceof ApiError && err.status === 404) {
          setExpired(true);
          return;
        }
        setError((err as Error).message);
      }
    };

    timer = window.setTimeout(tick, 600);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [data?.jobId, canceled]);

  // 作业完成后再取片子本体
  useEffect(() => {
    const videoId = job?.state === 'done' ? job.videoId : undefined;
    if (!videoId || video) return undefined;
    let alive = true;
    api
      .explainGet(videoId)
      .then((res) => {
        if (alive) setVideo(res.video);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [job?.state, job?.videoId, video]);

  useEffect(() => {
    const cache = blobUrls.current;
    return () => {
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);

  const resolveAudio = useCallback(
    async (url: string): Promise<string> => {
      const cached = blobUrls.current.get(url);
      if (cached) return cached;
      const match = url.match(/\/seg\/(\d+)(?:\?track=zh)?$/);
      if (!match || !video) return url;
      const track = url.includes('track=zh') ? 'native' : 'target';
      const blob = await api.explainSegmentBlob(video.id, Number(match[1]), track);
      blobUrls.current.set(url, blob);
      return blob;
    },
    [video],
  );

  const onCancel = async () => {
    if (!data?.jobId) return;
    try {
      await api.agentExplainCancel(data.jobId);
      setCanceled(true);
      setJob((prev) => (prev ? { ...prev, state: 'canceled', detail: '已取消' } : prev));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (video) {
    return (
      <div className="video-pane">
        <div className="liquid-glass-frame">
          <div className="liquid-glass-inner">
            <Suspense fallback={<div className="hint" style={{ padding: 18 }}>播放器加载中…</div>}>
              <ExplainVideoPlayer
                video={video as never}
                editable={false}
                audioUrlResolver={resolveAudio}
                theme={videoTheme}
                onRequestPlay={() => {
                  claimMediaPlayback('explain');
                  stopAllSpeech();
                }}
              />
            </Suspense>
          </div>
        </div>
      </div>
    );
  }

  // 作业失效：历史回放时的常态，不是错误
  if (expired) {
    return (
      <div className="video-pane">
        <div className="video-job">
          <div className="video-job-head">
            <strong>这次讲解作业已经不在了</strong>
          </div>
          <p className="hint">
            讲解作业是进程内任务，不落库 —— 服务重启或你取消之后就没了。
            回今天那篇精读里重新生成一份就行，命中缓存会秒出、不重复花 token。
          </p>
          <a className="btn btn-sm" href="#/today">去今日任务</a>
        </div>
      </div>
    );
  }

  const state = canceled ? 'canceled' : job?.state ?? (data?.state === 'done' ? 'done' : 'running');
  const progress = job?.progress ?? 0;

  return (
    <div className="video-pane">
      <div className="video-job">
        <div className="video-job-head">
          <strong>
            {state === 'done' ? '讲解已生成' : state === 'canceled' ? '已取消' : state === 'error' ? '生成失败' : '讲解生成中'}
          </strong>
          <span className="hint">
            {data?.depth === 'short' ? '精简版' : data?.depth === 'long' ? '精讲版' : '标准版'}
            {' · '}
            {data?.coach === 'bilingual' ? '双语讲师' : '目标语讲师'}
          </span>
        </div>
        <div
          className={`studio-progress${progress > 0 ? '' : ' is-idle'}`}
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={progress > 0 ? { width: `${Math.min(100, progress)}%` } : undefined} />
        </div>
        <p className="hint">{job?.detail ?? '正在排队…'}</p>
        {job?.tokens ? <p className="hint">已消耗 {job.tokens} token</p> : null}
        {error ? <p className="run-step-error">{error}</p> : null}
        {state === 'running' ? (
          <button className="btn btn-sm" onClick={onCancel}>不看了，取消</button>
        ) : null}
        {state === 'done' && !job?.videoId ? (
          <p className="hint">片子已生成，但没拿到播放地址，去「今日任务」里打开这篇精读就能看到。</p>
        ) : null}
        <p className="hint video-job-note">
          讲解是真视频，要写分镜、逐镜配音、对时间轴，几分钟起步 —— 所以这里只等进度，不阻塞你做别的事。
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 兜底：还没做专用渲染器的产物类型
// ---------------------------------------------------------------------------

function GenericPane({ artifact }: { artifact: AgentArtifact }) {
  return (
    <div className="generic-pane">
      <p className="hint">
        「{artifact.title}」的专用渲染器还没做，先把结构原样给你，至少可读。
      </p>
      <pre className="generic-json">{JSON.stringify(artifact.data, null, 2)}</pre>
    </div>
  );
}
