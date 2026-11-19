-- =============================================================
-- 学情诊断 · 新增表参考 DDL（SQLite，贴合本库现有风格）
--
-- 用法：直接作为第 7 章的数据契约骨架，按需裁剪字段。
-- 前置：本文件全部为「新增」，不改动现有 21 张表；
--       现有题库与作答表的衔接方式见文末「零迁移读路径」与「历史回填」。
--
-- 分层结构：
--   knowledge_points    知识点树（语种 × 考试各一棵，三级：考试 / 分项 / 知识点）
--   questions           统一题池（不动现有三张题表，靠 source_type + source_ref 反查）
--   question_knowledge  题 ↔ 知识点（多对多 + 权重，一题可考多个点）
--   question_attempts   逐题作答（诊断的唯一数据源）
--   knowledge_mastery   知识点掌握度快照（增量更新，避免每次报告全量重算）
--   diagnosis_reports   诊断报告（dimensions_json 复用 practice_attempts 的既有契约）
--   diagnosis_jobs      诊断跑批任务（本库无队列，用表轮询，风格对齐 ai_gen_runs）
--
-- 命名与类型约定（与现有表保持一致）：
--   · 主键一律 TEXT（现库为 UUID 或语义 id，如 'ko-2009-full'）
--   · 时间一律 TEXT，存 ISO 8601 字符串（如 2026-11-08T06:21:40.582Z）
--   · JSON 一律 TEXT，字段名以 _json 结尾（少数沿用 answers / options / payload）
--   · user_id TEXT NOT NULL —— 本项目为单用户，实际恒为 'local'，保留字段以便将来多用户
--   · 枚举用 CHECK (x IN (...))，与 voices.provider / voice_assignments.scene 同风格
--   · 外键统一 ON DELETE CASCADE；级联主体是「用户删除计划/题目」这类动作
--   · 索引命名 idx_<表简称>_<用途>，唯一索引 uq_<表简称>_<用途>
--   · 建表用 CREATE TABLE / INDEX IF NOT EXISTS，与 008~012 迁移一致
-- =============================================================

PRAGMA foreign_keys = ON;

-- -------------------------------------------------------------
-- 1. 知识点树
--    对应第 7 章「知识点标签体系」。三套考纲各一棵，不共用同一棵树。
--    jlpt: 語彙 / 文法 / 読解 / 聴解
--    toefl: Reading / Listening / Speaking / Writing（下挂题型）
--    topik: 어휘 / 문법 / 읽기 / 듣기 / 쓰기
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_points (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  language    TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  -- 对应 plans.exam_id 的实际取值：toefl / jlpt / topik
  exam_id     TEXT NOT NULL,
  -- 自引用成树；depth=1 的根节点 parent_id 为 NULL
  parent_id   TEXT REFERENCES knowledge_points(id) ON DELETE CASCADE,
  -- 1 考试 / 2 分项 / 3 知识点（叶子）。留 4 给「微技能」，先不用
  depth       INTEGER NOT NULL DEFAULT 3,
  -- 稳定编码，跨版本不改：诊断结论与处方按它对齐，不要用 name 做关联
  -- 形如 ja.jlpt.n3.grammar.te-form / en.toefl.reading.inference
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- 原语种写法：語彙 / 어휘 / Vocabulary，界面按语种展示
  name_local  TEXT NOT NULL DEFAULT '',
  -- 对齐现有 exam_items.section_key（listening/vocab/grammar/reading/writing），
  -- 有了它，未标注知识点的历史数据也能先按分项聚合，不至于完全无法出报告
  section_key TEXT NOT NULL DEFAULT '',
  -- 考纲权重 0~1：用于诊断加权与「提分性价比」排序（听力高频点权重大）
  exam_weight REAL NOT NULL DEFAULT 0.5,
  sort_idx    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, language, exam_id, code)
);

CREATE INDEX IF NOT EXISTS idx_kp_tree
  ON knowledge_points(user_id, language, exam_id, parent_id, sort_idx);
CREATE INDEX IF NOT EXISTS idx_kp_section
  ON knowledge_points(user_id, language, section_key);

-- -------------------------------------------------------------
-- 2. 统一题池
--    不物理迁移现有三张题表，用 source_type + source_ref 反查：
--      exam_item       → exam_items.id
--      ai_bank         → ai_bank_items.id
--      practice_prompt → practice_prompts.id
--      manual          → 教研后台手工录入，source_ref 留空
--    好处：现有 742 题零改动即可进入诊断；坏处：读题要 join 回原表，
--          所以配一个视图（见文末 v_question_pool）供诊断引擎只读使用。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  language      TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  exam_id       TEXT NOT NULL DEFAULT '',
  -- choice 单选 / writing 写作 / speak 口语 / word 单词 / sentence 句子
  question_type TEXT NOT NULL,
  stem          TEXT NOT NULL,
  passage       TEXT NOT NULL DEFAULT '',
  options_json  TEXT NOT NULL DEFAULT '[]',
  -- 客观题存正确下标（0 起，与 exam_items.answer 一致）；主观题留空
  answer_idx    INTEGER,
  -- 主观题存参考答案 / 评分要点；客观题留空
  answer_text   TEXT NOT NULL DEFAULT '',
  explanation   TEXT NOT NULL DEFAULT '',
  -- 难度 0（最易）~1（最难）。首版按题型给经验值，后续用作答数据校准
  difficulty    REAL NOT NULL DEFAULT 0.5,
  source_type   TEXT NOT NULL DEFAULT 'manual'
                CHECK (source_type IN ('exam_item', 'ai_bank', 'practice_prompt', 'manual')),
  source_ref    TEXT NOT NULL DEFAULT '',
  -- 内容指纹（归一化题干 + 选项的哈希），同一道题不重复入库
  fingerprint   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at    TEXT NOT NULL
);

-- 指纹唯一只对「有指纹的行」生效：允许教研在草稿态先插入无指纹的题
CREATE UNIQUE INDEX IF NOT EXISTS uq_questions_fingerprint
  ON questions(user_id, language, fingerprint) WHERE fingerprint <> '';
CREATE INDEX IF NOT EXISTS idx_questions_pool
  ON questions(user_id, language, question_type, status, difficulty);
CREATE INDEX IF NOT EXISTS idx_questions_source
  ON questions(source_type, source_ref);

-- -------------------------------------------------------------
-- 3. 题 ↔ 知识点
--    一题可考多个点：主考点 weight=1.0、is_primary=1，次考点 0.3~0.5。
--    诊断时按 weight 把「对/错」分摊到各知识点，避免一题只归一个点导致样本稀薄。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_knowledge (
  question_id        TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  weight             REAL NOT NULL DEFAULT 1,
  is_primary         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, knowledge_point_id)
);

CREATE INDEX IF NOT EXISTS idx_qk_point ON question_knowledge(knowledge_point_id);

-- -------------------------------------------------------------
-- 4. 逐题作答 —— 整份诊断方案的唯一数据源
--
--    为什么必须新建：现有 exam_attempts.answers 是 Array<number|null>，
--    只按 exam_items.idx 的位置对齐，不存题目 id。题库一旦重排或替换，
--    历史作答立刻错位，且无法回答「这道题考的是哪个知识点」。
--    practice_attempts 只有整篇得分，无逐题粒度；study_logs 连题目 id 都没有。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_attempts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  question_id     TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  language        TEXT NOT NULL,
  -- exam 整卷模考 / task 计划内任务 / drill 专项刷题 / review 错题重做
  session_type    TEXT NOT NULL CHECK (session_type IN ('exam', 'task', 'drill', 'review')),
  -- exam → exam_attempts.id；task → plan_days.id；drill/review → 练单 id（可空）
  session_id      TEXT NOT NULL DEFAULT '',
  plan_id         TEXT,
  day_id          TEXT,
  -- 客观题：选了哪个下标（0 起）；未作答为 NULL
  chosen_idx      INTEGER,
  -- 主观题作答文本
  answer_text     TEXT NOT NULL DEFAULT '',
  -- 客观题 0/1，未作答 NULL；主观题留 NULL，看 score
  is_correct      INTEGER,
  -- 主观题得分 0~100；客观题可留空（由 is_correct 推导）
  score           REAL,
  seconds         INTEGER NOT NULL DEFAULT 0,
  -- 归因，供引擎区分「不会」与「不小心」：
  -- knowledge_gap 知识缺口 / misread 审题 / careless 粗心 / time_pressure 时间不够
  error_type      TEXT NOT NULL DEFAULT ''
                  CHECK (error_type IN ('', 'knowledge_gap', 'misread', 'careless', 'time_pressure')),
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qa_user_time
  ON question_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_question
  ON question_attempts(user_id, question_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_session
  ON question_attempts(session_type, session_id);
CREATE INDEX IF NOT EXISTS idx_qa_day
  ON question_attempts(day_id);

-- -------------------------------------------------------------
-- 5. 知识点掌握度快照
--    诊断报告不该每次全量重算——作答即增量更新这张表，报告只读它。
--    算法（EWMA / BKT / 简化正确率）由引擎决定，这里只存结果。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_mastery (
  user_id            TEXT NOT NULL,
  knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  attempts           INTEGER NOT NULL DEFAULT 0,
  correct            INTEGER NOT NULL DEFAULT 0,
  -- 掌握度 0~1
  mastery            REAL NOT NULL DEFAULT 0,
  -- 置信度 0~1，随样本量上升。低于阈值时报告只能说「样本不足」，不得下结论
  confidence         REAL NOT NULL DEFAULT 0,
  last_seen          TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, knowledge_point_id)
);

CREATE INDEX IF NOT EXISTS idx_mastery_weak
  ON knowledge_mastery(user_id, mastery, attempts);

-- -------------------------------------------------------------
-- 6. 诊断报告
--    dimensions_json 直接复用 practice_attempts.dimensions 的契约：
--      [{"id":"content","name":"内容与切题","weight":0.3,"score":70,"comment":"…"}]
--    前端已有渲染这类维度的组件，诊断报告可以零改造套用。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnosis_reports (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  language          TEXT NOT NULL,
  exam_id           TEXT NOT NULL,
  plan_id           TEXT,
  -- daily 每日小结 / weekly 周报 / mock 模考后 / on_demand 手动触发
  scope             TEXT NOT NULL CHECK (scope IN ('daily', 'weekly', 'mock', 'on_demand')),
  window_start      TEXT NOT NULL,
  window_end        TEXT NOT NULL,
  -- 样本：本轮用到的作答条数与覆盖的知识点数。报告页必须如实显示，
  -- 样本不足时前端要降级成「继续积累中」而不是给一个假分数
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  point_count       INTEGER NOT NULL DEFAULT 0,
  -- 总体档位（如 JLPT N3 / 托福 82 分档）与能力就绪度 0~1
  -- 注意与 plans.readiness 区分：那是「计划可行性预测」，这里是「能力就绪度」
  level_label       TEXT NOT NULL DEFAULT '',
  readiness         REAL,
  summary           TEXT NOT NULL DEFAULT '',
  -- 复用既有维度契约
  dimensions_json   TEXT NOT NULL DEFAULT '[]',
  -- 薄弱点 top-N：[{pointId,code,name,mastery,attempts,priority}]
  weak_points_json  TEXT NOT NULL DEFAULT '[]',
  -- 处方：[{action,pointIds,targetCount,reason}]
  prescriptions_json TEXT NOT NULL DEFAULT '[]',
  -- 证据与限制：{sampleWarning,untaggedRate,coverage,model,latencyMs}
  -- untaggedRate 指「无法归因到知识点的作答占比」，必须透出，否则报告可信度不可证
  evidence_json     TEXT NOT NULL DEFAULT '{}',
  model             TEXT,
  source            TEXT NOT NULL DEFAULT 'heuristic' CHECK (source IN ('llm', 'heuristic')),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diag_reports
  ON diagnosis_reports(user_id, language, scope, created_at DESC);

-- -------------------------------------------------------------
-- 7. 诊断跑批任务
--    本库没有队列也没有 worker，长任务只能靠表轮询（ai_gen_runs 就是这么做的）。
--    若将来上了队列，这张表可以退化为历史记录，不必删。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnosis_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  language     TEXT NOT NULL,
  plan_id      TEXT,
  scope        TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'done', 'failed')),
  progress     INTEGER NOT NULL DEFAULT 0,
  report_id    TEXT REFERENCES diagnosis_reports(id) ON DELETE SET NULL,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diag_jobs
  ON diagnosis_jobs(user_id, status, created_at DESC);

-- 同一用户同一语种同一 scope 同一窗口，只允许一个未完成任务，防止重复跑批烧 token
CREATE UNIQUE INDEX IF NOT EXISTS uq_diag_jobs_active
  ON diagnosis_jobs(user_id, language, scope, window_start, window_end)
  WHERE status IN ('pending', 'running');


-- =============================================================
-- 零迁移读路径：把现有试卷题映射成统一题池视图（只读）
--
-- 用途：diagnosis 引擎读题统一走这个视图，不必关心底层是哪张表。
-- 说明：ai_bank_items / practice_prompts 的题干在 payload JSON 里，
--       字段名需按其真实结构补 SELECT，此处只示范三者中最规整的 exam_items。
-- =============================================================
CREATE VIEW IF NOT EXISTS v_question_pool AS
SELECT
  'exam_item'               AS source_type,
  i.id                      AS source_ref,
  p.language                AS language,
  p.exam_name               AS exam_name,
  i.section                 AS section_name,
  COALESCE(NULLIF(i.section_key, ''), '') AS section_key,
  i.kind                    AS question_type,
  i.stem                    AS stem,
  i.passage                 AS passage,
  i.options                 AS options_json,
  i.answer                  AS answer_idx,
  CASE WHEN i.kind = 'writing' THEN i.sample_answer ELSE '' END AS answer_text,
  i.explanation             AS explanation
FROM exam_items i
JOIN exam_papers p ON p.id = i.paper_id;

-- 扩展示例（字段名需按真实 payload 校准后启用）：
-- UNION ALL
-- SELECT 'ai_bank', b.id, b.language, '', b.topic, '',
--        b.item_type, json_extract(b.payload, '$.stem'), '', '[]', NULL, '', ''
-- FROM ai_bank_items b;


-- =============================================================
-- 历史回填：把已交卷的整卷作答拆成逐题记录
--
-- 已核实的真实形态：
--   · exam_attempts.answers = Array<number|null>，按 exam_items.idx 的位置对齐
--   · exam_items.idx 从 0 开始（当前库实测范围 0~9）
--   · 目前库里只有 1 条 status='active' 的未交卷记录，回填实际影响 0 行
--
-- 执行前提：
--   1) 先执行「题目同步」（见下方 STEP 1），保证 questions 里有对应行
--   2) 再跑 STEP 2
--   3) 全程在一个事务里；建议先在 .data/app.db 的副本上试跑
-- =============================================================

/* ---------- STEP 1：把 exam_items 同步进统一题池 ----------
-- questions.id 直接沿用 exam_items.id（形如 'ko-2026-full-3'，稳定且天然唯一），
-- 配合 INSERT OR IGNORE 即天然幂等：重复执行不会插出重复题目。
-- 若改用随机 UUID + 随机指纹，重复执行会不断堆积重复题，这是本脚本刻意规避的坑。
INSERT OR IGNORE INTO questions
  (id, user_id, language, exam_id, question_type, stem, passage, options_json,
   answer_idx, answer_text, explanation, difficulty, source_type, source_ref,
   fingerprint, status, created_at)
SELECT
  i.id,
  'local',
  p.language,
  CASE p.exam_name
    WHEN '托福 iBT' THEN 'toefl'
    WHEN 'JLPT 日本语能力测试' THEN 'jlpt'
    ELSE 'topik'
  END,
  i.kind,
  i.stem,
  i.passage,
  i.options,
  CASE WHEN i.kind = 'choice' THEN i.answer ELSE NULL END,
  i.sample_answer,
  i.explanation,
  0.5,
  'exam_item',
  i.id,
  i.id,                                -- 源 id 作指纹，稳定可追溯
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM exam_items i
JOIN exam_papers p ON p.id = i.paper_id;
------------------------------------------------------------ */

/* ---------- STEP 2：拆解整卷作答 ----------
-- 已核实：saveAttempt() 写入的 status 是 'done'（不是 'submitted'），
--         见 server/src/repositories/exams.ts 的 UPDATE ... status = 'done'。
--         correct / total 只统计 kind='choice' 的客观题。
INSERT INTO question_attempts
  (id, user_id, question_id, language, session_type, session_id,
   chosen_idx, is_correct, seconds, created_at)
SELECT
  lower(hex(randomblob(16))),
  a.user_id,
  q.id,
  a.language,
  'exam',
  a.id,
  CAST(json_extract(a.answers, '$[' || i.idx || ']') AS INTEGER),
  CASE
    WHEN json_extract(a.answers, '$[' || i.idx || ']') IS NULL THEN NULL
    WHEN CAST(json_extract(a.answers, '$[' || i.idx || ']') AS INTEGER) = i.answer THEN 1
    ELSE 0
  END,
  0,
  COALESCE(a.submitted_at, a.started_at)
FROM exam_attempts a
JOIN exam_items i
  ON i.paper_id = a.paper_id
 AND i.kind = 'choice'
JOIN questions q
  ON q.id = i.id
WHERE a.status = 'done'
  AND json_valid(a.answers)
  AND json_array_length(a.answers) > 0;
------------------------------------------------------------ */


-- =============================================================
-- 可选：给现有表补字段（默认不建议，保持单一事实源）
--
-- 若希望 exam_items 自己也能带难度与标注状态，才启用下面两行；
-- 否则难度与知识点统一放 questions / question_knowledge，避免双写不一致。
-- =============================================================
-- ALTER TABLE exam_items ADD COLUMN difficulty REAL NOT NULL DEFAULT 0.5;
-- ALTER TABLE exam_items ADD COLUMN knowledge_status TEXT NOT NULL DEFAULT 'untagged';


-- =============================================================
-- 建议的落地分期（与路线图对应）
--
-- 阶段 0（数据基座，必须最先做，否则后续全是空转）
--   建 knowledge_points / questions / question_knowledge / question_attempts
--   在「交卷」与「提交练习」两处写入 question_attempts
--   用 STEP 1 同步 742 道现有题；知识点标注按 section_key 先粗标，再逐批精标
--
-- 阶段 1（掌握度与报告）
--   建 knowledge_mastery / diagnosis_reports
--   交卷后用规则引擎（非 LLM）算一次掌握度与薄弱点，先把闭环跑通
--   报告 samples < 3 的知识点一律标记「样本不足」
--
-- 阶段 2（Agent 与处方）
--   LLM 只负责「归因解释」与「处方措辞」，分值仍由规则算，避免不可复现
--   每次调用写 diagnosis_jobs，token 消耗可审计
--
-- 阶段 3（教研后台）
--   知识点树维护、题目标注、难度校准
--   注意：本系统无角色体系，后台入口只能靠本地配置开关，不是权限隔离
-- =============================================================
