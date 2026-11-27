/**
 * 知识图谱仓储：概念节点、关系边、统一题池、逐题作答、掌握度。
 *
 * 三条读写在别处也要成立的前提：
 *   1. 节点编码（code）稳定 —— 诊断结论、处方、掌握度都按它对齐，编码一改历史数据就断；
 *   2. 题目按内容去重 —— 同一道题出现在多少份卷子里都只是一道题；
 *   3. 落库幂等 —— 启动期每次都会跑一遍，重复执行不增行。
 *
 * 掌握度只统计主考点（question_knowledge.is_primary = 1）。
 * 一题多考点时按权重分摊对错留给诊断引擎，这里不替它做决定。
 */
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db';
import { logger } from '../lib/logger';
import {
  KNOWLEDGE_TREES,
  treeFor,
  type KnowledgeEdgeDef,
  type KnowledgeNodeDef,
  type KnowledgeTree,
} from '../content/knowledge';
import { resolveVocabTags } from '../content/knowledge/questionVocab';

/** 掌握度置信度的两个门槛：做满几次、做过几道不同的题，才允许下结论 */
const CONFIDENCE_MIN_ATTEMPTS = 3;
const CONFIDENCE_MIN_DISTINCT = 2;

const CODE_RE = /^[a-z]{2}(\.[a-z0-9-]+)+$/;

/** 交卷路径与回填共用的题目最小形状（repositories/exams.ts 的行结构与之兼容） */
export interface ExamItemLite {
  id: string;
  paperId: string;
  /** 卷内序号：写作作答以它为键（{ 题目序号: 文本 }） */
  idx: number;
  sectionKey: string;
  /** 卷面大题名（exam_items.section 列），字段名与题库行保持一致 */
  section: string;
  kind: 'choice' | 'writing';
  stem: string;
  passage: string;
  options: string[];
  answer: number;
  sampleAnswer: string;
  explanation: string;
}

export interface KnowledgeNode {
  id: string;
  code: string;
  kind: string;
  name: string;
  nameLocal: string;
  parentId: string | null;
  depth: number;
  examId: string;
  sectionKey: string;
  levelBand: string;
  examWeight: number;
  sortIdx: number;
  meta: Record<string, unknown>;
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
  source: string;
  confidence: number;
}

// ------------------------------------------------------------------ 小工具

/** 卷面大题名归一：大小写、弯引号、多余空格都不该影响匹配 */
export function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 题目身份 = 内容哈希。题干或选项改了才算新题，出现在哪份卷子里不影响 */
export function questionIdOf(input: {
  language: string;
  sectionKey: string;
  stem: string;
  options: string[];
}): string {
  const digest = createHash('sha1');
  digest.update(
    [input.language, input.sectionKey, input.stem, JSON.stringify(input.options)].join('\u0000'),
  );
  return `q-${digest.digest('hex').slice(0, 16)}`;
}

/** 题池里的默认考试：内置卷没带考试 id，按卷名认；认不出就用该语种的主考试 */
const DEFAULT_EXAM: Record<string, string> = { en: 'toefl', ja: 'jlpt', ko: 'topik' };
const EXAM_BY_NAME: Array<[RegExp, string]> = [
  [/雅思|ielts/i, 'ielts'],
  [/六级|cet/i, 'cet6'],
  [/考研/, 'kaoyan'],
  [/jlpt/i, 'jlpt'],
  [/topik/i, 'topik'],
  [/托福|toefl/i, 'toefl'],
];

function examIdForPaper(language: string, examName: string): string {
  for (const [pattern, id] of EXAM_BY_NAME) {
    if (pattern.test(examName)) return id;
  }
  return DEFAULT_EXAM[language] ?? '';
}

/** 一道题该归到哪个知识点：该语种的匹配规则按声明顺序取第一个命中；没有规则返回 null */
export function resolvePointCode(
  language: string,
  item: { sectionKey: string; label: string; stem: string },
): string | null {
  const tree = treeFor(language);
  if (!tree) return null;
  const label = normalizeLabel(item.label);
  for (const matcher of tree.matchers) {
    if (matcher.sectionKey !== item.sectionKey) continue;
    if (!matcher.labels.some((candidate) => normalizeLabel(candidate) === label)) continue;
    if (matcher.stemAny && !matcher.stemAny.some((fragment) => item.stem.includes(fragment))) continue;
    return matcher.code;
  }
  return null;
}

// ------------------------------------------------------------------ 节点与边

/** 由父子声明算出深度并按深度排序（父节点先落库，外键才不会在事务中途报错），顺便发现节点声明里的环 */
function orderNodesByDepth(
  nodes: KnowledgeNodeDef[],
  language: string,
): Array<{ node: KnowledgeNodeDef; depth: number }> {
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const depth = new Map<string, number>();

  const depthOf = (code: string): number => {
    const cached = depth.get(code);
    if (cached !== undefined) return cached;
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: KnowledgeNodeDef | undefined = byCode.get(code);
    let levels = 1;
    while (current?.parent) {
      if (seen.has(current.code)) {
        throw new Error(`知识树 ${language} 的父子关系成环：${[...chain, current.code].join(' → ')}`);
      }
      seen.add(current.code);
      chain.push(current.code);
      levels += 1;
      const parent = current.parent;
      if (!byCode.has(parent)) {
        throw new Error(`知识树 ${language} 的节点 ${current.code} 引用了未声明的父节点 ${parent}`);
      }
      current = byCode.get(parent);
    }
    depth.set(code, levels);
    for (const [index, item] of chain.entries()) {
      depth.set(item, levels - 1 - index);
    }
    return levels;
  };

  return nodes
    .map((node) => ({ node, depth: depthOf(node.code) }))
    .sort((a, b) => a.depth - b.depth);
}

/** 类义边是无向的：声明一次，落库时成对展开 */
function expandEdges(edges: KnowledgeEdgeDef[]): KnowledgeEdgeDef[] {
  const out: KnowledgeEdgeDef[] = [];
  for (const edge of edges) {
    out.push(edge);
    if (edge.type === 'similar') out.push({ ...edge, from: edge.to, to: edge.from });
  }
  return out;
}

/**
 * 写入一棵知识树（幂等）。
 * 传入的必须是该语种的**完整**树（手写骨架 + 语法库派生部分，见 content/knowledge/index.ts）：
 * 种子边以声明为准，会先清掉该语种所有 source='seed' 的边再重写 ——
 * 只传半棵树，另外半棵的种子边就被清掉了。规则抽取 / 模型推断 / 人工补的边不动。
 * 节点只增不删 —— 下线一个节点要把作答证据迁走，不能靠重启时静默删掉。
 */
export function upsertKnowledgeTree(tree: KnowledgeTree): { nodes: number; edges: number } {
  const byCode = new Map(tree.nodes.map((node) => [node.code, node]));
  for (const node of tree.nodes) {
    if (!CODE_RE.test(node.code) || !node.code.startsWith(`${tree.language}.`)) {
      throw new Error(`知识点编码不合法：${node.code}（应形如 ${tree.language}.reading.inference）`);
    }
    if (node.examWeight !== undefined && (node.examWeight < 0 || node.examWeight > 1)) {
      throw new Error(`知识点 ${node.code} 的 examWeight 必须在 0~1 之间`);
    }
  }
  for (const edge of tree.edges) {
    if (!byCode.has(edge.from) || !byCode.has(edge.to)) {
      throw new Error(`关系边 ${edge.from} → ${edge.to} 引用了本树未声明的节点`);
    }
    if (edge.weight !== undefined && (edge.weight < 0 || edge.weight > 1)) {
      throw new Error(`关系边 ${edge.from} → ${edge.to} 的 weight 必须在 0~1 之间`);
    }
    if (edge.confidence !== undefined && (edge.confidence < 0 || edge.confidence > 1)) {
      throw new Error(`关系边 ${edge.from} → ${edge.to} 的 confidence 必须在 0~1 之间`);
    }
  }
  for (const matcher of tree.matchers) {
    if (!byCode.has(matcher.code)) {
      throw new Error(`题目匹配规则指向了未声明的节点：${matcher.code}`);
    }
  }
  const ordered = orderNodesByDepth(tree.nodes, tree.language);

  const run = db.transaction(() => {
    const now = new Date().toISOString();
    const upsertNode = db.prepare(`
      INSERT INTO knowledge_points
        (id, language, kind, code, name, name_local, parent_id, depth, exam_id, section_key,
         level_band, exam_weight, sort_idx, meta_json, created_at, updated_at)
      VALUES
        (@id, @language, @kind, @code, @name, @nameLocal, @parentId, @depth, @examId, @sectionKey,
         @levelBand, @examWeight, @sortIdx, @metaJson, @now, @now)
      ON CONFLICT(language, code) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        name_local = excluded.name_local,
        parent_id = excluded.parent_id,
        depth = excluded.depth,
        exam_id = excluded.exam_id,
        section_key = excluded.section_key,
        level_band = excluded.level_band,
        exam_weight = excluded.exam_weight,
        sort_idx = excluded.sort_idx,
        meta_json = excluded.meta_json,
        updated_at = excluded.updated_at
    `);
    for (const { node, depth } of ordered) {
      upsertNode.run({
        id: node.code,
        language: tree.language,
        kind: node.kind,
        code: node.code,
        name: node.name,
        nameLocal: node.nameLocal ?? '',
        parentId: node.parent ?? null,
        depth,
        examId: node.examId ?? '*',
        sectionKey: node.sectionKey ?? '',
        levelBand: node.levelBand ?? '',
        examWeight: node.examWeight ?? 0.5,
        sortIdx: node.sort ?? 0,
        metaJson: JSON.stringify(node.meta ?? {}),
        now,
      });
    }

    db.prepare(
      `DELETE FROM kp_edges
        WHERE source = 'seed'
          AND from_id IN (SELECT id FROM knowledge_points WHERE language = ?)`,
    ).run(tree.language);

    const insertEdge = db.prepare(`
      INSERT INTO kp_edges (from_id, to_id, type, weight, source, confidence, created_at)
      VALUES (@from, @to, @type, @weight, 'seed', @confidence, @now)
      ON CONFLICT(from_id, to_id, type) DO UPDATE SET
        weight = excluded.weight,
        confidence = excluded.confidence
    `);
    const edges = expandEdges(tree.edges);
    for (const edge of edges) {
      insertEdge.run({
        from: edge.from,
        to: edge.to,
        type: edge.type,
        weight: edge.weight ?? 1,
        confidence: edge.confidence ?? 1,
        now,
      });
    }

    assertPrereqAcyclic(tree.language);
    return { nodes: ordered.length, edges: edges.length };
  });
  return run();
}

/** 前置关系必须无环：成环意味着「学 A 之前要先会 B，学 B 之前要先会 A」，计划排不出来 */
function assertPrereqAcyclic(language: string): void {
  const rows = db
    .prepare(
      `SELECT e.from_id AS f, e.to_id AS t
         FROM kp_edges e
         JOIN knowledge_points p ON p.id = e.from_id
        WHERE e.type = 'prereq' AND p.language = ?`,
    )
    .all(language) as Array<{ f: string; t: string }>;

  const next = new Map<string, string[]>();
  for (const row of rows) {
    const list = next.get(row.f) ?? [];
    list.push(row.t);
    next.set(row.f, list);
  }

  // 0 未访问 / 1 在当前路径上 / 2 已完成
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (node: string): void => {
    const marked = state.get(node) ?? 0;
    if (marked === 1) {
      const at = path.indexOf(node);
      throw new Error(`前置关系成环：${[...path.slice(at), node].join(' → ')}`);
    }
    if (marked === 2) return;
    state.set(node, 1);
    path.push(node);
    for (const child of next.get(node) ?? []) visit(child);
    path.pop();
    state.set(node, 2);
  };
  for (const node of next.keys()) visit(node);
}

export function listNodes(language: string): KnowledgeNode[] {
  const rows = db
    .prepare('SELECT * FROM knowledge_points WHERE language = ? ORDER BY depth, sort_idx, code')
    .all(language) as Array<{
    id: string;
    code: string;
    kind: string;
    name: string;
    name_local: string | null;
    parent_id: string | null;
    depth: number;
    exam_id: string;
    section_key: string;
    level_band: string;
    exam_weight: number;
    sort_idx: number;
    meta_json: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    kind: row.kind,
    name: row.name,
    nameLocal: row.name_local ?? '',
    parentId: row.parent_id ?? null,
    depth: row.depth,
    examId: row.exam_id,
    sectionKey: row.section_key,
    levelBand: row.level_band,
    examWeight: row.exam_weight,
    sortIdx: row.sort_idx,
    meta: safeParse(row.meta_json),
  }));
}

export function listEdges(language: string): KnowledgeEdge[] {
  const rows = db
    .prepare(
      `SELECT e.from_id AS f, e.to_id AS t, e.type, e.weight, e.source, e.confidence
         FROM kp_edges e
         JOIN knowledge_points p ON p.id = e.from_id
        WHERE p.language = ?
        ORDER BY e.type, e.from_id, e.to_id`,
    )
    .all(language) as Array<{ f: string; t: string } & Omit<KnowledgeEdge, 'from' | 'to'>>;
  return rows.map((row) => ({
    from: row.f,
    to: row.t,
    type: row.type,
    weight: row.weight,
    source: row.source,
    confidence: row.confidence,
  }));
}

function safeParse(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ 题池

interface PoolRow {
  id: string;
  paper_id: string;
  language: string;
  exam_name: string;
  section_key: string;
  section: string;
  kind: string;
  stem: string;
  passage: string;
  options: string;
  answer: number | null;
  explanation: string;
  sample_answer: string | null;
}

export interface SyncStats {
  questions: number;
  /** 已对上知识点的题 */
  tagged: number;
  /** 对不上任何知识点的题：有题没知识点，缺口要从这里看 */
  untagged: number;
}

/**
 * 把卷面题同步进统一题池（幂等）。
 * 内置卷每次启动都会重排 exam_items，但内容不变 —— 所以题目身份按内容算，重排不增行。
 * 逐卷去重后一题一行；知识点按该语种的匹配规则挂主考点。
 * 无手写匹配规则的语种（日语）走词形兜底：解析标注词升为主考点，全文命中词只作次要关联。
 */
export function syncExamPoolQuestions(): Record<string, SyncStats> {
  const run = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT i.id, i.paper_id, p.language, p.exam_name, i.section_key, i.section, i.kind,
                i.stem, i.passage, i.options, i.answer, i.explanation, i.sample_answer
           FROM exam_items i
           JOIN exam_papers p ON p.id = i.paper_id`,
      )
      .all() as PoolRow[];

    const byLanguage = new Map<string, SyncStats>();
    const seen = new Set<string>();
    const now = new Date().toISOString();

    const insertQuestion = db.prepare(`
      INSERT OR IGNORE INTO questions
        (id, language, exam_id, question_type, section_key, label, stem, passage, options_json,
         answer_idx, answer_text, explanation, difficulty, source_type, source_ref, owner_user_id,
         status, created_at)
      VALUES
        (@id, @language, @examId, @type, @sectionKey, @label, @stem, @passage, @options,
         @answerIdx, @answerText, @explanation, 0.5, 'exam_pool', @sourceRef, NULL, 'active', @now)
    `);
    const clearSeedLinks = db.prepare(
      `DELETE FROM question_knowledge WHERE question_id = ? AND source = 'seed'`,
    );
    const linkPoint = db.prepare(`
      INSERT INTO question_knowledge (question_id, knowledge_point_id, weight, is_primary, source)
      VALUES (?, ?, ?, ?, 'seed')
      ON CONFLICT(question_id, knowledge_point_id) DO UPDATE SET
        weight = excluded.weight,
        is_primary = excluded.is_primary
    `);
    const hasNode = db.prepare('SELECT 1 FROM knowledge_points WHERE id = ?');
    const linked = db.prepare(
      'SELECT COUNT(*) AS n FROM question_knowledge WHERE question_id = ?',
    );

    for (const row of rows) {
      const options = safeParseArray(row.options);
      const id = questionIdOf({
        language: row.language,
        sectionKey: row.section_key,
        stem: row.stem,
        options,
      });
      const stats = byLanguage.get(row.language) ?? { questions: 0, tagged: 0, untagged: 0 };
      byLanguage.set(row.language, stats);
      if (seen.has(id)) continue;
      seen.add(id);

      insertQuestion.run({
        id,
        language: row.language,
        examId: examIdForPaper(row.language, row.exam_name),
        type: row.kind === 'writing' ? 'writing' : 'choice',
        sectionKey: row.section_key,
        label: row.section,
        stem: row.stem,
        passage: row.passage ?? '',
        options: JSON.stringify(options),
        answerIdx: row.kind === 'writing' ? null : row.answer,
        answerText: row.kind === 'writing' ? row.sample_answer ?? '' : '',
        explanation: row.explanation ?? '',
        sourceRef: row.id,
        now,
      });

      const code = resolvePointCode(row.language, {
        sectionKey: row.section_key,
        label: row.section,
        stem: row.stem,
      });
      clearSeedLinks.run(id);
      if (code && hasNode.get(code)) linkPoint.run(id, code, 1, 1);

      // 日语没有手写匹配规则（matchers 为空），改为按词形把题目连到 JLPT 词汇节点。
      // 解析首引号命中的词当主考点（参与掌握度），其余只是次要关联（不参与掌握度），
      // 这样既打通诊断证据链，又不会因为全文扫词把虚词当成考点。
      const vocabTags = resolveVocabTags(row.language, {
        sectionKey: row.section_key,
        stem: row.stem,
        explanation: row.explanation,
      });
      let hasPrimary = Boolean(code && hasNode.get(code));
      for (const tag of vocabTags) {
        if (!hasNode.get(tag.code)) continue;
        // 已有语法主考点时，词汇节点一律次要；否则只有解析标注的考点词升为主考点
        const primary = tag.primary && !hasPrimary;
        linkPoint.run(id, tag.code, primary ? 1 : 0.4, primary ? 1 : 0);
        if (primary) hasPrimary = true;
      }

      stats.questions += 1;
      const count = (linked.get(id) as { n: number } | undefined)?.n ?? 0;
      if (count > 0) stats.tagged += 1;
      else stats.untagged += 1;
    }

    return Object.fromEntries(byLanguage);
  });
  return run();
}

function safeParseArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ 逐题作答

function questionForItem(
  language: string,
  item: { sectionKey: string; stem: string; options: string[] },
): { id: string } | undefined {
  return db
    .prepare('SELECT id FROM questions WHERE id = ?')
    .get(questionIdOf({ language, sectionKey: item.sectionKey, stem: item.stem, options: item.options })) as
    | { id: string }
    | undefined;
}

/**
 * 把一次整卷作答拆成逐题记录，并重算受影响知识点的掌握度。
 * 幂等：同一次交卷重复执行不增行（唯一键：账号 + 场景 + 场次 + 卷面行）。
 *
 * 记录规则：
 *   · 客观题：一律记。未作答 chosen_idx / is_correct 为 NULL，是有效证据（时间不够或跳过）；
 *   · 写作题：有作答文本才记，is_correct 为 NULL，得分由批改环节回填 score；
 *   · 题不在题池里（同步之前就交了卷）：跳过并计入 skipped，不凭空造题。
 */
export function recordExamAttempt(input: {
  attemptId: string;
  userId: string;
  language: string;
  items: ReadonlyArray<ExamItemLite>;
  answers: ReadonlyArray<number | null>;
  writing: Record<string, string>;
  seconds: number;
  createdAt: string;
}): { recorded: number; skipped: number } {
  const run = db.transaction(() => {
    const touched = new Set<string>();
    let recorded = 0;
    let skipped = 0;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO question_attempts
        (id, user_id, question_id, language, session_type, session_id, source_item_id,
         chosen_idx, answer_text, is_correct, score, seconds, error_type, created_at)
        VALUES
        (@id, @userId, @questionId, @language, 'exam', @sessionId, @sourceItemId,
         @chosenIdx, @answerText, @isCorrect, NULL, 0, '', @createdAt)
    `);

    input.items.forEach((item, index) => {
      const isWriting = item.kind === 'writing';
      const text = isWriting ? (input.writing[String(item.idx)] ?? '').trim() : '';
      // 写作题一个字没写 = 没作答，不记
      if (isWriting && !text) return;

      const question = questionForItem(input.language, item);
      if (!question) {
        skipped += 1;
        return;
      }

      // answers 按卷面顺序对齐（交卷接口就是按数组下标收的）
      const chosen = isWriting ? null : (input.answers[index] ?? null);
      const isCorrect = isWriting || chosen === null ? null : chosen === item.answer ? 1 : 0;

      const info = insert.run({
        id: randomUUID(),
        userId: input.userId,
        questionId: question.id,
        language: input.language,
        sessionId: input.attemptId,
        sourceItemId: item.id,
        chosenIdx: chosen,
        answerText: text,
        isCorrect,
        createdAt: input.createdAt,
      });
      if (info.changes === 0) return;
      recorded += 1;

      const points = db
        .prepare('SELECT knowledge_point_id AS id FROM question_knowledge WHERE question_id = ? AND is_primary = 1')
        .all(question.id) as Array<{ id: string }>;
      for (const point of points) touched.add(point.id);
    });

    const now = input.createdAt;
    for (const point of touched) refreshMastery(input.userId, point, now);
    return { recorded, skipped };
  });
  return run();
}

/**
 * 重算一个知识点的掌握度（只看主考点、只看客观题）。
 * confidence 同时受「做了几次」与「做过几道不同的题」约束：
 * 同一道题连对五次只说明记住了答案。
 */
export function refreshMastery(userId: string, pointId: string, now: string): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS attempts,
              COALESCE(SUM(is_correct), 0) AS correct,
              COUNT(DISTINCT qa.question_id) AS distinct_questions,
              MAX(qa.created_at) AS last_seen
         FROM question_attempts qa
         JOIN question_knowledge qk
           ON qk.question_id = qa.question_id AND qk.is_primary = 1
        WHERE qa.user_id = ? AND qk.knowledge_point_id = ? AND qa.is_correct IS NOT NULL`,
    )
    .get(userId, pointId) as
    | { attempts: number; correct: number; distinct_questions: number; last_seen: string | null }
    | undefined;

  const attempts = row?.attempts ?? 0;
  const correct = row?.correct ?? 0;
  const distinct = row?.distinct_questions ?? 0;
  const mastery = attempts > 0 ? correct / attempts : 0;
  const confidence =
    Math.min(1, attempts / CONFIDENCE_MIN_ATTEMPTS) * Math.min(1, distinct / CONFIDENCE_MIN_DISTINCT);

  db.prepare(
    `INSERT INTO knowledge_mastery
       (user_id, knowledge_point_id, attempts, correct, distinct_questions, mastery, confidence, last_seen, updated_at)
     VALUES (@userId, @pointId, @attempts, @correct, @distinct, @mastery, @confidence, @lastSeen, @now)
     ON CONFLICT(user_id, knowledge_point_id) DO UPDATE SET
       attempts = excluded.attempts,
       correct = excluded.correct,
       distinct_questions = excluded.distinct_questions,
       mastery = excluded.mastery,
       confidence = excluded.confidence,
       last_seen = excluded.last_seen,
       updated_at = excluded.updated_at`,
  ).run({
    userId,
    pointId,
    attempts,
    correct,
    distinct,
    mastery,
    confidence,
    lastSeen: row?.last_seen ?? null,
    now,
  });
}

/**
 * 历史回填：把已交卷的整卷作答拆成逐题记录。
 * 用户归属取 exam_attempts.user_id 原值，不依赖请求作用域（启动期没有请求）。
 */
export function backfillExamAttempts(): { attempts: number; recorded: number; skipped: number } {
  const run = db.transaction(() => {
    const attempts = db
      .prepare(
        `SELECT id, user_id, language, paper_id, seconds, answers, writing, COALESCE(submitted_at, started_at) AS at
           FROM exam_attempts
          WHERE status = 'done'`,
      )
      .all() as Array<{
      id: string;
      user_id: string;
      language: string;
      paper_id: string;
      seconds: number;
      answers: string;
      writing: string;
      at: string;
    }>;

    let recorded = 0;
    let skipped = 0;
    for (const attempt of attempts) {
      const items = listItemRows(attempt.paper_id);
      const result = recordExamAttempt({
        attemptId: attempt.id,
        userId: attempt.user_id,
        language: attempt.language,
        items,
        answers: parseJsonArray(attempt.answers),
        writing: safeParseRecord(attempt.writing),
        seconds: attempt.seconds,
        createdAt: attempt.at,
      });
      recorded += result.recorded;
      skipped += result.skipped;
    }
    return { attempts: attempts.length, recorded, skipped };
  });
  return run();
}

function listItemRows(paperId: string): ExamItemLite[] {
  const rows = db
    .prepare(
      `SELECT id, paper_id, idx, section_key, section, kind, stem, passage, options, answer, sample_answer, explanation
         FROM exam_items WHERE paper_id = ? ORDER BY idx`,
    )
    .all(paperId) as Array<{
    id: string;
    paper_id: string;
    idx: number;
    section_key: string;
    section: string;
    kind: string;
    stem: string;
    passage: string;
    options: string;
    answer: number | null;
    sample_answer: string | null;
    explanation: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    paperId: row.paper_id,
    idx: row.idx,
    sectionKey: row.section_key,
    section: row.section,
    kind: row.kind === 'writing' ? 'writing' : 'choice',
    stem: row.stem,
    passage: row.passage ?? '',
    options: safeParseArray(row.options),
    answer: row.answer ?? -1,
    sampleAnswer: row.sample_answer ?? '',
    explanation: row.explanation ?? '',
  }));
}

function parseJsonArray(value: string): Array<number | null> {
  const parsed = safeParseArrayRaw(value);
  return parsed.map((entry) => (typeof entry === 'number' ? entry : null));
}

function safeParseArrayRaw(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item === 'string') out[key] = item;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 删除一份导入卷时，把它的逐题记录一并清掉，并重算受影响知识点的掌握度。
 * 不清理的话，掌握度里会一直算着一份已经不存在的卷子的成绩。
 */
export function purgePaperAttemptRecords(paperId: string): number {
  const run = db.transaction(() => {
    const sessions = db
      .prepare('SELECT id, user_id FROM exam_attempts WHERE paper_id = ?')
      .all(paperId) as Array<{ id: string; user_id: string }>;

    const touchedByUser = new Map<string, Set<string>>();
    let removed = 0;
    const remove = db.prepare("DELETE FROM question_attempts WHERE session_type = 'exam' AND session_id = ?");
    for (const session of sessions) {
      const points = db
        .prepare(
          `SELECT DISTINCT qk.knowledge_point_id AS id
             FROM question_attempts qa
             JOIN question_knowledge qk ON qk.question_id = qa.question_id AND qk.is_primary = 1
            WHERE qa.session_type = 'exam' AND qa.session_id = ?`,
        )
        .all(session.id) as Array<{ id: string }>;
      const bucket = touchedByUser.get(session.user_id) ?? new Set<string>();
      for (const point of points) bucket.add(point.id);
      touchedByUser.set(session.user_id, bucket);

      const info = remove.run(session.id);
      removed += info.changes;
    }

    const now = new Date().toISOString();
    for (const [userId, points] of touchedByUser) {
      for (const point of points) refreshMastery(userId, point, now);
    }
    return removed;
  });
  return run();
}

// ------------------------------------------------------------------ 读路径

export interface KnowledgeOverview {
  language: string;
  nodes: Array<
    KnowledgeNode & {
      questionCount: number;
      attempts: number;
      correct: number;
      distinctQuestions: number;
      mastery: number | null;
      confidence: number | null;
      lastSeen: string | null;
    }
  >;
  edges: KnowledgeEdge[];
  stats: {
    questions: number;
    taggedQuestions: number;
    attempts: number;
    /** 对不上任何知识点的作答条数 */
    untaggedAttempts: number;
    /** 无法归因到知识点的作答占比 0~1；报告必须透出这个数，否则诊断结论不可证伪 */
    untaggedRate: number;
    /** 置信度达标的知识点数：只有这些点允许下结论 */
    readyPoints: number;
  };
}

/** 某语种的知识树 + 当前用户的掌握度 + 覆盖率。只读，供诊断入口与核查脚本使用 */
export function getKnowledgeOverview(
  language: string,
  userId: string,
  minConfidence = 0.6,
): KnowledgeOverview {
  const nodes = listNodes(language);
  const mastery = new Map(
    (
      db
        .prepare(
          `SELECT knowledge_point_id AS id, attempts, correct, distinct_questions, mastery, confidence, last_seen
             FROM knowledge_mastery WHERE user_id = ?`,
        )
        .all(userId) as Array<{
        id: string;
        attempts: number;
        correct: number;
        distinct_questions: number;
        mastery: number;
        confidence: number;
        last_seen: string | null;
      }>
    ).map((row) => [row.id, row]),
  );
  const questionCounts = new Map(
    (
      db
        .prepare(
          `SELECT knowledge_point_id AS id, COUNT(*) AS n FROM question_knowledge
            WHERE knowledge_point_id IN (SELECT id FROM knowledge_points WHERE language = ?)
            GROUP BY knowledge_point_id`,
        )
        .all(language) as Array<{ id: string; n: number }>
    ).map((row) => [row.id, row.n]),
  );

  const questions = db
    .prepare("SELECT COUNT(*) AS n FROM questions WHERE language = ? AND status = 'active'")
    .get(language) as { n: number };
  const tagged = db
    .prepare(
      `SELECT COUNT(DISTINCT q.id) AS n
         FROM questions q JOIN question_knowledge qk ON qk.question_id = q.id
        WHERE q.language = ? AND q.status = 'active'`,
    )
    .get(language) as { n: number };
  const attempts = db
    .prepare('SELECT COUNT(*) AS n FROM question_attempts WHERE user_id = ? AND language = ?')
    .get(userId, language) as { n: number };
  const untagged = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM question_attempts qa
         JOIN questions q ON q.id = qa.question_id
        WHERE qa.user_id = ? AND qa.language = ?
          AND NOT EXISTS (SELECT 1 FROM question_knowledge qk WHERE qk.question_id = qa.question_id)`,
    )
    .get(userId, language) as { n: number };

  const decorated = nodes.map((node) => {
    const state = mastery.get(node.id);
    return {
      ...node,
      questionCount: questionCounts.get(node.id) ?? 0,
      attempts: state?.attempts ?? 0,
      correct: state?.correct ?? 0,
      distinctQuestions: state?.distinct_questions ?? 0,
      mastery: state?.mastery ?? null,
      confidence: state?.confidence ?? null,
      lastSeen: state?.last_seen ?? null,
    };
  });

  return {
    language,
    nodes: decorated,
    edges: listEdges(language),
    stats: {
      questions: questions.n,
      taggedQuestions: tagged.n,
      attempts: attempts.n,
      untaggedAttempts: untagged.n,
      untaggedRate: attempts.n > 0 ? untagged.n / attempts.n : 0,
      readyPoints: decorated.filter(
        (node) => node.kind === 'question_type' && (node.confidence ?? 0) >= minConfidence,
      ).length,
    },
  };
}

/** 启动期日志用：各语种题池覆盖率 */
export function knowledgeCoverageSummary(): Record<string, SyncStats> {
  const out: Record<string, SyncStats> = {};
  const rows = db
    .prepare(
      `SELECT q.language,
              COUNT(*) AS questions,
              SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM question_knowledge qk WHERE qk.question_id = q.id) THEN 1 ELSE 0 END) AS tagged
         FROM questions q WHERE q.status = 'active' GROUP BY q.language`,
    )
    .all() as Array<{ language: string; questions: number; tagged: number }>;
  for (const row of rows) {
    out[row.language] = {
      questions: row.questions,
      tagged: row.tagged,
      untagged: row.questions - row.tagged,
    };
  }
  return out;
}

/** 登记在册的知识树（启动日志与检查脚本用） */
export function registeredTreeLanguages(): string[] {
  return KNOWLEDGE_TREES.map((tree) => tree.language);
}

/** 供脚本定位问题：写一棵树并返回统计，失败只记日志不抛（与 ensureExamBank 的口径一致） */
export function seedKnowledgeTrees(): Array<{ language: string; nodes: number; edges: number }> {
  const out: Array<{ language: string; nodes: number; edges: number }> = [];
  for (const tree of KNOWLEDGE_TREES) {
    const result = upsertKnowledgeTree(tree);
    out.push({ language: tree.language, nodes: result.nodes, edges: result.edges });
  }
  return out;
}

export function logKnowledgeSummary(context: string): void {
  logger.info(context, {
    trees: registeredTreeLanguages(),
    coverage: knowledgeCoverageSummary(),
  });
}
