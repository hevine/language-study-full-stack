/**
 * Standalone Loop DB：用 better-sqlite3 本地文件，复用 018_loop.sql 建表。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLoopStore, type LoopStore } from '../../loop/store';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS loop_documents (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'local',
  lang        TEXT NOT NULL DEFAULT 'en',
  kind        TEXT NOT NULL DEFAULT 'essay',
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'agent',
  run_id      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loop_documents_user ON loop_documents(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS loop_cards (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL DEFAULT 'local',
  document_id   TEXT NOT NULL DEFAULT '',
  artifact_id   TEXT NOT NULL,
  run_id        TEXT,
  lang          TEXT NOT NULL DEFAULT 'en',
  kind          TEXT NOT NULL,
  front         TEXT NOT NULL,
  back          TEXT NOT NULL,
  context       TEXT,
  rule_id       TEXT,
  source_ref    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  ease          REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 1,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  good_streak   INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loop_cards_due ON loop_cards(user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_loop_cards_doc ON loop_cards(user_id, document_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_cards_unique
  ON loop_cards(user_id, artifact_id, kind, front);

CREATE TABLE IF NOT EXISTS loop_card_events (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL DEFAULT 'local',
  card_id  TEXT NOT NULL,
  at       TEXT NOT NULL,
  grade    INTEGER NOT NULL,
  ms       INTEGER NOT NULL DEFAULT 0,
  mode     TEXT NOT NULL DEFAULT 'review'
);
CREATE INDEX IF NOT EXISTS idx_loop_events_card ON loop_card_events(user_id, card_id, at);
CREATE INDEX IF NOT EXISTS idx_loop_events_time ON loop_card_events(user_id, at);

CREATE TABLE IF NOT EXISTS loop_artifacts (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL DEFAULT 'local',
  run_id             TEXT NOT NULL,
  document_id        TEXT NOT NULL DEFAULT '',
  type               TEXT NOT NULL,
  title              TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'draft',
  data_json          TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  adopted_at         TEXT,
  parent_artifact_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_loop_artifacts_user ON loop_artifacts(user_id, created_at DESC);
`;

export interface StandaloneLoopDeps {
  db: Database.Database;
  store: LoopStore;
}

export function createStandaloneLoopDeps(dataDir: string): StandaloneLoopDeps {
  const loopDir = path.join(dataDir, 'loop');
  fs.mkdirSync(loopDir, { recursive: true });

  const dbPath = path.join(loopDir, 'loop.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(MIGRATION_SQL);

  const store = createLoopStore(db);

  return { db, store };
}
