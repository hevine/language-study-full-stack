/**
 * Standalone Agent Runtime 入口。
 *
 * 组装一个不依赖 waiyu-baodian 主项目的 AgentRuntime：
 * - LLM：用户配置的 OpenAI 兼容 API
 * - Store：JSONL 文件（已自包含）
 * - Trace：文件（已自包含）
 * - Task：stub（无任务系统）
 * - Media：stub（无视频）
 * - ASR：local-asr 或 Whisper API
 * - Language：英语（en.ts 已自包含）
 * - Loop：本地 SQLite（loop-db.ts）
 *
 * 同时初始化 Loop → Agent 反馈管道（setFeedbackHook）。
 */
import path from 'node:path';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { setFeedbackHook } from '../../loop/store';
import { createEnSyntax, enLevel, enPhonology, enTaxonomy, enTokenizer } from '../adapters/en';
import { createJaSyntax, jaLevel, jaPhonology, jaTaxonomy, jaTokenizer } from '../adapters/ja';
import { createKoSyntax, koLevel, koPhonology, koTaxonomy, koTokenizer } from '../adapters/ko';
import { createLearnerStore, createTraceStore } from '../adapters/storage';
import { loadLanguagePacks } from '../lang/loader';
import type { AgentDeps, LanguagePorts } from '../ports';
import { loadScenePacks } from '../scenes/loader';
import { BUILTIN_TOOLS } from '../tools/builtin';
import { ToolRegistry } from '../tools/registry';
import type { AgentRuntime } from '../core';
import { createStandaloneAsr } from './asr';
import { createStandaloneLlm } from './llm';
import { createStandaloneLoopDeps } from './loop-db';
import { createStubMediaPort } from './media';
import { createStubTaskPort } from './task';

export interface StandaloneConfig {
  /** LLM 配置；缺省从 env 读 */
  llm?: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  /** ASR 配置；缺省用 local-asr */
  asr?: {
    mode: 'local' | 'whisper-api';
    localPort?: number;
    apiKey?: string;
  };
  /** 数据根目录；缺省用 env.dataDir */
  dataDir?: string;
}

export function createStandaloneRuntime(config?: StandaloneConfig): AgentRuntime {
  const dataDir = config?.dataDir ?? env.dataDir;

  // LLM
  const llmConfig = config?.llm ?? {
    apiKey: env.llm.apiKey,
    baseUrl: env.llm.baseUrl,
    model: env.llm.model,
  };
  if (!llmConfig.apiKey || !llmConfig.baseUrl || !llmConfig.model) {
    throw new Error(
      'standalone 模式需要 LLM 配置：设置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 环境变量，或在 config.llm 中传入',
    );
  }
  const llm = createStandaloneLlm(llmConfig);

  // Loop DB（独立 SQLite）
  const loopDeps = createStandaloneLoopDeps(dataDir);

  // LearnerStore（带 loopDb 聚合 lapseCount）
  const store = createLearnerStore(loopDeps.db);

  // Trace
  const trace = createTraceStore();

  // Task / Media stub
  const tasks = createStubTaskPort();
  const media = createStubMediaPort();

  // ASR
  const asr = createStandaloneAsr(config?.asr ?? { mode: 'local' });

  // 英语能力
  const enPorts: LanguagePorts = {
    tokenizer: enTokenizer,
    syntax: createEnSyntax(llm),
    taxonomy: enTaxonomy,
    phonology: enPhonology,
    level: enLevel,
  };

  // 日语能力：词典与规则集都自包含，不依赖主项目
  const jaPorts: LanguagePorts = {
    tokenizer: jaTokenizer,
    syntax: createJaSyntax(llm),
    taxonomy: jaTaxonomy,
    phonology: jaPhonology,
    level: jaLevel,
  };

  // 韩语能力：纯规则，无词典依赖，standalone 直接可用
  const koPorts: LanguagePorts = {
    tokenizer: koTokenizer,
    syntax: createKoSyntax(llm),
    taxonomy: koTaxonomy,
    phonology: koPhonology,
    level: koLevel,
  };

  const deps: AgentDeps = {
    llm,
    store,
    trace,
    tasks,
    media,
    asr,
    language: (code) => (code === 'en' ? enPorts : code === 'ja' ? jaPorts : code === 'ko' ? koPorts : null),
    now: () => new Date(),
  };

  // 工具注册
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  // 场景 + 语言包
  const scenes = loadScenePacks();
  const langs = loadLanguagePacks();

  // Loop → Agent 反馈管道：gradeCard 的评分回流到 profile
  setFeedbackHook(async (ruleId, action, evidence) => {
    const { LearnerPatchSchema } = await import('../protocols');
    const patch = LearnerPatchSchema.parse({
      patchId: `loop_fb_${Date.now()}`,
      userId: 'local',
      lang: 'en',
      scope: 'errors',
      ops:
        action === 'inc'
          ? [{ op: 'inc', ruleId, evidence }]
          : [{ op: 'promote', ruleId, from: 'candidate', to: 'resolved' }],
      requiresConfirm: false,
      reversible: true,
    });
    await store.applyPatch(patch, { confirm: true });
    logger.info('loop feedback → profile', { ruleId, action, evidence });
  });

  logger.info('standalone agent runtime ready', {
    dataDir,
    scenes: scenes.map((s) => s.id),
    tools: registry.list().map((t) => t.name),
    llmModel: llmConfig.model,
    asrMode: config?.asr?.mode ?? 'local',
  });

  return { deps, registry, scenes, langs };
}

/** 导出 Loop store 供 standalone 路由层使用 */
export { createStandaloneLoopDeps } from './loop-db';
export { createStandaloneLlm } from './llm';
export { createStandaloneAsr } from './asr';
