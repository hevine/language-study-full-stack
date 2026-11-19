import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError } from '../lib/errors';
import { buildExamSessions, sessionScheduleNote } from '../catalog/sessions';
import { examLinks } from '../catalog/calendar';

export const examSessionsRouter = Router();

const Query = z.object({
  examId: z.enum(['toefl', 'jlpt', 'topik']),
  years: z.coerce.number().min(1).max(5).default(3),
});

/** 真实考试场次：供设置计划时直接选「哪一年哪一月的那一场」 */
examSessionsRouter.get(
  '/exam-sessions',
  asyncHandler(async (req, res) => {
    const query = parseBody(Query, req.query);
    const sessions = buildExamSessions(query.examId, query.years);
    if (!sessions) throw new NotFoundError('该考试暂不支持场次列表');
    res.json({
      examId: query.examId,
      examName: sessions[0]?.examName ?? '',
      scheduleNote: sessionScheduleNote(query.examId),
      links: examLinks(query.examId),
      sessions,
    });
  }),
);
