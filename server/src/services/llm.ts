import { env } from '../config/env';
import { providerById, providerForBaseUrl } from '../content/llmProviders';
import { UpstreamError } from '../lib/errors';
import { repairJson } from '../lib/jsonRepair';
import { logger } from '../lib/logger';
import { redactSecret } from '../lib/secret';
import {
  classifyLlmFailure,
  listPoolKeys,
  markPoolFailure,
  markPoolSuccess,
  poolCandidates,
  poolSummary,
  type FailureInfo,
  type PoolCandidate,
} from './keyPool';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 是否发送 response_format: json_object；部分国内平台不支持，会 400 */
  jsonMode: boolean;
  /** 这条配置来自号池时，标记线路 id；null 表示环境变量线路 */
  keyId?: string | null;
  /** 是否允许在失败时轮换到号池里的其他线路 */
  pool?: boolean;
  label?: string;
  /** chat() 成功后回填「这次真正用的是哪条线路」，供上层记录来源 */
  usedModel?: string;
  usedLabel?: string;
  usedKeyId?: string | null;
  /** 本次调用累计消耗的 token（含重试与降级重发，按平台回的 usage 累加） */
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  source: 'pool' | 'env' | 'settings' | 'none';
  providerId: string | null;
  providerName: string;
  jsonMode: boolean;
  pool: {
    total: number;
    enabled: number;
    ready: number;
    cooling: number;
    needsKey: number;
    activeLabel: string | null;
    activeModel: string | null;
  };
}

interface Override {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  providerId?: string;
}

let override: Override = {};

/** 老接口保留：没有号池时仍可用运行时配置（主要给测试与脚本用） */
export function setRuntimeLlmConfig(next: Override): void {
  override = { ...override, ...next };
}

/** 已经确认不支持 json 模式的「地址 + 模型」，下次直接不再发 response_format */
const jsonModeUnsupported = new Set<string>();

const configKey = (baseUrl: string, model: string): string => `${baseUrl.toLowerCase()}|${model.toLowerCase()}`;

/** 这个接口要不要带 response_format：先看服务商预设，再看运行时探测结果 */
function wantsJsonMode(baseUrl: string, model: string, providerId?: string | null): boolean {
  if (jsonModeUnsupported.has(configKey(baseUrl, model))) return false;
  const provider = providerById(providerId) ?? providerForBaseUrl(baseUrl);
  return provider ? provider.jsonMode : true;
}

export function markJsonModeUnsupported(baseUrl: string, model: string): void {
  jsonModeUnsupported.add(configKey(baseUrl, model));
}

/** 上次成功的线路：下次优先从它开始，避免每次都去撞已经坏掉的第一条 */
let lastGoodKeyId: string | null | undefined;

export function resolveLlmConfig(): { config: LlmConfig | null; source: LlmStatus['source'] } {
  const candidates = poolCandidates();
  if (candidates.length > 0) {
    const chosen =
      (lastGoodKeyId !== undefined && candidates.find((item) => item.keyId === lastGoodKeyId)) || candidates[0];
    return { config: fromCandidate(chosen), source: chosen.source === 'env' ? 'env' : 'pool' };
  }

  // 兼容没有号池的老配置：只有显式 override（脚本/测试）才走这里
  if (override.baseUrl && override.apiKey && override.model) {
    const baseUrl = override.baseUrl.trim().replace(/\/+$/, '');
    const timeoutMs = override.timeoutMs ?? env.llm.timeoutMs;
    return {
      config: {
        baseUrl,
        apiKey: override.apiKey.trim(),
        model: override.model.trim(),
        timeoutMs,
        jsonMode: wantsJsonMode(baseUrl, override.model.trim(), override.providerId),
        keyId: null,
        pool: false,
      },
      source: 'settings',
    };
  }

  return { config: null, source: 'none' };
}

function fromCandidate(candidate: PoolCandidate): LlmConfig {
  return {
    baseUrl: candidate.baseUrl,
    apiKey: candidate.apiKey,
    model: candidate.model,
    timeoutMs: candidate.timeoutMs,
    jsonMode: wantsJsonMode(candidate.baseUrl, candidate.model, candidate.providerId),
    keyId: candidate.keyId,
    label: candidate.label,
    pool: true,
  };
}

export function llmStatus(): LlmStatus {
  const summary = poolSummary();
  const { config, source } = resolveLlmConfig();
  const provider = config ? providerById(override.providerId) ?? providerForBaseUrl(config.baseUrl) : null;
  const configured = summary.total > 0 || Boolean(config);
  return {
    configured,
    baseUrl: config?.baseUrl ?? '',
    model: config?.model ?? summary.activeModel ?? '',
    source: configured ? source : 'none',
    providerId: provider?.id ?? null,
    providerName: provider?.name ?? (config ? '自定义接口' : ''),
    jsonMode: config?.jsonMode ?? true,
    pool: summary,
  };
}

/** 号池里每条线路的展示信息（不含明文 Key） */
export function poolKeyViews() {
  return listPoolKeys();
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 单次请求 token 预算的天花板：截断后的加预算重试都以此为止，避免超出平台上限 */
const MAX_TOKEN_BUDGET = 10_000;

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  /**
   * chatJson 专用的回传口：记录这次是不是靠本地修复救回来的，
   * 调用方（AI 加练）用它决定要不要在界面上标注「格式已自动修复」。
   */
  meta?: {
    localRepaired?: boolean;
    modelRetried?: boolean;
    /** 最终成功响应的 finish_reason === 'length'：正文可能在 JSON 中途被截断 */
    truncated?: boolean;
  };
}

interface AttemptFailure {
  label: string;
  info: FailureInfo;
  status?: number;
  snippet?: string;
  /** 原始异常，单线路时原样抛出，避免丢失 emptyOutput 之类的标记 */
  raw?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 有的平台把 content 返回成 [{type:'text',text:'...'}] 这种分段数组，统一拍平成字符串 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const item = part as { text?: unknown; content?: unknown };
          if (typeof item.text === 'string') return item.text;
          if (typeof item.content === 'string') return item.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * HTTP 200 但正文为空：网络、Key、模型名都是通的，只是这一次没吐出可用文字。
 * 最常见的是「思考型模型」（智谱 GLM、DeepSeek R1 等）把 max_tokens 全花在思考上，
 * 正式生成时 token 给得足，基本不会触发。所以这里冷却只要 5 秒，别把一条好线路打废。
 */
function emptyContentError(meta: { finishReason?: string; hasReasoning: boolean }): UpstreamError {
  const truncated = meta.finishReason === 'length';
  const reason = truncated
    ? meta.hasReasoning
      ? '模型的思考过程吃满了 max_tokens，正文没来得及输出'
      : '输出达到 max_tokens 上限被截断，正文为空'
    : meta.hasReasoning
      ? '模型只返回了思考内容，没有输出正文'
      : '模型返回了空内容，可能被安全策略拦截或该模型不支持这种指令';
  const short = truncated
    ? meta.hasReasoning
      ? '思考占满 max_tokens'
      : '达到 max_tokens 上限'
    : meta.hasReasoning
      ? '只有思考内容'
      : '空内容，可能被拦截';

  const err = new UpstreamError(`大模型返回内容为空：${reason}`, {
    status: 200,
    snippet: `finish_reason=${meta.finishReason ?? 'null'}｜思考内容=${meta.hasReasoning ? '有' : '无'}｜正文 0 字`,
  });
  const marked = err as UpstreamError & {
    retryable?: boolean;
    failure?: FailureInfo;
    emptyOutput?: boolean;
    truncated?: boolean;
  };
  marked.retryable = false;
  marked.emptyOutput = true;
  marked.truncated = truncated;
  marked.failure = { kind: 'transient', switchable: true, cooldownMs: 5_000, message: `返回内容为空（${short}）` };
  return err;
}

/** 真正发一次请求；jsonMode 决定要不要带 response_format */
async function requestOnce(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  jsonMode: boolean,
): Promise<
  { ok: true; content: string; finishReason?: string } | { ok: false; status: number; body: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 2400,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, status: response.status, body };
    }

    const data = (await response.json().catch(() => ({}))) as {
      choices?: Array<{
        message?: { content?: unknown; reasoning_content?: unknown; refusal?: unknown };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    // 先记 token：哪怕这次正文为空，额度也已经花掉了，界面上的「用了多少 token」不能少算
    if (data.usage) {
      const promptTokens = Number(data.usage.prompt_tokens ?? 0) || 0;
      const completionTokens = Number(data.usage.completion_tokens ?? 0) || 0;
      const totalTokens = Number(data.usage.total_tokens ?? promptTokens + completionTokens) || promptTokens + completionTokens;
      const usage = config.usage ?? (config.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      usage.promptTokens += promptTokens;
      usage.completionTokens += completionTokens;
      usage.totalTokens += totalTokens;
    }
    const choice = data.choices?.[0];
    const message = choice?.message;
    const content = textOf(message?.content);
    if (!content.trim()) {
      throw emptyContentError({
        finishReason: choice?.finish_reason,
        hasReasoning: Boolean(textOf(message?.reasoning_content).trim() || textOf(message?.refusal).trim()),
      });
    }
    // finish_reason 必须一路带出去：正文非空但 JSON 写到一半被 length 掐断时，
    // 光看 content 是看不出来的，chatJson 要靠它决定「加预算重新生成」还是「让模型重写」。
    return { ok: true, content, finishReason: choice?.finish_reason };
  } finally {
    clearTimeout(timer);
  }
}

/** 接口抱怨 response_format / json 参数时，说明这个平台不支持，降级重发一次 */
const JSON_MODE_COMPLAINT = /response_format|json_object|json mode|json\s*模式/i;

/** 单条线路调用：返回文本，或抛出带 retryable 标记的 UpstreamError */
async function callOnce(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  withBackoff: boolean,
): Promise<{ text: string; truncated: boolean }> {
  const retries = withBackoff ? options.retries ?? 2 : 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // 配置里的 jsonMode 只是「想不想用」，这里再叠一层「试过发现用不了」的记忆
      const jsonMode = config.jsonMode && !jsonModeUnsupported.has(configKey(config.baseUrl, config.model));
      let result: Awaited<ReturnType<typeof requestOnce>>;
      try {
        result = await requestOnce(config, messages, options, jsonMode);
      } catch (err) {
        // 「思考型模型」会把 max_tokens 花在推理上，正文被截断成空。
        // 这种情况翻倍预算再试一次，通常就能拿到正文（只多花一次调用，且只发生在截断时）。
        const budget = options.maxTokens ?? 2400;
        if (!(err as { truncated?: boolean }).truncated || budget >= MAX_TOKEN_BUDGET) throw err;
        const bumped = Math.min(MAX_TOKEN_BUDGET, Math.max(6000, budget * 2));
        logger.warn('llm output truncated by max_tokens, retrying with bigger budget', { from: budget, to: bumped });
        result = await requestOnce(config, messages, { ...options, maxTokens: bumped }, jsonMode);
      }

      // 智谱、混元、魔搭等平台对 response_format 支持不一：报参数错误就退到纯提示词模式
      if (!result.ok && result.status === 400 && jsonMode && JSON_MODE_COMPLAINT.test(result.body)) {
        logger.warn('llm json mode unsupported, retrying without response_format', {
          baseUrl: config.baseUrl,
          model: config.model,
        });
        markJsonModeUnsupported(config.baseUrl, config.model);
        result = await requestOnce(config, messages, options, false);
      }

      if (!result.ok) {
        const info = classifyLlmFailure(result.status, result.body);
        const err = new UpstreamError(`大模型接口返回 ${result.status}`, {
          status: result.status,
          snippet: redactSecret(result.body.slice(0, 300)),
        });
        (err as UpstreamError & { retryable?: boolean; failure?: FailureInfo }).retryable = info.switchable;
        (err as UpstreamError & { failure?: FailureInfo }).failure = info;
        throw err;
      }

      return { text: result.content, truncated: result.finishReason === 'length' };
    } catch (err) {
      lastError = err;
      const retryable = (err as { retryable?: boolean }).retryable ?? false;
      if (!retryable || attempt === retries) break;
      const backoff = 600 * 2 ** attempt;
      logger.warn('llm retry', { attempt: attempt + 1, backoff, message: (err as Error).message });
      await sleep(backoff);
    }
  }

  if (lastError instanceof UpstreamError) {
    if (!(lastError as UpstreamError & { failure?: FailureInfo }).failure) {
      (lastError as UpstreamError & { failure?: FailureInfo }).failure = {
        kind: 'transient',
        switchable: true,
        cooldownMs: 30_000,
        message: lastError.message,
      };
    }
    throw lastError;
  }

  const message = (lastError as Error)?.message ?? '未知错误';
  const timeout = (lastError as Error)?.name === 'AbortError';
  const info: FailureInfo = timeout
    ? { kind: 'transient', switchable: true, cooldownMs: 30_000, message: `响应超时（${config.timeoutMs}ms）` }
    : { kind: 'transient', switchable: true, cooldownMs: 30_000, message: `连不上接口：${message}` };
  const wrapped = new UpstreamError(
    timeout ? `大模型响应超时（${config.timeoutMs}ms）` : `无法连接大模型接口：${message}`,
  );
  (wrapped as UpstreamError & { retryable?: boolean; failure?: FailureInfo }).retryable = true;
  (wrapped as UpstreamError & { failure?: FailureInfo }).failure = info;
  (wrapped as UpstreamError & { timeoutOutput?: boolean }).timeoutOutput = true;
  throw wrapped;
}

/** 号池轮换顺序：上次成功的优先，其余按优先级；手动传入的配置不参与轮换 */
function rotationOrder(config: LlmConfig): Array<{ config: LlmConfig; keyId: string | null; label: string }> {
  if (!config.pool) return [{ config, keyId: config.keyId ?? null, label: config.label ?? config.model }];

  const candidates = poolCandidates();
  const preferred =
    lastGoodKeyId !== undefined ? candidates.find((item) => item.keyId === lastGoodKeyId) : undefined;
  const ordered = preferred ? [preferred, ...candidates.filter((item) => item !== preferred)] : candidates;

  return ordered.map((candidate) => ({
    config: { ...fromCandidate(candidate), timeoutMs: config.timeoutMs },
    keyId: candidate.keyId,
    label: candidate.label,
  }));
}

function summarizeFailures(failures: AttemptFailure[], total: number): UpstreamError {
  const head = failures.slice(0, 3).map((item) => `${item.label}（${item.info.message}）`).join('；');
  const tail = failures.length > 3 ? `；等 ${failures.length} 条` : '';
  const err = new UpstreamError(`所有模型线路都不可用（共 ${total} 条）：${head}${tail}`, {
    hint: '到「设置 → 模型 Key 池」里补一条可用线路，或点「恢复」清掉冷却后重试',
    failures: failures.map((item) => ({
      label: item.label,
      message: item.info.message,
      status: item.status,
      snippet: item.snippet,
    })),
  });
  (err as UpstreamError & { retryable?: boolean }).retryable = false;
  if (failures.length > 0 && failures.every((item) => /超时|连不上/.test(item.info.message))) {
    (err as UpstreamError & { timeoutOutput?: boolean }).timeoutOutput = true;
  }
  return err;
}

/**
 * 调用 OpenAI 兼容接口并返回原始文本。
 *
 * 号池模式（config.pool）下：按优先级逐条线路尝试，失败即记录冷却并换下一条；
 * 单条线路模式（脚本 / 测试）下：保留原来的指数退避重试。
 */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const order = rotationOrder(config);
  if (order.length === 0) {
    throw new UpstreamError('没有可用的模型线路', {
      hint: '到「设置 → 模型 Key 池」添加一条线路，或等待冷却结束',
    });
  }

  const rotate = order.length > 1;
  const failures: AttemptFailure[] = [];

  for (const line of order) {
    try {
      const { text, truncated } = await callOnce(line.config, messages, options, !rotate);
      // 用回传口带出截断标记，不改变 chat() 的 string 返回类型，其他调用方零改动
      if (options.meta) options.meta.truncated = truncated;
      markPoolSuccess(line.keyId);
      lastGoodKeyId = line.keyId;
      config.usedModel = line.config.model;
      config.usedLabel = line.label;
      config.usedKeyId = line.keyId;
      // 用量记在外层 config 上，调用方直接读 config.usage 就能展示
      config.usage = line.config.usage;
      return text;
    } catch (err) {
      const info =
        (err as UpstreamError & { failure?: FailureInfo }).failure ??
        ({
          kind: 'transient',
          switchable: true,
          cooldownMs: 30_000,
          message: (err as Error).message,
        } satisfies FailureInfo);

      const detail = (err as { details?: { status?: number; snippet?: string } }).details;
      markPoolFailure(line.keyId, info);
      failures.push({ label: line.label, info, status: detail?.status, snippet: detail?.snippet, raw: err });
      logger.warn('llm line failed, trying next', {
        label: line.label,
        kind: info.kind,
        message: info.message,
      });

      if (!info.switchable) break;
    }
  }

  if (failures.length === 1 && order.length === 1) {
    // 只有一条线路时把上游原始报错原样抛出去，用户更容易定位
    const only = failures[0];
    if (only.raw && (only.raw as { emptyOutput?: boolean }).emptyOutput) throw only.raw;
    throw new UpstreamError(only.info.message, {
      hint: '检查 Key、模型名与账户余额',
      status: only.status,
      snippet: only.snippet,
    });
  }

  throw summarizeFailures(failures, order.length);
}

function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * 要求模型返回 JSON，并做一次「修复重试」。
 *
 * 失败分两条路，别混在一起：
 * - 输出被 max_tokens 截断（finish_reason=length），且本地补全也救不回来 →
 *   加预算、用原提示词重新完整生成一次（把残缺前缀塞回给模型只会再次截断）；
 * - 单纯格式/字段不对 → 才把原文交给模型重写。
 *
 * 只要本地能修好就直接返回，绝不额外调用上游（AI 加练的自检依赖这一点）。
 */
export async function chatJson<T>(
  config: LlmConfig,
  messages: ChatMessage[],
  parser: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ path: (string | number)[]; message: string }> } } },
  options: ChatOptions = {},
): Promise<T> {
  // 复用调用方传进来的 meta（AI 加练要靠它显示「已自动修复」），只是补一个截断回传口
  const meta: NonNullable<ChatOptions['meta']> = options.meta ?? {};
  const callOptions: ChatOptions = { ...options, meta };

  const parse = (raw: string): { ok: true; data: T } | { ok: false; reason: string } => {
    const text = stripFence(raw);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // 先本地修：围栏、客套话、尾逗号、中文引号、截断……都不用再花一次调用
      const repaired = repairJson(text);
      if (!repaired.ok) {
        return { ok: false, reason: '返回内容不是合法 JSON（本地修复也没救回来）' };
      }
      meta.localRepaired = true;
      logger.info('llm json locally repaired', { stage: repaired.stage });
      json = repaired.value;
    }
    const result = parser.safeParse(json);
    if (!result.success) {
      const detail = (result.error?.issues ?? [])
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return { ok: false, reason: `JSON 结构不符合要求（${detail}）` };
    }
    return { ok: true, data: result.data as T };
  };

  const first = await chat(config, messages, callOptions);
  const parsed = parse(first);
  if (parsed.ok) return parsed.data;

  const budget = options.maxTokens ?? 2400;
  const bumped = Math.min(MAX_TOKEN_BUDGET, Math.max(6000, budget * 2));

  // 截断且本地补全救不回来：加预算重新完整生成一次，这是「止血」的主路径
  if (meta.truncated && bumped > budget) {
    logger.warn('llm json truncated, retrying once with bigger budget', {
      from: budget,
      to: bumped,
      reason: parsed.reason,
    });
    meta.modelRetried = true;
    const retryMessages: ChatMessage[] = messages.map((message, index) =>
      index === messages.length - 1 && message.role === 'user'
        ? {
            ...message,
            content: `${message.content}\n\n【重要】上一次输出在 JSON 中途被截断，请重新输出完整闭合的 JSON；篇幅不足时可精简解释性文字，但必须保留全部必需字段。`,
          }
        : message,
    );
    const retryMeta: NonNullable<ChatOptions['meta']> = { ...meta };
    let second: string;
    try {
      second = await chat(config, retryMessages, { ...options, maxTokens: bumped, meta: retryMeta });
    } catch (err) {
      (err as { truncatedOutput?: boolean }).truncatedOutput = true;
      throw err;
    }
    const secondParsed = parse(second);
    if (secondParsed.ok) return secondParsed.data;
    const err = new UpstreamError('大模型输出被 max_tokens 截断，重试后仍未拿到完整 JSON', {
      reason: secondParsed.reason,
    });
    (err as UpstreamError & { truncatedOutput?: boolean }).truncatedOutput = true;
    throw err;
  }

  // 单纯格式/字段不对：才让模型自己重写，这一步是真的要再花一次调用
  logger.warn('llm json invalid, retrying once', { reason: parsed.reason });
  meta.modelRetried = true;
  const repair = await chat(
    config,
    [
      ...messages,
      { role: 'assistant', content: first.slice(0, 4000) },
      {
        role: 'user',
        content: `上一次输出无法解析：${parsed.reason}。请只输出严格符合要求的 JSON 对象，不要任何解释文字、不要 markdown 代码块。`,
      },
    ],
    callOptions,
  );
  const repaired = parse(repair);
  if (repaired.ok) return repaired.data;

  throw new UpstreamError('大模型返回的 JSON 无法解析', { reason: repaired.reason });
}

export type LlmErrorKind = 'timeout' | 'truncated' | 'config' | 'other';

/** 把大模型链路的异常归类，供上层给出可操作的中文提示（不泄漏堆栈与密钥） */
export function classifyLlmError(err: unknown): LlmErrorKind {
  const marked = err as {
    timeoutOutput?: boolean;
    truncatedOutput?: boolean;
    truncated?: boolean;
    details?: { status?: number };
    failure?: FailureInfo;
    message?: string;
  };
  const message = typeof marked?.message === 'string' ? marked.message : '';
  // 网络类优先：截断重试过程中也可能撞上超时，别把它误报成「输出被截断」
  if (marked?.timeoutOutput || /响应超时|连接超时|连不上|fetch failed/i.test(message)) return 'timeout';
  if (marked?.truncatedOutput || marked?.truncated || /截断|max_tokens/.test(message)) return 'truncated';
  const status = marked?.details?.status;
  const kind = marked?.failure?.kind;
  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    kind === 'invalid' ||
    kind === 'quota' ||
    kind === 'model' ||
    /Key 无效|额度|余额|模型名|没有可用的模型线路/.test(message)
  ) {
    return 'config';
  }
  return 'other';
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  /** 上游 HTTP 状态与平台原话，方便判断 429 到底是限流、并发还是额度 */
  status?: number;
  snippet?: string;
}

const TEST_MESSAGES: ChatMessage[] = [
  { role: 'system', content: '你是一个连通性测试助手。' },
  { role: 'user', content: '请只输出 JSON：{"ok":true}' },
];

export async function pingLlm(config: LlmConfig): Promise<PingResult> {
  const startedAt = Date.now();
  // 20 个 token 对「思考型模型」几乎必然被思考过程吃光，给 128 留点余量
  const runOnce = () =>
    chat({ ...config, pool: false }, TEST_MESSAGES, { maxTokens: 128, temperature: 0, retries: 0 });

  try {
    await runOnce();
    return { ok: true, latencyMs: Date.now() - startedAt, message: '连接成功' };
  } catch (err) {
    const detail = (err as { details?: { status?: number; snippet?: string } }).details;

    // 能拿到 HTTP 200 却正文为空：线路是通的，只是这次模型没吐字（多半是思考占满 token）。
    // 连通性测试只回答「通不通」，所以这里算通过，但把实情写清楚，别让人以为 Key 坏了。
    if ((err as { emptyOutput?: boolean }).emptyOutput) {
      const reason = (err as Error).message.replace(/^大模型返回内容为空：?/, '');
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        message: `线路正常（HTTP 200），但这次没有正文输出：${reason}。正式生成时 token 给得足，一般不受影响。`,
        status: 200,
        snippet: detail?.snippet,
      };
    }

    // 429 往往是「上一秒并发撞车」，并不代表 Key 不能用：等几秒再试一次，别让用户白紧张
    if (detail?.status === 429) {
      await sleep(2500);
      try {
        await runOnce();
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          message: '连接成功（首次被限流，等待 2.5 秒后重试通过）',
        };
      } catch (retryErr) {
        const retryDetail = (retryErr as { details?: { status?: number; snippet?: string } }).details;
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          message: (retryErr as Error).message,
          status: retryDetail?.status,
          snippet: retryDetail?.snippet,
        };
      }
    }

    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: (err as Error).message,
      status: detail?.status,
      snippet: detail?.snippet,
    };
  }
}
