/**
 * Agent 录音仓：口语场景的「音频原件」。
 *
 * 为什么单独存一份，而不是转写完就把字节丢掉：
 * 1. 转写必须可复核 —— 用户改过转写稿之后，还得能回听原音，否则评的是稿子不是口语；
 * 2. 发音类评分（phonology）要读波形，不能只吃文本；
 * 3. 录音笔文件往往一次导一大段，转写失败时不该逼用户重新导一次。
 *
 * 所以约定：**上传一次 → 拿到 audioId → 转写可重试，run 里只带 audioId**。
 * 字节落盘，元信息存同名 json；audioId 是唯一入口，客户端拿不到真实路径。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import type { Language } from '../domain/language';
import type { ProsodyMeasurement } from '../domain/speech';
import { logger } from '../lib/logger';

/** 口语单次作答一般十几秒；25MB 足够长录音，也避免异常请求 abuse */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const AUDIO_SOURCES = ['recorder', 'file', 'recorder-pen'] as const;

export type AgentAudioSource = (typeof AUDIO_SOURCES)[number];

/** 用户看得懂来源：界面上「录的」和「录音笔导入」要区分，评的是不同场景 */
export const AUDIO_SOURCE_LABEL: Record<AgentAudioSource, string> = {
  recorder: '网页录音',
  file: '上传文件',
  'recorder-pen': '录音笔导入',
};

export interface AgentAudioMeta {
  audioId: string;
  /** 原始文件名，给界面显示 */
  name: string;
  ext: string;
  bytes: number;
  /** 时长以客户端上报为准（服务端不解析容器），未知就是 null */
  durationMs: number | null;
  source: AgentAudioSource;
  lang: string;
  createdAt: string;
  /** 试听地址；同源可直接 <audio src> */
  url: string;
}

const AUDIO_ID_RE = /^aud_[a-z0-9]{6,24}$/;
const ALLOWED_EXT = /^(webm|wav|mp3|mp4|m4a|ogg|aac|flac|amr|opus)$/i;

function audioDir(): string {
  const dir = path.join(path.dirname(env.dbPath), 'agent', 'audio');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileOf(audioId: string, ext: string): string {
  return path.join(audioDir(), `${audioId}.${ext}`);
}

function metaPath(audioId: string): string {
  return path.join(audioDir(), `${audioId}.json`);
}

/** 节奏测量结果单独存一份：转写是一次性的，但报告回看时还要能解释「语速怎么算的」 */
function prosodyPath(audioId: string): string {
  return path.join(audioDir(), `${audioId}.prosody.json`);
}

function urlOf(audioId: string): string {
  return `/api/agent/audio/${audioId}`;
}

/**
 * 清理过期录音。
 *
 * 录音是一次性的中间件：run trace 里只留 audioId，学员真正回听的是产物里的那一段。
 * 不清理的话，一次 5 分钟的录音笔导入就 25MB，几周就能把磁盘吃满。
 * 保留 7 天：够回看一周内的报告，又不至于囤积。
 */
const AUDIO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

function pruneExpired(force = false): void {
  const now = Date.now();
  // 每次上传都扫一遍目录太贵；一小时最多一次
  if (!force && now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(audioDir());
  } catch {
    return;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    // 节奏测量跟着录音一起走，不单独参与过期判断
    if (entry.endsWith('.prosody.json')) continue;
    const file = path.join(audioDir(), entry);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs < AUDIO_TTL_MS) continue;
      const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentAudioMeta;
      fs.rmSync(file, { force: true });
      const id = meta?.audioId ?? entry.replace(/\.json$/, '');
      if (meta?.ext) fs.rmSync(fileOf(id, meta.ext), { force: true });
      fs.rmSync(prosodyPath(id), { force: true });
      removed += 1;
    } catch {
      // 单条清理失败不影响上传
    }
  }
  if (removed > 0) logger.info('清理过期录音', { removed });
}

/** 只允许常见音频扩展名；其余统一按 webm 收，避免把奇怪后缀透给上游识别服务 */
export function safeAudioExt(name: string | undefined, mime?: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const match = /\.([a-z0-9]{2,5})$/i.exec(base);
  if (match && ALLOWED_EXT.test(match[1])) return match[1].toLowerCase();
  if (mime?.includes('mp4') || mime?.includes('m4a')) return 'm4a';
  if (mime?.includes('wav')) return 'wav';
  if (mime?.includes('mpeg') || mime?.includes('mp3')) return 'mp3';
  return 'webm';
}

export function saveAgentAudio(
  buffer: Buffer,
  input: {
    name?: string;
    lang?: string;
    durationMs?: number;
    source?: AgentAudioSource;
    mime?: string;
  } = {},
): AgentAudioMeta {
  if (buffer.length === 0) throw new Error('没有收到录音内容');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('录音文件超过 25MB 上限');

  const audioId = `aud_${randomBytes(8).toString('hex')}`;
  const ext = safeAudioExt(input.name, input.mime);
  const durationMs =
    typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs > 0
      ? Math.round(input.durationMs)
      : null;
  const source = input.source && AUDIO_SOURCES.includes(input.source) ? input.source : 'recorder';

  const meta: AgentAudioMeta = {
    audioId,
    name: (input.name ?? `recording.${ext}`).slice(0, 160),
    ext,
    bytes: buffer.length,
    durationMs,
    source,
    lang: input.lang ?? 'en',
    createdAt: new Date().toISOString(),
    url: urlOf(audioId),
  };

  fs.writeFileSync(fileOf(audioId, ext), buffer);
  fs.writeFileSync(metaPath(audioId), JSON.stringify(meta, null, 2));
  pruneExpired();
  logger.info('agent 录音已保存', { audioId, bytes: meta.bytes, source, durationMs });
  return meta;
}

export function readAgentAudioMeta(audioId: string): AgentAudioMeta | null {
  if (!AUDIO_ID_RE.test(audioId)) return null;
  try {
    const raw = fs.readFileSync(metaPath(audioId), 'utf8');
    const meta = JSON.parse(raw) as AgentAudioMeta;
    // 元信息在、字节不在（清理过磁盘）时也当不存在，别给一个放不出声的地址
    if (!fs.existsSync(fileOf(audioId, meta.ext))) return null;
    return meta;
  } catch {
    return null;
  }
}

/** 给转写用：拿到字节与文件名 */
export function readAgentAudioBytes(audioId: string): { meta: AgentAudioMeta; buffer: Buffer; fileName: string } | null {
  const meta = readAgentAudioMeta(audioId);
  if (!meta) return null;
  try {
    return {
      meta,
      buffer: fs.readFileSync(fileOf(audioId, meta.ext)),
      fileName: `speaking.${meta.ext}`,
    };
  } catch {
    return null;
  }
}

/** 转写结果同时更新时长：客户端报的时长常常拿不到（部分浏览器无 duration），以服务端为准更可信 */
export function patchAgentAudioDuration(audioId: string, durationMs: number): void {
  const meta = readAgentAudioMeta(audioId);
  if (!meta || durationMs <= 0) return;
  const next = { ...meta, durationMs: Math.round(durationMs) };
  try {
    fs.writeFileSync(metaPath(audioId), JSON.stringify(next, null, 2));
  } catch {
    // 更新失败不影响转写结果
  }
}

export function deleteAgentAudio(audioId: string): boolean {
  const meta = readAgentAudioMeta(audioId);
  if (!meta) return false;
  try {
    fs.rmSync(fileOf(audioId, meta.ext), { force: true });
    fs.rmSync(metaPath(audioId), { force: true });
    fs.rmSync(prosodyPath(audioId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 节奏测量的缓存。
 *
 * 为什么缓存而不是每次重算：界面在用户停止录音时就转写了一次（那条路已经拿到时间戳），
 * run 里如果再算一遍，同一段音频要解码两次、甚至重新识别一次。
 * 缓存按 audioId 落在录音旁边，跟着录音一起过期。
 */
/** 字段一扩充就要 +1：旧缓存缺字段，当作未命中重算，别让老录音永远少一个指标 */
const PROSODY_CACHE_VERSION = 2;

export function readAgentProsody(audioId: string): ProsodyMeasurement | null {
  if (!AUDIO_ID_RE.test(audioId)) return null;
  try {
    const raw = fs.readFileSync(prosodyPath(audioId), 'utf8');
    const parsed = JSON.parse(raw) as ProsodyMeasurement;
    if (!parsed || typeof parsed.durationMs !== 'number') return null;
    if (parsed.v !== PROSODY_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAgentProsody(audioId: string, measurement: ProsodyMeasurement): void {
  if (!AUDIO_ID_RE.test(audioId)) return;
  try {
    fs.writeFileSync(
      prosodyPath(audioId),
      JSON.stringify({ ...measurement, v: PROSODY_CACHE_VERSION }, null, 2),
    );
  } catch (err) {
    // 缓存失败不影响本次评测：调用方手里已经有测量结果了
    logger.warn('节奏测量缓存写入失败', { audioId, error: (err as Error).message });
  }
}

export function languageOf(value: string | undefined): Language {
  return value === 'ja' || value === 'ko' ? value : 'en';
}
