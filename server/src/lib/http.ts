import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { ValidationError } from '../lib/errors';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** 校验路径参数，失败时抛出统一的 ValidationError */
export function parseParams<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  return parseBody(schema, value);
}

/** 校验请求体，失败时抛出统一的 ValidationError */
export function parseBody<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError(
        '请求参数不合法',
        err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    throw err;
  }
}
