/**
 * LearnerStorePort / TracePort 的进程内实现（M0 = JSONL + JSON 文件）。
 *
 * 为什么先不上 SQLite：接口先定型，存储后换。
 * 这里刻意只用 append-only 事件流 + 快照 —— 它天然满足「可回滚」与「语种隔离」，
 * 等 M0.5 换 DB 时，改的只是这个文件里的三个方法，工具与内核一行不动。
 *
 * 落盘位置：<db 目录>/agent/ ，与 app.db 同盘，方便一起备份。
 * 用户主权区（rules/）优先读 ~/.lingua/rules/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import type { LearnerStorePort, TracePort } from '../ports';
import { AgentRunSchema, type AgentRun, type LearnerPatch } from '../protocols';
import type { ErrorRecord, LangCode, LearnerProfile } from '../types';

const ROOT = path.join(path.dirname(env.dbPath), 'agent');
const RULES_DIRS = [path.join(os.homedir(), '.lingua', 'rules'), path.join(ROOT, 'rules')];

/** 三振升级：同一错因累计到这个次数才升为长期错因（设计文档 §3.6） */
const PROMOTE_AT = 3;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function profileFile(userId: string): string {
  return path.join(ROOT, 'profile', `${userId}.json`);
}

function errorsFile(userId: string): string {
  return path.join(ROOT, 'errors', `${userId}.jsonl`);
}

function runsDir(): string {
  return path.join(ROOT, 'runs');
}

/** M0 的默认水平：M0.5 改成从 Language Pack 的 levelScale 取首个可用档位 */
const DEFAULT_LEVEL: Record<string, { scale: string; band: string }> = {
  en: { scale: 'cefr', band: 'B2' },
  ja: { scale: 'jlpt', band: 'N3' },
  ko: { scale: 'topik', band: '4' },
};

interface StoredProfile {
  targetExam?: string;
  examDate?: string;
  dailyMinutes?: number;
  level?: { scale: string; band: string };
  style?: string[];
}

function readStoredProfile(userId: string): StoredProfile {
  const file = profileFile(userId);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredProfile;
  } catch (err) {
    logger.warn('档案 JSON 损坏，按空档案处理', { file, err: (err as Error).message });
    return {};
  }
}

/** 用户守则：只读，文件是权威（用户手改优先于任何 DB 记录） */
function readUserRules(): string[] {
  const out: string[] = [];
  for (const dir of RULES_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      try {
        out.push(fs.readFileSync(path.join(dir, name), 'utf8').trim());
      } catch {
        // 单个文件读不了就跳过，不值得让整次 run 失败
      }
    }
  }
  return out.filter(Boolean);
}

type ErrorEvent =
  | { at: string; lang: string; ruleId: string; op: 'inc'; evidence: string; quote?: string }
  | { at: string; lang: string; ruleId: string; op: 'promote' }
  | { at: string; lang: string; ruleId: string; op: 'resolve' };

/** 重放事件得到当前错因状态；按语种过滤，跨语种互不污染 */
function replayErrors(userId: string, lang: LangCode, loopDb?: DatabaseType.Database): ErrorRecord[] {
  const file = errorsFile(userId);
  if (!fs.existsSync(file)) return [];

  const map = new Map<string, ErrorRecord>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event: ErrorEvent;
    try {
      event = JSON.parse(line) as ErrorEvent;
    } catch {
      continue;
    }
    if (event.lang !== lang) continue;

    const current =
      map.get(event.ruleId) ??
      ({
        ruleId: event.ruleId,
        status: 'candidate',
        count: 0,
        firstSeenAt: event.at,
        lastSeenAt: event.at,
        evidence: [],
      } satisfies ErrorRecord);

    if (event.op === 'inc') {
      current.count += 1;
      current.lastSeenAt = event.at;
      if (event.evidence) current.evidence = [...current.evidence.slice(-9), event.evidence];
    } else if (event.op === 'promote') {
      current.status = 'long-term';
    } else {
      current.status = 'resolved';
    }
    map.set(event.ruleId, current);
  }

  const result = [...map.values()].filter((item) => item.status !== 'resolved').sort((a, b) => b.count - a.count);

  // 聚合 Loop 复习中的遗忘次数（grade <= 1）
  if (loopDb) {
    try {
      const lapseRows = loopDb
        .prepare(
          `SELECT c.rule_id, COUNT(*) AS lapses
           FROM loop_card_events e
           JOIN loop_cards c ON c.id = e.card_id
           WHERE c.user_id = ? AND c.rule_id IS NOT NULL AND e.grade <= 1
           GROUP BY c.rule_id`,
        )
        .all(userId) as Array<{ rule_id: string; lapses: number }>;
      for (const row of lapseRows) {
        const record = result.find((item) => item.ruleId === row.rule_id);
        if (record) record.lapseCount = row.lapses;
      }
    } catch {
      // loop 表可能不存在，忽略
    }
  }

  return result;
}

export function createLearnerStore(loopDb?: DatabaseType.Database): LearnerStorePort {
  return {
    async read({ userId, lang, topN = 5 }): Promise<LearnerProfile> {
      const stored = readStoredProfile(userId);
      const errors = replayErrors(userId, lang, loopDb);
      let daysLeft: number | undefined;
      if (stored.examDate) {
        const diff = Math.ceil((new Date(stored.examDate).getTime() - Date.now()) / 86_400_000);
        if (Number.isFinite(diff)) daysLeft = diff;
      }
      return {
        userId,
        lang,
        level: stored.level ?? DEFAULT_LEVEL[lang] ?? { scale: 'cefr', band: 'B1' },
        targetExam: stored.targetExam,
        examDate: stored.examDate,
        daysLeft,
        dailyMinutes: stored.dailyMinutes,
        topErrors: errors.slice(0, topN),
        style: stored.style ?? [],
        rules: readUserRules(),
      };
    },

    async applyPatch(patch: LearnerPatch, opts) {
      const pending = patch.ops.map((op) =>
        op.op === 'inc'
          ? { op: op.op, detail: `记一次「${op.ruleId}」` }
          : op.op === 'promote'
            ? { op: op.op, detail: `把「${op.ruleId}」升为 ${op.to}` }
            : { op: op.op, detail: `设置 ${op.key}` },
      );

      // 未确认时只回显「将要写什么」—— 档案写错会污染后续所有推理
      if (!opts.confirm) return { applied: false, added: [], promoted: [], pending };

      ensureDir(path.dirname(errorsFile(patch.userId)));
      const file = errorsFile(patch.userId);
      const at = new Date().toISOString();
      const lines: string[] = [];
      const added: string[] = [];
      const promoted: string[] = [];
      const before = replayErrors(patch.userId, patch.lang as LangCode, loopDb);

      for (const op of patch.ops) {
        if (op.op === 'inc') {
          lines.push(JSON.stringify({ at, lang: patch.lang, ruleId: op.ruleId, op: 'inc', evidence: op.evidence, quote: op.quote }));
          added.push(op.ruleId);
          const current = before.find((item) => item.ruleId === op.ruleId);
          const nextCount = (current?.count ?? 0) + 1;
          if (nextCount >= PROMOTE_AT && current?.status !== 'long-term') {
            lines.push(JSON.stringify({ at, lang: patch.lang, ruleId: op.ruleId, op: 'promote' }));
            promoted.push(op.ruleId);
          }
        } else if (op.op === 'promote') {
          lines.push(JSON.stringify({ at, lang: patch.lang, ruleId: op.ruleId, op: 'promote' }));
          promoted.push(op.ruleId);
        } else {
          lines.push(JSON.stringify({ at, lang: patch.lang, ruleId: op.key, op: 'resolve' }));
        }
      }

      fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      logger.info('learner profile patched', { user: patch.userId, lang: patch.lang, ops: patch.ops.length });
      return { applied: true, added, promoted };
    },

    async findError(userId, lang, ruleId) {
      return replayErrors(userId, lang, loopDb).find((item) => item.ruleId === ruleId) ?? null;
    },
  };
}

export function createTraceStore(): TracePort {
  return {
    async save(run) {
      ensureDir(runsDir());
      fs.writeFileSync(path.join(runsDir(), `${run.runId}.json`), JSON.stringify(run, null, 2), 'utf8');
    },

    async load(runId) {
      const file = path.join(runsDir(), `${runId}.json`);
      if (!fs.existsSync(file)) return null;
      try {
        return AgentRunSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) as AgentRun;
      } catch (err) {
        logger.warn('run trace 解析失败', { runId, err: (err as Error).message });
        return null;
      }
    },

    async list(limit = 20) {
      if (!fs.existsSync(runsDir())) return [];
      return fs
        .readdirSync(runsDir())
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const file = path.join(runsDir(), name);
          try {
            const run = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentRun;
            return { runId: run.runId, scene: run.scene, startedAt: run.startedAt, ok: run.ok };
          } catch {
            return null;
          }
        })
        .filter((item): item is { runId: string; scene: string; startedAt: string; ok: boolean } => item !== null)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit);
    },
  };
}
