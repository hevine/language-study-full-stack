-- 音色库：应用内的音色条目，按 user_id + language 严格隔离。
-- 这里的「系统音色」只是记录浏览器 Web Speech 声音的引用（voiceURI / 名字），
-- 删除记录绝不会改动操作系统里安装的声音。
-- provider = browser | cloud；cloud 走 OpenAI 兼容 /audio/speech，api_key 存 AES 密文。

CREATE TABLE IF NOT EXISTS voices (
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

CREATE INDEX IF NOT EXISTS idx_voices_user_lang ON voices(user_id, language, is_default);

-- 场景 → 音色：单词 / 长难句 / 精读 / 听力可以各自用不同声音
CREATE TABLE IF NOT EXISTS voice_assignments (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  scene TEXT NOT NULL CHECK (scene IN ('word', 'sentence', 'article', 'listening')),
  voice_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language, scene)
);

-- 每个语种自己的试听语料与全局语速
CREATE TABLE IF NOT EXISTS voice_prefs (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  sample_text TEXT NOT NULL DEFAULT '',
  global_rate REAL NOT NULL DEFAULT 0.9,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language)
);
