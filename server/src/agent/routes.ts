/**
 * /api/agent/* —— 同进程挂载，但前缀独立。
 *
 * 前缀独立不是为了好看：将来要把 Agent 拆成独立进程时，
 * 反代上把这个前缀整体转发过去就行，前端与主站都不用动。
 */
import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors';
import { asyncHandler, parseBody } from '../lib/http';
import { logger } from '../lib/logger';
import { resolveTtsFile } from './adapters/media';
import { getAgentRuntime, reloadAgentRuntime } from './adapters/inprocess';
import { runAgent } from './core';
import { LearnerPatchSchema, type AgentRun } from './protocols';
import type { LangCode } from './types';

export const agentRouter = Router();

const RunSchema = z.object({
  lang: z.enum(['en', 'ja', 'ko']).default('en'),
  mode: z.enum(['ask', 'craft', 'coach']).default('craft'),
  query: z.string().max(2000).optional(),
  text: z.string().max(20_000).optional(),
  exam: z.string().max(40).optional(),
  scene: z.string().max(40).optional(),
  /** 阅读类场景必填：讲解视频按文章生成 */
  articleId: z.string().max(120).optional(),
  helpLevel: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
  userId: z.string().max(60).default('local'),
});

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
    req.on('close', () => controller.abort());

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      for await (const event of runAgent({ ...input, signal: controller.signal }, runtime)) {
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

    for await (const event of runAgent(input, runtime)) {
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

    logger.info('agent 产物采纳', {
      runId: run.runId,
      artifactId: artifact.artifactId,
      confirmed: input.confirm,
      attached: attach.attached,
      rules: ruleIds.size,
    });

    res.json({
      confirm: input.confirm,
      attached: attach.attached,
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
