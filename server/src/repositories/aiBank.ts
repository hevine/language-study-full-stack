import { randomUUID } from 'node:crypto';
import { db, parseJson } from '../db';

/** 大模型生成的练习条目类型：选择题 / 单词 / 待拆解的句子 / 写作口语题 */
export type AiItemType = 'quiz' | 'word' | 'sentence' | 'prompt';

export interface AiQuizItem {
  type: 'quiz';
  prompt: string;
  options: string[];
  answer: number;
  explain: string;
}

export interface AiWordItem {
  type: 'word';
  term: string;
  reading: string;
  pos: string;
  meaning: string;
  example: string;
  exampleCn: string;
}

export interface AiSentenceItem {
  type: 'sentence';
  text: string;
  translation: string;
  tips: string[];
}

export interface AiPromptItem {
  type: 'prompt';
  title: string;
  scenario: string;
  outline: string[];
  phrases: string[];
  sample: string;
}

export type AiItem = AiQuizItem | AiWordItem | AiSentenceItem | AiPromptItem;

export interface AiRunInput {
  userId: string;
  cacheKey: string;
  language: string;
  kind: string;
  levelId: string;
  topic: string;
  planId: string | null;
  dayId: string | null;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  items: AiItem[];
  newCount: number;
  status?: string;
  notice?: string | null;
}

export interface AiRunRecord {
  id: string;
  cacheKey: string;
  language: string;
  kind: string;
  levelId: string;
  topic: string;
  model: string | null;
  provider: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  itemCount: number;
  newCount: number;
  items: AiItem[];
  latencyMs: number;
  status: string;
  notice: string | null;
  createdAt: string;
}

interface RunRow {
  id: string;
  cache_key: string;
  language: string;
  kind: string;
  level_id: string;
  topic: string;
  model: string | null;
  provider: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  item_count: number;
  new_count: number;
  items_json: string;
  latency_ms: number;
  status: string;
  notice: string | null;
  created_at: string;
}

function mapRun(row: RunRow): AiRunRecord {
  return {
    id: row.id,
    cacheKey: row.cache_key,
    language: row.language,
    kind: row.kind,
    levelId: row.level_id,
    topic: row.topic,
    model: row.model,
    provider: row.provider,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    itemCount: row.item_count,
    newCount: row.new_count,
    items: parseJson<AiItem[]>(row.items_json, []),
    latencyMs: row.latency_ms,
    status: row.status,
    notice: row.notice,
    createdAt: row.created_at,
  };
}

/** 一次生成动作：连同这一批内容一起落库，5 分钟内复用时直接读它 */
export function insertRun(input: AiRunInput): AiRunRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_gen_runs
      (id, user_id, cache_key, language, kind, level_id, topic, plan_id, day_id,
       model, provider, prompt_tokens, completion_tokens, total_tokens, item_count, new_count,
       items_json, latency_ms, status, notice, created_at)
     VALUES
      (@id, @user_id, @cache_key, @language, @kind, @level_id, @topic, @plan_id, @day_id,
       @model, @provider, @prompt_tokens, @completion_tokens, @total_tokens, @item_count, @new_count,
       @items_json, @latency_ms, @status, @notice, @created_at)`,
  ).run({
    id,
    user_id: input.userId,
    cache_key: input.cacheKey,
    language: input.language,
    kind: input.kind,
    level_id: input.levelId,
    topic: input.topic,
    plan_id: input.planId,
    day_id: input.dayId,
    model: input.model,
    provider: input.provider,
    prompt_tokens: input.promptTokens,
    completion_tokens: input.completionTokens,
    total_tokens: input.totalTokens,
    item_count: input.items.length,
    new_count: input.newCount,
    items_json: JSON.stringify(input.items),
    latency_ms: input.latencyMs,
    status: input.status ?? 'ok',
    notice: input.notice ?? null,
    created_at: now,
  });

  return mapRun(db.prepare('SELECT * FROM ai_gen_runs WHERE id = ?').get(id) as RunRow);
}

/** 找到 withinMs 内同一批次的成功生成，用于「5 分钟内不重复生成」 */
export function findRecentRun(userId: string, cacheKey: string, withinMs: number): AiRunRecord | null {
  const since = new Date(Date.now() - withinMs).toISOString();
  const row = db
    .prepare(
      `SELECT * FROM ai_gen_runs
        WHERE user_id = ? AND cache_key = ? AND status = 'ok' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId, cacheKey, since) as RunRow | undefined;
  if (!row) return null;
  const run = mapRun(row);
  return run.items.length > 0 ? run : null;
}

export interface AiNewItem {
  itemType: AiItemType;
  payload: AiItem;
  fingerprint: string;
}

/** 题库写入：同指纹直接跳过，返回真正新增的数量 */
export function insertBankItems(params: {
  runId: string;
  userId: string;
  language: string;
  kind: string;
  levelId: string;
  topic: string;
  planId: string | null;
  dayId: string | null;
  model: string;
  provider: string;
  items: AiNewItem[];
}): { inserted: number; duplicates: number } {
  const statement = db.prepare(
    `INSERT OR IGNORE INTO ai_bank_items
      (id, run_id, user_id, language, kind, level_id, topic, item_type, payload, fingerprint, model, provider, plan_id, day_id, created_at)
     VALUES
      (@id, @run_id, @user_id, @language, @kind, @level_id, @topic, @item_type, @payload, @fingerprint, @model, @provider, @plan_id, @day_id, @created_at)`,
  );
  const now = new Date().toISOString();
  let inserted = 0;

  const tx = db.transaction(() => {
    for (const item of params.items) {
      const result = statement.run({
        id: randomUUID(),
        run_id: params.runId,
        user_id: params.userId,
        language: params.language,
        kind: params.kind,
        level_id: params.levelId,
        topic: params.topic,
        item_type: item.itemType,
        payload: JSON.stringify(item.payload),
        fingerprint: item.fingerprint,
        model: params.model,
        provider: params.provider,
        plan_id: params.planId,
        day_id: params.dayId,
        created_at: now,
      });
      inserted += result.changes;
    }
  });
  tx();

  return { inserted, duplicates: params.items.length - inserted };
}

/** 一批生成真正新增了多少条（先插 run 再插条目，所以这里回填） */
export function updateRunNewCount(runId: string, newCount: number): void {
  db.prepare('UPDATE ai_gen_runs SET new_count = ? WHERE id = ?').run(newCount, runId);
}

export interface AiBankItemView {
  id: string;
  language: string;
  kind: string;
  levelId: string;
  topic: string;
  itemType: AiItemType;
  payload: AiItem;
  model: string | null;
  provider: string | null;
  createdAt: string;
}

interface ItemRow {
  id: string;
  language: string;
  kind: string;
  level_id: string;
  topic: string;
  item_type: string;
  payload: string;
  model: string | null;
  provider: string | null;
  created_at: string;
}

export function listBank(params: {
  userId: string;
  language?: string;
  kind?: string;
  limit?: number;
}): AiBankItemView[] {
  const where: string[] = ['user_id = ?'];
  const args: unknown[] = [params.userId];
  if (params.language) {
    where.push('language = ?');
    args.push(params.language);
  }
  if (params.kind) {
    where.push('kind = ?');
    args.push(params.kind);
  }
  const limit = Math.min(Math.max(params.limit ?? 60, 1), 300);
  const rows = db
    .prepare(
      `SELECT * FROM ai_bank_items WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT ${limit}`,
    )
    .all(...args) as ItemRow[];

  return rows.map((row) => ({
    id: row.id,
    language: row.language,
    kind: row.kind,
    levelId: row.level_id,
    topic: row.topic,
    itemType: row.item_type as AiItemType,
    payload: parseJson<AiItem>(row.payload, { type: 'quiz', prompt: '', options: [], answer: 0, explain: '' }),
    model: row.model,
    provider: row.provider,
    createdAt: row.created_at,
  }));
}

export function deleteBankItem(userId: string, id: string): boolean {
  const result = db.prepare('DELETE FROM ai_bank_items WHERE user_id = ? AND id = ?').run(userId, id);
  return result.changes > 0;
}

/** 题库里同一批次里已有的题干，用来在提示词里避开重复（少花 token） */
export function recentStems(params: {
  userId: string;
  language: string;
  kind: string;
  topic: string;
  limit?: number;
}): string[] {
  const rows = db
    .prepare(
      `SELECT payload FROM ai_bank_items
        WHERE user_id = ? AND language = ? AND kind = ? AND topic = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(params.userId, params.language, params.kind, params.topic, params.limit ?? 8) as Array<{
    payload: string;
  }>;

  return rows
    .map((row) => {
      const payload = parseJson<Record<string, unknown>>(row.payload, {});
      const text = [payload.prompt, payload.term, payload.text, payload.title].find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      );
      return text?.trim() ?? '';
    })
    .filter((text) => text.length > 0);
}

export interface AiBankStats {
  today: { runs: number; tokens: number; items: number };
  total: { runs: number; tokens: number; items: number };
  byModel: Array<{ model: string; provider: string | null; runs: number; tokens: number }>;
}

export function bankStats(userId: string): AiBankStats {
  // 「今天」按本地时区算：created_at 存的是 UTC ISO，用本地零点换算才不会有 8 小时偏差
  const localMidnight = new Date();
  localMidnight.setHours(0, 0, 0, 0);
  const dayStart = localMidnight.toISOString();
  const today = db
    .prepare(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(total_tokens), 0) AS tokens
         FROM ai_gen_runs WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, dayStart) as { runs: number; tokens: number };
  const todayItems = db
    .prepare('SELECT COUNT(*) AS n FROM ai_bank_items WHERE user_id = ? AND created_at >= ?')
    .get(userId, dayStart) as { n: number };
  const total = db
    .prepare(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(total_tokens), 0) AS tokens
         FROM ai_gen_runs WHERE user_id = ?`,
    )
    .get(userId) as { runs: number; tokens: number };
  const totalItems = db.prepare('SELECT COUNT(*) AS n FROM ai_bank_items WHERE user_id = ?').get(userId) as {
    n: number;
  };
  const byModel = db
    .prepare(
      `SELECT COALESCE(model, '未知模型') AS model, provider, COUNT(*) AS runs, COALESCE(SUM(total_tokens), 0) AS tokens
         FROM ai_gen_runs WHERE user_id = ?
        GROUP BY model, provider ORDER BY tokens DESC LIMIT 6`,
    )
    .all(userId) as Array<{ model: string; provider: string | null; runs: number; tokens: number }>;

  return {
    today: { runs: today.runs, tokens: today.tokens, items: todayItems.n },
    total: { runs: total.runs, tokens: total.tokens, items: totalItems.n },
    byModel,
  };
}
