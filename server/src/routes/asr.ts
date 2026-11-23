/**
 * 录音转写接口：接收浏览器录制的音频原始字节，服务端调用 ASR 转成目标语言文本。
 *
 * 传输方式沿用项目的「raw bytes + query 元数据」约定（不引 multipart 到浏览器侧）：
 *   POST /asr?language=ja&name=recording.webm
 *   Content-Type: application/octet-stream
 *   Body: <录音字节>
 *
 * Key 只在服务端使用；AUTH_REQUIRED=true 时由全局 enforceAuth 覆盖，
 * 单独再加可选登录校验以兼容游客模式的本机使用习惯。
 */
import express, { type Router } from 'express';
import { requireLanguage } from '../domain/language';
import { ValidationError } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { transcribeAudio } from '../services/asr';

export const asrRouter: Router = express.Router();

/** 口语单次作答一般十几秒；25MB 足够长录音，也避免异常请求 abuse */
const MAX_BYTES = 25 * 1024 * 1024;

const safeName = (value: unknown): string => {
  if (typeof value !== 'string') return 'recording.webm';
  const base = value.split(/[\\/]/).pop() ?? 'recording.webm';
  // 只允许常见音频扩展名，其余统一补 .webm，避免把奇怪后缀传给上游
  return /\.(webm|wav|mp3|mp4|m4a|ogg|aac|flac)$/i.test(base) ? base : `${base}.webm`;
};

asrRouter.post(
  '/asr',
  express.raw({ type: () => true, limit: MAX_BYTES }),
  asyncHandler(async (req, res) => {
    const language = requireLanguage(req.query.language);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ValidationError('没有收到录音内容，请确认麦克风已录制到声音');
    }
    if (body.length > MAX_BYTES) throw new ValidationError('录音文件超过 25MB 上限');

    const result = await transcribeAudio(body, language, safeName(req.query.name));
    res.json(result);
  }),
);
