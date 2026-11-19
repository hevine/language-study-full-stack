/**
 * 模型 Key 号池。
 *
 * 一条「线路」= 一个平台 + 一把 Key + 一个模型。多个线路按 priority 从上到下排队，
 * 调用时先试第一条，遇到「额度用尽 / 限流 / Key 失效 / 连不上」就自动换下一条，
 * 并给失败的线路挂一个冷却时间，冷却期内不再浪费请求。
 *
 * 所有 Key 都以 AES-256-GCM 密文落库；persist=0 的线路只留在内存里，重启即消失。
 */
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { providerById, providerForBaseUrl } from '../content/llmProviders';
import { db } from '../db';
import { logger } from '../lib/logger';
import { fingerprintSecret, maskSecret, openSecret, sealSecret } from '../lib/secret';
import { getSetting, setSetting } from '../repositories/misc';

/**
 * 模型 Key 池是「系统级配置」，刻意不随登录账号隔离：
 * 管理员在设置页配的线路要能被所有登录用户用来生成每日材料，
 * 否则新扫码进来的账号会直接掉回演示模式。
 * 备考数据（计划 / 词汇 / 作答 / 批改 / 音色 …）才按 currentUserId() 分账号。
 */
const LOCAL_USER = 'local';

export type KeyStatus = 'ready' | 'cooling' | 'exhausted' | 'invalid' | 'unset';

export interface PoolKeyView {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  baseUrl: string;
  model: string;
  maskedKey: string;
  fingerprint: string;
  persist: boolean;
  enabled: boolean;
  priority: number;
  status: KeyStatus;
  cooldownUntil: string | null;
  cooldownSeconds: number;
  failCount: number;
  successCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastUsedAt: string | null;
  needsKey: boolean;
  source: 'db' | 'env';
  jsonMode: boolean;
}

export interface PoolCandidate {
  keyId: string | null;
  label: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
  timeoutMs: number;
  source: 'db' | 'env';
}

export interface PoolSummary {
  total: number;
  enabled: number;
  ready: number;
  cooling: number;
  needsKey: number;
  activeLabel: string | null;
  activeModel: string | null;
}

interface KeyRow {
  id: string;
  provider_id: string;
  label: string;
  base_url: string;
  model: string;
  key_cipher: string;
  key_masked: string;
  key_fingerprint: string;
  persist: number;
  enabled: number;
  priority: number;
  status: string;
  cooldown_until: string | null;
  fail_count: number;
  success_count: number;
  last_error: string | null;
  last_error_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** persist=0 的线路：Key 只在这次运行里存在 */
const memorySecrets = new Map<string, string>();

export const ENV_KEY_ID = 'env';

function nowIso(): string {
  return new Date().toISOString();
}

function nextLocalMidnight(): string {
  const date = new Date();
  date.setHours(24, 0, 0, 120);
  return date.toISOString();
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  const diff = Date.parse(iso) - Date.now();
  return diff > 0 ? Math.ceil(diff / 1000) : 0;
}

function providerInfo(baseUrl: string, providerId: string) {
  const provider = providerById(providerId) ?? providerForBaseUrl(baseUrl);
  return {
    providerId: provider?.id ?? (providerId || 'custom'),
    providerName: provider?.name ?? '自定义接口',
    jsonMode: provider ? provider.jsonMode : true,
  };
}

/** 数据库里的 status 可能已经过期（冷却结束），这里按时间算真实状态 */
function effectiveStatus(row: KeyRow, hasSecret: boolean): KeyStatus {
  if (!hasSecret) return 'unset';
  if (row.status === 'invalid') {
    return secondsUntil(row.cooldown_until) > 0 ? 'invalid' : 'ready';
  }
  if (row.status === 'cooling' || row.status === 'exhausted') {
    return secondsUntil(row.cooldown_until) > 0 ? (row.status as KeyStatus) : 'ready';
  }
  return 'ready';
}

function secretOf(row: KeyRow): string {
  if (!row.persist) return memorySecrets.get(row.id) ?? '';
  if (!row.key_cipher) return '';
  try {
    return openSecret(row.key_cipher);
  } catch (err) {
    logger.warn('无法解密号池里的 Key', { id: row.id, message: (err as Error).message });
    return '';
  }
}

function toView(row: KeyRow): PoolKeyView {
  const secret = secretOf(row);
  const info = providerInfo(row.base_url, row.provider_id);
  const status = effectiveStatus(row, Boolean(secret));
  return {
    id: row.id,
    providerId: info.providerId,
    providerName: info.providerName,
    label: row.label,
    baseUrl: row.base_url,
    model: row.model,
    maskedKey: row.key_masked || maskSecret(secret),
    fingerprint: row.key_fingerprint,
    persist: Boolean(row.persist),
    enabled: Boolean(row.enabled),
    priority: row.priority,
    status,
    cooldownUntil: row.cooldown_until,
    cooldownSeconds: status === 'cooling' || status === 'exhausted' || status === 'invalid' ? secondsUntil(row.cooldown_until) : 0,
    failCount: row.fail_count,
    successCount: row.success_count,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastUsedAt: row.last_used_at,
    needsKey: status === 'unset',
    source: 'db',
    jsonMode: info.jsonMode,
  };
}

function allRows(): KeyRow[] {
  return db
    .prepare(
      `SELECT * FROM llm_keys WHERE user_id = ?
       ORDER BY priority ASC, created_at ASC`,
    )
    .all(LOCAL_USER) as KeyRow[];
}

/** 环境变量里的 Key 不写库，只作为最后一条只读线路参与轮换 */
function envCandidate(): PoolCandidate | null {
  const apiKey = env.llm.apiKey.trim();
  const baseUrl = env.llm.baseUrl.trim();
  const model = env.llm.model.trim();
  if (!apiKey || !baseUrl || !model) return null;
  const info = providerInfo(baseUrl, 'custom');
  return {
    keyId: null,
    label: '环境变量 Key',
    providerId: info.providerId,
    baseUrl,
    apiKey,
    model,
    jsonMode: info.jsonMode,
    timeoutMs: env.llm.timeoutMs,
    source: 'env',
  };
}

export function hasEnvKey(): boolean {
  return envCandidate() !== null;
}

export function listPoolKeys(): PoolKeyView[] {
  const views = allRows().map(toView);
  const envKey = envCandidate();
  if (envKey) {
    views.push({
      id: ENV_KEY_ID,
      providerId: envKey.providerId,
      providerName: `${providerInfo(envKey.baseUrl, envKey.providerId).providerName} · 环境变量`,
      label: envKey.label,
      baseUrl: envKey.baseUrl,
      model: envKey.model,
      maskedKey: maskSecret(envKey.apiKey),
      fingerprint: fingerprintSecret(envKey.apiKey),
      persist: false,
      enabled: true,
      priority: 9999,
      status: 'ready',
      cooldownUntil: null,
      cooldownSeconds: 0,
      failCount: 0,
      successCount: 0,
      lastError: null,
      lastErrorAt: null,
      lastUsedAt: null,
      needsKey: false,
      source: 'env',
      jsonMode: envKey.jsonMode,
    });
  }
  return views;
}

/** 按优先级取出此刻可用的线路，Key 已解密，供调用层直接使用 */
export function poolCandidates(): PoolCandidate[] {
  const candidates: PoolCandidate[] = [];

  for (const row of allRows()) {
    if (!row.enabled) continue;
    const secret = secretOf(row);
    if (!secret) continue;
    if (effectiveStatus(row, true) !== 'ready') continue;
    const info = providerInfo(row.base_url, row.provider_id);
    candidates.push({
      keyId: row.id,
      label: row.label,
      providerId: info.providerId,
      baseUrl: row.base_url,
      apiKey: secret,
      model: row.model,
      jsonMode: info.jsonMode,
      timeoutMs: env.llm.timeoutMs,
      source: 'db',
    });
  }

  const envKey = envCandidate();
  if (envKey) candidates.push(envKey);

  return candidates;
}

/** 按 id 取一条线路的明文配置（测试连接、拉模型列表时用，不受冷却影响） */
export function candidateById(id: string): PoolCandidate | null {
  if (id === ENV_KEY_ID) return envCandidate();
  const row = db.prepare('SELECT * FROM llm_keys WHERE id = ? AND user_id = ?').get(id, LOCAL_USER) as
    | KeyRow
    | undefined;
  if (!row) return null;
  const secret = secretOf(row);
  if (!secret) return null;
  const info = providerInfo(row.base_url, row.provider_id);
  return {
    keyId: row.id,
    label: row.label,
    providerId: info.providerId,
    baseUrl: row.base_url,
    apiKey: secret,
    model: row.model,
    jsonMode: info.jsonMode,
    timeoutMs: env.llm.timeoutMs,
    source: 'db',
  };
}

export function poolSummary(): PoolSummary {
  const views = listPoolKeys();
  const ready = views.filter((view) => view.enabled && view.status === 'ready');
  return {
    total: views.length,
    enabled: views.filter((view) => view.enabled).length,
    ready: ready.length,
    cooling: views.filter((view) => view.status === 'cooling' || view.status === 'exhausted').length,
    needsKey: views.filter((view) => view.needsKey).length,
    activeLabel: ready[0]?.label ?? null,
    activeModel: ready[0]?.model ?? null,
  };
}

export interface AddKeyInput {
  providerId?: string;
  label?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  persist?: boolean;
  enabled?: boolean;
  priority?: number;
}

export function addPoolKey(input: AddKeyInput): PoolKeyView {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const model = input.model.trim();
  const apiKey = input.apiKey.trim();
  if (!baseUrl) throw new Error('请填写 Base URL');
  if (!model) throw new Error('请填写模型名');
  if (!apiKey) throw new Error('请填写 API Key');

  const info = providerInfo(baseUrl, input.providerId ?? 'custom');
  const persist = input.persist !== false;
  const id = randomUUID();
  const now = nowIso();
  const maxPriority =
    (db.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM llm_keys WHERE user_id = ?').get(LOCAL_USER) as {
      p: number;
    }).p ?? 0;

  if (!persist) memorySecrets.set(id, apiKey);

  db.prepare(
    `INSERT INTO llm_keys
      (id, user_id, provider_id, label, base_url, model, key_cipher, key_masked, key_fingerprint,
       persist, enabled, priority, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
  ).run(
    id,
    LOCAL_USER,
    info.providerId,
    (input.label ?? '').trim() || `${info.providerName} ${model}`.slice(0, 40),
    baseUrl,
    model,
    persist ? sealSecret(apiKey) : '',
    maskSecret(apiKey),
    fingerprintSecret(apiKey),
    persist ? 1 : 0,
    input.enabled === false ? 0 : 1,
    input.priority ?? maxPriority + 10,
    now,
    now,
  );

  return toView(db.prepare('SELECT * FROM llm_keys WHERE id = ?').get(id) as KeyRow);
}

export interface UpdateKeyInput {
  providerId?: string;
  label?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  persist?: boolean;
  enabled?: boolean;
  priority?: number;
}

export function updatePoolKey(id: string, patch: UpdateKeyInput): PoolKeyView {
  const row = db.prepare('SELECT * FROM llm_keys WHERE id = ? AND user_id = ?').get(id, LOCAL_USER) as
    | KeyRow
    | undefined;
  if (!row) throw new Error('这条线路不存在');

  const baseUrl = patch.baseUrl !== undefined ? patch.baseUrl.trim().replace(/\/+$/, '') : row.base_url;
  const model = patch.model !== undefined ? patch.model.trim() : row.model;
  const apiKey = patch.apiKey?.trim();
  const persist = patch.persist !== undefined ? patch.persist : Boolean(row.persist);

  let cipher = row.key_cipher;
  let masked = row.key_masked;
  let fingerprint = row.key_fingerprint;

  if (apiKey) {
    masked = maskSecret(apiKey);
    fingerprint = fingerprintSecret(apiKey);
    cipher = persist ? sealSecret(apiKey) : '';
    if (!persist) memorySecrets.set(id, apiKey);
  } else if (patch.persist !== undefined && patch.persist !== Boolean(row.persist)) {
    // 存储方式切换：明文只在当前进程里出现过，切换时把已有的拿回来重新处理
    const secret = secretOf(row);
    if (!secret) throw new Error('这条线路还没有可用的 Key，请重新填写');
    cipher = persist ? sealSecret(secret) : '';
    if (!persist) memorySecrets.set(id, secret);
  }

  const info = providerInfo(baseUrl, patch.providerId ?? row.provider_id);

  db.prepare(
    `UPDATE llm_keys SET provider_id = ?, label = ?, base_url = ?, model = ?, key_cipher = ?,
       key_masked = ?, key_fingerprint = ?, persist = ?, enabled = ?, priority = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    info.providerId,
    patch.label !== undefined ? patch.label.trim().slice(0, 60) || row.label : row.label,
    baseUrl,
    model,
    cipher,
    masked,
    fingerprint,
    persist ? 1 : 0,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
    patch.priority ?? row.priority,
    nowIso(),
    id,
    LOCAL_USER,
  );

  return toView(db.prepare('SELECT * FROM llm_keys WHERE id = ?').get(id) as KeyRow);
}

export function deletePoolKey(id: string): boolean {
  memorySecrets.delete(id);
  const result = db.prepare('DELETE FROM llm_keys WHERE id = ? AND user_id = ?').run(id, LOCAL_USER);
  return result.changes > 0;
}

/** 手动「恢复」：清掉冷却与错误记录，立刻重新可用 */
export function resetPoolKey(id: string): void {
  db.prepare(
    `UPDATE llm_keys SET status = 'ready', cooldown_until = NULL, fail_count = 0,
       last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(nowIso(), id, LOCAL_USER);
}

export function reorderPoolKeys(ids: string[]): void {
  const update = db.prepare('UPDATE llm_keys SET priority = ?, updated_at = ? WHERE id = ? AND user_id = ?');
  const now = nowIso();
  const apply = db.transaction(() => {
    ids.forEach((id, index) => update.run((index + 1) * 10, now, id, LOCAL_USER));
  });
  apply();
}

export type FailureKind = 'invalid' | 'quota' | 'rate' | 'transient' | 'model' | 'client';

export interface FailureInfo {
  kind: FailureKind;
  /** 是否值得换下一条线路 */
  switchable: boolean;
  cooldownMs: number;
  message: string;
}

/**
 * 只认「额度」本身的词。别把「限制 / exceeded」这类泛词算进来——
 * 平台常说「并发数超过限制」，那是限流，不是额度用光，误判会让用户以为没钱了。
 */
const QUOTA_PATTERN = /(quota|insufficient|billing|arrears|credit|额度|余额|配额|欠费|用尽)/i;

/** 把上游的 HTTP 状态 + 报错体翻译成「要不要换线、冷却多久」 */
export function classifyLlmFailure(status: number, body: string): FailureInfo {
  const text = (body ?? '').slice(0, 2000);
  const quotaish = QUOTA_PATTERN.test(text);
  const modelish = /(model|模型)/i.test(text);

  if (status === 401) {
    return { kind: 'invalid', switchable: true, cooldownMs: 24 * 3600_000, message: 'Key 无效或已被删除（401）' };
  }
  if (status === 402) {
    return { kind: 'quota', switchable: true, cooldownMs: Math.max(60_000, Date.parse(nextLocalMidnight()) - Date.now()), message: '账户余额不足（402）' };
  }
  if (status === 403) {
    return quotaish
      ? { kind: 'quota', switchable: true, cooldownMs: Math.max(60_000, Date.parse(nextLocalMidnight()) - Date.now()), message: '额度用尽或账号被限制（403）' }
      : { kind: 'invalid', switchable: true, cooldownMs: 6 * 3600_000, message: 'Key 没有该模型的权限（403）' };
  }
  if (status === 404) {
    return { kind: 'model', switchable: true, cooldownMs: 2 * 3600_000, message: '该线路的模型名或地址不可用（404）' };
  }
  if (status === 400) {
    return modelish
      ? { kind: 'model', switchable: true, cooldownMs: 3600_000, message: '模型名不被这个平台接受（400）' }
      : { kind: 'client', switchable: false, cooldownMs: 60_000, message: '请求参数被平台拒绝（400）' };
  }
  if (status === 429) {
    if (quotaish) {
      return {
        kind: 'quota',
        switchable: true,
        cooldownMs: Math.max(60_000, Date.parse(nextLocalMidnight()) - Date.now()),
        message: '免费额度已用尽（429）',
      };
    }
    // 智谱等平台的免费模型常按「并发数」限流，和「额度」是两件事：等几秒就能过
    const concurrent = /(concurren|并发|parallel)/i.test(text);
    const frequent = /(频繁|frequent|too many|throttl|qps|rpm|tpm)/i.test(text);
    const busy = /(访问量|繁忙|busy|overload|too\s+many\s+visitors)/i.test(text);
    return {
      kind: 'rate',
      switchable: true,
      cooldownMs: 20_000,
      message: concurrent
        ? '并发超限（429）：同一 Key 同时请求太多，稍等几秒'
        : frequent
          ? '请求过于频繁（429）：免费档有频率限制，稍等几秒'
          : busy
            ? '平台当前繁忙（429）：该模型排队的人多，稍后或换一条线路'
            : '触发限流（429）：稍等几秒再试',
    };
  }
  if (status >= 500) {
    return { kind: 'transient', switchable: true, cooldownMs: 60_000, message: `平台服务异常（${status}）` };
  }
  return { kind: 'client', switchable: true, cooldownMs: 30_000, message: `接口返回 ${status}` };
}

export function markPoolSuccess(id: string | null): void {
  if (!id) return;
  const now = nowIso();
  db.prepare(
    `UPDATE llm_keys SET status = 'ready', cooldown_until = NULL, fail_count = 0,
       success_count = success_count + 1, last_used_at = ?, last_error = NULL, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(now, now, id, LOCAL_USER);
}

export function markPoolFailure(id: string | null, info: FailureInfo): void {
  if (!id) return;
  const now = nowIso();
  const status: KeyStatus =
    info.kind === 'invalid' ? 'invalid' : info.kind === 'quota' ? 'exhausted' : 'cooling';
  const cooldownUntil = new Date(Date.now() + info.cooldownMs).toISOString();
  db.prepare(
    `UPDATE llm_keys SET status = ?, cooldown_until = ?, fail_count = fail_count + 1,
       last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(status, cooldownUntil, info.message.slice(0, 300), now, now, id, LOCAL_USER);
}

/**
 * 旧版本把 Key 明文存在 settings 表里。启动时搬进号池并清空原值，
 * 顺便 VACUUM 一次，把旧页里的明文真正覆盖掉。
 */
export function migrateLegacyKeys(): void {
  const legacyKey = (getSetting('llm.apiKey') ?? '').trim();
  if (!legacyKey) return;

  const baseUrl = (getSetting('llm.baseUrl') ?? '').trim().replace(/\/+$/, '');
  const model = (getSetting('llm.model') ?? '').trim();
  const providerId = (getSetting('llm.provider') ?? '').trim() || 'custom';

  if (!baseUrl || !model) {
    // 信息不全，先不搬；但仍把明文清掉，避免继续躺在库里
    setSetting('llm.apiKey', '');
    logger.warn('旧 Key 缺少 Base URL / 模型名，已从 settings 清除，请到设置页重新添加线路');
    return;
  }

  const fingerprint = fingerprintSecret(legacyKey);
  const duplicated = allRows().some((row) => row.key_fingerprint === fingerprint);
  if (!duplicated) {
    addPoolKey({ providerId, baseUrl, model, apiKey: legacyKey, label: '旧配置迁移' });
  }
  setSetting('llm.apiKey', '');

  try {
    db.exec('VACUUM');
  } catch {
    /* 有并发连接时可能失败，忽略 */
  }
  logger.info('旧版明文 Key 已加密迁移到号池', { duplicated });
}
