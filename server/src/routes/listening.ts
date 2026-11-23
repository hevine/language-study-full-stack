/**
 * 听力库接口：上传自有音频 → 登记元数据 + 落盘，列表/重命名/删除按当前账号隔离。
 *
 * 播放文件单独走 /listening/materials/:id/file：鉴权只认 Authorization 头，
 * <audio> 无法自带头，所以前端带 token fetch 成 Blob 再交给播放器；
 * 接口本身仍严格按 user_id 取文件，不给跨账号越权的口子。
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { asyncHandler } from '../lib/http';
import { NotFoundError, ValidationError } from '../lib/errors';
import { requireLanguage } from '../domain/language';
import {
  ALLOWED_AUDIO_EXT,
  deleteListeningMaterial,
  getListeningMaterial,
  listListeningMaterials,
  saveListeningMaterial,
  storagePathFor,
  updateListeningMaterial,
} from '../repositories/listening';

export const listeningRouter: Router = express.Router();

const MAX_BYTES = 300 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

const decodeName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const durationOf = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 86400) : 0;
};

listeningRouter.post(
  '/listening/materials',
  express.raw({ type: () => true, limit: MAX_BYTES }),
  asyncHandler(async (req, res) => {
    const language = requireLanguage(req.query.language);
    const fileName = decodeName(req.query.name);
    if (!fileName) throw new ValidationError('缺少文件名（query.name）');

    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED_AUDIO_EXT.has(ext)) {
      throw new ValidationError('暂不支持该格式，请上传 MP3 / M4A / AAC / WAV / OGG / FLAC');
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new ValidationError('没有收到文件内容');
    if (body.length > MAX_BYTES) throw new ValidationError('文件超过 300MB 上限');

    const material = saveListeningMaterial({
      language,
      title: decodeName(req.query.title).trim() || path.basename(fileName, ext) || '未命名听力',
      fileName,
      fileSize: body.length,
      mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      ext,
      durationSec: durationOf(req.query.durationSec),
      buffer: body,
    });

    res.status(201).json({ material });
  }),
);

listeningRouter.get(
  '/listening/materials',
  asyncHandler(async (req, res) => {
    const language =
      typeof req.query.language === 'string' && req.query.language
        ? requireLanguage(req.query.language)
        : undefined;
    res.json({ materials: listListeningMaterials(language) });
  }),
);

listeningRouter.get(
  '/listening/materials/:id/file',
  asyncHandler(async (req, res) => {
    const item = getListeningMaterial(req.params.id);
    if (!item) throw new NotFoundError('听力资料不存在');
    const filePath = storagePathFor(item.id, item.ext);
    if (!fs.existsSync(filePath)) throw new NotFoundError('音频文件已丢失，请重新上传');

    res.setHeader('Content-Type', item.mime || 'application/octet-stream');
    res.setHeader('Content-Length', String(item.fileSize));
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
  }),
);

listeningRouter.patch(
  '/listening/materials/:id',
  asyncHandler(async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
    if (title !== undefined && !title) throw new ValidationError('标题不能为空');
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : undefined;
    const material = updateListeningMaterial(req.params.id, {
      ...(title !== undefined ? { title } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!material) throw new NotFoundError('听力资料不存在');
    res.json({ material });
  }),
);

listeningRouter.delete(
  '/listening/materials/:id',
  asyncHandler(async (req, res) => {
    const removed = deleteListeningMaterial(req.params.id);
    if (!removed) throw new NotFoundError('听力资料不存在');
    res.json({ ok: true });
  }),
);
