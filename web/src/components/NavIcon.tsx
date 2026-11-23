import { useId } from 'react';

export type NavIconName =
  | 'overview'
  | 'today'
  | 'path'
  | 'practice'
  | 'plan'
  | 'vocab'
  | 'exam'
  | 'media'
  | 'listen'
  | 'settings'
  | 'uikit';

/**
 * 侧栏图标：全部手绘路径，不依赖任何图标库或 Unicode 字形。
 *
 * 每个图标由两部分构成：
 *  1. 结构线：currentColor 描边，负责"看得懂"；
 *  2. 高光件：主题色渐变填充/描边，负责"流光玻璃"的质感——
 *     换任何主题色（蓝/紫/粉/绿/橙…）高光件都会跟着变色。
 */
export default function NavIcon({ name, size = 18 }: { name: NavIconName; size?: number }) {
  const uid = `nav${useId().replace(/:/g, '')}`;
  const grad = `url(#${uid})`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="nav-icon"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={uid} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent-light)" />
          <stop offset="1" stopColor="var(--accent-deep)" />
        </linearGradient>
      </defs>
      {draw(name, grad)}
    </svg>
  );
}

function draw(name: NavIconName, grad: string) {
  switch (name) {
    // 今日概览：进度环 + 中心玻璃珠（仪表盘语义）
    case 'overview':
      return (
        <g>
          <path d="M17.23 6.77A7.4 7.4 0 1 1 17.23 17.23" />
          <circle cx="12" cy="12" r="2.7" fill={grad} stroke="none" />
          <circle cx="12" cy="12" r="4.9" opacity="0.28" strokeDasharray="1.4 3.2" />
        </g>
      );

    // 今日任务：任务卡 + 右下金色勾（勾压在卡片边角上）
    case 'today':
      return (
        <g>
          <rect x="4.1" y="4.5" width="12.8" height="14.9" rx="3.2" />
          <path d="M7.3 9.1h6M7.3 12.5h4.2" opacity="0.8" />
          <path d="M13.3 16.3l2 2 4-4.4" stroke={grad} strokeWidth={2.1} />
        </g>
      );

    // 学习之路：三级台阶 + 顶端进阶光点
    case 'path':
      return (
        <g>
          <path d="M4.2 19.4h4.2v-4.8h4.2v-4.8h3.6v-4" />
          <circle cx="4.2" cy="19.4" r="1.5" opacity="0.6" />
          <circle cx="16.9" cy="5.4" r="2.5" fill={grad} stroke="none" />
          <circle cx="16.9" cy="5.4" r="4" stroke={grad} strokeOpacity="0.3" />
        </g>
      );

    // 写作·口语：对话气泡 + 气泡内一支斜挑的笔
    case 'practice':
      return (
        <g>
          <rect x="3.6" y="5" width="16.8" height="11.1" rx="3.2" />
          <path d="M8 16.1v3.4l3.5-3.4" />
          <path d="M9.3 13.6l5.4-5.4" stroke={grad} strokeWidth={2} />
          <circle cx="15.9" cy="7" r="1.55" fill={grad} stroke="none" />
        </g>
      );

    // 学习计划：日历页 + 当天高亮格
    case 'plan':
      return (
        <g>
          <path d="M8.2 3.3v2.9M15.8 3.3v2.9" />
          <rect x="3.8" y="5.8" width="16.4" height="14.8" rx="3.4" />
          <path d="M3.8 10.2h16.4" opacity="0.75" />
          <rect x="7.2" y="12.7" width="4.4" height="4.3" rx="1.4" fill={grad} stroke="none" />
          <circle cx="16.1" cy="14.9" r="1.1" opacity="0.55" />
        </g>
      );

    // 词汇本：摊开的书 + 夹在页间的渐变书签
    case 'vocab':
      return (
        <g>
          <path d="M12 6.9C9.9 5.4 7.1 4.7 4.4 4.9v13.1c2.7-.2 5.5.5 7.6 2 2.1-1.5 4.9-2.2 7.6-2V4.9c-2.7-.2-5.5.5-7.6 2z" />
          <path d="M12 6.9v13.1" opacity="0.5" />
          <path d="M15.9 5.1v5.6l1.75-1.45L19.4 10.7V5.35" fill={grad} stroke="none" />
        </g>
      );

    // 升级自测：试卷 + 计时环（右上角），环内一根指针
    case 'exam':
      return (
        <g>
          <rect x="3.6" y="4.4" width="13.2" height="15.6" rx="3.2" />
          <path d="M6.9 8.6h6.6M6.9 12h4.4" opacity="0.75" />
          <path d="M6.9 15.4l1.7 1.7 3.1-3.4" stroke={grad} strokeWidth={1.9} />
          <circle cx="17.4" cy="16.6" r="3.5" stroke={grad} strokeOpacity="0.55" strokeWidth="1.4" />
          <circle cx="17.4" cy="16.6" r="1.1" fill={grad} stroke="none" />
        </g>
      );

    // 媒体播放器：播放三角 + 音频声波，高光三角为主题色
    case 'media':
      return (
        <g>
          <circle cx="12" cy="12" r="8.6" opacity="0.9" />
          <path d="M10.1 8.3l5.1 3.7-5.1 3.7z" fill={grad} stroke="none" />
          <path d="M5.4 9.2v5.6M18.6 9.2v5.6" stroke={grad} strokeWidth="1.5" opacity="0.75" />
        </g>
      );

    // 听力素材：头戴耳机，耳罩用主题色高光
    case 'listen':
      return (
        <g>
          <path d="M5.2 13.4v-1.2a6.8 6.8 0 0 1 13.6 0v1.2" />
          <rect x="3.7" y="12.6" width="4.1" height="6.8" rx="2" />
          <rect x="16.2" y="12.6" width="4.1" height="6.8" rx="2" />
          <rect x="4.3" y="13.4" width="2.9" height="5.2" rx="1.5" fill={grad} stroke="none" />
          <rect x="16.8" y="13.4" width="2.9" height="5.2" rx="1.5" fill={grad} stroke="none" />
        </g>
      );

    // 设置：iOS 控制条三滑杆，中间滑块为主题色高光件
    case 'settings':
      return (
        <g>
          <path d="M4 7.5h16M4 12h16M4 16.5h16" opacity="0.5" />
          <circle cx="9" cy="7.5" r="2.45" fill="#fff" fillOpacity="0.92" />
          <circle cx="15" cy="12" r="2.45" fill={grad} stroke="none" />
          <circle cx="10.6" cy="16.5" r="2.45" fill="#fff" fillOpacity="0.92" />
        </g>
      );

    // UI 组件库：三块玻璃控件（输入框/开关/分段），高光为主题色
    case 'uikit':
      return (
        <g>
          <rect x="3.4" y="4.6" width="17.2" height="5.2" rx="2.4" />
          <path d="M6.2 7.2h8" opacity="0.7" />
          <circle cx="18" cy="7.2" r="1.1" fill={grad} stroke="none" />
          <rect x="3.4" y="11.4" width="17.2" height="5.2" rx="2.6" />
          <rect x="4.6" y="12.6" width="8.4" height="2.8" rx="1.4" fill={grad} stroke="none" opacity="0.85" />
          <circle cx="17.6" cy="14" r="1.5" fill="#fff" fillOpacity="0.92" />
          <path d="M4.4 20.2h15.2" stroke={grad} strokeWidth="1.7" strokeLinecap="round" />
        </g>
      );

    default:
      return null;
  }
}
