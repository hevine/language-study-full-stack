import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ExamHub from './pages/ExamHub';
import ExamResult from './pages/ExamResult';
import ExamTake from './pages/ExamTake';
import PathPage from './pages/Path';
import PlanPage from './pages/Plan';
import Practice from './pages/Practice';
import PracticeHub from './pages/PracticeHub';
import SettingsPage from './pages/Settings';
import Setup from './pages/Setup';
import TaskPage from './pages/TaskPage';
import Today from './pages/Today';
import VocabPage from './pages/Vocab';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';

// 播放器 SDK 内联了 WASM，体积较大；懒加载避免拖慢现有页面首屏
const MediaPlayerDemo = lazy(() => import('./pages/MediaPlayerDemo'));
const ListeningMaterial = lazy(() => import('./pages/ListeningMaterial'));
const UIKit = lazy(() => import('./pages/UIKit'));
import { AppCtx, pickPlanForLanguage, useApp } from './store';
import { applyTheme, isAutoTheme, resetTheme, resolveTheme, saveTheme, type ThemeId } from '@waiyubaodian/ui-kit/theme';
import { useAuth } from './auth/AuthProvider';
import { VoiceProvider } from './hooks/useVoiceSystem';
import type { Catalog, Language, Plan } from './types';

function CenterMessage({ children }: { children: ReactNode }) {
  return (
    <div className="center-page">
      <div className="center">{children}</div>
    </div>
  );
}

/**
 * 路由外壳。登录页与扫码回调页是独立全屏页面（不带侧栏）；
 * AUTH_REQUIRED=true 时，其余任何页面在未登录状态下一律渲染登录页。
 */
function AppContent() {
  const {
    plan, planKey, loading, error, language, switching,
  } = useApp();
  const { ready: authReady, user, config } = useAuth();
  const location = useLocation();

  if (location.pathname === '/login') return <Login />;
  if (location.pathname === '/auth/callback') return <AuthCallback />;

  if (!authReady) {
    return <CenterMessage><div className="hint">正在恢复登录状态…</div></CenterMessage>;
  }
  if (config?.required && !user) return <Login />;

  if (loading) {
    return (
      <CenterMessage>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>外语考证宝典</div>
        <div className="hint" style={{ marginTop: 8 }}>正在准备你的备考空间…</div>
      </CenterMessage>
    );
  }

  if (error) {
    return (
      <CenterMessage>
        <div className="card card-pad" style={{ maxWidth: 460 }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>连不上本地服务</h2>
          <p className="small muted" style={{ marginBottom: 14 }}>{error}</p>
          <p className="hint" style={{ marginBottom: 14 }}>
            请确认已执行 <code>npm run dev</code>（或 <code>npm start</code>），后端默认监听 4399 端口。
          </p>
          <button className="btn btn-primary btn-block" onClick={() => window.location.reload()}>
            重新连接
          </button>
        </div>
      </CenterMessage>
    );
  }

  return (
    <Layout>
      {/* 以计划为键：切语种后整页重挂载，所有页面按新语种重新取数 */}
      <Suspense fallback={<CenterMessage><div className="hint">正在加载…</div></CenterMessage>}>
      <Routes key={planKey}>
        <Route path="/" element={plan ? <Dashboard /> : <Navigate to="/setup" replace />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/today" element={plan ? <Today /> : <Navigate to="/setup" replace />} />
        <Route
          path="/task/:date/:taskId"
          element={plan ? <TaskPage /> : <Navigate to="/setup" replace />}
        />
        <Route path="/practice" element={plan ? <PracticeHub /> : <Navigate to="/setup" replace />} />
        <Route path="/practice/:date/:taskId" element={plan ? <Practice /> : <Navigate to="/setup" replace />} />
        <Route path="/path" element={<PathPage />} />
        <Route path="/media-player" element={<MediaPlayerDemo />} />
        <Route path="/ui-kit" element={<UIKit />} />
        <Route path="/listening" element={<ListeningMaterial />} />
        <Route path="/plan" element={plan ? <PlanPage /> : <Navigate to="/setup" replace />} />
        <Route path="/vocab" element={<VocabPage />} />
        <Route path="/exams" element={<ExamHub />} />
        <Route path="/exams/:paperId/take" element={<ExamTake />} />
        <Route path="/exams/attempts/:attemptId" element={<ExamResult />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [switching, setSwitching] = useState<Language | null>(null);

  // 登录态变化意味着数据归属变了：换账号后必须整体重拉，避免串到上一个账号的数据
  const { ready: authReady, user, config } = useAuth();
  const userId = user?.id ?? null;

  const reload = useCallback(async () => {
    const [nextCatalog, active] = await Promise.all([api.catalog(), api.activePlan()]);
    setCatalog(nextCatalog);
    setPlan(active.plan);
    setError(null);
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (config?.required && !user) return;
    let cancelled = false;
    setLoading(true);
    reload()
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, config?.required, userId, reload]);

  const language = plan?.language ?? 'en';
  // 计划指纹：换语种 / 重建计划后变化，路由以此重挂载，页面的数据请求全部重跑
  const planKey = plan?.id ?? 'none';
  // themeTick 用来在用户改配色 / 改语种后重新读一次本地偏好
  const theme = useMemo(() => resolveTheme(language), [language, themeTick]);
  const autoTheme = useMemo(() => isAutoTheme(language), [language, themeTick]);

  /**
   * 切语种只有一个动作：先激活目标语种的计划，再整体刷新。
   * 三个入口共用，避免各写一套导致「菜单切了、页面数据没变」。
   */
  const switchLanguage = useCallback(
    async (next: Language) => {
      if (next === language) return { ok: true, needsSetup: false };
      setSwitching(next);
      try {
        const { plans } = await api.plans();
        const target = pickPlanForLanguage(plans, next);
        if (!target) return { ok: false, needsSetup: true };
        await api.activatePlan(target.id);
        await reload();
        setThemeTick((value) => value + 1);
        return { ok: true, needsSetup: false };
      } finally {
        setSwitching(null);
      }
    },
    [language, reload],
  );

  useEffect(() => {
    applyTheme(theme, language);
  }, [theme, language]);

  const setTheme = useCallback(
    (id: ThemeId) => {
      saveTheme(language, id);
      setThemeTick((value) => value + 1);
    },
    [language],
  );

  const resetThemeToAuto = useCallback(() => {
    resetTheme(language);
    setThemeTick((value) => value + 1);
  }, [language]);

  return (
    <AppCtx.Provider
      value={{
        catalog,
        plan,
        loading,
        error,
        reload,
        language,
        planKey,
        switching,
        switchLanguage,
        theme,
        setTheme,
        resetTheme: resetThemeToAuto,
        autoTheme,
      }}
    >
      <HashRouter>
        <VoiceProvider>
          <AppContent />
        </VoiceProvider>
      </HashRouter>
    </AppCtx.Provider>
  );
}
