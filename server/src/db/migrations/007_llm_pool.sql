-- 模型 Key 号池：一个平台可以放多把 Key，也可以把不同厂商的 Key 排成一条线路
-- key_cipher 是 AES-256-GCM 密文（见 server/src/lib/secret.ts），空字符串表示「不落盘 / 待填写」
CREATE TABLE IF NOT EXISTS llm_keys (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL DEFAULT 'local',
  provider_id     TEXT NOT NULL DEFAULT 'custom',
  label           TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  model           TEXT NOT NULL,
  key_cipher      TEXT NOT NULL DEFAULT '',
  key_masked      TEXT NOT NULL DEFAULT '',
  key_fingerprint TEXT NOT NULL DEFAULT '',
  persist         INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 100,
  status          TEXT NOT NULL DEFAULT 'ready',
  cooldown_until  TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_error_at   TEXT,
  last_used_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_keys_order ON llm_keys(user_id, enabled, priority, created_at);
