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
import { claimMediaPlayback, stopAllSpeech } from '@waiyubaodian/ui-kit';
import { videoThemeFor } from '@waiyubaodian/ui-kit/theme';
import type {
  AnnotatedDiffPayload,
  AgentArtifact,
  ExplainJobState,
  ExplainVideoPayload,
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
