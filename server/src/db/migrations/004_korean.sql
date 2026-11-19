-- 韩语（TOPIK）语种上线：语言白名单从 en/ja 扩到 en/ja/ko。
-- SQLite 触发器无法 ALTER，这里删除重建。
DROP TRIGGER IF EXISTS trg_vocab_language_insert;
DROP TRIGGER IF EXISTS trg_vocab_language_update;

CREATE TRIGGER trg_vocab_language_insert
BEFORE INSERT ON vocab_items
WHEN NEW.language NOT IN ('en', 'ja', 'ko')
BEGIN
  SELECT RAISE(ABORT, 'vocab_items.language 只允许 en、ja 或 ko');
END;

CREATE TRIGGER trg_vocab_language_update
BEFORE UPDATE OF language ON vocab_items
WHEN NEW.language NOT IN ('en', 'ja', 'ko')
BEGIN
  SELECT RAISE(ABORT, 'vocab_items.language 只允许 en、ja 或 ko');
END;
