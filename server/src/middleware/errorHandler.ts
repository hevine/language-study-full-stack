import type { NextFunction, Request, Response } from 'express';
import { toErrorPayload } from '../lib/errors';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: '接口不存在', requestId: req.requestId },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const { status, payload } = toErrorPayload(err, req.requestId ?? 'unknown');

  if (status >= 500) {
    req.log?.error('unhandled error', {
      code: payload.error.code,
      message: (err as Error)?.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : (err as Error)?.stack,
    });
  }

  if (res.headersSent) return;
  res.status(status).json(payload);
}
