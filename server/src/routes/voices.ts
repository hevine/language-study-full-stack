/** 音色库 API：按语种隔离的增删改查、场景分配、AI 发现与云端合成 */
import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../lib/errors';
import { asyncHandler, parseBody } from '../lib/http';
import { logger } from '../lib/logger';
import { maskSecret, openSecret } from '../lib/secret';
import { getActivePlan } from '../repositories/plans';
import { currentUserId } from '../auth/requestScope';
import {
  BCP47,
  countVoices,
  deleteVoice,
  getAssignments,
  getPrefs,
  getVoice,
  insertVoice,
  listVoices,
  SCENE_LABEL,
  setAssignments,
  setDefaultVoice,
  setPrefs,
  updateVoice,
  VOICE_SCENES,
  type VoiceInput,
  type VoiceRecord,
} from '../repositories/voices';
import { isLanguage, requireLanguage, type Language } from '../domain/language';
import {
  discoverVoices,
  enableLocalEdgeVoices,
  ensureVoiceSeed,
  POPULAR_PRESETS,
  sealVoiceKey,
  synthesizeSpeech,
} from '../services/voiceCatalog';
import {
  getEdgeTtsStatus,
  isLocalEdge,
  LOCAL_EDGE_KEY,
  resetEdgeTtsStatus,
} from '../services/edgeTts';

export const voicesRouter = Router();

const LanguageInput = z.enum(['en', 'ja', 'ko']);

/** 显式 language 优先，否则跟随当前激活计划；写操作一律 requireLanguage 兜底 */
function resolveLanguage(value: unknown): Language {
  if (isLanguage(value)) return value;
  const plan = getActivePlan();
  if (plan && isLanguage(plan.language)) return plan.language;
  return 'en';
}

const VoiceFields = {
  name: z.string().trim().min(1).max(40),
  provider: z.enum(['browser', 'cloud']).default('browser'),
  engineVoice: z.string().max(400).default(''),
  matchHint: z.string().max(400).default(''),
  model: z.string().max(120).default(''),
  baseUrl: z.string().max(300).default(''),
  voiceId: z.string().max(120).default(''),
  style: z.string().max(500).default(''),
  persona: z.string().max(120).default(''),
  tags: z.array(z.string().max(20)).max(8).default([]),
  rate: z.number().min(0.5).max(1.4).default(0.9),
  pitch: z.number().min(0.5).max(1.5).default(1),
  volume: z.number().min(0).max(1).default(1),
  source: z.enum(['system', 'preset', 'ai', 'custom']).default('custom'),
};

const VoiceCreate = z.object({
  language: LanguageInput.optional(),
  ...VoiceFields,
  /** 只在新建时接收明文 Key；服务端立即加密，之后任何接口都不回传明文 */
  apiKey: z.string().max(600).optional(),
});

const VoiceUpdate = z.object({
  language: LanguageInput.optional(),
  ...Object.fromEntries(Object.entries(VoiceFields).map(([key, schema]) => [key, schema.optional()])),
  apiKey: z.string().max(600).optional(),
  clearKey: z.boolean().optional(),
});

const ImportItem = z.object({
  name: z.string().trim().min(1).max(40),
  persona: z.string().max(120).default(''),
  provider: z.enum(['browser', 'cloud']).default('browser'),
  matchHint: z.string().max(400).default(''),
  engineVoice: z.string().max(400).default(''),
  voiceId: z.string().max(120).default(''),
  model: z.string().max(120).default(''),
  baseUrl: z.string().max(300).default(''),
  style: z.string().max(500).default(''),
  tags: z.array(z.string().max(20)).max(8).default([]),
  rate: z.number().min(0.5).max(1.4).default(0.9),
  source: z.enum(['system', 'preset', 'ai', 'custom']).default('preset'),
});

/** 回给前端的音色：去掉密文 Key，只留「有没有配」与掩码 */
function publicVoice(voice: VoiceRecord) {
  const { apiKey: _secret, ...rest } = voice;
  let maskedKey = '';
  if (voice.apiKey) {
    try {
      maskedKey = maskSecret(openSecret(voice.apiKey));
    } catch {
      maskedKey = '••••（无法解密）';
    }
  }
  return { ...rest, hasKey: Boolean(voice.apiKey), maskedKey };
}

function payload(userId: string, language: Language) {
  return {
    language,
    bcp47: BCP47[language],
    voices: listVoices(userId, language).map(publicVoice),
    assignments: getAssignments(userId, language),
    prefs: getPrefs(userId, language),
    scenes: VOICE_SCENES.map((id) => ({ id, label: SCENE_LABEL[id] })),
    presets: POPULAR_PRESETS[language].map((preset) => {
      const { apiKey: _secret, ...rest } = preset;
      return rest;
    }),
  };
}

voicesRouter.get(
  '/voices',
  asyncHandler(async (req, res) => {
    const language = resolveLanguage(req.query.language);
    ensureVoiceSeed(currentUserId(), language);
    res.json(payload(currentUserId(), language));
  }),
);

/** 大模型按语种推荐流行音色：只返回候选，不落库，由用户勾选后导入 */
voicesRouter.post(
  '/voices/discover',
  asyncHandler(async (req, res) => {
    const input = parseBody(z.object({ language: LanguageInput.optional() }), req.body ?? {});
    const language = resolveLanguage(input.language ?? req.query.language);
    res.json(await discoverVoices(language));
  }),
);

/** 批量导入选中的候选（内置目录或 AI 推荐都走这里） */
voicesRouter.post(
  '/voices/import',
  asyncHandler(async (req, res) => {
    const input = parseBody(
      z.object({ language: LanguageInput.optional(), items: z.array(ImportItem).min(1).max(12) }),
      req.body ?? {},
    );
    const language = requireLanguage(input.language ?? req.query.language);
    const existing = new Set(listVoices(currentUserId(), language).map((item) => item.name));
    let added = 0;
    for (const item of input.items) {
      if (existing.has(item.name)) continue;
      const voiceInput: VoiceInput = {
        name: item.name,
        provider: item.provider,
        engineVoice: item.engineVoice,
        matchHint: item.matchHint,
        model: item.model,
        baseUrl: item.baseUrl,
        // 本地 Edge 不需要真实密钥，写占位值让前端「已配置」状态正确
        apiKey: isLocalEdge(item.baseUrl) ? sealVoiceKey(LOCAL_EDGE_KEY) ?? '' : '',
        voiceId: item.voiceId,
        style: item.style,
        persona: item.persona,
        tags: item.tags,
        rate: item.rate,
        pitch: 1,
        volume: 1,
        source: item.source,
      };
      insertVoice(currentUserId(), language, voiceInput, { isDefault: countVoices(currentUserId(), language) === 0 });
      existing.add(item.name);
      added += 1;
    }
    logger.info('voices imported', { language, added });
    res.json(payload(currentUserId(), language));
  }),
);

/** 本地 Edge Neural 引擎自检：设置页据此提示是否需要先跑 voice:setup */
voicesRouter.get(
  '/voices/edge/status',
  asyncHandler(async (req, res) => {
    res.json(await getEdgeTtsStatus(req.query.refresh === '1'));
  }),
);

/** 一键为当前语种启用本地 Neural：补音色 + 设默认 + 四个场景绑定，其它语种不动 */
voicesRouter.post(
  '/voices/edge/enable',
  asyncHandler(async (req, res) => {
    const input = parseBody(z.object({ language: LanguageInput.optional() }), req.body ?? {});
    const language = requireLanguage(input.language ?? req.query.language);
    const enabled = enableLocalEdgeVoices(currentUserId(), language);
    resetEdgeTtsStatus();
    res.json({ ...payload(currentUserId(), language), enabled });
  }),
);

/** 场景分配：单词 / 长难句 / 精读 / 听力各自绑定音色，null 表示跟随默认 */
voicesRouter.put(
  '/voices/assignments',
  asyncHandler(async (req, res) => {
    const input = parseBody(
      z.object({
        language: LanguageInput.optional(),
        assignments: z.record(z.enum(['word', 'sentence', 'article', 'listening']), z.string().nullable()),
      }),
      req.body ?? {},
    );
    const language = requireLanguage(input.language ?? req.query.language);
    setAssignments(currentUserId(), language, input.assignments);
    res.json(payload(currentUserId(), language));
  }),
);

/** 每个语种自己的试听语料与全局语速 */
voicesRouter.put(
  '/voices/prefs',
  asyncHandler(async (req, res) => {
    const input = parseBody(
      z.object({
        language: LanguageInput.optional(),
        sampleText: z.string().max(600).optional(),
        globalRate: z.number().min(0.5).max(1.4).optional(),
      }),
      req.body ?? {},
    );
    const language = requireLanguage(input.language ?? req.query.language);
    setPrefs(currentUserId(), language, {
      sampleText: input.sampleText,
      globalRate: input.globalRate,
    });
    res.json(payload(currentUserId(), language));
  }),
);

/** 云端音色：服务端代理合成，返回音频二进制（Key 不出后端） */
voicesRouter.post(
  '/voices/:id/synthesize',
  asyncHandler(async (req, res) => {
    const language = resolveLanguage(req.body?.language ?? req.query.language);
    const voice = getVoice(currentUserId(), language, req.params.id);
    if (!voice) throw new NotFoundError('音色不存在或不属于当前语种');
    const input = parseBody(
      z.object({ text: z.string().trim().min(1).max(3000), rate: z.number().min(0.5).max(1.4).optional() }),
      req.body ?? {},
    );
    const { body, contentType } = await synthesizeSpeech(voice, input.text, input.rate);
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  }),
);

voicesRouter.post(
  '/voices/:id/default',
  asyncHandler(async (req, res) => {
    const language = resolveLanguage(req.body?.language ?? req.query.language);
    const voice = setDefaultVoice(currentUserId(), language, req.params.id);
    if (!voice) throw new NotFoundError('音色不存在或不属于当前语种');
    res.json(payload(currentUserId(), language));
  }),
);

voicesRouter.post(
  '/voices',
  asyncHandler(async (req, res) => {
    const input = parseBody(VoiceCreate, req.body ?? {});
    const language = requireLanguage(input.language ?? req.query.language);
    const { language: _lang, apiKey, ...fields } = input;
    const voice = insertVoice(
      currentUserId(),
      language,
      { ...fields, apiKey: sealVoiceKey(apiKey) ?? '' } as VoiceInput,
      { isDefault: countVoices(currentUserId(), language) === 0 },
    );
    logger.info('voice created', { language, provider: voice.provider, name: voice.name });
    res.status(201).json(payload(currentUserId(), language));
  }),
);

voicesRouter.put(
  '/voices/:id',
  asyncHandler(async (req, res) => {
    const input = parseBody(VoiceUpdate, req.body ?? {});
    const language = requireLanguage(input.language ?? req.query.language);
    const { language: _lang, apiKey, clearKey, ...patch } = input;
    const sealed = sealVoiceKey(apiKey);
    const next = updateVoice(currentUserId(), language, req.params.id, {
      ...patch,
      ...(sealed !== undefined ? { apiKey: sealed } : {}),
      ...(clearKey ? { apiKey: '' } : {}),
    });
    if (!next) throw new NotFoundError('音色不存在或不属于当前语种');
    res.json(payload(currentUserId(), language));
  }),
);

/** 只删应用内记录：操作系统里安装的声音完全不受影响 */
voicesRouter.delete(
  '/voices/:id',
  asyncHandler(async (req, res) => {
    const language = requireLanguage(req.body?.language ?? req.query.language);
    if (!deleteVoice(currentUserId(), language, req.params.id)) {
      throw new NotFoundError('音色不存在或不属于当前语种');
    }
    // 删掉默认音色时，把同语种剩下的一条顶上来，避免出现「没有可用音色」
    const rest = listVoices(currentUserId(), language);
    if (rest.length > 0 && !rest.some((item) => item.isDefault)) {
      setDefaultVoice(currentUserId(), language, rest[0].id);
    }
    res.json(payload(currentUserId(), language));
  }),
);
