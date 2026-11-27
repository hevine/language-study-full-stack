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
import { createJaSyntax, jaLevel, jaPhonology, jaTaxonomy, jaTokenizer } from './ja';
import { createKoSyntax, koLevel, koPhonology, koTaxonomy, koTokenizer } from './ko';
import { createAsrPort } from './asr';
import { createLlmPort } from './llm';
import { createMediaPort } from './media';
import { createLearnerStore, createTraceStore } from './storage';
import { createTaskPort } from './tasks';

function buildRuntime(): AgentRuntime {
  const llm = createLlmPort();

  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  // 英语：分词按空格，句法走 LLM，规则集是拉丁文字那一套
  const enPorts: LanguagePorts = {
    tokenizer: enTokenizer,
    syntax: createEnSyntax(llm),
    taxonomy: enTaxonomy,
    phonology: enPhonology,
    level: enLevel,
  };

  // 日语：分词走 kuromoji 词典，句法按文节算，规则集是助词／活用／敬语那一套
  const jaPorts: LanguagePorts = {
    tokenizer: jaTokenizer,
    syntax: createJaSyntax(llm),
    taxonomy: jaTaxonomy,
    phonology: jaPhonology,
    level: jaLevel,
  };

  // 韩语：空格即词边界（어절），句法按 조사 定角色，规则集是助词／语尾／语体那一套
  const koPorts: LanguagePorts = {
    tokenizer: koTokenizer,
    syntax: createKoSyntax(llm),
    taxonomy: koTaxonomy,
    phonology: koPhonology,
    level: koLevel,
  };

  const deps: AgentDeps = {
    llm,
    store: createLearnerStore(),
    trace: createTraceStore(),
    // 产物采纳后挂回今日任务；不接这一条，「学了一点」就永远闭不了环
    tasks: createTaskPort(),
    // TTS + 讲解视频：复用主项目已有链路，本层只做协议适配
    media: createMediaPort(),
    // 语音识别：复用主项目转写号池（多线路 + 冷却换线），口语场景靠它把录音变成转写稿
    asr: createAsrPort(),
    language: (code) => (code === 'en' ? enPorts : code === 'ja' ? jaPorts : code === 'ko' ? koPorts : null),
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
