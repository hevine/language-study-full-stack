-- 自建教材库：用户上传的自有电子书，解析为「章节 + 词条」，仅本地单用户学习使用
CREATE TABLE IF NOT EXISTS materials (
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
);

CREATE INDEX IF NOT EXISTS idx_materials_lang ON materials(language, created_at DESC);

CREATE TABLE IF NOT EXISTS material_units (
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

CREATE TABLE IF NOT EXISTS material_words (
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

CREATE INDEX IF NOT EXISTS idx_material_words_unit ON material_words(material_id, unit_idx);

-- 教材词条不允许跨语种串写：language 由 materials 表约束，此处只做兜底
CREATE TRIGGER IF NOT EXISTS trg_material_words_guard
BEFORE INSERT ON material_words
FOR EACH ROW
WHEN (SELECT language FROM materials WHERE id = NEW.material_id) NOT IN ('en', 'ja', 'ko')
BEGIN
  SELECT RAISE(ABORT, 'material language not supported');
END;
