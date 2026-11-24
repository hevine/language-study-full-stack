/**
 * 进程内运行时装配。
 *
 * 这就是「同进程、但随时可拆」的落点：
 * - 所有外部能力都通过 AgentDeps 注入，core/ 不知道它们住在哪；
 * - 拆分时把这里的 createLlmPort / createLearnerStore 换成 HTTP 客户端即可，
 *   core/、tools/、scenes/ 一行不用改。
 */
import { logger } from '../../lib/logger';
import type { AgentRuntime } from '../core';
import { loadLanguagePacks } from '../lang/loader';
import type { AgentDeps, LanguagePorts } from '../ports';
import { loadScenePacks } from '../scenes/loader';
import { BUILTIN_TOOLS } from '../tools/builtin';
import { ToolRegistry } from '../tools/registry';
import { createEnSyntax, enLevel, enPhonology, enTaxonomy, enTokenizer } from './en';
import { createLlmPort } from './llm';
import { createMediaPort } from './media';
import { createLearnerStore, createTraceStore } from './storage';
import { createTaskPort } from './tasks';

function buildRuntime(): AgentRuntime {
  const llm = createLlmPort();

  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  // 英语能力先接通；日语需要 kuromoji 分词 + 助词/敬语规则集，按 M2 计划补
  const enPorts: LanguagePorts = {
    tokenizer: enTokenizer,
    syntax: createEnSyntax(llm),
    taxonomy: enTaxonomy,
    phonology: enPhonology,
    level: enLevel,
  };

  const deps: AgentDeps = {
    llm,
    store: createLearnerStore(),
    trace: createTraceStore(),
    // 产物采纳后挂回今日任务；不接这一条，「学了一点」就永远闭不了环
    tasks: createTaskPort(),
    // TTS + 讲解视频：复用主项目已有链路，本层只做协议适配
    media: createMediaPort(),
    language: (code) => (code === 'en' ? enPorts : null),
    now: () => new Date(),
  };

  const scenes = loadScenePacks();
  const langs = loadLanguagePacks();

  logger.info('agent runtime ready', {
    scenes: scenes.map((scene) => scene.id),
    langs: [...langs.keys()],
    tools: registry.list().map((tool) => tool.name),
  });

  return { deps, registry, scenes, langs };
}

let cached: AgentRuntime | null = null;

export function getAgentRuntime(): AgentRuntime {
  if (!cached) cached = buildRuntime();
  return cached;
}

/** 场景包 / 语言包是磁盘数据，改了不用重启服务 */
export function reloadAgentRuntime(): AgentRuntime {
  cached = buildRuntime();
  return cached;
}
