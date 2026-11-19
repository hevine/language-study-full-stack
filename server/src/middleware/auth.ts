/**
 * 鉴权中间件：Cookie 读写、令牌解析、RBAC、CSRF 同源校验、登录限流。
 * 令牌只走 Authorization: Bearer 与 HttpOnly Cookie，绝不从 query / localStorage 读取。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../lib/errors';
import { REFRESH_COOKIE, type AuthRole } from '../auth/constants';
import {
  bindCurrentUser,
  currentAuthUser,
  isAuthenticated,
} from '../auth/requestScope';
import { resolveAccessToken, type RequestMeta } from '../services/auth';

// ------------------------------------------------------------------ Cookie

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

/** Path 限定在 /api/auth：刷新令牌不会被带到普通业务接口上 */
export function setRefreshCookie(res: Response, token: string): void {
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/api/auth',
    'SameSite=Lax',
    `Max-Age=${env.auth.refreshTtlSec}`,
  ];
  if (env.auth.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearRefreshCookie(res: Response): void {
  const parts = [
    `${REFRESH_COOKIE}=`,
    'HttpOnly',
    'Path=/api/auth',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (env.auth.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// ------------------------------------------------------------- 请求元信息

export function requestMeta(req: Request): RequestMeta {
  // 不采信 X-Forwarded-For：它可被客户端伪造，会污染限流键与审计日志。
  // 若部署在反代后，请让反代改写成真实来源并在网关层限流。
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  return {
    ip: ip ? ip.slice(0, 64) : null,
    userAgent: (req.header('user-agent') ?? null)?.slice(0, 300) ?? null,
  };
}

export function bearerToken(req: Request): string {
  const header = req.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// --------------------------------------------------------------- 认证解析

/** 全局挂载：有令牌就解析并绑定数据用户，没令牌就当游客；无效令牌在游客模式降级 */
export const optionalAuthenticate: RequestHandler = (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return next();
  try {
    const user = resolveAccessToken(token);
    bindCurrentUser(user);
    res.locals.authUser = user;
    next();
  } catch (err) {
    // 无效令牌一律降级为游客：登录页即使带着过期令牌，也必须能拿到 /auth/config。
    // 业务接口的「必须登录」由 enforceAuth 兜底，受保护端点由 requireAuth 自己校验。
    req.log?.warn('invalid access token, falling back to guest', {
      message: (err as Error).message,
    });
    next();
  }
};

/** 路由级：要求有效登录；配合 optionalAuthenticate 时几乎零额外开销 */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (isAuthenticated()) return next();
  const token = bearerToken(req);
  if (!token) return next(new UnauthorizedError('请先登录', 'LOGIN_REQUIRED'));
  try {
    const user = resolveAccessToken(token);
    bindCurrentUser(user);
    res.locals.authUser = user;
    next();
  } catch (err) {
    next(err);
  }
};

export function requireRole(role: AuthRole): RequestHandler {
  return (_req, _res, next) => {
    const user = currentAuthUser();
    if (!user) return next(new UnauthorizedError('请先登录', 'LOGIN_REQUIRED'));
    if (user.role !== role) return next(new ForbiddenError('需要管理员权限', 'ROLE_REQUIRED'));
    next();
  };
}

/** AUTH_REQUIRED=true 时挂到所有业务路由之前：白名单独占放行 */
export const enforceAuth: RequestHandler = (_req, _res, next) => {
  if (isAuthenticated()) return next();
  next(new UnauthorizedError('请先登录', 'LOGIN_REQUIRED'));
};

// ------------------------------------------------------------------- CSRF

const ALLOWED_ORIGINS = new Set<string>([
  'http://localhost:5199',
  'http://127.0.0.1:5199',
  `http://localhost:${env.port}`,
  `http://127.0.0.1:${env.port}`,
]);
try {
  ALLOWED_ORIGINS.add(new URL(env.auth.publicBaseUrl).origin);
} catch {
  /* 配置成非 URL 时忽略，启动日志会另有提示 */
}

/** 依赖 Cookie 的 POST 必须同源；curl 等无 Origin 的非浏览器请求放行，便于自检 */
export function assertSameOrigin(req: Request): void {
  const origin = req.header('origin');
  if (!origin) return;
  if (ALLOWED_ORIGINS.has(origin)) return;
  throw new ForbiddenError('跨站请求被拒绝', 'CSRF_ORIGIN');
}

// ------------------------------------------------------------------- 限流

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

// 定时清理，避免长期运行后 Map 无限增长
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000);
sweeper.unref();

/** 固定窗口限流，按「动作 + IP」计数；登录、刷新、二维码都单独限 */
export function rateLimit(action: string): RequestHandler {
  const windowMs = env.auth.rateLimit.windowSec * 1000;
  return (req, _res, next) => {
    const key = `${action}:${requestMeta(req).ip ?? 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= env.auth.rateLimit.max) {
      return next(
        new TooManyRequestsError('操作太频繁，请稍后再试', {
          retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        }),
      );
    }
    bucket.count += 1;
    next();
  };
}
