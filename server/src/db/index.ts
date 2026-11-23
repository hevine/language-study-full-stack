import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../lib/logger';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export const db = new Database(env.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
// 删除或覆盖时把旧内容真正抹掉，避免废弃的 Key 留在空闲页里
db.pragma('secure_delete = ON');

/** 可回滚的顺序迁移：每个 .sql 文件在独立事务中执行并登记版本 */
export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map(
      (row) => row.version,
    ),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // 重建被外键引用的表（如 016 的 users）时，SQLite 要求 foreign_keys 在事务外切换。
    // 用文件首行的 `@foreign-keys-off` 标记声明，迁移体本身仍在一个事务内原子提交。
    const needsFkOff = /^--\s*@foreign-keys-off\b/m.test(sql);
    if (needsFkOff) db.pragma('foreign_keys = OFF');
    try {
      const apply = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          file,
          new Date().toISOString(),
        );
      });
      apply();
      logger.info('migration applied', { file });
    } catch (err) {
      logger.error('migration failed', { file, error: (err as Error).message });
      throw err;
    } finally {
      if (needsFkOff) db.pragma('foreign_keys = ON');
    }
  }
}

export function closeDb(): void {
  try {
    db.close();
  } catch {
    /* 已关闭则忽略 */
  }
}

/** 便于 JSON 字段的读写 */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
