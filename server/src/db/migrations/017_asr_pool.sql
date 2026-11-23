-- 语音识别（录音转写）号池：与 llm_keys 同构，一条线路 = 一个转录服务地址 + 一把 Key + 一个模型
-- 多条线路按 priority 排队，转写时依次尝试，连不通/额度用尽就自动切下一条并挂冷却。
CREATE TABLE IF NOT EXISTS asr_keys (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL DEFAULT 'local',
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

CREATE INDEX IF NOT EXISTS idx_asr_keys_order ON asr_keys(user_id, enabled, priority, created_at);
