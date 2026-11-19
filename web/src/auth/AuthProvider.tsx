/**
 * 全局登录态。
 *
 * 安全约定：
 *   · access token 只在模块内存里（api.ts），刷新页面即丢；
 *   · refresh token 只在 HttpOnly Cookie 里，前端代码读不到、也拿不到；
 *   · 页面加载时用 Cookie 静默换回一对新令牌，实现「刷新不掉线」；
 *   · 401 自动刷新重试，刷新失败广播 AUTH_LOST_EVENT，由这里统一清空用户。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, AUTH_LOST_EVENT, refreshSilently, setAccessToken } from '../api';
import type { AuthConfig, AuthUser, TokenResponse } from '../types';

export interface AuthState {
  config: AuthConfig | null;
  user: AuthUser | null;
  /** 初始化完成（配置已取、静默刷新已尝试） */
  ready: boolean;
  error: string | null;
  applyTokens: (data: TokenResponse) => void;
  loginWithPassword: (username: string, password: string) => Promise<void>;
  loginWithTicket: (ticketId: string, ticketSecret: string) => Promise<void>;
  logout: () => Promise<void>;
  reloadConfig: () => Promise<void>;
}

const noop = async () => {};

const AuthCtx = createContext<AuthState>({
  config: null,
  user: null,
  ready: false,
  error: null,
  applyTokens: () => {},
  loginWithPassword: noop,
  loginWithTicket: noop,
  logout: noop,
  reloadConfig: noop,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTokens = useCallback((data: TokenResponse) => {
    setAccessToken(data.accessToken);
    setUser(data.user);
    setError(null);
  }, []);

  const reloadConfig = useCallback(async () => {
    const next = await api.authConfig();
    setConfig(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const nextConfig = await api.authConfig();
        if (cancelled) return;
        setConfig(nextConfig);
        const restored = await refreshSilently();
        if (cancelled) return;
        setUser(restored?.user ?? null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onLost = () => {
      setAccessToken(null);
      setUser(null);
    };
    window.addEventListener(AUTH_LOST_EVENT, onLost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, onLost);
  }, []);

  const loginWithPassword = useCallback(
    async (username: string, password: string) => {
      applyTokens(await api.authLogin(username, password));
    },
    [applyTokens],
  );

  const loginWithTicket = useCallback(
    async (ticketId: string, ticketSecret: string) => {
      applyTokens(await api.authQrExchange(ticketId, ticketSecret));
      sessionStorage.removeItem('wb_login_ticket');
    },
    [applyTokens],
  );

  const logout = useCallback(async () => {
    try {
      await api.authLogout();
    } catch {
      // 服务端已不可达也要清掉本地登录态
    }
    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      config,
      user,
      ready,
      error,
      applyTokens,
      loginWithPassword,
      loginWithTicket,
      logout,
      reloadConfig,
    }),
    [config, user, ready, error, applyTokens, loginWithPassword, loginWithTicket, logout, reloadConfig],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
