/**
 * 朗读播放器：精读分段 / 长难句 / 精听共用。
 * 音色来自「设置 → 音色库」按场景的分配，切换后立即对所有页面生效。
 *
 * 两个标签页：
 *  - 文字朗读：原有 TTS 链路（useVoicePlayer），一字未改；
 *  - 真人媒体：播放真实音视频文件（MediaPane），与 TTS 零耦合。
 * 只有传入 media prop 或用户主动体验演示素材时才挂载媒体面板，现有调用点零改动。
 */
import { lazy, Suspense, useId, useRef, useState } from 'react';
import type { MediaType, SourceKind } from '@waiyubaodian/hevc-player';

// SDK 内联 WASM 体积大，媒体面板按需加载，避免拖慢精读页首屏
const MediaPane = lazy(() => import('../player/MediaPane'));
import type { MediaPaneHandle } from '../player/MediaPane';
import type { ReadingSegment, VoiceScene } from '../types';
import { useVoicePlayer } from '../hooks/useVoicePlayer';
import { useVoiceSystem } from '../hooks/useVoiceSystem';
import { SCENE_LABEL } from '../hooks/voiceUtils';
import { Dropdown, type DropdownOption } from '@waiyubaodian/ui-kit';

const RATES = [0.7, 0.85, 0.9, 1, 1.15];

/** 业务素材：有真人音视频时由调用方传入；字段与 SDK 的媒体类型对齐 */
export interface ReadingMedia {
  src: string;
  mediaType: MediaType;
  sourceKind?: SourceKind;
  title?: string;
}

const DEMO_MEDIA: Record<'video' | 'audio', ReadingMedia> = {
  video: { src: '/media/demo-hevc.mp4', mediaType: 'video', sourceKind: 'mp4', title: '演示 · H265 视频' },
  audio: { src: '/media/demo-audio.wav', mediaType: 'audio', sourceKind: 'url', title: '演示 · 纯音频' },
};

export default function ReadingPlayer({
  segments,
  language,
  scene = 'article',
  media,
}: {
  segments: ReadingSegment[];
  language: 'en' | 'ja' | 'ko';
  scene?: VoiceScene;
  media?: ReadingMedia;
}) {
  const player = useVoicePlayer(scene);
  const { data, assign } = useVoiceSystem();
  const [showTranslation, setShowTranslation] = useState(true);
  const [tab, setTab] = useState<'voice' | 'media'>('voice');
  const [demo, setDemo] = useState<'video' | 'audio' | null>(null);
  // useId 保证同屏多个 ReadingPlayer 的协调器 id 唯一（P0-1 现场就是同屏两实例）
  const mediaId = useId().replace(/:/g, '');
  const mediaRef = useRef<MediaPaneHandle>(null);

  const activeMedia: ReadingMedia | null = media ?? (demo ? DEMO_MEDIA[demo] : null);

  const switchTab = (next: 'voice' | 'media') => {
    if (next === tab) return;
    // P0-5：两个方向都显式停掉当前通道，避免 TTS 与媒体同时出声。
    // 只靠卸载协调器的 unregister 不够及时，这里主动 stop 更确定。
    if (tab === 'voice') player.stop();
    else mediaRef.current?.stop();
    setTab(next);
  };

  const playAll = () => {
    player.play(segments.map((segment, index) => ({ text: segment.text, id: `seg-${index}` })));
  };

  const playOne = (index: number) => {
    player.speak(segments[index].text, `seg-${index}`);
  };

  const speakingSegment = player.speakingId?.startsWith('seg-') ? player.speakingId : null;
  const previewing = player.speakingId === 'voice-preview';
  const voices = data?.voices ?? [];
  const currentId = data?.assignments[scene] ?? voices.find((item) => item.isDefault)?.id ?? '';

  const voiceOptions: DropdownOption<string>[] = [
    { value: '', label: '跟随默认音色' },
    ...voices.map((item) => ({
      value: item.id,
      label: `${item.isDefault ? '★ ' : ''}${item.name}`,
      sublabel: item.provider === 'cloud' ? '云端音色' : '本机音色',
    })),
  ];

  return (
    <div>
      <div className="reader-tabs" role="tablist" aria-label="播放方式">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'voice'}
          className={tab === 'voice' ? 'active' : ''}
          onClick={() => switchTab('voice')}
        >
          文字朗读
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'media'}
          className={tab === 'media' ? 'active' : ''}
          onClick={() => switchTab('media')}
        >
          真人媒体
        </button>
      </div>

      {tab === 'media' ? (
        <div style={{ marginTop: 10 }}>
          {activeMedia ? (
            <Suspense fallback={<div className="hint">正在加载播放器…</div>}>
              <MediaPane
                ref={mediaRef}
                id={`reading-${mediaId}`}
                src={activeMedia.src}
                mediaType={activeMedia.mediaType}
                sourceKind={activeMedia.sourceKind}
              />
            </Suspense>
          ) : (
            <div className="card card-pad" style={{ marginBottom: 10 }}>
              <div className="section-title">当前材料暂无真人音视频</div>
              <p className="small muted" style={{ marginTop: -2, marginBottom: 12 }}>
                材料尚未配置音频 / 视频文件，文字内容仍可用「文字朗读」收听。想先体验媒体播放器，可选一段演示素材：
              </p>
              <div className="player-bar" style={{ marginBottom: 0 }}>
                <button className="btn btn-sm" onClick={() => setDemo('video')}>🎬 演示视频</button>
                <button className="btn btn-sm" onClick={() => setDemo('audio')}>🎵 演示音频</button>
                {demo ? (
                  <button className="btn btn-sm btn-ghost" onClick={() => setDemo(null)}>清除演示</button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="player-bar">
            <button className="btn btn-primary btn-sm" onClick={playAll} disabled={!player.supported}>
              ▶ 全文连读
            </button>
            <button className="btn btn-sm" onClick={player.stop} disabled={!player.supported || !player.playing}>
              停止
            </button>

            <span className="divider-v" />

            <span className="hint">{SCENE_LABEL[scene]} · 音色</span>
            <Dropdown
              value={currentId}
              options={voiceOptions}
              onChange={(id) => void assign({ [scene]: id || null })}
              ariaLabel={`${SCENE_LABEL[scene]} 音色`}
              trigger={({ open, selected, toggle }) => (
                <button
                  type="button"
                  className={`select-field${open ? ' open' : ''}`}
                  onClick={toggle}
                  aria-haspopup="listbox"
                  aria-expanded={open}
                >
                  <span className="sf-label">{selected ? selected.label : currentId || '跟随默认音色'}</span>
                  <svg className="caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            />
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => player.speak(player.sampleText, 'voice-preview')}
              disabled={!player.supported}
              title="念一句你在设置里保存的试听语料"
            >
              {previewing ? '试听中…' : '试听'}
            </button>

            <span className="divider-v" />

            <span className="hint">语速</span>
            <div className="rate-group">
              {RATES.map((value) => (
                <button
                  key={value}
                  className={player.rate === value ? 'active' : ''}
                  onClick={() => player.setRate(value)}
                >
                  {value}×
                </button>
              ))}
            </div>

            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setShowTranslation((value) => !value)}>
              {showTranslation ? '隐藏译文' : '显示译文'}
            </button>
          </div>

          {player.error ? (
            <div className="banner banner-danger" style={{ marginBottom: 12 }}>{player.error}</div>
          ) : null}

          {!player.supported ? (
            <div className="banner banner-danger" style={{ marginBottom: 12 }}>
              当前浏览器不支持语音合成，建议使用 Chrome / Edge / Safari 的最新版本；也可以在「设置 → 音色库」里配置云端 TTS 音色。
            </div>
          ) : null}

          {player.currentVoice ? (
            <div className="hint" style={{ marginBottom: 10 }}>
              正在用「{player.currentVoice.name}」{player.currentVoice.persona ? `（${player.currentVoice.persona}）` : ''}。
              想换更悦耳的声音、添加/移除音色或改这句试听语料，到「设置 → 音色库」；移除音色不会改动系统里安装的声音。
            </div>
          ) : null}

          {segments.map((segment, index) => {
            const playing = speakingSegment === `seg-${index}`;
            return (
              <div key={index} className={`segment${playing ? ' playing' : ''}`}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div className="segment-text">{segment.text}</div>
                    {showTranslation && segment.translation ? (
                      <div className="segment-trans">{segment.translation}</div>
                    ) : null}
                    {segment.tips && segment.tips.length > 0 ? (
                      <div className="tips">
                        {segment.tips.map((tip, tipIndex) => (
                          <span key={tipIndex} className="tip">
                            {tip}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="seg-actions">
                    <button
                      className={`icon-btn${playing ? ' active' : ''}`}
                      onClick={() => (playing ? player.stop() : playOne(index))}
                      title="朗读这一句"
                      disabled={!player.supported}
                    >
                      {playing ? '❚❚' : '▶'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
