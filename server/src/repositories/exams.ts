import { currentUserId } from '../auth/requestScope';
import { randomUUID } from 'node:crypto';
import { db, parseJson } from '../db';
import { SEED_PAPERS } from '../data/exams';
import { logger } from '../lib/logger';


export type PaperType = 'real' | 'mock' | 'ai';

/** 答案来源：原卷答案 / 据解析推导 / 模型作答 / 无答案 */
export type AnswerSource = 'key' | 'explain' | 'solve' | 'none';

/** 考试科目：笔答与听力分开计时、分开收卷，界面按这个分阶段 */
export type ExamStage = 'written' | 'oral';

export interface ExamSectionPlan {
  key: string;
  label: string;
  count: number;
  minutes: number;
  /** 原卷大题号（問題N）；老的内置卷没有这个字段 */
  no?: number;
  /** 该大题属于哪个科目 */
  stage?: ExamStage;
}

export interface ExamPaperRow {
  id: string;
  language: 'en' | 'ja' | 'ko';
  year: number;
  examName: string;
  levelLabel: string;
  title: string;
  paperType: PaperType;
  sourceNote: string;
  originUrl: string;
  durationMin: number;
  sortIdx: number;
  sections: ExamSectionPlan[];
  /** 设置页上传解析进来的卷子才有值：原始文件名 */
  importFile: string;
  /** 解析元信息（OCR、页数、字符数、模型、警告） */
  importMeta: ExamImportMeta;
}

export interface ExamImportMeta {
  ocr?: boolean;
  pages?: number;
  chars?: number;
  model?: string | null;
  warnings?: string[];
  importedAt?: string;
  /** 文档里是否有独立的答案区 */
  hasAnswerKey?: boolean;
  /** 答案来源统计 */
  answerStats?: { fromKey: number; fromExplain: number; fromSolve: number };
  /** 逐大题抽取结果，用来核对题型有没有漏 */
  coverage?: Array<{ label: string; no: number; count: number; answerKey: number; missing: number }>;
  /** 定点补抽记录：哪几块补过题、补前补后各多少（只有 topup:exam 脚本会写） */
  /** 图片型大题（発話表現）按答案区重建的记录 */
  lastSpeechBuild?: { at: string; block: number; count: number };
  /** 定点补朗读稿记录（只有 fill:audio 脚本会写） */
  lastAudioFill?: { at: string; filled: number };
  lastTopUp?: {
    at: string;
    blocks: Array<{ no: number; label: string; before: number; after: number; state: string }>;
  };
}

export interface ExamItemRow {
  id: string;
  paperId: string;
  idx: number;
  section: string;
  sectionKey: string;
  /** 原卷大题号（問題N）；0 表示没识别出来 */
  questionNo: number;
  kind: 'choice' | 'writing';
  stem: string;
  passage: string;
  audioText: string;
  audioUrl: string;
  options: string[];
  answer: number;
  answerSource: AnswerSource;
  explanation: string;
  sampleAnswer: string;
  minWords: number;
}

export interface ExamAttemptRow {
  id: string;
  paperId: string;
  language: string;
  startedAt: string;
  submittedAt: string | null;
  seconds: number;
  answers: Array<number | null>;
  writing: Record<string, string>;
  correct: number;
  total: number;
  status: string;
}

interface PaperDbRow {
  id: string;
  language: 'en' | 'ja' | 'ko';
  year: number;
  exam_name: string;
  level_label: string;
  title: string;
  paper_type: PaperType;
  source_note: string;
  origin_url: string;
  duration_min: number;
  sort_idx: number;
  sections_json: string;
  import_file: string;
  import_meta: string;
}

interface ItemDbRow {
  id: string;
  paper_id: string;
  idx: number;
  section: string;
  section_key: string;
  question_no: number | null;
  kind: string;
  stem: string;
  passage: string;
  audio_text: string;
  audio_url: string;
  options: string;
  answer: number;
  answer_source: string | null;
  explanation: string;
  sample_answer: string;
  min_words: number;
}

function mapPaper(row: PaperDbRow): ExamPaperRow {
  return {
    id: row.id,
    language: row.language,
    year: row.year,
    examName: row.exam_name,
    levelLabel: row.level_label,
    title: row.title,
    paperType: row.paper_type ?? 'mock',
    sourceNote: row.source_note,
    originUrl: row.origin_url ?? '',
    durationMin: row.duration_min,
    sortIdx: row.sort_idx,
    sections: parseJson<ExamSectionPlan[]>(row.sections_json, []),
    importFile: row.import_file ?? '',
    importMeta: parseJson<ExamImportMeta>(row.import_meta, {}),
  };
}

function mapItem(row: ItemDbRow): ExamItemRow {
  return {
    id: row.id,
    paperId: row.paper_id,
    idx: row.idx,
    section: row.section,
    sectionKey: row.section_key || 'vocab',
    questionNo: row.question_no ?? 0,
    kind: row.kind === 'writing' ? 'writing' : 'choice',
    stem: row.stem,
    passage: row.passage,
    audioText: row.audio_text ?? '',
    audioUrl: row.audio_url ?? '',
    options: parseJson<string[]>(row.options, []),
    answer: row.answer,
    answerSource: (row.answer_source as AnswerSource) ?? 'key',
    explanation: row.explanation,
    sampleAnswer: row.sample_answer ?? '',
    minWords: row.min_words ?? 0,
  };
}

/**
 * 对齐内置题库：新卷子插入，已有卷子的题目按种子内容刷新
 * （题目 id 稳定为 paper-idx，历史作答只记选项下标，不会错位）。
 * 同时清掉已被题库移除、且没人做过的仿真卷，避免同一份年份出现两张卷。
 */
export function ensureExamBank(): void {
  const insertPaper = db.prepare(`
    INSERT OR IGNORE INTO exam_papers
      (id, language, year, exam_name, level_label, title, paper_type, source_note,
       origin_url, duration_min, sort_idx, sections_json, created_at)
    VALUES (@id, @language, @year, @examName, @levelLabel, @title, @paperType, @sourceNote,
            '', @durationMin, @sortIdx, @sectionsJson, @createdAt)
  `);
  const updatePaper = db.prepare(`
    UPDATE exam_papers
       SET year = @year, exam_name = @examName, level_label = @levelLabel, title = @title,
           paper_type = @paperType, source_note = @sourceNote, duration_min = @durationMin,
           sections_json = @sectionsJson
     WHERE id = @id AND paper_type = 'mock'
  `);
  const clearItems = db.prepare('DELETE FROM exam_items WHERE paper_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO exam_items
      (id, paper_id, idx, section, section_key, question_no, kind, stem, passage, audio_text, audio_url,
       options, answer, answer_source, explanation, sample_answer, min_words)
    VALUES (@id, @paperId, @idx, @section, @sectionKey, 0, @kind, @stem, @passage, @audioText, @audioUrl,
            @options, @answer, 'key', @explanation, @sampleAnswer, @minWords)
  `);

  const run = db.transaction(() => {
    for (const paper of SEED_PAPERS) {
      const common = {
        id: paper.id,
        language: paper.language,
        year: paper.year,
        examName: paper.examName,
        levelLabel: paper.levelLabel,
        title: paper.title,
        paperType: paper.paperType,
        sourceNote: paper.sourceNote,
        durationMin: paper.durationMin,
        sortIdx: 0,
        sectionsJson: JSON.stringify(paper.sections),
        createdAt: new Date().toISOString(),
      };
      insertPaper.run(common);
      updatePaper.run(common);
      clearItems.run(paper.id);
      paper.items.forEach((item, index) => {
        insertItem.run({
          id: `${paper.id}-${index}`,
          paperId: paper.id,
          idx: index,
          section: item.label ?? item.section,
          sectionKey: item.section,
          kind: item.kind ?? 'choice',
          stem: item.stem,
          passage: item.passage ?? '',
          audioText: item.audioText ?? '',
          audioUrl: '',
          options: JSON.stringify(item.options ?? []),
          answer: item.answer ?? -1,
          explanation: item.explanation,
          sampleAnswer: item.sampleAnswer ?? '',
          minWords: item.minWords ?? 0,
        });
      });
    }

    // 旧版内置卷（已不在题库里、也没人做过）不再保留
    const keep = new Set(SEED_PAPERS.map((paper) => paper.id));
    const stale = db
      .prepare(
        `SELECT p.id FROM exam_papers p
          WHERE p.paper_type = 'mock'
            AND NOT EXISTS (SELECT 1 FROM exam_attempts a WHERE a.paper_id = p.id)`,
      )
      .all() as Array<{ id: string }>;
    const drop = db.prepare('DELETE FROM exam_papers WHERE id = ?');
    for (const row of stale) {
      if (!keep.has(row.id)) drop.run(row.id);
    }
  });

  try {
    run();
  } catch (err) {
    logger.error('exam bank seed failed', { error: (err as Error).message });
  }
}

export interface PaperSummary extends Omit<ExamPaperRow, 'sections'> {
  itemCount: number;
  /** 分项名（按卷内顺序），供卡片展示 */
  sections: string[];
  hasListening: boolean;
  hasWriting: boolean;
  attemptCount: number;
  bestCorrect: number | null;
  bestPercent: number | null;
  lastAttemptAt: string | null;
}

export function listPapers(language: string): PaperSummary[] {
  const papers = db
    .prepare('SELECT * FROM exam_papers WHERE language = ? ORDER BY year DESC, sort_idx, title')
    .all(language) as PaperDbRow[];

  const itemStats = db
    .prepare(
      `SELECT paper_id, COUNT(*) AS count,
              SUM(CASE WHEN kind = 'writing' THEN 1 ELSE 0 END) AS writing,
              SUM(CASE WHEN audio_text <> '' THEN 1 ELSE 0 END) AS listening
         FROM exam_items GROUP BY paper_id`,
    )
    .all() as Array<{ paper_id: string; count: number; writing: number; listening: number }>;
  const itemMap = new Map(itemStats.map((row) => [row.paper_id, row]));

  const attemptStats = db
    .prepare(
      `SELECT paper_id,
              COUNT(*) AS times,
              MAX(correct * 1.0 / NULLIF(total, 0)) AS best_ratio,
              MAX(submitted_at) AS last_at
         FROM exam_attempts
        WHERE user_id = ? AND language = ? AND status = 'done'
        GROUP BY paper_id`,
    )
    .all(currentUserId(), language) as Array<{
    paper_id: string;
    times: number;
    best_ratio: number | null;
    last_at: string | null;
  }>;
  const attemptMap = new Map(attemptStats.map((row) => [row.paper_id, row]));

  return papers.map((row) => {
    const items = itemMap.get(row.id);
    const attempts = attemptMap.get(row.id);
    const total = items?.count ?? 0;
    const ratio = attempts?.best_ratio ?? null;
    const paper = mapPaper(row);
    return {
      ...paper,
      itemCount: total,
      sections: paper.sections.length > 0 ? paper.sections.map((step) => step.label) : [],
      hasListening: (items?.listening ?? 0) > 0,
      hasWriting: (items?.writing ?? 0) > 0,
      attemptCount: attempts?.times ?? 0,
      bestCorrect: ratio === null ? null : Math.round(ratio * total),
      bestPercent: ratio === null ? null : Math.round(ratio * 100),
      lastAttemptAt: attempts?.last_at ?? null,
    };
  });
}

export function getPaper(id: string): ExamPaperRow | null {
  const row = db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(id) as PaperDbRow | undefined;
  return row ? mapPaper(row) : null;
}

export function listItems(paperId: string): ExamItemRow[] {
  const rows = db
    .prepare('SELECT * FROM exam_items WHERE paper_id = ? ORDER BY idx')
    .all(paperId) as ItemDbRow[];
  return rows.map(mapItem);
}

export function createAttempt(paperId: string, language: string): ExamAttemptRow {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO exam_attempts (id, user_id, paper_id, language, started_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  ).run(id, currentUserId(), paperId, language, startedAt);
  return {
    id,
    paperId,
    language,
    startedAt,
    submittedAt: null,
    seconds: 0,
    answers: [],
    writing: {},
    correct: 0,
    total: 0,
    status: 'active',
  };
}

interface AttemptDbRow {
  id: string;
  paper_id: string;
  language: string;
  started_at: string;
  submitted_at: string | null;
  seconds: number;
  answers: string;
  writing: string;
  correct: number;
  total: number;
  status: string;
}

function mapAttempt(row: AttemptDbRow): ExamAttemptRow {
  return {
    id: row.id,
    paperId: row.paper_id,
    language: row.language,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    seconds: row.seconds,
    answers: parseJson<Array<number | null>>(row.answers, []),
    writing: parseJson<Record<string, string>>(row.writing, {}),
    correct: row.correct,
    total: row.total,
    status: row.status,
  };
}

export function getAttempt(id: string): ExamAttemptRow | null {
  const row = db
    .prepare('SELECT * FROM exam_attempts WHERE id = ? AND user_id = ?')
    .get(id, currentUserId()) as AttemptDbRow | undefined;
  return row ? mapAttempt(row) : null;
}

export function saveAttempt(
  id: string,
  input: {
    answers: Array<number | null>;
    writing: Record<string, string>;
    correct: number;
    total: number;
    seconds: number;
  },
): void {
  db.prepare(
    `UPDATE exam_attempts
        SET answers = ?, writing = ?, correct = ?, total = ?, seconds = ?, submitted_at = ?, status = 'done'
      WHERE id = ? AND user_id = ?`,
  ).run(
    JSON.stringify(input.answers),
    JSON.stringify(input.writing),
    input.correct,
    input.total,
    input.seconds,
    new Date().toISOString(),
    id,
    currentUserId(),
  );
}

export interface AttemptSummaryRow extends ExamAttemptRow {
  paperTitle: string;
  paperYear: number;
  examName: string;
  levelLabel: string;
  paperType: PaperType;
}

export function listAttempts(language: string, limit = 30): AttemptSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT a.*, p.title AS paper_title, p.year AS paper_year, p.paper_type AS paper_type,
              p.exam_name AS exam_name, p.level_label AS level_label
         FROM exam_attempts a
         JOIN exam_papers p ON p.id = a.paper_id
        WHERE a.user_id = ? AND a.language = ? AND a.status = 'done'
        ORDER BY a.submitted_at DESC
        LIMIT ?`,
    )
    .all(currentUserId(), language, limit) as Array<
    AttemptDbRow & {
      paper_title: string;
      paper_year: number;
      exam_name: string;
      level_label: string;
      paper_type: PaperType;
    }
  >;

  return rows.map((row) => ({
    ...mapAttempt(row),
    paperTitle: row.paper_title,
    paperYear: row.paper_year,
    examName: row.exam_name,
    levelLabel: row.level_label,
    paperType: row.paper_type ?? 'mock',
  }));
}

/** 导入的自定义卷：写入题库（真卷 / 自制卷都走这里） */
export function upsertExternalPaper(input: {
  id: string;
  language: 'en' | 'ja' | 'ko';
  year: number;
  examName: string;
  levelLabel: string;
  title: string;
  paperType: PaperType;
  sourceNote: string;
  originUrl: string;
  durationMin: number;
  sections: ExamSectionPlan[];
  /** 从设置页上传解析的卷子：记录文件名与解析元信息 */
  importFile?: string;
  importMeta?: ExamImportMeta;
  items: Array<{
    section: string;
    sectionKey: string;
    questionNo?: number;
    kind: 'choice' | 'writing';
    stem: string;
    passage: string;
    audioText: string;
    audioUrl: string;
    options: string[];
    answer: number;
    answerSource?: AnswerSource;
    explanation: string;
    sampleAnswer: string;
    minWords: number;
  }>;
}): void {
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO exam_papers
         (id, language, year, exam_name, level_label, title, paper_type, source_note,
          origin_url, duration_min, sort_idx, sections_json, import_file, import_meta, created_at)
       VALUES (@id, @language, @year, @examName, @levelLabel, @title, @paperType, @sourceNote,
               @originUrl, @durationMin, 0, @sectionsJson, @importFile, @importMeta, @createdAt)
       ON CONFLICT(id) DO UPDATE SET
         year = excluded.year, exam_name = excluded.exam_name, level_label = excluded.level_label,
         title = excluded.title, paper_type = excluded.paper_type, source_note = excluded.source_note,
         origin_url = excluded.origin_url, duration_min = excluded.duration_min,
         sections_json = excluded.sections_json, import_file = excluded.import_file,
         import_meta = excluded.import_meta`,
    ).run({
      id: input.id,
      language: input.language,
      year: input.year,
      examName: input.examName,
      levelLabel: input.levelLabel,
      title: input.title,
      paperType: input.paperType,
      sourceNote: input.sourceNote,
      originUrl: input.originUrl,
      durationMin: input.durationMin,
      sectionsJson: JSON.stringify(input.sections),
      importFile: input.importFile ?? '',
      importMeta: JSON.stringify(input.importMeta ?? {}),
      createdAt: now,
    });
    db.prepare('DELETE FROM exam_items WHERE paper_id = ?').run(input.id);
    const insertItem = db.prepare(`
      INSERT INTO exam_items
        (id, paper_id, idx, section, section_key, question_no, kind, stem, passage, audio_text, audio_url,
         options, answer, answer_source, explanation, sample_answer, min_words)
      VALUES (@id, @paperId, @idx, @section, @sectionKey, @questionNo, @kind, @stem, @passage, @audioText, @audioUrl,
              @options, @answer, @answerSource, @explanation, @sampleAnswer, @minWords)
    `);
    input.items.forEach((item, index) => {
      insertItem.run({
        id: `${input.id}-${index}`,
        paperId: input.id,
        idx: index,
        section: item.section,
        sectionKey: item.sectionKey,
        questionNo: item.questionNo ?? 0,
        kind: item.kind,
        stem: item.stem,
        passage: item.passage,
        audioText: item.audioText,
        audioUrl: item.audioUrl,
        options: JSON.stringify(item.options),
        answer: item.answer,
        answerSource: item.answerSource ?? 'key',
        explanation: item.explanation,
        sampleAnswer: item.sampleAnswer,
        minWords: item.minWords,
      });
    });
  });
  run();
}

/** 设置页「真题导入」列表：只列从本机上传解析进来的卷子 */
export function listImportedPapers(language: string): PaperSummary[] {
  return listPapers(language).filter((paper) => paper.importFile !== '');
}

/**
 * 删除一份导入的卷子：题目、作答记录一起清掉，不留孤儿行。
 * 内置题库（`import_file` 为空）不允许删——种子数据会在下次启动时重新写回来，删了只会让用户以为没生效。
 */
export function deleteImportedPaper(id: string): boolean {
  const remove = db.transaction((paperId: string) => {
    const exists = db
      .prepare("SELECT id FROM exam_papers WHERE id = ? AND import_file <> ''")
      .get(paperId);
    if (!exists) return false;
    // 外键是 ON DELETE CASCADE，但这里显式删一遍：命令行/脚本直连库时关掉外键也不会留残渣
    db.prepare('DELETE FROM exam_attempts WHERE paper_id = ?').run(paperId);
    db.prepare('DELETE FROM exam_items WHERE paper_id = ?').run(paperId);
    db.prepare('DELETE FROM exam_papers WHERE id = ?').run(paperId);
    return true;
  });
  return remove(id);
}
