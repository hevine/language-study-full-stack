/**
 * 鉴权模块的常量与共享类型。
 * 放在独立文件里，避免 routes / services / repositories 之间出现循环依赖。
 */

/** 历史数据里的固定用户 ID。未登录（游客）与启动期后台任务都回落到它。 */
export const LOCAL_USER_ID = 'local';

export const AUTH_ROLES = ['admin', 'user'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

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
