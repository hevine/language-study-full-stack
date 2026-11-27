/**
 * 今日任务生成次数自检（npm run check:day）。
 *
 * 要守住的三条产品约定：
 *   1. 今日任务每天只生成一次；各语种各一次、各目标各一次；
 *   2. 换目标（另一个计划）→ 重新生成；今天该目标生成过 → 走缓存；
 *   3. 换语种 → 重新生成；今天该语种该目标生成过 → 走缓存；
 * 外加一条一致性底线：请求语种与当前激活计划不一致时必须报 LANGUAGE_MISMATCH，
 * 而不是把别语种的内容返回给界面。
 *
 * 这里用临时数据目录跑真实的仓储 + 服务（未配模型 → 内置库兜底，不花 token），
 * 并发用 Promise.all 在同一 tick 发起，正好复现 StrictMode 双 effect 的形态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiyu-day-check-'));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'test';
// 迁移与生成日志属于被检查对象的内部细节，这里只看断言结果
process.env.LOG_LEVEL = 'error';

const { db, runMigrations } = await import('../server/src/db');
const { ensureDayContent } = await import('../server/src/services/content');
const { runOnce, singleFlightStats, resetSingleFlightStats } = await import('../server/src/lib/singleFlight');
const { assertRequestLanguage } = await import('../server/src/lib/languageGuard');
const { listDayContents } = await import('../server/src/repositories/content');

runMigrations();

type Lang = 'en' | 'ja' | 'ko';

let failed = 0;
function check(scope: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${scope}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${scope}${detail ? ` — ${detail}` : ''}`);
  }
}

const DATE = '2026-11-27';

const insertPlan = db.prepare(`
  INSERT INTO plans (
    id, user_id, language, exam_id, exam_name, current_level_id, current_level_name,
    target_score, target_label, start_date, exam_date, weeks, hours_per_week, daily_minutes,
    status, feasibility, roadmap, created_at
  ) VALUES (
    @id, 'local', @language, @examId, @examName, 'lv1', 'Lv1',
    100, @targetLabel, '2026-11-20', '2027-03-01', 12, 8, 60,
    'archived', '{}', '{}', @createdAt
  )
`);

const insertDay = db.prepare(`
  INSERT INTO plan_days (
    id, plan_id, date, week_index, day_index, phase, phase_name, theme, focus, tasks, status, created_at
  ) VALUES (
    @id, @planId, @date, 1, 3, 'build', '主体期', '测试主题', '[]', '[]', 'pending', @createdAt
  )
`);

function seedPlan(id: string, language: Lang, targetLabel: string, examId: string, createdAt: string) {
  const plan = {
    id,
    language,
    examId,
    examName: examId.toUpperCase(),
    currentLevelId: 'lv1',
    currentLevelName: 'Lv1',
    targetScore: 100,
    targetLabel,
    startDate: '2026-11-20',
    examDate: '2027-03-01',
    weeks: 12,
    hoursPerWeek: 8,
    dailyMinutes: 60,
    status: 'active',
    feasibility: {} as never,
    roadmap: {} as never,
    createdAt,
  };
  insertPlan.run({ id, language, examId, examName: plan.examName, targetLabel, createdAt });
  return plan;
}

function seedDay(planId: string, id: string) {
  insertDay.run({ id, planId, date: DATE, createdAt: new Date().toISOString() });
  return {
    id,
    date: DATE,
    weekIndex: 1,
    dayIndex: 3,
    phase: 'build' as const,
    phaseName: '主体期',
    theme: '测试主题',
    focus: [],
    tasks: [],
    status: 'pending' as const,
  };
}

async function main() {
  const enPlan = seedPlan('plan-en-90', 'en', '托福 90', 'toefl', '2026-11-01T00:00:00.000Z');
  const enPlan2 = seedPlan('plan-en-100', 'en', '托福 100', 'toefl', '2026-11-02T00:00:00.000Z');
  const jaPlan = seedPlan('plan-ja', 'ja', 'N1 合格', 'jlpt', '2026-11-03T00:00:00.000Z');
  const enDay = seedDay(enPlan.id, 'day-en-90');
  const enDay2 = seedDay(enPlan2.id, 'day-en-100');
  const jaDay = seedDay(jaPlan.id, 'day-ja');

  console.log('单飞原语');
  resetSingleFlightStats();
  let executed = 0;
  await Promise.all(
    Array.from({ length: 5 }, () =>
      runOnce('demo', async () => {
        executed += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return executed;
      }),
    ),
  );
  check('5 个并发同名调用只执行 1 次', executed === 1, `实际 ${executed} 次`);
  check('其余 4 个被合并', singleFlightStats().joined === 4, JSON.stringify(singleFlightStats()));

  console.log('同一天同语种同目标：并发只生成一次');
  resetSingleFlightStats();
  const burst = await Promise.all(
    Array.from({ length: 6 }, () => ensureDayContent(enPlan as never, enDay as never)),
  );
  const stats = singleFlightStats();
  check('6 个并发请求只触发生成 1 次', stats.started === 1, JSON.stringify(stats));
  check('6 个请求都拿到完整两篇', burst.every((item) => item.articles.length === 2));
  check('文章语种与计划一致', burst.every((item) => item.articles.every((a) => a.language === 'en')));
  check(
    '库里只有两行（精读 + 泛读），没有重复写入',
    listDayContents(enDay.id).length === 2,
    `实际 ${listDayContents(enDay.id).length} 行`,
  );

  console.log('同日同语种同目标：再次进入走缓存');
  const again = await ensureDayContent(enPlan as never, enDay as never);
  check('第二次返回 cached', again.source === 'cached', again.source);
  check('没有新增生成', singleFlightStats().started === 1, JSON.stringify(singleFlightStats()));
  const enIds = again.articles.map((item) => item.id).sort();

  console.log('换语种：重新生成，互不覆盖');
  resetSingleFlightStats();
  const jaContent = await ensureDayContent(jaPlan as never, jaDay as never);
  check('生成了新的一份', singleFlightStats().started === 1);
  check('韩/日文内容语种正确', jaContent.articles.every((a) => a.language === 'ja'));
  check('同一天不同语种各两篇', listDayContents(jaDay.id).length === 2 && listDayContents(enDay.id).length === 2);
  check(
    '英语那天的内容没被日语覆盖',
    listDayContents(enDay.id).map((a) => a.id).sort().join() === enIds.join(),
  );

  console.log('换目标（同语种新计划）：重新生成，互不覆盖');
  resetSingleFlightStats();
  const en2 = await ensureDayContent(enPlan2 as never, enDay2 as never);
  check('生成了新的一份', singleFlightStats().started === 1);
  check('目标不同的文章是另一份', en2.articles.every((a) => !enIds.includes(a.id)));
  check('原目标的内容仍在缓存里', listDayContents(enDay.id).length === 2);

  console.log('缓存语种被污染：自动作废重生成');
  db.prepare("UPDATE day_contents SET language = 'ja' WHERE day_id = ?").run(enDay.id);
  const rebuilt = await ensureDayContent(enPlan as never, enDay as never);
  check('不再当作缓存命中', rebuilt.source !== 'cached', rebuilt.source);
  check('重新写回英语', listDayContents(enDay.id).every((a) => a.language === 'en'));
  check('仍然是两行', listDayContents(enDay.id).length === 2);

  console.log('请求语种与激活计划不一致：直接拒绝');
  let mismatch: { code?: string; details?: unknown } | null = null;
  try {
    assertRequestLanguage(enPlan as never, 'ja');
  } catch (err) {
    mismatch = err as { code?: string; details?: unknown };
  }
  check('抛出 LANGUAGE_MISMATCH', mismatch?.code === 'LANGUAGE_MISMATCH', String(mismatch?.code));
  check(
    'details 里带上请求语种与实际语种',
    JSON.stringify(mismatch?.details ?? {}) === JSON.stringify({ requested: 'ja', active: 'en', planId: 'plan-en-90' }),
    JSON.stringify(mismatch?.details),
  );
  check('语种一致时不报错', (() => {
    try {
      assertRequestLanguage(enPlan as never, 'en');
      return true;
    } catch {
      return false;
    }
  })());
  check('未传语种（脚本/内部调用）不校验', (() => {
    try {
      assertRequestLanguage(enPlan as never, undefined);
      return true;
    } catch {
      return false;
    }
  })());

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  if (failed > 0) {
    console.log(`✗ ${failed} 项未通过`);
    process.exit(1);
  }
  console.log('✓ 今日任务生成次数与语种隔离全部通过');
}

await main();
