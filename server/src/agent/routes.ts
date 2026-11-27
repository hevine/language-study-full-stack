/**
 * /api/agent/* —— 同进程挂载，但前缀独立。
 *
 * 前缀独立不是为了好看：将来要把 Agent 拆成独立进程时，
 * 反代上把这个前缀整体转发过去就行，前端与主站都不用动。
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../auth/requestScope';
import { adoptToLoop } from '../loop/store';
import type { DerivedCard } from '../loop/types';
import { AppError, NotFoundError, UpstreamError, ValidationError } from '../lib/errors';
import { asyncHandler, parseBody } from '../lib/http';
import { logger } from '../lib/logger';
import {
  deleteAgentAudio,
  languageOf,
  MAX_AUDIO_BYTES,
  patchAgentAudioDuration,
  readAgentAudioBytes,
  saveAgentAudio,
  writeAgentProsody,
  AUDIO_SOURCES,
} from '../services/agentAudio';
import { transcribeAudio } from '../services/asr';
import { measureProsody } from '../services/speechTiming';
import { spokenUnitCount } from './adapters/units';
import { resolveTtsFile } from './adapters/media';
import { getAgentRuntime, reloadAgentRuntime } from './adapters/inprocess';
import { runAgent, type AgentRequest } from './core';
import { LearnerPatchSchema, type AgentRun } from './protocols';
import { SessionOrchestrator } from './session/orchestrator';
import type { LangCode } from './types';

export const agentRouter = Router();

// ---------------------------------------------------------------------------
// Session 路由（多任务编排）
// ---------------------------------------------------------------------------

let orchestrator: SessionOrchestrator | null = null;

function getOrchestrator(): SessionOrchestrator {
  if (!orchestrator) orchestrator = new SessionOrchestrator(getAgentRuntime());
  return orchestrator;
}

const EnqueueSchema = z.object({
  query: z.string().max(2000).optional(),
  text: z.string().max(20_000).optional(),
  mode: z.enum(['ask', 'craft', 'coach']).default('craft'),
  scene: z.string().max(40).optional(),
  exam: z.string().max(40).optional(),
  articleId: z.string().max(120).optional(),
  helpLevel: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
  audioRef: z.string().max(100_000).optional(),
});

agentRouter.post(
  '/agent/sessions',
  asyncHandler(async (req, res) => {
    const lang = (req.body?.lang ?? 'en') as string;
    const sessionId = getOrchestrator().createSession(currentUserId(), lang as LangCode);
    res.json({ sessionId });
  }),
);

agentRouter.post(
  '/agent/sessions/:id/enqueue',
  asyncHandler(async (req, res) => {
    const input = parseBody(EnqueueSchema, req.body ?? {});
    const taskIds = getOrchestrator().enqueue(req.params.id, input);
    res.json({ taskIds });
  }),
);

agentRouter.get(
  '/agent/sessions/:id',
  asyncHandler(async (req, res) => {
    const state = getOrchestrator().getSession(req.params.id);
    if (!state) throw new NotFoundError('session 不存在');
    res.json({
      tasks: state.tasks.map((t) => ({ id: t.id, sceneId: t.sceneId, status: t.status })),
    });
  }),
);

agentRouter.post(
  '/agent/sessions/:id/run',
  asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      for await (const event of getOrchestrator().run(req.params.id)) {
        send(event);
      }
    } catch (err) {
      logger.warn('session run 失败', { err: (err as Error).message });
      send({ type: 'error', message: (err as Error).message });
    } finally {
      res.write('event: end\ndata: [DONE]\n\n');
      res.end();
    }
  }),
);

const RunSchema = z.object({
  lang: z.enum(['en', 'ja', 'ko']).default('en'),
  mode: z.enum(['ask', 'craft', 'coach']).default('craft'),
  query: z.string().max(2000).optional(),
  text: z.string().max(20_000).optional(),
  exam: z.string().max(40).optional(),
  scene: z.string().max(40).optional(),
  /** 阅读类场景必填：讲解视频按文章生成 */
  articleId: z.string().max(120).optional(),
  /** 口语场景：先 POST /agent/audio 拿到 audioRef，再带上来 */
  audioRef: z.string().max(80).optional(),
  audioName: z.string().max(160).optional(),
  audioDurationMs: z.number().nonnegative().optional(),
  audioSource: z.enum(AUDIO_SOURCES).optional(),
  /** 文本来源：手打 / 转写 / 转写后改过 —— 决定口语工具要不要重新转写 */
  transcriptSource: z.enum(['typed', 'asr', 'asr-edited']).optional(),
  helpLevel: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
  userId: z.string().max(60).default('local'),
});

type RunInput = z.infer<typeof RunSchema>;

/** 把 HTTP 入参摊平成内核请求：audio 的散字段在这里收成一个对象，内核只认一个 audioRef */
function toAgentRequest(input: RunInput): AgentRequest {
  return {
    userId: input.userId,
    lang: input.lang,
    mode: input.mode,
    query: input.query,
    text: input.text,
    exam: input.exam,
    scene: input.scene,
    articleId: input.articleId,
    helpLevel: input.helpLevel,
    audioRef: input.audioRef,
    transcriptSource: input.transcriptSource,
    audio: input.audioRef
      ? { name: input.audioName, durationMs: input.audioDurationMs, source: input.audioSource }
      : undefined,
  };
}

/** 场景与能力清单：前端据此决定显示哪些入口，不支持的语种直接不出现 */
agentRouter.get(
  '/agent/scenes',
  asyncHandler(async (_req, res) => {
    const runtime = getAgentRuntime();
    res.json({
      scenes: runtime.scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        version: scene.version,
        category: scene.category,
        modes: scene.modes,
        artifacts: scene.artifacts,
        tools: scene.tools,
        requires: scene.lang.requires,
        exams: scene.lang.exams,
        helpDefault: scene.helpDefault,
      })),
      langs: [...runtime.langs.values()].map((pack) => ({
        code: pack.code,
        name: pack.name,
        scale: pack.levelScale.id,
        bands: pack.levelScale.bands,
        supported: pack.supported,
        unsupported: pack.unsupported,
        /** 有语言包 ≠ 有能力：日语现在只有包，没有分词与规则集 */
        ready: Boolean(runtime.deps.language(pack.code)),
      })),
      tools: runtime.registry.list().map((tool) => ({ name: tool.name, cost: tool.cost, idempotent: tool.idempotent })),
    });
  }),
);

agentRouter.get(
  '/agent/health',
  asyncHandler(async (_req, res) => {
    const runtime = getAgentRuntime();
    res.json({ ok: true, scenes: runtime.scenes.length, tools: runtime.registry.list().length });
  }),
);

/** 场景包 / 语言包改了不用重启 */
agentRouter.post(
  '/agent/reload',
  asyncHandler(async (_req, res) => {
    const runtime = reloadAgentRuntime();
    res.json({ ok: true, scenes: runtime.scenes.length, langs: [...runtime.langs.keys()] });
  }),
);

/**
 * SSE 主入口：边跑边推，每步都让用户看见。
 * 一次安静 20 秒的等待会被当成卡死，所以中间状态必须流式出来。
 */
agentRouter.post(
  '/agent/run',
  asyncHandler(async (req, res) => {
    const input = parseBody(RunSchema, req.body ?? {});
    const runtime = getAgentRuntime();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const controller = new AbortController();
    // 只监听响应侧：POST 的 req 'close' 在请求体读完时就会触发，
    // 拿它当中断信号会让 Agent 刚启动就把每一步标成「已中断」。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      for await (const event of runAgent({ ...toAgentRequest(input), signal: controller.signal }, runtime)) {
        send(event);
      }
    } catch (err) {
      logger.warn('agent run 失败', { err: (err as Error).message });
      send({ type: 'error', message: (err as Error).message });
    } finally {
      res.write('event: end\ndata: [DONE]\n\n');
      res.end();
    }
  }),
);

/** 同步入口：给评测脚本与排查用（SSE 不方便跑断言） */
agentRouter.post(
  '/agent/run/sync',
  asyncHandler(async (req, res) => {
    const input = parseBody(RunSchema, req.body ?? {});
    const runtime = getAgentRuntime();

    const events: unknown[] = [];
    let run: AgentRun | null = null;
    let clarification: unknown = null;
    let error: string | null = null;

    for await (const event of runAgent(toAgentRequest(input), runtime)) {
      events.push(event);
      if (event.type === 'done') run = event.run;
      if (event.type === 'clarify') clarification = event;
      if (event.type === 'error') error = event.message;
    }

    res.json({ run, clarification, error, events: events.length });
  }),
);

agentRouter.get(
  '/agent/runs',
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit ?? 20);
    const runtime = getAgentRuntime();
    res.json({ runs: await runtime.deps.trace.list(Number.isFinite(limit) ? limit : 20) });
  }),
);

agentRouter.get(
  '/agent/runs/:id',
  asyncHandler(async (req, res) => {
    const runtime = getAgentRuntime();
    const run = await runtime.deps.trace.load(req.params.id);
    if (!run) throw new NotFoundError('找不到这次 run 的记录');
    res.json({ run });
  }),
);

// ---------------------------------------------------------------------------
// 采纳：Agent 与真实学习进度的接缝
// ---------------------------------------------------------------------------

const AdoptSchema = z.object({
  runId: z.string().min(3),
  artifactId: z.string().min(3),
  /** YYYY-MM-DD；缺省今天 */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  taskId: z.string().max(40).optional(),
  userId: z.string().max(60).default('local'),
  /** false = 只预览会写什么，不落盘（对应界面上先给 diff 再确认） */
  confirm: z.boolean().default(true),
});

/**
 * 采纳一份产物。
 *
 * 为什么采纳要单独一个接口，而不是在 run 结束时自动挂载：
 * 「产物被采纳」是北极星指标的计数点。让 Agent 自己挂上去，
 * 等于每跑一次就算学了一次，指标立刻失去意义。
 * 采纳 = 用户看完表示了同意，这时候才该写任务、写错因库。
 */
agentRouter.post(
  '/agent/adopt',
  asyncHandler(async (req, res) => {
    const input = parseBody(AdoptSchema, req.body ?? {});
    const runtime = getAgentRuntime();

    const run = await runtime.deps.trace.load(input.runId);
    if (!run) throw new NotFoundError('找不到这次 run 的记录，无法采纳');

    const artifact = run.artifacts.find((item) => item.artifactId === input.artifactId);
    if (!artifact) throw new NotFoundError('这次 run 里没有这个产物');

    const scene = runtime.scenes.find((item) => `${item.id}@${item.version}` === run.scene);

    // 错因从产物本身推导，而不是信任前端回传的补丁 —— 否则用户可以伪造「我很弱」骗过诊断
    const ruleIds = new Set<string>();
    const data = artifact.data as { items?: Array<{ ruleId?: string }> };
    for (const item of data.items ?? []) if (item.ruleId) ruleIds.add(item.ruleId);

    let patch: {
      applied: boolean;
      added: string[];
      promoted: string[];
      pending?: Array<{ op: string; detail: string }>;
    } | null = null;

    if (ruleIds.size > 0) {
      const learnerPatch = LearnerPatchSchema.parse({
        patchId: `p_${run.runId}_adopt`,
        userId: input.userId,
        lang: run.lang as LangCode,
        scope: 'errors',
        ops: [...ruleIds].map((ruleId) => ({ op: 'inc', ruleId, evidence: run.runId })),
        requiresConfirm: true,
        reversible: true,
      });
      patch = await runtime.deps.store.applyPatch(learnerPatch, { confirm: input.confirm });
    }

    // 预览也要跑一遍落点计算（dryRun），否则用户是在盲签：只看得到「会写入错因」，
    // 看不到会挂到哪条任务。真正写库仍然只在 confirm=true 时发生。
    const attach = await runtime.deps.tasks.attachArtifact({
      userId: input.userId,
      date: input.date,
      taskId: input.taskId,
      category: scene?.category,
      dryRun: !input.confirm,
      artifact: {
        artifactId: artifact.artifactId,
        type: artifact.type,
        title: artifact.title,
        scene: run.scene,
        runId: run.runId,
      },
    });

    // 产物 → 复习卡：与任务、错因库并列的一次写入。
    // 卡片写失败不能让「采纳」整体失败 —— 用户已经确认过了，任务与错因更重要。
    let cards: { preview: DerivedCard[]; created: number } = { preview: [], created: 0 };
    try {
      cards = adoptToLoop({
        userId: scopedUserId(input.userId),
        run,
        artifact,
        confirm: input.confirm,
      });
    } catch (err) {
      logger.warn('loop 卡片写入失败', {
        artifactId: input.artifactId,
        error: (err as Error).message,
      });
    }

    logger.info('agent 产物采纳', {
      runId: run.runId,
      artifactId: artifact.artifactId,
      confirmed: input.confirm,
      attached: attach.attached,
      rules: ruleIds.size,
      cards: cards.created,
    });

    res.json({
      confirm: input.confirm,
      attached: attach.attached,
      cards,
      taskId: attach.taskId ?? null,
      taskTitle: attach.taskTitle ?? null,
      reason: attach.reason ?? null,
      patch,
      /**
       * 闭环判定：产物挂进任务 + 错因进了复诊队列。
       * 只有 confirm=true 时才可能为 true —— 预览不该计分。
       */
      closedLoop: Boolean(input.confirm && attach.attached),
    });
  }),
);

// ---------------------------------------------------------------------------
// 口语录音：上传 / 转写 / 试听 / 丢弃
//
// 为什么把「存」和「转写」拆成两步：
// 转写依赖号池，可能全部线路失败。这时音频已经安全落在服务端，
// 用户只需要重试转写，不该被逼着重录一遍 —— 录音笔里那段可能已经删了。
// ---------------------------------------------------------------------------

const AUDIO_MIME: Record<string, string> = {
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  amr: 'audio/amr',
};

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

agentRouter.post(
  '/agent/audio',
  express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }),
  asyncHandler(async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ValidationError('没有收到录音内容，请确认麦克风已经录到声音');
    }
    if (body.length > MAX_AUDIO_BYTES) throw new ValidationError('录音超过 25MB 上限，请截取更短的一段');

    const rawSource = queryString(req.query.source);
    const source = rawSource && (AUDIO_SOURCES as readonly string[]).includes(rawSource)
      ? (rawSource as (typeof AUDIO_SOURCES)[number])
      : undefined;
    const durationMs = Number(req.query.durationMs);

    const audio = saveAgentAudio(body, {
      name: queryString(req.query.name),
      lang: queryString(req.query.lang) ?? 'en',
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      source,
      mime: req.headers['content-type'],
    });
    res.status(201).json({ audio });
  }),
);

agentRouter.post(
  '/agent/audio/:id/transcribe',
  asyncHandler(async (req, res) => {
    const found = readAgentAudioBytes(req.params.id);
    if (!found) throw new NotFoundError('这段录音已经不在了，重新录一段，或者把文字贴进来');

    const lang = languageOf(queryString(req.body?.lang) ?? found.meta.lang);
    try {
      // withTiming：界面上这一次转写就该把时间戳/节奏一起拿到，
      // 否则 run 里还要为同一段音频再识别或再解码一次
      const result = await transcribeAudio(found.buffer, lang, found.fileName, { withTiming: true });
      const measurement = await measureProsody({
        buffer: found.buffer,
        text: result.text,
        words: result.words,
        segments: result.segments,
        claimedDurationMs: result.durationMs ?? found.meta.durationMs,
        // 日语的「说了多少」是モーラ，不是词；数错了整份语速都会失真
        wordCount: await spokenUnitCount(result.text, lang),
      });
      if (measurement) {
        writeAgentProsody(found.meta.audioId, measurement);
        patchAgentAudioDuration(found.meta.audioId, measurement.durationMs);
      }
      res.json({
        audio: found.meta,
        transcript: result.text,
        line: result.line,
        model: result.model,
        prosody: measurement ?? null,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new UpstreamError((err as Error).message || '语音识别失败');
    }
  }),
);

agentRouter.get(
  '/agent/audio/:id',
  asyncHandler(async (req, res) => {
    const found = readAgentAudioBytes(req.params.id);
    if (!found) throw new NotFoundError('这段录音已经不在了');
    res.setHeader('Content-Type', AUDIO_MIME[found.meta.ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(found.buffer);
  }),
);

agentRouter.delete(
  '/agent/audio/:id',
  asyncHandler(async (req, res) => {
    res.json({ ok: deleteAgentAudio(req.params.id) });
  }),
);

// ---------------------------------------------------------------------------
// 媒体
// ---------------------------------------------------------------------------

const TtsSchema = z.object({
  text: z.string().min(1).max(3000),
  lang: z.enum(['en', 'ja', 'ko']).default('en'),
  voice: z.string().max(80).optional(),
  rate: z.number().min(0.5).max(1.4).optional(),
});

/** 任意句子的朗读：点一句听一句，是最便宜也最高频的媒体能力 */
agentRouter.post(
  '/agent/media/tts',
  asyncHandler(async (req, res) => {
    const input = parseBody(TtsSchema, req.body ?? {});
    const runtime = getAgentRuntime();
    const result = await runtime.deps.media.tts(input);
    res.json(result);
  }),
);

agentRouter.get(
  '/agent/media/tts/:file',
  asyncHandler(async (req, res) => {
    const file = resolveTtsFile(req.params.file);
    if (!file) throw new NotFoundError('音频不存在或已过期');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  }),
);

/** 讲解视频作业进度。前端拿到 artifact 里的 pollUrl 后轮这儿 */
agentRouter.get(
  '/agent/media/explain/:jobId',
  asyncHandler(async (req, res) => {
    const runtime = getAgentRuntime();
    const state = await runtime.deps.media.explainVideo.poll({ jobId: req.params.jobId });
    if (state.state === 'error' && state.error === 'job_not_found') {
      throw new NotFoundError('这次讲解作业不存在或已过期');
    }
    res.json(state);
  }),
);

/** 登录时以会话为准；游客保留请求里的 userId（默认 local），兼容单机用法 */
function scopedUserId(fallback: string): string {
  const scoped = currentUserId();
  return scoped === 'local' ? fallback : scoped;
}
