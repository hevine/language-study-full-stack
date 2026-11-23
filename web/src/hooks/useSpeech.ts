import { useCallback, useEffect, useRef, useState } from 'react';

/** 系统自带的玩具音色（macOS 等），机器味极重，直接排除 */
const NOVELTY =
  /bells|bad news|good news|jester|organ|superstar|trinoids|wobble|zarvox|albert|fred|junior|kathy|ralph|princess|eddie|boo\b|bruce|agnes|deranged|hysterical|cellos|bubbles|bahh|drift|sandwich|grandma|grandpa|rocko|shelley|eddy|flo|nels|reed|bunk|evil|dummy/i;

/** 口碑较好的拟真音色名单（各平台） */
const PREFERRED =
  /aria|jenny|emma|guy|davis|andrew|brian|ava|allison|samantha|serena|vanessa|joanna|sonia|libby|natasha|clara|ryan|michelle|aky|kyoko|o-ran|kenji|otoya|luca|amélie|amelie|nora|yuna/i;

/** 只保留前 15 个优质音色：足够挑，又不至于下拉框长到难选 */
const MAX_VOICES = 15;

type VoiceTier = 'neural' | 'google' | 'enhanced' | 'standard';

function voiceTier(voice: SpeechSynthesisVoice): VoiceTier {
  if (/natural|online\b|neural/i.test(voice.name)) return 'neural';
  if (/^google /i.test(voice.name)) return 'google';
  if (/premium|enhanced|siri/i.test(voice.name)) return 'enhanced';
  return 'standard';
}

/** 推荐等级中文标注，让用户知道这个音色好在哪 */
const TIER_TAG: Record<VoiceTier, string> = {
  neural: '神经网络',
  google: 'Google',
  enhanced: '增强',
  standard: '标准',
};

/** 同语种下不同地区的偏好顺序：美音最贴近托福，其次是英音、澳音 */
function regionBonus(lang: string, target: string): number {
  const voice = lang.replace('_', '-').toLowerCase();
  const base = target.slice(0, 2).toLowerCase();
  if (!voice.startsWith(base)) return -40;
  if (voice === target.toLowerCase()) return 30;
  if (base === 'en') {
    if (voice === 'en-gb') return 24;
    if (voice === 'en-au') return 16;
    return 4;
  }
  return 10;
}

function scoreVoice(voice: SpeechSynthesisVoice, targetLang: string): number {
  const name = voice.name;
  const tier = voiceTier(voice);
  let score = 0;

  if (tier === 'neural') score += 130;
  else if (tier === 'google') score += 100;
  else if (tier === 'enhanced') score += 85;

  if (PREFERRED.test(name)) score += 55;
  if (NOVELTY.test(name)) score -= 400;

  score += regionBonus(voice.lang, targetLang);
  // 本地音色不依赖网络，但联网音色质量明显更高，只给很小的补偿
  if (voice.localService) score += 5;
  return score;
}

/** 下拉框里显示的名字，去掉平台冗长的前后缀 */
function prettyName(voice: SpeechSynthesisVoice): string {
  return voice.name
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s*-\s*English \((United States|United Kingdom|Australia)\)/i, '')
    .replace(/\s*\(Natural\)/i, ' Natural')
    .replace(/\s*Online$/i, '')
    .trim();
}

/** 音色分组：考试音色（考场播报风）/ 声优风（自然音色的风格拟仿）/ 系统音色 */
export type VoiceGroup = 'exam' | 'star' | 'system';

/** 拟真音色 → 悦耳人设标签（按性别/气质拟仿知名声优与播音员风格，非真人录音） */
const STAR_PERSONAS: Array<{ match: RegExp; persona: string }> = [
  { match: /kyoko|sayaka|nanami|yuna|o-ran|mei-jia|japanese\(japan\)/i, persona: '清冷知性 · 女主播气质' },
  { match: /otoya|kenji|kazuo|hattori|rei\b/i, persona: '温润磁性 · 男旁白气质' },
  {
    match: /aria|jenny|emma|ava|serena|allison|samantha|sonia|libby|joanna|natasha|clara|vanessa|michelle|ava/i,
    persona: '悦耳暖声 · 新闻主播气质',
  },
  { match: /andrew|brian|guy|davis|ryan|daniel|luca|reed/i, persona: '沉稳叙事 · 纪录片旁白气质' },
];

function starPersona(name: string): string | null {
  for (const item of STAR_PERSONAS) {
    if (item.match.test(name)) return item.persona;
  }
  return null;
}

/**
 * 三类分组规则：
 * 1) 声优风：拟真度最高的 Premium/Natural 音色，挂上悦耳人设标签；
 * 2) 考试音色：与考试语区完全一致（en-US / ja-JP）的稳定播报声；
 * 3) 系统音色：其余地区或普通音色。
 */
function classifyVoice(
  voice: SpeechSynthesisVoice,
  tier: VoiceTier,
  targetLang: string,
): { group: VoiceGroup; persona: string | null } {
  const name = voice.name;
  const lang = voice.lang.replace('_', '-').toLowerCase();
  const target = targetLang.toLowerCase();

  if (tier === 'neural' || tier === 'enhanced') {
    return { group: 'star', persona: starPersona(name) ?? '悦耳拟真音色' };
  }
  if (lang === target) return { group: 'exam', persona: null };
  return { group: 'system', persona: null };
}

export interface VoiceOption {
  uri: string;
  label: string;
  recommended: boolean;
  tag: string;
  group: VoiceGroup;
  persona: string | null;
}

interface QueueItem {
  text: string;
  id: string;
}

const RATE_KEY = 'wb-speech-rate';
const voiceKey = (lang: string) => `wb-voice:${lang}`;

function loadRate(): number {
  if (typeof localStorage === 'undefined') return 0.85;
  const saved = Number(localStorage.getItem(RATE_KEY));
  return Number.isFinite(saved) && saved >= 0.5 && saved <= 1.4 ? saved : 0.85;
}

/** 取消后立刻 speak 在 Chrome 上会吞字/卡顿，留一点喘息时间 */
const RESTART_DELAY = 90;

export function useSpeech(lang: string) {
  const [rate, setRateState] = useState<number>(loadRate);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [supported] = useState(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
  );
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [voiceURI, setVoiceURIState] = useState<string | null>(null);

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const rateRef = useRef(rate);
  const queueRef = useRef<QueueItem[]>([]);
  const cursorRef = useRef(0);
  const inflightRef = useRef(0);
  const cancelledRef = useRef(true);
  const finishedRef = useRef(true);
  const onDoneRef = useRef<(() => void) | undefined>(undefined);
  const timerRef = useRef<number | null>(null);

  rateRef.current = rate;

  /** 音色列表：去重 + 排序 + 截断，只在 voiceschanged 时重建 */
  useEffect(() => {
    if (!supported) return;
    const target = lang.toLowerCase();
    let disposed = false;
    let lastSignature = '';

    const build = () => {
      if (disposed) return;
      const all = window.speechSynthesis.getVoices();
      if (all.length === 0) return;

      const seen = new Set<string>();
      const ranked = all
        .filter((voice) => voice.lang.toLowerCase().startsWith(target.slice(0, 2)))
        .map((voice) => ({ voice, score: scoreVoice(voice, target) }))
        .filter((item) => item.score > -100)
        .sort((a, b) => b.score - a.score)
        .filter((item) => {
          const key = `${prettyName(item.voice).toLowerCase()}|${item.voice.lang.toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      const top = ranked.slice(0, MAX_VOICES);
      const signature = top.map((item) => item.voice.voiceURI).join('|') + `#${voiceURI ?? ''}`;
      if (signature === lastSignature) return;
      lastSignature = signature;

      if (top.length === 0) {
        setVoiceOptions([]);
        return;
      }

      const savedURI = localStorage.getItem(voiceKey(lang));
      // 上次选的音色不在前十时，也保留它，避免用户的选择凭空消失
      const savedVoice = savedURI ? all.find((voice) => voice.voiceURI === savedURI) : undefined;
      const savedInTop = top.find((item) => item.voice.voiceURI === savedURI);

      const options: VoiceOption[] = top.map((item, index) => {
        const { group, persona } = classifyVoice(item.voice, voiceTier(item.voice), target);
        return {
          uri: item.voice.voiceURI,
          label: prettyName(item.voice),
          recommended: index < 3 || item.score >= 115,
          tag: TIER_TAG[voiceTier(item.voice)],
          group,
          persona,
        };
      });

      if (savedVoice && !savedInTop) {
        const { group, persona } = classifyVoice(savedVoice, voiceTier(savedVoice), target);
        options.push({
          uri: savedVoice.voiceURI,
          label: `${prettyName(savedVoice)}（已选）`,
          recommended: false,
          tag: TIER_TAG[voiceTier(savedVoice)],
          group,
          persona,
        });
      }

      const chosen = savedInTop?.voice ?? top[0].voice;
      voiceRef.current = chosen;
      setVoiceOptions(options);
      setVoiceURIState(chosen.voiceURI);
    };

    build();
    // Chrome 首次 getVoices() 常为空，voiceschanged 也未必触发，补几次轮询
    const timers = [80, 240, 600, 1200, 2400].map((delay) => window.setTimeout(build, delay));
    window.speechSynthesis.addEventListener('voiceschanged', build);

    return () => {
      disposed = true;
      timers.forEach((id) => window.clearTimeout(id));
      window.speechSynthesis.removeEventListener('voiceschanged', build);
    };
    // voiceURI 故意不进依赖：选音色不该重建列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, supported]);

  const setRate = useCallback((value: number) => {
    rateRef.current = value;
    setRateState(value);
    localStorage.setItem(RATE_KEY, String(value));
  }, []);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const stop = useCallback(() => {
    if (!supported) return;
    cancelledRef.current = true;
    finishedRef.current = true;
    clearTimer();
    queueRef.current = [];
    cursorRef.current = 0;
    inflightRef.current = 0;
    onDoneRef.current = undefined;
    window.speechSynthesis.cancel();
    setSpeakingId(null);
    setPlaying(false);
  }, [supported]);

  /** 保持队列里有 2 句预读，避免句与句之间出现空档与卡顿 */
  const pump = useCallback(() => {
    if (!supported || cancelledRef.current) return;
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();

    while (inflightRef.current < 2 && cursorRef.current < queueRef.current.length) {
      const item = queueRef.current[cursorRef.current];
      cursorRef.current += 1;
      inflightRef.current += 1;

      const utterance = new SpeechSynthesisUtterance(item.text);
      const voice = voiceRef.current;
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = lang;
      }
      utterance.rate = rateRef.current;

      let settled = false;
      const settle = (restart: boolean) => {
        if (settled) return;
        settled = true;
        inflightRef.current = Math.max(0, inflightRef.current - 1);
        if (cancelledRef.current) return;
        if (restart) pump();
        if (cursorRef.current >= queueRef.current.length && inflightRef.current === 0) {
          if (!finishedRef.current) {
            finishedRef.current = true;
            setSpeakingId(null);
            setPlaying(false);
            const done = onDoneRef.current;
            onDoneRef.current = undefined;
            done?.();
          }
        }
      };

      utterance.onstart = () => {
        if (cancelledRef.current) return;
        setSpeakingId(item.id);
        setPlaying(true);
      };
      utterance.onend = () => settle(true);
      utterance.onerror = (event) => {
        // canceled / interrupted 是主动停止触发的，不算异常。
        // 关键：必须走 settle(false) 而不是自己减 inflight——
        //  1) settled 守卫避免紧接着补发的 onend 二次递减、提前触发 onDone；
        //  2) 外部 speechSynthesis.cancel() 时 cancelledRef 仍为 false，
        //     settle 会把 playing 复位并回调 onDone，避免 ExamTake 停止按钮卡死。
        if (event.error === 'canceled' || event.error === 'interrupted') {
          settle(false);
          return;
        }
        settle(true);
      };

      synth.speak(utterance);
    }
  }, [lang, supported]);

  const play = useCallback(
    (items: QueueItem[], onDone?: () => void) => {
      if (!supported || items.length === 0) return;

      cancelledRef.current = true;
      clearTimer();
      window.speechSynthesis.cancel();

      queueRef.current = items;
      cursorRef.current = 0;
      inflightRef.current = 0;
      finishedRef.current = false;
      onDoneRef.current = onDone;

      // 给语音引擎一点时间清空上一段，避免开头被吞
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        cancelledRef.current = false;
        pump();
      }, RESTART_DELAY);
    },
    [pump, supported],
  );

  /** 单句/试听 */
  const speak = useCallback(
    (text: string, id: string, onDone?: () => void) => play([{ text, id }], onDone),
    [play],
  );

  const setVoiceURI = useCallback(
    (uri: string) => {
      const found = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === uri);
      if (!found) return;
      const wasPlaying = !cancelledRef.current;
      voiceRef.current = found;
      setVoiceURIState(uri);
      localStorage.setItem(voiceKey(lang), uri);
      // 播放中换音色：先停下，否则引擎切换会出怪声
      if (wasPlaying) stop();
    },
    [lang, stop],
  );

  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return {
    rate,
    setRate,
    speak,
    play,
    stop,
    speakingId,
    playing,
    supported,
    voiceOptions,
    voiceURI,
    setVoiceURI,
  };
}
