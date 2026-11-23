/**
 * 侧栏聚合卡（Logo 正下方）：把原先分散在「顶部语种卡 / 底部账号卡 / 底部倒计时卡」
 * 的三处信息收进同一块流光玻璃里，按「谁在学 → 学什么 → 什么时候考」自上而下排布。
 *
 * 状态与动作全部复用既有链路，不新增接口：
 *   · 登录 / 注册 / 退出 / 角色信息 → useAuth
 *   · 当前语种 / 计划 / 倒计时     → useApp（AppCtx）
 *   · 切换语种                     → useLanguageSwitch（三入口共用的那一个动作）
 *   · 弹层里的各语种计划           → api.plans()，仅在首次展开时懒加载
 *   · 定位 / 点外关闭 / Esc / 键盘 → Dropdown
 */
import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Dropdown } from '@waiyubaodian/ui-kit';
import { api } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { useLanguageSwitch } from '../hooks/useLanguageSwitch';
import { diffDays, pickPlanForLanguage, todayISO, useApp } from '../store';
import type { Language, Plan } from '../types';

/** 手绘双箭头：表示「换一个」，线条略带弧度，避免成套件的直角箭头 */
function SwapGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.2 7.4c3.1-.3 6.4-.4 9.6-.3 1.6 0 2.8.5 3.7 1.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13.1 5.2l2.9 2.9-2.9 2.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.8 12.9c-3.1.3-6.4.4-9.6.3-1.6 0-2.8-.5-3.7-1.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M6.9 15.1L4 12.2l2.9-2.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 手绘对勾：两笔，收尾略上扬 */
function PickGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.9 8.4c1.1.9 1.9 1.9 2.6 3.1 1.6-3.1 3.9-5.9 6.8-8.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 手绘铅笔：改目标入口 */
function PencilGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.9 2.4l2.7 2.7-8.3 8.3-3.4.7.7-3.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9.6 3.7l2.7 2.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export default function SidebarHub() {
  const { catalog, language, plan, switching } = useApp();
  const { user, config, logout } = useAuth();
  const switchToLanguage = useLanguageSwitch();

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState<Language | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const langDef = catalog?.languages.find((item) => item.id === language) ?? null;
  const languages = catalog?.languages ?? [];
  const daysLeft = plan ? Math.max(0, diffDays(todayISO(), plan.examDate)) : 0;
  const goalLabel = plan?.targetLabel ?? '未定目标';
  const allowRegister = config?.allowRegister !== false;
  const roleLabel =
    user?.role === 'admin'
      ? '管理员'
      : user?.role === 'teacher'
        ? '教师'
        : user?.role === 'student'
          ? '学生'
          : null;

  // 打开时懒加载计划列表（已加载过则复用），弹层内用来展示每个语种已有的目标
  const onOpenChange = (next: boolean) => {
    if (next && !plans) {
      setError(null);
      void api
        .plans()
        .then((res) => setPlans(res.plans))
        .catch((err: Error) => setError(err.message));
    }
  };

  const switchTo = async (next: Language, close?: () => void) => {
    if (busy) return;
    if (next === language) {
      close?.();
      return;
    }
    setBusy(next);
    setError(null);
    try {
      const result = await switchToLanguage(next);
      if (result.error) {
        setError(result.error);
        return;
      }
      close?.();
    } finally {
      setBusy(null);
    }
  };

  const onLogout = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await logout();
    } finally {
      setLeaving(false);
    }
  };

  return (
    <section className="hub" aria-label="账号、语种与备考目标">
      {/* 账号区：游客给登录/注册，已登录展示身份与账号操作 */}
      <div className="hub-account">
        <span className={`hub-avatar${user ? '' : ' guest'}`}>
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" />
          ) : user ? (
            user.displayName.slice(0, 1)
          ) : (
            '客'
          )}
        </span>
        <span className="hub-identity">
          <span className="hub-name" title={user?.displayName ?? '游客模式'}>
            {user?.displayName ?? '游客模式'}
          </span>
          <span className="hub-note">{user ? '数据独立保存' : '数据仅存本机'}</span>
        </span>
        {roleLabel ? <span className="hub-role">{roleLabel}</span> : null}
      </div>

      <div className="hub-actions">
        {user ? (
          <>
            <Link className="hub-btn" to="/login" title="修改资料、密码与登录设备">
              账号中心
            </Link>
            <button
              type="button"
              className="hub-btn hub-btn-quiet"
              onClick={() => void onLogout()}
              disabled={leaving}
              title="退出当前账号"
            >
              {leaving ? '退出中…' : '退出'}
            </button>
          </>
        ) : (
          <>
            <Link className="hub-btn hub-btn-primary" to="/login">
              登录
            </Link>
            {allowRegister ? (
              <Link className="hub-btn" to="/login?tab=register" title="创建账号，保存自己的备考数据">
                注册
              </Link>
            ) : null}
          </>
        )}
      </div>

      <div className="hub-rule" aria-hidden="true" />

      {/* 语种区：整行可点，弹层列出各语种及其目标；无计划时引导去定目标 */}
      <Dropdown
        className="hub-lang-drop"
        ariaLabel="切换学习语种"
        menuClassName="hub-lang-menu"
        onOpenChange={onOpenChange}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className={`hub-lang${open ? ' open' : ''}`}
            onClick={toggle}
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={!langDef}
            title={`当前学习语种：${langDef?.name ?? ''} · 点此切换`}
          >
            <span className="hub-lang-text">
              <span className="hub-lang-native">{langDef?.nativeName ?? '加载中…'}</span>
              <span className="hub-lang-meta">
                {langDef?.name ?? ''} · {goalLabel}
              </span>
            </span>
            <span className="hub-lang-swap" aria-hidden="true">
              <SwapGlyph />
            </span>
          </button>
        )}
      >
        {({ close }) => (
          <>
            <div className="lang-pop-head">
              <span>切换学习语种</span>
              <span className="lang-pop-note">切换后回到今日概览</span>
            </div>
            <div className="lang-pop-list">
              {languages.map((item) => {
                const own = pickPlanForLanguage(plans ?? [], item.id);
                const active = item.id === language;
                // 长考试名在窄弹层里会被省略，hover 仍可看到完整目标
                const meta =
                  busy === item.id || switching === item.id
                    ? '切换中…'
                    : own
                      ? `${own.examName} · ${own.targetLabel}`
                      : '还没有计划 · 去定目标';
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`lang-row${active ? ' active' : ''}`}
                    disabled={Boolean(busy)}
                    onClick={() => void switchTo(item.id, close)}
                  >
                    <span className="lang-row-mark">{active ? <PickGlyph /> : null}</span>
                    <span className="lang-row-text">
                      <span className="lang-row-native">{item.nativeName}</span>
                      <span className="lang-row-meta" title={meta}>
                        {meta}
                      </span>
                    </span>
                    {active ? <span className="lang-row-tag">当前</span> : null}
                  </button>
                );
              })}
            </div>
            {error ? <div className="lang-pop-err">{error}</div> : null}
          </>
        )}
      </Dropdown>

      {/* 目标区：倒计时 + 目标展示 + 改目标；无计划时给新建入口 */}
      <div className={`hub-goal${plan ? '' : ' empty'}`}>
        {plan ? (
          <>
            <div className="hub-count-row">
              <strong>{daysLeft}</strong>
              <span>天后考试</span>
            </div>
            <div className="hub-goal-foot">
              <span className="hub-target" title={plan.targetLabel}>
                {plan.targetLabel}
              </span>
              <NavLink
                className="hub-edit"
                to="/setup"
                title="去「定目标」变更考试、目标分数或考试日期"
              >
                <PencilGlyph />
                改目标
              </NavLink>
            </div>
            <div className="hub-meta">
              第 {plan.weeks} 周计划 · 每日 {plan.dailyMinutes} 分钟
            </div>
          </>
        ) : (
          <>
            <div className="hub-count-empty">还没有备考计划</div>
            <NavLink className="hub-edit hub-edit-block" to="/setup" title="去「定目标」新建备考计划">
              <PencilGlyph />
              去定目标
            </NavLink>
          </>
        )}
      </div>
    </section>
  );
}
