-- =============================================================
-- 外语考证宝典 · 数据库结构导出（SQLite，schema-only）
-- 导出时间：2026-11-08T06:21:40.582Z
-- 表数量：21    索引：22
--
-- 说明：
-- 1. 本文件仅包含 DDL（结构），不含任何业务数据、不含任何密钥内容。
-- 2. llm_keys 表只导出结构，密钥字段在库内为加密串，此处不导出任何行数据。
-- 3. user_id 字段全部存在，但本项目为单用户本地应用，
--    实际取值恒为常量 'local'（见 server/src/repositories/plans.ts: LOCAL_USER）。
-- 4. 无 users 表：用户档案在 profile 表（单行）。
-- 5. 无独立 questions 表：题目分散在 exam_items / ai_bank_items / practice_prompts。
-- 6. 无逐题作答表：整卷作答明细存于 exam_attempts.answers（JSON 文本）。
-- =============================================================

PRAGMA foreign_keys = ON;

-- ---------- profile ----------
CREATE TABLE profile (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '学员',
  goal_note    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ---------- plans ----------
CREATE TABLE plans (
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

-- ---------- plan_days ----------
CREATE TABLE plan_days (
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

-- ---------- day_contents ----------
CREATE TABLE day_contents (
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

-- ---------- materials ----------
CREATE TABLE materials (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  language   TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  title      TEXT NOT NULL,
  format     TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  file_size  INTEGER NOT NULL DEFAULT 0,
  unit_count INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  char_count INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'ready',
  note       TEXT,
  created_at TEXT NOT NULL
, level TEXT, kind TEXT NOT NULL DEFAULT 'textbook', origin TEXT NOT NULL DEFAULT 'upload');

-- ---------- material_units ----------
CREATE TABLE material_units (
  id          TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  char_count  INTEGER NOT NULL DEFAULT 0,
  page_from   INTEGER,
  page_to     INTEGER,
  UNIQUE (material_id, idx)
);

-- ---------- material_words ----------
CREATE TABLE material_words (
  id          TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  reading     TEXT,
  pos         TEXT,
  meaning     TEXT,
  example     TEXT,
  unit_idx    INTEGER NOT NULL DEFAULT 0,
  freq        INTEGER NOT NULL DEFAULT 1,
  in_lexicon  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (material_id, term)
);

-- ---------- vocab_items ----------
CREATE TABLE vocab_items (
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
  created_at    TEXT NOT NULL, level TEXT, theme TEXT, mnemonic TEXT, example_cn TEXT, syn TEXT,
  UNIQUE (user_id, language, term)
);

-- ---------- voices ----------
CREATE TABLE voices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'browser' CHECK (provider IN ('browser', 'cloud')),
  engine_voice TEXT NOT NULL DEFAULT '',
  match_hint TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  voice_id TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  rate REAL NOT NULL DEFAULT 0.9,
  pitch REAL NOT NULL DEFAULT 1,
  volume REAL NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('system', 'preset', 'ai', 'custom')),
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------- voice_prefs ----------
CREATE TABLE voice_prefs (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  sample_text TEXT NOT NULL DEFAULT '',
  global_rate REAL NOT NULL DEFAULT 0.9,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language)
);

-- ---------- voice_assignments ----------
CREATE TABLE voice_assignments (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  scene TEXT NOT NULL CHECK (scene IN ('word', 'sentence', 'article', 'listening')),
  voice_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language, scene)
);

-- ---------- llm_keys ----------
CREATE TABLE llm_keys (
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

-- ---------- ai_gen_runs ----------
CREATE TABLE ai_gen_runs (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  -- 语言|任务类型|级别|考试|主题：同一批次 5 分钟内直接复用，不再调模型
  cache_key         TEXT NOT NULL,
  language          TEXT NOT NULL,
  kind              TEXT NOT NULL,
  level_id          TEXT NOT NULL,
  topic             TEXT NOT NULL,
  plan_id           TEXT,
  day_id            TEXT,
  model             TEXT,
  provider          TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  item_count        INTEGER NOT NULL DEFAULT 0,
  new_count         INTEGER NOT NULL DEFAULT 0,
  -- 这一批的完整内容（缓存复用时直接从这里取，不必再查明细）
  items_json        TEXT NOT NULL DEFAULT '[]',
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'ok',
  notice            TEXT,
  created_at        TEXT NOT NULL
);

-- ---------- ai_bank_items ----------
CREATE TABLE ai_bank_items (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES ai_gen_runs(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  language    TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  kind        TEXT NOT NULL,
  level_id    TEXT NOT NULL,
  topic       TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  -- 归一化内容指纹：同一道题/同一个词不会重复入库
  fingerprint TEXT NOT NULL,
  model       TEXT,
  provider    TEXT,
  plan_id     TEXT,
  day_id      TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, language, fingerprint)
);

-- ---------- exam_papers ----------
CREATE TABLE exam_papers (
  id           TEXT PRIMARY KEY,
  language     TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  year         INTEGER NOT NULL,
  exam_name    TEXT NOT NULL,
  level_label  TEXT NOT NULL,
  title        TEXT NOT NULL,
  -- 来源说明：真题年份场次 / 改编说明，界面上原样展示，避免误认
  source_note  TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL DEFAULT 12,
  sort_idx     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
, paper_type TEXT NOT NULL DEFAULT 'mock', sections_json TEXT NOT NULL DEFAULT '[]', origin_url TEXT NOT NULL DEFAULT '', import_file TEXT NOT NULL DEFAULT '', import_meta TEXT NOT NULL DEFAULT '{}');

-- ---------- exam_items ----------
CREATE TABLE exam_items (
  id          TEXT PRIMARY KEY,
  paper_id    TEXT NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  -- 部分：語彙 / 文法 / 読解 / 词汇 / 阅读 / 어휘 / 문법 / 읽기 …
  section     TEXT NOT NULL,
  stem        TEXT NOT NULL,
  passage     TEXT NOT NULL DEFAULT '',
  options     TEXT NOT NULL,
  -- 正确选项下标（0 起）
  answer      INTEGER NOT NULL,
  explanation TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'choice', section_key TEXT NOT NULL DEFAULT '', audio_text TEXT NOT NULL DEFAULT '', audio_url TEXT NOT NULL DEFAULT '', sample_answer TEXT NOT NULL DEFAULT '', min_words INTEGER NOT NULL DEFAULT 0,
  UNIQUE (paper_id, idx)
);

-- ---------- exam_attempts ----------
CREATE TABLE exam_attempts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  paper_id     TEXT NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  language     TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  submitted_at TEXT,
  -- 实际用时（秒），以客户端计时为准，超时由服务端兜底
  seconds      INTEGER NOT NULL DEFAULT 0,
  answers      TEXT NOT NULL DEFAULT '[]',
  correct      INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active'
, writing TEXT NOT NULL DEFAULT '{}');

-- ---------- practice_prompts ----------
CREATE TABLE practice_prompts (
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

-- ---------- practice_attempts ----------
CREATE TABLE practice_attempts (
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

-- ---------- study_logs ----------
CREATE TABLE study_logs (
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

-- ---------- settings ----------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------- indexes ----------
CREATE INDEX idx_plans_status ON plans(status, created_at DESC);
CREATE INDEX idx_plan_days_date ON plan_days(plan_id, date);
CREATE INDEX idx_vocab_due ON vocab_items(user_id, language, due_date);
CREATE INDEX idx_logs_day ON study_logs(day_id, task_id);
CREATE INDEX idx_logs_created ON study_logs(user_id, log_date);
CREATE INDEX idx_practice_prompts_plan ON practice_prompts(plan_id, created_at DESC);
CREATE INDEX idx_attempts_task ON practice_attempts(day_id, task_id, created_at DESC);
CREATE INDEX idx_attempts_plan ON practice_attempts(plan_id, created_at DESC);
CREATE INDEX idx_attempts_kind ON practice_attempts(user_id, kind, created_at DESC);
CREATE INDEX idx_vocab_lang_level ON vocab_items(user_id, language, level, due_date);
CREATE INDEX idx_materials_lang ON materials(language, created_at DESC);
CREATE INDEX idx_material_words_unit ON material_words(material_id, unit_idx);
CREATE INDEX idx_materials_curriculum
  ON materials(user_id, language, kind, level, created_at DESC);
CREATE INDEX idx_llm_keys_order ON llm_keys(user_id, enabled, priority, created_at);
CREATE INDEX idx_ai_runs_key ON ai_gen_runs(user_id, cache_key, created_at DESC);
CREATE INDEX idx_ai_runs_created ON ai_gen_runs(user_id, created_at DESC);
CREATE INDEX idx_ai_items_lookup ON ai_bank_items(user_id, language, kind, created_at DESC);
CREATE INDEX idx_ai_items_run ON ai_bank_items(run_id);
CREATE INDEX idx_exam_papers_lang ON exam_papers(language, year DESC, sort_idx);
CREATE INDEX idx_exam_attempts_lang
  ON exam_attempts(user_id, language, submitted_at DESC);
CREATE INDEX idx_exam_attempts_paper
  ON exam_attempts(user_id, paper_id, submitted_at DESC);
CREATE INDEX idx_voices_user_lang ON voices(user_id, language, is_default);
