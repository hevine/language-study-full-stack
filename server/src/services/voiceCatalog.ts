/**
 * 音色目录与语音合成服务。
 *
 * 三条音色来源：
 * 1) 浏览器/系统声音（browser）——零配置、立刻可用，引用 OS 里的声音，删记录不影响系统；
 * 2) 云端大模型 TTS（cloud）——OpenAI 兼容 /audio/speech，服务端代理，音色更自然；
 * 3) 大模型按语种推荐（discover）——把当下流行的音色/风格整理成可导入的候选。
 */
import { z } from 'zod';
import type { Language } from '../domain/language';
import { UpstreamError } from '../lib/errors';
import { logger } from '../lib/logger';
import { openSecret, redactSecret, sealSecret } from '../lib/secret';
import {
  countVoices,
  insertVoice,
  listVoices,
  SAMPLE_TEXT,
  setAssignments,
  setDefaultVoice,
  setPrefs,
  type VoiceAssignments,
  type VoiceInput,
  type VoiceRecord,
  VOICE_SCENES,
} from '../repositories/voices';
import { chatJson, resolveLlmConfig } from './llm';
import {
  EDGE_VOICES,
  isLocalEdge,
  LOCAL_EDGE_BASE,
  LOCAL_EDGE_KEY,
  LOCAL_EDGE_MODEL,
  synthesizeLocalEdge,
} from './edgeTts';

export interface PopularPreset extends VoiceInput {
  key: string;
  /** 展示用：是否推荐 / 是否云端 */
  highlight?: boolean;
}

const browserPreset = (input: Partial<VoiceInput> & { name: string; persona: string }): VoiceInput => ({
  provider: 'browser',
  engineVoice: '',
  matchHint: '',
  model: '',
  baseUrl: '',
  apiKey: '',
  voiceId: '',
  style: '',
  tags: [],
  rate: 0.9,
  pitch: 1,
  volume: 1,
  source: 'preset',
  ...input,
});

const cloudPreset = (input: Partial<VoiceInput> & { name: string; persona: string }): VoiceInput => ({
  provider: 'cloud',
  engineVoice: '',
  matchHint: '',
  model: 'gpt-4o-mini-tts',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  voiceId: 'nova',
  style: '',
  tags: [],
  rate: 0.92,
  pitch: 1,
  volume: 1,
  source: 'preset',
  ...input,
});

/** 本地 Edge Neural 预设：音色名只在 edgeTts.ts 维护一处 */
function edgePresets(language: Language): PopularPreset[] {
  return EDGE_VOICES[language].map((item, index) => ({
    key: `${language}-edge-${index}`,
    highlight: index === 0,
    ...cloudPreset({
      name: item.name,
      persona: item.persona,
      baseUrl: LOCAL_EDGE_BASE,
      model: LOCAL_EDGE_MODEL,
      voiceId: item.voiceId,
      tags: item.tags,
      rate: item.rate,
    }),
  }));
}

/** 内置流行音色：浏览器音色按名字关键词智能匹配，云端音色需用户填自己的 TTS Key */
export const POPULAR_PRESETS: Record<Language, PopularPreset[]> = {
  en: [
    {
      key: 'en-warm',
      highlight: true,
      ...browserPreset({
        name: '晨曦 · 悦耳暖声',
        persona: '温暖清亮 · 新闻主播气质',
        matchHint: 'Samantha|Ava|Jenny|Aria|Serena|Google US English|Zira',
        tags: ['流行', '女声', '托福'],
        rate: 0.88,
      }),
    },
    {
      key: 'en-exam',
      ...browserPreset({
        name: '考场 · 标准美音',
        persona: '字正腔圆 · 考场播报风',
        matchHint: 'Alex|Daniel|David|Google US English|Guy',
        tags: ['考试', '标准'],
        rate: 0.9,
      }),
    },
    {
      key: 'en-doc',
      ...browserPreset({
        name: '纪录片 · 沉稳旁白',
        persona: '低沉从容 · 学术讲座气质',
        matchHint: 'Brian|Ryan|Andrew|Daniel|Google UK English Male',
        tags: ['旁白', '男声'],
        rate: 0.86,
      }),
    },
    {
      key: 'en-cloud-nova',
      highlight: true,
      ...cloudPreset({
        name: 'Nova · 自然女声（云端）',
        persona: '自然流畅 · 接近真人',
        voiceId: 'nova',
        style: 'Warm, clear and natural. Speak at a measured pace for language learners.',
        tags: ['云端', '流行', '女声'],
      }),
    },
    {
      key: 'en-cloud-onyx',
      ...cloudPreset({
        name: 'Onyx · 磁性男声（云端）',
        persona: '沉稳磁性 · 纪录片旁白',
        voiceId: 'onyx',
        style: 'Calm, grounded narration with precise articulation.',
        tags: ['云端', '男声'],
      }),
    },
    ...edgePresets('en'),
  ],
  ja: [
    {
      key: 'ja-clear',
      highlight: true,
      ...browserPreset({
        name: '清水 · 清澈女声',
        persona: '清冷知性 · 女主播气质',
        matchHint: 'Kyoko|O-Ren|Oren|Sayaka|Nanami|Google 日本語|Haruka',
        tags: ['流行', '女声', 'JLPT'],
        rate: 0.86,
      }),
    },
    {
      key: 'ja-exam',
      ...browserPreset({
        name: '考场 · 标准日语',
        persona: '平稳清晰 · 听解播报风',
        matchHint: 'Kyoko|Otoya|Google 日本語|Ichiro',
        tags: ['考试', '标准'],
        rate: 0.88,
      }),
    },
    {
      key: 'ja-warm',
      ...browserPreset({
        name: '暖流 · 温润男声',
        persona: '温润磁性 · 男旁白气质',
        matchHint: 'Otoya|Kenji|Ichiro|Hattori',
        tags: ['旁白', '男声'],
        rate: 0.86,
      }),
    },
    {
      key: 'ja-cloud-alloy',
      highlight: true,
      ...cloudPreset({
        name: 'Alloy · 中性自然（云端）',
        persona: '自然中性 · 适合精听',
        voiceId: 'alloy',
        style: '落ち着いた自然な日本語。学習者向けに明瞭で、ややゆっくり話す。',
        tags: ['云端', '流行'],
        rate: 0.88,
      }),
    },
    {
      key: 'ja-cloud-shimmer',
      ...cloudPreset({
        name: 'Shimmer · 柔和女声（云端）',
        persona: '柔和通透 · 朗读悦耳',
        voiceId: 'shimmer',
        style: '柔らかく清楚な日本語の読み上げ。聞き取りやすく、丁寧な発音。',
        tags: ['云端', '女声'],
      }),
    },
    ...edgePresets('ja'),
  ],
  ko: [
    {
      key: 'ko-bright',
      highlight: true,
      ...browserPreset({
        name: '새벽 · 明亮女声',
        persona: '明亮通透 · 播音气质',
        matchHint: 'Yuna|Seoyeon|Google 한국어|Nari|Ko-KR',
        tags: ['流行', '女声', 'TOPIK'],
        rate: 0.86,
      }),
    },
    {
      key: 'ko-exam',
      ...browserPreset({
        name: '考场 · 标准韩语',
        persona: '平稳清晰 · 听解播报风',
        matchHint: 'Yuna|Google 한국어|Junho|Ko-KR',
        tags: ['考试', '标准'],
        rate: 0.88,
      }),
    },
    {
      key: 'ko-calm',
      ...browserPreset({
        name: '느긋 · 稳重男声',
        persona: '沉稳从容 · 旁白气质',
        matchHint: 'Junho|Injoon|Google 한국어|Ko-KR',
        tags: ['旁白', '男声'],
        rate: 0.86,
      }),
    },
    {
      key: 'ko-cloud-nova',
      highlight: true,
      ...cloudPreset({
        name: 'Nova · 自然女声（云端）',
        persona: '自然流畅 · 接近真人',
        voiceId: 'nova',
        style: '또렷하고 자연스러운 한국어. 언어 학습자를 위해 조금 느리게 읽어 준다.',
        tags: ['云端', '流行', '女声'],
      }),
    },
    {
      key: 'ko-cloud-fable',
      ...cloudPreset({
        name: 'Fable · 叙述男声（云端）',
        persona: '温和叙事 · 精读朗读',
        voiceId: 'fable',
        style: '차분하고 따뜻한 한국어 낭독. 문장 끝까지 또렷하게.',
        tags: ['云端', '男声'],
      }),
    },
    ...edgePresets('ko'),
  ],
};

/** 首次进入某语种时播种三条「立刻能响」的浏览器音色，不让用户面对空列表 */
export function ensureVoiceSeed(userId: string, language: Language): void {
  if (countVoices(userId, language) > 0) return;
  const presets = POPULAR_PRESETS[language].filter((item) => item.provider === 'browser');
  presets.forEach((preset, index) => {
    const { key: _key, highlight: _highlight, ...input } = preset;
    insertVoice(userId, language, input, { isDefault: index === 0 });
  });
  setPrefs(userId, language, { sampleText: SAMPLE_TEXT[language], globalRate: 0.9 });
  logger.info('voice presets seeded', { language, count: presets.length });
}

/**
 * 一键为「当前语种」启用本地 Edge Neural：补音色、设默认、四个场景全部绑定。
 * 只写这一个 language，其它语种的音色与分配完全不动，隔离约定不变。
 */
export function enableLocalEdgeVoices(
  userId: string,
  language: Language,
): { added: number; primaryId: string; names: string[] } {
  ensureVoiceSeed(userId, language);
  const existing = new Map(listVoices(userId, language).map((item) => [item.name, item]));
  const ids: string[] = [];
  let added = 0;
  for (const preset of EDGE_VOICES[language]) {
    const found = existing.get(preset.name);
    if (found) {
      ids.push(found.id);
      continue;
    }
    const voice = insertVoice(userId, language, {
      name: preset.name,
      provider: 'cloud',
      engineVoice: '',
      matchHint: '',
      model: LOCAL_EDGE_MODEL,
      baseUrl: LOCAL_EDGE_BASE,
      apiKey: sealSecret(LOCAL_EDGE_KEY),
      voiceId: preset.voiceId,
      style: '',
      persona: preset.persona,
      tags: preset.tags,
      rate: preset.rate,
      pitch: 1,
      volume: 1,
      source: 'preset',
    });
    ids.push(voice.id);
    added += 1;
  }
  const primaryId = ids[0];
  setDefaultVoice(userId, language, primaryId);
  const assignments: Partial<VoiceAssignments> = {};
  for (const scene of VOICE_SCENES) assignments[scene] = primaryId;
  setAssignments(userId, language, assignments);
  logger.info('local edge voices enabled', { language, added, primaryId });
  return { added, primaryId, names: EDGE_VOICES[language].map((item) => item.name) };
}

/** 把明文 Key 加密后存库；空字符串表示不修改已有 Key */
export function sealVoiceKey(plain: string | undefined): string | undefined {
  if (plain === undefined) return undefined;
  return plain.trim() ? sealSecret(plain.trim()) : '';
}

export interface VoiceCandidate {
  key: string;
  name: string;
  persona: string;
  provider: 'browser' | 'cloud';
  matchHint: string;
  voiceId: string;
  model: string;
  style: string;
  tags: string[];
  rate: number;
}

const DiscoverySchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        persona: z.string().default(''),
        provider: z.enum(['browser', 'cloud']).default('browser'),
        matchHint: z.string().default(''),
        voiceId: z.string().default(''),
        model: z.string().default(''),
        style: z.string().default(''),
        tags: z.array(z.string()).default([]),
        rate: z.number().min(0.5).max(1.4).default(0.9),
      }),
    )
    .min(3)
    .max(8),
});

const SYSTEM_PROMPT = `你是一位语音产品与语言教学专家，熟悉各语种主流的语音合成音色与发音人。
用户会给你一个学习语种，请推荐适合「语言学习 / 精听 / 朗读跟读」的流行音色。
要求：
1. 只输出 JSON：{"items":[...]}。
2. 每条含 name（中文音色名，8 字以内）、persona（中文听感描述，10–20 字）、provider、matchHint、voiceId、model、style、tags、rate。
3. provider="browser" 时，matchHint 填浏览器语音名称里常见的英文/日文/韩文关键词，用 | 分隔多个备选；voiceId 留空。
4. provider="cloud" 时，voiceId 只能用 alloy / echo / fable / onyx / nova / shimmer 之一，model 填 gpt-4o-mini-tts，style 用该语种写一句发音风格指令。
5. 给 5–6 条，browser 与 cloud 都要有；tags 用中文短语；rate 在 0.8–1.0 之间。
不要解释、不要 markdown 代码块。`;

/**
 * 让大模型按语种整理一份「当下流行音色」候选；模型不可用时回退到内置目录，
 * 保证这个入口永远有结果，不把用户卡在空页面上。
 */
export async function discoverVoices(
  language: Language,
): Promise<{ items: VoiceCandidate[]; source: 'ai' | 'builtin'; notice: string | null; model: string | null }> {
  const fallback = (): VoiceCandidate[] =>
    POPULAR_PRESETS[language].map((preset) => ({
      key: preset.key,
      name: preset.name,
      persona: preset.persona,
      provider: preset.provider,
      matchHint: preset.matchHint,
      voiceId: preset.voiceId,
      model: preset.model,
      style: preset.style,
      tags: preset.tags,
      rate: preset.rate,
    }));

  const { config } = resolveLlmConfig();
  if (!config) {
    return {
      items: fallback(),
      source: 'builtin',
      notice: '未配置大模型，已展示内置流行音色目录；配置模型后可让 AI 按语种重新推荐。',
      model: null,
    };
  }

  try {
    const result = await chatJson(
      config,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `请为「${{ en: '英语', ja: '日语', ko: '韩语' }[language]}」推荐音色，输出 JSON。`,
        },
      ],
      DiscoverySchema,
      { temperature: 0.8, maxTokens: 2200, retries: 1 },
    );
    const items: VoiceCandidate[] = result.items.map((item, index) => ({
      ...item,
      key: `ai-${Date.now()}-${index}`,
      tags: item.tags.length > 0 ? item.tags : ['AI 推荐'],
    }));
    return { items, source: 'ai', notice: null, model: config.usedModel ?? config.model };
  } catch (err) {
    logger.warn('voice discovery failed, fallback to builtin catalog', {
      language,
      message: (err as Error).message,
    });
    return {
      items: fallback(),
      source: 'builtin',
      notice: `AI 推荐失败（${(err as Error).message.slice(0, 60)}），已展示内置流行音色目录。`,
      model: null,
    };
  }
}

/** 服务端代理云端 TTS：Key 不出后端，前端只拿到音频字节 */
export async function synthesizeSpeech(
  voice: VoiceRecord,
  text: string,
  rate?: number,
): Promise<{ body: Buffer; contentType: string }> {
  if (voice.provider !== 'cloud') {
    throw new UpstreamError('这个音色不是云端音色，无需服务端合成');
  }
  const effectiveRate = rate ?? voice.rate;
  // 本地 Edge Neural：不需要 Key、不走网络代理，直接起 Python 子进程合成
  if (isLocalEdge(voice.baseUrl)) {
    const body = await synthesizeLocalEdge({
      voice: voice.voiceId,
      input: text,
      rate: effectiveRate,
    });
    return { body, contentType: 'audio/mpeg' };
  }
  const apiKey = openSecret(voice.apiKey);
  if (!apiKey) throw new UpstreamError('云端音色还没填 API Key，请在「设置 → 音色库」里补齐');
  const baseUrl = voice.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new UpstreamError('TTS 服务地址不合法，需要以 http:// 或 https:// 开头');
  }
  if (!voice.model.trim() || !voice.voiceId.trim()) {
    throw new UpstreamError('云端音色缺少 model 或 voice 参数');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const payload: Record<string, unknown> = {
    model: voice.model.trim(),
    voice: voice.voiceId.trim(),
    input: text.slice(0, 3000),
    speed: effectiveRate,
  };
  // instructions 只有 mini-tts 系列支持，其它模型带上会 400
  if (/mini-tts/i.test(voice.model) && voice.style.trim()) {
    payload.instructions = voice.style.trim();
  }

  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new UpstreamError(`语音合成接口返回 ${response.status}`, {
        status: response.status,
        snippet: redactSecret(body.slice(0, 300)),
      });
    }
    const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
    if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
      const body = await response.text().catch(() => '');
      throw new UpstreamError('语音合成接口没有返回音频', {
        status: 200,
        snippet: redactSecret(body.slice(0, 200)),
      });
    }
    return { body: Buffer.from(await response.arrayBuffer()), contentType };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    const timeout = (err as Error)?.name === 'AbortError';
    throw new UpstreamError(timeout ? '语音合成超时（30 秒）' : `语音合成接口连不上：${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
