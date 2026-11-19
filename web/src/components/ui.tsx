import type { ReactNode } from 'react';
import type { TaskKind } from '../types';

export function Ring({
  value,
  size = 74,
  stroke = 6,
  label,
  color = 'var(--accent)',
}: {
  value: number;
  size?: number;
  stroke?: number;
  label?: ReactNode;
  color?: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(16,30,60,0.10)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * pct} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray .6s cubic-bezier(.2,.7,.3,1)' }}
        />
      </svg>
      <div className="ring-value" style={{ fontSize: size > 64 ? 18 : 14 }}>
        {label ?? `${Math.round(pct * 100)}%`}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function SectionCard({
  title,
  extra,
  children,
  className = '',
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card card-pad ${className}`}>
      {(title || extra) && (
        <div className="section-title">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function Banner({ tone = 'gold', children }: { tone?: 'gold' | 'teal' | 'danger'; children: ReactNode }) {
  const cls = tone === 'teal' ? 'banner banner-teal' : tone === 'danger' ? 'banner banner-danger' : 'banner';
  return (
    <div className={cls}>
      <span style={{ flex: 'none', opacity: 0.7 }}>※</span>
      <div>{children}</div>
    </div>
  );
}

export function StatusChip({ status }: { status: 'pending' | 'partial' | 'done' }) {
  if (status === 'done') return <span className="chip chip-ok">已完成</span>;
  if (status === 'partial') return <span className="chip chip-warn">进行中</span>;
  return <span className="chip">未开始</span>;
}

const KIND_TEXT: Record<TaskKind, string> = {
  vocab: '词汇',
  read: '精读',
  speak: '朗读',
  listen: '听力',
  write: '写作',
  grammar: '语法',
  mock: '模考',
  review: '复盘',
  admin: '报考',
};

export function kindLabel(kind: TaskKind): string {
  return KIND_TEXT[kind] ?? kind;
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="loading">{text}</div>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="center" style={{ padding: '34px 10px' }}>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{title}</div>
      {hint ? <div className="hint" style={{ marginTop: 6 }}>{hint}</div> : null}
    </div>
  );
}

/**
 * 手绘对勾：一条带弧度的笔触，模拟真人起笔收笔的粗细变化。
 * 用 stroke-dashoffset 做「画出来」的动画，done 时按路径长度擦除。
 */
export function CheckMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="checkmark"
    >
      <path
        className="checkmark-path"
        d="M4.6 12.9 C6.4 14.1, 8.2 15.9, 9.6 17.8 C11.9 13.4, 15.1 9.0, 19.4 5.9"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * token 消耗标记：一枚带闪电的硬币，出现在所有「点了就要花大模型额度」的入口上，
 * 让用户在点击前就知道这一下是要花钱的。
 */
export function TokenIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="token-icon"
    >
      {/* 硬币：双圈 + 微微的手绘不规则感 */}
      <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="5.9" stroke="currentColor" strokeWidth="0.9" opacity="0.45" />
      {/* 闪电：一道折返的笔触 */}
      <path
        d="M12.9 6.9 L9.6 12.4 L11.8 12.4 L11.0 17.2 L14.5 11.4 L12.2 11.4 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 完成庆祝奖章：玻璃圆牌（质感由 CSS 提供）内手绘的缎带勋章 + 打勾。
 * 勾沿路径「画出来」，缎带与缝线圆环都带一点手绘的不规则感。
 */
export function MedalCheck({ size = 58 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden className="medal-check">
      <defs>
        <linearGradient id="medalGoldG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e7b45a" />
          <stop offset="1" stopColor="#c08a2a" />
        </linearGradient>
      </defs>
      {/* 缎带双尾：左右各一撇，末端剪成燕尾 */}
      <path
        d="M24.6 44.2 L20.4 58.8 L27.2 54.9 L31.2 60.4"
        stroke="url(#medalGoldG)"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <path
        d="M39.4 44.2 L43.6 58.8 L36.8 54.9 L32.8 60.4"
        stroke="url(#medalGoldG)"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      {/* 勋章外环 + 内圈缝线 */}
      <circle cx="32" cy="28" r="17.5" stroke="url(#medalGoldG)" strokeWidth="2.6" />
      <circle
        cx="32"
        cy="28"
        r="13.4"
        stroke="url(#medalGoldG)"
        strokeWidth="1.1"
        strokeDasharray="2.6 3.2"
        strokeLinecap="round"
        opacity="0.75"
      />
      {/* 手绘对勾：起笔轻、收笔重 */}
      <path
        className="medal-path"
        d="M25.4 28.6 C27.6 30.4, 29.6 32.4, 31.2 34.8 C34.4 29.0, 38.4 24.4, 42.6 21.2"
        stroke="url(#medalGoldG)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 勋章右上角的小星芒 */}
      <path
        d="M51.4 8.2 C51.7 10.3, 53.3 11.9, 55.4 12.2 C53.3 12.5, 51.7 14.1, 51.4 16.2 C51.1 14.1, 49.5 12.5, 47.4 12.2 C49.5 11.9, 51.1 10.3, 51.4 8.2 Z"
        fill="#e0a63e"
      />
    </svg>
  );
}

/** 手绘四角星芒：庆祝场景的浮动小星，也用在「记住」统计上 */
export function StarIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="star-icon">
      <path
        d="M12 3.6 C12.7 8.0, 16.0 11.3, 20.4 12 C16.0 12.7, 12.7 16.0, 12 20.4 C11.3 16.0, 8.0 12.7, 3.6 12 C8.0 11.3, 11.3 8.0, 12 3.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 手绘回环箭头：用于「需重看」——绕一圈再回来的笔触 */
export function LoopIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="loop-icon">
      <path
        d="M18.9 12.6 A7 7 0 1 1 16.4 6.3"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M16.9 2.9 L17.3 7.1 L13.2 6.6"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 手绘靶心：用于「快测」——两圈加一个圆点 */
export function TargetIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="target-icon">
      <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.9" />
      <circle cx="12" cy="12" r="4.4" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** 播放：手绘三角播放键，外圈一道细环 */
export function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="play-icon">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
      <path
        d="M9.8 7.9c0-.5.54-.8.96-.55l6.1 3.9c.4.26.4.84 0 1.1l-6.1 3.9c-.42.27-.96-.03-.96-.55z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 停止：手绘圆角方停键 */
export function StopIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="stop-icon">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
      <rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1.8" fill="currentColor" />
    </svg>
  );
}

/** 「点了会消耗 token」的标准提示：图标 + 文案，按钮和徽章里都直接用 */
export function TokenHint({ text, tone }: { text: string; tone?: 'accent' | 'plain' }) {
  return (
    <span className={`token-hint${tone === 'plain' ? ' plain' : ''}`}>
      <TokenIcon />
      {text}
    </span>
  );
}
