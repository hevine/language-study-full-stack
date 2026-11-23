/**
 * 解题答疑视频存储。
 *
 * 两层结构（v9 起）：
 *   .data/explain-video/shared/<articleId>/<hash>/      ← 生成落在共享层，谁都能读
 *   .data/explain-video/<userId>/<articleId>/<hash>/    ← 个人副本（改过逐字稿才会产生）
 *
 * 为什么这么分：同一篇精读材料 + 同一级别 + 同一档位，讲的东西是同一套（教案决定提示词，
 * 提示词决定内容），没有理由让每个用户各付一次 token。默认读共享片；用户改逐字稿时
 * 走 copy-on-write 复制到个人目录，既不影响别人，自己的改动也能持久化。
 *
 * hash 不再含 userId 与音色：命中率优先。副作用是「讲师音色跟随首个生成者」，
 * 这一点在 UI 上明示，切换音色属于另一条能力（重配音），不要靠改 hash 来实现。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExplainVideo } from '../domain/explainVideo';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = path.join(projectRoot, '.data', 'explain-video');
const SHARED = path.join(ROOT, 'shared');
/** 个人副本（含老版本按用户隔离的存量数据）上限 */
const MAX_BYTES_PER_USER = 200 * 1024 * 1024;
/** 共享层上限：够放数千条讲解，超了按最旧清理 */
const MAX_BYTES_SHARED = 8 * 1024 * 1024 * 1024;

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

export function hashFor(params: {
  articleId: string;
  rate: number;
  scriptVersion: number;
  questionsText: string;
  /** 正文与译文：同一 id 的题目若换了文章，也必须重新生成，不能误命中旧缓存 */
  body?: string;
  translation?: string;
  /** 讲解深度：同一篇的短/中/长三档是三条独立缓存，不能互相命中 */
  depth?: string;
  /**
   * 教案档位（n5…n1 / toefl / cet …）。
   * 用户明确要求「N3 共享 N3、N1 共享 N1」——级别不同提示词不同，产物不能混用。
   */
  band?: string;
}): string {
  const raw = [
    params.articleId,
    params.rate,
    params.scriptVersion,
    params.questionsText,
    params.body ?? '',
    params.translation ?? '',
    params.depth ?? 'medium',
    params.band ?? 'default',
  ].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

export function dirFor(userId: string, articleId: string, hash: string): string {
  return path.join(ROOT, safeSegment(userId), safeSegment(articleId), hash);
}

export function sharedDirFor(articleId: string, hash: string): string {
  return path.join(SHARED, safeSegment(articleId), hash);
}

export interface StoredVideo {
  video: ExplainVideo;
  dir: string;
  /** 这条片来自共享层还是个人副本 */
  source: 'shared' | 'personal';
}

function readManifest(dir: string): ExplainVideo | null {
  const manifest = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifest)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')) as ExplainVideo;
  } catch {
    return null;
  }
}

/** videoId 形如 <articleId>_<hash>，可直接定位，不必遍历 */
function splitVideoId(videoId: string): { articleId: string; hash: string } | null {
  const at = videoId.lastIndexOf('_');
  if (at <= 0 || at === videoId.length - 1) return null;
  return { articleId: videoId.slice(0, at), hash: videoId.slice(at + 1) };
}

export function readStoredVideo(userId: string, videoId: string): StoredVideo | null {
  const split = splitVideoId(videoId);
  if (split) {
    // 个人副本优先：改过逐字稿的版本属于「我的」，不能被共享片覆盖
    const personal = dirFor(userId, split.articleId, split.hash);
    const mine = readManifest(personal);
    if (mine) return { video: mine, dir: personal, source: 'personal' };
    const shared = sharedDirFor(split.articleId, split.hash);
    const theirs = readManifest(shared);
    if (theirs) return { video: theirs, dir: shared, source: 'shared' };
    return null;
  }
  // 兜底：老 id 格式，遍历个人目录
  const userDir = path.join(ROOT, safeSegment(userId));
  if (!fs.existsSync(userDir)) return null;
  for (const article of fs.readdirSync(userDir, { withFileTypes: true })) {
    if (!article.isDirectory()) continue;
    for (const hash of fs.readdirSync(path.join(userDir, article.name), { withFileTypes: true })) {
      if (!hash.isDirectory()) continue;
      const dir = path.join(userDir, article.name, hash.name);
      const video = readManifest(dir);
      if (video && (video.id === videoId || video.id.endsWith(hash.name))) {
        return { video, dir, source: 'personal' };
      }
    }
  }
  return null;
}

/** 缓存命中判断：先看个人副本，再看共享层 */
export function findCachedVideo(
  userId: string,
  articleId: string,
  hash: string,
): StoredVideo | null {
  const personal = dirFor(userId, articleId, hash);
  const mine = readManifest(personal);
  if (mine) return { video: mine, dir: personal, source: 'personal' };
  const shared = sharedDirFor(articleId, hash);
  const theirs = readManifest(shared);
  if (theirs) return { video: theirs, dir: shared, source: 'shared' };
  return null;
}

/**
 * 写入新生成的视频。默认落共享层；`personal: true` 时落个人目录（改稿副本用）。
 * 分段音频与 manifest 同目录，中文轨写 seg-N.zh.mp3。
 */
export function writeVideo(
  userId: string,
  articleId: string,
  hash: string,
  video: ExplainVideo,
  segments: Buffer[],
  transcript?: string,
  options: { personal?: boolean } = {},
): StoredVideo {
  const dir = options.personal
    ? dirFor(userId, articleId, hash)
    : sharedDirFor(articleId, hash);
  fs.mkdirSync(dir, { recursive: true });
  segments.forEach((buf, i) => {
    if (buf.length > 0) fs.writeFileSync(path.join(dir, `seg-${i}.mp3`), buf);
  });
  if (transcript) {
    fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript, 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(video, null, 2), 'utf8');
  return { video, dir, source: options.personal ? 'personal' : 'shared' };
}

/** 母语音轨单独落盘：seg-N.zh.mp3，与主轨同目录，补轨时不需要整片重写 */
export function writeNativeSegments(dir: string, segments: Array<Buffer | null>): void {
  segments.forEach((buf, i) => {
    if (buf && buf.length > 0) fs.writeFileSync(path.join(dir, `seg-${i}.zh.mp3`), buf);
  });
}

export function nativeSegmentPath(dir: string, index: number): string {
  return path.join(dir, `seg-${index}.zh.mp3`);
}

/**
 * 更新 manifest。共享片被非 owner 编辑时走 copy-on-write：
 * 把共享目录整体复制成个人副本再写，避免一个人的改稿污染所有人。
 */
export function updateManifest(userId: string, videoId: string, video: ExplainVideo): boolean {
  const found = readStoredVideo(userId, videoId);
  if (!found) return false;
  const split = splitVideoId(videoId);
  const owner = found.video.meta?.ownerId;
  const needCopy = found.source === 'shared' && Boolean(split) && owner !== userId;
  if (!needCopy) {
    fs.writeFileSync(path.join(found.dir, 'manifest.json'), JSON.stringify(video, null, 2), 'utf8');
    return true;
  }
  const personal = dirFor(userId, split!.articleId, split!.hash);
  fs.mkdirSync(personal, { recursive: true });
  // 只复制音频与 manifest，导出文件按需重做，别把几十 MB 的 mp4 也搬过来
  for (const entry of fs.readdirSync(found.dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('export')) continue;
    fs.copyFileSync(path.join(found.dir, entry.name), path.join(personal, entry.name));
  }
  fs.writeFileSync(path.join(personal, 'manifest.json'), JSON.stringify(video, null, 2), 'utf8');
  return true;
}

export interface VideoSummary {
  id: string;
  articleId: string;
  title: string;
  totalMs: number;
  createdAt: string;
  depth?: string;
  band?: string;
  coach?: string;
  shots: number;
  /** shared = 别人生成、你直接复用；personal = 你自己生成，或你在共享片基础上改过/重配过 */
  source: 'shared' | 'personal';
  /** 是否当前用户生成 */
  mine: boolean;
  /** 共享片的个人副本（改过逐字稿或换过音色）——「不是我的，但我改过」 */
  revised: boolean;
}

function summarize(video: ExplainVideo, source: 'shared' | 'personal', userId: string): VideoSummary {
  const mine = (video.meta?.ownerId ?? '') === userId;
  return {
    id: video.id,
    articleId: video.articleId,
    title: video.title,
    totalMs: video.totalMs,
    createdAt: video.createdAt,
    depth: video.meta?.depth,
    band: video.meta?.band,
    coach: video.coach ?? 'target',
    shots: video.shots.length,
    source,
    mine,
    revised: source === 'personal' && !mine,
  };
}

/** 列出「我能看到」的全部视频：个人副本 + 共享层；同一 id 以个人副本为准 */
export function listVideos(userId: string): VideoSummary[] {
  const seen = new Map<string, VideoSummary>();

  const walk = (base: string, source: 'shared' | 'personal') => {
    if (!fs.existsSync(base)) return;
    for (const article of fs.readdirSync(base, { withFileTypes: true })) {
      if (!article.isDirectory()) continue;
      for (const hash of fs.readdirSync(path.join(base, article.name), { withFileTypes: true })) {
        if (!hash.isDirectory()) continue;
        const video = readManifest(path.join(base, article.name, hash.name));
        if (video) seen.set(video.id, summarize(video, source, userId));
      }
    }
  };

  walk(SHARED, 'shared');
  walk(path.join(ROOT, safeSegment(userId)), 'personal');
  return [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function measure(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return acc + measure(p);
    try {
      return acc + fs.statSync(p).size;
    } catch {
      return acc;
    }
  }, 0);
}

function collect(base: string): Array<{ dir: string; at: number; bytes: number }> {
  const entries: Array<{ dir: string; at: number; bytes: number }> = [];
  if (!fs.existsSync(base)) return entries;
  for (const article of fs.readdirSync(base, { withFileTypes: true })) {
    if (!article.isDirectory()) continue;
    for (const hash of fs.readdirSync(path.join(base, article.name), { withFileTypes: true })) {
      if (!hash.isDirectory()) continue;
      const dir = path.join(base, article.name, hash.name);
      const video = readManifest(dir);
      if (!video) continue;
      entries.push({ dir, at: Date.parse(video.updatedAt ?? video.createdAt) || 0, bytes: measure(dir) });
    }
  }
  return entries;
}

function evict(base: string, maxBytes: number): number {
  const entries = collect(base).sort((a, b) => a.at - b.at);
  let sum = entries.reduce((acc, e) => acc + e.bytes, 0);
  let removed = 0;
  for (const entry of entries) {
    if (sum <= maxBytes) break;
    fs.rmSync(entry.dir, { recursive: true, force: true });
    sum -= entry.bytes;
    removed += 1;
  }
  return removed;
}

/**
 * LRU 清理。个人副本保持较小配额（改稿副本通常只有一份），
 * 共享层配额大得多但要设上限——共享片被清掉会让下一个用户重新付费生成，
 * 所以顺序是先清个人副本，再清最旧的共享片。
 */
export function evictIfNeeded(userId: string): number {
  const personal = evict(path.join(ROOT, safeSegment(userId)), MAX_BYTES_PER_USER);
  const shared = evict(SHARED, MAX_BYTES_SHARED);
  return personal + shared;
}

/**
 * 删除。个人副本直接删；共享片只有 owner 能删（删了所有人都会失去缓存），
 * 非 owner 返回 false，由路由层提示「这是共享讲解，不能删除」。
 */
export function deleteVideo(userId: string, videoId: string): boolean {
  const found = readStoredVideo(userId, videoId);
  if (!found) return false;
  if (found.source === 'shared') {
    const owner = found.video.meta?.ownerId;
    if (owner && owner !== userId) return false;
  }
  fs.rmSync(found.dir, { recursive: true, force: true });
  return true;
}

export function segmentPath(dir: string, index: number): string {
  return path.join(dir, `seg-${index}.mp3`);
}

/** 导出音轨：原文单轨 / 中文讲师单轨 / 双语双音轨（同一容器两条 audio stream） */
export type ExportTrack = 'target' | 'native' | 'both';

export const EXPORT_TRACKS: ExportTrack[] = ['target', 'native', 'both'];

export function exportPath(dir: string, track: ExportTrack = 'target'): string {
  const name = track === 'native' ? 'export-zh.mp4' : track === 'both' ? 'export-both.mp4' : 'export.mp4';
  return path.join(dir, name);
}

/**
 * 删除全部导出文件（音频/音色变了就作废）。
 * 删不掉不算失败：导出产物是可再生的派生文件，下一次导出会覆盖；
 * 反过来让清理异常把「已经配好的新音轨」判成失败，用户会白跑一次。
 */
export function clearExports(dir: string): void {
  for (const track of EXPORT_TRACKS) {
    try {
      fs.rmSync(exportPath(dir, track), { force: true });
    } catch {
      // 交给下次导出覆盖
    }
  }
}

export function writeManifest(dir: string, video: ExplainVideo): void {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(video, null, 2), 'utf8');
}

/**
 * 提升为个人副本（copy-on-write），返回可写的个人目录。
 *
 * 「重配音」「改逐字稿」这类只该影响自己的写操作必须先走这里：
 * 共享片的音频是所有学员共用的，直接改写会把别人的讲解换成你的音色。
 * 导出文件不搬（几十 MB，且换音色后本来就要重做）。
 */
export function promoteToPersonal(
  userId: string,
  videoId: string,
): { video: ExplainVideo; dir: string } | null {
  const found = readStoredVideo(userId, videoId);
  if (!found) return null;
  if (found.source === 'personal') return { video: found.video, dir: found.dir };
  const split = splitVideoId(videoId);
  if (!split) return null;
  const personal = dirFor(userId, split.articleId, split.hash);
  fs.mkdirSync(personal, { recursive: true });
  for (const entry of fs.readdirSync(found.dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('export')) continue;
    fs.copyFileSync(path.join(found.dir, entry.name), path.join(personal, entry.name));
  }
  return { video: found.video, dir: personal };
}
