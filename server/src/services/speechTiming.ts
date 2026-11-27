/**
 * 口语节奏测量：把一段录音变成「语速 / 停顿 / 发声占比」这些可核对的事实。
 *
 * 两条路：
 * 1. 识别引擎给了时间戳（词级优先、分段次之）→ 直接用，最准；
 * 2. 没给 → 自己解码波形做声学检测。用 ffmpeg 解成 16k 单声道 PCM，
 *    按 20ms 一帧算 RMS，用自适应噪声门限分出「有声/无声」，再把间隔合并成停顿。
 *
 * 为什么不用固定阈值切静音：手机录音的底噪差一个数量级，写死 -40dBFS
 * 在有底噪的录音上会把整段判成有声，在安静的录音上会把气声切碎。
 * 所以门限从这段音频自己的能量分布里取（15 分位当底噪），再乘一个倍数。
 *
 * 这一层只产出**测量值**，不打分。打分是语言相关的事，放在 adapters/en.ts，
 * 因为「英语 130 wpm 算从容、日语不是」这种判断不该混进信号处理里。
 */
import { spawn } from 'node:child_process';
import { logger } from '../lib/logger';
import {
  PAUSE_MIN_MS,
  PROSODY_SOURCE_LABEL,
  type ClosureSpan,
  type PauseSpan,
  type PitchProfile,
  type ProsodyMeasurement,
  type ProsodySource,
  type SegmentSpan,
  type WordSpan,
} from '../domain/speech';

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
/** 短于这个的分段当作杂音（咳嗽、碰麦）丢掉 */
const MIN_SPEECH_MS = 50;
/** 两个有声段之间短于这个的缝，算同一个词内部，不拆 */
const MERGE_GAP_MS = 120;
const DECODE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

/**
 * 解成 16k 单声道 s16le。走 stdin 传字节、stdout 接 PCM，
 * 不落临时文件 —— 录音仓里已经有原件了，再写一份只会多一个要清理的东西。
 */
function decodePcm(buffer: Buffer): Promise<Int16Array | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        'pipe:1',
      ]);
    } catch {
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Int16Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      logger.warn('ffmpeg 解码超时，跳过声学测量');
      finish(null);
    }, DECODE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // stderr 必须读掉：不读会撑满管道把子进程卡死
    child.stderr.on('data', () => undefined);
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        finish(null);
        return;
      }
      const raw = Buffer.concat(chunks);
      // Int16Array 需要 2 字节对齐：Buffer 的 byteOffset 可能不是偶数，先复制一份
      const aligned = new Int16Array(raw.length / 2);
      for (let i = 0; i < aligned.length; i += 1) aligned[i] = raw.readInt16LE(i * 2);
      finish(aligned.length > 0 ? aligned : null);
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(buffer);
  });
}

// ---------------------------------------------------------------------------
// 声学检测
// ---------------------------------------------------------------------------

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

interface VadResult {
  durationMs: number;
  speechMs: number;
  speechRuns: Array<{ startMs: number; endMs: number }>;
  /** 60–220ms 的短闭塞：促音的声学候选，正常闭锁音也会有，只作展示不作判据 */
  closures: ClosureSpan[];
  leadInMs: number;
  tailMs: number;
}

const CLOSURE_MIN_MS = 60;
const CLOSURE_MAX_MS = 220;
/** 两侧都要有一段像样的发声，才算「两次发声之间」的闭塞，挡掉底噪抖动造成的碎片 */
const CLOSURE_MIN_SPEECH_MS = 100;

function detectSpeech(pcm: Int16Array): VadResult {
  const frameSize = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
  const frameCount = Math.floor(pcm.length / frameSize);
  const durationMs = Math.round((pcm.length / SAMPLE_RATE) * 1000);

  const energy: number[] = [];
  for (let f = 0; f < frameCount; f += 1) {
    let sum = 0;
    const offset = f * frameSize;
    for (let i = 0; i < frameSize; i += 1) {
      const value = pcm[offset + i] / 32768;
      sum += value * value;
    }
    energy.push(Math.sqrt(sum / frameSize));
  }
  if (energy.length === 0) {
    return { durationMs, speechMs: 0, speechRuns: [], closures: [], leadInMs: durationMs, tailMs: 0 };
  }

  const sorted = [...energy].sort((a, b) => a - b);
  const noiseFloor = percentile(sorted, 0.15);
  // 噪声门限：底噪的 2.6 倍，同时不低于一个绝对下限（极安静的录音不会因为门限太低而把气声当说话）
  const high = Math.max(noiseFloor * 2.6, 0.0055);
  const low = high * 0.55;

  const flags: boolean[] = [];
  let speaking = false;
  for (const value of energy) {
    if (speaking) {
      if (value < low) speaking = false;
    } else if (value > high) {
      speaking = true;
    }
    flags.push(speaking);
  }

  const runs: Array<{ startMs: number; endMs: number }> = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i += 1) {
    const active = i < flags.length ? flags[i] : false;
    if (active && start < 0) start = i;
    if (!active && start >= 0) {
      runs.push({ startMs: start * FRAME_MS, endMs: i * FRAME_MS });
      start = -1;
    }
  }

  // 合并短缝、丢弃短音
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.startMs - last.endMs < MERGE_GAP_MS) {
      last.endMs = run.endMs;
    } else {
      merged.push({ ...run });
    }
  }
  const speechRuns = merged.filter((run) => run.endMs - run.startMs >= MIN_SPEECH_MS);

  // 闭塞要在「合并短缝之前」的原始段上找：合并会把 ≤120ms 的缝吃掉，正好是促音的长度
  const closures: ClosureSpan[] = [];
  for (let i = 1; i < runs.length; i += 1) {
    const prev = runs[i - 1];
    const next = runs[i];
    if (prev.endMs - prev.startMs < CLOSURE_MIN_SPEECH_MS) continue;
    if (next.endMs - next.startMs < CLOSURE_MIN_SPEECH_MS) continue;
    const gap = next.startMs - prev.endMs;
    if (gap >= CLOSURE_MIN_MS && gap <= CLOSURE_MAX_MS) closures.push({ startMs: prev.endMs, endMs: next.startMs });
  }

  const speechMs = speechRuns.reduce((sum, run) => sum + (run.endMs - run.startMs), 0);
  const leadInMs = speechRuns.length > 0 ? speechRuns[0].startMs : durationMs;
  const tailMs = speechRuns.length > 0 ? Math.max(0, durationMs - speechRuns[speechRuns.length - 1].endMs) : 0;

  return { durationMs, speechMs, speechRuns, closures, leadInMs, tailMs };
}

// ---------------------------------------------------------------------------
// 音高轮廓
// ---------------------------------------------------------------------------

/**
 * 逐帧自相关求 F0。
 *
 * 为什么值得算：日语的アクセント是**词**层面的，判它需要知道每个モーラ在哪 ——
 * 拿不到。但「整段说话平不平」是波形本身给得出的，而平板单调恰恰是学习者
 * 最常见的韵律问题。这个指标不指词、不指音素，只说一个整体的抑扬范围。
 *
 * 先降到 8k：人的基频最高 400Hz 出头，8k 采样够用，而自相关的成本按采样率平方涨。
 */
const PITCH_DECIMATE = 2;
const PITCH_WINDOW_MS = 40;
const PITCH_HOP_MS = 20;
const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 420;
/** 归一化自相关低于这个值认为这一帧没有周期成分（清音、气声、噪音） */
const PITCH_MIN_CORRELATION = 0.45;

function frameF0(pcm: Int16Array, startSample: number, window: number, minLag: number, maxLag: number): number | null {
  const x = new Float32Array(window);
  let mean = 0;
  for (let i = 0; i < window; i += 1) {
    const value = (pcm[startSample + i * PITCH_DECIMATE] ?? 0) / 32768;
    x[i] = value;
    mean += value;
  }
  mean /= window;

  let energy = 0;
  for (let i = 0; i < window; i += 1) {
    x[i] -= mean;
    energy += x[i] * x[i];
  }
  if (energy < 1e-4) return null;

  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let tail = 0;
    for (let i = 0; i + lag < window; i += 1) {
      dot += x[i] * x[i + lag];
      tail += x[i + lag] * x[i + lag];
    }
    if (tail <= 0) continue;
    const score = dot / Math.sqrt(energy * tail);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (!bestLag || bestScore < PITCH_MIN_CORRELATION) return null;
  return SAMPLE_RATE / PITCH_DECIMATE / bestLag;
}

function analyzePitch(
  pcm: Int16Array,
  runs: Array<{ startMs: number; endMs: number }>,
  speechMs: number,
): PitchProfile | undefined {
  const rate = SAMPLE_RATE / PITCH_DECIMATE;
  const window = Math.round((rate * PITCH_WINDOW_MS) / 1000);
  const minLag = Math.floor(rate / PITCH_MAX_HZ);
  const maxLag = Math.ceil(rate / PITCH_MIN_HZ);

  const values: number[] = [];
  for (const run of runs) {
    for (let t = run.startMs; t + PITCH_WINDOW_MS <= run.endMs; t += PITCH_HOP_MS) {
      const f0 = frameF0(pcm, Math.round((t / 1000) * SAMPLE_RATE), window, minLag, maxLag);
      if (f0) values.push(f0);
    }
  }
  // 少于 20 帧（0.4 秒）的样本，分位数没有意义
  if (values.length < 20) return undefined;

  const sorted = [...values].sort((a, b) => a - b);
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  if (p10 <= 0 || p90 <= 0) return undefined;

  return {
    medianHz: Math.round(percentile(sorted, 0.5)),
    p10Hz: Math.round(p10),
    p90Hz: Math.round(p90),
    rangeSemitones: round(12 * Math.log2(p90 / p10), 1),
    voicedRatio: round(Math.min(1, (values.length * PITCH_HOP_MS) / Math.max(1, speechMs)), 2),
  };
}

// ---------------------------------------------------------------------------
// 缺口 → 停顿
// ---------------------------------------------------------------------------

/** 从「有声片段」序列里取停顿；首尾静音不算停顿（那是开口前的等待与收尾） */
function pausesFromRuns(runs: Array<{ startMs: number; endMs: number }>): PauseSpan[] {
  const out: PauseSpan[] = [];
  for (let i = 1; i < runs.length; i += 1) {
    const gap = runs[i].startMs - runs[i - 1].endMs;
    if (gap >= PAUSE_MIN_MS) out.push({ startMs: runs[i - 1].endMs, endMs: runs[i].startMs });
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function countEnglishWords(text: string): number {
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// 对外：一次测量
// ---------------------------------------------------------------------------

export interface MeasureInput {
  buffer: Buffer;
  text: string;
  words?: WordSpan[];
  segments?: SegmentSpan[];
  /** 客户端上报的时长，只在解码失败时兜底用 */
  claimedDurationMs?: number | null;
  /**
   * 「说了多少单位」由调用方给：英语是词数，日语是モーラ数。
   *
   * 这一层不做分词 —— 它只管时间。让它去猜语言，等于把分词精度问题
   * 藏进测量层，出错时谁也说不清是识别错了还是数错了。
   */
  wordCount?: number;
}

export async function measureProsody(input: MeasureInput): Promise<ProsodyMeasurement | null> {
  const pcm = await decodePcm(input.buffer);
  const vad = pcm ? detectSpeech(pcm) : null;
  const wordCount = input.wordCount ?? countEnglishWords(input.text);
  const claimed = input.claimedDurationMs && input.claimedDurationMs > 0 ? Math.round(input.claimedDurationMs) : null;
  const durationMs = vad?.durationMs || claimed || (input.words?.length ? Math.round(input.words[input.words.length - 1].endMs) : 0);

  if (!durationMs || durationMs < 400) return null;
  if (wordCount === 0) return null;

  let source: ProsodySource;
  let pauses: PauseSpan[];
  let speechMs: number;
  let leadInMs: number;
  let tailMs: number;
  let words: WordSpan[] | undefined;

  const wordSpans = (input.words ?? [])
    .filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs >= item.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (wordSpans.length >= 3) {
    source = 'asr-words';
    words = wordSpans;
    pauses = pausesFromRuns(wordSpans);
    // 发声时长按词时长累加：这是「开口时的速度」，不含词间静默
    speechMs = wordSpans.reduce((sum, item) => sum + (item.endMs - item.startMs), 0);
    leadInMs = Math.max(0, Math.round(wordSpans[0].startMs));
    tailMs = Math.max(0, durationMs - Math.round(wordSpans[wordSpans.length - 1].endMs));
  } else if (input.segments && input.segments.length >= 2) {
    source = 'asr-segments';
    const runs = input.segments
      .filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs))
      .map((item) => ({ startMs: Math.round(item.startMs), endMs: Math.round(item.endMs) }))
      .sort((a, b) => a.startMs - b.startMs);
    pauses = pausesFromRuns(runs);
    speechMs = runs.reduce((sum, run) => sum + (run.endMs - run.startMs), 0);
    leadInMs = Math.max(0, runs[0]?.startMs ?? 0);
    tailMs = Math.max(0, durationMs - (runs[runs.length - 1]?.endMs ?? 0));
  } else if (vad) {
    source = 'vad';
    pauses = pausesFromRuns(vad.speechRuns);
    speechMs = vad.speechMs;
    leadInMs = vad.leadInMs;
    tailMs = vad.tailMs;
  } else {
    // 既没有时间戳、也解不了码：老实说测不了，不要拿「录音时长 ÷ 词数」冒充语速
    return null;
  }

  const pauseMs = pauses.reduce((sum, item) => sum + (item.endMs - item.startMs), 0);
  const silenceMs = pauseMs + leadInMs + tailMs;
  const speechRatio = Math.min(1, Math.max(0, (durationMs - silenceMs) / durationMs));
  const longestPauseMs = pauses.reduce((max, item) => Math.max(max, item.endMs - item.startMs), 0);
  const speakingDuration = Math.max(1, durationMs);
  const articulatingDuration = Math.max(1, durationMs - silenceMs);

  const pitchRuns =
    source === 'asr-words' && words
      ? words
      : source === 'vad' && vad
        ? vad.speechRuns
        : (input.segments ?? []).map((item) => ({ startMs: item.startMs, endMs: item.endMs }));
  // 音高只看波形，与时间戳来源无关；解不出 PCM 就没有
  const pitch = pcm ? analyzePitch(pcm, pitchRuns, speechMs) : undefined;

  const note = buildNote(source, pauses, longestPauseMs, leadInMs);

  logger.info('口语节奏测量完成', {
    source,
    durationMs,
    wordCount,
    pauses: pauses.length,
    longestPauseMs,
  });

  return {
    source,
    sourceLabel: PROSODY_SOURCE_LABEL[source],
    durationMs,
    silenceMs,
    speechRatio: round(speechRatio, 3),
    pauseCount: pauses.length,
    longestPauseMs,
    leadInMs,
    pauses: pauses.slice(0, 60),
    words,
    wordCount,
    wpm: round((wordCount / speakingDuration) * 60_000, 1),
    articulationWpm: round((wordCount / articulatingDuration) * 60_000, 1),
    ...(pitch ? { pitch } : {}),
    ...(vad && vad.closures.length > 0 ? { closures: vad.closures.slice(0, 60) } : {}),
    note,
  };
}

function buildNote(source: ProsodySource, pauses: PauseSpan[], longest: number, leadIn: number): string {
  const medianMs = median(pauses.map((item) => item.endMs - item.startMs));
  const parts: string[] = [];
  if (source === 'asr-words') {
    parts.push('按识别引擎的词级时间戳测量，停顿指词与词之间 ≥350ms 的间隔');
  } else if (source === 'asr-segments') {
    parts.push('识别引擎只给了分段边界，句内的小停顿看不到，停顿次数会偏少');
  } else {
    parts.push('按声学停顿检测测量（逐帧能量），不区分「拖长音」与「停顿」，换气也会计入');
  }
  if (leadIn >= 1200) parts.push(`开口前空了 ${(leadIn / 1000).toFixed(1)} 秒`);
  if (medianMs > 0) parts.push(`停顿中位数 ${medianMs}ms`);
  if (longest >= 2000) parts.push(`最长一次停了 ${(longest / 1000).toFixed(1)} 秒`);
  return `${parts.join('；')}。`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
