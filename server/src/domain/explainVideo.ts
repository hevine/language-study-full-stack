/**
 * 解题答疑视频 · 后端领域类型（与 @waiyubaodian/explain-video 的契约结构兼容）。
 *
 * 为什么后端不直接 import SDK：后端生成契约、SDK 消费契约，两边应能独立构建；
 * 这里保留一份结构相同的类型 + 时间轴推导，避免 SDK dist 未构建时后端起不来。
 * 契约变更时两边同步即可（字段见 HANDOVER-EXPLAIN-VIDEO.md 4.4）。
 */
import type { Language } from './language';

export type NarrationLanguage = 'target' | 'zh';

/** 讲师轨形态：只有目标语讲解，或目标语 + 母语双讲师 */
export type CoachMode = 'target' | 'bilingual';

/** 讲解深度：短=每题3镜、中=5镜、长=6–7镜；决定旁白预算与 token 上限 */
export type ExplainDepth = 'short' | 'medium' | 'long';

export type ShotKind =
  | 'cover'
  | 'question'
  | 'passage'
  | 'grammar'
  | 'eliminate'
  | 'answer'
  | 'point'
  | 'takeaway';

export interface ShotHighlight {
  paragraph?: number;
  sentence?: string;
  options?: number[];
  picked?: number;
}
export interface GrammarFocus {
  sentence: string;
  structure: string;
  explanation: string;
  translation?: string;
}
export interface ExamPoint {
  label: string;
  text: string;
}
/** 一条音轨：主轨（目标语）与母语轨结构相同，只是语种不同 */
export interface AudioTrack {
  url: string;
  durationMs: number;
  /** 句级边界（相对本镜起点），写入 manifest 供前端精确切 cue */
  boundaries?: Array<{ text: string; offsetMs: number; durationMs: number }>;
}

export interface ShotAudio extends AudioTrack {
  /**
   * 母语（中文）讲师音轨。缺省 = 这条片只有目标语讲解。
   * 与主轨时长不同，播放器按「主轨时间轴」映射，不做时间轴重排——
   * 否则切轨会让画面与字幕整体错位。
   */
  native?: AudioTrack;
}
export interface Shot {
  id: string;
  kind: ShotKind;
  /** 目标语旁白（主轨 TTS 输入） */
  narration: string;
  /** 母语（中文）讲师口播稿；与 narration 同义同序，不是字幕，是第二个人在讲 */
  narrationZh?: string;
  caption: string;
  questionNo?: number;
  prompt?: string;
  options?: string[];
  highlight?: ShotHighlight;
  grammar?: GrammarFocus;
  point?: ExamPoint;
  audio: ShotAudio;
}
export interface Cue {
  id: string;
  shotIndex: number;
  text: string;
  narration: string;
  startMs: number;
  endMs: number;
  edited?: boolean;
}
export interface ExplainVideo {
  id: string;
  articleId: string;
  language: Language;
  narrationLanguage: NarrationLanguage;
  voice: string;
  title: string;
  totalMs: number;
  shots: Shot[];
  cues: Cue[];
  createdAt: string;
  updatedAt?: string;
  /** 讲师轨形态；缺省按 target 理解（老数据没有母语轨） */
  coach?: CoachMode;
  /** 生成来源 / 模型 / token，用于成本面板 */
  meta?: {
    model: string | null;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    scriptVersion: number;
    /** 生成时选的讲解深度：前端据此显示「精讲版」并允许切档对比 */
    depth?: ExplainDepth;
    /** 教案档位（n5…n1 / toefl / cet …）。共享缓存按「文章 + 级别 + 档位」隔离，级别不同提示词不同 */
    band?: string;
    /** 首个生成者；共享片据此判断谁可以物理删除（其他人只能建自己的改稿副本） */
    ownerId?: string;
    /** 母语轨的补充成本，单独记账，避免混进脚本成本里看不清 */
    nativeUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    /**
     * 重配音记录：只跑 TTS、不调大模型，所以不计入 usage。
     * 共享片换成本人音色时写在个人副本的 manifest 上，留痕便于排查「这条怎么不是原声」。
     */
    revoice?: { at: string; voice: string; by: string };
    /**
     * 脚本质量：模型这次吐的 JSON 不干净（本地抢救 / 被截断 / 有题靠题库补镜）时留痕，
     * 前端据此提示「本片有部分内容由题库自动补齐」，而不是假装一切正常。
     */
    quality?: {
      salvage: boolean;
      truncated: boolean;
      autoFilledShots: number;
    };
  };
}

export interface ServerTimeline {
  ranges: Array<{ shotIndex: number; startMs: number; endMs: number }>;
  totalMs: number;
  cues: Cue[];
}

/** 后端版 computeTimeline：优先用句级 boundaries，否则按字数比例切句 */
export function computeServerTimeline(
  shots: Shot[],
  language: Language = 'en',
): ServerTimeline {
  const ranges: ServerTimeline['ranges'] = [];
  const cues: Cue[] = [];
  let cursor = 0;
  const splitter = language === 'ja' ? /(?<=[。！？])/ : /(?<=[.!?。！？])\s*/;

  shots.forEach((shot, shotIndex) => {
    const duration = Math.max(0, Math.round(shot.audio?.durationMs ?? 0));
    const startMs = cursor;
    const endMs = cursor + duration;
    ranges.push({ shotIndex, startMs, endMs });
    cursor = endMs;
    if (duration <= 0) return;

    const boundaries = shot.audio.boundaries ?? [];
    let parts: Array<{ text: string; startMs: number; endMs: number }> = [];
    if (boundaries.length > 0) {
      parts = boundaries.map((b, i) => ({
        text: b.text,
        startMs: startMs + Math.max(0, Math.round(b.offsetMs)),
        endMs: i === boundaries.length - 1
          ? endMs
          : Math.min(endMs, startMs + Math.round(b.offsetMs + b.durationMs)),
      }));
    } else {
      const sentences = (shot.narration.trim().split(splitter).filter(Boolean) || [shot.narration]).filter(Boolean);
      const weights = sentences.map((s) => Math.max(1, s.length));
      const total = weights.reduce((a, b) => a + b, 0);
      let local = startMs;
      sentences.forEach((s, i) => {
        const isLast = i === sentences.length - 1;
        const len = isLast ? endMs - local : Math.max(1, Math.round((duration * weights[i]) / total));
        parts.push({ text: s, startMs: local, endMs: local + len });
        local += len;
      });
    }

    parts.forEach((part, cueIndex) => {
      cues.push({
        id: `s${shotIndex}-c${cueIndex}`,
        shotIndex,
        text: cueIndex === 0 ? shot.caption : part.text,
        narration: part.text,
        startMs: Math.max(startMs, part.startMs),
        endMs: Math.min(endMs, part.endMs),
      });
    });
  });

  return { ranges, totalMs: cursor, cues };
}

/** 时长 / 结构校验（代码侧，不信模型）；maxMs 由档位传入，精讲档允许更长 */
export function validateExplainVideo(video: ExplainVideo, options: { maxMs?: number } = {}): string[] {
  const issues: string[] = [];
  if (!video.id) issues.push('缺少视频 id');
  if (!video.articleId) issues.push('缺少 articleId');
  if (!video.shots.length) issues.push('没有分镜');
  let sum = 0;
  video.shots.forEach((s, i) => {
    if (!(s.audio.durationMs > 0)) issues.push(`分镜 ${i} 时长非法`);
    else sum += s.audio.durationMs;
    if (s.kind === 'answer' && s.highlight?.picked === undefined) issues.push(`答案镜 ${i} 缺 picked`);
  });
  if (Math.abs(sum - video.totalMs) > 1) issues.push(`totalMs 与分镜累加不一致（${video.totalMs} vs ${sum}）`);
  const maxMs = options.maxMs ?? 20 * 60_000;
  if (video.totalMs < 20_000 || video.totalMs > maxMs) {
    issues.push(`总时长 ${Math.round(video.totalMs / 1000)}s 超出 20s–${Math.round(maxMs / 60_000)}min 范围`);
  }
  return issues;
}
