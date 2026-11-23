-- @foreign-keys-off
-- 016 · 认证扩展：自助注册 / 角色体系 / 账号安全
--
-- 为什么重建 users 表：SQLite 无法用 ALTER 修改 CHECK 约束，也无法把普通列改成
-- COLLATE NOCASE UNIQUE。014 已上线不能改，这里按「只增不改」原则另起迁移重建。
--
-- 变更点：
--   1) role 从 ('admin','user') 扩展为 ('admin','user','student','teacher')，
--      保留旧值以兼容历史数据与扫码建号逻辑；自助注册只能选 student / teacher。
--   2) username 改为 COLLATE NOCASE UNIQUE —— 大小写不敏感，杜绝 Foo / foo 两个账号。
--   3) 预留 email / phone 列（部分唯一索引，NULL 不冲突），暂不启用验证与找回。
--   4) jlpt_level 预留教师能力等级（N1–N5），教学能力/证书/测评后续迭代启用。
--   5) failed_attempts / locked_until 支撑账号级失败锁定（连续失败 5 次锁 15 分钟）。
--
-- 注意：本文件首行标记让迁移框架在事务外临时关闭外键，重建完成后立刻恢复。
--       历史数据逐列照搬，user_id 全部保持不变，业务数据零迁移。

CREATE TABLE users_016 (
  id              TEXT PRIMARY KEY,
  username        TEXT COLLATE NOCASE UNIQUE,
  password_hash   TEXT,
  display_name    TEXT NOT NULL DEFAULT '学员',
  avatar_url      TEXT,
  role            TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('admin', 'user', 'student', 'teacher')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'pending', 'disabled')),
  provider_hint   TEXT,
  email           TEXT,
  phone           TEXT,
  jlpt_level      TEXT CHECK (jlpt_level IS NULL OR jlpt_level IN ('N1','N2','N3','N4','N5')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

INSERT INTO users_016 (
  id, username, password_hash, display_name, avatar_url, role, status,
  provider_hint, last_login_at, created_at, updated_at
)
SELECT
  id, username, password_hash, display_name, avatar_url, role, status,
  provider_hint, last_login_at, created_at, updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_016 RENAME TO users;

-- 014 的索引随旧表一起消失，这里重建并补上预留列的唯一索引
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_locked ON users(locked_until) WHERE locked_until IS NOT NULL;
