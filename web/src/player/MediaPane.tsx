/**
 * MediaPane —— 业务页共用的媒体播放面板。
 *
 * 封装 MediaPlayerView + 全局协调器 + 生命周期管理（stop→idle 后再次 play 自动 reload），
 * 供演示页 / 精读 / 考试听力复用，保证三处行为一致、同一时刻全局只有一个在出声。
 *
 * 两种形态：
 *  - standalone：自带完整控制栏（进度 / 音量 / 倍速），精读媒体标签页用；
 *  - bare：只输出 canvas，控制栏由宿主自绘，考试听力用（宿主需要精确控制"两遍限制"）。
 *
 * 与 TTS 朗读链路（useVoicePlayer / useSpeech）零耦合：本组件只放真实媒体文件。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type * as React from 'react';
import { MediaPlayerView, type MediaPlayerHandle } from '@waiyubaodian/hevc-player/react';
import type {
  MediaInfo,
  MediaType,
  PlayerErrorInfo,
  PlayerState,
  PlayerStats,
  SourceKind,
} from '@waiyubaodian/hevc-player';
import {
  claimMediaPlayback,
  getActiveMediaId,
  registerMediaPlayer,
  releaseMediaPlayback,
  subscribeActiveMedia,
} from '@waiyubaodian/ui-kit';
import { useApp } from '../store';
import { videoThemeFor } from '@waiyubaodian/ui-kit/theme';
import { Select, Slider, type SelectOption } from '@waiyubaodian/ui-kit';

export interface MediaPaneHandle {
  /** 申请播放权并播放；首次 / 被 stop 后会自动 load */
  play: () => Promise<void>;
  pause: () => void;
  /** 停止并释放播放权 */
  stop: () => void;
}

export interface MediaPaneProps {
  /** 全局协调器注册 id，必须唯一（用组件语义 + 题目 idx） */
  id: string;
  src: string;
  mediaType: MediaType;
  sourceKind?: SourceKind;
  /** standalone 时画布样式；bare 时宿主也可传入 */
  canvasStyle?: React.CSSProperties;
  variant?: 'standalone' | 'bare';
  onEnded?: () => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
}

function fmtTime(us: number): string {
  const total = Math.max(0, Math.floor(us / 1_000_000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const MediaPane = forwardRef<MediaPaneHandle, MediaPaneProps>(function MediaPane(
  {
    id,
    src,
    mediaType,
    sourceKind = mediaType === 'video' ? 'mp4' : 'url',
    canvasStyle,
    variant = 'standalone',
    onEnded,
    onStateChange,
    onError,
  },
  ref,
) {
  const { theme } = useApp();
  const videoTheme = videoThemeFor(theme);
  const playerRef = useRef<MediaPlayerHandle>(null);
  const stateRef = useRef<PlayerState>('idle');
  const loadedRef = useRef(false);
  const [state, setState] = useState<PlayerState>('idle');
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [volume, setVolume] = useState(100);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(getActiveMediaId());

  useEffect(() => subscribeActiveMedia(setActiveId), []);

  // 注册到全局协调器：被别人抢走播放权时立即 stop，并标记需重载
  useEffect(() => {
    return registerMediaPlayer(id, {
      stop: () => {
        playerRef.current?.stop();
        loadedRef.current = false;
      },
    });
  }, [id]);

  const handleState = useCallback(
    (next: PlayerState) => {
      stateRef.current = next;
      setState(next);
      onStateChange?.(next);
      if (next === 'ended') onEnded?.();
    },
    [onEnded, onStateChange],
  );

  const handleError = useCallback(
    (e: PlayerErrorInfo) => {
      if (e.isAbort) return;
      const msg = e.userMessage || '媒体加载失败，请检查文件地址';
      setError(msg);
      onError?.(msg);
    },
    [onError],
  );

  useEffect(() => {
    if (state !== 'playing' && state !== 'paused' && state !== 'ready') return;
    const timer = window.setInterval(() => setStats(playerRef.current?.getStats() ?? null), 200);
    return () => window.clearInterval(timer);
  }, [state]);

  const play = useCallback(async () => {
    setError(null);
    try {
      if (stateRef.current === 'idle' || !loadedRef.current) {
        await playerRef.current?.load({ url: src, sourceKind, mediaType });
        loadedRef.current = true;
        playerRef.current?.setVolume(volume / 100);
        playerRef.current?.setRate(rate);
      }
      claimMediaPlayback(id);
      playerRef.current?.play();
    } catch (e) {
      const err = e as PlayerErrorInfo;
      const msg = err?.userMessage || '播放失败，请重试';
      setError(msg);
      onError?.(msg);
    }
  }, [id, src, sourceKind, mediaType, volume, rate, onError]);

  const pause = useCallback(() => playerRef.current?.pause(), []);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    loadedRef.current = false;
    setStats(null);
    releaseMediaPlayback(id);
  }, [id]);

  useImperativeHandle(ref, () => ({ play, pause, stop }), [play, pause, stop]);

  const onSeek = useCallback(
    (pctValue: number) => {
      const dur = info?.durationUs ?? 0;
      if (!dur) return;
      void playerRef.current?.seek(Math.round((pctValue / 100) * dur));
    },
    [info],
  );

  const onVolume = useCallback((v: number) => {
    setVolume(v);
    playerRef.current?.setVolume(v / 100);
  }, []);

  const onRate = useCallback((r: number) => {
    setRate(r);
    playerRef.current?.setRate(r);
  }, []);

  const rateOptions: SelectOption[] = [
    { value: '0.75', label: '0.75×' },
    { value: '1', label: '1×' },
    { value: '1.25', label: '1.25×' },
    { value: '1.5', label: '1.5×' },
    { value: '2', label: '2×' },
  ];

  const dur = info?.durationUs ?? 0;
  const pos = stats?.positionUs ?? 0;
  const pct = dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0;
  const isActive = activeId === id;

  const view = (
    <MediaPlayerView
      ref={playerRef}
      mediaType={mediaType}
      sourceKind={sourceKind}
      audio={{ barCount: 56, haloColor: videoTheme.accent }}
      canvasStyle={
        canvasStyle ??
        (mediaType === 'video'
          ? { width: '100%', aspectRatio: '16 / 9', borderRadius: 10 }
          : { width: '100%', height: 180, borderRadius: 10 })
      }
      autoPlay={false}
      onStateChange={handleState}
      onReady={setInfo}
      onError={handleError}
      onMediaTypeChange={() => undefined}
    />
  );

  // 视频/音频画布包一层流光玻璃框（主题色流光，随语种换肤）
  const framedView = (
    <div className="liquid-glass-frame">
      <div className="liquid-glass-inner">{view}</div>
    </div>
  );

  if (variant === 'bare') {
    return (
      <div>
        {framedView}
        {error ? (
          <p className="small" role="alert" style={{ marginTop: 6, color: 'var(--danger)' }}>{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div className="player-bar">
        <button className="btn btn-primary btn-sm" onClick={() => void play()}>▶ 播放</button>
        <button className="btn btn-sm" onClick={pause}>❚❚ 暂停</button>
        <button className="btn btn-sm" onClick={stop}>■ 停止</button>
        <span className="divider-v" />
        <span className="hint">状态：{state}</span>
        {isActive ? <span className="hint" style={{ color: 'var(--accent-deep)' }}>● 占用中</span> : null}
        <span className="spacer" />
        <Select
          value={String(rate)}
          options={rateOptions}
          onChange={(value) => onRate(Number(value))}
          label="倍速"
          size="sm"
          ariaLabel="播放倍速"
        />
      </div>

      {framedView}

      <div className="player-bar" style={{ marginTop: 10, marginBottom: 0 }}>
        <span className="hint" style={{ minWidth: 42 }}>{fmtTime(pos)}</span>
        <Slider value={pct} onChange={onSeek} disabled={!dur} ariaLabel="播放进度" />
        <span className="hint" style={{ minWidth: 42, textAlign: 'right' }}>{dur ? fmtTime(dur) : '--:--'}</span>
      </div>

      <Slider
        value={volume}
        onChange={onVolume}
        label="音量"
        display={`${volume}%`}
        ariaLabel="音量"
        style={{ marginTop: 10 }}
      />

      {error ? (
        <p className="small" role="alert" style={{ marginTop: 8, color: 'var(--danger)' }}>{error}</p>
      ) : null}
    </div>
  );
});

export default MediaPane;
