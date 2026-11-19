/**
 * 音色管理台（设置页）。
 *
 * 关键设计：这里可以单独管理三个语种的音色，不必切换学习计划；
 * 每次写操作都把 language 显式传给后端，服务端按 user_id + language 隔离。
 * 「系统音色」只是引用浏览器里已存在的声音，删除只删应用记录，绝不动系统设置。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Banner, SectionCard } from './ui';
import { useApp } from '../store';
import { useVoiceSystem } from '../hooks/useVoiceSystem';
import {
  BCP47,
  isLocalEdge,
  LOCAL_EDGE_BASE,
  matchSystemVoice,
  NOVELTY,
  prettyName,
  SCENES,
  SCENE_LABEL,
} from '../hooks/voiceUtils';
import type {
  EdgeTtsStatus,
  Language,
  VoiceCandidate,
  VoiceDraft,
  VoiceItem,
  VoicePreset,
  VoicesResponse,
  VoiceScene,
} from '../types';
import Dropdown, { type DropdownOption } from './Dropdown';

const LANG_LABEL: Record<Language, string> = { en: '英语', ja: '日语', ko: '韩语' };
const LANGS: Language[] = ['en', 'ja', 'ko'];
const RATES = [0.7, 0.8, 0.9, 1, 1.15];

type AddTab = 'system' | 'popular' | 'cloud';

const SOURCE_LABEL: Record<VoiceItem['source'], string> = {
  system: '系统音色',
  preset: '流行音色',
  ai: 'AI 推荐',
  custom: '自定义',
};

function emptyDraft(language: Language): VoiceDraft {
  return {
    language,
    name: '',
    provider: 'browser',
    engineVoice: '',
    matchHint: '',
    model: '',
    baseUrl: '',
    voiceId: '',
    style: '',
    persona: '',
    tags: [],
    rate: 0.9,
    pitch: 1,
    volume: 1,
    source: 'custom',
  };
}

export default function VoiceStudio() {
  const { language: planLanguage } = useApp();
  const { systemVoices, reload: reloadGlobal } = useVoiceSystem();
  const [activeLang, setActiveLang] = useState<Language>(planLanguage);
  const [snapshot, setSnapshot] = useState<VoicesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'teal' | 'danger'; text: string } | null>(null);
  const [addTab, setAddTab] = useState<AddTab>('system');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [edgeStatus, setEdgeStatus] = useState<EdgeTtsStatus | null>(null);
  const [checkingEdge, setCheckingEdge] = useState(false);

  /* 添加表单 */
  const [systemPick, setSystemPick] = useState('');
  const [draft, setDraft] = useState<VoiceDraft>(() => emptyDraft(planLanguage));
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<VoiceCandidate[]>([]);
  const [discovery, setDiscovery] = useState<{ source: string; model: string | null; notice: string | null } | null>(null);
  const [discovering, setDiscovering] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async (lang: Language) => {
    try {
      const response = await api.voices(lang);
      setSnapshot(response);
      return response;
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
      return null;
    }
  }, []);

  useEffect(() => {
    void load(activeLang);
  }, [activeLang, load]);

  const checkEdge = useCallback(async (refresh = false) => {
    setCheckingEdge(true);
    try {
      setEdgeStatus(await api.edgeTtsStatus(refresh));
    } catch (err) {
      setEdgeStatus({ available: false, python: '', version: null, hint: (err as Error).message });
    } finally {
      setCheckingEdge(false);
    }
  }, []);

  useEffect(() => {
    void checkEdge();
  }, [checkEdge]);

  useEffect(() => {
    setActiveLang(planLanguage);
  }, [planLanguage]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    },
    [],
  );

  const afterWrite = useCallback(
    async (response: VoicesResponse) => {
      setSnapshot(response);
      if (response.language === planLanguage) void reloadGlobal();
    },
    [planLanguage, reloadGlobal],
  );

  const run = async (task: () => Promise<VoicesResponse>, okText?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await afterWrite(await task());
      if (okText) setMessage({ tone: 'teal', text: okText });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const stopPreview = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audioRef.current = null;
    }
    setPreviewId(null);
  };

  /** 试听任意语种的任意音色：browser 直接读系统声音，cloud 走服务端合成 */
  const preview = async (item: VoiceItem | VoicePreset, text: string) => {
    if (previewId === item.name) {
      stopPreview();
      return;
    }
    stopPreview();
    const sample = text.trim();
    if (!sample) {
      setMessage({ tone: 'danger', text: '先写一句试听语料再点试听' });
      return;
    }
    setPreviewId(item.name);

    if (item.provider === 'cloud') {
      if (!('id' in item)) {
        setMessage({
          tone: 'danger',
          text: isLocalEdge(item.baseUrl)
            ? '请先把这个本地 Neural 音色加入音色库再试听'
            : '云端音色请先导入并填好 API Key 再试听',
        });
        setPreviewId(null);
        return;
      }
      try {
        const url = await api.synthesizeVoice(item.id, sample, activeLang, snapshot?.prefs.globalRate);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setPreviewId(null);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setPreviewId(null);
          setMessage({ tone: 'danger', text: '试听播放失败，请检查 TTS 配置' });
        };
        void audio.play().catch(() => setPreviewId(null));
      } catch (err) {
        setPreviewId(null);
        setMessage({ tone: 'danger', text: (err as Error).message });
      }
      return;
    }

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setPreviewId(null);
      setMessage({ tone: 'danger', text: '当前浏览器不支持语音合成' });
      return;
    }
    const utter = new SpeechSynthesisUtterance(sample);
    const pseudo = { ...item, id: 'preview', language: activeLang } as unknown as VoiceItem;
    const found = matchSystemVoice(pseudo, systemVoices, BCP47[activeLang]);
    if (found) {
      utter.voice = found;
      utter.lang = found.lang;
    } else {
      utter.lang = BCP47[activeLang];
    }
    utter.rate = snapshot?.prefs.globalRate ?? item.rate;
    utter.onend = () => setPreviewId(null);
    utter.onerror = () => setPreviewId(null);
    window.speechSynthesis.speak(utter);
  };

  const systemOptions = systemVoices
    .filter((voice) => voice.lang.toLowerCase().startsWith(activeLang))
    .filter((voice) => !NOVELTY.test(voice.name))
    .slice(0, 60);

  const addSystemVoice = () => {
    const picked = systemVoices.find((voice) => voice.voiceURI === systemPick);
    if (!picked) {
      setMessage({ tone: 'danger', text: '先选一个系统音色' });
      return;
    }
    void run(
      () =>
        api.createVoice({
          ...emptyDraft(activeLang),
          name: prettyName(picked).slice(0, 40) || '系统音色',
          provider: 'browser',
          engineVoice: picked.voiceURI,
          matchHint: prettyName(picked),
          persona: `${picked.lang} · 系统内置音色`,
          tags: ['系统音色'],
          source: 'system',
        }),
      '已把系统音色加入音色库（系统里的声音本身没有任何改动）',
    );
    setSystemPick('');
  };

  const doDiscover = async () => {
    setDiscovering(true);
    setMessage(null);
    try {
      const result = await api.discoverVoices(activeLang);
      setCandidates(result.items);
      setSelectedKeys(result.items.map((item) => item.key));
      setDiscovery({ source: result.source, model: result.model, notice: result.notice });
      if (result.notice) setMessage({ tone: 'teal', text: result.notice });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setDiscovering(false);
    }
  };

  const importSelected = () => {
    const pool: VoiceCandidate[] =
      candidates.length > 0
        ? candidates
        : (snapshot?.presets ?? []).map((preset) => ({
            key: preset.key,
            name: preset.name,
            persona: preset.persona,
            provider: preset.provider,
            matchHint: preset.matchHint,
            voiceId: preset.voiceId,
            model: preset.model,
            style: preset.style,
            tags: preset.tags,
            rate: preset.rate,
          }));
    const picked = pool.filter((item) => selectedKeys.includes(item.key));
    if (picked.length === 0) {
      setMessage({ tone: 'danger', text: '先勾选要添加的音色' });
      return;
    }
    void run(() => api.importVoices(activeLang, picked), `已添加 ${picked.length} 个音色`);
    setSelectedKeys([]);
  };

  const addCloud = () => {
    const local = isLocalEdge(draft.baseUrl);
    if (!draft.name.trim() || !draft.voiceId.trim() || !draft.model.trim() || (!local && !draft.apiKey?.trim())) {
      setMessage({
        tone: 'danger',
        text: local ? '名称、模型与音色 ID 都要填' : '名称、模型、音色 ID 与 API Key 都要填',
      });
      return;
    }
    void run(
      () =>
        api.createVoice({
          ...draft,
          apiKey: local ? 'local-edge-tts' : draft.apiKey,
          provider: 'cloud',
          source: 'custom',
          baseUrl: local ? LOCAL_EDGE_BASE : draft.baseUrl.trim() || 'https://api.openai.com/v1',
          persona: draft.persona.trim() || (local ? '本地 Neural 音色' : '云端大模型音色'),
          tags: local ? ['本地 Neural', '自定义'] : ['云端', '自定义'],
        }),
      local ? '本地 Neural 音色已添加，无需 API Key' : '云端音色已添加，可在场景分配里选用',
    );
    setDraft(emptyDraft(activeLang));
  };

  const voices = snapshot?.voices ?? [];
  const assignments = snapshot?.assignments;
  const prefs = snapshot?.prefs;

  return (
    <SectionCard
      title="音色库 · 朗读与听力"
      extra={
        <div className="row" style={{ gap: 6 }}>
          {LANGS.map((lang) => (
            <button
              key={lang}
              className={`btn btn-sm${activeLang === lang ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => {
                setActiveLang(lang);
                setEditingId(null);
                setCandidates([]);
                setSelectedKeys([]);
                setDiscovery(null);
                stopPreview();
              }}
            >
              {LANG_LABEL[lang]}
            </button>
          ))}
        </div>
      }
    >
      {message ? <Banner tone={message.tone === 'teal' ? 'teal' : 'danger'}>{message.text}</Banner> : null}
      {!snapshot ? (
        <div className="hint">正在读取{LANG_LABEL[activeLang]}音色库…</div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="hint">
            当前管理 <strong>{LANG_LABEL[activeLang]}</strong> 的音色，与另外两个语种完全隔离。
            删除只移除应用里的这条记录，<strong>不会改动操作系统中安装的任何声音</strong>。
          </div>

          {/* 本地 Edge Neural：零成本的三语种母语音色 */}
          <div className="voice-block">
            <div className="voice-block-title">本地 Neural 引擎 · 零成本母语发音</div>
            <div className="hint">
              服务端调用本机 edge-tts 合成，英 / 日 / 韩各有母语 Neural 音色；不用 API Key、不产生费用。
              这是浏览器「大声朗读」的非官方接口，微软可能临时调整鉴权导致 403，届时会自动回退到系统音色。
            </div>
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
              <span className={`chip ${edgeStatus?.available ? 'chip-teal' : 'chip-gold'}`}>
                {edgeStatus ? (edgeStatus.available ? '引擎已就绪' : '引擎未就绪') : '正在检测…'}
              </span>
              <span className="hint">{edgeStatus?.hint ?? ''}</span>
              <span className="spacer" />
              <button
                className="btn btn-sm btn-ghost"
                disabled={checkingEdge}
                onClick={() => void checkEdge(true)}
              >
                重新检测
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.enableEdgeVoices(activeLang),
                    `${LANG_LABEL[activeLang]}本地 Neural 音色已启用：设为默认，四个场景全部切换`,
                  )
                }
              >
                一键启用{LANG_LABEL[activeLang]}音色
              </button>
            </div>
            {edgeStatus && !edgeStatus.available ? (
              <div className="hint" style={{ marginTop: 8 }}>
                首次使用请在项目目录运行 <code>npm run voice:setup</code> 装本地依赖；
                若已装仍不可用，可用 <code>EDGE_TTS_PYTHON</code> 指向你的 Python。
              </div>
            ) : null}
          </div>

          {/* 试听语料与全局语速 */}
          <div className="voice-block">
            <div className="voice-block-title">我的试听语料</div>
            <textarea
              className="input"
              rows={2}
              value={prefs?.sampleText ?? ''}
              placeholder="写一句你想反复听的话，各页面的「试听」都会念它"
              onChange={(event) =>
                setSnapshot({ ...snapshot, prefs: { ...snapshot.prefs, sampleText: event.target.value } })
              }
            />
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
              <span className="hint">全局语速</span>
              <div className="rate-group">
                {RATES.map((value) => (
                  <button
                    key={value}
                    className={prefs?.globalRate === value ? 'active' : ''}
                    onClick={() =>
                      void run(() => api.setVoicePrefs(activeLang, { globalRate: value }))
                    }
                  >
                    {value}×
                  </button>
                ))}
              </div>
              <span className="spacer" />
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      api.setVoicePrefs(activeLang, {
                        sampleText: (prefs?.sampleText ?? '').slice(0, 600),
                      }),
                    '试听语料已保存，单词 / 长难句 / 精读 / 听力页的试听都会念这一句',
                  )
                }
              >
                保存语料
              </button>
              <button
                className="btn btn-sm btn-ghost"
                disabled={voices.length === 0}
                onClick={() => {
                  const item = voices.find((voice) => voice.isDefault) ?? voices[0];
                  if (item) void preview(item, prefs?.sampleText ?? '');
                }}
              >
                {previewId ? '停止试听' : '试听默认音色'}
              </button>
            </div>
          </div>

          {/* 场景分配 */}
          <div className="voice-block">
            <div className="voice-block-title">场景分配 · 不同内容用不同声音</div>
            <div className="voice-grid">
              {SCENES.map((scene: VoiceScene) => (
                <label key={scene} className="voice-assign">
                  <span className="hint">{SCENE_LABEL[scene]}</span>
                  <Dropdown
                    block
                    disabled={busy}
                    value={assignments?.[scene] ?? ''}
                    options={[
                      { value: '', label: '跟随默认音色' },
                      ...voices.map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onChange={(id) =>
                      void run(() =>
                        api.setVoiceAssignments(activeLang, {
                          [scene]: id || null,
                        } as Partial<Record<VoiceScene, string | null>>),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          </div>

          {/* 音色列表 */}
          <div className="voice-block">
            <div className="voice-block-title">已添加的音色 · {voices.length}</div>
            {voices.length === 0 ? (
              <div className="hint">这个语种还没有音色，从下面添加就能开始用。</div>
            ) : (
              <div className="voice-list">
                {voices.map((item) => (
                  <div key={item.id} className={`voice-card${item.isDefault ? ' is-default' : ''}`}>
                    <div className="voice-card-head">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                          <strong>{item.name}</strong>
                          {item.isDefault ? <span className="chip chip-teal">默认</span> : null}
                          <span
                            className={`chip ${
                              item.provider === 'cloud'
                                ? isLocalEdge(item.baseUrl)
                                  ? 'chip-teal'
                                  : 'chip-gold'
                                : ''
                            }`}
                          >
                            {isLocalEdge(item.baseUrl)
                              ? '本地 Neural'
                              : item.provider === 'cloud'
                                ? '云端 TTS'
                                : '系统音色'}
                          </span>
                          <span className="chip">{SOURCE_LABEL[item.source]}</span>
                          {item.provider === 'cloud' ? (
                            isLocalEdge(item.baseUrl) ? (
                              <span className="chip chip-teal">无需 Key</span>
                            ) : (
                              <span className={`chip ${item.hasKey ? 'chip-teal' : 'chip-gold'}`}>
                                {item.hasKey ? `Key ${item.maskedKey}` : '未填 Key'}
                              </span>
                            )
                          ) : null}
                        </div>
                        <div className="hint" style={{ marginTop: 4 }}>
                          {item.persona || '未填写听感描述'}
                          {item.tags.length > 0 ? ` · ${item.tags.join(' / ')}` : ''} · {item.rate}×
                        </div>
                      </div>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => void preview(item, prefs?.sampleText ?? '')}
                        >
                          {previewId === item.name ? '停止' : '试听'}
                        </button>
                        {!item.isDefault ? (
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={busy}
                            onClick={() => void run(() => api.setDefaultVoice(item.id, activeLang))}
                          >
                            设默认
                          </button>
                        ) : null}
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setEditingId(editingId === item.id ? null : item.id)}
                        >
                          编辑
                        </button>
                        <button
                          className={`btn btn-sm ${confirmId === item.id ? 'btn-danger' : 'btn-ghost'}`}
                          disabled={busy}
                          onClick={() => {
                            if (confirmId !== item.id) {
                              setConfirmId(item.id);
                              return;
                            }
                            setConfirmId(null);
                            void run(() => api.deleteVoice(item.id, activeLang), '已从音色库移除（系统声音不受影响）');
                          }}
                        >
                          {confirmId === item.id ? '确认移除？' : '移除'}
                        </button>
                      </div>
                    </div>

                    {editingId === item.id ? (
                      <VoiceEditor
                        item={item}
                        busy={busy}
                        onCancel={() => setEditingId(null)}
                        onSave={(patch) =>
                          void run(async () => {
                            const response = await api.updateVoice(item.id, { ...patch, language: activeLang });
                            setEditingId(null);
                            return response;
                          }, '音色已更新')
                        }
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 添加音色 */}
          <div className="voice-block">
            <div className="voice-block-title">添加音色</div>
            <div className="row" style={{ gap: 6, marginBottom: 10 }}>
              {(
                [
                  ['system', '本机系统音色'],
                  ['popular', '流行音色 / AI 推荐'],
                  ['cloud', '云端大模型 TTS'],
                ] as Array<[AddTab, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={`btn btn-sm${addTab === id ? ' btn-primary' : ' btn-ghost'}`}
                  onClick={() => setAddTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {addTab === 'system' ? (
              <div>
                <div className="field">
                  <label>从本机已安装的声音里选（只读引用）</label>
                  <Dropdown
                    block
                    value={systemPick}
                    options={[
                      { value: '', label: '请选择…' },
                      ...systemOptions.map((voice) => ({
                        value: voice.voiceURI,
                        label: `${prettyName(voice)} · ${voice.lang}`,
                      })),
                    ]}
                    onChange={(voiceURI) => setSystemPick(voiceURI)}
                  />
                  <div className="hint">
                    这里列出的是浏览器读到的{LANG_LABEL[activeLang]}系统声音，共 {systemOptions.length} 个。
                    加入音色库后可以随时移除，系统里的声音不会因此被删除。
                  </div>
                </div>
                <button className="btn btn-primary btn-sm" disabled={busy || !systemPick} onClick={addSystemVoice}>
                  加入音色库
                </button>
              </div>
            ) : null}

            {addTab === 'popular' ? (
              <div>
                <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                  <button className="btn btn-sm" disabled={discovering} onClick={() => void doDiscover()}>
                    {discovering ? 'AI 正在挑选…' : '✦ 让大模型按语种推荐流行音色'}
                  </button>
                  {discovery ? (
                    <span className="hint">
                      来源：{discovery.source === 'ai' ? `AI（${discovery.model ?? '模型'}）` : '内置目录'}
                    </span>
                  ) : null}
                </div>
                <div className="voice-candidates">
                  {(candidates.length > 0
                    ? candidates.map((item) => ({
                        key: item.key,
                        name: item.name,
                        persona: item.persona,
                        provider: item.provider,
                        tags: item.tags,
                        rate: item.rate,
                      }))
                    : (snapshot.presets ?? []).map((preset) => ({
                        key: preset.key,
                        name: preset.name,
                        persona: preset.persona,
                        provider: preset.provider,
                        tags: preset.tags,
                        rate: preset.rate,
                      }))
                  ).map((item) => (
                    <label key={item.key} className="voice-candidate">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(item.key)}
                        onChange={(event) =>
                          setSelectedKeys((prev) =>
                            event.target.checked ? [...prev, item.key] : prev.filter((key) => key !== item.key),
                          )
                        }
                      />
                      <span style={{ flex: 1 }}>
                        <strong>{item.name}</strong>
                        <span className="hint"> · {item.persona}</span>
                        <span className="hint">
                          {' '}
                          · {item.provider === 'cloud' ? '云端' : '系统'} · {item.rate}×
                          {item.tags.length > 0 ? ` · ${item.tags.join('/')}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  云端音色导入后还需在「编辑」里填 API Key 才能发声；本地 Neural 与系统音色导入即可用。
                </div>
                <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={busy} onClick={importSelected}>
                  导入选中音色
                </button>
              </div>
            ) : null}

            {addTab === 'cloud' ? (
              <div className="voice-form">
                <div className="field">
                  <label>音色名称</label>
                  <input
                    className="input"
                    value={draft.name}
                    placeholder="例如：晨读 · 云端暖声"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label>TTS 服务地址（OpenAI 兼容）</label>
                  <input
                    className="input"
                    value={draft.baseUrl}
                    placeholder="https://api.openai.com/v1"
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  />
                  <div className="hint" style={{ marginTop: 4 }}>
                    也可填 <code>local://edge</code>（内置本地引擎）或 <code>http://127.0.0.1:5050/v1</code>（外部代理）
                  </div>
                </div>
                <div className="voice-form-row">
                  <div className="field">
                    <label>模型</label>
                    <input
                      className="input"
                      value={draft.model}
                      placeholder="gpt-4o-mini-tts"
                      onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>音色 ID</label>
                    <input
                      className="input"
                      value={draft.voiceId}
                      placeholder="nova / alloy / shimmer…"
                      onChange={(event) => setDraft({ ...draft, voiceId: event.target.value })}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>API Key（本机加密保存，界面只显示掩码）</label>
                  <input
                    className="input"
                    type="password"
                    value={draft.apiKey ?? ''}
                    placeholder="sk-…"
                    autoComplete="off"
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label>风格指令（可选，mini-tts 系列支持）</label>
                  <input
                    className="input"
                    value={draft.style}
                    placeholder="温暖、清晰、略慢，适合语言学习"
                    onChange={(event) => setDraft({ ...draft, style: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label>听感描述</label>
                  <input
                    className="input"
                    value={draft.persona}
                    placeholder="悦耳暖声 · 新闻主播气质"
                    onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
                  />
                </div>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={addCloud}>
                  添加云端音色
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/** 音色编辑：改名、调语速、换 Key、改风格 */
function VoiceEditor({
  item,
  busy,
  onCancel,
  onSave,
}: {
  item: VoiceItem;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Partial<VoiceDraft> & { clearKey?: boolean }) => void;
}) {
  const [name, setName] = useState(item.name);
  const [persona, setPersona] = useState(item.persona);
  const [rate, setRate] = useState(item.rate);
  const [style, setStyle] = useState(item.style);
  const [model, setModel] = useState(item.model);
  const [voiceId, setVoiceId] = useState(item.voiceId);
  const [baseUrl, setBaseUrl] = useState(item.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);

  return (
    <div className="voice-editor">
      <div className="voice-form-row">
        <div className="field">
          <label>名称</label>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label>语速（0.5–1.4）</label>
          <input
            className="input"
            type="number"
            step="0.02"
            min="0.5"
            max="1.4"
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
          />
        </div>
      </div>
      <div className="field">
        <label>听感描述</label>
        <input className="input" value={persona} onChange={(event) => setPersona(event.target.value)} />
      </div>
      {item.provider === 'cloud' ? (
        <>
          <div className="voice-form-row">
            <div className="field">
              <label>服务地址</label>
              <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </div>
            <div className="field">
              <label>模型 / 音色 ID</label>
              <div className="row" style={{ gap: 6 }}>
                <input className="input" value={model} onChange={(event) => setModel(event.target.value)} />
                <input className="input" value={voiceId} onChange={(event) => setVoiceId(event.target.value)} />
              </div>
            </div>
          </div>
          <div className="field">
            <label>风格指令</label>
            <input className="input" value={style} onChange={(event) => setStyle(event.target.value)} />
          </div>
          <div className="field">
            <label>更换 API Key（留空表示不修改；已配置 {item.maskedKey || '无'}）</label>
            <input
              className="input"
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder="sk-…"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          {item.hasKey ? (
            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />
              清空已保存的 Key
            </label>
          ) : null}
        </>
      ) : null}
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !name.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              persona,
              rate,
              style,
              ...(item.provider === 'cloud' ? { model, voiceId, baseUrl, ...(apiKey.trim() ? { apiKey } : {}) } : {}),
              ...(clearKey ? { clearKey: true } : {}),
            })
          }
        >
          保存
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
