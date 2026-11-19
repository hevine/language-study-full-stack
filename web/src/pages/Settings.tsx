import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import LanguageSwitch from '../components/LanguageSwitch';
import MaterialsCard from '../components/MaterialsCard';
import ExamImportCard from '../components/ExamImportCard';
import VoiceStudio from '../components/VoiceStudio';
import { Banner, Loading, SectionCard } from '../components/ui';
import Dropdown from '../components/Dropdown';
import { useApp } from '../store';
import { THEMES, themeById } from '../theme';
import type { LlmKeyStatus, LlmPoolKey, LlmProviderOption, SettingsResponse } from '../types';

type SettingsTab = 'model' | 'voice' | 'materials' | 'profile' | 'appearance' | 'privacy';

/** 设置页按功能分组：顺序即 tab 顺序，hint 显示在 tab 条下方 */
const TABS: Array<{ id: SettingsTab; label: string; hint: string }> = [
  {
    id: 'model',
    label: '模型线路',
    hint: '配置大模型 Key、轮换优先级与连接测试；某条失败会自动切到下一条。',
  },
  {
    id: 'voice',
    label: '音色与朗读',
    hint: '管理与试听音色，按语种隔离；单词、长难句、精读、听力可各用不同声音。',
  },
  {
    id: 'materials',
    label: '教材与真题',
    hint: '上传本机教材 PDF 与真题原卷，解析后进入内置题库。',
  },
  {
    id: 'profile',
    label: '个人与计划',
    hint: '修改称呼、查看当前学习计划，或重新生成 / 归档计划。',
  },
  {
    id: 'appearance',
    label: '外观与语种',
    hint: '切换学习语种与主题配色；每种语种可以保留自己的配色。',
  },
  {
    id: 'privacy',
    label: '隐私与数据',
    hint: 'Key 的加密方式、主密钥位置，以及本机数据库的存放说明。',
  },
];

const STATUS_TEXT: Record<LlmKeyStatus, string> = {
  ready: '可用',
  cooling: '冷却中',
  exhausted: '额度用尽',
  invalid: 'Key 失效',
  unset: '待填写',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

/** 冷却剩余时间用本地时钟算，服务端时间戳为基准 */
function cooldownText(key: LlmPoolKey, now: number): string {
  if (!key.cooldownUntil) return '';
  const seconds = Math.max(0, Math.ceil((Date.parse(key.cooldownUntil) - now) / 1000));
  if (seconds <= 0) return '即将恢复';
  if (seconds < 60) return `${seconds} 秒后恢复`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟后恢复`;
  const date = new Date(key.cooldownUntil);
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${hm} 恢复`;
}

export default function SettingsPage() {
  const { plan, reload, language, theme, setTheme, resetTheme, autoTheme } = useApp();
  const navigate = useNavigate();
  const currentTheme = themeById(theme);

  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [message, setMessage] = useState<{ tone: 'teal' | 'danger'; text: string; detail?: string } | null>(null);

  /* 功能分组：用 ?tab= 记住当前分组，刷新或分享链接都能直接落到同一组 */
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab: SettingsTab = TABS.some((item) => item.id === requestedTab)
    ? (requestedTab as SettingsTab)
    : 'model';
  // 访问过的分组保留挂载，来回切换不会丢掉表单草稿、上传列表与音色试听状态
  const [visited, setVisited] = useState<SettingsTab[]>([activeTab]);
  useEffect(() => {
    setVisited((prev) => (prev.includes(activeTab) ? prev : [...prev, activeTab]));
  }, [activeTab]);
  const activeMeta = TABS.find((item) => item.id === activeTab) ?? TABS[0];

  const selectTab = (id: SettingsTab) => {
    if (id === activeTab) return;
    // 先挂载再切，避免第一次进入某分组时出现一帧空白
    setVisited((prev) => (prev.includes(id) ? prev : [...prev, id]));
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
    setMessage(null);
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(index + offset + TABS.length) % TABS.length];
    selectTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

  /* 新增线路的表单 */
  const [adding, setAdding] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [persist, setPersist] = useState(true);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  /* 冷却倒计时每秒刷新一次 */
  const [now, setNow] = useState(Date.now());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKeyValue, setEditKeyValue] = useState('');

  const apply = (llm: SettingsResponse['llm']) => setSettings((prev) => (prev ? { ...prev, llm } : prev));

  useEffect(() => {
    api
      .settings()
      .then((response) => {
        setSettings(response);
        setDisplayName(response.profile.displayName);
      })
      .catch((err: Error) => setMessage({ tone: 'danger', text: err.message }));
  }, []);

  const keys = settings?.llm.keys ?? [];
  const cooling = keys.some((key) => key.status === 'cooling' || key.status === 'exhausted' || key.status === 'invalid');

  useEffect(() => {
    if (!cooling) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooling]);

  const providers = settings?.llm.providers ?? [];
  const activeProvider: LlmProviderOption | null = useMemo(
    () => providers.find((item) => item.id === providerId) ?? null,
    [providers, providerId],
  );

  const pickProvider = (provider: LlmProviderOption) => {
    setProviderId(provider.id);
    setBaseUrl(provider.baseUrl);
    setModel(provider.defaultModel);
    setRemoteModels([]);
    setMessage(null);
  };

  const refresh = async () => {
    const response = await api.settings();
    setSettings(response);
    return response;
  };

  const add = async () => {
    if (!baseUrl.trim() || !model.trim() || !apiKey.trim()) {
      setMessage({ tone: 'danger', text: 'Base URL、模型名、API Key 都要填。' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await api.addKey({
        providerId: providerId || undefined,
        label: keyLabel.trim() || undefined,
        baseUrl,
        model,
        apiKey,
        persist,
      });
      apply(result.llm);
      setApiKey('');
      setKeyLabel('');
      setAdding(false);
      setMessage({
        tone: 'teal',
        text: persist
          ? '线路已加入号池，Key 已加密写入本机数据库。'
          : '线路已加入，Key 只存在内存里 —— 下次重启需要重新填写。',
      });
      await reload().catch(() => undefined);
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    setMessage(null);
    try {
      const result = await api.llmModels({ baseUrl, apiKey: apiKey || undefined, providerId });
      setRemoteModels(result.models);
      setMessage({
        tone: 'teal',
        text:
          result.count > 0
            ? `拉取到 ${result.count} 个可用模型，从下面的下拉里挑一个。`
            : '平台返回了空列表，直接手填模型名即可。',
      });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setLoadingModels(false);
    }
  };

  const testDraft = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const result = await api.testLlm({ baseUrl, model, apiKey, providerId });
      setMessage({
        tone: result.ok ? 'teal' : 'danger',
        text: result.ok ? `连接成功，响应 ${result.latencyMs} ms。` : `连接失败：${result.message}`,
        detail: result.ok ? undefined : result.snippet,
      });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const testKey = async (key: LlmPoolKey) => {
    setBusyKey(key.id);
    setMessage(null);
    try {
      const result = await api.testKey(key.id);
      setMessage({
        tone: result.ok ? 'teal' : 'danger',
        text: result.ok
          ? `「${key.label}」连接成功，响应 ${result.latencyMs} ms。`
          : `「${key.label}」连接失败：${result.message}`,
        detail: result.ok ? undefined : result.snippet,
      });
      await refresh();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyKey(null);
    }
  };

  const toggleKey = async (key: LlmPoolKey) => {
    setBusyKey(key.id);
    try {
      const result = await api.updateKey(key.id, { enabled: !key.enabled });
      apply(result.llm);
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyKey(null);
    }
  };

  const resetKey = async (key: LlmPoolKey) => {
    setBusyKey(key.id);
    try {
      const result = await api.resetKey(key.id);
      apply(result.llm);
      setMessage({ tone: 'teal', text: `「${key.label}」已解除冷却，可以重新参与轮换。` });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyKey(null);
    }
  };

  const removeKey = async (key: LlmPoolKey) => {
    if (!window.confirm(`删除线路「${key.label}」？保存在本机的那份 Key 也会一起抹掉。`)) return;
    setBusyKey(key.id);
    try {
      const result = await api.deleteKey(key.id);
      apply(result.llm);
      setMessage({ tone: 'teal', text: '线路已删除。' });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyKey(null);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const ids = keys.filter((key) => key.source === 'db').map((key) => key.id);
    const currentId = keys[index]?.id;
    const target = ids.indexOf(currentId);
    const swapWith = target + direction;
    if (target < 0 || swapWith < 0 || swapWith >= ids.length) return;
    [ids[target], ids[swapWith]] = [ids[swapWith], ids[target]];
    try {
      const result = await api.reorderKeys(ids);
      apply(result.llm);
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    }
  };

  const replaceKey = async (key: LlmPoolKey) => {
    if (!editKeyValue.trim()) return;
    setBusyKey(key.id);
    try {
      const result = await api.updateKey(key.id, { apiKey: editKeyValue.trim() });
      apply(result.llm);
      setEditKeyValue('');
      setEditingId(null);
      setMessage({ tone: 'teal', text: `「${key.label}」的 Key 已更新并重新加密保存。` });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyKey(null);
    }
  };

  const saveProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await api.saveSettings({ displayName });
      setSettings(response);
      setMessage({ tone: 'teal', text: '称呼已保存。' });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!plan) return;
    if (!window.confirm('归档当前计划后，历史记录会保留，但今天的任务不再显示。确定继续？')) return;
    await api.archivePlan(plan.id);
    await reload();
    navigate('/setup');
  };

  if (!settings) return <Loading text="读取设置…" />;

  const { llm } = settings;
  const configured = llm.configured;
  const modelOptions = activeProvider?.models ?? [];
  const masterKeyHint =
    llm.storage.masterKeySource === 'env'
      ? '主密钥来自环境变量 LLM_MASTER_KEY（不落盘）'
      : llm.storage.masterKeySource === 'file'
        ? `主密钥在 ${llm.storage.masterKeyPath}（权限 600）`
        : `主密钥已生成到 ${llm.storage.masterKeyPath}（权限 600）`;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>设置</h1>
          <div className="page-sub">按功能分组切换：模型、音色、资料、计划、外观与隐私。数据只保存在本机。</div>
        </div>
        <span className={`chip ${configured ? 'chip-ok' : 'chip-gold'}`}>
          {configured
            ? `号池 ${llm.summary.ready}/${llm.summary.total} 可用${
                llm.summary.activeModel ? ` · ${llm.summary.activeModel}` : ''
              }`
            : '演示模式 · 内置题库'}
        </span>
      </div>

      {message ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone={message.tone}>
            {message.text}
            {message.detail ? <span className="banner-detail">平台原话：{message.detail}</span> : null}
          </Banner>
        </div>
      ) : null}

      <div className="settings-tabs" role="tablist" aria-label="设置功能分组">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            id={`settings-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-pane-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`settings-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            <span className="settings-tab-label">{tab.label}</span>
            {tab.id === 'model' && llm.summary.total > 0 ? (
              <span className="settings-tab-badge">{llm.summary.total}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="settings-context">
        <strong>{activeMeta.label}</strong>
        <span>{activeMeta.hint}</span>
      </div>

      {visited.includes('model') ? (
        <div
          className="settings-pane"
          id="settings-pane-model"
          role="tabpanel"
          aria-labelledby="settings-tab-model"
          hidden={activeTab !== 'model'}
        >
          <SectionCard
            title="模型 Key 池"
            extra={<span className="hint">从上到下依次尝试 · 失败自动切换</span>}
          >
            <div className="pool-bar">
              <span className={`chip ${llm.summary.ready > 0 ? 'chip-ok' : 'chip-gold'}`}>
                {llm.summary.ready} 条可用
              </span>
              <span className="chip">共 {llm.summary.total} 条</span>
              {llm.summary.cooling > 0 ? <span className="chip chip-gold">{llm.summary.cooling} 条冷却中</span> : null}
              <span className="hint">
                {llm.summary.activeLabel
                  ? `当前优先：${llm.summary.activeLabel} · ${llm.summary.activeModel ?? ''}`
                  : '当前没有可用线路，生成任务会回退到内置题库'}
              </span>
            </div>

            <div className="key-list">
              {keys.length === 0 ? (
                <div className="key-empty">
                  还没有任何线路。把一个免费平台的 Key 加进来，就能让每日材料由大模型实时生成。
                </div>
              ) : null}

              {keys.map((key, index) => {
                const isEnv = key.source === 'env';
                const busy = busyKey === key.id;
                return (
                  <div className={`key-row${key.enabled ? '' : ' is-off'}`} key={key.id}>
                    <div className="key-order">{index + 1}</div>
                    <div className="key-main">
                      <div className="key-title">
                        <span className="key-label">{key.label}</span>
                        <span className="key-provider">{key.providerName}</span>
                        <span className={`key-status is-${key.status}`}>
                          {STATUS_TEXT[key.status]}
                          {key.status !== 'ready' && key.status !== 'unset' && key.cooldownUntil
                            ? ` · ${cooldownText(key, now)}`
                            : ''}
                        </span>
                        {isEnv ? <span className="key-tag">环境变量 · 只读</span> : null}
                        {!key.persist && !isEnv ? <span className="key-tag">不落盘</span> : null}
                        {!key.enabled ? <span className="key-tag">已停用</span> : null}
                      </div>

                      <div className="key-meta">
                        <code>{key.model}</code>
                        <span className="key-mask">{key.maskedKey || '未填写 Key'}</span>
                        <span>{hostOf(key.baseUrl)}</span>
                        {key.successCount > 0 ? <span>成功 {key.successCount}</span> : null}
                        {key.failCount > 0 ? <span>失败 {key.failCount}</span> : null}
                      </div>

                      {key.lastError && key.status !== 'ready' ? <div className="key-error">{key.lastError}</div> : null}

                      {editingId === key.id ? (
                        <div className="key-edit">
                          <input
                            className="input"
                            type="password"
                            autoComplete="new-password"
                            spellCheck={false}
                            placeholder="粘贴新的 Key（不会显示出来）"
                            value={editKeyValue}
                            onChange={(event) => setEditKeyValue(event.target.value)}
                          />
                          <button className="btn btn-sm btn-primary" onClick={() => replaceKey(key)} disabled={busy}>
                            保存
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                              setEditingId(null);
                              setEditKeyValue('');
                            }}
                          >
                            取消
                          </button>
                        </div>
                      ) : null}

                      <div className="key-actions">
                        {!isEnv ? (
                          <>
                            <button
                              className="btn btn-xs"
                              title="上移"
                              disabled={index === 0}
                              onClick={() => move(index, -1)}
                            >
                              ↑
                            </button>
                            <button
                              className="btn btn-xs"
                              title="下移"
                              disabled={index === keys.length - 1}
                              onClick={() => move(index, 1)}
                            >
                              ↓
                            </button>
                          </>
                        ) : null}
                        <button className="btn btn-xs" onClick={() => testKey(key)} disabled={busy}>
                          {busy ? '…' : '测试'}
                        </button>
                        {!isEnv ? (
                          <>
                            <button className="btn btn-xs" onClick={() => setEditingId(key.id)}>
                              换 Key
                            </button>
                            <button className="btn btn-xs" onClick={() => resetKey(key)}>
                              恢复
                            </button>
                            <button className="btn btn-xs" onClick={() => toggleKey(key)}>
                              {key.enabled ? '停用' : '启用'}
                            </button>
                            <button className="btn btn-xs btn-danger-ghost" onClick={() => removeKey(key)}>
                              删除
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {!adding ? (
              <button
                className="btn btn-block"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setAdding(true);
                  setMessage(null);
                }}
              >
                + 添加一条线路
              </button>
            ) : (
              <div className="key-form">
                <div className="key-form-head">
                  <strong>新增线路</strong>
                  <button className="btn btn-xs btn-ghost" onClick={() => setAdding(false)}>
                    收起
                  </button>
                </div>

                <div className="provider-grid">
                  {providers.map((provider) => {
                    const hasFree = provider.models.some((item) => item.free);
                    return (
                      <button
                        key={provider.id}
                        className={`provider-card${providerId === provider.id ? ' active' : ''}`}
                        onClick={() => pickProvider(provider)}
                        title={provider.freeNote}
                      >
                        <span className="provider-name">{provider.name}</span>
                        <span className="provider-vendor">{provider.vendor}</span>
                        <span className={`provider-tag${hasFree ? ' is-free' : ''}`}>
                          {hasFree ? '免费档' : '自费'}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {activeProvider ? (
                  <div className="provider-note">
                    <span>{activeProvider.freeNote}</span>
                    {activeProvider.applyUrl ? (
                      <a href={activeProvider.applyUrl} target="_blank" rel="noreferrer">
                        {activeProvider.applyLabel} ↗
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <div className="provider-note">
                    <span>自建网关、one-api、Ollama 之类直接填下面的地址与模型名即可。</span>
                  </div>
                )}

                <div className="field">
                  <label>备注名</label>
                  <input
                    className="input"
                    placeholder="例如：智谱 主号 / 混元 备用"
                    value={keyLabel}
                    onChange={(event) => setKeyLabel(event.target.value)}
                  />
                  <div className="hint">只用来区分，可以留空。</div>
                </div>

                <div className="field">
                  <label>Base URL</label>
                  <input
                    className="input"
                    placeholder="https://open.bigmodel.cn/api/paas/v4"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                  <div className="hint">末尾不要带 /chat/completions，系统会自动拼接。</div>
                </div>

                <div className="field">
                  <label>模型名</label>
                  <div className="model-row">
                    <input
                      className="input"
                      list="llm-model-options"
                      placeholder={activeProvider?.defaultModel || 'glm-4.7-flash'}
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                    />
                    <button className="btn btn-sm" onClick={fetchModels} disabled={loadingModels}>
                      {loadingModels ? '拉取中…' : '拉取列表'}
                    </button>
                  </div>
                  <datalist id="llm-model-options">
                    {[...new Set([...remoteModels, ...modelOptions.map((item) => item.id)])].map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>

                  {modelOptions.length > 0 ? (
                    <div className="model-chips">
                      {modelOptions.map((option) => (
                        <button
                          key={option.id}
                          className={`btn btn-sm${model === option.id ? ' btn-selected' : ''}`}
                          onClick={() => setModel(option.id)}
                          title={option.note}
                        >
                          {option.label}
                          {option.free ? <span className="model-free">免费</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {remoteModels.length > 0 ? (
                    <Dropdown
                      block
                      value=""
                      placeholder={`服务端返回了 ${remoteModels.length} 个模型，点这里挑…`}
                      options={remoteModels.map((id) => ({ value: id, label: id }))}
                      onChange={(id) => {
                        if (id) setModel(id);
                      }}
                    />
                  ) : null}

                  <div className="hint">
                    {activeProvider?.keyHint ??
                      '模型名按平台文档填写；魔搭要用「模型 ID」，形如 Qwen/Qwen3-8B-Instruct。'}
                  </div>
                </div>

                <div className="field">
                  <label>API Key</label>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder="sk-..."
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <label className="check">
                    <input type="checkbox" checked={!persist} onChange={(event) => setPersist(!event.target.checked)} />
                    <span>
                      只存在内存，不写入磁盘
                      <span className="hint"> · 勾选后重启需要重填，适合临时借用别人的额度</span>
                    </span>
                  </label>
                </div>

                <div className="row">
                  <button className="btn btn-primary" onClick={add} disabled={saving}>
                    {saving ? '加密保存中…' : '加入号池'}
                  </button>
                  <button className="btn" onClick={testDraft} disabled={testing}>
                    {testing ? '测试中…' : '先测一下'}
                  </button>
                  <span className="hint">保存后立刻参与轮换，排在队尾。</span>
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {visited.includes('voice') ? (
        <div
          className="settings-pane"
          id="settings-pane-voice"
          role="tabpanel"
          aria-labelledby="settings-tab-voice"
          hidden={activeTab !== 'voice'}
        >
          <VoiceStudio />
        </div>
      ) : null}

      {visited.includes('materials') ? (
        <div
          className="settings-pane is-paired"
          id="settings-pane-materials"
          role="tabpanel"
          aria-labelledby="settings-tab-materials"
          hidden={activeTab !== 'materials'}
        >
          <SectionCard title="我的教材" extra={<span className="hint">本地上传 · 只存在这台机器</span>}>
            <MaterialsCard language={language} />
          </SectionCard>
          <SectionCard
            title="真题导入"
            extra={<span className="hint">导入你自己的原卷 · 解析后进「升级自测」</span>}
          >
            <ExamImportCard language={language} />
          </SectionCard>
        </div>
      ) : null}

      {visited.includes('profile') ? (
        <div
          className="settings-pane is-paired"
          id="settings-pane-profile"
          role="tabpanel"
          aria-labelledby="settings-tab-profile"
          hidden={activeTab !== 'profile'}
        >
          <SectionCard title="个人信息">
            <div className="field">
              <label>称呼</label>
              <input
                className="input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="怎么称呼你"
              />
            </div>
            <button className="btn" onClick={saveProfile} disabled={saving}>
              保存
            </button>
          </SectionCard>
          <SectionCard title="当前计划">
            {plan ? (
              <>
                <div className="row" style={{ justifyContent: 'space-between', padding: '5px 0' }}>
                  <span className="small muted">考试</span>
                  <span className="small">{plan.examName}</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', padding: '5px 0' }}>
                  <span className="small muted">目标</span>
                  <span className="small">{plan.targetLabel}</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', padding: '5px 0' }}>
                  <span className="small muted">周期</span>
                  <span className="small">
                    {plan.startDate} → {plan.examDate}
                  </span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', padding: '5px 0' }}>
                  <span className="small muted">每日时长</span>
                  <span className="small">{plan.dailyMinutes} 分钟</span>
                </div>
                <hr className="divider" />
                <button className="btn btn-block" onClick={() => navigate('/setup')}>
                  修改目标 / 重新生成计划
                </button>
                <button className="btn btn-block btn-ghost" style={{ marginTop: 8 }} onClick={archive}>
                  归档当前计划
                </button>
              </>
            ) : (
              <button className="btn btn-primary btn-block" onClick={() => navigate('/setup')}>
                去创建计划
              </button>
            )}
          </SectionCard>
        </div>
      ) : null}

      {visited.includes('appearance') ? (
        <div
          className="settings-pane is-narrow"
          id="settings-pane-appearance"
          role="tabpanel"
          aria-labelledby="settings-tab-appearance"
          hidden={activeTab !== 'appearance'}
        >
          <SectionCard
            title="外观与语种"
            extra={<span className="hint">{autoTheme ? '按语种自动配色' : '自定义配色'}</span>}
          >
            <div className="field">
              <label>学习语种</label>
              <LanguageSwitch compact />
              <div className="hint">切换后会自动启用该语种的计划；没有计划则先引导你去定目标。</div>
            </div>

            <div className="field">
              <label>主题配色 · Apple 系统色</label>
              <div className="theme-dots" style={{ gap: 10 }}>
                {THEMES.map((item) => (
                  <button
                    key={item.id}
                    className={`theme-dot${theme === item.id ? ' active' : ''}`}
                    style={{ background: item.swatch, width: 24, height: 24 }}
                    onClick={() => setTheme(item.id)}
                    title={`${item.name}（${item.en}）· ${item.hint}`}
                    aria-label={item.name}
                  />
                ))}
              </div>
              <div className="hint">
                {currentTheme.name}（{currentTheme.en}）· {currentTheme.hint}
              </div>
            </div>

            <button className="btn btn-sm btn-ghost" onClick={resetTheme} disabled={autoTheme}>
              恢复按语种自动配色
            </button>
            <div className="hint" style={{ marginTop: 8 }}>
              当前语种：{language === 'ja' ? '日语（默认樱花粉）' : language === 'ko' ? '韩语（默认青瓷）' : '英语（默认海湾蓝）'}。手动选择只影响当前语种，切回另一种语言仍用它自己的配色。
            </div>
          </SectionCard>
        </div>
      ) : null}

      {visited.includes('privacy') ? (
        <div
          className="settings-pane is-paired"
          id="settings-pane-privacy"
          role="tabpanel"
          aria-labelledby="settings-tab-privacy"
          hidden={activeTab !== 'privacy'}
        >
          <SectionCard title="密钥与隐私" extra={<span className="hint">{llm.storage.algorithm}</span>}>
            <ul className="privacy-list">
              <li>
                Key 加密后才写盘：<strong>{llm.storage.algorithm}</strong>，{masterKeyHint}。
              </li>
              <li>界面永远拿不到明文：接口只返回 {llm.apiKeyMasked || '掩码'} 这类遮罩值。</li>
              <li>勾了「只存在内存」的线路不写磁盘，进程一停就没了。</li>
              <li>日志与报错会自动抹掉 sk-xxx、Bearer xxx 这类片段。</li>
              <li>把 .data 整个拷走也解不开 —— 没有主密钥就只有密文。</li>
              <li>数据目录 {llm.storage.dataDir} 权限 700，数据库文件 600。</li>
            </ul>
            <hr className="divider" />
            <p className="small muted" style={{ lineHeight: 1.8 }}>
              最彻底的做法：把 Key 写进 <code>.env</code> 的 <code>LLM_API_KEY</code>，界面里一条都不存；它会作为「环境变量」
              线路排在队尾，且不会出现在任何接口返回里。
              {llm.storage.envKeyActive ? ' 当前已检测到环境变量 Key。' : ''}
            </p>
          </SectionCard>
          <SectionCard title="关于数据">
            <p className="small muted" style={{ lineHeight: 1.85 }}>
              计划、每日材料、词汇与学习记录都保存在本机 <code>{llm.storage.dbFile}</code>（SQLite）。
              删除该文件即清空全部数据；备份也只需复制它。
            </p>
            <hr className="divider" />
            <p className="small muted" style={{ lineHeight: 1.85 }}>
              每日的「精读 / 朗读」材料来源有两种：号池里任一条线路可用时按当日主题与考纲实时生成；全部不可用时使用内置考纲题库（内容固定，但流程完整）。
            </p>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
