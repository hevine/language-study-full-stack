import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../store';
import type { Language } from '../types';

/** 这些路由绑定的是「某个计划下的具体条目」，换语种后旧参数没有意义 */
const PLAN_BOUND = /^\/(task|practice)\//;

/**
 * 三个语种入口（侧栏顶部、主区顶部、设置 · 外观与语种）共用：
 * 切换成功后把绑定旧计划的页面送回概览，没有目标语种计划则引导去定目标。
 */
export function useLanguageSwitch() {
  const { switchLanguage } = useApp();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return useCallback(
    async (next: Language): Promise<{ ok: boolean; needsSetup: boolean; error?: string }> => {
      try {
        const result = await switchLanguage(next);
        if (result.needsSetup) {
          navigate('/setup', { state: { language: next } });
          return result;
        }
        if (result.ok && PLAN_BOUND.test(pathname)) navigate('/');
        return result;
      } catch (err) {
        return { ok: false, needsSetup: false, error: (err as Error).message };
      }
    },
    [navigate, pathname, switchLanguage],
  );
}
