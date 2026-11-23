/**
 * 解题答疑视频面板（精读页「解题答疑视频」独立页签）。
 *
 * 交互四态：idle → loading → ready → error。
 * - idle：题数、正文规模、预计时长与 token 区间；明示缓存命中不重复消耗
 * - loading：手绘 SVG 分镜动画（脚本/配音/组装）+ 阶段进度 + 预计还需时间
 * - ready：lazy 加载 SDK 播放器（目标语旁白 + 中文字幕 + 逐字稿编辑 + seek）
 * - error：中文错误 + 重试
 *
 * 缓存策略：进入页签先 explainResolve 预检——命中直接读视频，绝不创建 job、不消耗 token；
 * 同篇正在生成则续轮询既有 job，避免重复提交。音频分段带鉴权，交给 SDK 的
 * audioUrlResolver fetch 成 blob；逐字稿编辑即时反映并防抖持久化。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import {
  claimMediaPlayback,
  registerMediaPlayer,
  stopAllSpeech,
} from '@waiyubaodian/ui-kit';
import { useApp } from '../store';
import { videoThemeFor } from '@waiyubaodian/ui-kit/theme';
import type {
  Article,
  ExplainCoachMode,
  ExplainDepth,
  ExplainDepthEstimate,
  ExplainExportTrack,
  ExplainVideoLike,
  ExplainVideoSummary,
  VoiceItem,
} from '../types';
import ExplainProgressArt from './ExplainProgressArt';

const ExplainVideoPlayer = lazy(() =>
  import('@waiyubaodian/explain-video/react').then((m) => ({ default: m.ExplainVideoPlayer })),
);

interface Props {
  articleId: string;
  article: Article;
  language: 'en' | 'ja' | 'ko';
  /** 独立页签模式：横向铺开，动画与播放器都用大尺寸 */
  wide?: boolean;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

interface JobState {
  id: string;
  stage: string;
  progress: number;
  detail: string;
  videoId?: string;
  error?: string;
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
  cacheHit?: boolean;
}

interface TokenEstimate {
  shots: number;
  /** 成片时长（秒） */
  videoLow: number;
  videoHigh: number;
  /** 生成等待（秒）：写脚本 + 配音 + 组装 */
  genLow: number;
  genHigh: number;
  tokenLow: number;
  tokenHigh: number;
  /** 单独补一条中文讲师轨的 token（不重跑脚本） */
  nativeLow: number;
  nativeHigh: number;
}

const STAGE_LABEL: Record<string, string> = {
  script: '写讲解脚本',
  speech: '合成配音',
  coach: '生成中文讲师轨',
  revoice: '重配音色',
  assemble: '组装时间轴',
  done: '完成',
  error: '失败',
};

/** 讲解配音只认 Edge Neural 音色：浏览器/云端音色拿不到 Neural 名，做不了分镜配音 */
const NEURAL_NAME = /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;

function neuralOf(voice: VoiceItem): string | null {
  const direct = voice.voiceId?.trim() ?? '';
  if (NEURAL_NAME.test(direct)) return direct;
  if (direct.startsWith('local://edge:')) {
    const bare = direct.slice('local://edge:'.length);
    if (NEURAL_NAME.test(bare)) return bare;
  }
  const engine = voice.engineVoice?.trim() ?? '';
  if (NEURAL_NAME.test(engine)) return engine;
  return null;
}

/** 音色短名：Nanami / Xiaoxiao，给按钮和提示用，别让用户读一串 ja-JP-xxxNeural */
function shortVoiceName(neural: string): string {
  const bare = neural.split('-').pop() ?? neural;
  return bare.replace(/Neural$/, '');
}

/** 字幕与讲师偏好：属于用户习惯，跨篇记忆（不进后端） */
type CaptionMode = 'both' | 'target' | 'native';
type AudioTrackKind = 'target' | 'native';
const PREF_KEY = 'explain-video:prefs';

function readPrefs(): { captionMode: CaptionMode; track: AudioTrackKind } {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ captionMode: CaptionMode; track: AudioTrackKind }>;
      return {
        captionMode: parsed.captionMode === 'target' || parsed.captionMode === 'native' ? parsed.captionMode : 'both',
        track: parsed.track === 'native' ? 'native' : 'target',
      };
    }
  } catch {
    // 隐私模式 / 存储被禁用：用默认值即可
  }
  return { captionMode: 'both', track: 'target' };
}

function savePrefs(next: { captionMode: CaptionMode; track: AudioTrackKind }): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch {
    // 存不下就不存，不影响播放
  }
}

/** 深度对成本的粗略倍率：仅用于服务端预估回来之前的骨架值，最终以 /estimate 为准 */
const DEPTH_FACTOR: Record<ExplainDepth, number> = { short: 0.62, medium: 1, long: 1.55 };

/** 基于题量与正文长度的区间估计：只给量级，不承诺精确值。
 *  实测样本：4 题 22 镜约 7.3k token；3 题 15 镜约 6.7k token。 */
function estimate(questionCount: number, bodyLength: number, depth: ExplainDepth): TokenEstimate {
  const factor = DEPTH_FACTOR[depth];
  const shots = Math.round(Math.max(6, questionCount * 4 + 2) * factor);
  const tokenBase = (3600 + questionCount * 550 + Math.round(bodyLength / 6)) * factor;
  // 成片时长由旁白字数决定；生成等待由大模型吐 token 的速度决定，两者不能混用
  const videoSec = (questionCount * 190 + 70) * factor;
  const genSec = (240 + questionCount * 60) * factor;
  const round500 = (n: number) => Math.max(500, Math.round(n / 500) * 500);
  return {
    shots,
    videoLow: Math.max(45, Math.round(videoSec * 0.85)),
    videoHigh: Math.round(videoSec * 1.25),
    genLow: Math.round(genSec * 0.8),
    genHigh: Math.round(genSec * 1.6),
    tokenLow: round500(tokenBase * 0.82),
    tokenHigh: round500(tokenBase * 1.18),
    // 中文轨只是一次转述：约为脚本的 18%，服务端 /estimate 回来后覆盖
    nativeLow: round500(tokenBase * 0.14),
    nativeHigh: round500(tokenBase * 0.24),
  };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatMinutes(sec: number): string {
  return `${(sec / 60).toFixed(1)} 分钟`;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const DEPTH_LABEL: Record<string, string> = { short: '精简', medium: '标准', long: '精讲' };

/**
 * 讲师轨选择：目标语单轨（省 token）/ 目标语 + 中文双讲师。
 * 不是「字幕语言」——字幕始终双语可切；这是「谁来念」。
 */
function CoachPicker({
  value,
  onChange,
  nativeLow,
  nativeHigh,
  disabled = false,
}: {
  value: ExplainCoachMode;
  onChange: (next: ExplainCoachMode) => void;
  nativeLow: number;
  nativeHigh: number;
  disabled?: boolean;
}) {
  return (
    <div className="ev-coach" role="radiogroup" aria-label="讲师轨">
      <button
        type="button"
        role="radio"
        aria-checked={value === 'target'}
        className={`ev-coach-item${value === 'target' ? ' is-active' : ''}`}
        onClick={() => onChange('target')}
        disabled={disabled}
      >
        <span className="ev-coach-name">目标语讲师</span>
        <span className="ev-coach-meta">只有外语讲解 · 双语字幕</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === 'bilingual'}
        className={`ev-coach-item${value === 'bilingual' ? ' is-active' : ''}`}
        onClick={() => onChange('bilingual')}
        disabled={disabled}
      >
        <span className="ev-coach-name">
          双语讲师
          <em className="ev-coach-extra">+{formatTokens(nativeLow)}–{formatTokens(nativeHigh)} token</em>
        </span>
        <span className="ev-coach-meta">外语 + 中文同讲一条轨 · 可随时补</span>
      </button>
    </div>
  );
}

/**
 * 历史讲解浮层（右上角）。
 * 这里会列出「同篇同级别的共享讲解」——别人生成过一次，你直接看，不再花 token。
 */
function HistoryPanel({
  items,
  currentId,
  onPick,
  onClose,
}: {
  items: ExplainVideoSummary[];
  currentId?: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="ev-history" role="dialog" aria-label="历史讲解">
      <div className="ev-history-head">
        <strong>这篇的历史讲解</strong>
        <button type="button" className="ev-history-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      {items.length === 0 ? (
        <div className="ev-history-empty">还没有生成过。生成一次后，同篇同级别的学员都会看到它。</div>
      ) : (
        <div className="ev-history-list">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`ev-history-item${item.id === currentId ? ' is-current' : ''}`}
              onClick={() => onPick(item.id)}
            >
              <span className="ev-history-title">
                {DEPTH_LABEL[item.depth ?? 'medium'] ?? '标准'}版
                {item.band ? <em className="ev-history-tag">{item.band.toUpperCase()}</em> : null}
                {item.coach === 'bilingual' ? <em className="ev-history-tag ev-history-bi">双语</em> : null}
                {item.source === 'shared' ? (
                  <em className="ev-history-tag ev-history-shared">共享</em>
                ) : null}
                {item.revised ? <em className="ev-history-tag ev-history-revised">我改过</em> : null}
              </span>
              <span className="ev-history-meta">
                {item.shots} 镜 · {formatClock(item.totalMs)} · {new Date(item.createdAt).toLocaleDateString()}
                {item.mine ? ' · 我生成的' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const DEPTH_FALLBACK: Array<{ id: ExplainDepth; label: string; blurb: string }> = [
  { id: 'short', label: '精简', blurb: '每题三镜：题 → 证据 → 答案。适合复习与快速过题。' },
  { id: 'medium', label: '标准', blurb: '每题五镜：定位 → 拆解 → 排除 → 答案 → 迁移。日常主用。' },
  { id: 'long', label: '精讲', blurb: '每题六到七镜，含语法专镜与第二个视角。难题、长文用。' },
];

/**
 * 三档选择器。
 * 「短/中/长」本质是三个不同的 prompt 预算与分镜计划，所以它不是播放器倍速，
 * 而是「换一条片子」：缓存也按档位分开存，选到已生成的档会显示「已生成」。
 */
function DepthPicker({
  value,
  depths,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: ExplainDepth;
  depths: ExplainDepthEstimate[] | null;
  onChange: (next: ExplainDepth) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const items = depths?.length
    ? depths
    : DEPTH_FALLBACK.map((item) => ({ ...item, shots: 0, secLow: 0, secHigh: 0, tokenLow: 0, tokenHigh: 0, cached: false }));
  return (
    <div className={`ev-depth${compact ? ' ev-depth-compact' : ''}`} role="radiogroup" aria-label="讲解深度">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`ev-depth-item${active ? ' is-active' : ''}`}
            onClick={() => onChange(item.id)}
            disabled={disabled || active}
          >
            <span className="ev-depth-name">
              {item.label}
              {item.cached ? <em className="ev-depth-cached">已生成</em> : null}
            </span>
            <span className="ev-depth-meta">
              {item.shots > 0 ? `${item.shots} 镜 · ` : ''}
              {item.secHigh > 0 ? `${formatMinutes(item.secLow)}–${formatMinutes(item.secHigh)}` : '—'}
            </span>
            <span className="ev-depth-meta ev-depth-token">
              {item.tokenHigh > 0 ? `约 ${formatTokens(item.tokenLow)}–${formatTokens(item.tokenHigh)} token` : '—'}
            </span>
            {!compact ? <span className="ev-depth-blurb">{item.blurb}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// language 仍留在 Props 里给调用方用（生成时由后端按正文推断语种），面板本身不需要它
export default function ExplainVideoPanel({ articleId, article, wide = false }: Props) {
  const { theme } = useApp();
  const videoTheme = useMemo(() => videoThemeFor(theme), [theme]);
  const playerRef = useRef<{ pause: () => void } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [job, setJob] = useState<JobState | null>(null);
  const [video, setVideo] = useState<ExplainVideoLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cacheNote, setCacheNote] = useState<string | null>(null);
  const [depth, setDepth] = useState<ExplainDepth>('medium');
  const [depths, setDepths] = useState<ExplainDepthEstimate[] | null>(null);
  const [levelLabel, setLevelLabel] = useState<string | null>(null);
  /** 讲师轨：默认只出目标语（最省 token），需要母语再补 */
  const [coach, setCoach] = useState<ExplainCoachMode>('target');
  const [nativeCost, setNativeCost] = useState<{ low: number; high: number } | null>(null);
  /** 历史讲解（含跨用户共享的同篇同级别片子） */
  const [history, setHistory] = useState<ExplainVideoSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 当前这条片来自共享层还是自己的副本 */
  const [cacheSource, setCacheSource] = useState<'shared' | 'personal' | null>(null);
  const [prefs, setPrefs] = useState(readPrefs);
  /** 生成中到底是哪一种任务：决定 loading 文案与成本口径（重配音是 0 token） */
  const [pendingKind, setPendingKind] = useState<'generate' | 'coach' | 'revoice'>('generate');
  /** 换音色重配：可用音色列表 + 浮层开关 */
  const [revoiceOpen, setRevoiceOpen] = useState(false);
  const [voiceOptions, setVoiceOptions] = useState<Array<{ neural: string; label: string }>>([]);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  /** 上一次选的重配音音色：重试时要重跑同一件事，不能一按「重试」就重新生成整片 */
  const [lastRevoiceVoice, setLastRevoiceVoice] = useState<string | undefined>(undefined);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const blobUrlsRef = useRef<Map<string, string>>(new Map());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const questionCount = article.questions.length;
  /** 选中档位的预估：服务端 /estimate 回来前先用本地骨架值，避免空白 */
  const est = useMemo<TokenEstimate>(() => {
    const server = depths?.find((item) => item.id === depth);
    if (server) {
      return {
        shots: server.shots,
        videoLow: server.secLow,
        videoHigh: server.secHigh,
        genLow: server.genSecLow,
        genHigh: server.genSecHigh,
        tokenLow: server.tokenLow,
        tokenHigh: server.tokenHigh,
        nativeLow: nativeCost?.low ?? Math.round(server.tokenLow * 0.16),
        nativeHigh: nativeCost?.high ?? Math.round(server.tokenHigh * 0.24),
      };
    }
    return estimate(questionCount, (article.body ?? '').length, depth);
  }, [depths, depth, nativeCost, questionCount, article.body]);

  // 三档预估只在换篇时拉一次：档位切换是纯前端选择，不必再请求
  useEffect(() => {
    let alive = true;
    api
      .explainEstimate(articleId)
      .then((res) => {
        if (!alive) return;
        setDepths(res.depths);
        setLevelLabel(res.level.label);
        setNativeCost({ low: res.nativeCost.tokenLow, high: res.nativeCost.tokenHigh });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [articleId]);

  const depthLabel =
    depths?.find((item) => item.id === depth)?.label ??
    DEPTH_FALLBACK.find((item) => item.id === depth)?.label ??
    '标准';

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current.clear();
    };
  }, []);

  // P0-5：把讲解播放器注册进全局媒体协调器，媒体/TTS 开播时可反停它，互斥变双向
  useEffect(
    () =>
      registerMediaPlayer('explain', {
        stop: () => playerRef.current?.pause(),
      }),
    [],
  );

  // 换篇（articleId 变）后重置：旧视频自然不再出现
  useEffect(() => {
    setPhase('idle');
    setJob(null);
    setVideo(null);
    setError(null);
    setSaved(false);
    setCacheNote(null);
    setCacheSource(null);
    setHistoryOpen(false);
    setStartedAt(null);
    setRevoiceOpen(false);
    setExportMenuOpen(false);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    blobUrlsRef.current.clear();

    // 先预检缓存：命中直接秒开；正在生成则续轮询；都没有才停在 idle
    // 档位也是缓存键的一部分：切档等于换一条片子，必须重新预检
    api
      .explainResolve(articleId, depth)
      .then(({ resolve }) => {
        if (!aliveRef.current) return;
        if (resolve.state === 'cached' && resolve.videoId) {
          setCacheSource(resolve.source ?? null);
          return api.explainGet(resolve.videoId).then((res) => {
            if (!aliveRef.current) return;
            setVideo(res.video);
            setPhase('ready');
            setCacheNote(
              resolve.source === 'shared'
                ? '这篇同级别讲解已经有人生成过，直接复用，本次 0 token'
                : resolve.tokens?.totalTokens
                  ? `已命中缓存，本次消耗 0 token（首次生成用了 ${formatTokens(resolve.tokens.totalTokens)}）`
                  : '已命中缓存，本次消耗 0 token',
            );
          });
        }
        if (resolve.state === 'running' && resolve.job) {
          setJob(resolve.job);
          setPhase('loading');
          setStartedAt(Date.now());
          startPollingRef.current?.(resolve.job.id);
        }
        return undefined;
      })
      .catch(() => undefined);
  }, [articleId, depth]);

  // 历史讲解：进入页签拉一次，生成完成后再刷新
  const refreshHistory = useCallback(() => {
    api
      .explainList(articleId)
      .then((res) => {
        if (aliveRef.current) setHistory(res.videos);
      })
      .catch(() => undefined);
  }, [articleId]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // 已用秒数：loading 态用于「预计还需」
  useEffect(() => {
    if (phase !== 'loading') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      pollRef.current = setInterval(() => {
        api
          .explainJob(jobId)
          .then(({ job: next }) => {
            if (!aliveRef.current) return;
            setJob(next);
            if (next.stage === 'error') {
              setPhase('error');
              setError(next.error ?? '生成失败，请重试');
              stopPolling();
            } else if (next.stage === 'done' && next.videoId) {
              stopPolling();
              // 换过音色：分段 URL 没变（还是 /seg/N），但文件内容换了，旧 blob 必须丢弃
              if (next.revoiceOnly) {
                blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
                blobUrlsRef.current.clear();
              }
              return api.explainGet(next.videoId).then((res) => {
                if (!aliveRef.current) return;
                setVideo(res.video);
                setPhase('ready');
                setCacheSource(null);
                const used = next.tokens?.totalTokens ?? 0;
                setCacheNote(
                  next.revoiceOnly
                    ? next.detail
                    : next.coachOnly && used > 0
                      ? `中文讲师轨已补上（约 ${formatTokens(used)} token），之后切中文讲师不再花钱`
                      : next.cacheHit
                        ? next.cacheSource === 'shared'
                          ? '这篇同级别讲解已有人生成过，直接复用，本次 0 token'
                          : '命中缓存，本次消耗 0 token'
                        : used > 0
                          ? `本次消耗约 ${formatTokens(used)} token，同一篇同级别再打开直接读缓存`
                          : null,
                );
                refreshHistory();
              });
            }
            return undefined;
          })
          .catch((err: Error) => {
            if (!aliveRef.current) return;
            setPhase('error');
            setError(err.message);
            stopPolling();
          });
      }, 1000);
    },
    [stopPolling, refreshHistory],
  );

  // resolve 回调里需要最新的 startPolling（effect 依赖只留 articleId）
  const startPollingRef = useRef(startPolling);
  useEffect(() => {
    startPollingRef.current = startPolling;
  }, [startPolling]);

  const generate = async (
    force = false,
    targetDepth: ExplainDepth = depth,
    targetCoach: ExplainCoachMode = coach,
  ) => {
    setPhase('loading');
    setPendingKind('generate');
    setError(null);
    setVideo(null);
    setSaved(false);
    setCacheNote(null);
    setCacheSource(null);
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const { job: created } = await api.explainCreate(articleId, force, targetDepth, targetCoach);
      setJob({ ...created, stage: 'script', progress: 5, detail: '正在提交生成任务…' });
      startPolling(created.id);
    } catch (err) {
      setPhase('error');
      setError((err as Error).message);
    }
  };

  /** 只补中文讲师轨：不重跑脚本，成本约为整片重生成的 1/5 */
  const addNativeCoach = async () => {
    if (!video) return;
    const low = formatTokens(est.nativeLow);
    const high = formatTokens(est.nativeHigh);
    if (!window.confirm(`补一条中文讲师轨不会重写脚本，只做转述与配音，预计 ${low}–${high} token。继续吗？`)) {
      return;
    }
    setPhase('loading');
    setError(null);
    setPendingKind('coach');
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const { job: created } = await api.explainCoach(video.id);
      setJob({ ...created, stage: 'coach', progress: 8, detail: '正在生成中文讲师轨…' });
      startPolling(created.id);
    } catch (err) {
      setPhase('error');
      setError((err as Error).message);
    }
  };

  /** 打开「换音色重配」：第一次展开时才去拉该语种的音色列表 */
  const openRevoice = () => {
    setExportMenuOpen(false);
    setRevoiceOpen((v) => !v);
    if (voiceOptions.length > 0 || voiceLoading) return;
    const language = video?.language ?? 'en';
    setVoiceLoading(true);
    api
      .voices(language)
      .then((res) => {
        if (!aliveRef.current) return;
        const seen = new Set<string>();
        const items: Array<{ neural: string; label: string }> = [];
        for (const voice of res.voices) {
          const neural = neuralOf(voice);
          if (!neural || seen.has(neural)) continue;
          seen.add(neural);
          items.push({ neural, label: voice.name?.trim() || shortVoiceName(neural) });
        }
        setVoiceOptions(items);
      })
      .catch(() => undefined)
      .finally(() => {
        if (aliveRef.current) setVoiceLoading(false);
      });
  };

  /**
   * 换音色重配：只重跑 TTS，不调大模型，token 恒为 0。
   * 不传 voice 就用「文章讲解」场景当前配的音色（服务端解析）。
   */
  const doRevoice = async (voice?: string) => {
    if (!video) return;
    setLastRevoiceVoice(voice);
    setRevoiceOpen(false);
    setPhase('loading');
    setError(null);
    setPendingKind('revoice');
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const { job: created } = await api.explainRevoice(video.id, voice);
      setJob({
        ...created,
        stage: 'revoice',
        progress: 5,
        detail: voice ? `正在用「${shortVoiceName(voice)}」重配…` : '正在用你的音色重配…',
      });
      startPolling(created.id);
    } catch (err) {
      setPhase('error');
      setError((err as Error).message);
    }
  };

  const cancel = async () => {
    if (!job) return;
    stopPolling();
    try {
      await api.explainCancelJob(job.id);
    } catch {
      // 取消失败也回到 idle，后台任务会自行结束
    }
    setPhase('idle');
    setJob(null);
    setStartedAt(null);
  };

  /** SDK 的音频 URL 解析器：把分段 URL fetch 成带鉴权的 blob URL 并缓存（按 URL 区分音轨） */
  const audioUrlResolver = useCallback(
    async (url: string): Promise<string> => {
      const hit = blobUrlsRef.current.get(url);
      if (hit) return hit;
      const match = url.match(/\/seg\/(\d+)(?:\?track=zh)?$/);
      if (!match || !video) return url;
      const track = url.includes('track=zh') ? 'native' : 'target';
      const blobUrl = await api.explainSegmentBlob(video.id, Number(match[1]), track);
      blobUrlsRef.current.set(url, blobUrl);
      return blobUrl;
    },
    [video],
  );

  /** 逐字稿编辑：本地已由 SDK 实时更新，这里防抖持久化到后端 */
  const handleTranscript = useCallback(
    (_event: unknown, nextVideo: ExplainVideoLike) => {
      setVideo(nextVideo);
      setSaved(false);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        api
          .explainSaveTranscript(nextVideo.id, nextVideo)
          .then(() => setSaved(true))
          .catch(() => setSaved(false));
      }, 800);
    },
    [],
  );

  /** 导出 MP4：按音轨分文件，双语导出在容器里带两条 audio stream */
  const handleExport = async (track: ExplainExportTrack) => {
    if (!video) return;
    setExportMenuOpen(false);
    setExporting(true);
    try {
      const { url } = await api.explainExport(video.id, track);
      const suffix = track === 'native' ? '·中文讲师' : track === 'both' ? '·双语' : '';
      const a = document.createElement('a');
      a.href = url;
      a.download = `${video.title || '解题讲解'}${suffix}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    } finally {
      setExporting(false);
    }
  };

  const shellClass = `ev-panel ev-panel-${phase}${wide ? ' ev-panel-wide' : ''}`;
  const hasNative = Boolean(
    video && (video.coach === 'bilingual' || video.shots.some((shot) => Boolean(shot.audio?.native?.url))),
  );

  /** 右上角的历史入口：同篇同级别的共享讲解都在这里，点开即看，不再花 token */
  const historyBtn = (
    <button
      type="button"
      className={`ev-history-btn${historyOpen ? ' is-open' : ''}`}
      onClick={() => setHistoryOpen((v) => !v)}
      title="同篇同级别的历史讲解（含其他学员生成过的）"
    >
      历史讲解{history.length > 0 ? ` · ${history.length}` : ''}
    </button>
  );

  const historyLayer = historyOpen ? (
    <HistoryPanel
      items={history}
      currentId={video?.id}
      onPick={(id) => {
        setHistoryOpen(false);
        api
          .explainGet(id)
          .then((res) => {
            if (!aliveRef.current) return;
            setVideo(res.video);
            setPhase('ready');
            setCacheSource(null);
            setCacheNote('已切换到历史讲解');
          })
          .catch((err: Error) => setError(err.message));
      }}
      onClose={() => setHistoryOpen(false)}
    />
  ) : null;

  if (phase === 'loading' && job) {
    const pct = Math.min(100, Math.max(0, job.progress));
    const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
    // 三种任务的等待与成本完全不是一回事，不能共用「生成」那一套数字
    const shotCount = video?.shots.length ?? est.shots;
    const revoiceSec = Math.round((shotCount / 2) * 3) + 6;
    const span = pendingKind === 'revoice'
      ? { low: revoiceSec, high: Math.round(revoiceSec * 1.9) }
      : pendingKind === 'coach'
        ? { low: 30 + shotCount * 5, high: 60 + shotCount * 11 }
        : { low: est.genLow, high: est.genHigh };
    const remainLow = Math.max(5, Math.round(span.low - elapsed));
    const remainHigh = Math.max(remainLow + 5, Math.round(span.high - elapsed));
    const heading = pendingKind === 'revoice'
      ? '解题答疑 · 正在换音色重配'
      : pendingKind === 'coach'
        ? '解题答疑 · 正在补中文讲师轨'
        : `解题答疑 · 正在生成${depthLabel}讲解`;
    return (
      <div className={shellClass}>
        <div className="ev-panel-head">
          <strong>{heading}</strong>
          <button className="btn btn-sm" onClick={cancel}>取消</button>
        </div>
        <div className="ev-loading-body">
          <ExplainProgressArt stage={job.stage} progress={pct} elapsedSec={elapsed} />
          <div className="ev-loading-copy">
            <div className="ev-stage-label">
              {STAGE_LABEL[job.stage] ?? job.stage}
              <span className="ev-stage-count">
                {pendingKind === 'generate'
                  ? job.stage === 'script' ? '1/3' : job.stage === 'speech' ? '2/3' : job.stage === 'assemble' ? '3/3' : ''
                  : ''}
              </span>
            </div>
            <div className="ev-progress"><div className="ev-progress-fill" style={{ width: `${pct}%` }} /></div>
            <div className="ev-panel-hint">{job.detail}</div>
            <div className="ev-est-row">
              <span className="ev-est-pill">预计还需 {remainLow}–{remainHigh} 秒</span>
              {pendingKind === 'revoice' ? (
                <span className="ev-est-pill ev-est-token ev-est-free">0 token · 只重配音频</span>
              ) : pendingKind === 'coach' ? (
                <span className="ev-est-pill ev-est-token">
                  约 {formatTokens(est.nativeLow)}–{formatTokens(est.nativeHigh)} token
                </span>
              ) : (
                <span className="ev-est-pill ev-est-token">
                  约 {formatTokens(est.tokenLow)}–{formatTokens(est.tokenHigh)} token
                </span>
              )}
            </div>
            <div className="ev-panel-hint">
              {pendingKind === 'revoice'
                ? `旁白与字幕一个字都不改，只换个人念（共 ${shotCount} 镜）。共享讲解会存成你个人的副本，不影响其他学员。`
                : pendingKind === 'coach'
                  ? '只把已有的讲解转述成中文再配音，不重写脚本。'
                  : `共约 ${est.shots} 个分镜；这份讲解只生成一次，之后再打开直接读缓存、不重复消耗 token。`}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    // 重试要重跑「上一次那件事」：补轨/重配音失败后按重试却重生成整片，是最贵的误操作
    const retry = () => {
      if (!video) return generate(false);
      if (pendingKind === 'revoice') return doRevoice(lastRevoiceVoice);
      if (pendingKind === 'coach') return addNativeCoach();
      return generate(false);
    };
    return (
      <div className={shellClass}>
        <div className="ev-panel-head"><strong>解题答疑 · 生成失败</strong></div>
        <div className="ev-error-text">{error ?? '未知错误'}</div>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" onClick={retry}>
            {pendingKind === 'revoice' ? '重试重配音' : pendingKind === 'coach' ? '重试补中文轨' : '重试'}
          </button>
          <button className="btn btn-sm" onClick={() => { setPhase('idle'); setError(null); }}>返回</button>
        </div>
      </div>
    );
  }

  if (phase === 'ready' && video) {
    const shownDepth = video.meta?.depth ?? depth;
    const shownLabel = depths?.find((item) => item.id === shownDepth)?.label ?? depthLabel;
    /** 换音色只跑本地 TTS：并发 2、单镜约 3 秒，加几秒启动开销 */
    const revoiceSec = Math.round((video.shots.length / 2) * 3) + 6;
    return (
      <div className={shellClass}>
        <div className="ev-panel-head">
          <strong>
            解题答疑 · 视频讲解
            {cacheSource === 'shared' ? <span className="ev-shared-badge">共享讲解</span> : null}
            {hasNative ? <span className="ev-shared-badge ev-bi-badge">双语</span> : null}
          </strong>
          <div className="ev-head-right">
            <span className="hint">{questionCount} 道题 · {video.shots.length} 镜 · 约 {Math.round(video.totalMs / 1000)} 秒</span>
            {historyBtn}
          </div>
        </div>
        {historyLayer}
        <div className="ev-depth-bar">
          <DepthPicker
            value={shownDepth}
            depths={depths}
            onChange={(next) => {
              if (next === shownDepth) return;
              setDepth(next);
            }}
            compact
          />
          <span className="ev-depth-hint">
            当前为{shownLabel}版 · 切档会读该档缓存，没有才重新生成
          </span>
        </div>
        {cacheNote ? <div className="ev-cache-note">{cacheNote}</div> : null}
        {video.meta?.quality && (video.meta.quality.salvage || video.meta.quality.autoFilledShots > 0) ? (
          <div className="ev-cache-note ev-quality-note">
            {video.meta.quality.truncated ? '上次模型输出被截断' : '模型输出格式不规范'}，已按可用部分生成
            {video.meta.quality.autoFilledShots > 0
              ? `，其中 ${video.meta.quality.autoFilledShots} 镜由题库自动补齐`
              : ''}
            ；答案仍以题库为准。
          </div>
        ) : null}
        <div className="liquid-glass-frame" style={{ marginTop: 10 }}>
          <div className="liquid-glass-inner">
            <Suspense fallback={<div className="ev-panel-hint">播放器加载中…</div>}>
              <ExplainVideoPlayer
                ref={playerRef as never}
                video={video as never}
                context={{ body: article.body, translation: article.translation, questions: article.questions }}
                editable
                transcriptOpen={wide}
                audioUrlResolver={audioUrlResolver}
                initialCaptionMode={prefs.captionMode}
                initialTrack={prefs.track}
                onCaptionModeChange={(mode) => {
                  const next = { ...prefs, captionMode: mode };
                  setPrefs(next);
                  savePrefs(next);
                }}
                onTrackChange={(track) => {
                  const next = { ...prefs, track };
                  setPrefs(next);
                  savePrefs(next);
                }}
                onRequestPlay={() => {
                  // P0-5：抢媒体出声权（会停掉其它 MediaPane）+ 停掉所有 TTS / 云端朗读，
                  // 保证同一时刻全局只有这一路在出声。
                  claimMediaPlayback('explain');
                  stopAllSpeech();
                }}
                onTranscriptChange={(event) => handleTranscript(event, event.video as ExplainVideoLike)}
                theme={videoTheme}
              />
            </Suspense>
          </div>
        </div>
        <div className="ev-panel-foot">
          <span className="hint">
            {saved ? '逐字稿已保存' : '逐字稿编辑后自动保存'} · 音色 {shortVoiceName(video.voice)}
            {video.meta?.revoice ? '（你重配的）' : ''}
          </span>
          <div className="row ev-foot-actions" style={{ gap: 6 }}>
            {!hasNative ? (
              <button className="btn btn-sm ev-coach-cta" onClick={addNativeCoach}>
                补中文讲师 · 约 {formatTokens(est.nativeLow)}–{formatTokens(est.nativeHigh)} token
              </button>
            ) : null}

            {/* 换音色：只重跑 TTS，0 token。共享片会先落成个人副本再写音频 */}
            <div className="ev-menu-wrap">
              <button
                className={`btn btn-sm${revoiceOpen ? ' is-open' : ''}`}
                onClick={openRevoice}
                title="只重配音频，不重新生成讲解"
              >
                换音色{revoiceOpen ? ' ▴' : ' ▾'}
              </button>
              {revoiceOpen ? (
                <div className="ev-menu ev-revoice" role="dialog" aria-label="换音色重配">
                  <div className="ev-menu-head">
                    <strong>换一个讲师音色</strong>
                    <button
                      type="button"
                      className="ev-history-close"
                      onClick={() => setRevoiceOpen(false)}
                      aria-label="关闭"
                    >
                      ×
                    </button>
                  </div>
                  <div className="ev-menu-note">
                    只重跑配音、不调大模型：<b>0 token</b>，约 {revoiceSec} 秒。旁白与字幕一个字都不改。
                    {cacheSource === 'shared' ? ' 这次会存成你的个人副本，不影响其他学员。' : ''}
                  </div>
                  <button type="button" className="ev-menu-item" onClick={() => doRevoice()}>
                    <span className="ev-menu-name">用我的默认音色</span>
                    <span className="ev-menu-meta">「文章讲解」场景当前配的那个</span>
                  </button>
                  {voiceLoading ? <div className="ev-menu-note">正在读取音色列表…</div> : null}
                  {voiceOptions.map((item) => {
                    const current = item.neural === video.voice;
                    return (
                      <button
                        type="button"
                        key={item.neural}
                        className={`ev-menu-item${current ? ' is-current' : ''}`}
                        onClick={() => doRevoice(item.neural)}
                        disabled={current}
                      >
                        <span className="ev-menu-name">
                          {item.label}
                          {current ? <em className="ev-history-tag">当前</em> : null}
                        </span>
                        <span className="ev-menu-meta">{item.neural}</span>
                      </button>
                    );
                  })}
                  {!voiceLoading && voiceOptions.length === 0 ? (
                    <div className="ev-menu-note">
                      这个语种还没配可用的 Neural 音色。去「音色」页点「启用本地音色」后再回来。
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* 导出：三条音轨口径，双语导出在容器里放两条 audio stream */}
            <div className="ev-menu-wrap">
              <button
                className={`btn btn-sm${exportMenuOpen ? ' is-open' : ''}`}
                onClick={() => {
                  setRevoiceOpen(false);
                  setExportMenuOpen((v) => !v);
                }}
                disabled={exporting}
                title="选择导出哪条音轨"
              >
                {exporting ? '导出中…' : '导出 MP4 ▾'}
              </button>
              {exportMenuOpen ? (
                <div className="ev-menu ev-export" role="dialog" aria-label="导出 MP4">
                  <div className="ev-menu-head">
                    <strong>导出 MP4</strong>
                    <button
                      type="button"
                      className="ev-history-close"
                      onClick={() => setExportMenuOpen(false)}
                      aria-label="关闭"
                    >
                      ×
                    </button>
                  </div>
                  <button type="button" className="ev-menu-item" onClick={() => handleExport('target')}>
                    <span className="ev-menu-name">原文音轨</span>
                    <span className="ev-menu-meta">外语讲师 · 中文字幕烧进画面</span>
                  </button>
                  <button
                    type="button"
                    className="ev-menu-item"
                    onClick={() => handleExport('native')}
                    disabled={!hasNative}
                  >
                    <span className="ev-menu-name">中文讲师音轨</span>
                    <span className="ev-menu-meta">
                      {hasNative ? '中文口播 · 第二行换成中文稿' : '还没有中文讲师轨'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ev-menu-item"
                    onClick={() => handleExport('both')}
                    disabled={!hasNative}
                  >
                    <span className="ev-menu-name">
                      双语双音轨
                      <em className="ev-history-tag ev-history-bi">推荐</em>
                    </span>
                    <span className="ev-menu-meta">一个文件两条音轨，播放器/剪辑软件可切语言</span>
                  </button>
                </div>
              ) : null}
            </div>

            <button
              className="btn btn-sm"
              onClick={() => {
                const target = depths?.find((item) => item.id === shownDepth);
                const tokenText = target
                  ? `${formatTokens(target.tokenLow)}–${formatTokens(target.tokenHigh)}`
                  : `${formatTokens(est.tokenLow)}–${formatTokens(est.tokenHigh)}`;
                if (window.confirm(`重新生成会再次调用大模型，预计消耗 ${tokenText} token。确定继续吗？`)) {
                  generate(true, shownDepth, video.coach ?? 'target');
                }
              }}
            >
              重新生成
            </button>
          </div>
        </div>
      </div>
    );
  }

  // idle
  return (
    <div className={shellClass}>
      <div className="ev-panel-head">
        <strong>解题答疑 · 视频讲解</strong>
        {historyBtn}
      </div>
      {historyLayer}
      <div className={`ev-idle-body${wide ? ' wide' : ''}`}>
        <div className="ev-idle-hero" aria-hidden="true">
          <svg viewBox="0 0 104 96" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <rect className="art-card" x="14" y="20" width="58" height="56" rx="8" />
            <path className="art-soft" d="M22 34h34M22 44h42M22 54h28" />
            <path className="art-line art-draw" pathLength={1} d="M22 64h20" />
            <path className="art-check art-draw" pathLength={1} style={{ animationDelay: '0.5s' }} d="M70 62l6 6 12-14" />
          </svg>
        </div>
        <div className="ev-idle-copy">
          <div className="ev-idle-line">
            AI 教授级老师，逐题讲解这道题为什么这么解
            {levelLabel ? <span className="ev-level-badge">按 {levelLabel} 教案讲</span> : null}
          </div>
          <DepthPicker value={depth} depths={depths} onChange={setDepth} />
          <CoachPicker
            value={coach}
            onChange={setCoach}
            nativeLow={est.nativeLow}
            nativeHigh={est.nativeHigh}
          />
          <div className="ev-idle-meta">
            <span className="ev-idle-pill">{questionCount} 道题 · 约 {est.shots} 镜</span>
            <span className="ev-idle-pill">成片 {formatMinutes(est.videoLow)}–{formatMinutes(est.videoHigh)}</span>
            <span className="ev-idle-pill">
              约 {formatTokens(est.tokenLow + (coach === 'bilingual' ? est.nativeLow : 0))}–
              {formatTokens(est.tokenHigh + (coach === 'bilingual' ? est.nativeHigh : 0))} token
            </span>
            <span className="ev-idle-pill">双语字幕 · 可切原文/中文</span>
          </div>
          <button className="btn btn-primary" onClick={() => generate(false)} style={{ marginTop: 12 }}>
            ▶ 生成{depthLabel}讲解
          </button>
          <div className="ev-panel-hint">
            每道题都走「生活化入口 → 原文定位 → 拆句 → 逐项排除 → 迁移动作」，答案以题库为准 ·
            同篇同级别只生成一次，别人看过的你也能直接看（右上角「历史讲解」）
          </div>
        </div>
      </div>
    </div>
  );
}
