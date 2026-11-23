/**
 * 解题答疑视频专用配音：spawn scripts/edge_tts_timeline.py，拿到 mp3 + 句级边界。
 *
 * 与 edgeTts.ts 的 synthesizeLocalEdge 平行存在，绝不改动后者（朗读链路依赖它）。
 * 失败翻译成可执行中文提示；内存 LRU 缓存，避免同一句重复联网。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpstreamError } from '../lib/errors';
import { logger } from '../lib/logger';

export interface VoiceBoundary {
  text: string;
  offsetMs: number;
  durationMs: number;
}

export interface SynthWithTimelineResult {
  audio: Buffer;
  boundaries: VoiceBoundary[];
  /** 由边界累加得到的时长；边界缺失时为 0，调用方需按字数估算兜底 */
  durationMs: number;
}

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scriptPath = path.join(projectRoot, 'scripts', 'edge_tts_timeline.py');
const venvPython = path.join(projectRoot, '.voice-venv', 'bin', 'python');
const MAX_STDOUT = 24 * 1024 * 1024;
const CACHE_LIMIT = 80;

function resolvePython(): string {
  const override = process.env.EDGE_TTS_PYTHON?.trim();
  if (override) return override;
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
}

function toRateArg(rate: number): string {
  const pct = Math.round((Math.min(1.4, Math.max(0.5, rate)) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function runChild(input: string, timeoutMs: number): Promise<{ out: string; err: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePython(), [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const chunks: Buffer[] = [];
    const errs: string[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out: Buffer.concat(chunks).toString('utf8'), err: errs.join(''), code, timedOut });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_STDOUT) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errs.push(chunk.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', done);
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function explainFailure(err: string, code: number | null, timedOut: boolean): string {
  if (timedOut) return '讲解配音超时（30 秒），可稍后重试';
  const text = err.toLowerCase();
  if (text.includes('modulenotfounderror')) return '本地 edge-tts 未安装，请运行 npm run voice:setup';
  if (text.includes('403') || text.includes('handshake') || text.includes('unauthorized')) {
    return '微软 Edge 语音接口暂时不可用（403 / 握手失败），稍后重试';
  }
  return `讲解配音失败${code !== null ? `（退出码 ${code}）` : ''}${err.trim() ? `：${err.trim().split('\n').slice(-1)[0].slice(0, 140)}` : ''}`;
}

const cache = new Map<string, SynthWithTimelineResult>();

/** 合成一段旁白；相同 voice + rate + text 命中缓存。超时 30 秒 */
export async function synthesizeWithTimeline(args: {
  voice: string;
  input: string;
  rate?: number;
}): Promise<SynthWithTimelineResult> {
  const voice = args.voice.trim();
  if (!/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(voice)) {
    throw new UpstreamError(`本地 Neural 音色名不合法：${voice || '（空）'}`);
  }
  const text = args.input.trim().slice(0, 3000);
  if (!text) throw new UpstreamError('讲解旁白为空');
  const rate = toRateArg(args.rate ?? 0.92);
  const key = `${voice}|${rate}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result;
  try {
    result = await runChild(JSON.stringify({ voice, input: text, rate, boundary: 'SentenceBoundary' }), 30_000);
  } catch (err) {
    throw new UpstreamError(`启动讲解配音失败：${(err as Error).message}`);
  }
  if (result.code !== 0) {
    const message = explainFailure(result.err, result.code, result.timedOut);
    logger.warn('explain tts failed', { voice, code: result.code, err: result.err.slice(0, 200) });
    throw new UpstreamError(message, { code: result.code });
  }

  let parsed: { audioBase64: string; boundaries: VoiceBoundary[]; durationMs: number };
  try {
    parsed = JSON.parse(result.out.trim());
  } catch {
    throw new UpstreamError('讲解配音返回的数据无法解析，请稍后重试');
  }
  const audio = Buffer.from(parsed.audioBase64 ?? '', 'base64');
  if (audio.length === 0) throw new UpstreamError('讲解配音没有返回音频，可能音色已下线');

  const value: SynthWithTimelineResult = {
    audio,
    boundaries: (parsed.boundaries ?? []).filter((b) => b.durationMs > 0),
    durationMs: Math.max(0, Math.round(parsed.durationMs ?? 0)),
  };
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/** 字数估算时长（边界缺失兜底）：目标语约 4.2 字符/秒，中文约 5 */
export function estimateDurationMs(text: string, language: string): number {
  const perSec = language === 'zh' ? 5 : 4.2;
  return Math.max(2500, Math.round((text.length / perSec) * 1000));
}
