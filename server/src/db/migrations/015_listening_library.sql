-- 自建听力库：用户上传的自有整段音频（自购书配套录音等），按账号隔离。
-- 音频本体不进 SQLite：35MB 级二进制放 DATA_DIR/listening/<user>/<id><ext>，
-- 表里只存元数据，列表接口因此保持轻量。
CREATE TABLE IF NOT EXISTS listening_materials (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  language     TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  title        TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  file_size    INTEGER NOT NULL DEFAULT 0,
  mime         TEXT NOT NULL DEFAULT '',
  ext          TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listening_user_lang
  ON listening_materials(user_id, language, created_at DESC);
