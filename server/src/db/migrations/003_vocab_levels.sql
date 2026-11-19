-- 分级词库：为词汇本补上级别与词条扩展信息，并在库层面锁死语言隔离
ALTER TABLE vocab_items ADD COLUMN level TEXT;
ALTER TABLE vocab_items ADD COLUMN theme TEXT;
ALTER TABLE vocab_items ADD COLUMN mnemonic TEXT;
ALTER TABLE vocab_items ADD COLUMN example_cn TEXT;
ALTER TABLE vocab_items ADD COLUMN syn TEXT;

CREATE INDEX IF NOT EXISTS idx_vocab_lang_level ON vocab_items(user_id, language, level, due_date);

-- 语言只允许 en / ja：任何跨语种写入（比如日语的词写进英语本）直接报错，
-- 这样「英语与日语数据隔离」不依赖应用层是否记得传 language。
CREATE TRIGGER IF NOT EXISTS trg_vocab_language_insert
BEFORE INSERT ON vocab_items
WHEN NEW.language NOT IN ('en', 'ja')
BEGIN
  SELECT RAISE(ABORT, 'vocab_items.language 只允许 en 或 ja');
END;

CREATE TRIGGER IF NOT EXISTS trg_vocab_language_update
BEFORE UPDATE OF language ON vocab_items
WHEN NEW.language NOT IN ('en', 'ja')
BEGIN
  SELECT RAISE(ABORT, 'vocab_items.language 只允许 en 或 ja');
END;
