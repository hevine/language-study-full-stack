import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { loadOrCreateSecret } from '../auth/crypto';

dotenv.config();

/** env 里的布尔值不能用 z.coerce.boolean()：字符串 'false' 会被强转成 true */
const bool = (fallback: 'true' | 'false') =>
  z
    .string()
    .default(fallback)
    .transform((value) => value === 'true' || value === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4399),
  /** 默认只听本机回环：同一局域网的其他设备访问不到你的 Key 与数据 */
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().default('./.data'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  // ---- 用户与鉴权 ----
  /** true 时除白名单外所有 /api 端点都要有效令牌；默认 false，保留本机游客使用习惯 */
  AUTH_REQUIRED: bool('false'),
  AUTH_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  AUTH_REFRESH_TTL_SEC: z.coerce.number().int().min(3600).max(31_536_000).default(2_592_000),
  /** 不填则自动生成在 .data/.authkey（600）。生产建议显式设置，换机器不用带文件 */
  AUTH_JWT_SECRET: z.string().optional(),
  AUTH_ISSUER: z.string().min(1).default('waiyu-baodian'),
  /** 扫码回调的公网基址，必须是微信/钉钉后台登记的 HTTPS 域名 */
  AUTH_PUBLIC_BASE_URL: z.string().optional(),
  /** 只在首次启动时给本地管理员设置密码；之后改密码用 npm run admin:passwd */
  AUTH_ADMIN_PASSWORD: z.string().optional(),
  AUTH_NEW_USER_STATUS: z.enum(['active', 'pending']).default('active'),
  AUTH_TICKET_TTL_SEC: z.coerce.number().int().min(60).max(1800).default(300),
  AUTH_LOGIN_CODE_TTL_SEC: z.coerce.number().int().min(30).max(600).default(90),
  /** 留空则跟随 NODE_ENV：生产 true，开发 false */
  AUTH_COOKIE_SECURE: z.string().optional(),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(3).max(1000).default(10),
  AUTH_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().min(10).max(3600).default(60),

  // ---- 微信开放平台：网站应用扫码登录（QRConnect）----
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  WECHAT_REDIRECT_URI: z.string().optional(),

  // ---- 钉钉开放平台：统一授权登录第三方网站（OAuth2 新版）----
  DINGTALK_CLIENT_ID: z.string().optional(),
  DINGTALK_CLIENT_SECRET: z.string().optional(),
  DINGTALK_REDIRECT_URI: z.string().optional(),
  DINGTALK_SCOPE: z.string().default('openid'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  · ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`[config] 环境变量校验失败，进程终止：\n${detail}\n请参考 .env.example 修正配置。`);
  process.exit(1);
}

const raw = parsed.data;
const rootDir = process.cwd();
const dataDir = path.resolve(rootDir, raw.DATA_DIR);

fs.mkdirSync(dataDir, { recursive: true });
// 数据目录只给当前用户：里面有数据库与主密钥
try {
  fs.chmodSync(dataDir, 0o700);
} catch {
  /* ignore */
}

/** 仅去除尾部斜杠，保留用户填写的完整 base url */
const trimUrl = (value?: string) => (value ? value.replace(/\/+$/, '') : '');

const loopback = raw.HOST === '0.0.0.0' || raw.HOST === '::' ? '127.0.0.1' : raw.HOST;
const publicBaseUrl = trimUrl(raw.AUTH_PUBLIC_BASE_URL) || `http://${loopback}:${raw.PORT}`;
const cookieSecure = raw.AUTH_COOKIE_SECURE
  ? raw.AUTH_COOKIE_SECURE === 'true' || raw.AUTH_COOKIE_SECURE === '1'
  : raw.NODE_ENV === 'production';

const wechatAppId = raw.WECHAT_APP_ID?.trim() ?? '';
const wechatAppSecret = raw.WECHAT_APP_SECRET?.trim() ?? '';
const dingtalkClientId = raw.DINGTALK_CLIENT_ID?.trim() ?? '';
const dingtalkClientSecret = raw.DINGTALK_CLIENT_SECRET?.trim() ?? '';

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  port: raw.PORT,
  host: raw.HOST,
  logLevel: raw.LOG_LEVEL,
  rootDir,
  dataDir,
  dbPath: path.join(dataDir, 'app.db'),
  publicDir: path.resolve(rootDir, 'dist/web'),
  llm: {
    baseUrl: trimUrl(raw.LLM_BASE_URL),
    apiKey: raw.LLM_API_KEY?.trim() ?? '',
    model: raw.LLM_MODEL?.trim() ?? '',
    timeoutMs: raw.LLM_TIMEOUT_MS,
  },
  auth: {
    required: raw.AUTH_REQUIRED,
    accessTtlSec: raw.AUTH_ACCESS_TTL_SEC,
    refreshTtlSec: raw.AUTH_REFRESH_TTL_SEC,
    jwtSecret: loadOrCreateSecret(raw.AUTH_JWT_SECRET, path.join(dataDir, '.authkey')),
    issuer: raw.AUTH_ISSUER,
    audience: 'waiyu-baodian-web',
    publicBaseUrl,
    cookieSecure,
    newUserStatus: raw.AUTH_NEW_USER_STATUS,
    ticketTtlSec: raw.AUTH_TICKET_TTL_SEC,
    loginCodeTtlSec: raw.AUTH_LOGIN_CODE_TTL_SEC,
    rateLimit: { max: raw.AUTH_RATE_LIMIT_MAX, windowSec: raw.AUTH_RATE_LIMIT_WINDOW_SEC },
    adminPassword: raw.AUTH_ADMIN_PASSWORD?.trim() ?? '',
    wechat: {
      enabled: Boolean(wechatAppId && wechatAppSecret),
      appId: wechatAppId,
      appSecret: wechatAppSecret,
      redirectUri:
        trimUrl(raw.WECHAT_REDIRECT_URI) || `${publicBaseUrl}/api/auth/callback/wechat`,
    },
    dingtalk: {
      enabled: Boolean(dingtalkClientId && dingtalkClientSecret),
      clientId: dingtalkClientId,
      clientSecret: dingtalkClientSecret,
      redirectUri:
        trimUrl(raw.DINGTALK_REDIRECT_URI) || `${publicBaseUrl}/api/auth/callback/dingtalk`,
      scope: trimUrl(raw.DINGTALK_SCOPE) || 'openid',
    },
  },
} as const;

export type Env = typeof env;
