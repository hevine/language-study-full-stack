/**
 * 统一朗读入口：单词、长难句、精读、听力都通过它播放。
 *
 * - browser 音色：复用 useSpeech 的队列预读 + 断点重连，按「场景 → 音色」解析出的
 *   系统声音播放；换机器时按名字关键词重新匹配，不会突然没声音。
 * - cloud 音色：服务端代理合成音频，逐条串行播放，API Key 永远不出后端。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { claimSpeechPlayback, registerSpeechStop } from '@waiyubaodian/ui-kit';
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

  // P0-5：把自己登记为全局朗读源，媒体 / 讲解视频开播时可借此抢占出声权
  useEffect(() => registerSpeechStop(stop), [stop]);

  const playCloud = useCallback(
    async (voiceId: string, items: Array<{ text: string; id: string }>, onDone?: () => void) => {
      stop();
      const token = ++tokenRef.current;
      setCloudPlaying(true);

      /**
       * 音色 id 过期自愈：刷新页面 / 换账号后，内存里的快照可能还是上一份
       * （例如游客快照），此时合成会 404「音色不存在或不属于当前语种」。
       * 重拉一次音色库，按「场景绑定 → 默认 → 第一条」重新解析，从失败处续播。
       */
      const recover = async (): Promise<VoiceItem | null> => {
        const fresh = await system.reload();
        if (!fresh) return null;
        const assignedId = fresh.assignments[scene];
        const next =
          (assignedId ? fresh.voices.find((item) => item.id === assignedId) : undefined) ??
          fresh.voices.find((item) => item.isDefault) ??
          fresh.voices[0] ??
          null;
        return next && next.id !== voiceId ? next : null;
      };

      const run = async (
        currentId: string,
        rest: Array<{ text: string; id: string }>,
        allowRecover: boolean,
      ): Promise<void> => {
        let failed = false;
        for (let index = 0; index < rest.length; index += 1) {
          const item = rest[index];
          if (token !== tokenRef.current) return;
          setCloudSpeakingId(item.id);
          try {
            const url = await api.synthesizeVoice(currentId, item.text, language, rate);
            if (token !== tokenRef.current) {
              URL.revokeObjectURL(url);
              return;
            }
            // 播放成功/失败用布尔值区分：失败要能被 catch 捕获并触发回退，
            // 不能像过去那样 onerror 也当成"正常播完"静默跳过。
            const ok = await new Promise<boolean>((resolve) => {
              const audio = new Audio(url);
              audioRef.current = audio;
              let settled = false;
              const finish = (success: boolean) => {
                if (settled) return;
                settled = true;
                URL.revokeObjectURL(url);
                if (audioRef.current === audio) audioRef.current = null;
                resolve(success);
              };
              audio.onended = () => finish(true);
              audio.onerror = () => finish(false);
              void audio.play().catch(() => finish(false));
            });
            if (!ok) throw new Error('音频播放失败');
          } catch (err) {
            if (token !== tokenRef.current) return;
            // 1) 先尝试自愈：音色换了账号 / 被删掉 / 快照过期
            if (allowRecover && err instanceof ApiError && err.status === 404) {
              const next = await recover();
              if (token !== tokenRef.current) return;
              if (next) {
                setError(null);
                if (next.provider === 'cloud') {
                  await run(next.id, rest.slice(index), false);
                } else {
                  const found = matchSystemVoice(next, systemVoices, bcp47);
                  if (found) speech.setVoiceURI(found.voiceURI);
                  speech.play(rest.slice(index), () => {
                    if (token === tokenRef.current) {
                      setCloudPlaying(false);
                      setCloudSpeakingId(null);
                      onDone?.();
                    }
                  });
                }
                return;
              }
            }
            // 2) 本地 Edge 是非官方接口，哪天 403 了不能让朗读直接哑掉：
            //    从失败的那一条开始，自动接回系统音色继续播完。
            const reason = (err as Error).message;
            const fallback = data?.voices.find((entry) => entry.provider === 'browser');
            if (fallback) {
              const found = matchSystemVoice(fallback, systemVoices, bcp47);
              if (found) speech.setVoiceURI(found.voiceURI);
              setError(`${reason.slice(0, 90)}；已自动改用系统音色「${fallback.name}」`);
              speech.play(rest.slice(index), () => {
                if (token === tokenRef.current) {
                  setCloudPlaying(false);
                  setCloudSpeakingId(null);
                  onDone?.();
                }
              });
              return;
            }
            // 没有可用回退：这是一次失败，绝不能触发 onDone 让调用方误判为"播完了"
            setError(reason);
            failed = true;
            break;
          }
        }
        if (token === tokenRef.current) {
          setCloudPlaying(false);
          setCloudSpeakingId(null);
          if (!failed) onDone?.();
        }
      };

      await run(voiceId, items, true);
    },
    [language, rate, stop, data, systemVoices, bcp47, speech, scene, system.reload],
  );

  const play = useCallback(
    (items: Array<{ text: string; id: string }>, onDone?: () => void) => {
      setError(null);
      if (items.length === 0) return;
      // P0-5：朗读开播先抢占全局出声权，停掉正在播放的媒体 / 讲解视频
      claimSpeechPlayback();
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
