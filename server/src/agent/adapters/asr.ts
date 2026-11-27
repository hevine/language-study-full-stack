/**
 * AsrPort 的进程内实现：把「录音 id」翻成主项目已有的识别链路。
 *
 * 主项目早有一条 OpenAI 兼容的转写号池（services/asr.ts：多线路、失败自动换线、Key 不出后端）。
 * 这里不重复造识别，只做三件事：
 * - 把 audioId 解析成字节（录音仓 services/agentAudio.ts）；
 * - 把结果翻译成 Port 承诺的形状，让 core/ 不知道录音存在哪、走哪家识别；
 * - 顺带测一次节奏（speechTiming.ts），因为识别与测量用的是同一份字节。
 */
import { transcribeAudio } from '../../services/asr';
import { languageOf, readAgentAudioBytes, readAgentProsody, writeAgentProsody } from '../../services/agentAudio';
import { measureProsody } from '../../services/speechTiming';
import { logger } from '../../lib/logger';
import type { ProsodyMeasurement } from '../../domain/speech';
import type { AsrPort } from '../ports';
import { spokenUnitCount } from './units';

export function createAsrPort(): AsrPort {
  return {
    async transcribe(audioRef, lang = 'en') {
      const audio = readAgentAudioBytes(audioRef);
      if (!audio) {
        // 录音仓是磁盘态：进程重启后仍在，但被清理过就真的没了 —— 说清楚，别让人反复重试
        throw new Error('这段录音已经不在了（可能过了清理期），重新录一段或直接把文字贴进来');
      }

      const started = Date.now();
      const result = await transcribeAudio(audio.buffer, languageOf(lang), audio.fileName, { withTiming: true });
      const ms = Date.now() - started;

      // 识别线路给了时间戳就用它；没给就退到声学检测。两条都不通就返回 null，
      // 上层据此把「发音/节奏」标为未测，而不是拿字数除时长算个假语速。
      const measurement = await measureProsody({
        buffer: audio.buffer,
        text: result.text,
        words: result.words,
        segments: result.segments,
        claimedDurationMs: result.durationMs ?? audio.meta.durationMs,
        // 日语按モーラ计数：语速单位是拍，不是词。数不出来就别假装测到了
        wordCount: await spokenUnitCount(result.text, lang),
      });
      if (measurement) writeAgentProsody(audioRef, measurement);

      logger.info('agent asr 转写完成', {
        audioRef,
        line: result.line,
        model: result.model,
        chars: result.text.length,
        ms,
        words: result.words?.length ?? 0,
        prosody: measurement?.source ?? 'none',
      });

      return {
        text: result.text,
        ms,
        // 兼容接口基本不返置信度，这里给名义值；界面不把它当分数展示
        confidence: 0.9,
        measurement,
      };
    },

    async measure(audioRef, text, lang = 'en') {
      // 缓存命中就不再解码：界面上停止录音时已经转过一次，时间戳跟着一起存下来了
      const cached = readAgentProsody(audioRef);
      if (cached) return cached;

      const audio = readAgentAudioBytes(audioRef);
      if (!audio) return null;

      const measurement = await measureProsody({
        buffer: audio.buffer,
        text,
        claimedDurationMs: audio.meta.durationMs,
        wordCount: await spokenUnitCount(text, lang),
      });
      if (measurement) writeAgentProsody(audioRef, measurement);
      if (!measurement) {
        logger.info('节奏测量不可用（无时间戳且解码失败），本次报告不含实测语速', { audioRef });
      }
      return measurement;
    },
  };
}

export type { ProsodyMeasurement };
