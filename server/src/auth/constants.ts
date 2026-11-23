/**
 * 鉴权模块的常量与共享类型。
 * 放在独立文件里，避免 routes / services / repositories 之间出现循环依赖。
 */

/** 历史数据里的固定用户 ID。未登录（游客）与启动期后台任务都回落到它。 */
export const LOCAL_USER_ID = 'local';

/**
 * 角色体系：
 *   admin   —— 站点管理员（管理端用户表、审计、重置密码）
 *   teacher —— 教师，可带 jlptLevel 能力等级；将来按等级放开 N4/N5 或全级别教学权限
 *   student —— 学生（默认注册身份）
 *   user    —— 历史兼容值：改造前的普通账号、扫码建号沿用；权限等同 student
 *
 * 注意：自助注册只能在 student / teacher 之间选择，绝不允许选 admin（防提权）。
 */
export const AUTH_ROLES = ['admin', 'user', 'student', 'teacher'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

/** 自助注册允许对外选择的角色子集 */
export const PUBLIC_REGISTER_ROLES = ['student', 'teacher'] as const;
export type PublicRegisterRole = (typeof PUBLIC_REGISTER_ROLES)[number];

/** 日语能力等级（教师能力预留）；数字越小越强，N1 最强 */
export const JLPT_LEVELS = ['N1', 'N2', 'N3', 'N4', 'N5'] as const;
export type JlptLevel = (typeof JLPT_LEVELS)[number];

export function isPublicRegisterRole(value: unknown): value is PublicRegisterRole {
  return typeof value === 'string' && (PUBLIC_REGISTER_ROLES as readonly string[]).includes(value);
}

export function isJlptLevel(value: unknown): value is JlptLevel {
  return typeof value === 'string' && (JLPT_LEVELS as readonly string[]).includes(value);
}

export type UserStatus = 'active' | 'pending' | 'disabled';
export type ProviderId = 'wechat' | 'dingtalk';
export type TicketStatus = 'pending' | 'confirmed' | 'failed' | 'expired' | 'consumed';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  wechat: '微信',
  dingtalk: '钉钉',
};

/** 对外暴露的用户视图：永远不含 password_hash、token_hash 等内部字段 */
export interface AuthUser {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: AuthRole;
  status: UserStatus;
  providerHint: string | null;
  /** 教师能力等级（N1–N5）；学生/历史账号为 null。教学能力判定后续迭代启用 */
  jlptLevel: JlptLevel | null;
  email: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  identities: Array<{ provider: ProviderId; displayName: string | null }>;
}

export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: AuthUser;
}

/** 第三方渠道换回来的统一身份描述 */
export interface ExternalIdentity {
  provider: ProviderId;
  /** 稳定唯一键：微信 unionid ?? openid，钉钉 unionId ?? openId */
  subject: string;
  openId: string | null;
  unionId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export const REFRESH_COOKIE = 'wb_refresh';
export const TICKET_SECRET_HEADER = 'x-ticket-secret';
