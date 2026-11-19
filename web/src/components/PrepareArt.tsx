import type { ReactElement } from 'react';
import type { TaskKind } from '../types';

/**
 * 材料准备期间的等待插画：每个任务类型一套手绘小场景，
 * 线条用 pathLength=1 归一化后做「画出来」循环，配合浮动与呼气光晕。
 * 全部为内联 SVG（无图片、无表情符号），颜色跟随主题 accent。
 */

/** 词卡：三张叠卡，词条与对勾依次画出 */
function VocabScene() {
  return (
    <g className="art-float">
      <rect className="art-ghost" x="24" y="26" width="46" height="30" rx="8" transform="rotate(-9 47 41)" />
      <rect className="art-ghost" x="26" y="26" width="46" height="30" rx="8" transform="rotate(8 49 41)" />
      <rect className="art-card" x="21" y="32" width="54" height="36" rx="9" />
      <path className="art-line art-draw" pathLength={1} d="M30 45h30" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.35s' }} d="M30 55h15" />
      <path
        className="art-check art-draw"
        pathLength={1}
        style={{ animationDelay: '0.7s' }}
        d="M56 55l4 4.6 7.2-9"
      />
    </g>
  );
}

/** 长难句：一整句被刻度断开，再拆成三行主干与分支 */
function GrammarScene() {
  return (
    <g className="art-float">
      <path className="art-line art-draw" pathLength={1} d="M15 28h66" />
      <path className="art-tick" d="M37 23v10M57 23v10M71 23v10" />
      <path className="art-link" d="M37 33c-5 4-8 8-8 11" />
      <path className="art-link" d="M57 33c1 7-1 15-4 21" />
      <path className="art-link" d="M71 33c-11 12-18 24-19 34" />
      <path className="art-line art-draw" pathLength={1} style={{ animationDelay: '0.3s' }} d="M26 46h30" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.55s' }} d="M33 59h28" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.8s' }} d="M52 72h24" />
    </g>
  );
}

/** 精读：摊开的书，字行逐行浮现 */
function ReadScene() {
  return (
    <g className="art-float">
      <path
        className="art-card"
        d="M48 33c-7-4.6-17-5.6-25-3.4v38c8-2.2 18-1.2 25 3.4 7-4.6 17-5.6 25-3.4v-38C65 27.4 55 28.4 48 33z"
      />
      <path className="art-line art-draw" pathLength={1} d="M48 33v38" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.2s' }} d="M31 42h11" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.4s' }} d="M31 51h9" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.6s' }} d="M54 42h11" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.8s' }} d="M54 51h9" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '1s' }} d="M31 60h10" />
    </g>
  );
}

/** 精听：耳机 + 三道依次亮起的声波 */
function ListenScene() {
  return (
    <g className="art-float">
      <path className="art-line art-draw" pathLength={1} d="M27 58V48c0-11.6 9.4-21 21-21s21 9.4 21 21v10" />
      <rect className="art-card" x="20" y="54" width="13" height="21" rx="6.5" />
      <rect className="art-card" x="63" y="54" width="13" height="21" rx="6.5" />
      <path className="art-wave" style={{ animationDelay: '0s' }} d="M79 56c5 2.4 5 9.6 0 12" />
      <path className="art-wave" style={{ animationDelay: '0.45s' }} d="M85 50c8 5.6 8 18.4 0 24" />
      <path className="art-wave" style={{ animationDelay: '0.9s' }} d="M91 44c11 8.6 11 29.4 0 38" />
    </g>
  );
}

/** 跟读：麦克风 + 声波 */
function SpeakScene() {
  return (
    <g className="art-float">
      <rect className="art-card" x="38" y="16" width="20" height="34" rx="10" />
      <path className="art-line art-draw" pathLength={1} d="M28 40c0 11 9 20 20 20s20-9 20-20" />
      <path className="art-line art-draw" pathLength={1} style={{ animationDelay: '0.3s' }} d="M48 60v13" />
      <path className="art-line art-draw" pathLength={1} style={{ animationDelay: '0.45s' }} d="M38 75h20" />
      <path className="art-wave" style={{ animationDelay: '0s' }} d="M70 30c5 4 5 12 0 16" />
      <path className="art-wave" style={{ animationDelay: '0.5s' }} d="M77 24c8.6 7.6 8.6 22.4 0 30" />
    </g>
  );
}

/** 写作：纸上字迹渐成，笔尖轻点 */
function WriteScene() {
  return (
    <g className="art-float">
      <rect className="art-card" x="18" y="20" width="40" height="52" rx="7" />
      <path className="art-soft art-draw" pathLength={1} d="M26 34c3-2 5 2 8 0s5-2 8 0" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.3s' }} d="M26 44h19" />
      <path className="art-soft art-draw" pathLength={1} style={{ animationDelay: '0.5s' }} d="M26 53h13" />
      <g className="art-pen">
        <path className="art-line" d="M57 73l13-24" strokeWidth="3.2" />
        <path className="art-fill" d="M69 42l7 3.8-3.4 6.2-7-3.8z" />
        <path className="art-line" d="M53 79l3.4-5.4 3.6 2z" />
      </g>
    </g>
  );
}

/** 模考：试卷 + 计时环 + 选项逐个亮起 */
function MockScene() {
  return (
    <g className="art-float">
      <rect className="art-card" x="16" y="22" width="42" height="52" rx="7" />
      <path className="art-soft" d="M24 34h18M24 42h24M24 50h13" />
      <circle className="art-ring" cx="70" cy="66" r="13" />
      <path className="art-line art-draw" pathLength={1} d="M70 58.5v8l6 3.4" />
      <circle className="art-blink" style={{ animationDelay: '0s' }} cx="28" cy="63" r="2.6" />
      <circle className="art-blink" style={{ animationDelay: '0.4s' }} cx="38" cy="63" r="2.6" />
      <circle className="art-blink" style={{ animationDelay: '0.8s' }} cx="48" cy="63" r="2.6" />
    </g>
  );
}

/** 复盘：虚线环缓慢转，中间手绘对勾 */
function ReviewScene() {
  return (
    <g>
      <g className="art-spin-slow">
        <circle className="art-dash-ring" cx="48" cy="48" r="25" />
      </g>
      <path className="art-line art-draw" pathLength={1} d="M34 48.5l7.5 8 20-19" />
    </g>
  );
}

/** 报考事务：日历 + 一枚打钩 */
function AdminScene() {
  return (
    <g className="art-float">
      <rect className="art-card" x="21" y="28" width="54" height="46" rx="8" />
      <path className="art-line" d="M21 42h54" />
      <path className="art-line" d="M36 21v13M60 21v13" />
      <circle className="art-dot" cx="33" cy="52" r="2.2" />
      <circle className="art-dot" cx="45" cy="52" r="2.2" />
      <circle className="art-dot" cx="57" cy="52" r="2.2" />
      <circle className="art-dot" cx="33" cy="63" r="2.2" />
      <path
        className="art-check art-draw"
        pathLength={1}
        style={{ animationDelay: '0.4s' }}
        d="M50 62l4.5 4.8 9-10"
      />
    </g>
  );
}

/** 还没识别出类型时的通用场景：轨道 + 四角星芒 */
function GenericScene() {
  return (
    <g className="art-float">
      <circle className="art-ring" cx="48" cy="48" r="26" />
      <path
        className="art-check art-draw"
        pathLength={1}
        d="M48 30.5l4 13.5L65.5 48l-13.5 4-4 13.5-4-13.5L30.5 48l13.5-4z"
      />
      <circle className="art-dot" cx="48" cy="48" r="2.6" />
    </g>
  );
}

const SCENES: Record<TaskKind, () => ReactElement> = {
  vocab: VocabScene,
  grammar: GrammarScene,
  read: ReadScene,
  listen: ListenScene,
  speak: SpeakScene,
  write: WriteScene,
  mock: MockScene,
  review: ReviewScene,
  admin: AdminScene,
};

export default function PrepareArt({ kind }: { kind?: TaskKind }) {
  const Scene = kind ? SCENES[kind] : GenericScene;
  return (
    <div className={`prepare-art${kind ? ` kind-${kind}` : ''}`} aria-hidden="true">
      <svg viewBox="0 0 96 96" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <Scene />
      </svg>
    </div>
  );
}
