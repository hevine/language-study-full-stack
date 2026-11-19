import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { diffDays, todayISO, useApp } from '../store';
import { THEMES } from '../theme';
import NavIcon, { type NavIconName } from './NavIcon';
import SidebarLanguage from './SidebarLanguage';
import UserMenu from './UserMenu';

const NAV: Array<{ to: string; label: string; icon: NavIconName }> = [
  { to: '/', label: '今日概览', icon: 'overview' },
  { to: '/today', label: '今日任务', icon: 'today' },
  { to: '/path', label: '学习之路', icon: 'path' },
  { to: '/practice', label: '写作·口语', icon: 'practice' },
  { to: '/plan', label: '学习计划', icon: 'plan' },
  { to: '/vocab', label: '词汇本', icon: 'vocab' },
  { to: '/exams', label: '升级自测', icon: 'exam' },
  { to: '/settings', label: '设置', icon: 'settings' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { plan, theme, setTheme, resetTheme, autoTheme, switching, catalog } = useApp();
  const daysLeft = plan ? Math.max(0, diffDays(todayISO(), plan.examDate)) : 0;
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

        <SidebarLanguage />

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

        <UserMenu />

        <div className="sidebar-foot">
          {plan ? (
            <>
              <div className="countdown">
                <div className="countdown-row">
                  <strong>{daysLeft}</strong>
                  <span>天后考试</span>
                </div>
                <div className="countdown-goal">
                  <span className="countdown-target" title={plan.targetLabel}>
                    {plan.targetLabel}
                  </span>
                  <NavLink
                    className="goal-edit"
                    to="/setup"
                    title="去「定目标」变更考试、目标分数或考试日期"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M10.9 2.4l2.7 2.7-8.3 8.3-3.4.7.7-3.4z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                    </svg>
                    改目标
                  </NavLink>
                </div>
              </div>
              <div className="small" style={{ opacity: 0.7 }}>
                第 {plan.weeks} 周计划 · 每日 {plan.dailyMinutes} 分钟
              </div>
            </>
          ) : (
            <>
              <div className="small">还没有备考计划</div>
              <NavLink className="goal-edit goal-edit-block" to="/setup" title="去「定目标」新建备考计划">
                去定目标
              </NavLink>
            </>
          )}
        </div>
      </aside>

      <main className={`main${switching ? ' is-syncing' : ''}`}>{children}</main>

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
