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
import { PROFILE_RULES, QUALITY_ORDER, capabilitiesOf, type LineCaps, type RunProfile } from './lineCaps';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 是否发送 response_format: json_object；部分国内平台不支持，会 400 */
  jsonMode: boolean;
  /** 平台 id（zhipu / hunyuan / …）。决定「关思考」时该发哪个字段 */
  providerId?: string;
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
  /** 这条线路上次失败的信息（来自号池持久化），长输出调用据此把它排到最后 */
  lastError?: string | null;
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

/**
 * 「思考吃满预算」的线路。
 *
 * 解题视频脚本一次要吐 6–10k token，而思考型模型会把 max_tokens 全花在推理上，
 * 正文一个字都不留——这不是坏线路（聊天场景它还很好用），是「干不了长输出」。
 * 学一次就把它在长输出调用里排到最后，否则每次生成都要白等两分钟才换线。
 */
const reasoningHungry = new Set<string>();

/**
 * 长输出调用的门槛。凡是「要模型连续吐几千字」的请求都算：
 * 解题视频脚本（5–11k）、母语讲稿（3k 上下）。聊天 / 评分 / 解释单词远低于它。
 * 门槛从 6000 降到 4000 再到 3000 的教训：门槛定高了，小预算任务会绕过排序，
 * 一样要白等思考型模型两分钟才换线。
 */
const LONG_OUTPUT_TOKENS = 3_000;

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
        providerId: override.providerId,
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
    providerId: candidate.providerId,
    keyId: candidate.keyId,
    label: candidate.label,
    lastError: candidate.lastError ?? null,
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

/** 某条线在某类请求下的处置 */
export type LineDecision = 'active' | 'deferred' | 'excluded';

export interface LineDispatchRow {
  label: string;
  model: string;
  providerName: string;
  priority: number;
  /** 号池当前状态（ready / cooling / exhausted…） */
  status: string;
  caps: LineCaps;
  decision: LineDecision;
  /** 为什么是这个处置，直接给界面用 */
  note: string;
}

export interface LineDispatchView {
  profile: RunProfile;
  desc: string;
  thinking: 'auto' | 'off' | 'on';
  rows: LineDispatchRow[];
  /** 筛选后一条不剩时回落全池，界面要能提示「画像没配上」 */
  fellBack: boolean;
}

/**
 * 线路调度预览：每种请求画像下，每条线路会怎样。
 *
 * 这是给运维看的，不是给调用链用的 —— 不删线路的前提是「看得见它此刻不用」，
 * 否则过两周没人记得 glm-4v-flash 为什么一直在池子里却没被调用过。
 * 基于 listPoolKeys() 而不是 poolCandidates()：冷却中的线路也要列出来，
 * 不然界面只剩两三条，像丢了一样。
 */
export function lineDispatchPreview(): LineDispatchView[] {
  const keys = listPoolKeys().filter((key) => key.enabled);
  const profiles = Object.keys(PROFILE_RULES) as RunProfile[];

  return profiles.map((profile) => {
    const rule = PROFILE_RULES[profile];
    const rows: LineDispatchRow[] = keys.map((key) => {
      const caps = capabilitiesOf(key.model, key.providerId, { lastError: key.lastError });
      const accepted = rule.accept(caps);
      const deferred = accepted && Boolean(rule.deferAlwaysThinking) && caps.thinking === 'always';
      const decision: LineDecision = !accepted ? 'excluded' : deferred ? 'deferred' : 'active';
      const note =
        decision === 'excluded'
          ? `不参与：${caps.reason}`
          : decision === 'deferred'
            ? `可用但垫后：${caps.reason}，只能降推理档`
            : `参与：${caps.reason}`;
      return {
        label: key.label,
        model: key.model,
        providerName: key.providerName,
        priority: key.priority,
        status: key.status,
        caps,
        decision,
        note,
      };
    });

    // 与真实轮换同序：参与 → 垫后 → 排除；同组内保持号池 priority，deep 再按质量重排
    const rank: Record<LineDecision, number> = { active: 0, deferred: 1, excluded: 2 };
    rows.sort((a, b) => {
      if (rank[a.decision] !== rank[b.decision]) return rank[a.decision] - rank[b.decision];
      if (rule.preferQuality) {
        const diff = QUALITY_ORDER[a.caps.tier] - QUALITY_ORDER[b.caps.tier];
        if (diff !== 0) return diff;
      }
      return a.priority - b.priority;
    });

    const usable = rows.filter((row) => row.decision !== 'excluded');
    return {
      profile,
      desc: rule.desc,
      thinking: rule.thinking,
      rows,
      fellBack: usable.length === 0,
    };
  });
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 单次请求 token 预算的天花板：截断后的加预算重试都以此为止，避免超出平台上限 */
// 精讲档 23 镜 × 600 token 需要 ~14k 输出；上限跟着最大档走，别让截断重试封顶在 12k
const MAX_TOKEN_BUDGET = 16_000;

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  /**
   * 单次上游请求超时（毫秒）。默认取线路配置（90s）。
   * 解题视频的「精讲」档一次要吐 20+ 镜的 JSON，90s 会被误杀成超时，
   * 所以调用方能按输出体量把预算放大。
   */
  timeoutMs?: number;
  /**
   * 本次调用要什么样的线路。决定「哪些线路参与」+「默认要不要开思维链」。
   *
   * 调用方只声明需求，不点名模型——这样换线路不用改场景代码，新场景也自动继承。
   * 默认 'balanced' 不筛选，保持历史行为。
   * 详见 services/lineCaps.ts 的 PROFILE_RULES。
   */
  profile?: RunProfile;
  /**
   * 是否允许模型「先想再答」。
   *
   * 不传则跟随 profile（interactive/long-output 为 off，deep 为 on）。
   * - 默认 'auto'：什么都不发，保持各家平台自己的默认行为（多数思考型模型默认开）。
   * - 'off'：交互路径请显式传它。实测同一把 Key、同一句长难句、同一个规划任务，
   *   glm-4.5-air 从 9.5s 降到 2.1~2.5s，正文长度基本不变（427~476 字 vs 426 字）。
   *   慢的主因不是模型不行，是思维链把时间吃掉了。
   * - 'on'：显式要求思考，留给「作文深评」这类值得等几秒换质量的场景。
   */
  thinking?: 'auto' | 'off' | 'on';
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
  /**
   * chatJson 专用的「最后一道本地抢救」：严格解析与 repairJson 都失败、
   * 或解析出来结构不合 schema 时，把原始文本交给调用方自己捞能用的部分。
   * 返回 null 表示救不了（此时才值得再花一次调用让模型重写）。
   */
  tolerant?: (raw: string) => unknown | null;
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
/**
 * 生效的思考策略：显式指定优先，其次跟随请求画像，最后回落到平台默认。
 * 放在一处算，避免 requestOnce 的几处重发路径各算一遍导致行为不一致。
 */
function effectiveThinking(options: ChatOptions): 'auto' | 'off' | 'on' {
  return options.thinking ?? PROFILE_RULES[options.profile ?? 'balanced'].thinking;
}

/**
 * 「关掉思维链」时该往请求体里塞什么。
 *
 * 各家字段不一样，而且不是所有模型都允许关，所以这里按平台 + 模型名分派，
 * 认不出来的平台一律不发 —— 多发一个它不认识的字段，换来的可能是一个 400，
 * 比慢更糟。
 *
 * 实测（2026-11-24，同一句长难句、同一个规划任务、同一个 Key）：
 *   glm-4.5-air    默认 9.5s（思维链占满）→ 关思考 2.1~2.5s，正文 427~476 字，与开着时持平
 *   glm-5.3-flash  默认 16.3s 且正文为空 → 传 disabled 直接 400「该模型始终思考」→ 只能退到 low，8.1s
 *   hy3            关思考 5.6s；hy4 关思考 10.9s（且爱写 1200+ 字，容易撞 max_tokens）
 *   glm-4.7-flash  免费，但两次实测都是 429「访问量过大」，不能当主线路
 */
function thinkingPatch(config: LlmConfig, want: 'auto' | 'off' | 'on'): Record<string, unknown> {
  if (want === 'auto') return {};
  const model = config.model.toLowerCase();
  const providerId = config.providerId ?? providerForBaseUrl(config.baseUrl)?.id ?? '';

  // GLM-5 系列是「始终思考」，thinking.disabled 会被拒；只能把推理档降到 low
  if (model.startsWith('glm-5')) {
    return want === 'off' ? { reasoning_effort: 'low' } : { reasoning_effort: 'high' };
  }
  if (providerId === 'zhipu' || providerId === 'hunyuan') {
    return want === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' } };
  }
  return {};
}

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
        ...thinkingPatch(config, effectiveThinking(options)),
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
  // 超时预算要透传给 requestOnce；它是唯一会造副本的选项，
  // 所以要在 finally 里把用量搬回原对象 —— 否则外层读 config.usage 永远是空（成本面板会归零）
  const cfg = options.timeoutMs
    ? { ...config, timeoutMs: Math.max(config.timeoutMs, options.timeoutMs) }
    : config;

  try {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        // 配置里的 jsonMode 只是「想不想用」，这里再叠一层「试过发现用不了」的记忆
        const jsonMode = config.jsonMode && !jsonModeUnsupported.has(configKey(config.baseUrl, config.model));
        let result: Awaited<ReturnType<typeof requestOnce>>;
        try {
          result = await requestOnce(cfg, messages, options, jsonMode);
        } catch (err) {
          // 「思考型模型」会把 max_tokens 花在推理上，正文被截断成空。
          // 这种情况翻倍预算再试一次，通常就能拿到正文（只多花一次调用，且只发生在截断时）。
          const budget = options.maxTokens ?? 2400;
          if (!(err as { truncated?: boolean }).truncated || budget >= MAX_TOKEN_BUDGET) throw err;
          const bumped = Math.min(MAX_TOKEN_BUDGET, Math.max(6000, budget * 2));
          logger.warn('llm output truncated by max_tokens, retrying with bigger budget', { from: budget, to: bumped });
          result = await requestOnce(cfg, messages, { ...options, maxTokens: bumped }, jsonMode);
        }

        // 智谱、混元、魔搭等平台对 response_format 支持不一：报参数错误就退到纯提示词模式
        if (!result.ok && result.status === 400 && jsonMode && JSON_MODE_COMPLAINT.test(result.body)) {
          logger.warn('llm json mode unsupported, retrying without response_format', {
            baseUrl: config.baseUrl,
            model: config.model,
          });
          markJsonModeUnsupported(config.baseUrl, config.model);
          result = await requestOnce(cfg, messages, options, false);
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
  } finally {
    // 副本上记的用量搬回去；config.usage 已存在时两者本就是同一个引用，赋值是空操作
    if (cfg !== config && cfg.usage) config.usage = cfg.usage;
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

/**
 * 按请求画像挑线路：谁参与、谁垫后。
 *
 * 与「优先级队列」的分工：号池的 priority 仍然决定同档内的先后，这里只做两件事 ——
 * 一是把「必失败」的组合踢出本次队列（视觉专用模型收到纯文本请求），
 * 二是把「能跑但明显更差」的线路垫后（交互档里关不掉思考的线路）。
 *
 * 硬排除之后如果一条都不剩，回落到全池：画像推导靠模型名，总有认不出的时候，
 * 标签配错顶多慢一点，不能因为配错就拒绝服务。
 */
function candidatesFor(profile: RunProfile): { queue: PoolCandidate[]; excluded: PoolCandidate[]; fellBack: boolean } {
  const rule = PROFILE_RULES[profile];
  const all = poolCandidates();
  if (profile === 'balanced') return { queue: all, excluded: [], fellBack: false };

  const caps = new Map<PoolCandidate, LineCaps>();
  for (const candidate of all) {
    caps.set(candidate, capabilitiesOf(candidate.model, candidate.providerId, { lastError: candidate.lastError }));
  }

  const accepted: PoolCandidate[] = [];
  const excluded: PoolCandidate[] = [];
  for (const candidate of all) {
    if (rule.accept(caps.get(candidate)!)) accepted.push(candidate);
    else excluded.push(candidate);
  }

  if (accepted.length === 0) {
    logger.warn('按画像筛选后无可用线路，回落全池', {
      profile,
      excluded: excluded.map((item) => item.model),
    });
    return { queue: all, excluded, fellBack: true };
  }

  let queue = accepted;
  if (rule.deferAlwaysThinking) {
    const soft = (candidate: PoolCandidate): boolean => caps.get(candidate)?.thinking === 'always';
    queue = [...queue.filter((item) => !soft(item)), ...queue.filter(soft)];
  }
  if (rule.preferQuality) {
    // sort 是稳定的：同档内保留号池 priority 的原始顺序
    queue = [...queue].sort(
      (a, b) => QUALITY_ORDER[caps.get(a)!.tier] - QUALITY_ORDER[caps.get(b)!.tier],
    );
  }

  if (excluded.length > 0) {
    logger.debug('画像筛选排除线路', {
      profile,
      excluded: excluded.map((item) => `${item.model}（${caps.get(item)?.reason}）`),
    });
  }
  return { queue, excluded, fellBack: false };
}

/** 号池轮换顺序：上次成功的优先，其余按优先级；手动传入的配置不参与轮换 */
function rotationOrder(
  config: LlmConfig,
  options: ChatOptions = {},
): Array<{ config: LlmConfig; keyId: string | null; label: string }> {
  if (!config.pool) return [{ config, keyId: config.keyId ?? null, label: config.label ?? config.model }];

  const { queue: candidates } = candidatesFor(options.profile ?? 'balanced');
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
 * 把某条线路的用量并入外层 config。
 *
 * 池模式下每条候选线路都有自己的 config 对象，用量记在各自身上；
 * 换线路时前面那条已经花掉的 token 不能丢——用户看到的成本必须是真的花了多少。
 */
function absorbUsage(target: LlmConfig, source: LlmConfig): void {
  if (source === target || !source.usage) return;
  const acc = target.usage ?? (target.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  acc.promptTokens += source.usage.promptTokens;
  acc.completionTokens += source.usage.completionTokens;
  acc.totalTokens += source.usage.totalTokens;
  source.usage = undefined;
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
  const order = rotationOrder(config, options);
  if (order.length === 0) {
    throw new UpstreamError('没有可用的模型线路', {
      hint: '到「设置 → 模型 Key 池」添加一条线路，或等待冷却结束',
    });
  }

  // 长输出调用（解题视频脚本 6–10k token）最怕思考型模型：一次空输出白等两分钟。
  // 判据有两个：本次进程里学到的、号池里持久化的上次失败（重启后仍然有效）；
  // 若全部都被判为不适合，仍然照原顺序试，不能因为记忆而拒绝服务。
  const hungry = (line: { config: LlmConfig }): boolean =>
    reasoningHungry.has(configKey(line.config.baseUrl, line.config.model)) ||
    /思考占满|只有思考/.test(line.config.lastError ?? '');
  const longOutput = (options.maxTokens ?? 2_400) >= LONG_OUTPUT_TOKENS;
  const queue = longOutput
    ? [...order.filter((line) => !hungry(line)), ...order.filter((line) => hungry(line))]
    : order;

  const rotate = queue.length > 1;
  const failures: AttemptFailure[] = [];

  for (const line of queue) {
    try {
      const { text, truncated } = await callOnce(line.config, messages, options, !rotate);
      // 用回传口带出截断标记，不改变 chat() 的 string 返回类型，其他调用方零改动
      if (options.meta) options.meta.truncated = truncated;
      markPoolSuccess(line.keyId);
      lastGoodKeyId = line.keyId;
      config.usedModel = line.config.model;
      config.usedLabel = line.label;
      config.usedKeyId = line.keyId;
      // 用量并入外层 config（含前面几条失败线路已花掉的 token），调用方直接读 config.usage
      absorbUsage(config, line.config);
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
      // 这条线路可能已经把 prompt（甚至部分输出）算进额度了，先收上来再换线
      absorbUsage(config, line.config);
      // 思考把预算吃光：内容全在 reasoning 里，正文为空。记住它不适合长输出，下次排到最后
      if (longOutput && /思考占满|只有思考/.test(info.message)) {
        const key = configKey(line.config.baseUrl, line.config.model);
        if (!reasoningHungry.has(key)) {
          reasoningHungry.add(key);
          logger.warn('llm line marked reasoning-hungry, deprioritised for long output', {
            label: line.label,
            model: line.config.model,
          });
        }
      }
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

  if (failures.length === 1 && queue.length === 1) {
    // 只有一条线路时把上游原始报错原样抛出去，用户更容易定位
    const only = failures[0];
    if (only.raw && (only.raw as { emptyOutput?: boolean }).emptyOutput) throw only.raw;
    throw new UpstreamError(only.info.message, {
      hint: '检查 Key、模型名与账户余额',
      status: only.status,
      snippet: only.snippet,
    });
  }

  throw summarizeFailures(failures, queue.length);
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

    /** 交给调用方的抢救器；救不动就返回 null，让上层决定是否再花一次调用 */
    const salvage = (): unknown | null => {
      if (!options.tolerant) return null;
      try {
        const value = options.tolerant(text);
        if (value !== null && value !== undefined) {
          meta.localRepaired = true;
          logger.info('llm json salvaged from raw output');
          return value;
        }
      } catch (err) {
        logger.warn('llm tolerant parser threw', { err: (err as Error).message });
      }
      return null;
    };

    try {
      json = JSON.parse(text);
    } catch {
      // 先本地修：围栏、客套话、尾逗号、中文引号、截断……都不用再花一次调用
      const repaired = repairJson(text);
      if (repaired.ok) {
        meta.localRepaired = true;
        logger.info('llm json locally repaired', { stage: repaired.stage });
        json = repaired.value;
      } else {
        const salvaged = salvage();
        if (salvaged === null) {
          return { ok: false, reason: '返回内容不是合法 JSON（本地修复也没救回来）' };
        }
        json = salvaged;
      }
    }

    let result = parser.safeParse(json);
    if (!result.success) {
      // 结构不合要求：再让抢救器按「对象粒度」捞一遍，捞回来的部分往往就够用了
      const salvaged = salvage();
      if (salvaged !== null) {
        const again = parser.safeParse(salvaged);
        if (again.success) result = again;
      }
    }
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
    const marked = err as UpstreamError & { truncatedOutput?: boolean; rawOutput?: string };
    marked.truncatedOutput = true;
    marked.rawOutput = second;
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

  const failure = new UpstreamError('大模型返回的 JSON 无法解析', { reason: repaired.reason });
  // 把最后一次原文回传给调用方：它可能能按对象粒度救回一部分，不必让用户重试
  (failure as UpstreamError & { rawOutput?: string }).rawOutput = repair;
  throw failure;
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
