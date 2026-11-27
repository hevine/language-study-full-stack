-- 知识图谱基座：概念节点 + 关系边 + 统一题池 + 逐题作答 + 掌握度
--
-- 这是学情诊断的数据前提。在此之前：
--   · 没有「知识点」这个实体，题目的标签只有 section / section_key（5 类）
--   · 作答只存整卷 JSON（exam_attempts.answers），没有逐题记录，无法回答「哪道题、考什么点、对没对」
--   · 同一道题在不同年份的卷子里重复出现，按「卷子-序号」记会把一道题算成二十几道
--
-- 两类数据，两种归属：
--   内容（全局，不带 user_id）：knowledge_points / kp_edges / questions / question_knowledge
--   学习者（按账号隔离）：      question_attempts / knowledge_mastery
--
-- 与 handoff/ai-agent-diagnosis/03-diagnosis-ddl.sql 参考稿的差异（均来自实测）：
--   1. 节点与题目不带 user_id —— 它们是内容，不是某个账号的私有数据；
--   2. questions.id 是内容哈希，不是 exam_items.id —— 卷面行每次启动都会重排，内容不会；
--   3. 增加 kp_edges —— 参考稿只有三层树，表达不了「前置 / 类义 / 考查于」；
--   4. diagnosis_reports / diagnosis_jobs 暂不建 —— 诊断引擎开工时再加，不预建空表。

-- -------------------------------------------------------------
-- 1. 知识点节点
--    kind 决定这是哪一类概念；code 是稳定编码，诊断结论与处方都按它对齐，永不复用、不改义。
--    形如 en.reading.inference / en.grammar.en-001（语法点）/ en.error-rule.er-01（错因规则）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_points (
  id          TEXT PRIMARY KEY,
  language    TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  kind        TEXT NOT NULL CHECK (kind IN ('exam', 'skill', 'question_type', 'topic', 'vocab', 'grammar', 'error_rule')),
  -- 与 id 相同；单列出来是为了让「按编码查」的意图在 SQL 里可读
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- 语种内的写法，界面按语种展示；可为空
  name_local  TEXT NOT NULL DEFAULT '',
  parent_id   TEXT REFERENCES knowledge_points(id) ON DELETE CASCADE,
  -- 根为 1，逐层加一
  depth       INTEGER NOT NULL DEFAULT 1,
  -- 归属考试：toefl / jlpt / topik …；'*' 表示该语种所有考试通用
  exam_id     TEXT NOT NULL DEFAULT '*',
  -- 对齐 exam_items.section_key（listening/vocab/grammar/reading/writing），
  -- 未精标的历史数据可以按它聚合到分项粒度
  section_key TEXT NOT NULL DEFAULT '',
  -- 级别档位，按语种刻度填写：CEFR（A1–C2）/ JLPT（N5–N1）/ TOPIK（1–6급）；通用节点留空
  level_band  TEXT NOT NULL DEFAULT '',
  -- 考试权重 0~1：用于「提分性价比」排序
  exam_weight REAL NOT NULL DEFAULT 0.5 CHECK (exam_weight >= 0 AND exam_weight <= 1),
  sort_idx    INTEGER NOT NULL DEFAULT 0,
  -- 类型相关的补充信息（接续规则、词性、主题等），不参与查询
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (language, code),
  CHECK (id = code)
);

CREATE INDEX IF NOT EXISTS idx_kp_tree
  ON knowledge_points(language, parent_id, sort_idx);
CREATE INDEX IF NOT EXISTS idx_kp_section
  ON knowledge_points(language, section_key);
CREATE INDEX IF NOT EXISTS idx_kp_kind
  ON knowledge_points(language, kind, level_band);

-- -------------------------------------------------------------
-- 2. 关系边
--    type 的方向约定：
--      prereq    from 是 to 的前置 —— 学 to 之前应先会 from
--      similar   from 与 to 是类义 / 易混点，需要对比着学（无向，建表时成对写）
--      tested_in from 这个知识点被 to 这场考试考查，weight 是考查权重
--      explains  from（语言知识）能解释 to（另一知识点）的典型错误 —— 如语法点 → 它对应的错因规则
--      related   其它关联（同一主题、常搭配出现等）
--    每条边必须带来源与置信度：seed=人工审定，rule=规则抽取，llm=模型推断。
--    报告只采信置信度达标的边，其余留给人工复核。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kp_edges (
  from_id    TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('prereq', 'similar', 'tested_in', 'explains', 'related')),
  weight     REAL NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 1),
  source     TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'rule', 'llm', 'manual')),
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type),
  CHECK (from_id <> to_id)
);

CREATE INDEX IF NOT EXISTS idx_kp_edges_to ON kp_edges(to_id, type);
CREATE INDEX IF NOT EXISTS idx_kp_edges_type ON kp_edges(type, source, confidence);

-- -------------------------------------------------------------
-- 3. 统一题池
--    一道题只存一行，不管它出现在多少份卷子里。
--    id = 'q-' + sha1(语种 | 分项 | 题干 | 选项) 前 16 位 —— 由内容决定，重复同步不增行。
--    现有三处题表（exam_items / ai_bank_items / practice_prompts）不物理迁移，靠 source_type + source_ref 反查。
--    题目只增不删：下线用 status='retired'，历史作答才不会悬空。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  language      TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  exam_id       TEXT NOT NULL DEFAULT '',
  question_type TEXT NOT NULL CHECK (question_type IN ('choice', 'writing', 'speak')),
  section_key   TEXT NOT NULL DEFAULT '',
  -- 卷面大题名（Conversation / Inference / Vocabulary …），精标前的粗粒度依据
  label         TEXT NOT NULL DEFAULT '',
  stem          TEXT NOT NULL,
  passage       TEXT NOT NULL DEFAULT '',
  options_json  TEXT NOT NULL DEFAULT '[]',
  -- 客观题：正确选项下标（0 起）；主观题为 NULL
  answer_idx    INTEGER,
  -- 主观题：参考范文 / 评分要点
  answer_text   TEXT NOT NULL DEFAULT '',
  explanation   TEXT NOT NULL DEFAULT '',
  -- 难度 0（最易）~1（最难）。首版按题型给经验值，后续用作答数据校准
  difficulty    REAL NOT NULL DEFAULT 0.5 CHECK (difficulty >= 0 AND difficulty <= 1),
  source_type   TEXT NOT NULL CHECK (source_type IN ('exam_pool', 'ai_bank', 'practice_prompt', 'manual')),
  source_ref    TEXT NOT NULL DEFAULT '',
  -- 手工录入的题归属某个账号；NULL = 内置题池，全员可见
  owner_user_id TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_pool
  ON questions(language, question_type, status, difficulty);
CREATE INDEX IF NOT EXISTS idx_questions_source
  ON questions(source_type, source_ref);

-- -------------------------------------------------------------
-- 4. 题 ↔ 知识点
--    一题可考多个点：主考点 is_primary=1、weight=1；次考点 0.3~0.5。
--    诊断时按 weight 把对错分摊到各点，避免一题只归一点导致样本稀薄。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_knowledge (
  question_id        TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  weight             REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 1),
  is_primary         INTEGER NOT NULL DEFAULT 0,
  source             TEXT NOT NULL DEFAULT 'rule' CHECK (source IN ('seed', 'rule', 'llm', 'manual')),
  PRIMARY KEY (question_id, knowledge_point_id)
);

CREATE INDEX IF NOT EXISTS idx_qk_point ON question_knowledge(knowledge_point_id);

-- -------------------------------------------------------------
-- 5. 逐题作答 —— 诊断的唯一数据源
--
--    为什么必须新建：exam_attempts.answers 是 Array<number|null>，只按位置对齐，
--    不存题目 id；题库重排后历史作答即错位，且答不了「这道题考的是哪个知识点」。
--    幂等靠 (user_id, session_type, session_id, source_item_id) 唯一：同一次交卷重复落库不增行。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_attempts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  question_id    TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  language       TEXT NOT NULL CHECK (language IN ('en', 'ja', 'ko')),
  -- exam 整卷模考 / task 计划内任务 / drill 专项刷题 / review 错题重做
  session_type   TEXT NOT NULL CHECK (session_type IN ('exam', 'task', 'drill', 'review')),
  -- exam → exam_attempts.id；task → plan_days.id；drill/review → 练单 id
  session_id     TEXT NOT NULL,
  -- 卷面行 id（形如 en-2026-full-3），用来对回「当时那张卷的第几题」
  source_item_id TEXT NOT NULL DEFAULT '',
  -- 客观题：选了哪个下标（0 起）；未作答为 NULL
  chosen_idx     INTEGER,
  -- 主观题作答文本
  answer_text    TEXT NOT NULL DEFAULT '',
  -- 客观题 0/1，未作答 NULL；主观题 NULL，看 score
  is_correct     INTEGER,
  score          REAL,
  seconds        INTEGER NOT NULL DEFAULT 0,
  -- 归因，供诊断引擎区分「不会」与「不小心」：
  -- knowledge_gap 知识缺口 / misread 审题 / careless 粗心 / time_pressure 时间不够
  error_type     TEXT NOT NULL DEFAULT ''
                 CHECK (error_type IN ('', 'knowledge_gap', 'misread', 'careless', 'time_pressure')),
  created_at     TEXT NOT NULL,
  UNIQUE (user_id, session_type, session_id, source_item_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_user_time
  ON question_attempts(user_id, language, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_question
  ON question_attempts(user_id, question_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_session
  ON question_attempts(session_type, session_id);

-- -------------------------------------------------------------
-- 6. 知识点掌握度快照
--    作答即增量重算，报告只读它，不必每次全量扫作答。
--    confidence 必须同时看「做了几次」与「做过几道不同的题」：
--    同一道题连对五次只说明记住了答案，不说明掌握了这个点。
--    confidence 低于阈值时报告只能说「样本不足」，不得下结论。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_mastery (
  user_id            TEXT NOT NULL,
  knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  attempts           INTEGER NOT NULL DEFAULT 0,
  correct            INTEGER NOT NULL DEFAULT 0,
  -- 做过的不同题目数
  distinct_questions INTEGER NOT NULL DEFAULT 0,
  mastery            REAL NOT NULL DEFAULT 0 CHECK (mastery >= 0 AND mastery <= 1),
  confidence         REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  last_seen          TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, knowledge_point_id)
);

CREATE INDEX IF NOT EXISTS idx_mastery_weak
  ON knowledge_mastery(user_id, mastery, confidence);
