/**
 * 工具注册表。
 *
 * 判定标准只有一条（设计文档 §3.4）：**要么确定性，要么可验证**。
 * 纯生成的活（"随便聊聊"）不放这里 —— 那是模型的事，放进来只会让计划变长、成本变高。
 */
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import type { AgentDeps } from '../ports';
import type { Artifact } from '../protocols';
import type { ArtifactType, Bag, HelpLevel, LangCode, Provenance, ToolCost } from '../types';

export interface ToolContext {
  lang: LangCode;
  userId: string;
  runId: string;
  helpLevel: HelpLevel;
  /** 场景守则原文，注入 system prompt */
  sceneRules: string;
  /** 当前语种的合法 ruleId 白名单，写进 prompt 约束模型别自己造 */
  ruleIds: string[];
  /** 黑板：前序工具的结果都在这里，M1 换成显式参数槽 */
  bag: Bag;
  deps: AgentDeps;
  signal?: AbortSignal;
  /** 产物 id 由内核统一发号，工具不要自己编 */
  nextArtifactId(type: ArtifactType): string;
  log(message: string, fields?: Record<string, unknown>): void;
}

export interface ToolOutcome {
  data: unknown;
  artifacts?: Artifact[];
  provenance?: Provenance[];
  /** 这次调用实际花掉的 token，用于预算与成本归因 */
  tokens?: number;
  /** 一句话摘要，给 SSE 与 run trace 用 */
  summary?: string;
}

export interface ToolDef {
  name: string;
  /** 只在这些语种可用；省略表示全语种（仍受 Language Pack 能力约束） */
  langs?: LangCode[];
  cost: ToolCost;
  /** 幂等工具可以缓存、可以断点续跑 */
  idempotent: boolean;
  args: ZodTypeAny;
  /**
   * 单步超时覆盖（毫秒）。
   * 默认按「有没有花 token」猜耗时，但有些工具不花 token 却慢得不可预测 ——
   * 录音转写就是典型：9 秒录音 0.4 秒回来，5 分钟的录音笔文件可能几十秒。
   * 这类工具自己申报上限，比让内核猜准。
   */
  timeoutMs?: number;
  run(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/**
 * 写工具时的助手：入参在 run 里已经是类型安全的（由 schema 推导），
 * 注册表只保留类型擦除后的版本（异构注册表必然要擦除，别硬抗）。
 */
export function defineTool<S extends ZodTypeAny>(spec: {
  name: string;
  langs?: LangCode[];
  cost: ToolCost;
  idempotent: boolean;
  args: S;
  timeoutMs?: number;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}): ToolDef {
  return {
    name: spec.name,
    langs: spec.langs,
    cost: spec.cost,
    idempotent: spec.idempotent,
    args: spec.args,
    timeoutMs: spec.timeoutMs,
    run: (args, ctx) => spec.run(spec.args.parse(args) as z.infer<S>, ctx),
  };
}

const RENDERER_BY_TYPE = {
  'annotated-diff': 'diff-pane',
  'score-report': 'score-pane',
  'explain-video': 'video-pane',
  'reading-pack': 'reader-pane',
  'quiz-set': 'quiz-pane',
  'speaking-report': 'speaking-pane',
  'plan-patch': 'plan-pane',
  'card-deck': 'deck-pane',
  'syntax-tree': 'syntax-pane',
} as const;

export function artifact(input: {
  id: string;
  type: ArtifactType;
  title: string;
  data: unknown;
  actions?: string[];
  writes?: Array<{ target: string; summary: string }>;
  confidence?: number;
}): Artifact {
  return {
    artifactId: input.id,
    type: input.type,
    renderer: RENDERER_BY_TYPE[input.type],
    title: input.title,
    data: input.data,
    actions: input.actions ?? [],
    writes: input.writes ?? [],
    confidence: input.confidence,
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): this {
    if (this.tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDef | null {
    return this.tools.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** 某语种可用的工具名集合，Planner 据此裁剪计划 */
  availableFor(lang: LangCode): Set<string> {
    const out = new Set<string>();
    for (const tool of this.tools.values()) {
      if (!tool.langs || tool.langs.includes(lang)) out.add(tool.name);
    }
    return out;
  }
}
