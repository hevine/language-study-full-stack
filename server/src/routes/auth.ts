/**
 * 用户与鉴权 REST 接口。
 *
 * 公开：config / login / qr/start / qr/:id / qr/exchange / refresh / logout / callback/:provider
 * 需登录：me / sessions
 * 需管理员：admin/*
 *
 * 令牌约定：
 *   · access token 只在响应 JSON 里给一次，由前端保存在内存（不落 localStorage）
 *   · refresh token 只通过 HttpOnly + SameSite=Lax Cookie 传递，绝不出现在 URL 或响应体
 *   · 扫码回调 URL 上只有 ticketId 与状态文字，真正的兑换凭证 ticketSecret 留在浏览器会话里
 */
import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError, ValidationError } from '../lib/errors';
import {
  REFRESH_COOKIE,
  TICKET_SECRET_HEADER,
  LOCAL_USER_ID,
  type AuthRole,
  type TokenPair,
  type UserStatus,
} from '../auth/constants';
import { currentAuthUser } from '../auth/requestScope';
import {
  assertSameOrigin,
  bearerToken,
  clearRefreshCookie,
  rateLimit,
  readCookie,
  requestMeta,
  requireAuth,
  requireRole,
  setRefreshCookie,
} from '../middleware/auth';
import * as auth from '../services/auth';
import { isProviderId } from '../services/oauthProviders';

export const authRouter = Router();

function sendTokens(res: Response, pair: TokenPair, status = 200): void {
  setRefreshCookie(res, pair.refreshToken);
  res.status(status).json({
    accessToken: pair.accessToken,
    expiresIn: pair.expiresIn,
    user: pair.user,
  });
}

/** 前端登录页的第一屏配置：哪些渠道可用、是否强制登录、当前是否已登录 */
authRouter.get(
  '/auth/config',
  asyncHandler(async (_req, res) => {
    res.json({
      ...auth.publicAuthConfig(),
      user: currentAuthUser(),
      guestUserId: LOCAL_USER_ID,
    });
  }),
);

const LoginInput = z.object({
  username: z.string().min(1).max(60),
  password: z.string().min(1).max(200),
});

authRouter.post(
  '/auth/login',
  rateLimit('login'),
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = parseBody(LoginInput, req.body);
    sendTokens(res, auth.loginWithPassword(body.username, body.password, requestMeta(req)));
  }),
);

/**
 * 自助注册。
 * 201 + 令牌（status=active，与登录同一套令牌链、Set-Cookie 轮换刷新令牌）
 * 202 + { pending:true,user }（status=pending，等管理员启用）
 * 错误按 code 分支：REGISTER_DISABLED / USERNAME_TAKEN / VALIDATION_FAILED / RATE_LIMITED
 */
const RegisterInput = z.object({
  username: z.string().min(1).max(40),
  password: z.string().min(1).max(200),
  displayName: z.string().trim().min(1).max(60).optional(),
  role: z.enum(['student', 'teacher']).optional(),
  jlptLevel: z.enum(['N1', 'N2', 'N3', 'N4', 'N5']).optional(),
});

authRouter.post(
  '/auth/register',
  rateLimit('register'),
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = parseBody(RegisterInput, req.body);
    const result = auth.registerWithPassword(body, requestMeta(req));
    if ('pending' in result) {
      res.status(202).json({ pending: true, user: result.user });
      return;
    }
    sendTokens(res, result, 201);
  }),
);

const QrStartInput = z.object({
  provider: z.string(),
  /** 已登录时传 true：把该渠道绑到当前账号，而不是新建用户 */
  bind: z.boolean().optional(),
});

authRouter.post(
  '/auth/qr/start',
  rateLimit('qr-start'),
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = parseBody(QrStartInput, req.body);
    if (!isProviderId(body.provider)) throw new ValidationError('不支持的登录渠道');
    const current = currentAuthUser();
    if (body.bind && !current) throw new ValidationError('绑定渠道需要先登录');
    res.json(auth.startQrLogin(body.provider, requestMeta(req), body.bind ? current!.id : null));
  }),
);

authRouter.get(
  '/auth/qr/:ticketId',
  rateLimit('qr-poll'),
  asyncHandler(async (req, res) => {
    const secret = req.header(TICKET_SECRET_HEADER);
    if (!secret) throw new ValidationError('缺少票据密钥');
    res.json(auth.pollTicket(req.params.ticketId, secret));
  }),
);

const QrExchangeInput = z.object({
  ticketId: z.string().min(1).max(80),
  ticketSecret: z.string().min(1).max(200),
});

authRouter.post(
  '/auth/qr/exchange',
  rateLimit('qr-exchange'),
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = parseBody(QrExchangeInput, req.body);
    sendTokens(res, auth.exchangeTicket(body.ticketId, body.ticketSecret, requestMeta(req)));
  }),
);

/** 微信 / 钉钉授权回调：只改票据状态，随后 302 回前端，URL 上不携带任何凭证 */
authRouter.get(
  '/auth/callback/:provider',
  asyncHandler(async (req, res) => {
    const provider = req.params.provider;
    if (!isProviderId(provider)) throw new NotFoundError('未知的登录渠道');

    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    let result: Awaited<ReturnType<typeof auth.handleOAuthCallback>>;
    try {
      result = await auth.handleOAuthCallback(
        provider,
        {
          code: text(req.query.code),
          authCode: text(req.query.authCode),
          state: text(req.query.state),
          error: text(req.query.error) ?? text(req.query.errorcode),
          error_description: text(req.query.error_description),
        },
        requestMeta(req),
      );
    } catch (err) {
      result = { ticketId: null, ok: false, message: (err as Error).message };
    }

    const params = new URLSearchParams();
    if (result.ticketId) params.set('ticket', result.ticketId);
    params.set('status', result.ok ? 'confirmed' : 'failed');
    params.set('provider', provider);
    if (result.message) params.set('message', result.message.slice(0, 160));
    res.redirect(302, `${env.auth.publicBaseUrl}/#/auth/callback?${params.toString()}`);
  }),
);

authRouter.post(
  '/auth/refresh',
  rateLimit('refresh'),
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const token = readCookie(req, REFRESH_COOKIE);
    sendTokens(res, auth.refreshSession(token ?? '', requestMeta(req)));
  }),
);

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    auth.logout(readCookie(req, REFRESH_COOKIE), requestMeta(req));
    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/auth/me',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ user: currentAuthUser() });
  }),
);

/** 改自己的昵称/头像（依赖 Cookie 之外的 Bearer，但仍显式校验同源） */
const UpdateMeInput = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
});

authRouter.patch(
  '/auth/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = parseBody(UpdateMeInput, req.body);
    res.json({ user: auth.updateMe(currentAuthUser()!.id, body) });
  }),
);

/** 改密码：撤销其它设备，保留当前设备 */
const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

authRouter.post(
  '/auth/password',
  requireAuth,
  rateLimit('password'),
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = parseBody(ChangePasswordInput, req.body);
    auth.changePassword(
      currentAuthUser()!.id,
      body.currentPassword,
      body.newPassword,
      auth.sessionIdFromToken(bearerToken(req)),
    );
    res.json({ ok: true });
  }),
);

/** 认领预览：游客名下待搬移的分项计数（只读，不搬移） */
authRouter.get(
  '/auth/guest-data',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ tables: auth.claimGuestPreview() });
  }),
);

/** 确认认领：把游客数据整体搬到当前账号，不可逆 */
authRouter.post(
  '/auth/claim-guest',
  requireAuth,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const result = auth.claimGuestData(currentAuthUser()!.id, requestMeta(req));
    res.json({ result, total: result.reduce((sum, item) => sum + item.moved, 0) });
  }),
);

authRouter.get(
  '/auth/sessions',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ sessions: auth.listMySessions(currentAuthUser()!.id) });
  }),
);

authRouter.delete(
  '/auth/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    auth.revokeMySession(currentAuthUser()!.id, req.params.id, requestMeta(req));
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- 管理端

authRouter.get(
  '/auth/admin/users',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const users = auth.adminListUsers();
    res.json({ users, total: users.length });
  }),
);

const AdminCreate = z.object({
  username: z.string().min(3).max(40),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(60).optional(),
  role: z.enum(['admin', 'user', 'student', 'teacher']).optional(),
  jlptLevel: z.enum(['N1', 'N2', 'N3', 'N4', 'N5']).optional(),
});

authRouter.post(
  '/auth/admin/users',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = parseBody(AdminCreate, req.body);
    res.status(201).json({ user: auth.adminCreateUser(body) });
  }),
);

const AdminPatch = z.object({
  role: z.enum(['admin', 'user', 'student', 'teacher']).optional(),
  status: z.enum(['active', 'pending', 'disabled']).optional(),
  displayName: z.string().min(1).max(60).optional(),
});

authRouter.patch(
  '/auth/admin/users/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = parseBody(AdminPatch, req.body);
    const patch: { role?: AuthRole; status?: UserStatus; displayName?: string } = body;
    res.json({ user: auth.adminUpdateUser(req.params.id, patch) });
  }),
);

/** 管理员重置任意用户密码（含找回密码场景）：新密码由管理员设定，云端无邮件通道 */
const AdminResetInput = z.object({
  password: z.string().min(8).max(200),
});

authRouter.post(
  '/auth/admin/users/:id/password',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = parseBody(AdminResetInput, req.body);
    res.json({ user: auth.adminResetPassword(req.params.id, body.password) });
  }),
);

authRouter.get(
  '/auth/admin/audit',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const raw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 100;
    res.json({ events: auth.adminListAudit(limit) });
  }),
);
