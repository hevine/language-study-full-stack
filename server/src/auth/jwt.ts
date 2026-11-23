/**
 * 极简 HS256 JWT：签发与校验，只用 node:crypto。
 * 不引 jsonwebtoken，避免为此新增依赖；实现严格校验 alg / iss / aud / exp / nbf。
 */
import crypto from 'node:crypto';
import { sha256 } from './crypto';
import { AUTH_ROLES, type AuthRole } from './constants';

export interface AccessClaims {
  /** JWT 标准字段 */
  sub: string;
  iat: number;
  exp: number;
  nbf: number;
  iss: string;
  aud: string;
  jti: string;
  /** 自定义字段 */
  role: AuthRole;
  sid: string;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

const encoder = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signAccessToken(params: {
  userId: string;
  role: AuthRole;
  sessionId: string;
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}): { token: string; expiresIn: number } {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = {
    sub: params.userId,
    iat: now,
    nbf: now - 5,
    exp: now + params.ttlSeconds,
    iss: params.issuer,
    aud: params.audience,
    jti: crypto.randomBytes(12).toString('base64url'),
    role: params.role,
    sid: params.sessionId,
  };
  const header = encoder({ alg: 'HS256', typ: 'JWT' });
  const payload = encoder(claims);
  const signingInput = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', params.secret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, expiresIn: params.ttlSeconds };
}

export function verifyAccessToken(
  token: string,
  params: { secret: string; issuer: string; audience: string },
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('令牌格式不正确');

  const [headerRaw, payloadRaw, signature] = parts;
  const expected = crypto
    .createHmac('sha256', params.secret)
    .update(`${headerRaw}.${payloadRaw}`)
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new TokenError('令牌签名校验失败');
  }

  let header: { alg?: string; typ?: string };
  let claims: AccessClaims;
  try {
    header = JSON.parse(Buffer.from(headerRaw, 'base64url').toString('utf8')) as typeof header;
    claims = JSON.parse(Buffer.from(payloadRaw, 'base64url').toString('utf8')) as AccessClaims;
  } catch {
    throw new TokenError('令牌内容无法解析');
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new TokenError('不支持的令牌算法');

  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || typeof claims.sub !== 'string') throw new TokenError('令牌缺少主体');
  if (claims.iss !== params.issuer) throw new TokenError('令牌签发方不匹配');
  if (claims.aud !== params.audience) throw new TokenError('令牌受众不匹配');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new TokenError('令牌已过期');
  if (typeof claims.nbf !== 'number' || claims.nbf > now + 30) throw new TokenError('令牌尚未生效');
  if (!(AUTH_ROLES as readonly string[]).includes(claims.role)) throw new TokenError('令牌角色无效');
  return claims;
}

/** 令牌指纹：只用于审计日志，绝不把令牌本身写进日志 */
export function tokenFingerprint(token: string): string {
  return sha256(token).slice(0, 12);
}
