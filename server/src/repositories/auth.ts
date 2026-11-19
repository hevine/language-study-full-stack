/**
 * 用户、第三方身份、刷新会话、扫码票据的数据访问层。
 * 只做 SQL，不含业务规则；所有秘密字段（refresh token / state / ticket secret / login code）
 * 一律只存 SHA-256 摘要，数据库文件被拷走也拿不到可直接使用的凭据。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import {
  LOCAL_USER_ID,
  type AuthRole,
  type AuthUser,
  type ExternalIdentity,
  type ProviderId,
  type TicketStatus,
  type UserStatus,
} from '../auth/constants';
import { sha256 } from '../auth/crypto';

const nowIso = () => new Date().toISOString();

export interface UserRow {
  id: string;
  username: string | null;
  password_hash: string | null;
  display_name: string;
  avatar_url: string | null;
  role: AuthRole;
  status: UserStatus;
  provider_hint: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdentityRow {
  id: string;
  user_id: string;
  provider: ProviderId;
  subject: string;
  open_id: string | null;
  union_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  user_agent: string | null;
  ip: string | null;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
  created_at: string;
}

export interface TicketRow {
  id: string;
  provider: ProviderId;
  state_hash: string;
  ticket_secret: string;
  status: TicketStatus;
  bind_user_id: string | null;
  user_id: string | null;
  error_message: string | null;
  authorize_url: string | null;
  confirmed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- users

export function findUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function listUserRows(): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
}

export function createUser(input: {
  id?: string;
  username?: string | null;
  passwordHash?: string | null;
  displayName: string;
  avatarUrl?: string | null;
  role?: AuthRole;
  status?: UserStatus;
  providerHint?: string | null;
}): UserRow {
  const id = input.id ?? `usr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, avatar_url, role, status,
                        provider_hint, last_login_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    input.username ?? null,
    input.passwordHash ?? null,
    input.displayName.slice(0, 60),
    input.avatarUrl ?? null,
    input.role ?? 'user',
    input.status ?? 'active',
    input.providerHint ?? null,
    now,
    now,
  );
  return findUserById(id)!;
}

export function updateUser(
  id: string,
  patch: Partial<{
    username: string | null;
    passwordHash: string | null;
    displayName: string;
    avatarUrl: string | null;
    role: AuthRole;
    status: UserStatus;
    providerHint: string | null;
  }>,
): UserRow | undefined {
  const columns: Record<string, string> = {
    username: 'username',
    passwordHash: 'password_hash',
    displayName: 'display_name',
    avatarUrl: 'avatar_url',
    role: 'role',
    status: 'status',
    providerHint: 'provider_hint',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return findUserById(id);
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return findUserById(id);
}

export function touchLogin(id: string): void {
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
    nowIso(),
    nowIso(),
    id,
  );
}

export function listIdentities(userId: string): IdentityRow[] {
  return db
    .prepare('SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at')
    .all(userId) as IdentityRow[];
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    providerHint: row.provider_hint,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    identities: listIdentities(row.id).map((item) => ({
      provider: item.provider,
      displayName: item.display_name,
    })),
  };
}

/** 现有 profile 表继续作为展示资料表；新建用户时同步一行，避免设置页读到默认值 */
export function ensureProfileForUser(userId: string, displayName: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO profile (user_id, display_name, goal_note, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  ).run(userId, displayName.slice(0, 40), now, now);
}

// ------------------------------------------------------- user_identities

export function findIdentity(provider: ProviderId, subject: string): IdentityRow | undefined {
  return db
    .prepare('SELECT * FROM user_identities WHERE provider = ? AND subject = ?')
    .get(provider, subject) as IdentityRow | undefined;
}

export function bindIdentity(userId: string, identity: ExternalIdentity): IdentityRow {
  const now = nowIso();
  const existing = findIdentity(identity.provider, identity.subject);
  if (existing) {
    db.prepare(
      `UPDATE user_identities
       SET open_id = ?, union_id = ?, display_name = COALESCE(?, display_name),
           avatar_url = COALESCE(?, avatar_url), updated_at = ?
       WHERE id = ?`,
    ).run(
      identity.openId,
      identity.unionId,
      identity.displayName,
      identity.avatarUrl,
      now,
      existing.id,
    );
    return findIdentity(identity.provider, identity.subject)!;
  }
  const id = `idt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db.prepare(
    `INSERT INTO user_identities
       (id, user_id, provider, subject, open_id, union_id, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    identity.provider,
    identity.subject,
    identity.openId,
    identity.unionId,
    identity.displayName,
    identity.avatarUrl,
    now,
    now,
  );
  return findIdentity(identity.provider, identity.subject)!;
}

// -------------------------------------------------------- auth_sessions

export function insertSession(input: {
  userId: string;
  familyId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: string;
}): SessionRow {
  const id = `ses_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, family_id, token_hash, user_agent, ip, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.familyId,
    input.tokenHash,
    input.userAgent?.slice(0, 300) ?? null,
    input.ip?.slice(0, 64) ?? null,
    input.expiresAt,
    nowIso(),
  );
  return db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as SessionRow;
}

export function findSessionByTokenHash(tokenHash: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(tokenHash) as
    | SessionRow
    | undefined;
}

export function revokeSession(id: string, replacedBy?: string): void {
  db.prepare('UPDATE auth_sessions SET revoked_at = ?, replaced_by = ? WHERE id = ?').run(
    nowIso(),
    replacedBy ?? null,
    id,
  );
}

/** 检测到旧 refresh 被重用：整条家族链作废，这是重放检测的核心 */
export function revokeFamily(familyId: string): number {
  const result = db
    .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
    .run(nowIso(), familyId);
  return result.changes;
}

export function listSessions(userId: string): Array<{
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ip: string | null;
  userAgent: string | null;
}> {
  return (
    db
      .prepare(
        `SELECT id, created_at, expires_at, revoked_at, ip, user_agent
         FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      )
      .all(userId) as Array<{
      id: string;
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
      ip: string | null;
      user_agent: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    ip: row.ip,
    userAgent: row.user_agent,
  }));
}

export function findSessionById(id: string, userId: string): SessionRow | undefined {
  return db
    .prepare('SELECT * FROM auth_sessions WHERE id = ? AND user_id = ?')
    .get(id, userId) as SessionRow | undefined;
}

/**
 * refresh 轮换：旧会话作废并指向新会话，整个动作在一个事务里。
 * 旧令牌随后再被拿来刷新时会被识别为「已撤销」并触发整族撤销（见 services/auth.ts）。
 */
export function rotateSession(
  oldSessionId: string,
  input: {
    userId: string;
    familyId: string;
    tokenHash: string;
    userAgent: string | null;
    ip: string | null;
    expiresAt: string;
  },
): SessionRow {
  const rotate = db.transaction(() => {
    const created = insertSession(input);
    db.prepare('UPDATE auth_sessions SET revoked_at = ?, replaced_by = ? WHERE id = ?').run(
      nowIso(),
      created.id,
      oldSessionId,
    );
    return created;
  });
  return rotate();
}

// -------------------------------------------------- auth_login_tickets

export function createTicket(input: {
  provider: ProviderId;
  state: string;
  ticketSecret: string;
  authorizeUrl: string;
  expiresAt: string;
  bindUserId?: string | null;
}): { id: string; expiresAt: string } {
  const id = `tkt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = nowIso();
  db.prepare(
    `INSERT INTO auth_login_tickets
       (id, provider, state_hash, ticket_secret, status, bind_user_id, authorize_url, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.provider,
    sha256(input.state),
    sha256(input.ticketSecret),
    input.bindUserId ?? null,
    input.authorizeUrl,
    input.expiresAt,
    now,
    now,
  );
  return { id, expiresAt: input.expiresAt };
}

export function findTicketById(id: string): TicketRow | undefined {
  return db.prepare('SELECT * FROM auth_login_tickets WHERE id = ?').get(id) as TicketRow | undefined;
}

export function findTicketByStateHash(stateHash: string): TicketRow | undefined {
  return db
    .prepare('SELECT * FROM auth_login_tickets WHERE state_hash = ?')
    .get(stateHash) as TicketRow | undefined;
}

export function failTicket(id: string, message: string): void {
  db.prepare(
    `UPDATE auth_login_tickets SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
  ).run(message.slice(0, 200), nowIso(), id);
}

/** 回调成功后只记落哪个用户；真正的令牌要凭 ticket_secret 来兑换，回调 URL 里不放任何凭证 */
export function confirmTicket(id: string, userId: string): void {
  const now = nowIso();
  db.prepare(
    `UPDATE auth_login_tickets
     SET status = 'confirmed', user_id = ?, confirmed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(userId, now, now, id);
}

/** 条件更新保证一枚票据只能兑换一次，并发请求里只有一个能拿到 true */
export function consumeTicket(id: string): boolean {
  const result = db
    .prepare(
      `UPDATE auth_login_tickets SET status = 'consumed', updated_at = ?
       WHERE id = ? AND status = 'confirmed'`,
    )
    .run(nowIso(), id);
  return result.changes === 1;
}

/** 过期票据与会话清理：由启动时的 bootstrap 调一次，之后由请求懒触发 */
export function pruneExpired(): { tickets: number; sessions: number } {
  const now = nowIso();
  const tickets = db
    .prepare(
      `UPDATE auth_login_tickets SET status = 'expired', updated_at = ?
       WHERE status IN ('pending', 'confirmed') AND expires_at < ?`,
    )
    .run(now, now).changes;
  const sessions = db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now).changes;
  return { tickets, sessions };
}

// ----------------------------------------------------------- audit log

export function writeAudit(input: {
  userId?: string | null;
  event: string;
  provider?: ProviderId | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
}): void {
  db.prepare(
    `INSERT INTO auth_audit_logs (id, user_id, event, provider, ip, user_agent, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `log_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    input.userId ?? null,
    input.event,
    input.provider ?? null,
    input.ip?.slice(0, 64) ?? null,
    input.userAgent?.slice(0, 300) ?? null,
    input.detail?.slice(0, 300) ?? null,
    nowIso(),
  );
}

export function listAudit(limit = 100): Array<{
  id: string;
  userId: string | null;
  event: string;
  provider: string | null;
  ip: string | null;
  detail: string | null;
  createdAt: string;
}> {
  return (
    db
      .prepare(
        `SELECT id, user_id, event, provider, ip, detail, created_at
         FROM auth_audit_logs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      user_id: string | null;
      event: string;
      provider: string | null;
      ip: string | null;
      detail: string | null;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    userId: row.user_id,
    event: row.event,
    provider: row.provider,
    ip: row.ip,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

/** 管理端视图：用户 + 会话数，不回传任何哈希字段 */
export function adminUserViews(): Array<AuthUser & { sessionCount: number }> {
  const counts = db
    .prepare(
      `SELECT user_id, COUNT(*) AS n FROM auth_sessions
       WHERE revoked_at IS NULL AND expires_at > ? GROUP BY user_id`,
    )
    .all(nowIso()) as Array<{ user_id: string; n: number }>;
  const map = new Map(counts.map((row) => [row.user_id, row.n]));
  return listUserRows().map((row) => ({
    ...toAuthUser(row),
    sessionCount: map.get(row.id) ?? 0,
  }));
}

export { LOCAL_USER_ID };
