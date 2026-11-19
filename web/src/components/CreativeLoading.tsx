import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { CheckMark, TokenIcon } from './ui';
import type { Language, TaskKind } from '../types';

/**
 * 口语 / 写作材料生成时的等待画面。
 *
 * 所有线条都是内联 SVG 手绘路径，配 pathLength=1 的「写出来」循环；
 * 语种字符与短句跟随当前学习语种，信息区把「谁在生成 / 要等多久 / 花多少 token」讲清楚。
 * full 用于整页加载，compact 用于 AI 加练、批改这类内联等待。
 */

export type CreateVariant = 'prompt' | 'enrich' | 'grade';

interface LlmStatus {
  configured: boolean;
  model: string | null;
}

/** 号池状态是全局事实，多个等待画面共用一次请求即可 */
let statusPromise: Promise<LlmStatus | null> | null = null;
function readLlmStatus(): Promise<LlmStatus | null> {
  if (!statusPromise) {
    statusPromise = api
      .settings()
      .then((response) => ({
        configured: response.llm.configured,
        model: response.llm.summary.activeModel || response.llm.model || null,
      }))
      .catch(() => null);
  }
  return statusPromise;
}

const VERSE: Record<Language, { glyph: string; line: string; note: string; name: string }> = {
  en: { glyph: 'Aa', line: 'A thought takes shape.', note: 'English · 让想法成句', name: '英语' },
  ja: { glyph: 'あ', line: '言の葉が、かたちになる。', note: '日本語 · 言语成形', name: '日语' },
  ko: { glyph: '가', line: '생각이 말이 되는 순간', note: '한국어 · 思绪成声', name: '韩语' },
};

const MUSE: Record<CreateVariant, string[]> = {
  prompt: [
    '把今天的主题摊开，等第一句话自己浮上来。',
    '先有片刻安静的构思，才有一道值得认真回答的题。',
    '题目正从考纲与今日之间，慢慢长出骨架。',
  ],
  enrich: [
    '在同一片主题里，再多开出几条可以走的路。',
    '把读过的材料轻轻翻过来，看看背面还藏着什么。',
    '多一点练习，就多一种把话说圆的把握。',
  ],
  grade: [
    '一句一句读过去，也读懂你没写出来的那层意思。',
    '先把想法接住，再谈措辞与分寸。',
    '好的批改不急着下判断，先看清你想说什么。',
  ],
};

const SPEAK_MUSE = [
  '先让一个念头出声，余下的句子会自己跟上来。',
  '在开口之前，思绪正替你斟酌第一个词。',
  '把今天的主题，轻轻放进一段可以说出口的话。',
];

const WRITE_MUSE = [
  '把散落的念头收拢，落成一行有分量的字。',
  '纸上先有留白，才有值得写下的第一句。',
  '让题目留一点空隙，好放得下你自己的见解。',
];

const PROFILE: Record<CreateVariant, { fast: [number, number]; slow: [number, number]; tokens: string }> = {
  prompt: { fast: [1, 2], slow: [8, 18], tokens: '约 1.5–2k' },
  enrich: { fast: [1, 2], slow: [5, 15], tokens: '约 1.5–2k' },
  grade: { fast: [1, 3], slow: [10, 40], tokens: '约 2–4k' },
};

function ClockMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 创作现场：纸、笔、思考气泡、星芒、语种字符，口语时多三道声波 */
function CreativeArt({ glyph, line, speak }: { glyph: string; line: string; speak: boolean }) {
  return (
    <svg viewBox="0 0 320 200" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse className="cl-halo" cx="158" cy="100" rx="138" ry="82" />

      {/* 一条自由游走的曲线，把画面松松地连起来 */}
      <path className="cl-swirl cl-draw" pathLength={1} d="M18 132C42 168 96 186 150 178c48-7 76-34 148-30" />
      <path className="cl-swirl cl-draw cl-delay-2" pathLength={1} d="M26 26C74 8 128 20 168 12" />

      {/* 摊开的纸 */}
      <g className="cl-paper-group">
        <path
          className="cl-paper"
          d="M52 38c38-5 78-4 114 2 4 38 3 82-2 122-36 5-76 4-114-2-5-40-4-84 2-122z"
        />
        {/* 淡底稿常年留着，描边动画只是「笔尖把字再描深一遍」 */}
        <path className="cl-ghost" d="M66 62c26-4 52 3 86-2" />
        <path className="cl-ghost" d="M66 82c22-3 44 3 72-1" />
        <path className="cl-ghost" d="M66 102c30-3 58 3 88-2" />
        <path className="cl-ghost" d="M66 122c18-2 36 2 54-1" />
        <path className="cl-line cl-draw" pathLength={1} d="M66 62c26-4 52 3 86-2" />
        <path className="cl-soft cl-draw cl-delay-1" pathLength={1} d="M66 82c22-3 44 3 72-1" />
        <path className="cl-soft cl-draw cl-delay-2" pathLength={1} d="M66 102c30-3 58 3 88-2" />
        <path className="cl-soft cl-draw cl-delay-3" pathLength={1} d="M66 122c18-2 36 2 54-1" />
        <path className="cl-quote cl-draw cl-delay-4" pathLength={1} d="M66 142c8-6 13-6 18 0 5-6 10-6 18 0" />
      </g>

      {/* 羽毛笔：轻轻摆动，笔尖留一滴墨 */}
      <g className="cl-pen">
        <path className="cl-ink-line" d="M186 170l40-86" strokeWidth="3.4" />
        <path
          className="cl-feather"
          d="M226 84c14-24 30-44 27-56-18 2-36 18-41 38-2 9 4 17 14 18z"
        />
        <path className="cl-ink-line cl-thin" d="M226 84l-10 12" />
        <path className="cl-ink-line cl-thin" d="M233 71c4-11 10-19 18-27" />
      </g>
      <circle className="cl-drop" cx="184" cy="174" r="3.2" />

      {/* 思考气泡：三个念头依次亮起，再飘出两粒小点 */}
      <g className="cl-thought-group">
        <path
          className="cl-thought"
          d="M244 18c0-9 13-13 25-11 12-5 29 1 29 13 9 6 5 21-5 23-4 9-20 11-29 5-12 2-22-6-20-16z"
        />
        <circle className="cl-blink" cx="262" cy="28" r="2.7" />
        <circle className="cl-blink cl-delay-1" cx="273" cy="28" r="2.7" />
        <circle className="cl-blink cl-delay-2" cx="284" cy="28" r="2.7" />
        <circle className="cl-trail" cx="240" cy="58" r="3.2" />
        <circle className="cl-trail cl-delay-1" cx="230" cy="70" r="2" />
      </g>

      {/* 当前语种的字符与短句 */}
      <text className="cl-glyph" x="246" y="132" textAnchor="middle">
        {glyph}
      </text>
      <text className="cl-verse" x="320" y="190" textAnchor="end">
        {line}
      </text>

      {/* 口语：从纸边散开的三道声波 */}
      {speak ? (
        <g className="cl-waves">
          <path className="cl-wave" d="M242 150c7 6 7 18 0 24" />
          <path className="cl-wave cl-delay-1" d="M254 142c12 10 12 32 0 42" />
          <path className="cl-wave cl-delay-2" d="M268 134c17 15 17 47 0 62" />
        </g>
      ) : null}

      {/* 星芒与浮尘 */}
      <g className="cl-stars">
        <path className="cl-star" d="M28 18l2.4 7.6L38 28l-7.6 2.4L28 38l-2.4-7.6L18 28l7.6-2.4z" />
        <path className="cl-star cl-delay-2" d="M302 92l1.8 5.8 5.8 1.8-5.8 1.8-1.8 5.8-1.8-5.8-5.8-1.8 5.8-1.8z" />
        <path className="cl-star cl-delay-3" d="M198 24l1.5 4.5 4.5 1.5-4.5 1.5-1.5 4.5-1.5-4.5-4.5-1.5 4.5-1.5z" />
        <circle className="cl-dust" cx="30" cy="112" r="2" />
        <circle className="cl-dust cl-delay-1" cx="212" cy="168" r="2.6" />
        <circle className="cl-dust cl-delay-3" cx="296" cy="60" r="1.8" />
      </g>
    </svg>
  );
}

export interface CreativeLoadingProps {
  variant?: CreateVariant;
  kind?: TaskKind | null;
  compact?: boolean;
  /** 调用方已有更准确的 token 预估时覆盖 */
  tokenLabel?: string;
  /** 调用方已知线路时覆盖（如 AI 加练统计里的 activeModel） */
  modelHint?: string | null;
  title?: string;
  subtitle?: string;
}

export default function CreativeLoading({
  variant = 'prompt',
  kind = null,
  compact = false,
  tokenLabel,
  modelHint,
  title,
  subtitle,
}: CreativeLoadingProps) {
  const { catalog, language } = useApp();
  const verse = VERSE[language] ?? VERSE.en;
  const profile = PROFILE[variant];
  const isSpeak = kind === 'speak';
  const isWrite = kind === 'write';

  const [elapsed, setElapsed] = useState(0);
  const [museIndex, setMuseIndex] = useState(0);
  const [status, setStatus] = useState<LlmStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void readLlmStatus().then((value) => {
      if (alive && value) setStatus(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((value) => value + 0.5), 500);
    return () => window.clearInterval(timer);
  }, []);

  const muses = variant === 'prompt' && isSpeak ? SPEAK_MUSE : variant === 'prompt' && isWrite ? WRITE_MUSE : MUSE[variant];
  useEffect(() => {
    const timer = window.setInterval(() => setMuseIndex((value) => (value + 1) % muses.length), 3800);
    return () => window.clearInterval(timer);
  }, [muses.length]);

  /** catalog 立即给出初判，settings 回来后以号池真实可用状态为准 */
  const configured = status?.configured ?? catalog?.llm.configured ?? null;
  const model = modelHint || status?.model || catalog?.llm.model || null;
  const [fastLo, fastHi] = profile.fast;
  const [slowLo, slowHi] = profile.slow;
  const estimate = configured === false ? fastHi : slowHi;
  const pct = Math.min(92, Math.round((elapsed / estimate) * 88) + 5);
  const overtime = elapsed > estimate;
  const seconds = Math.floor(elapsed);

  const heading =
    title ??
    (variant === 'grade'
      ? '正在逐句读你的作答'
      : variant === 'enrich'
        ? '正在出一批加练'
        : isSpeak
          ? '正在为你准备一道口语题'
          : isWrite
            ? '正在为你准备一道写作题'
            : '正在生成今天的输出题目');
  const lead =
    subtitle ??
    (variant === 'grade'
      ? '按评分标准逐维度打分，也定位值得改的那一句。'
      : variant === 'enrich'
        ? '围绕这一项的内容，再铺开几条可以练的路。'
        : isSpeak
          ? '从今日主题里，挑一个值得说出口的角度。'
          : '让题目落在纸上，留出你发挥的余地。');

  const sourceText =
    configured === null
      ? '正在确认生成方式'
      : configured
        ? `大模型实时生成${model ? ` · ${model}` : ''}`
        : '本地内置题库生成';
  const etaText =
    configured === null
      ? '预计几秒'
      : overtime
        ? '比预计稍久，仍在生成'
        : `预计 ${configured ? `${slowLo}–${slowHi}` : `${fastLo}–${fastHi}`} 秒`;
  const tokenText =
    configured === null
      ? 'token 用量待确认'
      : configured
        ? `${tokenLabel ?? profile.tokens} tokens · 首次生成`
        : '0 token · 不调用模型';
  const noteText =
    configured === null
      ? '正在读取本机模型配置，确认这次由谁出题…'
      : configured
        ? '生成结果会写入本机题库：今天再打开直接读缓存，不会重复消耗 token；线路超时会自动回退内置题库，依然有题可练。'
        : '全程在本机完成，不联网、不消耗 token。想让题目按当日主题实时生成，可在「设置 → 模型线路」加一条线路。';
  const thirdStep =
    variant === 'grade'
      ? '按评分标准逐维度批改，定位问题句与表达升级'
      : variant === 'enrich'
        ? '围绕本项内容生成一批加练，并写入本地题库'
        : configured
          ? '由模型按今日主题与考纲命题'
          : configured === false
            ? '从内置题库挑一道同水平的题'
            : '确认来源后开始出题';

  return (
    <div className={`cl-card${compact ? ' cl-compact' : ''}`} role="status" aria-live="polite">
      <span className="cl-sheen" aria-hidden="true" />
      <div className="cl-art" aria-hidden="true">
        <CreativeArt glyph={verse.glyph} line={verse.line} speak={isSpeak} />
      </div>

      <div className="cl-info">
        <div className="cl-head">
          <div className="cl-head-text">
            <div className="cl-eyebrow">CREATING · {verse.note}</div>
            <h2 className="cl-title">{heading}</h2>
            <p className="cl-sub">{lead}</p>
          </div>
          <span className="cl-timer">已等 {seconds}s</span>
        </div>

        <p className="cl-muse" key={museIndex}>
          「{muses[museIndex % muses.length]}」
        </p>

        <div className="cl-chips">
          <span className={`cl-chip ${configured === false ? 'is-local' : configured ? 'is-llm' : ''}`}>
            {configured === false ? <CheckMark size={12} /> : <TokenIcon size={12} />}
            {sourceText}
          </span>
          <span className="cl-chip">
            <ClockMark />
            {etaText}
          </span>
          <span className="cl-chip">
            <TokenIcon size={12} />
            {tokenText}
          </span>
        </div>

        <div className={`cl-progress${overtime ? ' is-overtime' : ''}`} aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>

        {!compact ? (
          <>
            <ol className="cl-steps">
              <li className="is-done">
                <span className="cl-step-dot is-done"><CheckMark size={10} /></span>
                读取今日考纲与当前水平（本地完成）
              </li>
              <li className={elapsed >= 1 ? 'is-done' : 'is-active'}>
                <span className={`cl-step-dot ${elapsed >= 1 ? 'is-done' : 'is-active'}`}>
                  {elapsed >= 1 ? <CheckMark size={10} /> : null}
                </span>
                检查本机题目缓存 · 命中即秒开，不消耗 token
              </li>
              <li className={elapsed >= 1 ? 'is-active' : 'is-pending'}>
                <span className={`cl-step-dot ${elapsed >= 1 ? 'is-active' : 'is-pending'}`} />
                {thirdStep}
              </li>
            </ol>
            <p className="cl-note">{noteText}</p>
            <div className="cl-language">
              <span className="cl-language-glyph">{verse.glyph}</span>
              <span>
                <strong>{verse.line}</strong>
                <span className="hint">正在按{verse.name}的语感，为你构思这一份材料</span>
              </span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
