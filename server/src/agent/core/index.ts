/**
 * 内核编排：把 ①感知 → ②路由 → ③规划 → ④执行 → ⑤校验 → ⑥沉淀 串成一条事件流。
 *
 * 之所以做成 AsyncGenerator 而不是普通函数：SSE 要边跑边推，
 * 「第 2 步正在跑」这种中间状态对用户信任极其重要 —— 一次安静 20 秒的等待会被当成卡死。
 */
import { logger } from '../../lib/logger';
import { sceneSupport, type LanguagePack } from '../lang/loader';
import type { AgentDeps } from '../ports';
import { AgentRunSchema, type AgentRun, type Artifact, type RunStep, type VerifyReport } from '../protocols';
import type { ScenePack } from '../scenes/loader';
import type { Bag, HelpLevel, LangCode, RunMode } from '../types';
import type { ToolContext, ToolRegistry } from '../tools/registry';
import { runStep } from './executor';
import { plan } from './planner';
import { route } from './router';
import { verify } from './verifier';

export interface AgentRequest {
  userId: string;
  lang: LangCode;
  mode: RunMode;
  query?: string;
  text?: string;
  exam?: string;
  scene?: string;
  /** 阅读类场景的输入实体：讲解视频按文章生成，不是一个 articleId 就够不成活 */
  articleId?: string;
  /** 口语场景的录音：录音仓里的 audioId，转写交给 speak.asr（内核不碰字节） */
  audioRef?: string;
  /** 录音元信息，只进 trace 与界面说明，不参与推理 */
  audio?: { name?: string; durationMs?: number; source?: string };
  /** 文本是从哪来的：手打 / 录音转写 / 转写后改过 —— 决定 speak.asr 要不要重新转写 */
  transcriptSource?: 'typed' | 'asr' | 'asr-edited';
  helpLevel?: HelpLevel;
  signal?: AbortSignal;
}

export interface AgentRuntime {
  deps: AgentDeps;
  registry: ToolRegistry;
  scenes: ScenePack[];
  langs: Map<LangCode, LanguagePack>;
}

export type AgentEvent =
  | { type: 'start'; runId: string; scene: string; confidence: number; steps: string[]; needsPreview: boolean }
  | { type: 'step'; step: RunStep }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'verify'; report: VerifyReport }
  | { type: 'done'; run: AgentRun }
  | { type: 'clarify'; message: string; candidates: Array<{ id: string; title: string }> }
  | { type: 'error'; message: string };

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function* runAgent(
  req: AgentRequest,
  runtime: AgentRuntime,
  options?: { initialBag?: Bag },
): AsyncGenerator<AgentEvent> {
  const { deps, registry, scenes, langs } = runtime;
  const runId = newRunId();

  // ② 路由
  const routed = route({ query: req.query, text: req.text, scene: req.scene, mode: req.mode }, scenes);
  if (!routed.scene) {
    yield { type: 'clarify', message: routed.clarify ?? '能说得具体点吗？', candidates: routed.candidates };
    return;
  }
  const scene = routed.scene;

  // 语种能力检查：不支持就明确说理由，不硬跑（设计文档 §7.5）
  const pack = langs.get(req.lang) ?? null;
  const support = sceneSupport(pack, scene.category);
  if (!support.ok) {
    yield { type: 'error', message: support.reason };
    return;
  }
  if (scene.lang.requires.length > 0 && !deps.language(req.lang)) {
    yield {
      type: 'error',
      message: `${pack?.name ?? req.lang} 的语言能力（分词 / 句法 / 错误体系）还没接通，这个场景现在只能登记、不能执行。`,
    };
    return;
  }

  // ③ 规划
  const planned = plan(scene, registry, req.lang);
  if (planned.steps.length === 0) {
    yield { type: 'error', message: `场景「${scene.title}」没有可用的工具（检查工具是否已注册、语种是否支持）` };
    return;
  }

  const helpLevel = req.helpLevel ?? scene.helpDefault;

  // ① 感知：先读档案做上下文摘要（profile.read 工具随后还会读一次，幂等且便宜）
  let digest: AgentRun['contextDigest'] = { topErrors: [], helpLevel };
  try {
    const profile = await deps.store.read({ userId: req.userId, lang: req.lang, topN: 5 });
    digest = {
      level: `${profile.level.scale} ${profile.level.band}`,
      daysLeft: profile.daysLeft,
      topErrors: profile.topErrors.slice(0, 5).map((item) => `${item.ruleId}×${item.count}`),
      helpLevel,
    };
  } catch (err) {
    logger.warn('读取档案失败，按空档案继续', { runId, err: (err as Error).message });
  }

  yield {
    type: 'start',
    runId,
    scene: `${scene.id}@${scene.version}`,
    confidence: routed.confidence,
    steps: planned.steps.map((step) => step.tool),
    needsPreview: planned.needsPreview,
  };

  const bag: Bag = options?.initialBag ? { ...options.initialBag } : {};
  const runSteps: RunStep[] = [];
  const artifacts: Artifact[] = [];
  let usedTokens = 0;
  let artSeq = 0;

  const baseCtx: Omit<ToolContext, 'bag' | 'nextArtifactId' | 'log'> = {
    lang: req.lang,
    userId: req.userId,
    runId,
    helpLevel,
    sceneRules: scene.rules,
    ruleIds: pack?.errors.map((rule) => rule.id) ?? [],
    deps,
    signal: req.signal,
  };

  for (const step of planned.steps) {
    const tool = registry.get(step.tool);
    if (!tool) continue;

    const record: RunStep = { n: step.n, tool: step.tool, status: 'running', ms: 0, tokens: 0, ok: true };
    runSteps.push(record);
    yield { type: 'step', step: { ...record } };

    if (req.signal?.aborted) {
      record.status = 'skipped';
      record.summary = '已中断';
      yield { type: 'step', step: { ...record } };
      continue;
    }
    if (usedTokens >= scene.budget.maxTokens) {
      record.status = 'skipped';
      record.summary = `超出预算（已用 ${usedTokens} / ${scene.budget.maxTokens}）`;
      yield { type: 'step', step: { ...record } };
      continue;
    }

    const ctx: ToolContext = {
      ...baseCtx,
      bag,
      nextArtifactId: (type) => {
        artSeq += 1;
        return `art_${type}_${artSeq}`;
      },
      log: (message, fields) => logger.info(message, { runId, tool: step.tool, ...fields }),
    };

    const result = await runStep({
      step,
      tool,
      ctx,
      args: {
        text: req.text ?? req.query ?? '',
        exam: req.exam,
        articleId: req.articleId,
        // 口语场景要口语的评分标准：不传 kind 就会拿写作 rubric 去评口语（雅思「任务完成度」评口语毫无意义）
        kind: scene.category === 'speaking' ? 'speak' : 'write',
        // 口语工具靠这两项决定「用稿还是转写」：有稿就不该再花一次识别
        audioRef: req.audioRef,
        transcriptSource: req.transcriptSource,
        audioDurationMs: req.audio?.durationMs,
      },
    });

    record.ms = result.ms;
    record.tokens = result.tokens;
    record.ok = result.status === 'done';
    record.status = result.status === 'done' ? 'done' : 'failed';
    record.error = result.error;
    record.summary = result.outcome?.summary;
    usedTokens += result.tokens;

    if (result.outcome) {
      // 统一按工具名做黑板键：工具之间靠它传参，M1 换成显式参数槽
      bag[step.tool] = result.outcome.data;
      for (const artifact of result.outcome.artifacts ?? []) {
        artifacts.push(artifact);
      }
    }

    yield { type: 'step', step: { ...record } };
    for (const artifact of result.outcome?.artifacts ?? []) {
      yield { type: 'artifact', artifact };
    }
  }

  // ⑤ 校验
  const ruleData = bag['gra.rules'] as { count?: number } | undefined;
  const report = verify({
    artifacts,
    ruleIds: pack?.errors.map((rule) => rule.id) ?? [],
    ruleHits: ruleData?.count ?? 0,
  });
  yield { type: 'verify', report };

  // ⑥ 沉淀
  const failed = runSteps.filter((item) => item.status === 'failed');
  const run: AgentRun = AgentRunSchema.parse({
    runId,
    mode: req.mode,
    scene: `${scene.id}@${scene.version}`,
    lang: req.lang,
    userId: req.userId,
    input: {
      text: (req.text ?? '').slice(0, 2000),
      exam: req.exam,
      query: req.query,
      articleId: req.articleId,
      // 录音只留 id 与时长：trace 会被别人点开回放，不该塞一份音频进去
      audio: req.audioRef
        ? { audioRef: req.audioRef, ...(req.audio ?? {}), transcriptSource: req.transcriptSource ?? null }
        : undefined,
    },
    contextDigest: digest,
    steps: runSteps,
    verify: report,
    artifacts,
    budget: { usedTokens, limit: scene.budget.maxTokens },
    startedAt: new Date(Date.now() - runSteps.reduce((sum, item) => sum + item.ms, 0)).toISOString(),
    finishedAt: new Date().toISOString(),
    ok: failed.length === 0,
    error: failed.length ? failed.map((item) => `${item.tool}: ${item.error ?? '失败'}`).join('; ') : undefined,
  });

  try {
    await deps.trace.save(run);
  } catch (err) {
    logger.warn('run trace 落盘失败（不影响本次结果）', { runId, err: (err as Error).message });
  }

  yield { type: 'done', run };
}
