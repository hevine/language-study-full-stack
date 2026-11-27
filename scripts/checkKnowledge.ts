/**
 * 知识图谱基座自检（npm run check:knowledge）。
 *
 * 背景：学情诊断的一切结论都建立在三件事上 ——
 *   · 知识点有稳定编码，前置关系不成环；
 *   · 题目按内容去重，同一道题不因为出现在多份卷子里被算成多道；
 *   · 每次交卷都留下逐题记录，并且重复执行不会翻倍。
 * 这个脚本把这三件事固化成断言，任何一处破了，一跑就红。
 *
 * 用法：
 *   npm run check:knowledge              空库 + 内置题库
 *   npm run check:knowledge -- --from-real
 *                                        先把真实 .data/app.db 只读备份到临时目录再跑，
 *                                        用来验证迁移在真实数据上成立、历史作答能回填。
 *                                        全程不写真实库。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fromReal = process.argv.includes('--from-real');

// 先隔离数据目录再 import 仓储层，避免碰到真实 .data/app.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiyu-kp-check-'));
const tmpDb = path.join(tmpDir, 'app.db');
if (fromReal) {
  const realDb = path.resolve(process.cwd(), '.data', 'app.db');
  assert.ok(fs.existsSync(realDb), `找不到真实库：${realDb}`);
  // -readonly + .backup：对真实库只读，备份文件落到临时目录
  execFileSync('sqlite3', ['-readonly', realDb, `.backup ${tmpDb}`]);
}
process.env.DATA_DIR = tmpDir;
// 接口冒烟在进程内直连，不走鉴权；真实配置由 .env 决定，这里只影响本次自检
process.env.AUTH_REQUIRED = 'false';

const {
  closeDb,
  db,
  runMigrations,
} = await import('../server/src/db');
const { createAttempt, ensureExamBank, listItems, listPapers, saveAttempt } = await import(
  '../server/src/repositories/exams'
);
const {
  backfillExamAttempts,
  getKnowledgeOverview,
  recordExamAttempt,
  upsertKnowledgeTree,
} = await import('../server/src/repositories/knowledge');
const { runAsUser } = await import('../server/src/auth/requestScope');
const { ensureKnowledgeBase } = await import('../server/src/services/knowledgeSeed');
const { EN_TREE } = await import('../server/src/content/knowledge/en');
const { treeFor } = await import('../server/src/content/knowledge');
const { grammarLibrary, similarGrammarPairs } = await import('../server/src/content/grammar');
const { vocabKnowledge } = await import('../server/src/content/knowledge/vocab');
const { JLPT_WORDS } = await import('../server/src/content/jlptGraded');
const { getGrammarLibrary, grammarLevelsForPlan } = await import('../server/src/repositories/grammar');
const { grammarPatternsFor } = await import('../server/src/services/grammarBook');
const { CATALOG } = await import('../server/src/catalog');
const { createApp } = await import('../server/src/app');

/** 英语的完整知识树：手写骨架 + 内置语法库派生的节点与边 */
const EN_FULL = treeFor('en')!;

const count = (sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

const passed: string[] = [];
const ok = (label: string, detail?: unknown): void => {
  passed.push(label);
  console.log(`  ✓ ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
};

let server: ReturnType<ReturnType<typeof createApp>['listen']> | null = null;

try {
  console.log(fromReal ? '模式：真实库的只读备份' : '模式：空库 + 内置题库');

  // ---- 1. 迁移 ----
  runMigrations();
  for (const table of [
    'knowledge_points',
    'kp_edges',
    'questions',
    'question_knowledge',
    'question_attempts',
    'knowledge_mastery',
  ]) {
    assert.equal(
      count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table),
      1,
      `缺表 ${table}`,
    );
  }
  assert.equal(
    count("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '019_knowledge.sql'"),
    1,
  );
  ok('迁移 019 建出 6 张表并登记版本');

  // ---- 2. 播种 ----
  ensureExamBank();
  ensureKnowledgeBase();

  const nodeCount = count("SELECT COUNT(*) AS n FROM knowledge_points WHERE language = 'en'");
  assert.equal(nodeCount, EN_FULL.nodes.length, '英语知识点数量与声明不一致');
  const skeleton = count(
    "SELECT COUNT(*) AS n FROM knowledge_points WHERE language = 'en' AND kind IN ('exam', 'skill', 'question_type')",
  );
  assert.equal(skeleton, EN_TREE.nodes.length, '手写骨架的节点数不对');
  const inference = db
    .prepare("SELECT depth, parent_id FROM knowledge_points WHERE code = 'en.reading.inference'")
    .get() as { depth: number; parent_id: string };
  assert.deepEqual(
    { depth: inference.depth, parent: inference.parent_id },
    { depth: 2, parent: 'en.reading' },
    '技能 → 题型应为两层',
  );
  const orphans = count(
    'SELECT COUNT(*) AS n FROM kp_edges e WHERE NOT EXISTS (SELECT 1 FROM knowledge_points p WHERE p.id = e.to_id)',
  );
  assert.equal(orphans, 0, '存在指向不存在节点的关系边');
  const similarOneWay = db
    .prepare(
      `SELECT COUNT(*) AS n FROM kp_edges a
        WHERE a.type = 'similar'
          AND NOT EXISTS (SELECT 1 FROM kp_edges b WHERE b.type = 'similar' AND b.from_id = a.to_id AND b.to_id = a.from_id)`,
    )
    .get() as { n: number };
  assert.equal(similarOneWay.n, 0, '类义边没有成对展开');
  ok('英语知识树落库：编码、层级、关系边完整', {
    节点: nodeCount,
    其中手写骨架: skeleton,
    边: count("SELECT COUNT(*) AS n FROM kp_edges WHERE from_id LIKE 'en.%'"),
  });

  // ---- 2b. 内置语法库：三个语种的内容文件 → 图谱节点 → 读取路径，逐条对得上 ----
  const grammarReport: Record<string, unknown> = {};
  for (const language of ['en', 'ja', 'ko'] as const) {
    const library = grammarLibrary(language);
    assert.ok(library, `${language} 没有内置语法库数据文件`);
    const points = db
      .prepare(
        "SELECT code, parent_id, level_band, exam_id, section_key, meta_json FROM knowledge_points WHERE language = ? AND kind = 'grammar'",
      )
      .all(language) as Array<{
      code: string;
      parent_id: string;
      level_band: string;
      exam_id: string;
      section_key: string;
      meta_json: string;
    }>;
    assert.equal(points.length, library.points.length, `${language} 语法点节点数与内容文件不一致`);
    assert.equal(
      count("SELECT COUNT(*) AS n FROM knowledge_points WHERE language = ? AND kind = 'error_rule'", language),
      library.rules.length,
      `${language} 错因规则节点数与内容文件不一致`,
    );
    const byCode = new Map(points.map((row) => [row.code, row]));
    for (const point of library.points) {
      const code = `${language}.grammar.${point.ref.toLowerCase()}`;
      const row = byCode.get(code);
      assert.ok(row, `${language} 缺语法点节点 ${code}`);
      assert.equal(row.parent_id, `${language}.grammar`, `${code} 应挂在语法技能节点下`);
      assert.equal(row.level_band, point.level, `${code} 的级别不对`);
      assert.equal(row.section_key, 'grammar', `${code} 的分项应为 grammar`);
      const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
      for (const field of ['ref', 'structure', 'meaning', 'synonym', 'example', 'translation', 'note'] as const) {
        assert.equal(meta[field], point[field], `${code} 的 ${field} 与内容文件不一致`);
      }
    }
    assert.equal(
      new Set(points.map((row) => row.exam_id)).size,
      1,
      `${language} 的语法点应归属同一场考试`,
    );
    // 语法点 → 错因规则：每个写了 errorRule 的点都有一条 explains 边指向对应规则节点
    const linked = count(
      "SELECT COUNT(*) AS n FROM kp_edges e JOIN knowledge_points f ON f.id = e.from_id WHERE e.type = 'explains' AND f.language = ? AND f.kind = 'grammar'",
      language,
    );
    const expected = library.points.filter((point) => point.errorRule).length;
    assert.equal(linked, expected, `${language} 的语法点 → 错因规则边数不对`);
    const wrongTarget = db
      .prepare(
        `SELECT COUNT(*) AS n FROM kp_edges e JOIN knowledge_points f ON f.id = e.from_id
          WHERE e.type = 'explains' AND f.language = ? AND f.kind = 'grammar'
            AND json_extract(f.meta_json, '$.errorRule') IS NOT NULL
            AND e.to_id <> ? || lower(json_extract(f.meta_json, '$.errorRule'))`,
      )
      .get(language, `${language}.error-rule.`) as { n: number };
    assert.equal(wrongTarget.n, 0, `${language} 有语法点连到了不属于自己的错因规则`);
    // 类义边成对
    for (const [a, b] of similarGrammarPairs(library.points)) {
      const from = `${language}.grammar.${a.toLowerCase()}`;
      const to = `${language}.grammar.${b.toLowerCase()}`;
      for (const [x, y] of [
        [from, to],
        [to, from],
      ]) {
        assert.equal(
          count("SELECT COUNT(*) AS n FROM kp_edges WHERE from_id = ? AND to_id = ? AND type = 'similar'", x, y),
          1,
          `${language} 类义边 ${a} ↔ ${b} 没有成对落库`,
        );
      }
    }

    const view = getGrammarLibrary(language);
    assert.equal(view.points.length, library.points.length, `${language} 读取路径的语法点数不对`);
    assert.equal(view.rules.length, library.rules.length, `${language} 读取路径的规则数不对`);
    assert.equal(
      view.levels.reduce((sum, level) => sum + level.total, 0),
      library.points.length,
      `${language} 各级别收录量之和应等于语法点总数`,
    );
    // 级别由浅入深
    const ranks = view.points.map((point) => view.levels.findIndex((level) => level.id === point.level));
    assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y), `${language} 语法点没有按级别由浅入深排列`);
    for (const point of view.points) {
      if (!library.points.find((item) => item.ref === point.ref)?.errorRule) continue;
      assert.ok(point.errorRule, `${language} ${point.ref} 应带出错因规则`);
    }
    const first = library.points[0];
    const byQuery = getGrammarLibrary(language, { query: first.example.slice(0, 12) });
    assert.ok(
      byQuery.points.some((point) => point.ref === first.ref),
      `${language} 按例句搜索找不到 ${first.ref}`,
    );
    grammarReport[language] = {
      语法点: view.points.length,
      错因规则: view.rules.length,
      挂规则的语法点: view.stats.linkedPoints,
      被引用的规则: view.stats.linkedRules,
      级别: view.levels.map((level) => `${level.label}:${level.total}`).join(' '),
    };
  }
  {
    const en = getGrammarLibrary('en', { level: 'C1' });
    assert.equal(en.points.length, 39, '英语 C1 档应为 39 个语法点');
    assert.ok(en.points.every((point) => point.level === 'C1'), '级别筛选混入了别的级别');
    const n3 = getGrammarLibrary('ja', { level: 'N3' });
    assert.equal(n3.points.length, 40, '日语 N3 档应为 40 个语法点');
    const topik = getGrammarLibrary('ko', { level: '3' });
    assert.equal(topik.points.length, 40, '韩语 3 级应为 40 个语法点');
    // EN-ER-01 主谓一致 被 10 个语法点共用；EN-ER-37 没有语法点挂接
    const rules = getGrammarLibrary('en').rules;
    assert.equal(rules.find((rule) => rule.ref === 'EN-ER-01')?.pointCount, 10, 'EN-ER-01 应覆盖 10 个语法点');
    assert.equal(rules.find((rule) => rule.ref === 'EN-ER-37')?.pointCount, 0, 'EN-ER-37 不应有语法点挂接');
  }
  // 计划级别窗口 → 语法级别
  const windowOf = (language: 'en' | 'ja' | 'ko', ids: string[]) =>
    CATALOG[language].levels.filter((level) => ids.includes(level.id));
  assert.deepEqual(grammarLevelsForPlan('ja', windowOf('ja', ['n3', 'n2'])), ['N3', 'N2']);
  assert.deepEqual(grammarLevelsForPlan('ko', windowOf('ko', ['ko1', 'ko2', 'ko3'])), ['1', '2', '3']);
  assert.deepEqual(grammarLevelsForPlan('en', windowOf('en', ['cet4', 'cet6', 'tem4'])), ['B1', 'C1']);
  // 六级 / 六级 550+ 都是 B2，语法表没有 B2 档：离 B1 与 C1 一样近，取较低的 B1
  assert.deepEqual(grammarLevelsForPlan('en', windowOf('en', ['cet6', 'cet6plus'])), ['B1']);
  ok('内置语法库：内容文件、图谱节点、关系边、读取路径四者一致，计划级别能换算成语法级别', grammarReport);

  // ---- 2c. 没有上传语法书时，「拆句」取内置语法库，且同一天取到同一批 ----
  const FALLBACK_USER = 'kp-check-grammar-user';
  let fallbackTitle = '';
  {
    // 上传的书按账号隔离，这里用一个没有任何材料的账号走兜底路径
    const fakePlan = (language: 'en' | 'ja' | 'ko', currentLevelId: string, targetLabel: string) =>
      ({ language, currentLevelId, targetLabel }) as never;
    const day = { weekIndex: 2, dayIndex: 3 } as never;
    const plan = fakePlan('ja', 'n4', 'N2 130 分');
    const ja = runAsUser(FALLBACK_USER, () => grammarPatternsFor(plan, day, 3));
    assert.ok(ja && ja.patterns.length === 3, '日语计划应从内置语法库取到 3 个语法点');
    fallbackTitle = ja.materialTitle;
    const jaPoints = new Map(grammarLibrary('ja')!.points.map((point) => [point.name, point.level]));
    for (const pattern of ja.patterns) {
      assert.ok(
        ['N4', 'N3', 'N2'].includes(jaPoints.get(pattern.pattern) ?? ''),
        `取到的语法点「${pattern.pattern}」不在 N4–N2 窗口内`,
      );
    }
    const again = runAsUser(FALLBACK_USER, () => grammarPatternsFor(plan, day, 3));
    assert.deepEqual(
      again?.patterns.map((item) => item.pattern),
      ja.patterns.map((item) => item.pattern),
      '同一天重复生成应取到同一批语法点',
    );
    const otherDay = runAsUser(FALLBACK_USER, () =>
      grammarPatternsFor(plan, { weekIndex: 2, dayIndex: 4 } as never, 3),
    );
    assert.notDeepEqual(
      otherDay?.patterns.map((item) => item.pattern),
      ja.patterns.map((item) => item.pattern),
      '换一天应轮换到别的语法点',
    );
    // 英语：六级计划的级别窗口一直延伸到专四（C1），所以取 C1 档；
    // 「取最近档」的兜底只在不经过计划窗口、直接限定到 B2 时才触发（见上面 grammarLevelsForPlan 的断言）
    const en = runAsUser(FALLBACK_USER, () => grammarPatternsFor(fakePlan('en', 'cet6', '100'), day, 3));
    const enPoints = new Map(grammarLibrary('en')!.points.map((point) => [point.name, point.level]));
    assert.ok(
      en?.patterns.every((item) => enPoints.get(item.pattern) === 'C1'),
      '六级计划（窗口到专四）应取 C1 档的语法点',
    );
  }
  ok('没有上传语法书时，「拆句」按计划级别取内置语法库，按天轮换', { 示例: fallbackTitle });

  // ---- 2d. 日语词汇图谱：JLPT 词库 → 图谱节点 → 主题/近义关系边，逐条对得上 ----
  {
    const words = JLPT_WORDS();
    const derived = vocabKnowledge('ja')!;
    const vocabNodes = derived.nodes.filter((node) => node.kind === 'vocab');
    const topicNodes = derived.nodes.filter((node) => node.kind === 'topic');
    assert.equal(words.length, 10010, 'JLPT 词库应为 10010 条（教研主表 10000 + 题目回补 10）');
    assert.equal(vocabNodes.length, words.length, '词汇节点数与词库条数不一致');
    assert.ok(topicNodes.length > 0, '缺少主题中枢节点');
    assert.ok(
      vocabNodes.every((node) => node.parent === 'ja.vocab' && node.sectionKey === 'vocab'),
      '词汇节点应挂在词汇技能下且归入 vocab 分项',
    );
    assert.ok(
      vocabNodes.every((node) => ['N5', 'N4', 'N3', 'N2', 'N1'].includes(node.levelBand ?? '')),
      '词汇节点的级别档位应为 N5–N1',
    );

    // 落库核对：抽样 20 条，编码/释义/例句与词库一致
    const sample = words.filter((_, i) => i % 500 === 0).slice(0, 20);
    for (const word of sample) {
      const row = db
        .prepare('SELECT name, name_local, level_band, meta_json FROM knowledge_points WHERE id = ?')
        .get(`ja.vocab.${word.code.toLowerCase()}`) as
        | { name: string; name_local: string; level_band: string; meta_json: string }
        | undefined;
      assert.ok(row, `词汇节点未落库：${word.code}`);
      assert.equal(row.name, word.term, `${word.code} 词形不一致`);
      assert.equal(row.name_local, word.kana, `${word.code} 假名不一致`);
      assert.equal(row.level_band, word.level, `${word.code} 级别不一致`);
      const meta = JSON.parse(row.meta_json);
      assert.equal(meta.cn, word.cn, `${word.code} 释义不一致`);
      assert.equal(meta.example, word.example, `${word.code} 例句不一致`);
    }

    const nodeCount = count(
      `SELECT COUNT(*) AS n FROM knowledge_points WHERE language='ja' AND kind='vocab'`,
    );
    assert.equal(nodeCount, words.length, '库里日语词汇节点数不对');
    const related = count(
      `SELECT COUNT(*) AS n FROM kp_edges e JOIN knowledge_points p ON p.id=e.from_id
       WHERE p.language='ja' AND p.kind='vocab' AND e.type='related'`,
    );
    const similar = count(
      `SELECT COUNT(*) AS n FROM kp_edges e JOIN knowledge_points p ON p.id=e.from_id
       WHERE p.language='ja' AND p.kind='vocab' AND e.type='similar'`,
    );
    const oneWay = count(
      `SELECT COUNT(*) AS n FROM kp_edges e JOIN knowledge_points p ON p.id=e.from_id
       WHERE p.language='ja' AND p.kind='vocab' AND e.type='similar'
         AND NOT EXISTS (SELECT 1 FROM kp_edges r WHERE r.from_id=e.to_id AND r.to_id=e.from_id AND r.type='similar')`,
    );
    assert.equal(related, words.length, '每个词汇节点应有一条指向主题的 related 边');
    assert.ok(similar > 0, '近义/反义关系边未落库');
    assert.equal(oneWay, 0, '词汇近义边没有成对展开');
    // 10 条题目回补词必须已落库（续号词，抽样按间隔取不到）
    for (const code of ['JP-V-N4-1501', 'JP-V-N3-1401', 'JP-V-N2-2301', 'JP-V-N1-4001']) {
      assert.ok(
        db.prepare('SELECT 1 FROM knowledge_points WHERE id = ?').get(`ja.vocab.${code.toLowerCase()}`),
        `回补词节点未落库：${code}`,
      );
    }
    ok('日语词汇图谱：10010 词节点 + 主题/近义关系边完整', {
      词汇节点: nodeCount,
      主题节点: topicNodes.length,
      related边: related,
      similar边: similar,
    });
  }

  // ---- 2e. 日语题目按词形挂接词汇节点：诊断链路的作答证据来源 ----
  {
    const jaPool = db
      .prepare(
        `SELECT COUNT(*) AS questions,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM question_knowledge qk WHERE qk.question_id = q.id)
                         THEN 1 ELSE 0 END) AS tagged
           FROM questions q WHERE q.language = 'ja' AND q.status = 'active'`,
      )
      .get() as { questions: number; tagged: number };
    assert.ok(jaPool.questions > 0, '日语题池为空');
    assert.equal(jaPool.tagged, jaPool.questions, '有日语题没挂上词汇节点');

    const links = db
      .prepare(
        `SELECT qk.is_primary, qk.weight, kp.kind, kp.code
           FROM question_knowledge qk
           JOIN questions q ON q.id = qk.question_id
           JOIN knowledge_points kp ON kp.id = qk.knowledge_point_id
          WHERE q.language = 'ja' AND qk.source = 'seed'`,
      )
      .all() as Array<{ is_primary: number; weight: number; kind: string; code: string }>;
    assert.ok(links.length > 0, '日语题没有挂接任何知识点');
    assert.ok(
      links.every((link) => link.kind === 'vocab' && link.code.startsWith('ja.vocab.jp-v-')),
      '日语题应挂到词汇节点，而不是题型或主题节点',
    );
    const primaries = links.filter((link) => link.is_primary === 1);
    // 41 道词汇题应全部有主考点：18 原有 + 10 回补词 + 13 规则/映射修复
    const vocabQuestions = count(
      "SELECT COUNT(*) AS n FROM questions WHERE language='ja' AND status='active' AND section_key='vocab'",
    );
    const primaryQuestions = count(
      `SELECT COUNT(DISTINCT q.id) AS n
         FROM questions q JOIN question_knowledge qk ON qk.question_id = q.id
        WHERE q.language='ja' AND q.status='active' AND q.section_key='vocab'
          AND qk.is_primary = 1`,
    );
    assert.equal(primaryQuestions, vocabQuestions, '还有词汇题没主考点（应为 41/41）');
    assert.ok(primaries.every((link) => link.weight === 1), '主考点权重应为 1');
    assert.ok(
      links.filter((link) => link.is_primary === 0).every((link) => link.weight === 0.4),
      '次要关联权重应为 0.4，不能冒充主考点',
    );

    // 抽检：解析标注「計算」的题必须挂到该词节点
    const example = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM questions q JOIN question_knowledge qk ON qk.question_id = q.id
          WHERE q.language = 'ja' AND q.stem LIKE '%計算%'
            AND qk.knowledge_point_id = 'ja.vocab.jp-v-n4-0594'`,
      )
      .get() as { n: number };
    assert.ok(example.n > 0, '解析标注的考点词未挂到对应词汇节点');

    ok('日语题按词形挂接词汇节点：解析考点作主证据，全文词只作次要关联', {
      题数: jaPool.questions,
      已挂接: jaPool.tagged,
      关联数: links.length,
      主考点: primaries.length,
    });
  }

  // ---- 3. 题池：按内容去重 + 全部对上知识点 ----
  const pool = db
    .prepare(
      `SELECT COUNT(*) AS questions,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM question_knowledge qk WHERE qk.question_id = q.id) THEN 1 ELSE 0 END) AS tagged
         FROM questions q WHERE q.language = 'en' AND q.status = 'active'`,
    )
    .get() as { questions: number; tagged: number };
  const examRows = count(
    "SELECT COUNT(*) AS n FROM exam_items i JOIN exam_papers p ON p.id = i.paper_id WHERE p.language = 'en' AND p.paper_type = 'mock'",
  );
  assert.ok(pool.questions > 0, '英语题池为空');
  assert.ok(
    pool.questions < examRows,
    '题池条数应远少于卷面行数（按内容去重），否则掌握度会被同一道题的重复出现稀释',
  );
  assert.equal(pool.tagged, pool.questions, '有英语题对不上知识点');
  ok('统一题池按内容去重，英语题 100% 对上知识点', {
    卷面行: examRows,
    去重后题目: pool.questions,
  });

  // ---- 4. 幂等：整套再跑一遍不增行 ----
  const snapshot = (): string[] => [
    'SELECT COUNT(*) AS n FROM knowledge_points',
    'SELECT COUNT(*) AS n FROM kp_edges',
    'SELECT COUNT(*) AS n FROM questions',
    'SELECT COUNT(*) AS n FROM question_knowledge',
    'SELECT COUNT(*) AS n FROM question_attempts',
    'SELECT COUNT(*) AS n FROM knowledge_mastery',
  ].map((sql) => String(count(sql)));
  const before = snapshot();
  ensureKnowledgeBase();
  assert.deepEqual(snapshot(), before, '重复执行增行');
  ok('重复执行播种不增行');

  // ---- 5. 历史作答回填（真实库备份里才有） ----
  const doneAttempts = db
    .prepare("SELECT id, paper_id, answers, writing FROM exam_attempts WHERE status = 'done'")
    .all() as Array<{ id: string; paper_id: string; answers: string; writing: string }>;
  for (const attempt of doneAttempts) {
    const items = listItems(attempt.paper_id);
    const writing = JSON.parse(attempt.writing || '{}') as Record<string, string>;
    const expected =
      items.filter((item) => item.kind === 'choice').length +
      items.filter((item) => item.kind === 'writing' && (writing[String(item.idx)] ?? '').trim())
        .length;
    assert.equal(
      count('SELECT COUNT(*) AS n FROM question_attempts WHERE session_id = ?', attempt.id),
      expected,
      `历史交卷 ${attempt.id} 的逐题记录数不对`,
    );
  }
  const again = backfillExamAttempts();
  assert.equal(again.recorded, 0, '回填不幂等');
  ok('历史作答回填完整且幂等', { 已交卷次数: doneAttempts.length });

  // ---- 6. 交卷 → 逐题记录 → 掌握度 ----
  const TEST_USER = 'kp-check-user';
  const papers = listPapers('en');
  assert.ok(papers.length >= 2, '英语内置卷不足两份');
  const submit = (paperId: string, mode: 'all-correct' | 'all-wrong'): string => {
    const items = listItems(paperId);
    const attempt = createAttempt(paperId, 'en');
    const answers = items.map((item) => {
      if (item.kind !== 'choice') return null;
      if (mode === 'all-correct') return item.answer;
      return (item.answer + 1) % Math.max(item.options.length, 1);
    });
    const writing: Record<string, string> = {};
    for (const item of items) {
      if (item.kind === 'writing') writing[String(item.idx)] = 'This is a sample essay for the check.';
    }
    saveAttempt(attempt.id, { answers, writing, correct: 0, total: 0, seconds: 120 });
    return attempt.id;
  };

  const firstItems = listItems(papers[0].id);
  const firstId = runAsUser(TEST_USER, () => submit(papers[0].id, 'all-correct'));
  assert.equal(
    count('SELECT COUNT(*) AS n FROM question_attempts WHERE session_id = ?', firstId),
    firstItems.length,
    '第一次交卷：客观题（含未作答）与有文本的写作题都应各有一条',
  );

  const choiceTotal = [papers[0], papers[1]].reduce(
    (sum, paper) => sum + listItems(paper.id).filter((item) => item.kind === 'choice').length,
    0,
  );
  runAsUser(TEST_USER, () => submit(papers[1].id, 'all-wrong'));

  // 同一次交卷重复落库不增行
  const attemptRows = count(
    'SELECT COUNT(*) AS n FROM question_attempts WHERE user_id = ?',
    TEST_USER,
  );
  runAsUser(TEST_USER, () =>
    recordExamAttempt({
      attemptId: firstId,
      userId: TEST_USER,
      language: 'en',
      items: firstItems,
      answers: firstItems.map((item) => (item.kind === 'choice' ? item.answer : null)),
      writing: Object.fromEntries(
        firstItems
          .filter((item) => item.kind === 'writing')
          .map((item) => [String(item.idx), 'dup']),
      ),
      seconds: 0,
      createdAt: new Date().toISOString(),
    }),
  );
  assert.equal(
    count('SELECT COUNT(*) AS n FROM question_attempts WHERE user_id = ?', TEST_USER),
    attemptRows,
    '同一次交卷重复落库增行',
  );
  ok('交卷写入逐题记录，重复落库不增行', { 记录条数: attemptRows });

  const overview = getKnowledgeOverview('en', TEST_USER);
  assert.equal(overview.stats.untaggedRate, 0, '英语作答出现无法归因的记录');
  const typed = overview.nodes.filter((node) => node.kind === 'question_type' && node.attempts > 0);
  assert.equal(
    typed.reduce((sum, node) => sum + node.attempts, 0),
    choiceTotal,
    '各题型作答数之和应等于客观题数（每题恰好一个主考点）',
  );
  for (const node of typed) {
    assert.ok(node.mastery !== null && node.mastery >= 0 && node.mastery <= 1, `${node.code} 掌握度越界`);
    // 同一道题连对多次不等于掌握：做过不同题不足 2 道时，置信度必须被压住
    assert.ok(
      node.confidence! <= (node.attempts / 3) * Math.min(1, node.distinctQuestions / 2) + 1e-9,
      `${node.code} 置信度没有反映「不同题目数」`,
    );
    if (node.distinctQuestions < 2) assert.ok(node.confidence! <= 0.5, `${node.code} 只有一道题却给了高置信度`);
  }
  ok('掌握度按知识点聚合，置信度受「不同题目数」约束', {
    有作答的题型数: typed.length,
    客观题作答总数: choiceTotal,
    置信度达标的题型: overview.stats.readyPoints,
  });

  // ---- 7. 前置关系成环必须被拒 ----
  const edgesBefore = count('SELECT COUNT(*) AS n FROM kp_edges');
  assert.throws(
    () =>
      upsertKnowledgeTree({
        ...EN_FULL,
        edges: [
          ...EN_TREE.edges,
          { from: 'en.reading.inference', to: 'en.reading.factual-information', type: 'prereq' },
        ],
      }),
    /成环/,
    '前置关系成环却没有报错',
  );
  assert.equal(count('SELECT COUNT(*) AS n FROM kp_edges'), edgesBefore, '失败的写入没有整体回滚');
  ok('前置关系成环时拒绝写入并整体回滚');

  // ---- 8. 接口冒烟（进程内直连） ----
  const listening = createApp().listen(0, '127.0.0.1');
  server = listening;
  await new Promise<void>((resolve, reject) => {
    listening.once('listening', () => resolve());
    listening.once('error', reject);
  });
  const address = listening.address();
  assert.ok(address && typeof address !== 'string', '测试服务未监听');
  const base = `http://127.0.0.1:${address.port}/api`;
  const res = await fetch(`${base}/knowledge/en`);
  assert.equal(res.status, 200, `GET /knowledge/en 返回 ${res.status}`);
  const body = (await res.json()) as { language: string; nodes: unknown[]; stats: { questions: number } };
  assert.equal(body.language, 'en');
  assert.equal(body.nodes.length, EN_FULL.nodes.length, '接口返回的节点数应等于完整知识树');
  assert.ok(body.stats.questions > 0);
  const bad = await fetch(`${base}/knowledge/fr`);
  assert.equal(bad.status, 400, '未支持的语种应返回 400');
  const kinds: Record<string, number> = {};
  for (const node of body.nodes as Array<{ kind: string }>) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  assert.equal(kinds.grammar, 200, '知识图谱接口应包含 200 个英语语法点');
  assert.equal(kinds.error_rule, 40, '知识图谱接口应包含 40 条英语错因规则');
  ok('GET /api/knowledge/:language 可用，非法语种返回 400', {
    节点: body.nodes.length,
    按类型: kinds,
    题目: body.stats.questions,
  });

  // ---- 9. 语法库接口 ----
  type GrammarBody = {
    language: string;
    levels: Array<{ id: string; total: number }>;
    points: Array<{ level: string; ref: string; errorRule: { name: string } | null }>;
    rules: Array<{ ref: string; pointCount: number }>;
    stats: { seeded: boolean };
  };
  const getGrammar = async (path: string): Promise<{ status: number; body: GrammarBody }> => {
    const response = await fetch(`${base}/grammar/${path}`);
    return { status: response.status, body: (await response.json()) as GrammarBody };
  };
  const enLib = await getGrammar('en');
  assert.equal(enLib.status, 200, `GET /grammar/en 返回 ${enLib.status}`);
  assert.equal(enLib.body.points.length, 200, '英语语法库应有 200 个语法点');
  assert.equal(enLib.body.rules.length, 40, '英语语法库应有 40 条错因规则');
  assert.ok(enLib.body.points.every((point) => point.errorRule?.name), '英语 200 个语法点都应带出错因规则名称');
  const jaLevel = await getGrammar('ja?level=N3');
  assert.equal(jaLevel.status, 200);
  assert.equal(jaLevel.body.points.length, 40, 'N3 档应有 40 个语法点');
  assert.equal(
    jaLevel.body.levels.reduce((sum, level) => sum + level.total, 0),
    210,
    '按级别筛选后，级别表上的收录量仍是全库口径',
  );
  const koQuery = await getGrammar(`ko?q=${encodeURIComponent('使动')}`);
  assert.equal(koQuery.status, 200);
  assert.ok(koQuery.body.points.length > 0 && koQuery.body.points.length < 220, '韩语按「使动」搜索应有结果但不满库');
  assert.equal((await getGrammar('en?level=ZZ')).status, 400, '不存在的级别应返回 400');
  assert.equal((await getGrammar('fr')).status, 400, '未支持的语种应返回 400');
  ok('GET /api/grammar/:language 可用：级别筛选、搜索、非法参数返回 400', {
    en: `${enLib.body.points.length} 点 / ${enLib.body.rules.length} 规则`,
    'ja?level=N3': jaLevel.body.points.length,
    'ko?q=使动': koQuery.body.points.length,
  });

  console.log(`\n全部通过（${passed.length} 项）`);
} catch (err) {
  console.error('\n自检失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
