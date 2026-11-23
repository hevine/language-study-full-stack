/**
 * 解题答疑视频生成流水线（job 模式，绝不在请求处理器里跑长任务）。
 *
 *   POST /api/explain-videos  -> createExplainJob() 立刻返回 jobId，后台异步跑：
 *     script   一次 LLM 生成分镜脚本（目标语旁白 + 中文字幕）
 *     speech   逐镜配音（并发 2，失败重试 1 次，单镜失败降级静音+字幕停留）
 *     assemble 累加时长 + 句级边界 → cues，写 manifest.json + seg-N.mp3
 *     done
 *   前端 1 秒轮询 GET /api/explain-videos/jobs/:id，与 exam-imports 一致。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Language } from '../domain/language';
import type { ArticleRecord } from '../repositories/content';
import {
  computeServerTimeline,
  type CoachMode,
  type ExplainDepth,
  type ExplainVideo,
  type Shot,
  validateExplainVideo,
} from '../domain/explainVideo';
import { currentUserId, runAsUser } from '../auth/requestScope';
import { logger } from '../lib/logger';
import { NotFoundError, UpstreamError, ValidationError } from '../lib/errors';
import { getDayContentById } from '../repositories/content';
import { getAssignments, getVoice, listVoices, type VoiceRecord } from '../repositories/voices';
import { isLocalEdge } from './edgeTts';
import {
  clearExports,
  deleteVideo,
  evictIfNeeded,
  exportPath,
  findCachedVideo,
  hashFor,
  listVideos,
  nativeSegmentPath,
  promoteToPersonal,
  readStoredVideo,
  segmentPath,
  updateManifest,
  writeManifest,
  writeNativeSegments,
  writeVideo,
  type ExportTrack,
} from '../repositories/explainVideos';
import { generateExplainScript } from './explainScript';
import { estimateDurationMs, synthesizeWithTimeline } from './explainTts';
import { generateNativeNarration, resolveNativeVoice } from './explainNative';
import { DEPTH_PLANS, estimateAllDepths, resolveLevelProfile, type DepthEstimate } from './explainPedagogy';
import type { TokenUsage } from './llm';

/** 脚本版本：改 prompt / 分镜结构时 +1，让旧缓存自然失效
 *  v3：注入分级教学法（教案）+ 三档讲解深度 + 教案级七拍结构
 *  v4：旁白语种硬校验（v3 试跑发现模型把旁白写成了中文，音频会变乱码）
 *  v5：七拍改成每镜必做动作 + 单镜字数下限与密度示范（v4 产物只有 12–32 字/镜，像答案卡不像讲课）
 *  v6：去掉 eliminate/answer 重复抄写题干选项（组装时本就以题库覆盖，白烧 token 且撑爆输出预算）
 *  v7：全片只留一个结尾镜 + 明确字数上限（v6 产物每题 430 字、三个 takeaway，比计划长约 60%）
 *  v8：字数预算改为实测值（六镜结构的下限本就接近旧上限，压不下去就别压，让预估说实话）
 *  v9：跨用户共享缓存（hash 去掉 userId/音色、加入教案档位）+ 母语讲师轨
 *      —— hash 口径变了，旧缓存自然作废，这里升版本是为了让 v8 产物不再被误命中 */
const SCRIPT_VERSION = 9;
const SCRIPT_RATE = 0.92;
/** 分阶段超时：脚本（大模型）单独给预算，配音/组装合计另一份。
 *  不能用一个总倒计时——LLM 慢时脚本就能耗掉大半，导致配音被误杀。
 *  具体数值跟着讲解深度走（精讲档输出 20+ 镜，5 分钟不够）。 */
const SPEECH_TIMEOUT_MS = 4 * 60_000;

export type ExplainStage = 'script' | 'speech' | 'coach' | 'revoice' | 'assemble' | 'done' | 'error';

export interface ExplainJob {
  id: string;
  articleId: string;
  userId: string;
  stage: ExplainStage;
  progress: number;
  /** 0..N 段的进度文案 */
  detail: string;
  videoId?: string;
  error?: string;
  /** 本次任务实际消耗的 token（命中缓存为 0）；生成完成时由流水线回填 */
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** 直接命中磁盘缓存，未调用大模型 */
  cacheHit?: boolean;
  /** 命中缓存时说明这条片来自哪里：共享层（别人生成过）还是自己的副本 */
  cacheSource?: 'shared' | 'personal';
  /** 目标讲师轨形态 */
  coach?: CoachMode;
  /** 这是「给已有视频补母语轨」的任务，不是重新生成 */
  coachOnly?: boolean;
  /** 这是「换音色重配」的任务：只跑 TTS，不调大模型，token 恒为 0 */
  revoiceOnly?: boolean;
  /** 换了什么音色（重配音任务用，前端显示「已换成 XX」） */
  voice?: string;
  createdAt: number;
  updatedAt: number;
  canceled: boolean;
}

const jobs = new Map<string, ExplainJob>();
/** 文章 id 级别的 in-flight 去重，避免连点两次生成两份 */
const inFlight = new Map<string, string>();

function update(job: ExplainJob, patch: Partial<ExplainJob>): void {
  Object.assign(job, patch, { updatedAt: Date.now() });
  jobs.set(job.id, job);
}

export function getExplainJob(id: string): ExplainJob | null {
  return jobs.get(id) ?? null;
}

/** 取消生成：协作式，stage 循环里检查 canceled */
export function cancelExplainJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.stage === 'done' || job.stage === 'error') return false;
  update(job, { canceled: true, detail: '已请求取消，正在停止…' });
  return true;
}

function throwIfCanceled(job: ExplainJob): void {
  if (!job.canceled) return;
  update(job, { stage: 'error', error: '已取消生成', progress: 0 });
  throw new Error('__CANCELED__');
}

const NEURAL_NAME = /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;
const DEFAULT_NEURAL: Record<Language, string> = {
  en: 'en-US-AvaNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
};

/**
 * 把「一条音色记录」转成讲解配音可用的 Neural 音色名。
 * 讲解配音走本地 Edge 时间轴通道，只认 xx-XX-XxxNeural：
 *  - local://edge 音色：voiceId 就是 Neural 名（enableLocalEdgeVoices 播种时写入）；
 *  - 老数据若把 Neural 名直接写进 voiceId，也兼容；
 *  - 浏览器/云端音色没有 Neural 名，返回 null 让调用方回退。
 */
function neuralNameOf(voice: VoiceRecord | null | undefined): string | null {
  if (!voice) return null;
  const direct = voice.voiceId?.trim() ?? '';
  if (NEURAL_NAME.test(direct)) return direct;
  // 兼容旧格式：voiceId 带 local://edge: 前缀
  if (direct.startsWith('local://edge:')) {
    const bare = direct.slice('local://edge:'.length);
    if (NEURAL_NAME.test(bare)) return bare;
  }
  // engineVoice 偶尔也存过 Neural 名
  const engine = voice.engineVoice?.trim() ?? '';
  if (isLocalEdge(voice.baseUrl) && NEURAL_NAME.test(engine)) return engine;
  return null;
}

/**
 * 从 voice_assignments 的 article 场景解析出讲解配音实际使用的 Neural 音色名。
 *
 * P0-1 修正：setAssignments() 存的是 voice 记录的 UUID，不是 Neural 名，
 * 旧实现拿 UUID 去跑正则永远不命中 → 换音色不生效、缓存指纹也不变。
 * 现在按 assignment(UUID) → getVoice(userId, language, id) → voiceId 解析，
 * 同时保留对旧格式（直接写 Neural 名 / local://edge:xxx）的兼容。
 * 未分配时回退到该语种默认音色，最后才是硬编码兜底。
 */
function resolveVoice(language: Language, userId: string): string {
  try {
    const assignment = getAssignments(userId, language).article;
    if (assignment) {
      // 老格式：场景里直接存的 Neural 名
      const legacy = assignment.startsWith('local://edge:')
        ? assignment.slice('local://edge:'.length)
        : assignment;
      if (NEURAL_NAME.test(legacy)) return legacy;
      // 新格式：UUID → 音色记录 → Neural 名
      const named = neuralNameOf(getVoice(userId, language, assignment));
      if (named) return named;
    }
    // 未显式分配：优先用该语种的默认音色
    const defaultVoice = listVoices(userId, language).find((item) => item.isDefault);
    const named = neuralNameOf(defaultVoice);
    if (named) return named;
  } catch {
    // 未配音色 / 数据异常时走硬编码兜底
  }
  return DEFAULT_NEURAL[language];
}

function questionsText(article: ArticleRecord): string {
  return article.questions
    .map((q) => `${q.prompt}|${q.options.join('|')}|${q.answer}`)
    .join('~');
}

/**
 * 生成参数指纹：创建任务、预检、预估三处共用，保证判断的是同一份缓存。
 *
 * 故意不含 userId，也不含音色——这两个正是「跨用户共享」要跨过去的东西。
 * 含教案档位 band：N3 的提示词和 N1 的不是一套，产物不能互相命中。
 */
function fingerprint(article: ArticleRecord, userId: string, depth: ExplainDepth) {
  const language = inferLanguage(article);
  const voice = resolveVoice(language, userId);
  const profile = resolveLevelProfile({
    language,
    examLabel: article.examLabel ?? null,
    examId: article.examId ?? null,
  });
  const hash = hashFor({
    articleId: article.id,
    rate: SCRIPT_RATE,
    scriptVersion: SCRIPT_VERSION,
    questionsText: questionsText(article),
    body: article.body,
    translation: article.translation,
    depth,
    band: profile.band,
  });
  return { language, voice, hash, band: profile.band, levelLabel: profile.label };
}

/** 并行 map，限制并发数；单个失败可降级 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 这条片是否已经有母语讲师轨（老数据没有 coach 字段，靠 shot 自身判断更准） */
function hasNativeTrack(video: ExplainVideo): boolean {
  return video.shots.some((shot) => shot.audio.native?.url);
}

const ZERO_TOKENS = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** 创建生成任务：立刻返回，流水线在后台跑 */
export function createExplainJob(params: {
  articleId: string;
  force?: boolean;
  depth?: ExplainDepth;
  /** 是否连母语讲师轨一起生成；默认只出目标语轨（最省 token） */
  coach?: CoachMode;
}): ExplainJob {
  const userId = currentUserId();
  const article = getDayContentById(params.articleId);
  if (!article) throw new NotFoundError('这篇精读材料不存在或已失效');
  if (article.questions.length === 0) {
    throw new UpstreamError('这篇文章没有题目，暂时无法生成解题讲解');
  }

  const depth: ExplainDepth = params.depth ?? 'medium';
  const plan = DEPTH_PLANS[depth];
  const coach: CoachMode = params.coach ?? 'target';
  // 去重键带上档位：同一篇可以同时存在「精简」与「精讲」两条任务，互不顶替
  const flightKey = `${article.id}:${depth}`;

  const existing = inFlight.get(flightKey);
  if (existing && !params.force) {
    const job = jobs.get(existing);
    if (job && job.stage !== 'error') return job;
  }

  const { language, voice, hash, band, levelLabel } = fingerprint(article, userId, depth);

  // 命中缓存：直接造一个 done job，前端轮询一次即可秒开。
  // 缓存可能来自共享层（别的用户生成过同一篇同级别同档位的讲解）——这正是要的复用。
  const cached = params.force ? null : findCachedVideo(userId, article.id, hash);

  // 要双语但缓存里没有母语轨：不重跑脚本，只补一条中文音轨（省掉整份脚本的 token）
  if (cached && coach === 'bilingual' && !hasNativeTrack(cached.video)) {
    return requestCoachTrack(cached.video.id);
  }

  const id = randomUUID();
  const job: ExplainJob = {
    id,
    articleId: article.id,
    userId,
    stage: 'done',
    progress: 100,
    detail: cached ? '命中缓存' : '',
    videoId: cached?.video.id,
    tokens: ZERO_TOKENS,
    cacheHit: Boolean(cached),
    cacheSource: cached?.source,
    coach,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canceled: false,
  };
  jobs.set(id, job);

  if (!cached) {
    update(job, {
      stage: 'script',
      progress: 5,
      detail: `正在生成${plan.label}讲解脚本（${levelLabel} 教案 · 大模型）…`,
      videoId: undefined,
    });
    inFlight.set(flightKey, id);
    // 把当前请求作用域的 userId 带进后台任务
    void runAsUser(userId, () =>
      runPipeline(job, article, voice, hash, language, depth, coach, band),
    ).finally(() => {
      inFlight.delete(flightKey);
      // 保留最近 200 个 job 供轮询，旧的丢弃
      if (jobs.size > 200) {
        const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) jobs.delete(oldest.id);
      }
    });
  }
  return job;
}

/**
 * 给已有视频补母语讲师轨（不重跑脚本）。
 *
 * 这是「少烧 token」的关键路径：脚本已经生成过，中文讲解只是转述，
 * 成本约为整片重生成的 1/5（一次小预算调用 + 本地 TTS）。
 */
export function requestCoachTrack(videoId: string): ExplainJob {
  const userId = currentUserId();
  const found = readStoredVideo(userId, videoId);
  if (!found) throw new NotFoundError('这个讲解视频不存在或已过期');
  const video = found.video;

  if (hasNativeTrack(video)) {
    const ready: ExplainJob = {
      id: randomUUID(),
      articleId: video.articleId,
      userId,
      stage: 'done',
      progress: 100,
      detail: '这条讲解已经有中文讲师轨',
      videoId: video.id,
      tokens: ZERO_TOKENS,
      cacheHit: true,
      cacheSource: found.source,
      coach: 'bilingual',
      coachOnly: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      canceled: false,
    };
    jobs.set(ready.id, ready);
    return ready;
  }

  const flightKey = `coach:${video.id}`;
  const existing = inFlight.get(flightKey);
  if (existing) {
    const job = jobs.get(existing);
    if (job && job.stage !== 'error') return job;
  }

  const job: ExplainJob = {
    id: randomUUID(),
    articleId: video.articleId,
    userId,
    stage: 'coach',
    progress: 8,
    detail: '正在用中文重讲这一遍（不重跑脚本，只补音轨）…',
    videoId: video.id,
    coach: 'bilingual',
    coachOnly: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canceled: false,
  };
  jobs.set(job.id, job);
  inFlight.set(flightKey, job.id);
  void runAsUser(userId, () => runCoachPipeline(job, video, found.dir)).finally(() => {
    inFlight.delete(flightKey);
  });
  return job;
}

/** 从文章推断语种：day_contents 没存 language 列，按 id 前缀或内容特征兜底 */
function inferLanguage(article: ArticleRecord): Language {
  // body 优先：日文假名 / 韩文谚文
  if (/[\u3040-\u30ff]/.test(article.body)) return 'ja';
  if (/[\uac00-\ud7af]/.test(article.body)) return 'ko';
  return 'en';
}

/** 中文比目标语信息密度高，语速给 1.0 更自然（目标语用 0.92 是为了给学生反应时间） */
const NATIVE_RATE = 1.0;

/**
 * 给一条已落盘的视频补母语轨：一次 LLM 转述 + 逐镜中文 TTS。
 * 不做时间轴重排——主轨时间轴保持唯一时钟，播放器按比例映射中文音轨。
 */
async function attachNativeTrack(
  video: ExplainVideo,
  dir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ usage?: TokenUsage; model: string | null }> {
  const native = await generateNativeNarration(video.shots, video.language);
  const voice = resolveNativeVoice();
  const segments: Array<Buffer | null> = new Array(video.shots.length).fill(null);
  let done = 0;

  await mapWithConcurrency(video.shots, 2, async (shot: Shot, index: number) => {
    const text = native.texts.get(shot.id);
    if (!text) {
      // 个别镜没通过语种校验：这条镜的中文轨留空，播放器回落到目标语轨，不整片失败
      done += 1;
      onProgress?.(done, video.shots.length);
      return;
    }
    shot.narrationZh = text;
    try {
      const synth = await synthesizeWithTimeline({ voice, input: text, rate: NATIVE_RATE });
      segments[index] = synth.audio;
      shot.audio.native = {
        url: `/api/explain-videos/${video.id}/seg/${index}?track=zh`,
        durationMs: synth.durationMs > 0 ? synth.durationMs : estimateDurationMs(text, 'zh'),
        boundaries: synth.boundaries,
      };
    } catch (err) {
      logger.warn('explain native speech degraded', { shot: index, err: (err as Error).message });
      shot.audio.native = undefined;
    }
    done += 1;
    onProgress?.(done, video.shots.length);
  });

  writeNativeSegments(dir, segments);
  const covered = video.shots.filter((shot) => shot.audio.native?.url).length;
  if (covered === 0) throw new UpstreamError('中文讲解配音全部失败，请稍后重试');
  video.coach = 'bilingual';
  video.meta = { ...(video.meta ?? { model: null, scriptVersion: SCRIPT_VERSION }), nativeUsage: native.usage };
  logger.info('explain native track attached', {
    videoId: video.id,
    shots: video.shots.length,
    covered,
    tokTotal: native.usage?.totalTokens ?? 0,
  });
  return { usage: native.usage, model: native.model };
}

/** 只补母语轨的任务流水线 */
async function runCoachPipeline(job: ExplainJob, video: ExplainVideo, dir: string): Promise<void> {
  const timer = setTimeout(() => {
    if (job.stage !== 'done' && job.stage !== 'error') {
      update(job, { stage: 'error', error: '中文讲解生成超时，请稍后重试', progress: 0 });
    }
  }, 8 * 60_000);
  timer.unref?.();

  try {
    throwIfCanceled(job);
    update(job, { progress: 15, detail: '正在把讲解转成中文口播稿…' });
    const { usage } = await attachNativeTrack(video, dir, (done, total) => {
      update(job, {
        progress: 15 + Math.round((done / total) * 80),
        detail: `中文配音 ${done}/${total} 镜`,
      });
    });
    throwIfCanceled(job);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(video, null, 2), 'utf8');
    clearTimeout(timer);
    update(job, {
      stage: 'done',
      progress: 100,
      detail: '中文讲师轨已就绪',
      videoId: video.id,
      tokens: usage ?? ZERO_TOKENS,
      cacheHit: false,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = (err as Error).message === '__CANCELED__'
      ? '已取消生成'
      : (err as Error).message || '中文讲解生成失败，请重试';
    update(job, { stage: 'error', error: message, progress: 0 });
    logger.warn('explain coach job failed', { jobId: job.id, videoId: video.id, err: message });
  }
}

/* ------------------------------------------------------------------ 重配音 */

/** 音色 id 换成能读的名字：优先用用户自己给音色起的名字 */
function friendlyVoiceName(voice: string, userId: string, language: Language): string {
  try {
    const hit = listVoices(userId, language).find((item) => neuralNameOf(item) === voice);
    if (hit?.name) return hit.name;
  } catch {
    // 没配音色：退回音色 id 的短名
  }
  const bare = voice.split('-').pop() ?? voice;
  return bare.replace(/Neural$/, '');
}

/**
 * 换音色重配：只跑 TTS，不调大模型，token 恒为 0。
 *
 * 为什么需要这条路径：共享缓存的 hash 里故意不含音色（那是跨用户复用成立的前提），
 * 所以成片的音色跟随首个生成者。用户想听自己的音色时，重跑整份脚本纯属浪费——
 * 旁白一个字都不用变，只是换个人念。
 *
 * 写盘前必然先落到个人副本：共享片是全站共用资产，把它的 seg-N.mp3 换成我的音色，
 * 等于替所有人改了讲师。
 */
export function requestRevoice(videoId: string, voice?: string): ExplainJob {
  const userId = currentUserId();
  const found = readStoredVideo(userId, videoId);
  if (!found) throw new NotFoundError('这个讲解视频不存在或已过期');
  const video = found.video;

  const target = (voice?.trim() || resolveVoice(video.language, userId)).trim();
  if (!NEURAL_NAME.test(target)) {
    throw new ValidationError(
      `音色名不合法：${target || '（空）'}。讲解配音只支持 Edge Neural 音色（形如 ja-JP-NanamiNeural）`,
    );
  }
  const label = friendlyVoiceName(target, userId, video.language);

  const id = randomUUID();
  const job: ExplainJob = {
    id,
    articleId: video.articleId,
    userId,
    stage: 'revoice',
    progress: 5,
    detail: `正在用「${label}」重配 ${video.shots.length} 镜…`,
    videoId: video.id,
    coach: video.coach ?? 'target',
    revoiceOnly: true,
    voice: target,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canceled: false,
  };

  // 音色没变就别折腾：直接告诉用户「已经是这个声音」，一次 TTS 都不跑
  if (target === video.voice) {
    const ready: ExplainJob = {
      ...job,
      stage: 'done',
      progress: 100,
      detail: `当前已经是「${label}」，不需要重配`,
      tokens: ZERO_TOKENS,
      cacheHit: true,
      cacheSource: found.source,
    };
    jobs.set(id, ready);
    return ready;
  }

  const flightKey = `revoice:${videoId}`;
  const existing = inFlight.get(flightKey);
  if (existing) {
    const running = jobs.get(existing);
    if (running && running.stage !== 'error') return running;
  }

  const promoted = promoteToPersonal(userId, videoId);
  if (!promoted) throw new NotFoundError('这个讲解视频不存在或已过期');

  jobs.set(id, job);
  inFlight.set(flightKey, id);
  void runAsUser(userId, () => runRevoicePipeline(job, video, promoted.dir, target, label)).finally(() => {
    inFlight.delete(flightKey);
  });
  return job;
}

/** 重配音任务：逐镜换音色重合成 → 重算时间轴 → 保留用户改过的字幕 */
async function runRevoicePipeline(
  job: ExplainJob,
  video: ExplainVideo,
  dir: string,
  voice: string,
  label: string,
): Promise<void> {
  const timer = setTimeout(() => {
    if (job.stage !== 'done' && job.stage !== 'error') {
      update(job, { stage: 'error', error: '重配音超时，请稍后重试', progress: 0 });
    }
  }, 90_000 + video.shots.length * 6_000);
  timer.unref?.();

  try {
    throwIfCanceled(job);
    const segments: Array<Buffer | null> = new Array(video.shots.length).fill(null);
    let done = 0;
    let failed = 0;

    await mapWithConcurrency(video.shots, 2, async (shot: Shot, index: number) => {
      if (job.canceled) return;
      try {
        const synth = await synthesizeWithTimeline({ voice, input: shot.narration, rate: SCRIPT_RATE });
        segments[index] = synth.audio;
        shot.audio.durationMs = synth.durationMs > 0
          ? synth.durationMs
          : estimateDurationMs(shot.narration, video.language);
        shot.audio.boundaries = synth.boundaries;
      } catch (err) {
        // 单镜失败保留旧音频与旧时长：一个声音混进去也比整片重来强，但必须留痕
        failed += 1;
        logger.warn('explain revoice degraded', { shot: index, err: (err as Error).message });
      }
      done += 1;
      update(job, {
        progress: 8 + Math.round((done / video.shots.length) * 84),
        detail: `重配音 ${done}/${video.shots.length} 镜`,
      });
    });
    throwIfCanceled(job);
    if (done > 0 && failed === done) {
      throw new UpstreamError('换音色失败：所有分镜都没合成成功，请稍后再试');
    }

    segments.forEach((buf, index) => {
      if (buf && buf.length > 0) fs.writeFileSync(segmentPath(dir, index), buf);
    });

    video.voice = voice;
    const timeline = computeServerTimeline(video.shots, video.language);
    video.totalMs = timeline.totalMs;
    // 逐字稿是用户的劳动：按 cue id 把改过的文字贴回新时间轴，时间用新算的
    const editedById = new Map(video.cues.filter((cue) => cue.edited).map((cue) => [cue.id, cue.text]));
    video.cues = timeline.cues.map((cue) => {
      const edited = editedById.get(cue.id);
      return edited ? { ...cue, text: edited, edited: true } : cue;
    });
    video.updatedAt = new Date().toISOString();
    video.meta = {
      ...(video.meta ?? { model: null, scriptVersion: SCRIPT_VERSION }),
      revoice: { at: video.updatedAt, voice, by: job.userId },
    };
    // manifest 是唯一事实来源，先写它；导出产物是可再生的派生文件，清不掉也不该算失败
    writeManifest(dir, video);
    clearExports(dir);
    clearTimeout(timer);
    update(job, {
      stage: 'done',
      progress: 100,
      detail: failed > 0
        ? `已换成「${label}」（${failed} 镜沿用原音色），本次 0 token`
        : `已换成「${label}」，本次 0 token（只重配音频，没调大模型）`,
      videoId: video.id,
      tokens: ZERO_TOKENS,
      cacheHit: false,
    });
    logger.info('explain revoice done', { videoId: video.id, voice, failed, shots: video.shots.length });
  } catch (err) {
    clearTimeout(timer);
    const message = (err as Error).message === '__CANCELED__'
      ? '已取消重配'
      : (err as Error).message || '重配音失败，请重试';
    update(job, { stage: 'error', error: message, progress: 0 });
    logger.warn('explain revoice failed', { jobId: job.id, videoId: video.id, err: message });
  }
}

async function runPipeline(
  job: ExplainJob,
  article: ArticleRecord,
  voice: string,
  hash: string,
  language: Language,
  depth: ExplainDepth,
  coach: CoachMode,
  band: string,
): Promise<void> {
  const plan = DEPTH_PLANS[depth];
  let stageTimer = setTimeout(() => {
    if (job.stage === 'script') {
      update(job, {
        stage: 'error',
        error: `脚本生成超时（${Math.round(plan.scriptTimeoutMs / 60_000)} 分钟），请稍后重试`,
        progress: 0,
      });
    }
  }, plan.scriptTimeoutMs);
  stageTimer.unref?.();
  const resetTimer = (ms: number, message: string) => {
    clearTimeout(stageTimer);
    stageTimer = setTimeout(() => {
      if (job.stage !== 'done' && job.stage !== 'error') {
        update(job, { stage: 'error', error: message, progress: 0 });
      }
    }, ms);
    stageTimer.unref?.();
  };

  /**
   * 视频落盘后才有值。收尾阶段（补母语轨）超时不该把整份产物判死——
   * 用户看到的应该是「已就绪」，而不是「失败」然后重新付一次 token。
   */
  let savedVideo: { videoId: string; usage: TokenUsage } | null = null;

  try {
    throwIfCanceled(job);

    // ① 脚本
    const generated = await generateExplainScript({
      articleId: article.id,
      language,
      title: article.title,
      body: article.body,
      translation: article.translation,
      questions: article.questions,
      vocab: article.vocab.map((v) => ({ term: v.term, meaning: (v as { meaning?: string }).meaning })),
      depth,
      examLabel: article.examLabel ?? null,
      examId: article.examId ?? null,
    });
    throwIfCanceled(job);
    const shots = generated.shots;
    // 脚本阶段已结束，重新给配音+组装一个跟着镜数走的预算（精讲 20+ 镜需要更久）
    const speechBudget = Math.max(SPEECH_TIMEOUT_MS, 90_000 + shots.length * 6000);
    resetTimer(speechBudget, '配音或组装超时，请稍后重试');
    update(job, {
      stage: 'speech',
      progress: 20,
      detail: generated.quality.salvaged
        ? `模型输出不完整，已按可用部分生成（题库补齐 ${generated.quality.autoFilled} 镜），共 ${shots.length} 镜，正在配音…`
        : `${plan.label}脚本就绪，共 ${shots.length} 个分镜，正在配音…`,
    });

    // ② 逐镜配音（并发 2；单镜失败降级静音 + 字幕停留）
    const segments: Buffer[] = new Array(shots.length);
    await mapWithConcurrency(shots, 2, async (shot: Shot, index: number) => {
      if (job.canceled) return;
      try {
        let synth;
        try {
          synth = await synthesizeWithTimeline({ voice, input: shot.narration, rate: SCRIPT_RATE });
        } catch {
          // 重试一次
          synth = await synthesizeWithTimeline({ voice, input: shot.narration, rate: SCRIPT_RATE });
        }
        shot.audio.url = `/api/explain-videos/${article.id}_${hash}/seg/${index}`;
        shot.audio.boundaries = synth.boundaries;
        shot.audio.durationMs = synth.durationMs > 0
          ? synth.durationMs
          : estimateDurationMs(shot.narration, language);
        segments[index] = synth.audio;
      } catch (err) {
        // 单镜失败不整片失败：静音 + 字幕停留 4 秒
        logger.warn('explain shot speech degraded', { shot: index, err: (err as Error).message });
        shot.audio.url = '';
        shot.audio.durationMs = 4000;
        segments[index] = Buffer.alloc(0);
      }
      const done = segments.filter(Boolean).length;
      update(job, {
        progress: 20 + Math.round((done / shots.length) * 70),
        detail: `配音 ${done}/${shots.length} 镜${done < shots.length ? '（失败镜将静音+字幕）' : ''}`,
      });
    });
    throwIfCanceled(job);

    // ③ 组装时间轴
    update(job, { stage: 'assemble', progress: 92, detail: '正在组装时间轴与逐字稿…' });
    const timeline = computeServerTimeline(shots, language);
    const videoId = `${article.id}_${hash}`;
    const video: ExplainVideo = {
      id: videoId,
      articleId: article.id,
      language,
      narrationLanguage: 'target',
      voice,
      title: article.title,
      totalMs: timeline.totalMs,
      shots,
      cues: timeline.cues,
      createdAt: new Date().toISOString(),
      // 先按目标语落库；下面若选了双语，成功补上中文轨后再改成 bilingual
      coach: 'target',
      meta: {
        model: generated.model,
        usage: generated.usage,
        scriptVersion: SCRIPT_VERSION,
        depth,
        band,
        ownerId: job.userId,
        quality: {
          salvage: generated.quality.salvaged,
          truncated: generated.quality.truncated,
          autoFilledShots: generated.quality.autoFilled,
        },
      },
    };
    const issues = validateExplainVideo(video, { maxMs: plan.videoCapMs });
    if (issues.length > 0) {
      logger.warn('explain video validation issues', { videoId, issues });
    }

    const transcript = video.shots
      .map((s, i) => `[${i + 1}. ${s.kind}] 旁白: ${s.narration}\n字幕: ${s.caption}`)
      .join('\n\n');
    // 落在共享层：同篇同级别同档位的下一个人直接复用，不再付一次 token
    const stored = writeVideo(job.userId, article.id, hash, video, segments, transcript);
    evictIfNeeded(job.userId);
    savedVideo = { videoId, usage: generated.usage ?? ZERO_TOKENS };

    // ④ 母语讲师轨（可选）：脚本已落盘，失败也不影响目标语版可用
    let nativeUsage: TokenUsage | undefined;
    if (coach === 'bilingual') {
      // 中文稿是另一次 LLM 调用 + 一轮配音，必须单独计时：
      // 沿用配音阶段那份预算会把「已经出片、正在补轨」的 job 误判成超时（实测踩过）。
      resetTimer(180_000 + shots.length * 5_000, '中文讲师轨生成超时，请稍后重试');
      update(job, { stage: 'coach', progress: 94, detail: '正在生成中文讲师轨（转述 + 配音）…' });
      try {
        const attached = await attachNativeTrack(video, stored.dir, (done, total) => {
          update(job, { progress: 94 + Math.round((done / total) * 5), detail: `中文配音 ${done}/${total} 镜` });
        });
        nativeUsage = attached.usage;
        fs.writeFileSync(path.join(stored.dir, 'manifest.json'), JSON.stringify(video, null, 2), 'utf8');
      } catch (err) {
        logger.warn('explain native track failed, keeping target-only video', {
          videoId,
          err: (err as Error).message,
        });
      }
    }

    clearTimeout(stageTimer);
    const totalUsage: TokenUsage = {
      promptTokens: (generated.usage?.promptTokens ?? 0) + (nativeUsage?.promptTokens ?? 0),
      completionTokens: (generated.usage?.completionTokens ?? 0) + (nativeUsage?.completionTokens ?? 0),
      totalTokens: (generated.usage?.totalTokens ?? 0) + (nativeUsage?.totalTokens ?? 0),
    };
    update(job, {
      stage: 'done',
      progress: 100,
      detail: video.coach === 'bilingual' ? '双语讲解视频已就绪' : '讲解视频已就绪',
      videoId,
      tokens: totalUsage,
      cacheHit: false,
    });
    logger.info('explain video done', {
      videoId,
      shots: shots.length,
      totalMs: video.totalMs,
      coach: video.coach,
      tokTotal: totalUsage.totalTokens,
    });
  } catch (err) {
    clearTimeout(stageTimer);
    const message = (err as Error).message === '__CANCELED__'
      ? '已取消生成'
      : (err as Error).message || '生成失败，请重试';

    // 已经出片了：收尾（补母语轨）失败/超时不能把产物判死，否则用户会重新付一次 token
    if (savedVideo) {
      update(job, {
        stage: 'done',
        progress: 100,
        detail: '讲解视频已就绪（中文讲师轨未完成，可稍后单独补）',
        videoId: savedVideo.videoId,
        tokens: savedVideo.usage,
        cacheHit: false,
      });
      logger.warn('explain video saved but finishing step failed', {
        jobId: job.id,
        videoId: savedVideo.videoId,
        err: message,
      });
      return;
    }

    update(job, { stage: 'error', error: message, progress: 0 });
    logger.warn('explain video job failed', { jobId: job.id, articleId: article.id, err: message });
  }
}

/**
 * 缓存预检：进入页签时先走这里，命中就直接拿视频，不创建 job、不消耗 token。
 * 有正在跑的任务（同一文章 + 同一档位）则带回 jobId，前端续轮询，避免重复提交。
 */
export function resolveExplainVideo(
  articleId: string,
  depth: ExplainDepth = 'medium',
  coach?: CoachMode,
): {
  state: 'cached' | 'running' | 'none';
  videoId?: string;
  job?: ExplainJob;
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** 缓存来自共享层还是个人副本：前端据此区分「别人讲过」与「你之前生成的」 */
  source?: 'shared' | 'personal';
  /** 这条片当前有没有母语讲师轨 */
  hasNative?: boolean;
  /** 请求了双语但缓存只有目标语轨：前端可直接调补轨接口，不必重生成 */
  needsNative?: boolean;
} {
  const userId = currentUserId();
  const article = getDayContentById(articleId);
  if (!article) throw new NotFoundError('这篇精读材料不存在或已失效');
  const { hash } = fingerprint(article, userId, depth);
  const cached = findCachedVideo(userId, article.id, hash);
  if (cached) {
    const hasNative = hasNativeTrack(cached.video);
    return {
      state: 'cached',
      videoId: cached.video.id,
      source: cached.source,
      hasNative,
      needsNative: coach === 'bilingual' && !hasNative,
      tokens: cached.video.meta?.usage ?? ZERO_TOKENS,
    };
  }
  const activeId = inFlight.get(`${article.id}:${depth}`);
  const active = activeId ? jobs.get(activeId) : null;
  if (active && active.stage !== 'error') return { state: 'running', job: active };
  return { state: 'none' };
}

/**
 * 三档的预估 + 是否已有缓存：前端选择器用它显示「约几分钟 / 约多少 token / 已生成」，
 * 把服务端唯一的那份参数（分镜数、字数预算、tokensPerShot）暴露出去，避免前端各抄一份数字。
 */
export function estimateDepths(articleId: string): {
  depths: Array<DepthEstimate & { cached: boolean; videoId?: string; source?: 'shared' | 'personal'; hasNative?: boolean }>;
  level: { label: string; examLabel: string | null; band: string };
  /** 补一条中文讲师轨的估算成本（与档位无关，只跟镜数有关） */
  nativeCost: { tokenLow: number; tokenHigh: number; minutesLow: number; minutesHigh: number };
} {
  const userId = currentUserId();
  const article = getDayContentById(articleId);
  if (!article) throw new NotFoundError('这篇精读材料不存在或已失效');
  const language = inferLanguage(article);
  const base = estimateAllDepths({
    questionCount: article.questions.length,
    bodyChars: article.body.length,
    translationChars: article.translation.length,
    language,
  });
  const depths = base.map((item) => {
    const { hash } = fingerprint(article, userId, item.id);
    const cached = findCachedVideo(userId, article.id, hash);
    return {
      ...item,
      cached: Boolean(cached),
      videoId: cached?.video.id,
      source: cached?.source,
      hasNative: cached ? hasNativeTrack(cached.video) : false,
    };
  });
  const { label, band } = resolveLevelProfile({
    language,
    examLabel: article.examLabel,
    examId: article.examId,
  });
  // 实测（标准档 19 镜）：prompt 1 473 + 输出 4 848 = 6 321，约 340 token/镜。
  // 曾经按 90/镜 给，只有实际值的 1/4，用户会以为补轨几乎不花钱。
  const mediumShots = DEPTH_PLANS.medium.shotsPerQuestion * Math.max(1, article.questions.length) + 2;
  const tokenMid = 600 + mediumShots * 340;
  return {
    depths,
    level: { label, examLabel: article.examLabel ?? null, band },
    nativeCost: {
      tokenLow: Math.round(tokenMid * 0.8),
      tokenHigh: Math.round(tokenMid * 1.3),
      minutesLow: 1,
      minutesHigh: 3,
    },
  };
}

/** 读取完整视频（含分段音频 URL） */
export function getExplainVideo(videoId: string): ExplainVideo {
  const userId = currentUserId();
  const found = readStoredVideo(userId, videoId);
  if (!found) throw new NotFoundError('这个讲解视频不存在或已过期');
  return found.video;
}

/** 按文章取视频摘要列表（含共享层：别人生成过的同篇同级别讲解也在这里） */
export function listExplainVideos(articleId?: string) {
  const all = listVideos(currentUserId());
  return articleId ? all.filter((v) => v.articleId === articleId) : all;
}

/** 读取分段音频 Buffer；track=zh 时读母语轨 */
export function getSegment(videoId: string, index: number, track: 'target' | 'native' = 'target'): Buffer {
  const found = readStoredVideo(currentUserId(), videoId);
  if (!found) throw new NotFoundError('讲解视频不存在');
  if (!Number.isInteger(index) || index < 0 || index >= found.video.shots.length) {
    throw new NotFoundError('分段音频不存在');
  }
  const file = track === 'native'
    ? nativeSegmentPath(found.dir, index)
    : segmentPath(found.dir, index);
  if (!fs.existsSync(file)) {
    throw new NotFoundError(track === 'native' ? '这条讲解还没有中文音轨' : '分段音频不存在');
  }
  return fs.readFileSync(file);
}

/** 保存编辑后的逐字稿（只改 manifest；共享片走 copy-on-write，不影响别人） */
export function saveTranscript(videoId: string, video: ExplainVideo): ExplainVideo {
  const found = readStoredVideo(currentUserId(), videoId);
  if (!found) {
    throw new NotFoundError('讲解视频不存在，无法保存逐字稿');
  }
  // owner 信息属于原片，编辑后可能走个人副本，这里保留原值避免「改一次就变成我的」
  video.meta = { ...(found.video.meta ?? { model: null, scriptVersion: SCRIPT_VERSION }), ...(video.meta ?? {}) };
  video.meta.ownerId = found.video.meta?.ownerId ?? currentUserId();
  if (!updateManifest(currentUserId(), videoId, video)) {
    throw new NotFoundError('讲解视频不存在，无法保存逐字稿');
  }
  return video;
}

export function removeExplainVideo(videoId: string): boolean {
  const userId = currentUserId();
  const found = readStoredVideo(userId, videoId);
  if (!found) throw new NotFoundError('这个讲解视频不存在');
  // 共享片是公共资产：只有生成者能删，别人删会让所有人重新付费生成
  if (found.source === 'shared') {
    const owner = found.video.meta?.ownerId;
    if (owner && owner !== userId) {
      throw new UpstreamError('这是共享讲解，删除会影响其他学员；你可以在自己的副本上改写逐字稿');
    }
  }
  return deleteVideo(userId, videoId);
}

/** 导出任务读取 mp4 路径（由 explainExport 服务生成后写入）；track 区分音轨 */
export function getExportFile(videoId: string, track: ExportTrack = 'target'): string | null {
  const found = readStoredVideo(currentUserId(), videoId);
  if (!found) return null;
  const file = exportPath(found.dir, track);
  return fs.existsSync(file) ? file : null;
}

export function getVideoDir(videoId: string): { video: ExplainVideo; dir: string } | null {
  return readStoredVideo(currentUserId(), videoId);
}
