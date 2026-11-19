-- 分级教材体系：给教材打上级别与类型，让 0 → N2 的多本书按计划进度依次接进每日任务
ALTER TABLE materials ADD COLUMN level TEXT;
ALTER TABLE materials ADD COLUMN kind TEXT NOT NULL DEFAULT 'textbook';
ALTER TABLE materials ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload';

CREATE INDEX IF NOT EXISTS idx_materials_curriculum
  ON materials(user_id, language, kind, level, created_at DESC);
