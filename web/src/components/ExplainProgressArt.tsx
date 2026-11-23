/**
 * 解题答疑视频 · 生成中的「手绘 + 液态玻璃」动效（全内联 SVG，无图片、无表情符号）。
 *
 * 结构分四层，模拟 iOS 26/27 的液态玻璃：
 *   ① ambient  两团缓慢漂移的环境光（玻璃背后的色晕）
 *   ② liquid   随进度上升的液面，带一条会呼吸的波峰高光
 *   ③ refract  内嵌折射光环 + 顶部镜面高光（玻璃厚度感）
 *   ④ ink      手绘笔触：先一层模糊「洇墨」再叠一层清晰线稿
 * 另有一条斜向流光周期性扫过玻璃表面，解释「正在工作」而不靠转圈。
 *
 * 手绘场景仍然按流水线阶段切换：
 *   script   黑板上逐行写脚本（粉笔线依次画出）
 *   speech   一页分镜卡 + 声波逐圈亮起（配音）
 *   coach / revoice  同样用声波页——补中文轨与换音色都是「重新发声」，不是重新写稿
 *   assemble 胶片带上四格依次落位，播放头对齐（组装时间轴）
 *
 * 线条沿用 art-* 类（stroke-dasharray 归一化 pathLength=1），颜色自动跟随主题 accent。
 */
import { useId, type CSSProperties, type ReactElement } from 'react';

interface Props {
  stage: string;
  progress: number;
  /** 已用时（秒）。生成要几分钟，给用户一个「确实在走」的确定性信号 */
  elapsedSec?: number;
}

function ScriptScene(): ReactElement {
  return (
    <g className="art-float">
      <rect className="art-card" x="18" y="14" width="92" height="62" rx="10" />
      <path className="art-soft" d="M26 68h76" />
      <path className="art-line art-draw" pathLength={1} d="M26 30h58" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.3s' }} d="M26 42h72" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.6s' }} d="M26 54h44" />
      <path className="art-line" d="M100 66l10-18" strokeWidth="2.6" />
      <path className="art-fill" d="M109 45l6 3-3 6-6-3z" />
    </g>
  );
}

function SpeechScene(): ReactElement {
  return (
    <g className="art-float">
      <rect className="art-card" x="16" y="22" width="76" height="50" rx="9" />
      <path className="art-soft" d="M26 36h44M26 46h52M26 56h32" />
      <path className="art-wave" style={{ animationDelay: '0s' }} d="M100 40c5 2.8 5 9.2 0 12" />
      <path className="art-wave" style={{ animationDelay: '0.45s' }} d="M109 33c8 5.6 8 20.4 0 26" />
      <path className="art-wave" style={{ animationDelay: '0.9s' }} d="M118 26c12 8.6 12 30.4 0 40" />
    </g>
  );
}

function AssembleScene(): ReactElement {
  return (
    <g className="art-float">
      <path className="art-line art-draw" pathLength={1} d="M16 46h100" />
      {[22, 48, 74, 100].map((x, i) => (
        <rect
          key={x}
          className={i <= 2 ? 'art-card' : 'art-ghost'}
          x={x}
          y="33"
          width="20"
          height="26"
          rx="4"
          style={{ animationDelay: `${i * 0.25}s` }}
        />
      ))}
      <path className="art-check art-draw" pathLength={1} style={{ animationDelay: '0.8s' }} d="M56 76l5 5 9-11" />
    </g>
  );
}

const SCENES: Record<string, () => ReactElement> = {
  script: ScriptScene,
  speech: SpeechScene,
  // 补中文轨与换音色本质上都是「重新发声」，用声波页而不是黑板页
  coach: SpeechScene,
  revoice: SpeechScene,
  assemble: AssembleScene,
  done: AssembleScene,
  error: ScriptScene,
};

export default function ExplainProgressArt({ stage, progress, elapsedSec }: Props) {
  // 过滤器和 <use> 都要 id：同一页面可能同时挂多个面板，用 useId 保证唯一
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const sceneId = `ev-scene-${uid}`;
  const bloomId = `ev-bloom-${uid}`;
  const Scene = SCENES[stage] ?? ScriptScene;
  const pct = Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0));

  return (
    <div
      className="ev-art"
      data-stage={stage}
      style={{ '--ev-pct': String(pct) } as CSSProperties}
      role="img"
      aria-label={`生成中 ${Math.round(pct)}%`}
    >
      <div className="ev-art-glass">
        <span className="ev-art-ambient" aria-hidden="true" />
        <span className="ev-art-liquid" aria-hidden="true" />
        <span className="ev-art-sheen" aria-hidden="true" />
        <span className="ev-art-refract" aria-hidden="true" />
        <div className="ev-art-canvas" aria-hidden="true">
          <svg viewBox="0 0 132 92" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <defs>
              <filter id={bloomId} x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="2.4" />
              </filter>
              <g id={sceneId}>
                <Scene />
              </g>
            </defs>
            {/* 洇墨层：玻璃后面的墨迹被折射出来，给手绘线稿一点「湿」的质感 */}
            <use href={`#${sceneId}`} className="ev-art-bloom" filter={`url(#${bloomId})`} />
            <use href={`#${sceneId}`} className="ev-art-ink" />
          </svg>
        </div>
      </div>
      <div className="ev-art-track" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="ev-art-meta">
        <span className="ev-art-pct">{Math.round(pct)}%</span>
        {typeof elapsedSec === 'number' ? (
          <span className="ev-art-elapsed">已 {Math.floor(elapsedSec)}s</span>
        ) : null}
      </div>
    </div>
  );
}
