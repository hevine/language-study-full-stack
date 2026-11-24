/**
 * MediaPort 的进程内实现：TTS 与讲解视频。
 *
 * 两条完全不同的链路，接在同一个 Port 下：
 * - TTS 是「同步可完成的小活」，几百毫秒到几秒，带磁盘缓存，重复请求零成本；
 * - 讲解视频是「异步长作业」，要写脚本、逐镜配音、对时间轴、拼轨，几分钟起步。
 *   所以它只能是 start/poll —— 硬做成同步 Promise 会把 SSE 拖成假死。
 *
 * 这里不实现任何生成逻辑，只做协议适配：生成归 services/，本文件负责
 * 「按 Port 的语义调用它们，并把结果翻译成 Port 承诺的形状」。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { createExplainJob, getExplainJob } from '../../services/explainVideo';
import { EDGE_VOICES, synthesizeLocalEdge } from '../../services/edgeTts';
import type { MediaPort } from '../ports';
import type { LangCode } from '../types';

const MEDIA_ROOT = path.join(path.dirname(env.dbPath), 'agent', 'media');

function ttsDir(): string {
  const dir = path.join(MEDIA_ROOT, 'tts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultVoice(lang: LangCode): string {
  return EDGE_VOICES[lang]?.[0]?.voiceId ?? 'en-US-AvaNeural';
}

function clampRate(rate?: number): number {
  if (!rate || !Number.isFinite(rate)) return 1;
  return Math.min(1.4, Math.max(0.5, rate));
}

export function createMediaPort(): MediaPort {
  return {
    async tts(input) {
      const started = Date.now();
      const text = input.text.trim().slice(0, 3000);
      if (!text) throw new Error('朗读内容为空');

      const voice = input.voice?.trim() || defaultVoice(input.lang);
      const rate = clampRate(input.rate);

      // 缓存键与 edgeTts 的内部缓存保持一致口径：同音色同语速同文本 = 同一份音频
      const hash = crypto.createHash('sha1').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 20);
      const file = path.join(ttsDir(), `${hash}.mp3`);
      const audioRef = `/api/agent/media/tts/${hash}.mp3`;

      if (fs.existsSync(file)) {
        return { audioRef, ms: Date.now() - started, cached: true };
      }

      const buffer = await synthesizeLocalEdge({ voice, input: text, rate });
      fs.writeFileSync(file, buffer);
      logger.info('agent tts 生成', { voice, chars: text.length, bytes: buffer.length });
      return { audioRef, ms: Date.now() - started, cached: false };
    },

    explainVideo: {
      async start(input) {
        const started = Date.now();
        const job = createExplainJob({
          articleId: input.articleId,
          depth: input.depth,
          coach: input.coach,
        });
        // 命中缓存时 createExplainJob 直接返回一个已完成的 job，不消耗 token
        const reused = job.stage === 'done' || Boolean(job.cacheHit);
        return {
          jobId: job.id,
          videoId: job.videoId,
          reused,
          ms: Date.now() - started,
        };
      },

      async poll(input) {
        const job = getExplainJob(input.jobId);
        if (!job) {
          return { state: 'error' as const, progress: 0, detail: '作业已过期或不存在', error: 'job_not_found' };
        }
        // 用户主动取消：不是失败，也不该显示成「还在跑」
        if (job.canceled && job.stage !== 'done') {
          return { state: 'canceled' as const, progress: job.progress, detail: job.detail };
        }
        if (job.stage === 'error') {
          return { state: 'error' as const, progress: job.progress, detail: job.detail, error: job.error ?? '生成失败' };
        }
        if (job.stage === 'done' && job.videoId) {
          return {
            state: 'done' as const,
            progress: 100,
            detail: job.detail,
            videoId: job.videoId,
            videoRef: `/api/explain-videos/${job.videoId}`,
            tokens: job.tokens?.totalTokens ?? 0,
          };
        }
        return { state: 'running' as const, progress: job.progress, detail: job.detail };
      },
    },
  };
}

/** 给 /api/agent/media/tts/:file 路由用：只允许 tts 目录下的 mp3，禁止路径穿越 */
export function resolveTtsFile(name: string): string | null {
  if (!/^[a-f0-9]{20}\.mp3$/.test(name)) return null;
  const file = path.join(ttsDir(), name);
  return fs.existsSync(file) ? file : null;
}
