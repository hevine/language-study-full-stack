/**
 * 工作台的口语输入。
 *
 * 与 hooks/useSpeaking 的分工：
 * - useSpeaking 服务「练习页作答」：浏览器实时识别 + 录音兜底，状态都是那一道题的；
 * - 这个 hook 服务「工作台提问」：只做三件事 —— 录 / 传 / 转写，产物是一段录音 id + 一份稿子。
 *   它不猜用户想做什么，稿子交回给页面填进输入框，用户自己改、自己决定发不发。
 *
 * 关键取舍：录音先落服务端再转写。
 * 麦克风权限、识别线路、网络三处都可能出问题，一次失败就让人重录是很糟的体验；
 * 先存后转，重试只花一次识别，不用重说一遍。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AgentAudio, AgentAudioSource } from '../agentTypes';

const MAX_BYTES = 25 * 1024 * 1024;
const AUDIO_EXT = /\.(webm|wav|mp3|mp4|m4a|ogg|aac|flac|amr|opus)$/i;

export interface SpeechInputState {
  recording: boolean;
  /** 录音已进行的秒数 */
  elapsed: number;
  /** 0–1 的输入电平，用来画一个活着的指示条；没在录时是 0 */
  level: number;
  /** 正在上传或转写 */
  busy: boolean;
  /** 已挂上的录音（含试听地址） */
  audio: AgentAudio | null;
  /** 本轮识别出的稿子；页面据此填充输入框 */
  transcript: string;
  error: string | null;
  supported: boolean;
  startRecord: () => Promise<void>;
  stopRecord: () => void;
  /** 录音笔 / 本地音频文件，source 用于区分「导入」与「上传」 */
  attachFile: (file: File, source?: AgentAudioSource) => Promise<void>;
  /** 转写失败后原地重试，不重新上传 */
  retryTranscribe: () => Promise<void>;
  remove: () => void;
  clearError: () => void;
}

interface Options {
  lang: string;
  /** 转写成功时回调：页面拿去填输入框，并记录「这段稿是转写来的」 */
  onTranscript?: (text: string, audio: AgentAudio) => void;
}

function extOf(blob: Blob, name?: string): string {
  const fromName = name ? /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() : undefined;
  if (fromName) return fromName;
  if (blob.type.includes('mp4') || blob.type.includes('m4a')) return 'm4a';
  if (blob.type.includes('wav')) return 'wav';
  if (blob.type.includes('mpeg')) return 'mp3';
  return 'webm';
}

/** 音频时长：容器元数据永远比「用户说了多久」准，读不到就返回 null（不强报 0） */
function readDurationMs(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const url = URL.createObjectURL(file);
    const el = document.createElement('audio');
    const finish = (value: number | null) => {
      URL.revokeObjectURL(url);
      el.onloadedmetadata = null;
      el.onerror = null;
      resolve(value);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : null);
    el.onerror = () => finish(null);
    // 某些格式（amr / 部分 m4a）浏览器解不出元数据，5 秒后放弃，交给服务端时长
    window.setTimeout(() => finish(null), 5000);
    el.src = url;
  });
}

export function useSpeechInput({ lang, onTranscript }: Options): SpeechInputState {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<AgentAudio | null>(null);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterTimerRef = useRef<number | null>(null);
  /** 上一段录音：换新的一段前要把它从服务端删掉，不然每录一次留一份垃圾 */
  const currentAudioRef = useRef<AgentAudio | null>(null);
  const aliveRef = useRef(true);
  /** 每次新的转写请求自增；慢请求回来时若已过期就丢弃，避免旧稿覆盖新稿 */
  const tokenRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const supported =
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  const stopMeter = () => {
    if (meterTimerRef.current !== null) {
      window.clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    setLevel(0);
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const discardAudio = useCallback((target: AgentAudio | null) => {
    if (!target) return;
    void api.agentAudioDelete(target.audioId).catch(() => undefined);
    if (currentAudioRef.current?.audioId === target.audioId) currentAudioRef.current = null;
  }, []);

  /** 上传 + 转写。两步失败分开报：上传失败是网络/体积，转写失败多半是识别线路没配好 */
  const pushAudio = useCallback(
    async (blob: Blob, meta: { name: string; durationMs: number | null; source: AgentAudioSource }) => {
      const token = ++tokenRef.current;
      setBusy(true);
      setError(null);
      let uploaded: AgentAudio | null = null;
      try {
        uploaded = await api.agentAudioUpload(blob, {
          lang,
          name: meta.name,
          durationMs: meta.durationMs ?? undefined,
          source: meta.source,
        });
        if (!aliveRef.current || token !== tokenRef.current) return;

        const previous = currentAudioRef.current;
        currentAudioRef.current = uploaded;
        setAudio(uploaded);
        if (previous) discardAudio(previous);

        const result = await api.agentAudioTranscribe(uploaded.audioId, lang);
        if (!aliveRef.current || token !== tokenRef.current) return;
        const text = result.transcript.trim();
        if (text) {
          setTranscript(text);
          onTranscriptRef.current?.(text, result.audio);
        } else {
          setError('这段录音没识别出内容（太短或环境太吵）。可以重录，也可以直接把文字贴进来。');
        }
      } catch (err) {
        if (!aliveRef.current || token !== tokenRef.current) return;
        const reason = (err as Error).message || '处理失败';
        if (!uploaded) {
          setError(`${reason}。录音没能上传，请检查网络后重试，或直接把文字贴进来。`);
        } else {
          // 音频已经在服务端了：说清楚这一点，重试按钮才有意义
          setError(`${reason}。录音已保存，可以点「重新转写」，也可以直接改稿子或手打。`);
        }
      } finally {
        if (aliveRef.current && token === tokenRef.current) setBusy(false);
      }
    },
    [discardAudio, lang],
  );

  const stopRecord = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();

    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopMeter();
    releaseStream();
    setRecording(false);
  }, []);

  const startRecord = useCallback(async () => {
    if (!supported) {
      setError('这个浏览器不支持网页录音，请用 Chrome / Edge，或上传一段录音文件。');
      return;
    }
    if (recorderRef.current) stopRecord();
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
        typeof MediaRecorder.isTypeSupported === 'function' ? MediaRecorder.isTypeSupported(type) : false,
      );
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
        const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : null;
        if (blob.size < 1500) {
          setError('这段太短了，几乎没录到声音。说完整一句再停。');
          return;
        }
        void pushAudio(blob, {
          name: `speaking.${extOf(blob)}`,
          durationMs,
          source: 'recorder',
        });
      };

      recorder.start(250);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);

      // 计时：口播一遍 40 秒很常见，没有秒表就不知道自己在录多久
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
      }, 200);

      // 电平：一个会动的指示条比「正在录音」四个字更能说明麦克风真的收到了声音
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const audioCtx = new Ctx();
          audioCtxRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const data = new Uint8Array(analyser.frequencyBinCount);
          meterTimerRef.current = window.setInterval(() => {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i += 1) {
              const v = (data[i] - 128) / 128;
              sum += v * v;
            }
            setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
          }, 90);
        }
      } catch {
        // 电平只是装饰，拿不到不影响录音
      }
    } catch {
      releaseStream();
      setError('没拿到麦克风权限。请在浏览器地址栏允许麦克风，或上传一段录音文件。');
    }
  }, [pushAudio, stopRecord, supported]);

  const attachFile = useCallback(
    async (file: File, source: AgentAudioSource = 'file') => {
      if (file.size > MAX_BYTES) {
        setError('这个文件超过 25MB 了，截取要练的那一段再上传。');
        return;
      }
      if (!file.type.startsWith('audio/') && !AUDIO_EXT.test(file.name)) {
        setError('这不是音频文件。支持 webm / m4a / mp3 / wav / ogg 等常见格式。');
        return;
      }
      if (recorderRef.current) stopRecord();
      setError(null);
      const durationMs = await readDurationMs(file);
      await pushAudio(file, { name: file.name, durationMs, source });
    },
    [pushAudio, stopRecord],
  );

  const retryTranscribe = useCallback(async () => {
    const target = currentAudioRef.current;
    if (!target) {
      setError('没有可重试的录音，先录一段或上传一个文件。');
      return;
    }
    const token = ++tokenRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.agentAudioTranscribe(target.audioId, lang);
      if (!aliveRef.current || token !== tokenRef.current) return;
      const text = result.transcript.trim();
      if (text) {
        setTranscript(text);
        onTranscriptRef.current?.(text, result.audio);
      } else {
        setError('还是没识别出内容。换一段更清楚的录音，或者直接把文字贴进来。');
      }
    } catch (err) {
      if (!aliveRef.current || token !== tokenRef.current) return;
      setError((err as Error).message);
    } finally {
      if (aliveRef.current && token === tokenRef.current) setBusy(false);
    }
  }, [lang]);

  const remove = useCallback(() => {
    if (recorderRef.current) stopRecord();
    tokenRef.current += 1;
    discardAudio(currentAudioRef.current);
    setAudio(null);
    setTranscript('');
    setError(null);
    setBusy(false);
    setElapsed(0);
  }, [discardAudio, stopRecord]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      tokenRef.current += 1;
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      recorderRef.current = null;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      stopMeter();
      releaseStream();
    };
  }, []);

  return {
    recording,
    elapsed,
    level,
    busy,
    audio,
    transcript,
    error,
    supported,
    startRecord,
    stopRecord,
    attachFile,
    retryTranscribe,
    remove,
    clearError,
  };
}
