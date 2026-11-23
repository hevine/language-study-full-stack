/**
 * 听力库仓储：按当前请求作用域里的 user_id 隔离。
 *
 * 与教材库的差别：教材上传后要解析正文/词条入库，音频没有可抽的文本，
 * 只登记元数据并把原始字节写入 DATA_DIR/listening/<user>/ 下，
 * 避免把 35MB 级二进制塞进 SQLite。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentUserId } from '../auth/requestScope';
import { env } from '../config/env';
import { db } from '../db';
import type { Language } from '../domain/language';

export const ALLOWED_AUDIO_EXT = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ogg',
  '.flac',
]);

export interface ListeningMaterial {
  id: string;
  language: Language;
  title: string;
  fileName: string;
  fileSize: number;
  mime: string;
  ext: string;
  durationSec: number;
  note: string | null;
  createdAt: string;
}

interface ListeningRow {
  id: string;
  language: string;
  title: string;
  file_name: string;
  file_size: number;
  mime: string;
  ext: string;
  duration_sec: number;
  note: string | null;
  created_at: string;
}

const COLUMNS = `id, language, title, file_name, file_size, mime, ext, duration_sec, note, created_at`;

function toRecord(row: ListeningRow): ListeningMaterial {
  return {
    id: row.id,
    language: row.language as Language,
    title: row.title,
    fileName: row.file_name,
    fileSize: row.file_size,
    mime: row.mime,
    ext: row.ext,
    durationSec: row.duration_sec,
    note: row.note,
    createdAt: row.created_at,
  };
}

/** 用户目录名做白名单化，杜绝 user_id 里的路径分隔符穿越 */
function userDir(userId: string): string {
  const safe = userId.replace(/[^A-Za-z0-9_-]/g, '_') || 'local';
  return path.join(env.dataDir, 'listening', safe);
}

/** 只接受本仓储生成的 id + 白名单扩展名，供路由定位文件 */
export function storagePathFor(id: string, ext: string): string {
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '');
  const safeExt = ALLOWED_AUDIO_EXT.has(ext.toLowerCase()) ? ext.toLowerCase() : '';
  if (!safeId || !safeExt) throw new Error('非法听力文件标识');
  return path.join(userDir(currentUserId()), `${safeId}${safeExt}`);
}

export function listListeningMaterials(language?: Language): ListeningMaterial[] {
  const rows = language
    ? (db
        .prepare(
          `SELECT ${COLUMNS} FROM listening_materials
           WHERE user_id = ? AND language = ? ORDER BY created_at DESC`,
        )
        .all(currentUserId(), language) as ListeningRow[])
    : (db
        .prepare(
          `SELECT ${COLUMNS} FROM listening_materials
           WHERE user_id = ? ORDER BY created_at DESC`,
        )
        .all(currentUserId()) as ListeningRow[]);
  return rows.map(toRecord);
}

export function getListeningMaterial(id: string): ListeningMaterial | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM listening_materials WHERE id = ? AND user_id = ?`)
    .get(id, currentUserId()) as ListeningRow | undefined;
  return row ? toRecord(row) : null;
}

export interface SaveListeningInput {
  language: Language;
  title: string;
  fileName: string;
  fileSize: number;
  mime: string;
  ext: string;
  durationSec: number;
  buffer: Buffer;
}

export function saveListeningMaterial(input: SaveListeningInput): ListeningMaterial {
  const id = randomUUID();
  const dir = userDir(currentUserId());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${id}${input.ext}`);
  fs.writeFileSync(filePath, input.buffer, { mode: 0o600 });

  try {
    db.prepare(
      `INSERT INTO listening_materials
        (id, user_id, language, title, file_name, file_size, mime, ext, duration_sec, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      currentUserId(),
      input.language,
      input.title,
      input.fileName,
      input.fileSize,
      input.mime,
      input.ext,
      input.durationSec,
      new Date().toISOString(),
    );
  } catch (err) {
    // 元数据写失败不能留下孤儿音频文件
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  return getListeningMaterial(id)!;
}

export function updateListeningMaterial(
  id: string,
  patch: { title?: string; note?: string | null; durationSec?: number },
): ListeningMaterial | null {
  const existing = getListeningMaterial(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE listening_materials
     SET title = ?, note = ?, duration_sec = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    patch.title ?? existing.title,
    patch.note === undefined ? existing.note : patch.note,
    patch.durationSec ?? existing.durationSec,
    id,
    currentUserId(),
  );
  return getListeningMaterial(id);
}

export function deleteListeningMaterial(id: string): ListeningMaterial | null {
  const existing = getListeningMaterial(id);
  if (!existing) return null;
  db.prepare('DELETE FROM listening_materials WHERE id = ? AND user_id = ?').run(
    id,
    currentUserId(),
  );
  fs.rmSync(storagePathFor(existing.id, existing.ext), { force: true });
  return existing;
}
