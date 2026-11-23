import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
}

interface RecognitionResultList {
  length: number;
  [index: number]: RecognitionResult;
}

interface RecognitionEventLike {
  resultIndex: number;
  results: RecognitionResultList;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const ERROR_TEXT: Record<string, string> = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试，或直接手打转写稿。',
  'service-not-allowed': '浏览器未启用语音识别服务，请改用 Chrome / Edge，或手打转写稿。',
  'no-speech': '没有识别到语音，请靠近麦克风再试一次。',
  network: '语音识别需要联网，当前网络不可用。',
  aborted: '识别已中断。',
};

/** BCP47（en-US / ja-JP / ko-KR）→ 服务端 ASR 需要的 ISO 语种 */
function asrLanguageOf(bcp47: string): string {
  const base = bcp47.split('-')[0]?.toLowerCase();
  return base === 'ja' || base === 'ko' ? base : 'en';
}

export interface SpeakingController {
  recognitionSupported: boolean;
  recorderSupported: boolean;
  active: boolean;
  elapsed: number;
  finalText: string;
  interim: string;
  confidence: number | null;
  audioUrl: string | null;
  /** 服务端识别出的最终文本（按目标语言），录音停止后填入 */
  transcript: string;
  /** 正在上传录音并等待服务端识别 */
  transcribing: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  clearAudio: () => void;
}

export function useSpeaking(lang: string): SpeakingController {
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  /** 本轮录音的原始音频，停止后上传 ASR */
  const blobRef = useRef<Blob | null>(null);
  /** 浏览器实时识别的累积文本（ref 形式，供 ASR 失败时兜底读取，避开闭包过期） */
  const finalTextRef = useRef('');
  /** 只在最新一轮录音完成后才采纳识别结果，避免竞态 */
  const transcribeTokenRef = useRef(0);
  const aliveRef = useRef(true);

  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionSupported = typeof window !== 'undefined' && getRecognitionCtor() !== null;
  const recorderSupported =
    typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  /** 上传录音字节给服务端转写；结果写入 transcript，由页面填进作答框 */
  const runTranscribe = useCallback(async (blob: Blob, token: number) => {
    const language = asrLanguageOf(lang);
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('wav') ? 'wav' : 'webm';
    setTranscribing(true);
    setError(null);
    try {
      const result = await api.transcribeAudio(blob, language, `speaking.${ext}`);
      if (!aliveRef.current || token !== transcribeTokenRef.current) return;
      const text = result.text.trim();
      if (text) setTranscript(text);
    } catch (err) {
      if (!aliveRef.current || token !== transcribeTokenRef.current) return;
      const reason = (err as Error).message || '转写失败';
      // 服务端识别不可用时，退回浏览器实时识别已拿到的文本，尽量不让用户白录一次
      const browserText = finalTextRef.current.trim();
      if (browserText) {
        setTranscript(browserText);
        setError(`${reason}；已用浏览器实时识别结果填充，可手动修改。`);
      } else {
        setError(`${reason}；请在「设置 → 音色与朗读」配置语音识别线路，或手动输入转写稿。`);
      }
    } finally {
      if (aliveRef.current && token === transcribeTokenRef.current) setTranscribing(false);
    }
  }, [lang]);

  const stop = useCallback(() => {
    // P1-10：先摘掉回调再 stop，避免 onend/onerror 在停止过程中改状态；同时重置引用
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.stop();
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    clearTimer();
    setActive(false);
    setInterim('');
  }, []);

  const start = useCallback(async () => {
    // P1-10：并发保护——连点/重复 start 时先停掉上一轮，杜绝双实例抢麦克风
    if (recognitionRef.current || recorderRef.current) stop();
    setError(null);
    setInterim('');
    setTranscript('');
    setFinalText('');
    finalTextRef.current = '';
    setConfidence(null);

    const token = ++transcribeTokenRef.current;
    let started = false;

    // 1) 录音（主路径）：录到的音频在停止后上传服务端 ASR，得到按目标语言的文本。
    //    这是国内环境也能用的可靠路径——不依赖浏览器的 Google 识别服务。
    if (recorderSupported) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        chunksRef.current = [];
        blobRef.current = null;
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          if (chunksRef.current.length === 0) return;
          const blob = new Blob(chunksRef.current, { type: chunksRef.current[0].type || 'audio/webm' });
          blobRef.current = blob;
          setAudioUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
          });
          // 录音结束即触发服务端转写
          void runTranscribe(blob, token);
        };
        recorder.start();
        recorderRef.current = recorder;
        started = true;
      } catch {
        setError('无法访问麦克风，请检查浏览器权限后重试；也可以在下方手动输入转写稿。');
      }
    }

    // 2) 浏览器实时识别（增强）：只用于「说话中」的实时预览，不作为最终转写稿，
    //    最终文本一律以服务端 ASR 结果为准，避免两套结果重复/打架。
    const Ctor = getRecognitionCtor();
    if (Ctor) {
      const recognition = new Ctor();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        let finalChunk = '';
        let interimChunk = '';
        let lastConfidence: number | null = null;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const alternative = result[0];
          if (!alternative) continue;
          if (result.isFinal) {
            finalChunk += alternative.transcript;
            if (alternative.confidence > 0) lastConfidence = alternative.confidence;
          } else {
            interimChunk += alternative.transcript;
          }
        }
        if (finalChunk) {
          const merged = finalTextRef.current
            ? `${finalTextRef.current} ${finalChunk.trim()}`
            : finalChunk.trim();
          finalTextRef.current = merged;
          setFinalText(merged);
        }
        setInterim(interimChunk);
        if (lastConfidence !== null) setConfidence(lastConfidence);
      };

      recognition.onerror = (event) => {
        // 实时预览失败不打断录音与服务端转写，仅在提示里说明
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setError(ERROR_TEXT[event.error] ?? `实时识别不可用：${event.error}`);
        }
      };

      recognition.onend = () => {
        setInterim('');
        // 录音仍在继续时不要把界面切回「未录音」
        if (!recorderRef.current) setActive(false);
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
        started = true;
      } catch {
        // 浏览器识别起不来也没关系，服务端转写仍可用
      }
    }

    if (!started) {
      setError(recorderSupported
        ? '语音识别未能启动，请在下方手动输入转写稿。'
        : '当前浏览器不支持录音，请用 Chrome / Edge，或在下方手动输入转写稿。');
      setActive(false);
      return;
    }

    setActive(true);
    startedAtRef.current = Date.now();
    setElapsed(0);
    clearTimer();
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 500);
  }, [lang, recorderSupported, runTranscribe, stop]);

  const reset = useCallback(() => {
    stop();
    transcribeTokenRef.current += 1;
    setTranscript('');
    setTranscribing(false);
    setFinalText('');
    finalTextRef.current = '';
    setInterim('');
    setConfidence(null);
    setElapsed(0);
    setError(null);
    blobRef.current = null;
    // P1-10：reset 一并清掉录音 blob，避免培训页面残留上一段音频
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [stop]);

  const clearAudio = useCallback(() => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      transcribeTokenRef.current += 1;
      recognitionRef.current?.abort();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      clearTimer();
    };
  }, []);

  return {
    recognitionSupported,
    recorderSupported,
    active,
    elapsed,
    finalText,
    interim,
    confidence,
    audioUrl,
    transcript,
    transcribing,
    error,
    start,
    stop,
    reset,
    clearAudio,
  };
}
