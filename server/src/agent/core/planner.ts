/**
 * ③ 规划：场景声明的工具序列 → 可执行计划。
 *
 * 只做三件事：裁掉不可用的工具、按预算截断、判断要不要先给用户看执行计划。
 * 为什么要有"3 步阈值"：一次跑 8 个工具花两万 token、跑一分半，
 * 用户中途不知道它在干嘛就会跑掉 —— 先给预览，让他有机会打断。
 */
import type { ScenePack } from '../scenes/loader';
import type { LangCode, ToolCost } from '../types';
import type { ToolRegistry } from '../tools/registry';

export interface PlannedStep {
  n: number;
  tool: string;
  cost: ToolCost;
}

export interface Plan {
  steps: PlannedStep[];
  /** 被裁掉的工具与理由，run trace 里要能看到「为什么少了这一步」 */
  dropped: Array<{ tool: string; reason: string }>;
  estimatedTokens: number;
  /** 超过 3 步先给预览 */
  needsPreview: boolean;
}

export function plan(scene: ScenePack, registry: ToolRegistry, lang: LangCode, budget?: Partial<ScenePack['budget']>): Plan {
  const maxSteps = budget?.maxSteps ?? scene.budget.maxSteps;
  const maxTokens = budget?.maxTokens ?? scene.budget.maxTokens;

  const available = registry.availableFor(lang);
  const steps: PlannedStep[] = [];
  const dropped: Plan['dropped'] = [];
  let tokens = 0;

  for (const name of scene.tools) {
    const tool = registry.get(name);
    if (!tool) {
      dropped.push({ tool: name, reason: '工具未注册' });
      continue;
    }
    if (!available.has(name)) {
      dropped.push({ tool: name, reason: `该语种不可用（${lang}）` });
      continue;
    }
    if (steps.length >= maxSteps) {
      dropped.push({ tool: name, reason: `超出步数上限 ${maxSteps}` });
      continue;
    }
    const cost = tool.cost.tokens ?? 0;
    if (tokens + cost > maxTokens) {
      dropped.push({ tool: name, reason: `超出 token 预算 ${maxTokens}` });
      continue;
    }
    tokens += cost;
    steps.push({ n: steps.length + 1, tool: name, cost: tool.cost });
  }

  return { steps, dropped, estimatedTokens: tokens, needsPreview: steps.length > 3 };
}
