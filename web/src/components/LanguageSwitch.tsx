import { useState } from 'react';
import { useLanguageSwitch } from '../hooks/useLanguageSwitch';
import { useApp } from '../store';
import type { Language } from '../types';

/**
 * 语种切换：English ⇄ 日本語 ⇄ 한국어。
 * 切换动作统一交给 useLanguageSwitch：优先复用该语种已有计划（直接激活），
 * 没有计划才引导去定目标；切完页面数据按新语种整体重取。
 */
export default function LanguageSwitch({
  compact = false,
  onSwitched,
}: {
  compact?: boolean;
  onSwitched?: (language: Language) => void;
}) {
  const { catalog, language, switching } = useApp();
  const switchToLanguage = useLanguageSwitch();
  const [busy, setBusy] = useState<Language | null>(null);
  const [error, setError] = useState<string | null>(null);

  const languages = catalog?.languages ?? [];

  const switchTo = async (next: Language) => {
    if (next === language || busy) return;
    setBusy(next);
    setError(null);
    try {
      const result = await switchToLanguage(next);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.ok) onSwitched?.(next);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lang-switch-wrap">
      <div className={`lang-switch${compact ? ' compact' : ''}`} role="tablist" aria-label="切换语种">
        {languages.map((item) => {
          const active = language === item.id;
          const pending = busy === item.id || switching === item.id;
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={active}
              className={`lang-opt${active ? ' active' : ''}${pending ? ' busy' : ''}`}
              onClick={() => switchTo(item.id as Language)}
              disabled={Boolean(busy) || Boolean(switching)}
              title={active ? `当前：${item.name}` : `切换到${item.name}计划`}
            >
              <span className="lang-opt-native">{item.nativeName}</span>
              <span className="lang-opt-name">{pending ? '切换中…' : item.name}</span>
            </button>
          );
        })}
      </div>
      {error ? <div className="hint" style={{ marginTop: 6 }}>{error}</div> : null}
    </div>
  );
}
