/**
 * 鉴权业务编排层：登录、扫码状态机、令牌轮换、RBAC 与审计。
 * 不依赖 express 的 Request/Response，方便脚本与测试直接调用。
 */
import { env } from '../config/env';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../lib/errors';
import { logger } from '../lib/logger';
import {
  LOCAL_USER_ID,
  PROVIDER_LABELS,
  type AuthRole,
  type AuthUser,
  type ExternalIdentity,
  type ProviderId,
  type TokenPair,
  type UserStatus,
} from '../auth/constants';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from '../auth/crypto';
import { signAccessToken, tokenFingerprint, verifyAccessToken } from '../auth/jwt';
import * as repo from '../repositories/auth';
import { ensureProfile } from '../repositories/misc';
import {
  buildAuthorizeUrl,
  exchangeCode,
  isProviderEnabled,
  providerDescriptors,
} from './oauthProviders';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const nowIso = () => new Date().toISOString();
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/** 预先算一个假哈希：用户不存在时也跑一次 scrypt，避免通过响应耗时枚举账号 */
const DUMMY_HASH = hashPassword(randomToken(24));

function audit(event: string, meta: RequestMeta, extra: { userId?: string | null; provider?: ProviderId | null; detail?: string } = {}): void {
  repo.writeAudit({
    event,
    userId: extra.userId ?? null,
    provider: extra.provider ?? null,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: extra.detail ?? null,
  });
}

// ------------------------------------------------------------- 启动初始化

/**
 * 把改造前那套「单机本地用户」注册成管理员。
 * 现有业务表里的 user_id 全是 'local'，这里用同一个 ID 建用户，历史数据原地归属它，零迁移。
 */
export function bootstrapAuth(): void {
  const pruned = repo.pruneExpired();
  let local = repo.findUserById(LOCAL_USER_ID);
  if (!local) {
    const profile = ensureProfile(LOCAL_USER_ID);
    const displayName = profile.displayName && profile.displayName !== '学员'
      ? profile.displayName
      : '本地管理员';
    local = repo.createUser({
      id: LOCAL_USER_ID,
      username: 'admin',
      displayName,
      role: 'admin',
      status: 'active',
      providerHint: 'password',
    });
    logger.info('local admin created', { userId: local.id, existingDataOwner: LOCAL_USER_ID });
  }

  // AUTH_ADMIN_PASSWORD 只在本地管理员还没密码时生效，避免每次启动都被环境变量覆盖
  if (env.auth.adminPassword && !local.password_hash) {
    if (env.auth.adminPassword.length < 8) {
      logger.warn('AUTH_ADMIN_PASSWORD 少于 8 位，建议改强一些；本次仍然生效');
    }
    repo.updateUser(LOCAL_USER_ID, { passwordHash: hashPassword(env.auth.adminPassword) });
    logger.info('admin password initialized from env (first run only)');
  }

  if (!repo.findUserById(LOCAL_USER_ID)?.password_hash) {
    logger.info('admin password not set', {
      hint: '如需账号密码登录，执行 npm run admin:passwd，或在 .env 设置 AUTH_ADMIN_PASSWORD',
    });
  }

  if (pruned.tickets || pruned.sessions) {
    logger.info('expired auth rows pruned', pruned);
  }

  const httpsRequired = (env.auth.wechat.enabled || env.auth.dingtalk.enabled) &&
    !env.auth.publicBaseUrl.startsWith('https://');
  if (httpsRequired) {
    logger.warn('扫码渠道已启用但回调不是 HTTPS', {
      publicBaseUrl: env.auth.publicBaseUrl,
      hint: '微信开放平台与钉钉后台都要求登记公网 HTTPS 回调域名，请设置 AUTH_PUBLIC_BASE_URL',
    });
  }
}

export function publicAuthConfig(): {
  required: boolean;
  guestAllowed: boolean;
  passwordEnabled: boolean;
  providers: ReturnType<typeof providerDescriptors>;
  publicBaseUrl: string;
  accessTtlSec: number;
} {
  return {
    required: env.auth.required,
    guestAllowed: !env.auth.required,
    passwordEnabled: Boolean(repo.findUserById(LOCAL_USER_ID)?.password_hash),
    providers: providerDescriptors(),
    publicBaseUrl: env.auth.publicBaseUrl,
    accessTtlSec: env.auth.accessTtlSec,
  };
}

// ------------------------------------------------------------- 令牌签发

function signFor(
  user: repo.UserRow,
  sessionId: string,
  refreshToken: string,
): Pick<TokenPair, 'accessToken' | 'expiresIn' | 'refreshToken' | 'user'> {
  const signed = signAccessToken({
    userId: user.id,
    role: user.role,
    sessionId,
    secret: env.auth.jwtSecret,
    issuer: env.auth.issuer,
    audience: env.auth.audience,
    ttlSeconds: env.auth.accessTtlSec,
  });
  return {
    accessToken: signed.token,
    expiresIn: signed.expiresIn,
    refreshToken,
    user: repo.toAuthUser(user),
  };
}

function issueTokenPair(
  user: repo.UserRow,
  meta: RequestMeta,
  source: { event: string; provider: ProviderId | null },
): TokenPair {
  const refreshToken = randomToken(48);
  const session = repo.insertSession({
    userId: user.id,
    familyId: randomToken(18),
    tokenHash: sha256(refreshToken),
    userAgent: meta.userAgent,
    ip: meta.ip,
    expiresAt: futureIso(env.auth.refreshTtlSec),
  });
  repo.touchLogin(user.id);
  audit(source.event, meta, {
    userId: user.id,
    provider: source.provider,
    detail: `session=${session.id} refresh=${tokenFingerprint(refreshToken)}`,
  });
  return signFor(user, session.id, refreshToken);
}

/** 供中间件校验 access token：同时确认账号状态与会话未被撤销（支持「登出立即失效」） */
export function resolveAccessToken(token: string): AuthUser {
  let claims;
  try {
    claims = verifyAccessToken(token, {
      secret: env.auth.jwtSecret,
      issuer: env.auth.issuer,
      audience: env.auth.audience,
    });
  } catch {
    throw new UnauthorizedError('登录状态无效，请重新登录', 'TOKEN_INVALID');
  }
  const user = repo.findUserById(claims.sub);
  if (!user) throw new UnauthorizedError('账号不存在', 'ACCOUNT_MISSING');
  if (user.status !== 'active') {
    throw new ForbiddenError(user.status === 'pending' ? '账号待管理员审核' : '账号已被停用', 'ACCOUNT_INACTIVE');
  }
  const session = repo.findSessionById(claims.sid, claims.sub);
  if (!session || session.revoked_at || session.expires_at < nowIso()) {
    throw new UnauthorizedError('会话已失效，请重新登录', 'SESSION_REVOKED');
  }
  // 以库里的角色为准：管理员改了角色，旧 access token 不会继续保留旧权限
  return repo.toAuthUser(user);
}

// ----------------------------------------------------------- 账号密码登录

export function loginWithPassword(username: string, password: string, meta: RequestMeta): TokenPair {
  const name = (username ?? '').trim();
  if (!name || !password) throw new ValidationError('请输入账号与密码');
  const user = repo.findUserByUsername(name);
  const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    audit('login_failed', meta, { detail: `username=${name.slice(0, 40)}` });
    throw new UnauthorizedError('账号或密码不正确', 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'active') {
    throw new ForbiddenError(user.status === 'pending' ? '账号待管理员审核' : '账号已被停用', 'ACCOUNT_INACTIVE');
  }
  return issueTokenPair(user, meta, { event: 'login_password', provider: null });
}

// ------------------------------------------------------------- 扫码登录

export interface QrStartResult {
  ticketId: string;
  ticketSecret: string;
  provider: ProviderId;
  authorizeUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
}

export function startQrLogin(
  provider: ProviderId,
  meta: RequestMeta,
  bindUserId: string | null = null,
): QrStartResult {
  if (!isProviderEnabled(provider)) {
    throw new ValidationError(`${PROVIDER_LABELS[provider]}扫码登录尚未配置，请先补齐 .env 凭证`);
  }
  const state = randomToken(24);
  const ticketSecret = randomToken(32);
  const expiresAt = futureIso(env.auth.ticketTtlSec);
  const authorizeUrl = buildAuthorizeUrl(provider, state);
  const ticket = repo.createTicket({
    provider,
    state,
    ticketSecret,
    authorizeUrl,
    expiresAt,
    bindUserId,
  });
  audit('qr_start', meta, {
    userId: bindUserId,
    provider,
    detail: `ticket=${ticket.id}`,
  });
  return {
    ticketId: ticket.id,
    ticketSecret,
    provider,
    authorizeUrl,
    expiresAt,
    pollIntervalMs: 1500,
  };
}

export function pollTicket(
  ticketId: string,
  ticketSecret: string,
): {
  status: string;
  provider: ProviderId;
  expiresAt: string;
  message: string | null;
} {
  const ticket = repo.findTicketById(ticketId);
  if (!ticket) throw new NotFoundError('登录票据不存在或已被清理');
  if (!safeEqual(sha256(ticketSecret || ''), ticket.ticket_secret)) {
    throw new ForbiddenError('票据密钥不匹配，请重新发起扫码', 'TICKET_SECRET_MISMATCH');
  }
  let status = ticket.status;
  if (ticket.expires_at < nowIso() && (status === 'pending' || status === 'confirmed')) {
    status = 'expired';
  }
  return {
    status,
    provider: ticket.provider,
    expiresAt: ticket.expires_at,
    message: status === 'failed' ? ticket.error_message : null,
  };
}

/** 回调里查身份 → 找已有绑定 / 绑到当前账号 / 新建用户，全部在一个同步流程内完成 */
function resolveUserForIdentity(identity: ExternalIdentity, bindUserId: string | null): repo.UserRow {
  const existing = repo.findIdentity(identity.provider, identity.subject);
  if (existing) {
    const user = repo.findUserById(existing.user_id);
    if (!user) throw new UnauthorizedError('绑定的账号不存在，请联系管理员', 'ACCOUNT_MISSING');
    if (user.status !== 'active') {
      throw new ForbiddenError(user.status === 'pending' ? '账号待管理员审核' : '账号已被停用', 'ACCOUNT_INACTIVE');
    }
    repo.bindIdentity(user.id, identity);
    return user;
  }

  if (bindUserId) {
    const user = repo.findUserById(bindUserId);
    if (!user) throw new UnauthorizedError('待绑定的账号不存在', 'ACCOUNT_MISSING');
    if (user.status !== 'active') throw new ForbiddenError('账号不可用', 'ACCOUNT_INACTIVE');
    repo.bindIdentity(user.id, identity);
    audit('identity_bound', { ip: null, userAgent: null }, {
      userId: user.id,
      provider: identity.provider,
    });
    return user;
  }

  const displayName =
    identity.displayName?.trim().slice(0, 60) || `${PROVIDER_LABELS[identity.provider]}用户`;
  const user = repo.createUser({
    displayName,
    avatarUrl: identity.avatarUrl,
    role: 'user',
    status: env.auth.newUserStatus,
    providerHint: identity.provider,
  });
  repo.bindIdentity(user.id, identity);
  repo.ensureProfileForUser(user.id, displayName);
  audit('user_created', { ip: null, userAgent: null }, {
    userId: user.id,
    provider: identity.provider,
    detail: `status=${user.status}`,
  });
  logger.info('user created via oauth', { userId: user.id, provider: identity.provider, status: user.status });
  return user;
}

/**
 * 处理平台回调。不直接签发令牌：只把票据标为 confirmed 并记录用户，
 * 真正的令牌由浏览器持 ticket_secret 走 /api/auth/qr/exchange 兑换，
 * 这样回调 URL 上不会出现任何可用凭证。
 */
export async function handleOAuthCallback(
  provider: ProviderId,
  query: { code?: string; authCode?: string; state?: string; error?: string; error_description?: string },
  meta: RequestMeta,
): Promise<{ ticketId: string | null; ok: boolean; message: string | null }> {
  const state = query.state ?? '';
  const ticket = state ? repo.findTicketByStateHash(sha256(state)) : undefined;
  if (!ticket) {
    audit('oauth_bad_state', meta, { provider });
    logger.warn('oauth callback with unknown state', { provider });
    return { ticketId: null, ok: false, message: '登录状态无效或已过期，请重新发起扫码' };
  }
  if (ticket.provider !== provider) {
    repo.failTicket(ticket.id, '回调渠道与票据不一致');
    return { ticketId: ticket.id, ok: false, message: '回调渠道与票据不一致' };
  }
  if (ticket.status !== 'pending') {
    return {
      ticketId: ticket.id,
      ok: ticket.status === 'confirmed',
      message: ticket.status === 'failed' ? ticket.error_message : '该二维码已处理，请返回页面查看',
    };
  }
  if (ticket.expires_at < nowIso()) {
    repo.failTicket(ticket.id, '二维码已过期');
    return { ticketId: ticket.id, ok: false, message: '二维码已过期，请重新获取' };
  }

  const code = query.code || query.authCode;
  if (query.error || !code) {
    const message = query.error_description || query.error || '用户取消了授权';
    repo.failTicket(ticket.id, message);
    audit('oauth_denied', meta, { provider, detail: message });
    return { ticketId: ticket.id, ok: false, message };
  }

  try {
    const identity = await exchangeCode(provider, code);
    const user = resolveUserForIdentity(identity, ticket.bind_user_id);
    repo.confirmTicket(ticket.id, user.id);
    audit('qr_confirmed', meta, {
      userId: user.id,
      provider,
      detail: `ticket=${ticket.id}`,
    });
    return { ticketId: ticket.id, ok: true, message: null };
  } catch (err) {
    const message = (err as Error).message;
    repo.failTicket(ticket.id, message);
    audit('qr_failed', meta, { provider, detail: message });
    logger.warn('oauth exchange failed', { provider, message });
    return { ticketId: ticket.id, ok: false, message };
  }
}

export function exchangeTicket(ticketId: string, ticketSecret: string, meta: RequestMeta): TokenPair {
  const ticket = repo.findTicketById(ticketId);
  if (!ticket) throw new NotFoundError('登录票据不存在或已被清理');
  if (!safeEqual(sha256(ticketSecret || ''), ticket.ticket_secret)) {
    throw new ForbiddenError('票据密钥不匹配，请重新发起扫码', 'TICKET_SECRET_MISMATCH');
  }
  if (ticket.status === 'expired' || ticket.expires_at < nowIso()) {
    throw new UnauthorizedError('二维码已过期，请重新获取', 'TICKET_EXPIRED');
  }
  if (ticket.status === 'consumed') {
    throw new UnauthorizedError('该登录已完成，请重新扫码', 'TICKET_CONSUMED');
  }
  if (ticket.status === 'failed') {
    throw new UnauthorizedError(ticket.error_message ?? '授权失败，请重新扫码', 'OAUTH_FAILED');
  }
  if (ticket.status !== 'confirmed' || !ticket.user_id) {
    throw new UnauthorizedError('尚未完成扫码', 'TICKET_PENDING');
  }
  if (ticket.confirmed_at && ticket.confirmed_at < futureIso(-env.auth.loginCodeTtlSec)) {
    throw new UnauthorizedError('确认结果已超时，请重新扫码', 'TICKET_CONFIRM_EXPIRED');
  }
  if (!repo.consumeTicket(ticket.id)) {
    throw new UnauthorizedError('该登录已被使用', 'TICKET_CONSUMED');
  }
  const user = repo.findUserById(ticket.user_id);
  if (!user) throw new UnauthorizedError('账号不存在', 'ACCOUNT_MISSING');
  if (user.status !== 'active') {
    throw new ForbiddenError(user.status === 'pending' ? '账号待管理员审核，请联系管理员' : '账号已被停用', 'ACCOUNT_INACTIVE');
  }
  return issueTokenPair(user, meta, { event: 'login_qr', provider: ticket.provider });
}

// --------------------------------------------------------- 刷新 / 登出

export function refreshSession(refreshToken: string, meta: RequestMeta): TokenPair {
  if (!refreshToken) throw new UnauthorizedError('缺少刷新令牌', 'NO_REFRESH_TOKEN');
  const session = repo.findSessionByTokenHash(sha256(refreshToken));
  if (!session) throw new UnauthorizedError('登录已失效，请重新登录', 'SESSION_NOT_FOUND');

  if (session.revoked_at) {
    // 已撤销的令牌又被拿来用 = 疑似令牌泄露重放，整条家族链作废
    const revoked = repo.revokeFamily(session.family_id);
    audit('refresh_replay_detected', meta, {
      userId: session.user_id,
      detail: `family revoked: ${revoked}`,
    });
    logger.warn('refresh token replay detected', { userId: session.user_id, revoked });
    throw new UnauthorizedError('检测到登录凭证重复使用，已撤销该登录，请重新登录', 'SESSION_REPLAY');
  }
  if (session.expires_at < nowIso()) {
    repo.revokeSession(session.id);
    throw new UnauthorizedError('登录已过期，请重新登录', 'SESSION_EXPIRED');
  }
  const user = repo.findUserById(session.user_id);
  if (!user) throw new UnauthorizedError('账号不存在', 'ACCOUNT_MISSING');
  if (user.status !== 'active') {
    throw new ForbiddenError('账号已被停用', 'ACCOUNT_INACTIVE');
  }

  const newRefresh = randomToken(48);
  const created = repo.rotateSession(session.id, {
    userId: user.id,
    familyId: session.family_id,
    tokenHash: sha256(newRefresh),
    userAgent: meta.userAgent,
    ip: meta.ip,
    expiresAt: futureIso(env.auth.refreshTtlSec),
  });
  audit('refresh', meta, {
    userId: user.id,
    detail: `session=${created.id} refresh=${tokenFingerprint(newRefresh)}`,
  });
  return signFor(user, created.id, newRefresh);
}

export function logout(refreshToken: string | undefined, meta: RequestMeta): void {
  if (!refreshToken) return;
  const session = repo.findSessionByTokenHash(sha256(refreshToken));
  if (session && !session.revoked_at) {
    repo.revokeSession(session.id);
    audit('logout', meta, { userId: session.user_id, detail: `session=${session.id}` });
  }
}

export function listMySessions(userId: string): ReturnType<typeof repo.listSessions> {
  return repo.listSessions(userId);
}

export function revokeMySession(userId: string, sessionId: string, meta: RequestMeta): void {
  const session = repo.findSessionById(sessionId, userId);
  if (!session) throw new NotFoundError('会话不存在');
  repo.revokeSession(sessionId);
  audit('session_revoked', meta, { userId, detail: `session=${sessionId}` });
}

// ------------------------------------------------------------- 管理端

function assertNotLastAdmin(user: repo.UserRow, patch: { role?: AuthRole; status?: UserStatus }): void {
  if (user.role !== 'admin') return;
  const demoting = (patch.role && patch.role !== 'admin') || (patch.status && patch.status !== 'active');
  if (!demoting) return;
  const admins = repo.listUserRows().filter((row) => row.role === 'admin' && row.status === 'active');
  if (admins.length <= 1) {
    throw new ValidationError('不能停用或降级唯一的管理员账号');
  }
}

export function adminUpdateUser(
  id: string,
  patch: { role?: AuthRole; status?: UserStatus; displayName?: string },
): AuthUser {
  const user = repo.findUserById(id);
  if (!user) throw new NotFoundError('用户不存在');
  assertNotLastAdmin(user, patch);
  const updated = repo.updateUser(id, patch);
  return repo.toAuthUser(updated!);
}

/** 管理员新建本地账号：扫码之外也支持多人使用同一套系统，且便于审计与回收 */
export function adminCreateUser(input: {
  username: string;
  password: string;
  displayName?: string;
  role?: AuthRole;
}): AuthUser {
  const username = (input.username ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw new ValidationError('用户名需为 3–40 位字母、数字或 . _ -');
  }
  if ((input.password ?? '').length < 8) throw new ValidationError('密码至少 8 位');
  if (repo.findUserByUsername(username)) throw new ConflictError('这个用户名已被使用');

  const displayName = (input.displayName?.trim() || username).slice(0, 60);
  const user = repo.createUser({
    username,
    passwordHash: hashPassword(input.password),
    displayName,
    role: input.role ?? 'user',
    status: 'active',
    providerHint: 'password',
  });
  repo.ensureProfileForUser(user.id, displayName);
  audit('user_created_by_admin', { ip: null, userAgent: null }, {
    userId: user.id,
    detail: `username=${username} role=${user.role}`,
  });
  return repo.toAuthUser(user);
}

export function adminListUsers(): ReturnType<typeof repo.adminUserViews> {
  return repo.adminUserViews();
}

export function adminListAudit(limit: number): ReturnType<typeof repo.listAudit> {
  return repo.listAudit(limit);
}

/** 供 npm run admin:passwd 使用：设置/重置本地管理员密码 */
export function setAdminPassword(password: string): void {
  if (password.length < 8) throw new ValidationError('密码至少 8 位');
  if (!repo.findUserById(LOCAL_USER_ID)) {
    throw new ValidationError('本地管理员尚未初始化，请先启动一次服务');
  }
  repo.updateUser(LOCAL_USER_ID, { passwordHash: hashPassword(password) });
}
