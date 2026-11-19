import { useCallback, useEffect, useRef, useState } from 'react';

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

export interface SpeakingController {
  recognitionSupported: boolean;
  recorderSupported: boolean;
  active: boolean;
  elapsed: number;
  finalText: string;
  interim: string;
  confidence: number | null;
  audioUrl: string | null;
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

  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
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

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    clearTimer();
    setActive(false);
    setInterim('');
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setInterim('');

    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('当前浏览器不支持语音转写，请改用 Chrome / Edge，或在下方直接输入你的口语稿。');
      return;
    }

    // 录音（可选）：浏览器不支持时跳过，不影响转写
    if (recorderSupported) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        chunksRef.current = [];
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          if (chunksRef.current.length === 0) return;
          const blob = new Blob(chunksRef.current, { type: chunksRef.current[0].type || 'audio/webm' });
          setAudioUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
          });
        };
        recorder.start();
        recorderRef.current = recorder;
      } catch {
        setError('麦克风不可用（录音将跳过，仍可继续语音转写）。');
      }
    }

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
        setFinalText((prev) => (prev ? `${prev} ${finalChunk.trim()}` : finalChunk.trim()));
        if (lastConfidence !== null) setConfidence(lastConfidence);
      }
      setInterim(interimChunk);
    };

    recognition.onerror = (event) => {
      setError(ERROR_TEXT[event.error] ?? `语音识别出错：${event.error}`);
    };

    recognition.onend = () => {
      setActive(false);
      setInterim('');
      clearTimer();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setActive(true);
      startedAtRef.current = Date.now();
      setElapsed(0);
      clearTimer();
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
      }, 500);
    } catch {
      setError('语音识别启动失败，请刷新页面后重试。');
      setActive(false);
    }
  }, [lang, recorderSupported]);

  const reset = useCallback(() => {
    stop();
    setFinalText('');
    setInterim('');
    setConfidence(null);
    setElapsed(0);
    setError(null);
  }, [stop]);

  const clearAudio = useCallback(() => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  useEffect(() => {
    return () => {
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
    error,
    start,
    stop,
    reset,
    clearAudio,
  };
}
