/**
 * 全局音色上下文：跟随当前语种加载音色库，所有页面共用一份配置。
 * 语种切换时自动重新拉取，保证英语/日语/韩语的音色与场景分配互不串台。
 *
 * 必须等登录态恢复完再取库：子组件的 effect 先于父组件执行，页面刷新时这里会比
 * AuthProvider 的静默刷新更早发出 `/voices`，拿到的是游客（local）的音色 id。
 * 登录态落定后这些 id 在当前账号下并不存在，朗读时会合成 404 并回退系统音色——
 * 也就是「每次刷新都要去设置里再点一次」的根因。因此下面用 authReady + userId 闸门，
 * 并在账号变化时清空、重取。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { useApp } from '../store';
import type {
  Language,
  VoiceAssignmentMap,
  VoiceCandidate,
  VoiceDiscoverResponse,
  VoiceDraft,
  VoiceItem,
  VoicePrefs,
  VoicesResponse,
  VoiceScene,
} from '../types';

interface VoiceSystemValue {
  language: Language;
  data: VoicesResponse | null;
  loading: boolean;
  error: string | null;
  /** 当前机器上 Web Speech 能用的系统音色（只读，删除应用音色不会影响它） */
  systemVoices: SpeechSynthesisVoice[];
  reload: () => Promise<VoicesResponse | null>;
  resolve: (scene: VoiceScene) => VoiceItem | null;
  create: (draft: VoiceDraft) => Promise<void>;
  update: (id: string, patch: Partial<VoiceDraft> & { clearKey?: boolean }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  assign: (patch: Partial<VoiceAssignmentMap>) => Promise<void>;
  savePrefs: (patch: Partial<VoicePrefs>) => Promise<void>;
  discover: () => Promise<VoiceDiscoverResponse>;
  importItems: (items: VoiceCandidate[]) => Promise<void>;
}

const VoiceSystemCtx = createContext<VoiceSystemValue | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { language } = useApp();
  const { ready: authReady, user, config } = useAuth();
  const authRequired = Boolean(config?.required);
  const userId = user?.id ?? '';
  const [data, setData] = useState<VoicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  /** 请求代号：账号 / 语种切换后，旧请求的响应一律丢弃，避免游客快照覆盖已登录快照 */
  const seqRef = useRef(0);

  const reload = useCallback(async () => {
    // 登录态还没恢复完 → 不发请求，等下面的 effect 以真实账号重来一次
    if (!authReady || (authRequired && !userId)) return null;
    const seq = ++seqRef.current;
    try {
      const response = await api.voices(language);
      if (seq !== seqRef.current) return null;
      setData(response);
      setError(null);
      return response;
    } catch (err) {
      if (seq === seqRef.current) setError((err as Error).message);
      return null;
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [language, authReady, authRequired, userId]);

  useEffect(() => {
    // 恢复登录态期间先别渲染音色：宁可短暂空窗，也不要用游客音色库冒充本人配置
    if (!authReady || (authRequired && !userId)) {
      setData(null);
      setLoading(true);
      return;
    }
    setLoading(true);
    void reload();
  }, [reload, authReady, authRequired, userId]);

  /** 系统音色由浏览器提供，只是读取，不会安装也不会删除任何东西 */
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    let disposed = false;
    const build = () => {
      if (disposed) return;
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) setSystemVoices(voices);
    };
    build();
    const timers = [80, 240, 600, 1200, 2400].map((delay) => window.setTimeout(build, delay));
    window.speechSynthesis.addEventListener('voiceschanged', build);
    return () => {
      disposed = true;
      timers.forEach((id) => window.clearTimeout(id));
      window.speechSynthesis.removeEventListener('voiceschanged', build);
    };
  }, []);

  const resolve = useCallback(
    (scene: VoiceScene): VoiceItem | null => {
      if (!data) return null;
      const assignedId = data.assignments[scene];
      const assigned = assignedId ? data.voices.find((item) => item.id === assignedId) : undefined;
      return assigned ?? data.voices.find((item) => item.isDefault) ?? data.voices[0] ?? null;
    },
    [data],
  );

  const apply = useCallback((response: VoicesResponse) => {
    setData(response);
    setError(null);
  }, []);

  const create = useCallback(
    async (draft: VoiceDraft) => apply(await api.createVoice({ ...draft, language })),
    [apply, language],
  );

  const update = useCallback(
    async (id: string, patch: Partial<VoiceDraft> & { clearKey?: boolean }) =>
      apply(await api.updateVoice(id, { ...patch, language })),
    [apply, language],
  );

  const remove = useCallback(
    async (id: string) => apply(await api.deleteVoice(id, language)),
    [apply, language],
  );

  const setDefault = useCallback(
    async (id: string) => apply(await api.setDefaultVoice(id, language)),
    [apply, language],
  );

  const assign = useCallback(
    async (patch: Partial<VoiceAssignmentMap>) => apply(await api.setVoiceAssignments(language, patch)),
    [apply, language],
  );

  const savePrefs = useCallback(
    async (patch: Partial<VoicePrefs>) => apply(await api.setVoicePrefs(language, patch)),
    [apply, language],
  );

  const discover = useCallback(() => api.discoverVoices(language), [language]);

  const importItems = useCallback(
    async (items: VoiceCandidate[]) => apply(await api.importVoices(language, items)),
    [apply, language],
  );

  return (
    <VoiceSystemCtx.Provider
      value={{
        language,
        data,
        loading,
        error,
        systemVoices,
        reload,
        resolve,
        create,
        update,
        remove,
        setDefault,
        assign,
        savePrefs,
        discover,
        importItems,
      }}
    >
      {children}
    </VoiceSystemCtx.Provider>
  );
}

export function useVoiceSystem(): VoiceSystemValue {
  const value = useContext(VoiceSystemCtx);
  if (!value) throw new Error('useVoiceSystem 必须在 VoiceProvider 内使用');
  return value;
}
