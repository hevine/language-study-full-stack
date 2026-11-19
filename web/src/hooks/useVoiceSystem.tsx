/**
 * 全局音色上下文：跟随当前语种加载音色库，所有页面共用一份配置。
 * 语种切换时自动重新拉取，保证英语/日语/韩语的音色与场景分配互不串台。
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
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
  const [data, setData] = useState<VoicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);

  const reload = useCallback(async () => {
    try {
      const response = await api.voices(language);
      setData(response);
      setError(null);
      return response;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

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
