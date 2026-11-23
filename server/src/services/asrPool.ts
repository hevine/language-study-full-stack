/**
 * 语音识别号池。
 *
 * 与模型 Key 号池（keyPool.ts）同构：一条「线路」= 一个转录服务地址 + 一把 Key + 一个模型。
 * 多条线路按 priority 从上到下排队，转写时依次尝试：
 *   连不上 / Key 失效 / 额度用尽 / 模型不存在 → 标记该线路并挂冷却，自动换下一条；
 *   全部失败才把最后一错误抛给用户。
 *
 * Key 一律 AES-256-GCM 密文落库；persist=0 的线路只留内存、重启即消失。
 * 号池是系统级配置（不按登录账号隔离），所有用户共享同一批识别线路。
 */
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { db } from '../db';
import { logger } from '../lib/logger';
import { fingerprintSecret, maskSecret, openSecret, sealSecret } from '../lib/secret';
import { getSetting, setSetting } from '../repositories/misc';
import { classifyLlmFailure, type FailureInfo as AsrFailureInfo } from './keyPool';

const LOCAL_USER = 'local';

export type AsrKeyStatus = 'ready' | 'cooling' | 'exhausted' | 'invalid' | 'unset';

export interface AsrPoolKeyView {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  maskedKey: string;
  fingerprint: string;
  persist: boolean;
  enabled: boolean;
  priority: number;
  status: AsrKeyStatus;
  cooldownUntil: string | null;
  cooldownSeconds: number;
  failCount: number;
  successCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastUsedAt: string | null;
  needsKey: boolean;
  source: 'db' | 'env';
}

export interface AsrCandidate {
  keyId: string | null;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  source: 'db' | 'env';
}

export interface AsrPoolSummary {
  total: number;
  enabled: number;
  ready: number;
  cooling: number;
  needsKey: number;
  activeLabel: string | null;
  activeModel: string | null;
}

interface AsrKeyRow {
  id: string;
  user_id: string;
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

export const ENV_ASR_ID = 'env';

function nowIso(): string {
  return new Date().toISOString();
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  const diff = Date.parse(iso) - Date.now();
  return diff > 0 ? Math.ceil(diff / 1000) : 0;
}

function effectiveStatus(row: AsrKeyRow, hasSecret: boolean): AsrKeyStatus {
  if (!hasSecret) return 'unset';
  if (row.status === 'invalid' || row.status === 'cooling' || row.status === 'exhausted') {
    return secondsUntil(row.cooldown_until) > 0 ? (row.status as AsrKeyStatus) : 'ready';
  }
  return 'ready';
}

function secretOf(row: AsrKeyRow): string {
  if (!row.persist) return memorySecrets.get(row.id) ?? '';
  if (!row.key_cipher) return '';
  try {
    return openSecret(row.key_cipher);
  } catch (err) {
    logger.warn('无法解密 ASR 号池里的 Key', { id: row.id, message: (err as Error).message });
    return '';
  }
}

function toView(row: AsrKeyRow): AsrPoolKeyView {
  const secret = secretOf(row);
  const status = effectiveStatus(row, Boolean(secret));
  return {
    id: row.id,
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
    cooldownSeconds:
      status === 'cooling' || status === 'exhausted' || status === 'invalid' ? secondsUntil(row.cooldown_until) : 0,
    failCount: row.fail_count,
    successCount: row.success_count,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastUsedAt: row.last_used_at,
    needsKey: status === 'unset',
    source: 'db',
  };
}

function allRows(): AsrKeyRow[] {
  return db
    .prepare(
      `SELECT * FROM asr_keys WHERE user_id = ?
       ORDER BY priority ASC, created_at ASC`,
    )
    .all(LOCAL_USER) as AsrKeyRow[];
}

/** 环境变量线路：不写库，作为最后一条只读线路参与轮换 */
function envCandidate(): AsrCandidate | null {
  const apiKey = env.asr.apiKey.trim();
  const baseUrl = env.asr.baseUrl.trim();
  const model = env.asr.model.trim();
  if (!apiKey || !baseUrl) return null;
  return {
    keyId: null,
    label: '环境变量线路',
    baseUrl,
    apiKey,
    model: model || 'whisper-1',
    timeoutMs: env.asr.timeoutMs,
    source: 'env',
  };
}

export function hasEnvAsr(): boolean {
  return envCandidate() !== null;
}

export function listAsrPoolKeys(): AsrPoolKeyView[] {
  const views = allRows().map(toView);
  const line = envCandidate();
  if (line) {
    views.push({
      id: ENV_ASR_ID,
      label: line.label,
      baseUrl: line.baseUrl,
      model: line.model,
      maskedKey: maskSecret(line.apiKey),
      fingerprint: fingerprintSecret(line.apiKey),
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
    });
  }
  return views;
}

/** 按优先级取出此刻可用的线路，Key 已解密 */
export function asrPoolCandidates(): AsrCandidate[] {
  const candidates: AsrCandidate[] = [];
  for (const row of allRows()) {
    if (!row.enabled) continue;
    const secret = secretOf(row);
    if (!secret) continue;
    if (effectiveStatus(row, true) !== 'ready') continue;
    candidates.push({
      keyId: row.id,
      label: row.label,
      baseUrl: row.base_url,
      apiKey: secret,
      model: row.model,
      timeoutMs: env.asr.timeoutMs,
      source: 'db',
    });
  }
  const line = envCandidate();
  if (line) candidates.push(line);
  return candidates;
}

/** 按 id 取一条线路的明文配置（测试用，不受冷却影响） */
export function asrCandidateById(id: string): AsrCandidate | null {
  if (id === ENV_ASR_ID) return envCandidate();
  const row = db.prepare('SELECT * FROM asr_keys WHERE id = ? AND user_id = ?').get(id, LOCAL_USER) as
    | AsrKeyRow
    | undefined;
  if (!row) return null;
  const secret = secretOf(row);
  if (!secret) return null;
  return {
    keyId: row.id,
    label: row.label,
    baseUrl: row.base_url,
    apiKey: secret,
    model: row.model,
    timeoutMs: env.asr.timeoutMs,
    source: 'db',
  };
}

export function asrPoolSummary(): AsrPoolSummary {
  const views = listAsrPoolKeys();
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

export interface AddAsrKeyInput {
  label?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  persist?: boolean;
  enabled?: boolean;
  priority?: number;
}

export function addAsrPoolKey(input: AddAsrKeyInput): AsrPoolKeyView {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const model = input.model.trim();
  const apiKey = input.apiKey.trim();
  if (!baseUrl) throw new Error('请填写 Base URL');
  if (!model) throw new Error('请填写模型名');
  if (!apiKey) throw new Error('请填写 API Key');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('服务地址需要以 http:// 或 https:// 开头');

  const persist = input.persist !== false;
  const id = randomUUID();
  const now = nowIso();
  const maxPriority =
    (db.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM asr_keys WHERE user_id = ?').get(LOCAL_USER) as {
      p: number;
    }).p ?? 0;

  if (!persist) memorySecrets.set(id, apiKey);

  db.prepare(
    `INSERT INTO asr_keys
      (id, user_id, label, base_url, model, key_cipher, key_masked, key_fingerprint,
       persist, enabled, priority, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
  ).run(
    id,
    LOCAL_USER,
    (input.label ?? '').trim() || `${model}`.slice(0, 40),
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

  return toView(db.prepare('SELECT * FROM asr_keys WHERE id = ?').get(id) as AsrKeyRow);
}

export interface UpdateAsrKeyInput {
  label?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  persist?: boolean;
  enabled?: boolean;
  priority?: number;
}

export function updateAsrPoolKey(id: string, patch: UpdateAsrKeyInput): AsrPoolKeyView {
  const row = db.prepare('SELECT * FROM asr_keys WHERE id = ? AND user_id = ?').get(id, LOCAL_USER) as
    | AsrKeyRow
    | undefined;
  if (!row) throw new Error('这条线路不存在');

  const baseUrl = patch.baseUrl !== undefined ? patch.baseUrl.trim().replace(/\/+$/, '') : row.base_url;
  if (patch.baseUrl !== undefined && !/^https?:\/\//i.test(baseUrl)) {
    throw new Error('服务地址需要以 http:// 或 https:// 开头');
  }
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
    const secret = secretOf(row);
    if (!secret) throw new Error('这条线路还没有可用的 Key，请重新填写');
    cipher = persist ? sealSecret(secret) : '';
    if (!persist) memorySecrets.set(id, secret);
  }

  db.prepare(
    `UPDATE asr_keys SET label = ?, base_url = ?, model = ?, key_cipher = ?,
       key_masked = ?, key_fingerprint = ?, persist = ?, enabled = ?, priority = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
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

  return toView(db.prepare('SELECT * FROM asr_keys WHERE id = ?').get(id) as AsrKeyRow);
}

export function deleteAsrPoolKey(id: string): boolean {
  memorySecrets.delete(id);
  const result = db.prepare('DELETE FROM asr_keys WHERE id = ? AND user_id = ?').run(id, LOCAL_USER);
  return result.changes > 0;
}

/** 手动「恢复」：清掉冷却与错误记录，立刻重新可用 */
export function resetAsrPoolKey(id: string): void {
  db.prepare(
    `UPDATE asr_keys SET status = 'ready', cooldown_until = NULL, fail_count = 0,
       last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(nowIso(), id, LOCAL_USER);
}

export function reorderAsrPoolKeys(ids: string[]): void {
  const update = db.prepare('UPDATE asr_keys SET priority = ?, updated_at = ? WHERE id = ? AND user_id = ?');
  const now = nowIso();
  const apply = db.transaction(() => {
    ids.forEach((id, index) => update.run((index + 1) * 10, now, id, LOCAL_USER));
  });
  apply();
}

export const classifyAsrFailure = classifyLlmFailure;
export type { AsrFailureInfo };

export function markAsrSuccess(id: string | null): void {
  if (!id) return;
  const now = nowIso();
  db.prepare(
    `UPDATE asr_keys SET status = 'ready', cooldown_until = NULL, fail_count = 0,
       success_count = success_count + 1, last_used_at = ?, last_error = NULL, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(now, now, id, LOCAL_USER);
}

export function markAsrFailure(id: string | null, info: AsrFailureInfo): void {
  if (!id) return;
  const now = nowIso();
  const status: AsrKeyStatus =
    info.kind === 'invalid' ? 'invalid' : info.kind === 'quota' ? 'exhausted' : 'cooling';
  const cooldownUntil = new Date(Date.now() + info.cooldownMs).toISOString();
  db.prepare(
    `UPDATE asr_keys SET status = ?, cooldown_until = ?, fail_count = fail_count + 1,
       last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(status, cooldownUntil, info.message.slice(0, 300), now, now, id, LOCAL_USER);
}

/**
 * 旧版本把单条 ASR 线路存在 settings.asr.*，启动时搬进号池并清空原值。
 */
export function migrateLegacyAsr(): void {
  const legacyBase = (getSetting('asr.baseUrl') ?? '').trim().replace(/\/+$/, '');
  const legacyCipher = (getSetting('asr.keyCipher') ?? '').trim();
  const legacyModel = (getSetting('asr.model') ?? '').trim();
  if (!legacyBase || !legacyCipher) return;

  let apiKey = '';
  try {
    apiKey = openSecret(legacyCipher);
  } catch {
    apiKey = '';
  }
  setSetting('asr.baseUrl', '');
  setSetting('asr.model', '');
  setSetting('asr.keyCipher', '');
  if (!apiKey) {
    logger.warn('旧 ASR 线路缺少可解密的 Key，已清除，请到设置页重新添加');
    return;
  }

  const fingerprint = fingerprintSecret(apiKey);
  const duplicated = allRows().some((row) => row.key_fingerprint === fingerprint && row.base_url === legacyBase);
  if (!duplicated) {
    addAsrPoolKey({
      baseUrl: legacyBase,
      model: legacyModel || 'whisper-1',
      apiKey,
      label: '旧配置迁移',
    });
  }
  logger.info('旧版 ASR 线路已迁移到号池', { duplicated });
}
