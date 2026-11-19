/**
 * 本地 Edge Neural TTS 通道。
 *
 * 为什么是「内置」而不是独立代理进程：本项目是本机单用户应用，多一个常驻进程/端口
 * 就多一处会忘掉启动的地方。这里由服务端直接 spawn 一个 Python 子进程合成 mp3，
 * 音色记录里用 `local://edge` 标识，随 npm start 一起可用，不起端口、不落临时文件。
 *
 * 仍然保留标准 OpenAI 兼容通道：baseUrl 填 http(s) 地址时走 voiceCatalog 的 fetch 逻辑，
 * 所以用户也可以改用外部的 openai-edge-tts 容器。
 *
 * 注意：Edge TTS 是浏览器「大声朗读」用的非官方接口，微软随时可能调整鉴权导致 403。
 * 因此所有失败都会翻译成可执行的中文提示，前端另有自动降级到系统音色的兜底。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from '../domain/language';
import { UpstreamError } from '../lib/errors';
import { logger } from '../lib/logger';

export const LOCAL_EDGE_BASE = 'local://edge';
/** 占位 Key：让前端「已配置」状态正常，合成时并不真的用到外部密钥 */
export const LOCAL_EDGE_KEY = 'local-edge-tts';
export const LOCAL_EDGE_MODEL = 'edge-tts';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scriptPath = path.join(projectRoot, 'scripts', 'edge_tts_synth.py');
const venvPython = path.join(projectRoot, '.voice-venv', 'bin', 'python');
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const CACHE_LIMIT = 60;

export interface EdgeVoicePreset {
  name: string;
  persona: string;
  voiceId: string;
  tags: string[];
  rate: number;
}

/** 每个语种各挑一女一男的母语 Neural 音色，严格按 language 落库 */
export const EDGE_VOICES: Record<Language, EdgeVoicePreset[]> = {
  en: [
    {
      name: 'Ava · 本地美式女声',
      persona: '清亮自然 · 母语级美音，适合作精读与精听',
      voiceId: 'en-US-AvaNeural',
      tags: ['本地 Neural', '女声', '美音'],
      rate: 0.9,
    },
    {
      name: 'Andrew · 本地美式男声',
      persona: '温润沉稳 · 母语级美音，适合长难句与旁白',
      voiceId: 'en-US-AndrewNeural',
      tags: ['本地 Neural', '男声', '美音'],
      rate: 0.9,
    },
  ],
  ja: [
    {
      name: '七海 · 本地日语女声',
      persona: '清澈标准 · 日语母语播音，JLPT 听解友好',
      voiceId: 'ja-JP-NanamiNeural',
      tags: ['本地 Neural', '女声', 'JLPT'],
      rate: 0.88,
    },
    {
      name: '圭太 · 本地日语男声',
      persona: '平稳清晰 · 日语母语男声，适合新闻与长文',
      voiceId: 'ja-JP-KeitaNeural',
      tags: ['本地 Neural', '男声', 'JLPT'],
      rate: 0.88,
    },
  ],
  ko: [
    {
      name: '善熙 · 本地韩语女声',
      persona: '柔和标准 · 韩语母语播音，TOPIK 听解友好',
      voiceId: 'ko-KR-SunHiNeural',
      tags: ['本地 Neural', '女声', 'TOPIK'],
      rate: 0.88,
    },
    {
      name: '仁俊 · 本地韩语男声',
      persona: '干净沉稳 · 韩语母语男声，适合长难句',
      voiceId: 'ko-KR-InJoonNeural',
      tags: ['本地 Neural', '男声', 'TOPIK'],
      rate: 0.88,
    },
  ],
};

export interface EdgeTtsStatus {
  available: boolean;
  python: string;
  version: string | null;
  hint: string;
}

export function isLocalEdge(baseUrl: string | undefined | null): boolean {
  return (baseUrl ?? '').trim().toLowerCase() === LOCAL_EDGE_BASE;
}

function resolvePython(): string {
  const override = process.env.EDGE_TTS_PYTHON?.trim();
  if (override) return override;
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

/** 系统里的语速是倍率（0.9×），edge-tts 要的是带符号百分比（-10%） */
function toRateArg(rate: number): string {
  const pct = Math.round((Math.min(1.4, Math.max(0.5, rate)) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

interface ChildResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runChild(python: string, args: string[], input: string | null, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const out: Buffer[] = [];
    const errs: string[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const done = (result: ChildResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_AUDIO_BYTES) out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errs.push(chunk.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      done({ stdout: Buffer.concat(out), stderr: errs.join('').slice(0, 800), code, timedOut });
    });
    // 子进程若提前退出，写 stdin 会 EPIPE；忽略即可，错误信息从 stderr 取
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/** 把 Python / 微软接口的原始报错翻成用户能直接照做的中文 */
function explainFailure(stderr: string, code: number | null, timedOut: boolean): string {
  if (timedOut) return '本地语音合成超时（30 秒），可稍后重试或改用系统音色';
  const text = stderr.toLowerCase();
  if (text.includes('modulenotfounderror') || text.includes('no module named')) {
    return '本地 edge-tts 未安装，请在项目目录运行 npm run voice:setup';
  }
  if (text.includes('enoent') || text.includes('no such file') || text.includes('not found')) {
    return '找不到 Python 运行环境，请检查 EDGE_TTS_PYTHON 或运行 npm run voice:setup';
  }
  if (text.includes('403') || text.includes('handshake') || text.includes('wsserver') || text.includes('unauthorized')) {
    return '微软 Edge 语音接口暂时不可用（403 / 握手失败），这是非官方接口的已知风险；稍后重试或在设置里切回系统音色';
  }
  if (text.includes('noaudioreceived') || text.includes('no audio was received')) {
    return '这个 Neural 音色没有返回音频，可能已被微软下线；请在「编辑」里换一个音色，或切回系统音色';
  }
  const detail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 180);
  return `本地语音合成失败${code !== null ? `（退出码 ${code}）` : ''}${detail ? `：${detail}` : ''}`;
}

const cache = new Map<string, Buffer>();

/** 合成一段 mp3；相同音色 + 语速 + 文本命中内存缓存，重复试听不再联网 */
export async function synthesizeLocalEdge(args: {
  voice: string;
  input: string;
  rate: number;
}): Promise<Buffer> {
  const voice = args.voice.trim();
  if (!/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(voice)) {
    throw new UpstreamError(`本地 Neural 音色名不合法：${voice || '（空）'}`);
  }
  const text = args.input.trim().slice(0, 3000);
  if (!text) throw new UpstreamError('朗读内容为空');
  const rate = toRateArg(args.rate);
  const cacheKey = `${voice}|${rate}|${text}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const python = resolvePython();
  let result: ChildResult;
  try {
    result = await runChild(python, [], JSON.stringify({ voice, input: text, rate }), 30_000);
  } catch (err) {
    throw new UpstreamError(`启动本地语音合成失败：${(err as Error).message}`, { python });
  }
  if (result.code !== 0 || result.stdout.length === 0) {
    const message = explainFailure(result.stderr, result.code, result.timedOut);
    logger.warn('local edge tts failed', { voice, code: result.code, stderr: result.stderr.slice(0, 200) });
    throw new UpstreamError(message, { code: result.code });
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, result.stdout);
  return result.stdout;
}

let statusCache: { at: number; value: EdgeTtsStatus } | null = null;

/** 设置页用来显示「本地引擎是否就绪」，结果缓存 5 分钟，避免反复起子进程 */
export async function getEdgeTtsStatus(force = false): Promise<EdgeTtsStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < 5 * 60_000) return statusCache.value;
  const python = resolvePython();
  let value: EdgeTtsStatus;
  try {
    const result = await runChild(python, ['--probe'], null, 8_000);
    const missing = result.stderr.includes('ModuleNotFoundError');
    const version = missing ? null : result.stdout.toString('utf8').trim() || null;
    const available = result.code === 0 && !missing;
    value = {
      available,
      python,
      version,
      hint: available
        ? `本地 Edge Neural 已就绪${version ? `（edge-tts ${version}）` : ''}`
        : explainFailure(result.stderr, result.code, result.timedOut),
    };
  } catch (err) {
    value = {
      available: false,
      python,
      version: null,
      hint: `无法启动 Python：${(err as Error).message}；可运行 npm run voice:setup`,
    };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** 清掉状态缓存：setup 完成后让前端立刻看到「已就绪」 */
export function resetEdgeTtsStatus(): void {
  statusCache = null;
  cache.clear();
}
