-- 用户与鉴权：用户主表、第三方身份、刷新令牌会话、扫码票据、审计日志
--
-- 设计要点：
--   1) users 是唯一「真人」主表；一个真人可以有多个 user_identities（微信 + 钉钉），
--      这样同一个人用两个渠道扫码会落到同一账号，而不是产生两份备考数据。
--   2) 外部身份用 (provider, subject) 唯一约束。微信优先用 unionid 做 subject（跨应用稳定），
--      没拿到 unionid 时退回 openid；钉钉用 unionId。open_id / union_id 原样留档便于排障。
--   3) auth_sessions 只存 refresh token 的 SHA-256 摘要，库被拷走也拿不到可用令牌。
--      family_id 把一次登录派生出的所有 refresh 串成一条链，检测到旧令牌重用即整链撤销。
--   4) auth_login_tickets 承载扫码状态机。state 是 OAuth CSRF 随机数，login_code 是
--      回调成功后才生成的一次性兑换码，前端凭 ticket_secret 才能兑换，票据 ID 泄露也拿不到令牌。
--   5) 现有业务表里的 user_id 全是 'local'；本次不改动任何现有表，
--      由 014 之后的 bootstrap 把 'local' 注册为管理员，历史数据原地归属它。

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT UNIQUE,
  password_hash  TEXT,
  display_name   TEXT NOT NULL DEFAULT '学员',
  avatar_url     TEXT,
  role           TEXT NOT NULL DEFAULT 'user'  CHECK (role IN ('admin', 'user')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'disabled')),
  provider_hint  TEXT,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_identities (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('wechat', 'dingtalk')),
  subject       TEXT NOT NULL,
  open_id       TEXT,
  union_id      TEXT,
  display_name  TEXT,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (provider, subject)
);

CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip           TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  replaced_by  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_family ON auth_sessions(family_id);

CREATE TABLE IF NOT EXISTS auth_login_tickets (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('wechat', 'dingtalk')),
  state_hash     TEXT NOT NULL UNIQUE,
  ticket_secret  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'confirmed', 'failed', 'expired', 'consumed')),
  -- 已登录用户把第二个渠道绑到现有账号时，这里记目标用户；空则回调后走「查找或新建」
  bind_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  error_message  TEXT,
  authorize_url  TEXT,
  confirmed_at   TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_expires ON auth_login_tickets(expires_at);

CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  event       TEXT NOT NULL,
  provider    TEXT,
  ip          TEXT,
  user_agent  TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_logs(created_at DESC);
