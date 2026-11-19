/**
 * 请求作用域：把「当前登录用户」沿异步调用链传下去，让仓储层不用改签名就能按账号隔离数据。
 *
 * 为什么用 AsyncLocalStorage：现有 60 多处仓储调用把用户 ID 写死成 'local'，
 * 逐个改函数签名会把 services / routes 全部污染一遍。ALS 让「谁在调用」成为隐式上下文：
 *   - 中间件在最外层 run(scope, next)，后续所有 await / Promise 自动继承同一 scope；
 *   - 鉴权中间件把解析出的用户写回 scope 对象（引用共享），下游立刻可见；
 *   - 未登录、CLI 脚本、启动期种子任务没有 scope，currentUserId() 回落 LOCAL_USER_ID，
 *     行为与改造前完全一致，历史数据不迁移也不受影响。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { LOCAL_USER_ID, type AuthUser } from './constants';

export interface RequestScope {
  userId: string;
  user: AuthUser | null;
  /** true 表示这次请求带了有效令牌；用于区分「游客」与「令牌失效」 */
  authenticated: boolean;
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** 挂在 requestContext 之后、所有路由之前 */
export function requestScopeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const scope: RequestScope = {
    userId: LOCAL_USER_ID,
    user: null,
    authenticated: false,
    requestId: req.requestId,
  };
  res.locals.authScope = scope;
  storage.run(scope, () => next());
}

function scope(): RequestScope | undefined {
  return storage.getStore();
}

/** 当前请求应归属的数据用户 ID；无请求上下文时回落 'local' */
export function currentUserId(): string {
  return scope()?.userId ?? LOCAL_USER_ID;
}

export function currentAuthUser(): AuthUser | null {
  return scope()?.user ?? null;
}

export function isAuthenticated(): boolean {
  return scope()?.authenticated ?? false;
}

/** 鉴权中间件在验完令牌后调用，一次性写入作用域 */
export function bindCurrentUser(user: AuthUser): void {
  const active = scope();
  if (!active) return;
  active.user = user;
  active.userId = user.id;
  active.authenticated = true;
}

/** 供脚本 / 后台任务显式指定数据归属（例如给某个用户跑批处理） */
export function runAsUser<T>(userId: string, fn: () => T): T {
  const base = scope();
  return storage.run(
    {
      userId,
      user: null,
      authenticated: false,
      requestId: base?.requestId ?? 'background',
    },
    fn,
  );
}
