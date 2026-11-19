import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { requestScopeMiddleware } from './auth/requestScope';
import { apiRouter } from './routes';

const DEV_ORIGINS = ['http://localhost:5199', 'http://127.0.0.1:5199'];

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestContext);
  // 必须在所有路由之前：后续中间件与仓储层靠这个作用域判断「数据归属哪个账号」
  app.use(requestScopeMiddleware);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // 显式来源：生产环境同源访问，开发环境仅放行 vite 端口。
  // credentials 打开是为了 dev 直连时 refresh Cookie 能随跨端口请求带上（同源部署走不到 CORS 分支）。
  app.use(cors({ origin: env.isProd ? false : DEV_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', apiRouter);
  app.use('/api', notFoundHandler);

  const hasBuild = fs.existsSync(path.join(env.publicDir, 'index.html'));
  if (hasBuild) {
    app.use(
      express.static(env.publicDir, {
        index: false,
        maxAge: env.isProd ? '1h' : 0,
      }),
    );
    app.get('*', (_req, res) => {
      res.sendFile(path.join(env.publicDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('text/plain; charset=utf-8')
        .send('前端尚未构建。请先运行 `npm run build`，或用 `npm run dev` 同时启动前端开发服务器。');
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
