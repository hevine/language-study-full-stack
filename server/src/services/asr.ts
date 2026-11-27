/**
 * 语音识别（ASR / speech-to-text）
 * ============================================================
 * 「口语练习 / 录音与转写」过去完全依赖浏览器 Web Speech API：
 * 国内 Chrome 往往连不上 Google 的识别服务，用户录完音转写框一直是空的。
 * 这里把录音字节上传到服务端，走 OpenAI 兼容的 /audio/transcriptions，
 * Key 不出后端；按目标语言 en/ja/ko 传 language + prompt，让输出锁定目标语种。
 *
 * 线路来自 ASR 号池（asrPool.ts）：按优先级依次尝试，一条连不通自动切下一条，
 * 失败的线路挂冷却。环境变量线路作为最后一条只读兜底。
 *
 * 传输仍沿用本项目的约定：浏览器以 application/octet-stream 发原始字节，
 * 服务端再用 Node 原生 FormData 包成 multipart 转给上游，不引入 multer 依赖。
 */
import type { Language } from '../domain/language';
import { ConfigError, UpstreamError } from '../lib/errors';
import { logger } from '../lib/logger';
import { redactSecret } from '../lib/secret';
import {
  addAsrPoolKey,
  asrPoolCandidates,
  asrPoolSummary,
  classifyAsrFailure,
  listAsrPoolKeys,
  markAsrFailure,
  markAsrSuccess,
  type AsrCandidate,
  type AsrPoolKeyView,
  type AsrPoolSummary,
  type AsrFailureInfo,
} from './asrPool';
import { ensureLocalAsr, isLoopbackUrl } from './localAsr';
import { hasTranscriptContent, sanitizeTranscript, type TranscriptLang } from '../lib/transcript';

/** ISO 639-1 + 引导 prompt：让多语言模型按目标语种输出，而不是跟着口音跑偏 */
const LANGUAGE_HINT: Record<Language, { iso: string; prompt: string }> = {
  en: {
    iso: 'en',
    prompt:
      'Transcribe this English language practice recording. Output English text only. Do not output emoji, emoticons, or emotion tags.',
  },
  ja: {
    iso: 'ja',
    prompt:
      'この日本語学習の録音を文字起こししてください。日本語のテキストのみを出力してください。絵文字・顔文字・感情タグは出力しないでください。',
  },
  ko: {
    iso: 'ko',
    prompt:
      '이 한국어 학습 녹음을 전사해 주세요. 한국어 텍스트만 출력하세요. 이모지나 감정 태그는 출력하지 마세요.',
  },
};

export interface AsrSettingsView {
  configured: boolean;
  source: 'env' | 'pool' | 'none';
  suggestion: { baseUrl: string; model: string; note: string };
  keys: AsrPoolKeyView[];
  summary: AsrPoolSummary;
}

/** 读取设置页展示用的号池视图（Key 永远是掩码） */
export function readAsrSettings(): AsrSettingsView {
  const summary = asrPoolSummary();
  const keys = listAsrPoolKeys();
  const hasEnv = keys.some((key) => key.source === 'env');
  return {
    configured: summary.ready > 0,
    source: summary.ready > 0 ? (hasEnv && summary.activeLabel === '环境变量线路' ? 'env' : 'pool') : 'none',
    suggestion: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'FunAudioLLM/SenseVoiceSmall',
      note: '硅基流动 SenseVoiceSmall：免费、支持中/英/日/韩，OpenAI 兼容 /audio/transcriptions',
    },
    keys,
    summary,
  };
}

/**
 * 兼容旧版单线路设置入口：填了 Key 就当成「新增一条线路」加入号池。
 * 新的界面走 /settings/asr/keys，这里保留是为了脚本与旧书签不失效。
 */
export function saveAsrSettings(input: { baseUrl: string; model: string; apiKey?: string }): AsrSettingsView {
  if (input.apiKey?.trim() && input.baseUrl.trim() && input.model.trim()) {
    addAsrPoolKey({
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      label: '默认识别线路',
    });
  }
  return readAsrSettings();
}

export interface TranscribeResult {
  text: string;
  language: Language;
  model: string;
  source: AsrSettingsView['source'];
  /** 实际命中并能出声的那条线路名，便于界面提示 */
  line: string;
  /** 词级时间戳（秒 → 毫秒）；线路支持才有，不支持时为 undefined，绝不补零凑数 */
  words?: Array<{ word: string; startMs: number; endMs: number }>;
  segments?: Array<{ text: string; startMs: number; endMs: number }>;
  /** 上游报的音频时长；识别线路给得比浏览器准 */
  durationMs?: number;
}

interface AsrCallResult {
  text: string;
  words?: Array<{ word: string; startMs: number; endMs: number }>;
  segments?: Array<{ text: string; startMs: number; endMs: number }>;
  durationMs?: number;
}

interface AsrCallFailure {
  status: number;
  snippet: string;
  timeout: boolean;
  network: boolean;
  empty: boolean;
  /** 线路不认 verbose_json / timestamp_granularities，换普通 json 再来一次即可 */
  unsupportedFormat?: boolean;
}

/**
 * 哪些线路不支持 verbose_json：负缓存。
 *
 * 硅基流动的 SenseVoiceSmall 只认 json，每次都先试 verbose_json 再回退
 * 等于给每段录音白加一次往返 —— 口语场景本来就要等两秒，这一下能省一半。
 * key 用 baseUrl+model：换线路就不再走旧结论。
 */
const NO_VERBOSE = new Set<string>();

function lineKey(candidate: AsrCandidate): string {
  return `${candidate.baseUrl.replace(/\/+$/, '')}|${candidate.model}`;
}

/** 单条线路调用；成功返回文本，失败抛 AsrCallFailure（统一结构，便于号池分类） */
async function postTranscription(
  candidate: AsrCandidate,
  audio: Buffer | null,
  fileName: string,
  hint: { iso: string; prompt: string },
  opts: { verbose?: boolean } = {},
): Promise<AsrCallResult> {
  const form = new FormData();
  const bytes = audio ? new Uint8Array(audio) : new Uint8Array(makeTestWav());
  form.append('file', new Blob([bytes]), fileName);
  form.append('model', candidate.model);
  form.append('language', hint.iso);
  form.append('prompt', hint.prompt);
  form.append('response_format', opts.verbose ? 'verbose_json' : 'json');
  if (opts.verbose) {
    // OpenAI 系的写法；不认识的实现通常会忽略未知字段，真报错则回退 json
    form.append('timestamp_granularities[]', 'word');
  }
  form.append('temperature', '0');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), candidate.timeoutMs);
  try {
    const response = await fetch(`${candidate.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${candidate.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw {
        status: response.status,
        snippet: redactSecret((await response.text().catch(() => '')).slice(0, 300)),
        timeout: false,
        network: false,
        empty: false,
        // 4xx 大概率是参数不被接受；真正鉴权错误也会是 4xx，但回退一次 json 不影响判定
        unsupportedFormat: Boolean(opts.verbose) && response.status >= 400 && response.status < 500,
      } as AsrCallFailure;
    }
    const raw = await response.text();
    let text = '';
    let words: AsrCallResult['words'];
    let segments: AsrCallResult['segments'];
    let durationMs: number | undefined;
    try {
      const parsed = JSON.parse(raw) as {
        text?: unknown;
        words?: unknown;
        segments?: unknown;
        duration?: unknown;
      };
      text = typeof parsed.text === 'string' ? parsed.text : '';
      const lang = hint.iso as TranscriptLang;
      words = parseWords(parsed.words, lang);
      segments = parseSegments(parsed.segments, lang);
      if (typeof parsed.duration === 'number' && parsed.duration > 0) {
        durationMs = Math.round(parsed.duration * 1000);
      }
    } catch {
      text = raw.trim();
    }
    // SenseVoice 系会把 😌 这类情感表情和 <|HAPPY|> 标签写进正文：出口统一清掉，
    // 清完只剩标点也按「没识别出内容」处理，交给号池换下一条线路。
    text = sanitizeTranscript(text, hint.iso as TranscriptLang);
    if (!text || !hasTranscriptContent(text)) {
      throw { status: response.status, snippet: '', timeout: false, network: false, empty: true } as AsrCallFailure;
    }
    return { text, words, segments, durationMs };
  } catch (err) {
    if (isCallFailure(err)) throw err;
    const timeout = (err as Error)?.name === 'AbortError';
    throw {
      status: 0,
      snippet: (err as Error).message,
      timeout,
      network: true,
      empty: false,
    } as AsrCallFailure;
  } finally {
    clearTimeout(timer);
  }
}

/** 上游时间戳是**秒**（浮点）；负值或逆序一律丢弃，宁可没有也不给错的数据 */
function parseWords(value: unknown, lang: TranscriptLang): AsrCallResult['words'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<AsrCallResult['words']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { word?: unknown; start?: unknown; end?: unknown };
    if (typeof row.word !== 'string' || !row.word.trim()) continue;
    const start = Number(row.start);
    const end = Number(row.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue;
    // 词里也可能挂着 emoji；清完为空说明这个词本身就是模型标注，直接丢掉
    const word = sanitizeTranscript(row.word, lang);
    if (!word) continue;
    out.push({
      word,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseSegments(value: unknown, lang: TranscriptLang): AsrCallResult['segments'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<AsrCallResult['segments']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { text?: unknown; start?: unknown; end?: unknown };
    const start = Number(row.start);
    const end = Number(row.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue;
    out.push({
      text: typeof row.text === 'string' ? sanitizeTranscript(row.text, lang) : '',
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
    });
  }
  return out.length > 0 ? out : undefined;
}

function isCallFailure(err: unknown): err is AsrCallFailure {
  return Boolean(err) && typeof err === 'object' && 'network' in (err as object) && 'empty' in (err as object);
}

/**
 * 把录音字节转成目标语言文本：遍历号池，第一条成功即返回；
 * 失败的线路记录原因并挂冷却，全部失败才把聚合错误抛给用户。
 *
 * withTiming 只在口语评测里开：它要额外地请求词级时间戳。
 * 拿不到时间戳不算失败 —— 文本已经拿到了，节奏可以退到声学检测去测。
 */
export async function transcribeAudio(
  audio: Buffer,
  language: Language,
  fileName = 'recording.webm',
  opts: { withTiming?: boolean } = {},
): Promise<TranscribeResult> {
  const candidates = asrPoolCandidates();
  if (candidates.length === 0) {
    throw new ConfigError(
      '还没有可用的语音识别线路。请在「设置 → 音色与朗读 → 语音识别」添加一条转录服务（Base URL + API Key + 模型）。',
      undefined,
      true,
    );
  }

  const hint = LANGUAGE_HINT[language];
  const failures: string[] = [];
  let sawEmpty = false;

  for (const candidate of candidates) {
    try {
      // 本地兜底线路可能没在跑（比如刚开机）：先确保服务起来再发请求，
      // 起不来就当作这条线路失败，继续走剩下的线路。
      if (isLoopbackUrl(candidate.baseUrl) && !(await ensureLocalAsr(candidate.baseUrl))) {
        failures.push(`${candidate.label}：本地服务未就绪（请执行 npm run asr:setup 安装，或 npm run asr:start 手动启动）`);
        logger.warn('本地 ASR 兜底未就绪', { line: candidate.label });
        continue;
      }

      const result = await postTranscription(candidate, audio, fileName, hint, {
        verbose: Boolean(opts.withTiming) && !NO_VERBOSE.has(lineKey(candidate)),
      });
      if (opts.withTiming && !result.words && !result.segments && !NO_VERBOSE.has(lineKey(candidate))) {
        // 通了但没给时间戳：说明这条实现不返时间戳，记下来别再问
        NO_VERBOSE.add(lineKey(candidate));
      }

      markAsrSuccess(candidate.keyId);
      logger.info('asr transcribed', {
        language,
        line: candidate.label,
        source: candidate.source,
        model: candidate.model,
        bytes: audio.length,
        chars: result.text.length,
        words: result.words?.length ?? 0,
        segments: result.segments?.length ?? 0,
      });
      return {
        text: result.text,
        language,
        model: candidate.model,
        source: candidate.source === 'env' ? 'env' : 'pool',
        line: candidate.label,
        words: result.words,
        segments: result.segments,
        durationMs: result.durationMs,
      };
    } catch (err) {
      const failure = err as AsrCallFailure;
      if (failure.unsupportedFormat) {
        // 这条线路不认 verbose_json：标记后原地重试一次普通 json，别切线路
        NO_VERBOSE.add(lineKey(candidate));
        logger.info('asr line 不支持 verbose_json，回退普通 json', { line: candidate.label });
        try {
          const result = await postTranscription(candidate, audio, fileName, hint);
          markAsrSuccess(candidate.keyId);
          return {
            text: result.text,
            language,
            model: candidate.model,
            source: candidate.source === 'env' ? 'env' : 'pool',
            line: candidate.label,
          };
        } catch (retryErr) {
          const retryFailure = retryErr as AsrCallFailure;
          if (!retryFailure.empty) {
            failures.push(`${candidate.label}：回退 json 后仍失败（${retryFailure.status || '网络'}）`);
          }
          continue;
        }
      }
      if (failure.empty) {
        // 线路连通、只是这段录音没有可识别内容：不算线路故障，换下一条试试
        sawEmpty = true;
        continue;
      }
      let info: AsrFailureInfo;
      if (failure.network) {
        info = {
          kind: 'transient',
          switchable: true,
          cooldownMs: 30_000,
          message: failure.timeout ? '识别超时' : `连不上：${failure.snippet}`,
        };
      } else {
        info = classifyAsrFailure(failure.status, failure.snippet);
      }
      markAsrFailure(candidate.keyId, info);
      failures.push(`${candidate.label}：${info.message}`);
      logger.warn('asr line failed, switching', { line: candidate.label, status: failure.status, reason: info.message });
    }
  }

  if (sawEmpty && failures.length === 0) {
    throw new UpstreamError('语音识别没有返回文本，请确认录音里确实有说话声');
  }
  throw new UpstreamError(
    `所有语音识别线路都不可用：${failures.join('；')}${sawEmpty ? '（另有线路连上了但没识别出内容）' : ''}`,
    { lines: failures, empty: sawEmpty },
  );
}

/** 生成一段 0.5 秒 440Hz 的正弦波 WAV，用作线路连通测试的样本音频 */
function makeTestWav(): Buffer {
  const rate = 16_000;
  const seconds = 0.5;
  const frames = Math.floor(rate * seconds);
  const dataBytes = frames * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const value = Math.sin(2 * Math.PI * 440 * t) * 0.2;
    buf.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buf;
}

export interface AsrPingResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  status?: number;
  snippet?: string;
  text?: string;
}

/** 用一小段内置音频真实调用转录接口，验证某条线路是否可用 */
export async function pingAsr(
  config: { baseUrl: string; apiKey: string; model: string; keyId?: string | null; timeoutMs?: number },
): Promise<AsrPingResult> {
  const candidate: AsrCandidate = {
    keyId: config.keyId ?? null,
    label: '测试线路',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs ?? 30_000,
    source: config.keyId ? 'db' : 'env',
  };
  const started = Date.now();
  try {
    if (isLoopbackUrl(candidate.baseUrl) && !(await ensureLocalAsr(candidate.baseUrl))) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: '本地服务未就绪：先执行 npm run asr:setup 安装，再重试',
      };
    }
    const result = await postTranscription(candidate, null, 'test-tone.wav', LANGUAGE_HINT.en);
    markAsrSuccess(candidate.keyId);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `连接成功（模型返回 ${result.text.length} 个字符）`,
      text: result.text.slice(0, 80),
    };
  } catch (err) {
    const failure = err as AsrCallFailure;
    const latencyMs = Date.now() - started;
    // 测试音是纯音调、不是人声：HTTP 200 但识别为空恰恰说明地址/Key/模型都通了
    if (failure.empty) {
      markAsrSuccess(candidate.keyId);
      return {
        ok: true,
        latencyMs,
        message: '连接成功（测试音未含人声，模型返回空文本属正常）',
      };
    }
    const info = failure.network
      ? {
          kind: 'transient' as const,
          switchable: true,
          cooldownMs: 30_000,
          message: failure.timeout ? '连接超时' : `连不上：${failure.snippet}`,
        }
      : classifyAsrFailure(failure.status, failure.snippet);
    // 测试如实记账：测出 Key 失效就该显示失效，避免「横幅报错、状态却写着可用」
    markAsrFailure(candidate.keyId, info);
    return {
      ok: false,
      latencyMs,
      message: info.message,
      status: failure.status || undefined,
      snippet: failure.snippet || undefined,
    };
  }
}
