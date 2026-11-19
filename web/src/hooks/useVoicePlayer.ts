/**
 * 统一朗读入口：单词、长难句、精读、听力都通过它播放。
 *
 * - browser 音色：复用 useSpeech 的队列预读 + 断点重连，按「场景 → 音色」解析出的
 *   系统声音播放；换机器时按名字关键词重新匹配，不会突然没声音。
 * - cloud 音色：服务端代理合成音频，逐条串行播放，API Key 永远不出后端。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { VoiceItem, VoiceScene } from '../types';
import { useSpeech } from './useSpeech';
import { BCP47, matchSystemVoice, SAMPLE_TEXT } from './voiceUtils';
import { useVoiceSystem } from './useVoiceSystem';

export interface VoicePlayer {
  speak: (text: string, id?: string, onDone?: () => void) => void;
  play: (items: Array<{ text: string; id: string }>, onDone?: () => void) => void;
  stop: () => void;
  playing: boolean;
  speakingId: string | null;
  supported: boolean;
  currentVoice: VoiceItem | null;
  /** 用户在设置里为自己这个语种定制的试听语料 */
  sampleText: string;
  rate: number;
  setRate: (rate: number) => void;
  error: string | null;
}

export function useVoicePlayer(scene: VoiceScene): VoicePlayer {
  const system = useVoiceSystem();
  const { language, data, systemVoices } = system;
  const voice = system.resolve(scene);
  const bcp47 = data?.bcp47 ?? BCP47[language];
  const speech = useSpeech(bcp47);

  const [cloudPlaying, setCloudPlaying] = useState(false);
  const [cloudSpeakingId, setCloudSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tokenRef = useRef(0);

  const rate = data?.prefs.globalRate ?? voice?.rate ?? 0.9;
  const sampleText = data?.prefs.sampleText || SAMPLE_TEXT[language];

  /** 把音色库里的 browser 配置落到当前机器真实存在的系统声音上 */
  const matched = useMemo(
    () => (voice?.provider === 'browser' ? matchSystemVoice(voice, systemVoices, bcp47) : null),
    [voice, systemVoices, bcp47],
  );

  useEffect(() => {
    if (matched && speech.voiceURI !== matched.voiceURI) {
      speech.setVoiceURI(matched.voiceURI);
    }
  }, [matched, speech.voiceURI, speech.setVoiceURI]);

  useEffect(() => {
    speech.setRate(rate);
  }, [rate, speech.setRate]);

  useEffect(
    () => () => {
      tokenRef.current += 1;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audioRef.current = null;
      }
    },
    [],
  );

  const stop = useCallback(() => {
    tokenRef.current += 1;
    speech.stop();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audioRef.current = null;
    }
    setCloudPlaying(false);
    setCloudSpeakingId(null);
  }, [speech.stop]);

  const playCloud = useCallback(
    async (voiceId: string, items: Array<{ text: string; id: string }>, onDone?: () => void) => {
      stop();
      const token = ++tokenRef.current;
      setCloudPlaying(true);
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (token !== tokenRef.current) break;
        setCloudSpeakingId(item.id);
        try {
          const url = await api.synthesizeVoice(voiceId, item.text, language, rate);
          if (token !== tokenRef.current) {
            URL.revokeObjectURL(url);
            break;
          }
          await new Promise<void>((resolve) => {
            const audio = new Audio(url);
            audioRef.current = audio;
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              URL.revokeObjectURL(url);
              if (audioRef.current === audio) audioRef.current = null;
              resolve();
            };
            audio.onended = finish;
            audio.onerror = finish;
            void audio.play().catch(finish);
          });
        } catch (err) {
          // 本地 Edge 是非官方接口，哪天 403 了不能让朗读直接哑掉：
          // 从失败的那一条开始，自动接回系统音色继续播完。
          const reason = (err as Error).message;
          const fallback = data?.voices.find((entry) => entry.provider === 'browser');
          if (fallback) {
            const found = matchSystemVoice(fallback, systemVoices, bcp47);
            if (found) speech.setVoiceURI(found.voiceURI);
            setError(`${reason.slice(0, 90)}；已自动改用系统音色「${fallback.name}」`);
            speech.play(items.slice(index), () => {
              if (token === tokenRef.current) {
                setCloudPlaying(false);
                setCloudSpeakingId(null);
                onDone?.();
              }
            });
            return;
          }
          setError(reason);
          break;
        }
      }
      if (token === tokenRef.current) {
        setCloudPlaying(false);
        setCloudSpeakingId(null);
        onDone?.();
      }
    },
    [language, rate, stop, data, systemVoices, bcp47, speech],
  );

  const play = useCallback(
    (items: Array<{ text: string; id: string }>, onDone?: () => void) => {
      setError(null);
      if (items.length === 0) return;
      if (voice?.provider === 'cloud') {
        void playCloud(voice.id, items, onDone);
        return;
      }
      speech.play(items, onDone);
    },
    [voice, speech.play, playCloud],
  );

  const speak = useCallback(
    (text: string, id = 'solo', onDone?: () => void) => play([{ text, id }], onDone),
    [play],
  );

  const setRate = useCallback(
    (value: number) => {
      void system.savePrefs({ globalRate: value }).catch((err: Error) => setError(err.message));
    },
    [system],
  );

  const isCloud = voice?.provider === 'cloud';
  return {
    speak,
    play,
    stop,
    playing: isCloud ? cloudPlaying : speech.playing,
    speakingId: isCloud ? cloudSpeakingId : speech.speakingId,
    supported: isCloud ? true : speech.supported,
    currentVoice: voice,
    sampleText,
    rate,
    setRate,
    error,
  };
}
