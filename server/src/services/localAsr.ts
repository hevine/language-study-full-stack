/**
 * 本地语音识别兜底（SenseVoiceSmall）的生命周期管理。
 *
 * 为什么不做成「独立常驻服务 + 开机自启」：用户机器上装了什么、什么时候开机，
 * 应用都不该假设。这里改成「应用要用它的时候确保它在跑」——
 *   先用 /health 探活；没在跑就 detached 拉起 local-asr/server.py；
 *   等它加载完模型（首次约 20-30 秒）再返回。
 * 拉起的进程 detach 掉，应用重启、退出都不会把它带走，下次探活直接复用。
 *
 * 只有号池里那条「本地兜底」线路会走到这里，线上线路正常时完全不会触发。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger';
import { addAsrPoolKey, asrPoolCandidates, listAsrPoolKeys } from './asrPool';

/** 本地线路的约定地址：号池里填这个，服务器就能认出这是本机服务 */
export const LOCAL_ASR_BASE_URL = 'http://127.0.0.1:8108/v1';
export const LOCAL_ASR_LABEL = '本地 SenseVoice（兜底）';

let starting: Promise<boolean> | null = null;
let child: ChildProcess | null = null;

/** 只认回环地址，避免误判线上线路 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function localDir(): string | null {
  const candidates = [
    process.env.ASR_LOCAL_DIR,
    path.resolve(process.cwd(), 'local-asr'),
    path.resolve(process.cwd(), '..', 'local-asr'),
    path.resolve(process.cwd(), '..', '..', 'local-asr'),
  ].filter((item): item is string => Boolean(item));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'server.py'))) return dir;
  }
  return null;
}

function pythonOf(dir: string): string | null {
  const py = path.join(dir, '.venv', 'bin', 'python');
  return fs.existsSync(py) ? py : null;
}

/** 运行环境是否装好了（venv + 模型都在），没装就不该把它当可用兜底 */
export function localAsrInstalled(): boolean {
  const dir = localDir();
  if (!dir) return false;
  return Boolean(pythonOf(dir)) && fs.existsSync(path.join(dir, 'models', 'SenseVoiceSmall', 'model.pt'));
}

function portOf(baseUrl: string): number {
  try {
    const url = new URL(baseUrl);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 8108;
  }
}

function healthUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}/health`;
}

/** 号池里那条本地线路的地址；用户改了端口也能跟着走，没配就用约定地址 */
export function localAsrBaseUrl(): string {
  const line = listAsrPoolKeys().find((key) => isLoopbackUrl(key.baseUrl));
  return line?.baseUrl ?? LOCAL_ASR_BASE_URL;
}

/** 设置页展示用的本地线路实时状态 */
export interface LocalAsrLastRun {
  atMs: number;
  elapsedMs: number;
  language: string;
  chars: number;
  bytes: number;
  coldStart: boolean;
}

export interface LocalAsrStatus {
  /** venv 和模型是否都装好了；没装就不该在界面上显示成「可用兜底」 */
  installed: boolean;
  baseUrl: string;
  running: boolean;
  loaded: boolean;
  loading: boolean;
  model: string | null;
  device: string | null;
  idleUnloadSec: number | null;
  idleSec: number | null;
  uptimeSec: number | null;
  loadMs: number | null;
  total: number;
  failed: number;
  last: LocalAsrLastRun | null;
  error: string | null;
  checkedAt: number;
}

function emptyStatus(baseUrl: string, installed: boolean): LocalAsrStatus {
  return {
    installed,
    baseUrl,
    running: false,
    loaded: false,
    loading: false,
    model: null,
    device: null,
    idleUnloadSec: null,
    idleSec: null,
    uptimeSec: null,
    loadMs: null,
    total: 0,
    failed: 0,
    last: null,
    error: null,
    checkedAt: Date.now(),
  };
}

/** 读一次本地服务状态。不拉起进程、不抛错：没跑就返回 running=false。 */
export async function localAsrStatus(): Promise<LocalAsrStatus> {
  const baseUrl = localAsrBaseUrl();
  const installed = localAsrInstalled();
  const status = emptyStatus(baseUrl, installed);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(healthUrl(baseUrl), { signal: controller.signal });
    if (!response.ok) return status;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || body.status !== 'ok') return status;
    const last = body.last as Record<string, unknown> | null | undefined;
    return {
      ...status,
      running: true,
      loaded: Boolean(body.loaded),
      loading: Boolean(body.loading),
      model: typeof body.model === 'string' ? body.model : null,
      device: typeof body.device === 'string' ? body.device : null,
      idleUnloadSec: typeof body.idleUnloadSec === 'number' ? body.idleUnloadSec : null,
      idleSec: typeof body.idleSec === 'number' ? body.idleSec : null,
      uptimeSec: typeof body.uptimeSec === 'number' ? body.uptimeSec : null,
      loadMs: typeof body.loadMs === 'number' ? body.loadMs : null,
      total: typeof body.total === 'number' ? body.total : 0,
      failed: typeof body.failed === 'number' ? body.failed : 0,
      error: typeof body.error === 'string' ? body.error : null,
      last:
        last && typeof last.atMs === 'number'
          ? {
              atMs: last.atMs,
              elapsedMs: Number(last.elapsedMs ?? 0),
              language: String(last.language ?? 'auto'),
              chars: Number(last.chars ?? 0),
              bytes: Number(last.bytes ?? 0),
              coldStart: Boolean(last.coldStart),
            }
          : null,
    };
  } catch {
    return status;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl(baseUrl), { signal: controller.signal });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    return body?.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function spawnServer(dir: string, py: string, port: number): ChildProcess {
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const fd = fs.openSync(path.join(logs, 'asr-local.log'), 'a');
  const proc = spawn(py, [path.join(dir, 'server.py')], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ASR_LOCAL_PORT: String(port) },
  });
  fs.closeSync(fd);
  proc.unref();
  logger.info('本地 ASR 服务已拉起', { pid: proc.pid, port });
  proc.on('exit', (code) => {
    logger.warn('本地 ASR 服务退出', { code });
    if (child === proc) child = null;
  });
  return proc;
}

/**
 * 确保本地服务可用。返回 false 表示没装好或起不来，调用方按线路失败处理。
 * 并发请求会共享同一次启动过程，不会拉起多个进程。
 */
export async function ensureLocalAsr(baseUrl = LOCAL_ASR_BASE_URL): Promise<boolean> {
  if (await probe(baseUrl)) return true;

  if (!localAsrInstalled()) return false;

  if (!starting) {
    starting = (async () => {
      const dir = localDir();
      const py = dir ? pythonOf(dir) : null;
      if (!dir || !py) return false;
      try {
        child = spawnServer(dir, py, portOf(baseUrl));
      } catch (err) {
        logger.warn('本地 ASR 服务启动失败', { message: (err as Error).message });
        return false;
      }
      // 冷启动要把 ~900MB 模型读进内存：机器忙的时候实测要 90 秒左右，给到 180 秒
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (await probe(baseUrl, 1000)) return true;
        if (!child) return false; // 进程已经退出，不必再等
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return false;
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

/** 手动启动（设置页的「启动服务」）：拉起进程并等 /health 就绪，再回报最新状态 */
export async function startLocalAsr(): Promise<LocalAsrStatus> {
  const baseUrl = localAsrBaseUrl();
  if (localAsrInstalled()) await ensureLocalAsr(baseUrl);
  return localAsrStatus();
}

/** 顺带把本地线路补进号池（已存在则不重复加，停用的也不会被重新启用） */
export function ensureLocalAsrPoolLine(): void {
  if (!localAsrInstalled()) return;
  const exists = listAsrPoolKeys().some((key) => isLoopbackUrl(key.baseUrl));
  if (exists) return;
  try {
    addAsrPoolKey({
      label: LOCAL_ASR_LABEL,
      baseUrl: LOCAL_ASR_BASE_URL,
      model: 'SenseVoiceSmall',
      apiKey: 'local-no-key',
    });
    logger.info('已把本地兜底线路加入 ASR 号池', { baseUrl: LOCAL_ASR_BASE_URL });
  } catch (err) {
    logger.warn('本地兜底线路加入号池失败', { message: (err as Error).message });
  }
}

/**
 * 启动时预热：只在「本地线路确实排在号池里」时才拉起，
 * 用户把它删掉/停用了就不会白占 2GB 内存。
 */
export function warmLocalAsr(): void {
  const line = asrPoolCandidates().find((candidate) => isLoopbackUrl(candidate.baseUrl));
  if (!line) return;
  void ensureLocalAsr(line.baseUrl)
    .then((ok) => {
      if (!ok) logger.warn('本地 ASR 兜底未能就绪，录音转写仍然只走线上线路');
    })
    .catch((err: unknown) => {
      // 兜底失败不该影响主服务：这里必须兜住，否则未处理的 rejection 会带走整个进程
      logger.warn('本地 ASR 兜底预热异常', { message: (err as Error)?.message });
    });
}
