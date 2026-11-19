export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    message: string,
    options: { code?: string; status?: number; details?: unknown; cause?: unknown; expose?: boolean } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.status = options.status ?? 500;
    this.details = options.details;
    this.expose = options.expose ?? this.status < 500;
    if (options.cause) this.cause = options.cause;
  }
}

export class ValidationError extends AppError {
  constructor(message = '请求参数不合法', details?: unknown) {
    super(message, { code: 'VALIDATION_FAILED', status: 400, details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, { code: 'NOT_FOUND', status: 404 });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = '操作与当前状态冲突') {
    super(message, { code: 'CONFLICT', status: 409 });
    this.name = 'ConflictError';
  }
}

export class UpstreamError extends AppError {
  constructor(message = '上游服务调用失败', details?: unknown) {
    // 上游的报错（Key 无效、模型名不对、额度用尽）正是用户需要看到的，这里对外暴露
    super(message, { code: 'UPSTREAM_FAILED', status: 502, details, expose: true });
    this.name = 'UpstreamError';
  }
}

export class ConfigError extends AppError {
  constructor(message = '配置缺失或无效', details?: unknown) {
    super(message, { code: 'CONFIG_INVALID', status: 503, details });
    this.name = 'ConfigError';
  }
}

/** 未认证 / 令牌失效。前端拿到这个码会触发一次刷新重试，再失败才跳登录页。 */
export class UnauthorizedError extends AppError {
  constructor(message = '请先登录', code = 'UNAUTHORIZED') {
    super(message, { code, status: 401 });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '没有权限执行这个操作', code = 'FORBIDDEN') {
    super(message, { code, status: 403 });
    this.name = 'ForbiddenError';
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = '操作太频繁，请稍后再试', details?: unknown) {
    super(message, { code: 'RATE_LIMITED', status: 429, details });
    this.name = 'TooManyRequestsError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** 把任意异常转换为对外安全的结构，绝不泄漏堆栈或内部细节 */
export function toErrorPayload(err: unknown, requestId: string): { status: number; payload: ErrorPayload } {
  if (isAppError(err)) {
    return {
      status: err.status,
      payload: {
        error: {
          code: err.code,
          message: err.expose ? err.message : '服务暂时不可用，请稍后重试',
          requestId,
          ...(err.expose && err.details !== undefined ? { details: err.details } : {}),
        },
      },
    };
  }

  return {
    status: 500,
    payload: { error: { code: 'INTERNAL_ERROR', message: '服务内部错误，请稍后重试', requestId } },
  };
}
