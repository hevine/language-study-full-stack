-- 写作 / 口语练习：题目缓存 + 批改记录

CREATE TABLE IF NOT EXISTS practice_prompts (
  id         TEXT PRIMARY KEY,
  plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day_id     TEXT NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  source     TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (day_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_practice_prompts_plan ON practice_prompts(plan_id, created_at DESC);

CREATE TABLE IF NOT EXISTS practice_attempts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  plan_id           TEXT NOT NULL,
  day_id            TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  prompt_title      TEXT NOT NULL,
  submission        TEXT NOT NULL,
  submission_source TEXT NOT NULL DEFAULT 'typed',
  duration_seconds  INTEGER,
  overall           REAL NOT NULL,
  band_value        REAL NOT NULL,
  band_label        TEXT NOT NULL,
  band_note         TEXT NOT NULL DEFAULT '',
  dimensions        TEXT NOT NULL,
  feedback          TEXT NOT NULL,
  stats             TEXT NOT NULL,
  source            TEXT NOT NULL,
  model             TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_task ON practice_attempts(day_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_plan ON practice_attempts(plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_kind ON practice_attempts(user_id, kind, created_at DESC);
