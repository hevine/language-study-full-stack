/**
 * ④ 执行：单步执行器（循环与事件流在 core/index.ts）。
 *
 * 两条硬规则：
 * - 每步都有超时，绝不无限等（一次挂死的 TTS 会锁住整个 run）；
 * - 只对幂等工具重试。非幂等工具重试会造成重复扣费 / 重复写入。
 */
import { env } from '../../config/env';
import type { ToolOutcome, ToolContext, ToolDef } from '../tools/registry';
import type { PlannedStep } from './planner';

export interface StepResult {
  status: 'done' | 'failed';
  ms: number;
  tokens: number;
  outcome?: ToolOutcome;
  error?: string;
}

/** 本地确定性工具（规则扫描、档案读取）很快，30s 已经是很宽松的上限 */
const LOCAL_TIMEOUT_MS = 30_000;

/**
 * LLM 工具的超时必须**长于** LLM 层的总重试时间。
 *
 * 踩过两次坑：
 * 1. 内核原来一律 30s，而 llm 层单次超时是 90s —— 模型刚跑到第 30 秒就被内核掐断，
 *    多线路故障切换根本没机会发生，明明能成功的调用在 trace 里显示成「超时」。
 * 2. 改成 105s 后仍失败：号池有 7 条线路，一条 90s 超时后还会换下一条，
 *    单步的真实耗时是「各线路之和」，不是一个 LLM_TIMEOUT_MS。
 *
 * 所以这里按「一次换线」留够：env.llm.timeoutMs × 2 + 余量。
 * 超过这个仍然失败，说明是模型/线路本身的问题，不该靠无限等下去掩盖。
 */
const LLM_TIMEOUT_MS = env.llm.timeoutMs * 2 + 15_000;

function timeoutFor(tool: ToolDef, override?: number): number {
  if (override) return override;
  // 声明了 token 成本 = 它要调模型；这类工具让位给 LLM 层超时
  return (tool.cost.tokens ?? 0) > 0 ? LLM_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
}

function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function runStep(input: {
  step: PlannedStep;
  tool: ToolDef;
  ctx: ToolContext;
  args: unknown;
  timeoutMs?: number;
}): Promise<StepResult> {
  const { tool, ctx } = input;
  const timeoutMs = timeoutFor(tool, input.timeoutMs);
  const started = Date.now();
  const attempt = tool.idempotent ? 2 : 1;

  let lastError: unknown;
  for (let i = 0; i < attempt; i += 1) {
    if (ctx.signal?.aborted) {
      return { status: 'failed', ms: Date.now() - started, tokens: 0, error: '已中断' };
    }
    try {
      const outcome = await withTimeout(tool.run(input.args, ctx), timeoutMs, tool.name);
      return {
        status: 'done',
        ms: Date.now() - started,
        tokens: outcome.tokens ?? tool.cost.tokens ?? 0,
        outcome,
      };
    } catch (err) {
      lastError = err;
      ctx.log('工具执行失败', { tool: tool.name, attempt: i + 1, err: (err as Error).message });
    }
  }

  return {
    status: 'failed',
    ms: Date.now() - started,
    tokens: 0,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}
