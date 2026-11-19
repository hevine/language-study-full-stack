/**
 * 第三方 OAuth 客户端：微信开放平台网站应用扫码登录 + 钉钉统一授权登录。
 *
 * 严格按官方接口实现，不做任何「模拟扫码」：
 *   微信 https://developers.weixin.qq.com/doc/oplatform/developers/dev/auth/web.html
 *     · 授权  GET  https://open.weixin.qq.com/connect/qrconnect          (scope=snsapi_login)
 *     · 换票  GET  https://api.weixin.qq.com/sns/oauth2/access_token
 *     · 资料  GET  https://api.weixin.qq.com/sns/userinfo
 *   钉钉 https://open.dingtalk.com/document/app/obtain-identity-credentials
 *     · 授权  GET  https://login.dingtalk.com/oauth2/auth                 (scope=openid, prompt=consent)
 *     · 换票  POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken
 *     · 资料  GET  https://api.dingtalk.com/v1.0/contact/users/me  (x-acs-dingtalk-access-token)
 *
 * 凭证全部来自环境变量，未配置时渠道显示「未启用」，不构造假回调、不签发测试身份。
 */
import { env } from '../config/env';
import { ConfigError, UpstreamError } from '../lib/errors';
import { logger } from '../lib/logger';
import { PROVIDER_LABELS, type ExternalIdentity, type ProviderId } from '../auth/constants';

const WECHAT_AUTHORIZE = 'https://open.weixin.qq.com/connect/qrconnect';
const WECHAT_TOKEN = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const WECHAT_USERINFO = 'https://api.weixin.qq.com/sns/userinfo';
const DINGTALK_AUTHORIZE = 'https://login.dingtalk.com/oauth2/auth';
const DINGTALK_TOKEN = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const DINGTALK_USERINFO = 'https://api.dingtalk.com/v1.0/contact/users/me';

const UPSTREAM_TIMEOUT_MS = 12_000;

export const PROVIDER_IDS: readonly ProviderId[] = ['wechat', 'dingtalk'];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isProviderEnabled(provider: ProviderId): boolean {
  return provider === 'wechat' ? env.auth.wechat.enabled : env.auth.dingtalk.enabled;
}

export function redirectUriOf(provider: ProviderId): string {
  return provider === 'wechat' ? env.auth.wechat.redirectUri : env.auth.dingtalk.redirectUri;
}

/** 给前端登录页用：只回是否启用与回调地址，绝不回 AppSecret */
export function providerDescriptors(): Array<{
  id: ProviderId;
  label: string;
  enabled: boolean;
  redirectUri: string;
  hint: string;
}> {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
    enabled: isProviderEnabled(id),
    redirectUri: redirectUriOf(id),
    hint: isProviderEnabled(id)
      ? '已配置，点击后跳转到官方扫码页'
      : id === 'wechat'
        ? '需在 .env 配置 WECHAT_APP_ID / WECHAT_APP_SECRET'
        : '需在 .env 配置 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET',
  }));
}

function requireConfig(provider: ProviderId): void {
  if (isProviderEnabled(provider)) return;
  const label = PROVIDER_LABELS[provider];
  throw new ConfigError(`${label}扫码登录尚未配置`, {
    hint:
      provider === 'wechat'
        ? '请在 .env 填 WECHAT_APP_ID、WECHAT_APP_SECRET，并把回调地址登记到微信开放平台网站应用'
        : '请在 .env 填 DINGTALK_CLIENT_ID、DINGTALK_CLIENT_SECRET，并在钉钉后台登记回调域名',
    redirectUri: redirectUriOf(provider),
  });
}

export function buildAuthorizeUrl(provider: ProviderId, state: string): string {
  requireConfig(provider);
  if (provider === 'wechat') {
    const params = new URLSearchParams({
      appid: env.auth.wechat.appId,
      redirect_uri: env.auth.wechat.redirectUri,
      response_type: 'code',
      scope: 'snsapi_login',
      state,
      lang: 'cn',
    });
    return `${WECHAT_AUTHORIZE}?${params.toString()}#wechat_redirect`;
  }
  const params = new URLSearchParams({
    redirect_uri: env.auth.dingtalk.redirectUri,
    response_type: 'code',
    client_id: env.auth.dingtalk.clientId,
    scope: env.auth.dingtalk.scope,
    state,
    prompt: 'consent',
  });
  return `${DINGTALK_AUTHORIZE}?${params.toString()}`;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  upstream: string = '第三方服务',
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new UpstreamError(`${upstream}返回的不是 JSON（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      // 上游报错体只截取一小段，且经过 logger 的脱敏规则；不回传完整响应
      logger.warn('oauth upstream rejected', { upstream, status: response.status });
      throw new UpstreamError(`${upstream}拒绝了请求（HTTP ${response.status}）`, {
        snippet: text.slice(0, 160),
      });
    }
    return data;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(`连不上${upstream}，请检查网络与回调域名配置`, {
      detail: (err as Error).message,
    });
  } finally {
    clearTimeout(timer);
  }
}

interface WechatTokenResponse {
  access_token?: string;
  openid?: string;
  unionid?: string;
  scope?: string;
  errcode?: number;
  errmsg?: string;
}

interface WechatUserResponse {
  openid?: string;
  unionid?: string;
  nickname?: string;
  headimgurl?: string;
  errcode?: number;
  errmsg?: string;
}

interface DingtalkTokenResponse {
  accessToken?: string;
  expireIn?: number;
  refreshToken?: string;
  corpId?: string;
  code?: string;
  message?: string;
}

interface DingtalkUserResponse {
  unionId?: string;
  openId?: string;
  nick?: string;
  avatarUrl?: string;
  code?: string;
  message?: string;
}

async function wechatIdentity(code: string): Promise<ExternalIdentity> {
  const params = new URLSearchParams({
    appid: env.auth.wechat.appId,
    secret: env.auth.wechat.appSecret,
    code,
    grant_type: 'authorization_code',
  });
  const token = await fetchJson<WechatTokenResponse>(
    `${WECHAT_TOKEN}?${params.toString()}`,
    {},
    '微信',
  );
  if (!token.access_token || !token.openid) {
    throw new UpstreamError(`微信换取授权凭证失败（${token.errcode ?? 'unknown'}）`, {
      hint: token.errcode === 40029 ? 'code 无效或已被使用，请重新扫码' : token.errmsg,
    });
  }

  // 昵称/头像是可选的：scope 已拿到就补，失败不阻断登录，身份以 openid/unionid 为准
  let nickname: string | null = null;
  let avatar: string | null = null;
  try {
    const infoParams = new URLSearchParams({
      access_token: token.access_token,
      openid: token.openid,
      lang: 'zh_CN',
    });
    const info = await fetchJson<WechatUserResponse>(
      `${WECHAT_USERINFO}?${infoParams.toString()}`,
      {},
      '微信',
    );
    if (!info.errcode) {
      nickname = info.nickname ?? null;
      avatar = info.headimgurl ?? null;
    }
  } catch (err) {
    logger.warn('wechat userinfo unavailable', { message: (err as Error).message });
  }

  const subject = token.unionid || token.openid;
  return {
    provider: 'wechat',
    subject,
    openId: token.openid,
    unionId: token.unionid ?? null,
    displayName: nickname,
    avatarUrl: avatar,
  };
}

async function dingtalkIdentity(code: string): Promise<ExternalIdentity> {
  const token = await fetchJson<DingtalkTokenResponse>(DINGTALK_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: env.auth.dingtalk.clientId,
      clientSecret: env.auth.dingtalk.clientSecret,
      code,
      grantType: 'authorization_code',
    }),
  }, '钉钉');
  if (!token.accessToken) {
    throw new UpstreamError(`钉钉换取用户凭证失败（${token.code ?? 'unknown'}）`, {
      hint: token.code === 'invalidParameter.code' ? 'authCode 无效或已使用，请重新扫码' : token.message,
    });
  }

  const info = await fetchJson<DingtalkUserResponse>(DINGTALK_USERINFO, {
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      'x-acs-dingtalk-access-token': token.accessToken,
    },
  }, '钉钉通讯录');
  if (info.code && !info.unionId && !info.openId) {
    throw new UpstreamError(`钉钉未返回用户身份（${info.code}）`, {
      hint: '请在钉钉开发者后台为应用申请「通讯录个人信息读权限」，并确认 scope 包含 openid',
      detail: info.message,
    });
  }
  const subject = info.unionId || info.openId;
  if (!subject) throw new UpstreamError('钉钉未返回 unionId / openId，无法建立用户身份');
  return {
    provider: 'dingtalk',
    subject,
    openId: info.openId ?? null,
    unionId: info.unionId ?? null,
    displayName: info.nick ?? null,
    avatarUrl: info.avatarUrl ?? null,
  };
}

/** 用回调里的临时 code 换回统一身份；code 由平台保证一次性，这里不缓存 */
export async function exchangeCode(provider: ProviderId, code: string): Promise<ExternalIdentity> {
  requireConfig(provider);
  if (!code || code.length > 512) throw new UpstreamError('回调缺少有效的授权码');
  return provider === 'wechat' ? wechatIdentity(code) : dingtalkIdentity(code);
}
