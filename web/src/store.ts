import { createContext, useContext } from 'react';
import type { ThemeId } from '@waiyubaodian/ui-kit/theme';
import type { Catalog, Language, Plan } from './types';

export interface AppState {
  catalog: Catalog | null;
  plan: Plan | null;
  loading: boolean;
  /** 业务数据加载失败的原因（连不上后端等），由路由外壳展示 */
  error: string | null;
  reload: () => Promise<void>;
  /** 当前语种（跟随当前计划） */
  language: Language;
  /** 当前计划指纹：切换语种/换计划后会变，页面数据依赖它重新取数 */
  planKey: string;
  /** 正在切换到的语种，用于全局过渡态 */
  switching: Language | null;
  /**
   * 切语种：激活该语种已有计划。没有计划时返回 needsSetup，由调用方引导去定目标。
   * 三个入口（侧栏 / 主区顶部 / 设置）都走这一个动作，保证行为与数据一致。
   */
  switchLanguage: (next: Language) => Promise<{ ok: boolean; needsSetup: boolean }>;
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  /** 回到「跟随语种」的默认配色 */
  resetTheme: () => void;
  autoTheme: boolean;
}

export const AppCtx = createContext<AppState>({
  catalog: null,
  plan: null,
  loading: true,
  error: null,
  reload: async () => {},
  language: 'en',
  planKey: 'none',
  switching: null,
  switchLanguage: async () => ({ ok: false, needsSetup: false }),
  theme: 'blue',
  setTheme: () => {},
  resetTheme: () => {},
  autoTheme: true,
});

export const useApp = () => useContext(AppCtx);

export function todayISO(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round(
    (new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86_400_000,
  );
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function formatCn(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${m} 月 ${d} 日 · ${WEEKDAYS[date.getDay()]}`;
}

export function formatShort(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
}

/**
 * 同一语种可能存在多份历史计划：优先挑「考试日还没过」里最新的那份，
 * 都过期了才退回最新的一份，避免切语种时落到早就考完的旧计划上。
 */
export function pickPlanForLanguage(
  plans: Plan[],
  language: Language,
  today = todayISO(),
): Plan | undefined {
  const own = plans.filter((item) => item.language === language);
  if (own.length === 0) return undefined;
  const alive = own.filter((item) => diffDays(today, item.examDate) >= 0);
  const pool = alive.length > 0 ? alive : own;
  return pool.reduce((best, item) => (item.createdAt > best.createdAt ? item : best));
}
