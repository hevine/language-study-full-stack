import express, { Router } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { NotFoundError, ValidationError } from '../lib/errors';
import { requireLanguage } from '../domain/language';
import { createExamImportJob, getExamImportJob, IMPORT_EXTENSIONS } from '../services/examImport';
import { deleteImportedPaper, listImportedPapers } from '../repositories/exams';

export const examImportsRouter = Router();

const MAX_BYTES = 120 * 1024 * 1024;

const decodeName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const JobQuery = z.object({
  language: z.enum(['en', 'ja', 'ko']).optional(),
});

/** 上传原卷：请求体是文件原始字节，文件名与选项走 query（和「我的教材」一致，不引入 multipart 依赖） */
examImportsRouter.post(
  '/exam-imports',
  express.raw({ type: () => true, limit: MAX_BYTES }),
  asyncHandler(async (req, res) => {
    const language = requireLanguage(req.query.language);
    const fileName = decodeName(req.query.name);
    if (!fileName) throw new ValidationError('缺少文件名（query.name）');

    const ext = path.extname(fileName).toLowerCase();
    if (!IMPORT_EXTENSIONS.has(ext)) {
      throw new ValidationError(
        `暂不支持 ${ext || '该'} 格式。可导入 PDF / DOCX / EPUB / TXT / MD / HTML，或已整理好的 JSON。`,
      );
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ValidationError('没有收到文件内容');
    if (buffer.length > MAX_BYTES) throw new ValidationError('文件超过 120MB 上限');

    const year = Number(decodeName(req.query.year));
    if (!Number.isInteger(year) || year < 1990 || year > 2100) {
      throw new ValidationError('年份需要是 1990–2100 之间的整数');
    }

    const paperTypeRaw = decodeName(req.query.paperType);
    const paperType = paperTypeRaw === 'mock' || paperTypeRaw === 'ai' ? paperTypeRaw : 'real';
    const ocrRaw = decodeName(req.query.ocr);
    const ocrMode = ocrRaw === 'force' || ocrRaw === 'off' ? ocrRaw : 'auto';

    const job = createExamImportJob({
      buffer,
      fileName,
      language,
      year,
      title: decodeName(req.query.title) || undefined,
      examName: decodeName(req.query.examName) || undefined,
      levelLabel: decodeName(req.query.levelLabel) || undefined,
      paperType,
      ocrMode,
    });

    res.status(202).json({ job });
  }),
);

/** 已导入的卷子（只列从设置页上传的那些） */
examImportsRouter.get(
  '/exam-imports',
  asyncHandler(async (req, res) => {
    const { language } = JobQuery.parse(req.query ?? {});
    if (!language) throw new ValidationError('缺少 language 参数');
    res.json({ papers: listImportedPapers(language) });
  }),
);

/** 轮询导入进度：OCR 页码、分段进度、结果与警告都在这里 */
examImportsRouter.get(
  '/exam-imports/jobs/:id',
  asyncHandler(async (req, res) => {
    const job = getExamImportJob(req.params.id);
    if (!job) throw new NotFoundError('这次导入任务不存在或已过期');
    res.json({ job });
  }),
);

examImportsRouter.delete(
  '/exam-imports/:id',
  asyncHandler(async (req, res) => {
    const removed = deleteImportedPaper(req.params.id);
    if (!removed) throw new NotFoundError('这份卷子不存在');
    res.json({ ok: true });
  }),
);
