/**
 * 口语节奏的「实测数据」类型。
 *
 * 为什么单独立一层：发音评分这件事最容易变成编分数。
 * 能诚实地拿到的只有**时间信息** —— 每个词几点开始、几点结束、中间停了多久。
 * 音素读得准不准（θ 读成 s、重音放错）需要强制对齐或音素级声学模型，
 * 现在的 ASR 线路都给不了，所以这一层只承诺节奏，不承诺发音准确度。
 *
 * 三个来源按可信度排序：
 * - asr-words：识别引擎给出词级时间戳，词与词的空隙就是停顿，最准；
 * - asr-segments：只给分段边界的引擎（whisper 系常见），空隙仍可测，但句内停顿看不到；
 * - vad：声学检测（解码 PCM 逐帧能量），不看文本、只看有没有声音 —— 换气、迟疑都能抓到，
 *   但分不清「拖长音」和「停顿」。这一层必须让用户知道差别。
 */
export type ProsodySource = 'asr-words' | 'asr-segments' | 'vad';

export interface WordSpan {
  word: string;
  startMs: number;
  endMs: number;
}

export interface SegmentSpan {
  startMs: number;
  endMs: number;
  text: string;
}

export interface PauseSpan {
  startMs: number;
  endMs: number;
}

/**
 * 音高轮廓：只从波形上量，不问「哪个音读错了」。
 *
 * 日语的高低アクセント是**词**层面的属性，判它需要知道每个モーラ在哪，
 * 也就是强制对齐 —— 现在拿不到。但「整段说话有没有抑扬」是能测的：
 * 有声帧的 F0 分布就够。平板单调（跨度 < 3 个半音）是学习者最常见的韵律问题，
 * 这个判断不需要对齐，也不会指错词。
 */
export interface PitchProfile {
  medianHz: number;
  /** 10 / 90 分位：不用 min / max，一个爆音就能毁掉上下界 */
  p10Hz: number;
  p90Hz: number;
  /** p90 / p10 的半音跨度；自然说话约 5–12，< 3 基本是平的 */
  rangeSemitones: number;
  /** 有声帧占发声时长的比例；太低说明录音质量差或气声多，结论要打折扣 */
  voicedRatio: number;
}

/** 促音（っ）的声学表现是一段短闭塞：60–220ms 的静音 */
export interface ClosureSpan {
  startMs: number;
  endMs: number;
}

export interface ProsodyMeasurement {
  source: ProsodySource;
  /** 展示用：这三个来源在报告里必须能区分开 */
  sourceLabel: string;
  /** 全段时长（音频总长，含首尾静音） */
  durationMs: number;
  /** 非发声时长 = 停顿 + 首尾静音 */
  silenceMs: number;
  speechRatio: number;
  /** ≥ 350ms 才算一次停顿：换气式的短促间隔不算卡壳 */
  pauseCount: number;
  longestPauseMs: number;
  /** 开口前等了多久；录音笔常常先空几秒，这不是卡顿，单独算 */
  leadInMs: number;
  pauses: PauseSpan[];
  words?: WordSpan[];
  wordCount: number;
  /** 词/分钟，按总时长算 —— 与人对「语速」的直觉一致 */
  wpm: number;
  /** 词/分钟，按发声时长算（去掉停顿）—— 反映「开口时有多快」 */
  articulationWpm: number;
  /** 音高轮廓；PCM 解不出来或几乎全是清音时缺省 */
  pitch?: PitchProfile;
  /** 60–220ms 的短闭塞：日语促音的候选，也可能是词内短暂的闭锁 */
  closures?: ClosureSpan[];
  /** 这份测量可信到什么程度，原话给用户看 */
  note: string;
  /**
   * 缓存结构版本。
   *
   * 测量结果按 audioId 缓存在磁盘上，字段一扩充，旧缓存里就没有新字段 ——
   * 不校验版本的话，老录音会「永远测不出抑扬」，而且看不出是缓存的问题。
   */
  v?: number;
}

export const PROSODY_SOURCE_LABEL: Record<ProsodySource, string> = {
  'asr-words': '识别引擎词级时间戳',
  'asr-segments': '识别引擎分段边界',
  vad: '声学停顿检测',
};

/** 停顿阈值：低于这个数的间断是人说话的正常换气，不算卡壳 */
export const PAUSE_MIN_MS = 350;
