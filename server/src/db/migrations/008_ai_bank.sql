-- AI 加练：把大模型按「语种 + 任务类型 + 级别 + 主题」生成的练习落库
--
-- 两层结构：
--   ai_gen_runs    一次生成动作（含提示词缓存键、来源模型、token 消耗），用于「5 分钟内不重复生成」
--   ai_bank_items  真正入库的题目/单词/句子，按内容指纹去重，越用越厚

CREATE TABLE IF NOT EXISTS ai_gen_runs (
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

CREATE INDEX IF NOT EXISTS idx_ai_runs_key ON ai_gen_runs(user_id, cache_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_gen_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_bank_items (
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

CREATE INDEX IF NOT EXISTS idx_ai_items_lookup ON ai_bank_items(user_id, language, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_items_run ON ai_bank_items(run_id);
