CREATE TABLE IF NOT EXISTS profile (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '学员',
  goal_note    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  language           TEXT NOT NULL,
  exam_id            TEXT NOT NULL,
  exam_name          TEXT NOT NULL,
  current_level_id   TEXT NOT NULL,
  current_level_name TEXT NOT NULL,
  target_score       REAL NOT NULL,
  target_label       TEXT NOT NULL,
  start_date         TEXT NOT NULL,
  exam_date          TEXT NOT NULL,
  weeks              INTEGER NOT NULL,
  hours_per_week     REAL NOT NULL,
  daily_minutes      INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  feasibility        TEXT NOT NULL,
  roadmap            TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status, created_at DESC);

CREATE TABLE IF NOT EXISTS plan_days (
  id         TEXT PRIMARY KEY,
  plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  week_index INTEGER NOT NULL,
  day_index  INTEGER NOT NULL,
  phase      TEXT NOT NULL,
  phase_name TEXT NOT NULL,
  theme      TEXT NOT NULL,
  focus      TEXT NOT NULL,
  tasks      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, date)
);

CREATE INDEX IF NOT EXISTS idx_plan_days_date ON plan_days(plan_id, date);

CREATE TABLE IF NOT EXISTS day_contents (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day_id         TEXT NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  language       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  translation    TEXT NOT NULL,
  reading_script TEXT NOT NULL,
  vocab          TEXT NOT NULL,
  questions      TEXT NOT NULL,
  est_minutes    INTEGER NOT NULL DEFAULT 10,
  source         TEXT NOT NULL,
  model          TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (day_id, kind)
);

CREATE TABLE IF NOT EXISTS vocab_items (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  language      TEXT NOT NULL,
  term          TEXT NOT NULL,
  reading       TEXT,
  pos           TEXT,
  meaning       TEXT NOT NULL,
  example       TEXT,
  source        TEXT,
  ease          REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 1,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, language, term)
);

CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab_items(user_id, language, due_date);

CREATE TABLE IF NOT EXISTS study_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  plan_id    TEXT,
  day_id     TEXT,
  task_id    TEXT,
  kind       TEXT NOT NULL,
  minutes    INTEGER NOT NULL DEFAULT 0,
  score      REAL,
  log_date   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_day ON study_logs(day_id, task_id);
CREATE INDEX IF NOT EXISTS idx_logs_created ON study_logs(user_id, log_date);
