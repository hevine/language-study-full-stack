import { createApp } from './app';
import { env } from './config/env';
import { closeDb, runMigrations } from './db';
import { logger } from './lib/logger';
import { tightenPermissions } from './lib/secret';
import { ensureExamBank } from './repositories/exams';
import { bootstrapAuth } from './services/auth';
import { llmStatus } from './services/llm';
import { migrateLegacyKeys } from './services/keyPool';
import { migrateLegacyAsr } from './services/asrPool';
import { ensureLocalAsrPoolLine, warmLocalAsr } from './services/localAsr';

function bootstrap(): void {
  runMigrations();
  // 用户主表初始化必须在迁移之后、其它业务之前：把历史数据归属的 'local' 注册成管理员
  bootstrapAuth();
  // 内置的升级自测真题库：补齐缺失的卷子、刷新题目内容（作答记录只存选项下标，不受影响）
  ensureExamBank();
  // 旧版本把 Key 明文写在 settings 里，这里加密封存进号池并把原值抹掉
  migrateLegacyKeys();
  // 旧版单条 ASR 线路（settings.asr.*）搬进识别号池
  migrateLegacyAsr();
  // 装了本地 SenseVoice 兜底就把线路补进号池（已存在则跳过），随后后台预热
  ensureLocalAsrPoolLine();
  tightenPermissions();

  const app = createApp();
  const server = app.listen(env.port, env.host, () => {
    const status = llmStatus();
    logger.info('server started', {
      url: `http://${env.host}:${env.port}`,
      mode: env.nodeEnv,
      db: env.dbPath,
      llm: status.configured ? `${status.model} @ ${status.baseUrl}` : 'demo-mode(内置题库)',
      pool: `${status.pool.ready}/${status.pool.total} 条线路可用`,
    });
    if (env.host !== '127.0.0.1' && env.host !== 'localhost' && env.host !== '::1') {
      logger.warn('服务监听在非回环地址：同网络的其他设备也能调用你的模型额度，请确认这是你要的', {
        host: env.host,
      });
    }
    // 号池里排了本地兜底线路就先把它拉起来预热，别等真正要用时才冷启动
    warmLocalAsr();
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: (reason as Error)?.message ?? String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { message: err.message, stack: err.stack });
  });
}

bootstrap();
