/**
 * 口语输入条：录一段 / 导一个录音笔文件 / 什么都不用直接打字。
 *
 * 为什么要三入口而不是只放一个麦克风：
 * - 台式机没麦、会议室不方便出声、录音笔里已经录好一整段 —— 这三种情况都很常见；
 * - 口语评估真正的输入是「转写稿」，录音只是拿到稿子的其中一条路。
 *   所以稿子永远落在输入框里、可改：识别错了用户能纠正，而不是被迫接受。
 *
 * 界面上的诚实点：
 * - 说话时给电平与秒数 —— 麦克风没收到声音时必须一眼看出来，否则用户会对着空气说 20 秒；
 * - 录音先存后转，转写失败说「录音已保存」，重试按钮才不是骗人的；
 * - 纯文本路径明说「流利度按文本推测」，不假装是录音实测。
 */
import { useEffect, useRef } from 'react';
import { AudioPlayer } from '@waiyubaodian/ui-kit';
import { useSpeechInput } from '../../hooks/useSpeechInput';
import type { AgentAudio } from '../../agentTypes';

interface Props {
  lang: string;
  onTranscript: (text: string) => void;
  onAudioChange: (audio: AgentAudio | null) => void;
  disabled?: boolean;
}

const SOURCE_LABEL: Record<AgentAudio['source'], string> = {
  recorder: '网页录音',
  file: '上传文件',
  'recorder-pen': '录音笔导入',
};

function formatSeconds(ms: number | null): string {
  if (!ms || ms <= 0) return '未知时长';
  const total = Math.round(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss} 秒`;
}

export default function SpeechInput({ lang, onTranscript, onAudioChange, disabled }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  const speech = useSpeechInput({
    lang,
    onTranscript: (text) => onTranscript(text),
  });

  // 录音换了就同步给父组件：run 只需要一个 audioId，界面不需要知道字节在哪。
  // 必须放在 effect 里 —— 渲染期间回调父组件的 setState 会变成「渲染中更新别人」。
  useEffect(() => {
    onAudioChange(speech.audio);
  }, [speech.audio, onAudioChange]);

  const busy = speech.busy;
  const canRecord = !disabled && !busy;

  return (
    <div className={`speech-bar${speech.recording ? ' is-recording' : ''}`}>
      <div className="speech-bar-main">
        {speech.recording ? (
          <button className="speech-rec is-live" onClick={speech.stopRecord} type="button">
            <span className="speech-rec-dot" aria-hidden="true" />
            停止并转写
            <b>{speech.elapsed}s</b>
          </button>
        ) : (
          <button
            className="speech-rec"
            type="button"
            disabled={!canRecord}
            onClick={() => void speech.startRecord()}
            title={speech.supported ? '用麦克风录一段，停下就会转写' : '这个浏览器不支持网页录音，改用上传文件'}
          >
            <span className="speech-rec-dot" aria-hidden="true" />
            {speech.audio ? '重录一段' : '录一段'}
          </button>
        )}

        {speech.recording ? (
          <span className="speech-meter" title="麦克风电平：条不动说明没收到声音">
            <i style={{ transform: `scaleX(${Math.max(0.02, speech.level)})` }} />
          </span>
        ) : null}

        <button
          className="speech-upload"
          type="button"
          disabled={disabled || busy || speech.recording}
          onClick={() => fileRef.current?.click()}
          title="支持 webm / m4a / mp3 / wav / ogg，单条 25MB 以内"
        >
          导入录音笔文件
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.m4a,.amr,.opus"
          className="speech-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // 清空 value：同一个文件连选两次也要能触发
            event.target.value = '';
            if (file) void speech.attachFile(file, 'recorder-pen');
          }}
        />

        <span className="speech-hint hint">
          {speech.recording
            ? '说完点「停止并转写」；录音会先存下来再识别，失败了不用重说'
            : '没有条件录音？直接在上面打字，一样能评（流利度按文本推测）'}
        </span>
      </div>

      {busy ? (
        <p className="speech-status">
          <span className="speech-spinner" aria-hidden="true" />
          正在上传并转写…录音先落盘再识别，这一步失败也不用重录
        </p>
      ) : null}

      {speech.audio && !busy ? (
        <div className="speech-audio">
          <span className="speech-audio-tag">{SOURCE_LABEL[speech.audio.source]}</span>
          <span className="speech-audio-name" title={speech.audio.name}>
            {speech.audio.name}
          </span>
          <span className="hint">{formatSeconds(speech.audio.durationMs)}</span>
          <AudioPlayer src={speech.audio.url} label="原音" />
          <div className="speech-audio-actions">
            <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void speech.retryTranscribe()}>
              重新转写
            </button>
            <button className="btn btn-sm" type="button" onClick={speech.remove}>
              移除
            </button>
          </div>
        </div>
      ) : null}

      {speech.error ? (
        <div className="speech-error">
          <span>{speech.error}</span>
          <div className="speech-error-actions">
            {speech.audio ? (
              <button className="btn btn-sm" type="button" onClick={() => void speech.retryTranscribe()}>
                重新转写
              </button>
            ) : null}
            <button className="btn btn-sm" type="button" onClick={speech.clearError}>
              知道了
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
