/**
 * API Key 的本机加密。
 *
 * 目标很朴素：即便有人拷走了 .data/app.db（备份、同步盘、误发文件），
 * 里面也只是一段 AES-256-GCM 密文，看不到能直接拿去用的 Key。
 *
 * 主密钥（master key）只存在两处，且都不在数据库里：
 *   1. 环境变量 LLM_MASTER_KEY（最推荐：连磁盘都不落）
 *   2. .data/.llmkey（自动生成，权限 600，只有当前系统用户能读）
 *
 * 换机器或删掉主密钥后就解不开了 —— 这是刻意的：解密能力本身也是秘密。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedMaster: Buffer | null = null;

export function masterKeyPath(): string {
  return path.join(env.dataDir, '.llmkey');
}

/** 接受 hex / base64 / 任意口令；任意口令会先做一次 sha256 拉成 32 字节 */
function normalizeKey(raw: string): Buffer {
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  const base64 = Buffer.from(text, 'base64');
  if (base64.length === KEY_BYTES && /^[A-Za-z0-9+/=]+$/.test(text)) return base64;
  return crypto.createHash('sha256').update(text).digest();
}

function readKeyFile(): Buffer | null {
  try {
    const text = fs.readFileSync(masterKeyPath(), 'utf8').trim();
    if (!text) return null;
    return normalizeKey(text);
  } catch {
    return null;
  }
}

export function masterKeySource(): 'env' | 'file' | 'generated' {
  if (process.env.LLM_MASTER_KEY?.trim()) return 'env';
  return fs.existsSync(masterKeyPath()) ? 'file' : 'generated';
}

function masterKey(): Buffer {
  if (cachedMaster) return cachedMaster;

  const fromEnv = process.env.LLM_MASTER_KEY?.trim();
  if (fromEnv) {
    cachedMaster = normalizeKey(fromEnv);
    return cachedMaster;
  }

  const fromFile = readKeyFile();
  if (fromFile) {
    cachedMaster = fromFile;
    return cachedMaster;
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  try {
    fs.writeFileSync(masterKeyPath(), generated.toString('base64'), { mode: 0o600 });
    fs.chmodSync(masterKeyPath(), 0o600);
  } catch {
    // 极端情况下（比如只读目录）仍然允许本次运行，只是重启后解不开旧密文
  }
  cachedMaster = generated;
  return cachedMaster;
}

/** 明文 → `v1:iv:tag:密文`（base64url），可直接存进 TEXT 列 */
export function sealSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

/**
 * 密文 → 明文。
 * 没有 `v1:` 前缀的旧数据按明文返回，方便平滑迁移（迁移后会立即重新加密）。
 */
export function openSecret(blob: string): string {
  const text = (blob ?? '').trim();
  if (!text) return '';
  if (!text.startsWith(`${VERSION}:`)) return text;

  const parts = text.split(':');
  if (parts.length !== 4) throw new Error('密钥格式无法识别');
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      masterKey(),
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('无法解密本机保存的 Key：主密钥（.data/.llmkey 或 LLM_MASTER_KEY）可能已更换');
  }
}

export function isSealed(blob: string | null | undefined): boolean {
  return Boolean(blob && blob.startsWith(`${VERSION}:`));
}

/** 界面上只展示首 3 位 + 末 4 位，永远不回传完整 Key */
export function maskSecret(secret: string): string {
  const text = (secret ?? '').trim();
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 3)}••••${text.slice(-4)}`;
}

/** 用来判断「是不是同一个 Key」，不可逆 */
export function fingerprintSecret(secret: string): string {
  if (!secret) return '';
  return crypto.createHash('sha256').update(secret.trim()).digest('hex').slice(0, 10);
}

/** 把日志里可能出现的 Key 形态统一抹掉（sk-xxx / Bearer xxx / 智谱的 id.secret） */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|ak|pk)-[A-Za-z0-9._-]{8,}/g, '$1-***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  [/\b[0-9a-f]{8,16}\.[A-Za-z0-9]{16,}\b/g, '***.***'],
  [/([?&](?:api_?key|access_token|token)=)[^&\s"']+/gi, '$1***'],
];

export function redactSecret(text: string): string {
  let output = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

/** 数据目录与数据库文件设为「仅本用户可读写」，避免同机其他账号顺手读走 */
export function tightenPermissions(): void {
  const targets: Array<[string, number]> = [
    [env.dataDir, 0o700],
    [env.dbPath, 0o600],
    [`${env.dbPath}-wal`, 0o600],
    [`${env.dbPath}-shm`, 0o600],
    [masterKeyPath(), 0o600],
    [path.join(env.dataDir, '.authkey'), 0o600],
  ];
  for (const [file, mode] of targets) {
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, mode);
    } catch {
      /* 某些文件系统不支持 chmod，忽略即可 */
    }
  }
}
