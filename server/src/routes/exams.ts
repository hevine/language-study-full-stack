import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http';
import { NotFoundError, ValidationError } from '../lib/errors';
import {
  createAttempt,
  deleteImportedPaper,
  getAttempt,
  getPaper,
  listAttempts,
  listItems,
  listPapers,
  saveAttempt,
} from '../repositories/exams';
import { EXAM_END_YEAR, EXAM_START_YEAR } from '../data/exams';

export const examsRouter = Router();

const LANGUAGE = z.enum(['en', 'ja', 'ko']);

const LangQuery = z.object({
  language: LANGUAGE.optional(),
});

const SubmitInput = z.object({
  answers: z.array(z.number().int().min(0).max(9).nullable()).max(400),
  // 写作作答：{ 题目序号: 文本 }
  writing: z.record(z.string(), z.string().max(8000)).optional(),
  seconds: z.number().int().min(0).max(60 * 60 * 6).optional(),
});

/** 试卷列表：年份从 2000 到今年全覆盖，带最好成绩与分项，供「任选哪一年的卷子」 */
examsRouter.get(
  '/exams',
  asyncHandler(async (req, res) => {
    const { language } = LangQuery.parse(req.query ?? {});
    if (!language) throw new ValidationError('缺少 language 参数');
    res.json({
      papers: listPapers(language),
      range: { from: EXAM_START_YEAR, to: EXAM_END_YEAR },
    });
  }),
);

/** 历史自测记录（放在 /exams/:id 之前，避免被当成试卷 id） */
examsRouter.get(
  '/exams/attempts',
  asyncHandler(async (req, res) => {
    const { language } = LangQuery.parse(req.query ?? {});
    if (!language) throw new ValidationError('缺少 language 参数');
    res.json({ attempts: listAttempts(language) });
  }),
);

/** 取卷：作答时不下发答案与解析，避免 DevTools 里提前看到 */
examsRouter.get(
  '/exams/:id',
  asyncHandler(async (req, res) => {
    const paper = getPaper(req.params.id);
    if (!paper) throw new NotFoundError('这份卷子不存在');
    const items = listItems(paper.id).map((item) => ({
      id: item.id,
      idx: item.idx,
      section: item.section,
      sectionKey: item.sectionKey,
      questionNo: item.questionNo,
      kind: item.kind,
      stem: item.stem,
      passage: item.passage,
      // 听力题靠朗读稿合成语音：只播放、不在题面显示
      audioText: item.audioText,
      audioUrl: item.audioUrl,
      options: item.options,
      minWords: item.minWords,
    }));
    res.json({ paper, items });
  }),
);

/**
 * 删除一份自己导入的卷子：题目与作答记录一并清掉。
 * 内置题库（没有 import_file）不给删——下次启动会重新播种，删了也白删。
 */
examsRouter.delete(
  '/exams/:id',
  asyncHandler(async (req, res) => {
    const paper = getPaper(req.params.id);
    if (!paper) throw new NotFoundError('这份卷子不存在');
    if (!paper.importFile) {
      throw new ValidationError('内置题库不能删除，只能删自己导入的卷子');
    }
    if (!deleteImportedPaper(paper.id)) throw new NotFoundError('这份卷子不存在');
    res.json({ ok: true, id: paper.id });
  }),
);

/** 开始一次自测：记录开始时间，交卷时用于计算真实用时 */
examsRouter.post(
  '/exams/:id/attempts',
  asyncHandler(async (req, res) => {
    const paper = getPaper(req.params.id);
    if (!paper) throw new NotFoundError('这份卷子不存在');
    const attempt = createAttempt(paper.id, paper.language);
    res.status(201).json({ attempt, paper });
  }),
);

function buildDetails(
  items: ReturnType<typeof listItems>,
  answers: Array<number | null>,
  writing: Record<string, string>,
  reveal: boolean,
) {
  return items.map((item, index) => {
    const chosen = answers[index] ?? null;
    const text = writing[String(item.idx)] ?? '';
    const isWriting = item.kind === 'writing';
    return {
      idx: item.idx,
      section: item.section,
      sectionKey: item.sectionKey,
      questionNo: item.questionNo,
      kind: item.kind,
      stem: item.stem,
      passage: item.passage,
      audioText: item.audioText,
      audioUrl: item.audioUrl,
      options: item.options,
      minWords: item.minWords,
      // 写作题不参与客观判分，用 text 回传作答内容
      answer: isWriting ? -1 : reveal ? item.answer : -1,
      // 答案来源：原卷 / 据解析推导 / 模型作答，结果页据此提示可信度
      answerSource: item.answerSource,
      chosen: isWriting ? null : chosen,
      text,
      correct: isWriting ? false : chosen === item.answer,
      explanation: item.explanation,
      sampleAnswer: item.sampleAnswer,
    };
  });
}

/** 交卷判分：客观题自动判分，写作题保留原文与参考范文 */
examsRouter.post(
  '/exams/attempts/:id/submit',
  asyncHandler(async (req, res) => {
    const attempt = getAttempt(req.params.id);
    if (!attempt) throw new NotFoundError('这次自测记录不存在');
    if (attempt.status === 'done') throw new ValidationError('这次自测已经交卷了');

    const input = parseBody(SubmitInput, req.body ?? {});
    const paper = getPaper(attempt.paperId);
    if (!paper) throw new NotFoundError('这份卷子不存在');
    const items = listItems(paper.id);

    const answers = items.map((_, index) => input.answers[index] ?? null);
    const writing = input.writing ?? {};
    const details = buildDetails(items, answers, writing, true);
    const objective = details.filter((item) => item.kind === 'choice');
    const correct = objective.filter((item) => item.correct).length;
    const total = objective.length;

    saveAttempt(attempt.id, {
      answers,
      writing,
      correct,
      total,
      seconds: input.seconds ?? 0,
    });

    res.json({
      attempt: {
        ...attempt,
        answers,
        writing,
        correct,
        total,
        seconds: input.seconds ?? 0,
        status: 'done',
      },
      paper,
      details,
      score: { correct, total, percent: total > 0 ? Math.round((correct / total) * 100) : 0 },
    });
  }),
);

/** 回看某次自测：含答案、解析与写作范文 */
examsRouter.get(
  '/exams/attempts/:id',
  asyncHandler(async (req, res) => {
    const attempt = getAttempt(req.params.id);
    if (!attempt) throw new NotFoundError('这次自测记录不存在');
    const paper = getPaper(attempt.paperId);
    if (!paper) throw new NotFoundError('这份卷子不存在');
    const items = listItems(paper.id);
    const details = buildDetails(items, attempt.answers, attempt.writing, true);

    res.json({
      attempt,
      paper,
      details,
      score: {
        correct: attempt.correct,
        total: attempt.total,
        percent: attempt.total > 0 ? Math.round((attempt.correct / attempt.total) * 100) : 0,
      },
    });
  }),
);
