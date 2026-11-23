import { Router } from 'express';
import { env } from '../config/env';
import { enforceAuth, optionalAuthenticate } from '../middleware/auth';
import { authRouter } from './auth';
import { aiRouter } from './ai';
import { asrRouter } from './asr';
import { catalogRouter } from './catalog';
import { examCalendarRouter } from './examCalendar';
import { examImportsRouter } from './examImports';
import { examSessionsRouter } from './examSessions';
import { examsRouter } from './exams';
import { daysRouter } from './days';
import { explainVideosRouter } from './explainVideos';
import { lexiconRouter } from './lexicon';
import { listeningRouter } from './listening';
import { materialsRouter } from './materials';
import { pathsRouter } from './paths';
import { plansRouter } from './plans';
import { practiceRouter } from './practice';
import { settingsRouter } from './settings';
import { healthRouter, statsRouter } from './stats';
import { tasksRouter } from './tasks';
import { vocabRouter } from './vocab';
import { voicesRouter } from './voices';

export const apiRouter = Router();

// 健康检查永远公开；其余路由一律先尝试解析令牌，把数据归属绑定到请求作用域
apiRouter.use(healthRouter);
apiRouter.use(optionalAuthenticate);
apiRouter.use(authRouter);

// AUTH_REQUIRED=true 时，authRouter 里已放行的端点不受影响，所有业务接口都要登录
if (env.auth.required) apiRouter.use(enforceAuth);

apiRouter.use(examCalendarRouter);
apiRouter.use(examSessionsRouter);
apiRouter.use(examsRouter);
apiRouter.use(examImportsRouter);
apiRouter.use(catalogRouter);
apiRouter.use(plansRouter);
apiRouter.use(pathsRouter);
apiRouter.use(daysRouter);
apiRouter.use(tasksRouter);
apiRouter.use(explainVideosRouter);
apiRouter.use(aiRouter);
apiRouter.use(asrRouter);
apiRouter.use(practiceRouter);
apiRouter.use(vocabRouter);
apiRouter.use(voicesRouter);
apiRouter.use(lexiconRouter);
apiRouter.use(materialsRouter);
apiRouter.use(listeningRouter);
apiRouter.use(statsRouter);
apiRouter.use(settingsRouter);
