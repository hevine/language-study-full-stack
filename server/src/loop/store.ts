import { randomUUID } from 'node:crypto';
import type { AgentRun, Artifact } from '../agent/protocols';
import type DatabaseType from 'better-sqlite3';
import { db } from '../db';
import { addDays, diffDays, todayISO } from '../lib/date';
import { logger } from '../lib/logger';
import { scheduleNext, type Grade } from '../services/srs';
import { deriveCards } from './derive';
import {
  documentKindForScene,
  sceneOf,
  type AdoptLoopResult,
  type DerivedCard,
  type LoopArtifact,
  type LoopCard,
  type LoopCardKind,
  type LoopCardStatus,
  type LoopDocument,
  type LoopStats,
  type LoopToday,
} from './types';

const MAX_DAILY_REVIEW = 20;

// ---------------------------------------------------------------------------
// 反馈钩子：gradeCard 评分后异步通知 Agent 的错因档案
// ---------------------------------------------------------------------------

type GradeFeedbackHook = (
  ruleId: string,
  action: 'inc' | 'resolve',
  evidence: string,
) => Promise<void>;

let feedbackHook: GradeFeedbackHook | null = null;

/** Orchestrator 初始化时调用，把 LearnerStorePort.applyPatch 接上 */
export function setFeedbackHook(hook: GradeFeedbackHook | null): void {
  feedbackHook = hook;
}

// ---------------------------------------------------------------------------
// Row 类型 & 映射
// ---------------------------------------------------------------------------

interface LoopCardRow {
  id: string;
  user_id: string;
  document_id: string;
  artifact_id: string;
  run_id: string | null;
  lang: string;
  kind: LoopCardKind;
  front: string;
  back: string;
  context: string | null;
  rule_id: string | null;
  source_ref: string | null;
  status: LoopCardStatus;
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  good_streak: number;
  due_date: string;
  created_at: string;
  updated_at: string;
}

interface LoopDocumentRow {
  id: string;
  user_id: string;
  lang: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  run_id: string | null;
  created_at: string;
  card_count: number;
  active_count: number;
}

interface LoopArtifactRow {
  id: string;
  user_id: string;
  run_id: string;
  document_id: string;
  type: string;
  title: string;
  state: LoopArtifact['state'];
  data_json: string;
  created_at: string;
  adopted_at: string | null;
  parent_artifact_id: string | null;
  card_count?: number;
}

function nowLocal(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${todayISO()}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function mapCard(row: LoopCardRow): LoopCard {
  return {
    id: row.id,
    userId: row.user_id,
    documentId: row.document_id,
    artifactId: row.artifact_id,
    runId: row.run_id,
    lang: row.lang,
    kind: row.kind,
    front: row.front,
    back: row.back,
    context: row.context,
    ruleId: row.rule_id,
    sourceRef: row.source_ref,
    status: row.status,
    ease: row.ease,
    intervalDays: row.interval_days,
    reps: row.reps,
    lapses: row.lapses,
    goodStreak: row.good_streak,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDocument(row: LoopDocumentRow): LoopDocument {
  return {
    id: row.id,
    userId: row.user_id,
    lang: row.lang,
    kind: row.kind,
    title: row.title,
    content: row.content,
    source: row.source,
    runId: row.run_id,
    createdAt: row.created_at,
    cardCount: row.card_count,
    activeCount: row.active_count,
  };
}

function mapArtifact(row: LoopArtifactRow): LoopArtifact {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    documentId: row.document_id,
    type: row.type,
    title: row.title,
    state: row.state,
    createdAt: row.created_at,
    adoptedAt: row.adopted_at,
    parentArtifactId: row.parent_artifact_id,
    cardCount: row.card_count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// LoopStore 工厂：接收 Database 实例，主项目与 standalone 各传各的
// ---------------------------------------------------------------------------

export interface LoopStore {
  adoptToLoop(input: {
    userId: string;
    run: AgentRun;
    artifact: Artifact;
    confirm: boolean;
  }): AdoptLoopResult;
  dueCards(userId: string, date?: string, limit?: number): LoopCard[];
  gradeCard(
    userId: string,
    cardId: string,
    grade: Grade,
    ms: number,
  ): { dueDate: string; intervalDays: number; status: LoopCardStatus; ease: number } | null;
  loopStats(userId: string): LoopStats;
  loopToday(userId: string): LoopToday;
  listDocuments(userId: string, limit?: number): LoopDocument[];
  listArtifacts(userId: string, limit?: number): LoopArtifact[];
  listCards(userId: string, documentId?: string): LoopCard[];
  dismissArtifact(userId: string, artifactId: string): boolean;
  suspendDocument(userId: string, documentId: string): number;
  exportLoop(userId: string): {
    documents: LoopDocument[];
    cards: LoopCard[];
    events: unknown[];
    artifacts: LoopArtifact[];
  };
  loopRetentionHint(userId: string): number;
}

export function createLoopStore(database: DatabaseType.Database): LoopStore {
  function ensureDocument(input: {
    userId: string;
    run: AgentRun;
    artifact: Artifact;
    text: string;
  }): string {
    const id = `doc_${input.run.runId}`;
    const exists = database.prepare('SELECT id FROM loop_documents WHERE id = ?').get(id);
    if (exists) return id;

    const scene = sceneOf(input.run);
    const title = input.text.slice(0, 24).replace(/\s+/g, ' ').trim() || input.artifact.title;
    database
      .prepare(
        `INSERT OR IGNORE INTO loop_documents
          (id, user_id, lang, kind, title, content, source, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.run.lang,
        documentKindForScene(scene),
        title,
        input.text,
        input.run.runId,
        nowLocal(),
      );
    return id;
  }

  function upsertArtifact(input: {
    userId: string;
    run: AgentRun;
    artifact: Artifact;
    documentId: string;
    state: 'draft' | 'adopted';
  }): void {
    database
      .prepare(
        `INSERT INTO loop_artifacts
          (id, user_id, run_id, document_id, type, title, state, data_json, created_at, adopted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           adopted_at = excluded.adopted_at,
           document_id = excluded.document_id`,
      )
      .run(
        input.artifact.artifactId,
        input.userId,
        input.run.runId,
        input.documentId,
        input.artifact.type,
        input.artifact.title,
        input.state,
        JSON.stringify(input.artifact.data),
        nowLocal(),
        input.state === 'adopted' ? nowLocal() : null,
      );
  }

  function cardExists(userId: string, documentId: string, card: DerivedCard): boolean {
    if (!documentId) return false;
    const row = database
      .prepare(
        'SELECT 1 FROM loop_cards WHERE user_id = ? AND document_id = ? AND kind = ? AND front = ? LIMIT 1',
      )
      .get(userId, documentId, card.kind, card.front);
    return Boolean(row);
  }

  function adoptToLoop(input: {
    userId: string;
    run: AgentRun;
    artifact: Artifact;
    confirm: boolean;
  }): AdoptLoopResult {
    const derived = deriveCards(input.run, input.artifact);
    const text = typeof input.run.input?.text === 'string' ? input.run.input.text.trim() : '';
    const documentId = text ? `doc_${input.run.runId}` : '';

    const preview = derived.filter((card) => !cardExists(input.userId, documentId, card));
    if (!input.confirm) return { preview, created: 0 };

    if (text) {
      ensureDocument({ userId: input.userId, run: input.run, artifact: input.artifact, text });
    }

    const now = nowLocal();
    const today = todayISO();
    let created = 0;

    const apply = database.transaction(() => {
      upsertArtifact({
        userId: input.userId,
        run: input.run,
        artifact: input.artifact,
        documentId,
        state: 'adopted',
      });
      const insert = database.prepare(
        `INSERT OR IGNORE INTO loop_cards
          (id, user_id, document_id, artifact_id, run_id, lang, kind, front, back, context,
           rule_id, source_ref, status, ease, interval_days, reps, lapses, good_streak,
           due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 2.5, 1, 0, 0, 0, ?, ?, ?)`,
      );
      for (const card of preview) {
        const dueDate = card.kind === 'error' ? today : addDays(today, 1);
        const result = insert.run(
          randomUUID(),
          input.userId,
          documentId,
          input.artifact.artifactId,
          input.run.runId,
          input.run.lang,
          card.kind,
          card.front,
          card.back,
          card.context ?? null,
          card.ruleId ?? null,
          card.sourceRef ?? null,
          dueDate,
          now,
          now,
        );
        created += result.changes;
      }
    });
    apply();

    return { preview, created };
  }

  function dueCards(
    userId: string,
    date = todayISO(),
    limit = MAX_DAILY_REVIEW,
  ): LoopCard[] {
    const rows = database
      .prepare(
        `SELECT * FROM loop_cards
         WHERE user_id = ? AND status = 'active' AND due_date <= ?
         ORDER BY due_date ASC, kind ASC
         LIMIT ?`,
      )
      .all(userId, date, limit) as LoopCardRow[];
    return rows.map(mapCard);
  }

  function gradeCard(
    userId: string,
    cardId: string,
    grade: Grade,
    ms: number,
  ): { dueDate: string; intervalDays: number; status: LoopCardStatus; ease: number } | null {
    const row = database
      .prepare('SELECT * FROM loop_cards WHERE id = ? AND user_id = ?')
      .get(cardId, userId) as LoopCardRow | undefined;
    if (!row) return null;

    const next = scheduleNext(
      { ease: row.ease, intervalDays: row.interval_days, reps: row.reps, lapses: row.lapses },
      grade,
    );
    const goodStreak = grade >= 2 ? row.good_streak + 1 : 0;
    const status: LoopCardStatus =
      goodStreak >= 3 && next.intervalDays >= 21 ? 'mastered' : row.status;

    const apply = database.transaction(() => {
      database
        .prepare(
          `UPDATE loop_cards
           SET ease = ?, interval_days = ?, reps = ?, lapses = ?, good_streak = ?,
               status = ?, due_date = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(
          next.ease,
          next.intervalDays,
          next.reps,
          next.lapses,
          goodStreak,
          status,
          next.dueDate,
          nowLocal(),
          cardId,
          userId,
        );
      database
        .prepare(
          `INSERT INTO loop_card_events (id, user_id, card_id, at, grade, ms, mode)
           VALUES (?, ?, ?, ?, ?, ?, 'review')`,
        )
        .run(randomUUID(), userId, cardId, nowLocal(), grade, Math.max(0, Math.round(ms)));
    });
    apply();

    // 反馈钩子：异步通知 Agent 错因档案，不阻塞评分响应
    if (feedbackHook && row.rule_id) {
      const action: 'inc' | 'resolve' | null =
        grade <= 1 ? 'inc' : status === 'mastered' ? 'resolve' : null;
      if (action) {
        const evidence = `loop:${cardId}`;
        feedbackHook(row.rule_id, action, evidence).catch((err) =>
          logger.warn('loop feedback hook 失败', { ruleId: row.rule_id, err: (err as Error).message }),
        );
      }
    }

    return { dueDate: next.dueDate, intervalDays: next.intervalDays, status, ease: next.ease };
  }

  function loopStats(userId: string): LoopStats {
    const today = todayISO();
    const from = addDays(today, -6);

    const adopted = database
      .prepare(
        `SELECT * FROM loop_artifacts
         WHERE user_id = ? AND state = 'adopted' AND adopted_at IS NOT NULL
           AND substr(adopted_at, 1, 10) >= ?`,
      )
      .all(userId, from) as LoopArtifactRow[];

    const hasCard = database.prepare(
      'SELECT 1 FROM loop_cards WHERE user_id = ? AND artifact_id = ? LIMIT 1',
    );
    const closed = adopted.filter((artifact) => Boolean(hasCard.get(userId, artifact.id)));

    const verifiedStmt = database.prepare(
      `SELECT 1
       FROM loop_card_events e
       JOIN loop_cards c ON c.id = e.card_id
       WHERE c.user_id = ? AND c.artifact_id = ? AND substr(e.at, 1, 10) <= ?
       LIMIT 1`,
    );
    const verified = closed.filter((artifact) => {
      if (!artifact.adopted_at) return false;
      const limit = addDays(artifact.adopted_at.slice(0, 10), 7);
      return Boolean(verifiedStmt.get(userId, artifact.id, limit));
    });

    const retentionFrom = addDays(today, -29);
    const recentEvents = database
      .prepare('SELECT grade FROM loop_card_events WHERE user_id = ? AND substr(at, 1, 10) >= ?')
      .all(userId, retentionFrom) as Array<{ grade: number }>;
    const retention =
      recentEvents.length === 0
        ? 0
        : recentEvents.filter((event) => event.grade >= 2).length / recentEvents.length;

    const dayRows = database
      .prepare(
        `SELECT DISTINCT day FROM (
           SELECT substr(at, 1, 10) AS day FROM loop_card_events WHERE user_id = ?
           UNION
           SELECT substr(adopted_at, 1, 10) AS day FROM loop_artifacts
           WHERE user_id = ? AND adopted_at IS NOT NULL
         )`,
      )
      .all(userId, userId) as Array<{ day: string }>;
    const activeDays = new Set(dayRows.map((row) => row.day));

    let cursor = today;
    if (!activeDays.has(cursor)) cursor = addDays(cursor, -1);
    let streak = 0;
    while (activeDays.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }

    const due = database
      .prepare(
        `SELECT COUNT(*) AS n FROM loop_cards
         WHERE user_id = ? AND status = 'active' AND due_date <= ?`,
      )
      .get(userId, today) as { n: number };
    const reviewed = database
      .prepare(
        'SELECT COUNT(*) AS n FROM loop_card_events WHERE user_id = ? AND substr(at, 1, 10) = ?',
      )
      .get(userId, today) as { n: number };

    return {
      closed: closed.length,
      quality: closed.length === 0 ? 0 : verified.length / closed.length,
      retention,
      streak,
      due: due.n,
      reviewedToday: reviewed.n,
    };
  }

  function loopToday(userId: string): LoopToday {
    const stats = loopStats(userId);
    const cards = dueCards(userId);
    const recent = listArtifacts(userId, 2).filter((artifact) => artifact.state === 'adopted');
    return {
      due: stats.due,
      minutes: Math.max(1, Math.ceil(stats.due / 2)),
      reviewedToday: stats.reviewedToday,
      cards,
      recent,
      stats,
    };
  }

  function listDocuments(userId: string, limit = 100): LoopDocument[] {
    const rows = database
      .prepare(
        `SELECT d.*,
                COUNT(c.id) AS card_count,
                COALESCE(SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END), 0) AS active_count
         FROM loop_documents d
         LEFT JOIN loop_cards c ON c.document_id = d.id AND c.user_id = d.user_id
         WHERE d.user_id = ?
         GROUP BY d.id
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as LoopDocumentRow[];
    return rows.map(mapDocument);
  }

  function listArtifacts(userId: string, limit = 100): LoopArtifact[] {
    const rows = database
      .prepare(
        `SELECT a.*, COUNT(c.id) AS card_count
         FROM loop_artifacts a
         LEFT JOIN loop_cards c ON c.artifact_id = a.id AND c.user_id = a.user_id
         WHERE a.user_id = ?
         GROUP BY a.id
         ORDER BY a.created_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as LoopArtifactRow[];
    return rows.map(mapArtifact);
  }

  function listCards(userId: string, documentId?: string): LoopCard[] {
    const rows = documentId
      ? (database
          .prepare(
            'SELECT * FROM loop_cards WHERE user_id = ? AND document_id = ? ORDER BY created_at DESC',
          )
          .all(userId, documentId) as LoopCardRow[])
      : (database
          .prepare('SELECT * FROM loop_cards WHERE user_id = ? ORDER BY due_date ASC LIMIT 500')
          .all(userId) as LoopCardRow[]);
    return rows.map(mapCard);
  }

  function dismissArtifact(userId: string, artifactId: string): boolean {
    const result = database
      .prepare(
        "UPDATE loop_artifacts SET state = 'dismissed' WHERE id = ? AND user_id = ? AND state = 'draft'",
      )
      .run(artifactId, userId);
    return result.changes > 0;
  }

  function suspendDocument(userId: string, documentId: string): number {
    const result = database
      .prepare(
        "UPDATE loop_cards SET status = 'suspended', updated_at = ? WHERE user_id = ? AND document_id = ? AND status = 'active'",
      )
      .run(nowLocal(), userId, documentId);
    return result.changes;
  }

  function exportLoop(userId: string): {
    documents: LoopDocument[];
    cards: LoopCard[];
    events: unknown[];
    artifacts: LoopArtifact[];
  } {
    const events = database
      .prepare('SELECT * FROM loop_card_events WHERE user_id = ? ORDER BY at ASC')
      .all(userId) as unknown[];
    return {
      documents: listDocuments(userId, 1000),
      cards: listCards(userId),
      events,
      artifacts: listArtifacts(userId, 1000),
    };
  }

  function loopRetentionHint(userId: string): number {
    const row = database
      .prepare('SELECT COUNT(*) AS n FROM loop_cards WHERE user_id = ?')
      .get(userId) as { n: number };
    return row.n;
  }

  return {
    adoptToLoop,
    dueCards,
    gradeCard,
    loopStats,
    loopToday,
    listDocuments,
    listArtifacts,
    listCards,
    dismissArtifact,
    suspendDocument,
    exportLoop,
    loopRetentionHint,
  };
}

// ---------------------------------------------------------------------------
// 默认实例（向后兼容：主项目直接用模块级函数）
// ---------------------------------------------------------------------------

const defaultStore = createLoopStore(db);

export const adoptToLoop = defaultStore.adoptToLoop;
export const dueCards = defaultStore.dueCards;
export const gradeCard = defaultStore.gradeCard;
export const loopStats = defaultStore.loopStats;
export const loopToday = defaultStore.loopToday;
export const listDocuments = defaultStore.listDocuments;
export const listArtifacts = defaultStore.listArtifacts;
export const listCards = defaultStore.listCards;
export const dismissArtifact = defaultStore.dismissArtifact;
export const suspendDocument = defaultStore.suspendDocument;
export const exportLoop = defaultStore.exportLoop;
export const loopRetentionHint = defaultStore.loopRetentionHint;

export { diffDays };
