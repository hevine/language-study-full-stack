/**
 * 朗读播放器：精读分段 / 长难句 / 精听共用。
 * 音色来自「设置 → 音色库」按场景的分配，切换后立即对所有页面生效。
 */
import { useState } from 'react';
import type { ReadingSegment, VoiceScene } from '../types';
import { useVoicePlayer } from '../hooks/useVoicePlayer';
import { useVoiceSystem } from '../hooks/useVoiceSystem';
import { SCENE_LABEL } from '../hooks/voiceUtils';
import Dropdown, { type DropdownOption } from '../components/Dropdown';

const RATES = [0.7, 0.85, 0.9, 1, 1.15];

export default function ReadingPlayer({
  segments,
  language,
  scene = 'article',
}: {
  segments: ReadingSegment[];
  language: 'en' | 'ja' | 'ko';
  scene?: VoiceScene;
}) {
  const player = useVoicePlayer(scene);
  const { data, assign } = useVoiceSystem();
  const [showTranslation, setShowTranslation] = useState(true);

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
    </div>
  );
}
