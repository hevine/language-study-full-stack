import { Router } from 'express';
import { z } from 'zod';
import {
  LLM_PROVIDERS,
  providerById,
  providerForBaseUrl,
  type LlmProvider,
} from '../content/llmProviders';
import { env } from '../config/env';
import { currentUserId } from '../auth/requestScope';
import { asyncHandler, parseBody } from '../lib/http';
import { ConfigError, NotFoundError, UpstreamError } from '../lib/errors';
import { masterKeyPath, masterKeySource, redactSecret, tightenPermissions } from '../lib/secret';
import { ensureProfile, getSetting, setSetting, updateProfile } from '../repositories/misc';
import {
  addPoolKey,
  candidateById,
  deletePoolKey,
  hasEnvKey,
  listPoolKeys,
  poolSummary,
  reorderPoolKeys,
  resetPoolKey,
  updatePoolKey,
} from '../services/keyPool';
import { llmStatus, pingLlm, resolveLlmConfig, type LlmConfig } from '../services/llm';

export const settingsRouter = Router();

/** 前端下拉用的服务商预设（含免费额度说明与申请入口） */
function providerPayload(provider: LlmProvider) {
  return {
    id: provider.id,
    name: provider.name,
    vendor: provider.vendor,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    models: provider.models,
    freeNote: provider.freeNote,
    applyUrl: provider.applyUrl,
    applyLabel: provider.applyLabel,
    keyHint: provider.keyHint,
    jsonMode: provider.jsonMode,
  };
}

function readLlmSettings() {
  const status = llmStatus();
  const keys = listPoolKeys();
  const first = keys.find((key) => key.enabled && key.status === 'ready') ?? keys[0];

  return {
    configured: status.configured,
    availableNow: status.pool.ready,
    summary: status.pool,
    baseUrl: first?.baseUrl ?? status.baseUrl,
    model: first?.model ?? status.model,
    source: status.source,
    providerId: first?.providerId ?? status.providerId,
    providerName: first?.providerName ?? status.providerName,
    jsonMode: first?.jsonMode ?? status.jsonMode,
    // 只给掩码，永远不回传明文
    apiKeyMasked: first?.maskedKey ?? '',
    storage: {
      encrypted: true,
      algorithm: 'AES-256-GCM',
      masterKeySource: masterKeySource(),
      masterKeyPath: masterKeyPath().replace(env.dataDir, '.data'),
      dataDir: env.dataDir.replace(env.rootDir, '.'),
      dbFile: env.dbPath.replace(env.rootDir, '.'),
      envKeyActive: hasEnvKey(),
    },
    providers: LLM_PROVIDERS.filter((provider) => provider.id !== 'custom').map(providerPayload),
    keys,
  };
}

settingsRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const profile = ensureProfile();
    res.json({ profile, llm: readLlmSettings() });
  }),
);

const SettingsInput = z.object({
  baseUrl: z.string().max(300).optional(),
  model: z.string().max(120).optional(),
  apiKey: z.string().max(400).optional(),
  providerId: z.string().max(40).optional(),
  displayName: z.string().max(40).optional(),
  goalNote: z.string().max(300).optional(),
});

/**
 * 兼容旧版设置页：填了 Key 就当成「新增一条线路」。
 * 新的界面走 /settings/keys，这里保留是为了脚本与旧书签不失效。
 */
settingsRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const body = parseBody(SettingsInput, req.body);

    if (body.apiKey && body.apiKey.trim()) {
      const baseUrl = (body.baseUrl ?? getSetting('llm.baseUrl') ?? '').trim();
      const model = (body.model ?? getSetting('llm.model') ?? '').trim();
      if (!baseUrl || !model) throw new ConfigError('新增线路需要 Base URL 与模型名');
      addPoolKey({ providerId: body.providerId, baseUrl, model, apiKey: body.apiKey, label: '默认线路' });
    } else {
      if (body.baseUrl !== undefined) setSetting('llm.baseUrl', body.baseUrl.trim().replace(/\/+$/, ''));
      if (body.model !== undefined) setSetting('llm.model', body.model.trim());
      if (body.providerId !== undefined) setSetting('llm.provider', body.providerId.trim());
    }

    if (body.displayName !== undefined || body.goalNote !== undefined) {
      updateProfile(currentUserId(), {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.goalNote !== undefined ? { goalNote: body.goalNote } : {}),
      });
    }

    res.json({ profile: ensureProfile(), llm: readLlmSettings() });
  }),
);

const KeyInput = z.object({
  providerId: z.string().max(40).optional(),
  label: z.string().max(60).optional(),
  baseUrl: z.string().max(300),
  model: z.string().max(120),
  apiKey: z.string().max(400),
  persist: z.boolean().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
});

settingsRouter.post(
  '/settings/keys',
  asyncHandler(async (req, res) => {
    const body = parseBody(KeyInput, req.body);
    const key = addPoolKey({
      providerId: body.providerId,
      label: body.label,
      baseUrl: body.baseUrl,
      model: body.model,
      apiKey: body.apiKey,
      persist: body.persist,
      enabled: body.enabled,
      priority: body.priority,
    });
    tightenPermissions();
    res.json({ key, llm: readLlmSettings() });
  }),
);

const KeyPatch = z.object({
  providerId: z.string().max(40).optional(),
  label: z.string().max(60).optional(),
  baseUrl: z.string().max(300).optional(),
  model: z.string().max(120).optional(),
  apiKey: z.string().max(400).optional(),
  persist: z.boolean().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
});

settingsRouter.put(
  '/settings/keys/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(KeyPatch, req.body);
    const id = req.params.id;
    if (id === 'env') throw new ConfigError('环境变量里的 Key 请改 .env，界面上不能编辑');
    try {
      const key = updatePoolKey(id, body);
      res.json({ key, llm: readLlmSettings() });
    } catch (err) {
      if (/不存在/.test((err as Error).message)) throw new NotFoundError((err as Error).message);
      throw err;
    }
  }),
);

settingsRouter.delete(
  '/settings/keys/:id',
  asyncHandler(async (req, res) => {
    if (req.params.id === 'env') throw new ConfigError('环境变量里的 Key 请改 .env');
    const ok = deletePoolKey(req.params.id);
    if (!ok) throw new NotFoundError('这条线路不存在');
    res.json({ ok, llm: readLlmSettings() });
  }),
);

settingsRouter.post(
  '/settings/keys/:id/reset',
  asyncHandler(async (req, res) => {
    if (req.params.id === 'env') throw new ConfigError('环境变量里的 Key 不需要恢复');
    resetPoolKey(req.params.id);
    res.json({ ok: true, llm: readLlmSettings() });
  }),
);

const OrderInput = z.object({ ids: z.array(z.string().max(60)).max(40) });

settingsRouter.put(
  '/settings/keys/order',
  asyncHandler(async (req, res) => {
    const body = parseBody(OrderInput, req.body);
    reorderPoolKeys(body.ids.filter((id) => id !== 'env'));
    res.json({ ok: true, llm: readLlmSettings() });
  }),
);

/** 把一条号池线路转成可调用的配置 */
function configFromKey(id: string, overrides: { model?: string; baseUrl?: string } = {}): LlmConfig {
  if (id === 'env') {
    const { config } = resolveLlmConfig();
    if (!config) throw new ConfigError('环境变量里没有可用的 Key');
    return { ...config, pool: false };
  }
  const candidate = candidateById(id);
  if (!candidate) throw new ConfigError('这条线路还没有可用的 Key，请重新填写');
  const provider = providerById(candidate.providerId) ?? providerForBaseUrl(candidate.baseUrl);
  return {
    baseUrl: (overrides.baseUrl || candidate.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: candidate.apiKey,
    model: (overrides.model || candidate.model).trim(),
    timeoutMs: 20_000,
    jsonMode: provider ? provider.jsonMode : true,
    // 测试不参与号池轮换（不会切到别的线路），但成功/失败会如实记到这条线路上：
    // 测出 Key 无效就该显示失效，避免「横幅报错、状态却写着可用」的矛盾
    keyId: candidate.keyId,
    pool: false,
  };
}

const TestInput = z.object({
  keyId: z.string().max(60).optional(),
  baseUrl: z.string().max(300).optional(),
  model: z.string().max(120).optional(),
  apiKey: z.string().max(400).optional(),
  providerId: z.string().max(40).optional(),
});

/** 用「表单里正在填的值」拼一个待测配置；没填的字段回落到已保存配置 */
function candidateConfig(
  input: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    providerId?: string;
    timeoutMs?: number;
  },
  fallbackTimeout = 20_000,
): LlmConfig | null {
  const { config } = resolveLlmConfig();
  const baseUrl = (input.baseUrl || config?.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = (input.apiKey || config?.apiKey || '').trim();
  const model = (input.model || config?.model || '').trim();
  if (!baseUrl || !apiKey || !model) return null;
  const provider = providerById(input.providerId) ?? providerForBaseUrl(baseUrl);
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: input.timeoutMs ?? fallbackTimeout,
    jsonMode: provider ? provider.jsonMode : true,
    pool: false,
  };
}

settingsRouter.post(
  '/settings/keys/:id/test',
  asyncHandler(async (req, res) => {
    const result = await pingLlm(configFromKey(req.params.id));
    res.json(result);
  }),
);

settingsRouter.post(
  '/settings/test',
  asyncHandler(async (req, res) => {
    const body = parseBody(TestInput, req.body);
    // 表单里没填 Key 时，允许直接用已保存线路的 Key 测试，避免把 Key 再贴一遍
    if (!body.apiKey && body.keyId) {
      const result = await pingLlm(configFromKey(body.keyId, { model: body.model, baseUrl: body.baseUrl }));
      res.json(result);
      return;
    }
    const candidate = candidateConfig(body);
    if (!candidate) throw new ConfigError('请先填写 Base URL、模型名与 API Key');
    const result = await pingLlm(candidate);
    res.json(result);
  }),
);

const ModelsInput = z.object({
  keyId: z.string().max(60).optional(),
  baseUrl: z.string().max(300).optional(),
  apiKey: z.string().max(400).optional(),
  providerId: z.string().max(40).optional(),
});

/**
 * 拉取该平台的模型列表（OpenAI 的 GET /models）。
 * 魔搭的模型 ID 是 `Qwen/Qwen3-8B-Instruct` 这种，靠猜容易填错，直接问服务端最稳。
 */
settingsRouter.post(
  '/settings/models',
  asyncHandler(async (req, res) => {
    const body = parseBody(ModelsInput, req.body);
    const provider = providerById(body.providerId);

    let baseUrl = (body.baseUrl || '').trim().replace(/\/+$/, '');
    let apiKey = (body.apiKey || '').trim();

    if (body.keyId && (!baseUrl || !apiKey)) {
      const candidate = candidateById(body.keyId);
      if (candidate) {
        baseUrl = baseUrl || candidate.baseUrl;
        apiKey = apiKey || candidate.apiKey;
      }
    }
    if (!baseUrl || !apiKey) {
      const { config } = resolveLlmConfig();
      baseUrl = baseUrl || (config?.baseUrl ?? provider?.baseUrl ?? '');
      apiKey = apiKey || (config?.apiKey ?? '');
    }

    if (!baseUrl) throw new ConfigError('请先填写 Base URL');
    if (!apiKey) throw new ConfigError('拉取模型列表需要 API Key');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new UpstreamError(`该平台没有返回模型列表（${response.status}）`, {
          hint: '可以手动填写模型名，或点上面的预设按钮用推荐模型',
          snippet: redactSecret(text.slice(0, 200)),
        });
      }
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id))
        .sort((a, b) => a.localeCompare(b));
      res.json({ models: ids, count: ids.length });
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError('连不上这个 Base URL，检查地址是否写错或需要代理', {
        detail: (error as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }),
);

settingsRouter.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = parseBody(SettingsInput, req.body);
    const profile = updateProfile(currentUserId(), {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.goalNote !== undefined ? { goalNote: body.goalNote } : {}),
    });
    res.json({ profile });
  }),
);
