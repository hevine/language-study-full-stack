/**
 * Standalone AsrPort：支持 local-asr（本地 server.py）或 Whisper API。
 *
 * local 模式：POST http://localhost:{port}/transcribe，multipart/form-data
 * whisper-api 模式：POST https://api.openai.com/v1/audio/transcriptions
 *
 * 两个模式都顺带测一次节奏（domain/speech 的形状）：whisper 能直接给词级时间戳，
 * local-asr 只返文本，就退到声学停顿检测。测不出来返回 null —— 不拿时长除字数凑。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProsodyMeasurement } from '../../domain/speech';
import { measureProsody } from '../../services/speechTiming';
import { sanitizeTranscript } from '../../lib/transcript';
import type { AsrPort } from '../ports';
import type { LangCode } from '../types';
import { spokenUnitCount } from '../adapters/units';

export interface StandaloneAsrConfig {
  mode: 'local' | 'whisper-api';
  localPort?: number;
  apiKey?: string;
  model?: string;
}

/** audioRef 可能是文件路径或 base64；两种都收成一个字节 + 文件名 */
function readAudio(audioRef: string): { buffer: Buffer; filename: string } {
  if (fs.existsSync(audioRef)) {
    return { buffer: fs.readFileSync(audioRef), filename: path.basename(audioRef) };
  }
  return { buffer: Buffer.from(audioRef, 'base64'), filename: 'audio.wav' };
}

export function createStandaloneAsr(config: StandaloneAsrConfig): AsrPort {
  const model = config.model ?? 'whisper-1';

  async function transcribeLocal(
    audioRef: string,
    lang: LangCode,
  ): Promise<{ text: string; ms: number; confidence: number; measurement: ProsodyMeasurement | null }> {
    const port = config.localPort ?? 9880;
    const audio = readAudio(audioRef);
    const ext = path.extname(audio.filename).slice(1) || 'wav';
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audio.buffer)]), `audio.${ext}`);

    const res = await fetch(`http://localhost:${port}/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) throw new Error(`local-asr ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as { text?: string; duration?: number };
    // 本地 SenseVoice 同样会往正文里写 😌 这类情感表情
    const text = sanitizeTranscript(json.text ?? '', lang);
    const measurement = await measureProsody({
      buffer: audio.buffer,
      text,
      claimedDurationMs: json.duration ? Math.round(json.duration * 1000) : null,
      wordCount: await spokenUnitCount(text, lang),
    });
    return {
      text,
      ms: Math.round((json.duration ?? 0) * 1000),
      confidence: 0.9,
      measurement,
    };
  }

  async function transcribeWhisper(
    audioRef: string,
    lang: LangCode,
  ): Promise<{ text: string; ms: number; confidence: number; measurement: ProsodyMeasurement | null }> {
    if (!config.apiKey) throw new Error('Whisper API 模式需要 apiKey');

    const audio = readAudio(audioRef);
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audio.buffer)]), audio.filename);
    formData.append('model', model);
    // whisper-1 支持词级时间戳；拿不到就退到声学检测，不影响文本
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: formData,
    });

    if (!res.ok) throw new Error(`Whisper API ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as {
      text?: string;
      duration?: number;
      words?: Array<{ word?: string; start?: number; end?: number }>;
    };
    const text = sanitizeTranscript(json.text ?? '', lang);
    const words = (json.words ?? [])
      .map((item) => ({
        word: sanitizeTranscript(item.word ?? '', lang),
        startMs: Math.round(Number(item.start ?? 0) * 1000),
        endMs: Math.round(Number(item.end ?? 0) * 1000),
      }))
      .filter((item) => item.word && Number.isFinite(item.startMs) && item.endMs >= item.startMs);
    const measurement = await measureProsody({
      buffer: audio.buffer,
      text,
      words: words.length > 0 ? words : undefined,
      claimedDurationMs: json.duration ? Math.round(json.duration * 1000) : null,
      wordCount: await spokenUnitCount(text, lang),
    });
    return {
      text,
      ms: Math.round((json.duration ?? 0) * 1000),
      confidence: 0.95,
      measurement,
    };
  }

  return {
    async transcribe(audioRef: string, lang: LangCode = 'en') {
      if (config.mode === 'local') return transcribeLocal(audioRef, lang);
      return transcribeWhisper(audioRef, lang);
    },

    /** standalone 没有录音仓缓存：每次都从字节重新测（本地解码，不花外部调用） */
    async measure(audioRef: string, text: string, lang: LangCode = 'en') {
      const audio = readAudio(audioRef);
      return measureProsody({ buffer: audio.buffer, text, wordCount: await spokenUnitCount(text, lang) });
    },
  };
}
