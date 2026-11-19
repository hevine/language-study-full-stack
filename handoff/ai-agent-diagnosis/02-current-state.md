# 外语考证宝典 · 给 AI Agent 方案方的现状资料

> 配套文件：`01-schema.sql`（21 表 DDL，脱敏）、`screenshots/`（3 张实拍）
> 本文件不含任何业务数据、用户隐私与密钥；`llm_keys` 仅提供结构。

---

## 0. 一句话技术形态

**本地优先的单用户全栈 Web 应用**，不是 SaaS、不是多租户、不是桌面壳、不是小程序。

- 前端：React 18.3 + Vite 5.4，`react-router-dom` 6 **HashRouter** SPA，13 个页面，无 UI 框架、无状态库，全部视觉由一份 8,590 行手写 CSS 承担（玻璃拟态 + 主题变量）
- 后端：**Express 4.19**（不是 Nest），TypeScript 5.5 由 `tsx` 直接执行，**无编译产物**；21,500 行，`routes(18) → services(22) → repositories → db` 四层
- 数据：`better-sqlite3` **同步驱动 + 单文件**（`.data/app.db`），21 表 / 12 个迁移，无独立数据库进程
- 运行：生产单进程单端口 `:4399`（同进程既出 API 又出 `dist/web` 静态资源 + SPA fallback），默认只监听 `127.0.0.1`
- 账号：**无**。`LOCAL_USER = 'local'` 硬编码，无 JWT / Session / passport / bcrypt（全库零命中）
- 基础设施：**无 Redis、无消息队列、无 worker、无埋点**

---

## 1. P0 五项

### 1.1 数据库表结构

完整 DDL 见 `01-schema.sql`。**但比表结构更要紧的是下面这四条「不存在」**：

| 你以为有的 | 实际情况 |
|---|---|
| `users` 表 | **没有**。用户档案是 `profile` 单行表，各表 `user_id` 字段取值恒为常量 `'local'` |
| `questions` 表 | **没有统一主表**。题目分散在四处：`exam_items`(742 行，试卷题) / `ai_bank_items`(56 行，AI 生成池) / `practice_prompts`(11 行，写作口语题) / `vocab_items`(450 行，单词卡) |
| `answer_records`（逐题作答） | **没有**。只有三处近似表，且都不是逐题粒度 ↓ |
| 知识点 / 章节标签 | **没有**。只有 `section`（人读字符串）+ `section_key`（归一到 5 类） |

**作答明细的真实存储方式**（这是最关键的一条）：

- `exam_attempts` —— 整卷作答。**`answers` 是一个 JSON 文本字段**，另有 `correct` / `total` 两个汇总数。全库**仅 1 条记录且 `status='active'`（从未完整提交过）**，`correct=0, total=0`
- `practice_attempts` —— 写作/口语单次提交，**全库 1 条**（日语口语 81 分）
- `study_logs` —— 26 条，字段只有 `kind / minutes / score`，**不含任何题目标识**

**试卷表是有的**：`exam_papers` 81 份（en / ja / ko 各 27），字段含 `paper_type`（real|mock）、`sections_json`、`origin_url`、`import_file`、`import_meta`。

**标签粒度实际只有两级**：
- `exam_items.section` —— 人读的章节名，如 `Factual information`、`文脈規定`、`어휘`（语言内共 15 个）
- `exam_items.section_key` —— 归一到 5 类：`vocab / grammar / reading / listening / writing`

没有：知识点表、难度分级、tag 表、题目↔知识点关联、题干能力维度。

> **对第 7 章的直接结论：第 7 章是「新增表」，不是「改造现有表」。**
> 但不是加 1–2 张表，而是最小 5 张（落地版做到 7 张）：`knowledge_points` / `questions` / `question_knowledge` / `question_attempts`（逐题）/ `knowledge_mastery` / `diagnosis_reports` / `diagnosis_jobs`。
> 其中 `question_attempts` 是**一切诊断的数据前提**，它现在不存在。
>
> 这 7 张表的**可执行 DDL 已经在 `03-diagnosis-ddl.sql` 里写好**，按本库命名/类型/索引/注释风格，已在临时库完整跑通 30 项验证（含约束、级联、视图、历史回填）。第 7 章可直接对着填或裁剪。

---

### 1.2 现有学情报告：截图 + 计算逻辑

截图四张（`screenshots/`）：
1. `01-dashboard-learning-stats.png` —— 首页学情总览
2. `02-practice-hub-grading.png` —— 写作·口语批改中心
3. `03-exam-paper-bank.png` —— 试卷库（81 卷 / 2000–2026 逐年）
4. `04-exam-result-section-scores.png` —— **交卷结果页**（现有报告的天花板，2026-11-08 实拍）

**计算逻辑**（`server/src/services/stats.ts`，`buildStats()`）：

| 指标 | 算法 |
|---|---|
| `streak` 连续打卡 | 从最近一个有记录日期往回数连续天数 |
| `totalMinutes` 累计学习 | `study_logs.minutes` 求和 |
| `activeDays` | 有记录的去重日期数 |
| `vocabulary` | 词汇总数 / 今日到期 / 已掌握（SM-2 参数 `ease`/`interval_days` 推导） |
| `activity` | 近 14 天每日分钟数与任务数 |
| `practice` | 近 40 次写作口语的 `overall` 均分 + 趋势序列 |
| `plan.completionRate` | 已完成天 / 计划总天 |
| `plan.readiness` 达标概率 | `feasibility.probability × (0.62 + 0.38 × completionRate)`，封顶 0.97 |

**唯一的「维度化」评分，只存在于写作与口语**（`practice_attempts.dimensions`，JSON 数组）：

```json
[
  {"id":"content",      "name":"内容与切题", "weight":0.30, "score":70, "comment":"内容展开不足…"},
  {"id":"fluency",      "name":"流利与连贯", "weight":0.25, "score":90, "comment":"未检出填充词…"},
  {"id":"language",     "name":"语法与词汇", "weight":0.25, "score":92, "comment":"未检出常见语法错误…"},
  {"id":"pronunciation","name":"发音与语调", "weight":0.20, "score":74, "comment":"该维度无法仅凭文本判断…"}
]
```

这是**「输出能力评分维度」**（内容/流利/语法/发音），不是知识点诊断维度。它随考试品类变化（雅思写作 4 维、JLPT 无口语题型等，见 `domain/rubrics.ts` 376 行）。

**交卷结果页其实已经做到了分项粒度**（`ExamResult.tsx`，见 `04-exam-result-section-scores.png`）：
- 整卷圆环分 + 一句评价（「差一口气」）+ 答对/用时/错题/写作计数
- **「分部分得分」条形图**：듣기 1/2、어휘 2/3、문법 2/2、읽기 1/2、쓰기 写作
- 逐题解析：你的选择 / 正确答案 / 解析 / 听力原文

但它是**每次打开现算、不落库**——直接由 `exam_attempts.answers` + `exam_items` 实时 join 得出，没有沉淀成可跨次、跨卷聚合的诊断数据。所以「어휘 最近 30 天的正确率趋势」这类问题，现有实现答不了；换个计划、换份卷，历史就得重算一遍。

**客观题（660 道 choice）没有任何「存储的」逐题记录**。但有一处需要修正措辞（2026-11-08 实测）：**分项正确率其实能用现有 schema 现算**，不必等新表——

```sql
SELECT i.section_key, COUNT(*) n,
       SUM(CASE WHEN CAST(json_extract(att.answers, '$[' || i.idx || ']') AS INTEGER) = i.answer
                THEN 1 ELSE 0 END) ok
  FROM exam_attempts att
  JOIN exam_items i ON i.paper_id = att.paper_id AND i.kind = 'choice'
 WHERE att.id = ? GROUP BY i.section_key;
```

在真实交卷上跑出：`vocab 2/3 67% / grammar 2/2 100% / listening 1/2 50% / reading 1/2 50%`，逐题明细也能完整还原。

所以准确的结论是：
- ✅ **能**算到 `section_key`（5 类分项）粒度的正确率，冷启动可以零改表先出报告
- ❌ **不能**到知识点粒度（section_key 只有 5 类，"vocab 67%" 无法定位到具体语法点）
- ❌ **不能**跨卷合并同一知识点（没有知识点标签做锚点）
- ❌ **不能**记录单题耗时、错误归因、重做轨迹
- ⚠️ **脆弱**：`ensureExamBank()` 每次启动都 `DELETE + 重插` `exam_items`，`idx` 由 seed 顺序决定；题库内容一变，历史 `answers` 的下标语义就漂移（详见第 5 节）

> **对第 8 章的直接结论：诊断引擎是「从零建」，不是「升级」。**
> 唯一可直接复用的是 `dimensions` 的**输出契约范式**（`{id, name, weight, score, comment}` 加权维度 + 评语）。建议诊断报告直接沿用这个 JSON 形状，前端渲染组件可复用、用户也已习惯。
> 另外 `readiness` 是「计划可行性预测」，不是「能力诊断」，两者不要混为一谈。

---

### 1.3 题库现状

| 维度 | 实际 |
|---|---|
| 题量 | **742 题 / 81 卷**（en、ja、ko 各 27 卷，每卷 10 题 34 分钟） |
| 题型分布 | `choice` 660、`writing` 82 |
| 标签粒度 | `section` 15 个（语言内）+ `section_key` 5 类；**无知识点、无难度** |
| 解析覆盖率 | **100%（742/742 有 `explanation`）** |
| 版权来源 | **全部 `paper_type='mock'`（仿真卷），0 份真题**；`origin_url` / `import_file` 全为空；界面明确标注「仿真卷 / 非真题原卷」；真卷需经 `npm run import:exam -- --file x.json` 自行导入 |
| 附加池 | `ai_bank_items` 56 条（word 37 / sentence 14 / quiz 5），带指纹去重 |

**section 分布（节选）**：en 侧 `Vocabulary` 54 / `Conversation` 32 / `Writing` 27 / 阅读六类各 9；ja 侧 `文法形式` 54 / `文脈規定` 40 / `内容理解` 36 / `漢字読み` 28；ko 侧 `어휘` 65 / `문법` 54 / `내용 이해` 36。

> **对题库工厂的结论：合规约束强度低（无真题=无版权风险），但反过来也意味着没有内容护城河。**
> 工厂要启动只缺三样：**知识点体系**、**难度分级**、**来源溯源**（`origin_url` 字段已有但全空，等于没启用）。
> 好消息：`sections_json` + `import_meta` 已经预留了扩展位，加字段成本低。

---

### 1.4 后端技术细节

| 项 | 实际 |
|---|---|
| 框架 | **Express 4.19**（非 Nest），18 个 router |
| 认证 | **无**。无 JWT / Session / passport / bcrypt；`LOCAL_USER='local'` 常量贯穿全部 repository |
| 缓存 / 队列 | **无 Redis、无队列、无 worker**。长任务靠同步 `await` + `ai_gen_runs` 表当运行日志 |
| 输入校验 | zod（`parseBody`），统一错误中间件 + 请求 id 日志 |
| 数据驱动 | `better-sqlite3` **同步 API**，单文件，`.data` 目录 `chmod 700` |
| 部署 | 单进程，`tsx` 直跑 TS；dev 双端口（5199 反代 4399），prod 单端口 4399，仅 `127.0.0.1` |

> **对第 6 章的结论：集成方式必须是「同仓模块（in-process）」，不能是独立服务。** 三个硬约束，缺一不可推翻：
> 1. **无鉴权** —— 跨服务无法传递身份，独立服务只能裸奔或自造一套 token
> 2. **SQLite 单写者 + 同步驱动** —— 两个进程同时写会锁冲突，诊断跑批和主服务必然打架
> 3. **无队列基础设施** —— 长任务（批量诊断）只能自己实现轮询表（现有 `ai_gen_runs` 就是雏形）
>
> 如果方案里写了「独立诊断服务 + 消息队列 + Redis 缓存」，第 6 章要重写。

---

### 1.5 前端路由与页面清单

13 页，HashRouter（`web/src/App.tsx`）：

| 路由 | 页面 | 能否作挂载点 |
|---|---|---|
| `/` | Dashboard 今日概览（含学情指标） | **半可挂**：是首页 dashboard，不是独立「学情中心」；加卡片或加 tab 都行 |
| `/today` | 今日任务 | — |
| `/task/:date/:taskId` | 单任务详情 | — |
| `/plan` | 学习计划 | — |
| `/path` | 学习之路（3 阶段路线图） | — |
| `/practice` | **写作·口语批改中心** | 可挂「诊断」入口 |
| `/practice/:date/:taskId` | 单次批改详情 | — |
| `/vocab` | 词汇本（SM-2） | — |
| `/exams` | 考试中心（81 卷） | 可挂「薄弱项定向练」 |
| `/exams/:paperId/take` | 答题页 | — |
| `/exams/attempts/:attemptId` | 交卷结果 | 可挂「逐题诊断」 |
| `/setup` | 建计划向导 | — |
| `/settings` | 用户设置（模型 Key / 音色 / 主题 / 数据） | — |

> **对前端的结论：**
> - 「学情中心」——加组件即可，`/` 或 `/practice` 都能承载
> - 「教研后台」——**不存在，必须新建页面 + 新路由**；而且因为没有角色体系，后台入口只能靠「隐藏路由 / 本地配置开关」，**做不了真正的权限隔离**。这是形态限制，不是工程量问题。

---

## 2. P1 项

| 项 | 实际 |
|---|---|
| 考试品类 | 托福 iBT、JLPT（N1–N5）、TOPIK II；**3 语种 × 1 考试**，无扩展品类 |
| MAU / 日均答题量 | **不存在**。单用户本地应用；当前库内已提交试卷 **0 次**、写作口语批改 **1 次** |
| 埋点能力 | **无**。`analytics/track/events` 全库零命中。只有业务表 + 请求日志（含 request id） |
| LLM 供应商与预算 | OpenAI 兼容协议，**多线路号池**（现 5 个 key，加密存储于 `llm_keys`），可切智谱/混元/魔搭/DeepSeek；**无预算上限控制**，仅有单次 token 预算（10000）与截断重试/定向补缺 |
| 教研审核流程 | **无** |
| 报告页跳出率 | **无** |

补充两条对 Agent 有用的：未配置 Key 时自动进**演示模式**（内置题库跑全流程，可完全离线）；TTS 三档（本地 `local://edge` → 外部 openai-edge-tts → 浏览器 speechSynthesis）。

---

## 3. 附录 A 更正表：你的通用假设 vs 本项目实际

**这十行是这份资料里最该被拿去改方案的部分。**

| # | 通用假设 | 本项目实际 | 影响章节 |
|---|---|---|---|
| 1 | 有 `users` 表、多用户 | 单用户，`user_id='local'` 常量 | 6 / 7 / 8 |
| 2 | 有 `questions` 统一表 | 三处分散，无主表，需先合并或建视图 | 7 |
| 3 | 有 `answer_records` 逐题记录 | 仅 `answers` JSON blob，且从未提交过 | 7 / 8 |
| 4 | 有知识点/章节标签体系 | 只有 5 类 `section_key`，无知识点、无难度 | 7 / 8 |
| 5 | 现有学情报告是「正确率统计」 | 是**聚合量与预测概率**；无任何正确率拆解 | 8 |
| 6 | 有「教研后台」挂载点 | 无。`/settings` 是用户设置，不是教研后台 | 6 |
| 7 | 可能已有 Redis / 队列 | 无任何缓存与队列基础设施 | 6 |
| 8 | 集成可能需要认证对接 | 系统本身无认证，不存在「对接」问题 | 6 |
| 9 | 题库有真题版权约束 | **全仿真卷，0 真题**；约束反而不成立 | 题库工厂 |
| 10 | 关系库可水平扩展 | SQLite 单文件单写者，同步驱动 | 6 / 部署 |

---

## 4. 对路线图工作量估算的三点提醒

1. **最大工作项是数据基座，不是诊断算法。**
   逐题作答记录目前不存在，诊断引擎上线即「无数据可诊」。建议把「逐题落库 + 知识点标注 + 回填历史」放在第 0 阶段；否则第 8 章功能会整章空转，演示时只能拿 1 条口语记录撑场面。

2. **知识点体系是教研工作量，不是工程工作量。**
   要覆盖 3 个语种各自的考试体系：JLPT 是 `語彙/文法/読解/聴解`、TOPIK 是 `어휘/문법/읽기/듣기/쓰기`、托福是四技能 + 题型细分。三套体系不能共用一棵树。这块估时若按「建个 tag 表」算，会差一个数量级。

3. **单用户形态决定了「多角色」相关设计不成立。**
   如果 agent 设计里含教师端 / 教研角色 / 班级机构 / 审核工作流，要么砍掉，要么先给系统加账号体系——后者是独立的大工程（现有 21 张表全部无外键指向用户，迁移成本不低）。

---

## 5. Phase 0 验收定义（契约级）

**总验收：能在一套真卷上从开考走到出分，且这次作答能被逐题查出来。** 不满足这条，后面所有章节都是空转。

实测基线（2026-11-08，本次交付前）：库内已交卷 **0 次**、逐题记录 **0 条**、写作口语批改 1 条。
本次已实测跑通一次完整交卷：`ko-2026-full`，6/9 = 67%，逐题判定与落库一致（`status='done'`、`answers` 10 位、`writing` 存了 idx 9）。**所以「能不能交卷」不是风险点**，Phase 0 要解决的是「交卷之后有没有留下可诊断的痕迹」。

| # | 环节 | 完成定义（可验收） | 验收判据 |
|---|---|---|---|
| 1 | 建 7 张表 | 迁移可重复执行、约束生效、**不改动现有 21 表** | 连跑两次迁移不报错；`03-diagnosis-ddl.sql` 的 33 项自检全过 |
| 2 | 交卷写入 `question_attempts` | 交卷后，该次**客观题**每题有且仅有一条记录 | `select count(*) from question_attempts where session_id=?` = 该卷 choice 题数（**不是 total**） |
| 3 | 练习提交也写 | 写作/口语提交（`practice_attempts` 路径）同样落一条，`is_correct=NULL`、`score=overall` | 提交一次写作后能查到 `session_type='task'` 的记录 |
| 4 | 同步 742 题 | `questions` 里 `source_type='exam_item'` 恰好 742 行，id 与 `exam_items` 一一对应，**重复同步不增行** | 跑两次 STEP 1 后仍为 742（幂等靠 `questions.id = exam_items.id`） |
| 5 | 三棵树粗标 | 3 语种各一棵，至少到 `section_key`（5 类）；每题至少挂 1 个知识点 | `select language,count(*) from knowledge_points group by language` 三行齐全；`question_knowledge` 覆盖率 100% |
| 6 | 冷启动诊断入口 | 前端一个入口，对任意已交卷记录出「分项正确率 + 薄弱项」，样本不足显式标注 | 打开页面能看到环节 2 那次交卷的分项分数 |

### 三个施工必踩的坑（已实测确认）

1. **状态值是 `done`，不是 `submitted`。** `saveAttempt()` 里写死 `status = 'done'`。所有按状态过滤的 SQL（含回填）都必须用 `done`，否则永远 0 行。
2. **两套键不一致。** `answers` 用**数组位置**索引，`writing` 用 **`idx` 字符串**做 key。当前 seed 题库 `idx` 从 0 连续，两者恰好重合；一旦导入的卷有 `idx` 空洞，两者会错位。
3. **必须存题目快照，不能只存 `question_id`。** `ensureExamBank()` 每次启动都 `DELETE FROM exam_items WHERE paper_id` 再按 seed 顺序重插，`idx` 与内容绑定的是 seed 顺序。题库一改（换题/增删题），历史 `answers` 的下标语义立刻漂移。
   → 因此 `question_attempts` 要能还原「当时那道题长什么样、正确答案是什么」：`questions` 表**只增不删**（下线用 `status='retired'`），并在写入作答时把 `answer_idx` 快照进去。只存外键是不够的。

> **一句话版本（可直接发给方案方）**：Phase 0 的唯一验收标准是——在一套真卷上交一次卷，然后能用一条 SQL 从 `question_attempts` 里把它逐题查出来，并且每道题都挂到了知识点上。缺任何一环，诊断引擎上线即空转。

---

## 6. 第 7 章参考 DDL（`03-diagnosis-ddl.sql`）

已按本库风格写好，可直接当作第 7 章骨架。7 张新表 + 1 个只读视图，**不改动现有 21 张表**（迁移风险为零）。

| 表 | 作用 | 关键设计点 |
|---|---|---|
| `knowledge_points` | 知识点树 | 三级（考试/分项/知识点）；`code` 稳定编码跨版本不改；`section_key` 对齐现有 `exam_items.section_key`，让未标注的历史数据也能先按分项聚合 |
| `questions` | 统一题池 | **不物理迁移现有三处题表**，用 `source_type + source_ref` 反查；难度 `difficulty` 0~1；指纹部分唯一索引允许草稿态空指纹 |
| `question_knowledge` | 题↔知识点 | 多对多 + `weight`：一题多考点按权重分摊对错，避免样本稀薄 |
| `question_attempts` | **逐题作答（核心）** | 存 `question_id` 而非下标；带 `session_type`（exam/task/drill/review）与 `error_type` 归因（知识缺口/审题/粗心/时间） |
| `knowledge_mastery` | 掌握度快照 | 增量更新，报告只读它；带 `confidence`，样本不足时不允许下结论 |
| `diagnosis_reports` | 诊断报告 | `dimensions_json` **直接复用 `practice_attempts.dimensions` 的契约**，前端组件零改造；`evidence_json.untaggedRate` 强制透出不可归因占比 |
| `diagnosis_jobs` | 跑批任务 | 无队列时的表轮询（对齐 `ai_gen_runs`）；部分唯一索引防重复跑批烧 token |

配套给了两段可直接用的脚本：
- **零迁移读路径**：视图 `v_question_pool` 把 `exam_items` 映射成统一题池
- **历史回填**：从 `exam_attempts.answers`（`Array<number|null>`，按 `idx` 位置对齐、从 0 起）拆成逐题记录

**已验证**（临时库，**33 项全过**）：整体执行通过、可重复执行、UNIQUE 与 CHECK 生效、部分唯一索引生效、`ON DELETE CASCADE` 级联正确、视图字段映射正确、STEP 1 同步幂等（重复跑不增行）、回填四场景（全对/全错/空作答/未交卷）均不误判、分项正确率可现算。

**三个已修正/已确认的实现细节**：
1. 回填条件用 `status = 'done'`（实测 `saveAttempt()` 写的就是 `done`，不是 `submitted`）
2. `questions.id` 直接沿用 `exam_items.id`（形如 `ko-2026-full-3`），天然唯一且幂等；**不要用随机 UUID + 随机指纹**，否则每跑一次就堆一批重复题
3. 当前库 `exam_attempts.total` 只统计 `kind='choice'`，写作题不计分母

**一个建议写进第 7 章的判断**：`evidence_json` 里必须留 `untaggedRate`（无法归因到知识点的作答占比）。首次上线时这个值会很高（题池标注不全），报告页要能显示「本轮 62% 的作答未能归因」，否则诊断结论不可证伪，用户会当成玄学。

---

## 7. 没有提供的

代码全文、真实用户数据、任何密钥，均未提供。`llm_keys` 仅导出 DDL，不含任何行。截图已确认不含个人身份信息（页面仅有「学员」默认昵称与学习统计）。

---

*如需要补充：某个具体接口的请求/响应样例、`exam_items` 单题完整 JSON、或诊断报告希望对齐的现有组件，随时可再出。*
