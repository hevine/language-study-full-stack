/**
 * 密码哈希、令牌与摘要。只用 Node 内置 crypto，不引第三方依赖。
 *
 * 密码用 scrypt（N=2^15, r=8, p=1），带随机盐；校验用 timingSafeEqual 抗时序侧信道。
 * 存储格式：scrypt$N$r$p$salt(base64url)$hash(base64url)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const expected = Buffer.from(hashRaw, 'base64url');
    if (expected.length !== KEY_BYTES) return false;
    const actual = crypto.scryptSync(password, Buffer.from(saltRaw, 'base64url'), KEY_BYTES, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 签发令牌的主密钥：环境变量优先，否则落在 .data/.authkey（600） */
export function loadOrCreateSecret(envValue: string | undefined, filePath: string): string {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;

  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 首次启动，下面生成 */
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  try {
    fs.writeFileSync(filePath, generated, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* 只读目录时仍允许本次运行，重启后旧令牌会失效（安全降级） */
  }
  return generated;
}
