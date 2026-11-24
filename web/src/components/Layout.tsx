import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../store';
import { THEMES } from '@waiyubaodian/ui-kit/theme';
import NavIcon, { type NavIconName } from './NavIcon';
import SidebarHub from './SidebarHub';

const NAV: Array<{ to: string; label: string; icon: NavIconName }> = [
  { to: '/', label: '今日概览', icon: 'overview' },
  { to: '/studio', label: 'AI 学习台', icon: 'studio' },
  { to: '/today', label: '今日任务', icon: 'today' },
  { to: '/path', label: '学习之路', icon: 'path' },
  { to: '/practice', label: '写作·口语', icon: 'practice' },
  { to: '/plan', label: '学习计划', icon: 'plan' },
  { to: '/vocab', label: '词汇本', icon: 'vocab' },
  { to: '/exams', label: '升级自测', icon: 'exam' },
  { to: '/listening', label: '听力素材', icon: 'listen' },
  { to: '/media-player', label: '播放器演示', icon: 'media' },
  { to: '/ui-kit', label: 'UI 组件库', icon: 'uikit' },
  { to: '/settings', label: '设置', icon: 'settings' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { theme, setTheme, resetTheme, autoTheme, switching, catalog } = useApp();
  const location = useLocation();
  // 工作台是三栏同屏，1140px 会挤成一栏，需要放宽内容区
  const wide = location.pathname.startsWith('/studio');
  const switchingName = switching
    ? catalog?.languages.find((item) => item.id === switching)?.nativeName ?? switching
    : '';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">典</div>
          <div>
            <div className="brand-name">外语考证宝典</div>
            <div className="brand-sub">Lingo Quest</div>
          </div>
        </div>

        {/* Logo 正下方：身份 · 语种 · 目标 统一收进一块流光玻璃卡 */}
        <SidebarHub />

        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-glyph">
                <NavIcon name={item.icon} />
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="theme-picker">
          <button
            className={`theme-auto${autoTheme ? ' active' : ''}`}
            onClick={resetTheme}
            title="配色跟随语种（英语=蓝，日语=粉）；点右侧色点可手动固定"
          >
            自动
          </button>
          <div className="theme-dots">
            {THEMES.map((item) => (
              <button
                key={item.id}
                className={`theme-dot${theme === item.id ? ' active' : ''}`}
                style={{ background: item.swatch }}
                onClick={() => setTheme(item.id)}
                title={`${item.name}（${item.en}）· ${item.hint}`}
                aria-label={item.name}
              />
            ))}
          </div>
        </div>
      </aside>

      <main className={`main${wide ? ' main-wide' : ''}${switching ? ' is-syncing' : ''}`}>{children}</main>

      {switching ? (
        <div className="lang-sync" role="status" aria-live="polite">
          <span className="lang-sync-ring" aria-hidden="true" />
          <span className="lang-sync-text">
            正在切换到 <strong>{switchingName}</strong>
            <span className="lang-sync-sub">同步该语种的任务、词汇、批改与统计</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
