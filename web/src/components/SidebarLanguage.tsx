import { useState } from 'react';
import { api } from '../api';
import { useLanguageSwitch } from '../hooks/useLanguageSwitch';
import { pickPlanForLanguage, useApp } from '../store';
import type { Language, Plan } from '../types';
import Dropdown from './Dropdown';

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

/**
 * 侧栏顶部「当前语种」卡片上追加的切换交互：
 * 点卡片弹出白底下拉菜单，列出各语种及其计划；有计划的直接激活，没有的引导去定目标。
 * 定位 / 点外部关闭 / 已选回显 / 跟随主题 全部交给通用 Dropdown 组件。
 */
export default function SidebarLanguage() {
  const { catalog, language, switching } = useApp();
  const switchToLanguage = useLanguageSwitch();

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState<Language | null>(null);
  const [error, setError] = useState<string | null>(null);

  const langDef = catalog?.languages.find((item) => item.id === language) ?? null;
  const languages = catalog?.languages ?? [];
  const plan = pickPlanForLanguage(plans ?? [], language);

  if (!langDef) return null;

  // 打开时懒加载计划列表（已加载过则复用）
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

  return (
    <Dropdown
      className="lang-hub"
      ariaLabel="切换学习语种"
      onOpenChange={onOpenChange}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={`lang-badge${open ? ' open' : ''}`}
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`当前学习语种：${langDef.name} · 点此切换`}
        >
          <span className="lang-badge-text">
            <span className="lang-badge-name">{langDef.nativeName}</span>
            <span className="lang-badge-meta">
              {langDef.name} · {plan ? plan.targetLabel : '未定目标'}
            </span>
          </span>
          <span className="lang-swap" aria-hidden="true">
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
                    <span className="lang-row-meta">
                      {busy === item.id || switching === item.id
                        ? '切换中…'
                        : own
                          ? `${own.examName} · ${own.targetLabel}`
                          : '还没有计划 · 去定目标'}
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
  );
}
