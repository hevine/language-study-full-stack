-- 升级自测：按语种收纳历年真题（精选卷），记录每一次模考作答
--
-- 三层结构：
--   exam_papers    一份卷子（语种 + 年份 + 级别 + 时长）
--   exam_items     卷子里的题目（题干、材料、选项、答案、解析）
--   exam_attempts  一次作答（开始时间、交卷时间、用时、答案、得分）

CREATE TABLE IF NOT EXISTS exam_papers (
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
);

CREATE INDEX IF NOT EXISTS idx_exam_papers_lang ON exam_papers(language, year DESC, sort_idx);

CREATE TABLE IF NOT EXISTS exam_items (
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
  explanation TEXT NOT NULL DEFAULT '',
  UNIQUE (paper_id, idx)
);

CREATE TABLE IF NOT EXISTS exam_attempts (
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
);

CREATE INDEX IF NOT EXISTS idx_exam_attempts_lang
  ON exam_attempts(user_id, language, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_exam_attempts_paper
  ON exam_attempts(user_id, paper_id, submitted_at DESC);
