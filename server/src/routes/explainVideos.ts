/**
 * 解题答疑视频接口（照搬 exam-imports 的 job 轮询范式）。
 *
 *  POST   /api/explain-videos                  { articleId, depth?, force?, coach? } -> { job }
 *  GET    /api/explain-videos/jobs/:id          -> { job }
 *  DELETE /api/explain-videos/jobs/:id          -> 取消
 *  GET    /api/explain-videos/resolve?articleId=&depth=  -> { resolve }（缓存预检）
 *  GET    /api/explain-videos/estimate?articleId=       -> 三档时长/token 预估 + 是否已生成
 *  GET    /api/explain-videos?articleId=...     -> { videos: 摘要[] }
 *  GET    /api/explain-videos/:id               -> ExplainVideo（完整 shots + cues）
 *  PUT    /api/explain-videos/:id/transcript    -> 保存逐字稿（只改文本）
 *  POST   /api/explain-videos/:id/coach         -> 补中文讲师轨（不重跑脚本）
 *  POST   /api/explain-videos/:id/revoice       -> 换音色重配（只跑 TTS，0 token）
 *  GET    /api/explain-videos/:id/seg/:n        -> audio/mpeg（Authorization 头鉴权）
 *  POST   /api/explain-videos/:id/export        { track? } -> { url }（ffmpeg 合成 mp4）
 *  GET    /api/explain-videos/:id/export/file?track=  -> video/mp4 流
 *  DELETE /api/explain-videos/:id
 */
import fs from 'node:fs';
import express, { type Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError, ValidationError } from '../lib/errors';
import type { ExplainVideo } from '../domain/explainVideo';
import {
  cancelExplainJob,
  createExplainJob,
  estimateDepths,
  getExplainJob,
  getExplainVideo,
  getSegment,
  listExplainVideos,
  removeExplainVideo,
  requestCoachTrack,
  requestRevoice,
  resolveExplainVideo,
  saveTranscript,
} from '../services/explainVideo';
import { isExplainDepth } from '../services/explainPedagogy';
import { exportExplainVideo } from '../services/explainExport';
import { getExportFile } from '../services/explainVideo';
import { EXPORT_TRACKS, type ExportTrack } from '../repositories/explainVideos';

export const explainVideosRouter: Router = express.Router();

const DEPTH = z.enum(['short', 'medium', 'long']);
const COACH = z.enum(['target', 'bilingual']);
/** 音轨清单只有仓储层那一份（落盘文件名也归它管），这里不另抄一遍 */
const TRACK = z.enum(EXPORT_TRACKS as [ExportTrack, ...ExportTrack[]]);

const CreateSchema = z.object({
  articleId: z.string().min(1).max(120),
  force: z.boolean().optional(),
  /** 讲解深度：short 精简 / medium 标准 / long 精讲；不传按标准 */
  depth: DEPTH.optional(),
  /** 讲师轨：target 只出目标语（默认，最省 token）/ bilingual 连中文讲师一起出 */
  coach: COACH.optional(),
});

const TranscriptSchema = z.object({
  video: z.object({
    id: z.string().min(1),
    cues: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string().max(2000),
        narration: z.string().max(4000),
        shotIndex: z.number().int().min(0),
        startMs: z.number().finite(),
        endMs: z.number().finite(),
        edited: z.boolean().optional(),
      }),
    ),
  }).passthrough(),
});

explainVideosRouter.post(
  '/explain-videos',
  asyncHandler(async (req, res) => {
    const body = parseBody(CreateSchema, req.body ?? {});
    const job = createExplainJob(body);
    res.status(202).json({ job });
  }),
);

explainVideosRouter.get(
  '/explain-videos/jobs/:id',
  asyncHandler(async (req, res) => {
    const job = getExplainJob(req.params.id);
    if (!job) throw new NotFoundError('这次讲解生成任务不存在或已过期');
    res.json({ job });
  }),
);

explainVideosRouter.delete(
  '/explain-videos/jobs/:id',
  asyncHandler(async (req, res) => {
    const ok = cancelExplainJob(req.params.id);
    res.json({ ok });
  }),
);

/** 进入页签先预检缓存：命中直接秒开，不创建 job、不消耗 token */
explainVideosRouter.get(
  '/explain-videos/resolve',
  asyncHandler(async (req, res) => {
    const articleId = typeof req.query.articleId === 'string' ? req.query.articleId : '';
    if (!articleId) throw new ValidationError('缺少 articleId');
    const depthRaw = typeof req.query.depth === 'string' ? req.query.depth : '';
    const depth = isExplainDepth(depthRaw) ? depthRaw : 'medium';
    const coachRaw = typeof req.query.coach === 'string' ? req.query.coach : '';
    const coach = coachRaw === 'bilingual' ? 'bilingual' : undefined;
    res.json({ resolve: resolveExplainVideo(articleId, depth, coach) });
  }),
);

/** 三档的时长 / token 预估 + 是否已生成：面板的选择器直接用，避免前端另抄一份参数 */
explainVideosRouter.get(
  '/explain-videos/estimate',
  asyncHandler(async (req, res) => {
    const articleId = typeof req.query.articleId === 'string' ? req.query.articleId : '';
    if (!articleId) throw new ValidationError('缺少 articleId');
    res.json(estimateDepths(articleId));
  }),
);

explainVideosRouter.get(
  '/explain-videos',
  asyncHandler(async (req, res) => {
    const articleId = typeof req.query.articleId === 'string' ? req.query.articleId : undefined;
    res.json({ videos: listExplainVideos(articleId) });
  }),
);

// 注意：/jobs/:id 与 /:id 冲突风险由注册顺序规避（job 路由已先注册）
explainVideosRouter.get(
  '/explain-videos/:id',
  asyncHandler(async (req, res) => {
    res.json({ video: getExplainVideo(req.params.id) });
  }),
);

explainVideosRouter.put(
  '/explain-videos/:id/transcript',
  asyncHandler(async (req, res) => {
    const body = parseBody(TranscriptSchema, req.body ?? {});
    if (body.video.id !== req.params.id) throw new ValidationError('视频 id 与路径不一致');
    const existing = getExplainVideo(req.params.id);
    const merged: ExplainVideo = {
      ...existing,
      cues: body.video.cues as ExplainVideo['cues'],
      updatedAt: new Date().toISOString(),
    };
    res.json({ video: saveTranscript(req.params.id, merged) });
  }),
);

/**
 * 给已有讲解补中文讲师轨：不重跑脚本，只做「转述 + 中文配音」。
 * 这是「切中文讲师」时的低成本路径——纯目标语版先出，真需要母语再补这一条轨。
 */
explainVideosRouter.post(
  '/explain-videos/:id/coach',
  asyncHandler(async (req, res) => {
    const job = requestCoachTrack(req.params.id);
    res.status(202).json({ job });
  }),
);

const RevoiceSchema = z.object({
  /** Edge Neural 音色名；不传则用当前用户在该语种「文章讲解」场景配的音色 */
  voice: z.string().min(3).max(80).optional(),
});

/**
 * 换音色重配：旁白文本一个字都不改，只换个人念，所以不调大模型、token 为 0。
 * 共享片会先落成个人副本再写音频，不会改到别人的讲解。
 */
explainVideosRouter.post(
  '/explain-videos/:id/revoice',
  asyncHandler(async (req, res) => {
    const body = parseBody(RevoiceSchema, req.body ?? {});
    const job = requestRevoice(req.params.id, body.voice);
    res.status(202).json({ job });
  }),
);

explainVideosRouter.get(
  '/explain-videos/:id/seg/:n',
  asyncHandler(async (req, res) => {
    const index = Number(req.params.n);
    if (!Number.isInteger(index) || index < 0) throw new ValidationError('分段序号不合法');
    const track = req.query.track === 'zh' ? 'native' : 'target';
    const buffer = getSegment(req.params.id, index, track);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(buffer);
  }),
);

const ExportSchema = z.object({
  /**
   * target 原文音轨 / native 中文讲师音轨 / both 同一容器两条音轨（播放器可切语言）。
   * 不传沿用最早的「只导出原文音轨」行为，老调用方不必改。
   */
  track: TRACK.optional(),
});

/**
 * body 里传错音轨名一律 400（写代码的人应该立刻看到拼错了）；
 * query 里传错则回落 target（分享出去的链接不该因为参数脏就整条打不开）。
 */
function parseTrack(raw: unknown): ExportTrack {
  return typeof raw === 'string' && (EXPORT_TRACKS as readonly string[]).includes(raw)
    ? (raw as ExportTrack)
    : 'target';
}

explainVideosRouter.post(
  '/explain-videos/:id/export',
  asyncHandler(async (req, res) => {
    const body = parseBody(ExportSchema, req.body ?? {});
    const track = parseTrack(body.track);
    await exportExplainVideo(req.params.id, track);
    res.json({
      url: `/api/explain-videos/${encodeURIComponent(req.params.id)}/export/file?track=${track}`,
      track,
    });
  }),
);

explainVideosRouter.get(
  '/explain-videos/:id/export/file',
  asyncHandler(async (req, res) => {
    const track = parseTrack(req.query.track);
    const file = getExportFile(req.params.id, track);
    if (!file || !fs.existsSync(file)) throw new NotFoundError('还没有导出过这个视频，请先点导出');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(file).pipe(res);
  }),
);

explainVideosRouter.delete(
  '/explain-videos/:id',
  asyncHandler(async (req, res) => {
    const ok = removeExplainVideo(req.params.id);
    if (!ok) throw new NotFoundError('这个讲解视频不存在');
    res.json({ ok: true });
  }),
);
