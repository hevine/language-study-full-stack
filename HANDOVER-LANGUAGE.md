# HANDOVER-LANGUAGE · 语种贯穿与「新增一门语言」专项交接

> **给谁读**：接手「再加一门语言（法语/德语/俄语…）」或再遇到「选了韩语却生成托福题」这类串台 bug 的人。
> 只讲语种这一条线：语种怎么贯穿、新增要改哪些地方、哪些地方会**静默退回英文**、怎么验。
> 项目根目录：`/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian`（**不是**当前会话的 workspace 目录）。
> 基线：`main@92fac05`，工作区有较多未提交改动（本次语种修复 + 更早的解题视频 / 听力库 / 教案改动混在一起，别当成同一批）。

---

## 0. 一句话现状

`en / ja / ko` 三套链路已经各自成立：计划 → 每日材料 → 命题 → 评分标准 → 批改 → 加练 → 试卷 → 朗读/语音，全部按 `plans.language` 走，并由 `npm run check:lang` 守门。
「AI 学习台」（`server/src/agent`）同样三语同级：分词 / 句法 / 错因 / 音韵 / 等级五件套齐备，四个场景 `ready=true`，由 `npm run check:agent` 守门 —— 那半边的全貌见 **`HANDOVER-LANGUAGE-MATRIX.md`**，加新语种的操作顺序见 **`HANDOVER-NEW-LANGUAGE.md`**（本文只管主项目层）。
新增第 4 门语言的成本 ≈ **8 类数据文件 + 20 余张映射表 + 6 处提示词/文案分支 + 1 个迁移**；TypeScript 会把「必须补的映射表」直接报出来，真正危险的是那些**编译能过、运行期静默退英文**的地方（见 §3.3 黑名单）。

如果你只想知道「韩语那次为什么生成了托福任务」→ 直接跳 §4。

---

## 1. 语种是如何贯穿的（30 秒心智模型）

**唯一真源是数据库的 `plans.language`**，前端不单独存「当前语种」。

```
plans.language  ──►  GET /api/plans/active ──►  useApp().language
                          │
                          ├─► 生成链路：planner / dayArticle / practice / rubrics / grading / aiGen / exams
                          └─► 展示链路：主题色、朗读语音、单位（词/字/语节）、文案
```

切语种**只有一个动作**（`web/src/App.tsx:167 switchLanguage`）：

1. 找到目标语种的计划（有就激活，没有就引导去 `/setup`）；
2. `POST /api/plans/:id/activate`；
3. `reload()` 重新拉 `catalog + activePlan`；
4. `Routes key={planKey}`（`App.tsx:158`）整棵树重挂载，所有页面重新取数。

所以「切了语种但页面还是旧数据」基本只有两种可能：**当前计划没真正切换**，或**命中了不校验语种的缓存**（见 §5）。

### 三条必须守住的契约

| 契约 | 落点 | 违反的后果 |
| --- | --- | --- |
| 写库前校验语种 | `domain/language.ts` 的 `isLanguage` / `requireLanguage`；数据库 CHECK + 触发器 | 跨语种脏数据，事后只能手工洗库 |
| 生成按 **plan.language** 分叉，不按 `examId` | `rubricFor` / `buildPromptMessages` / `buildArticleMessages` / `buildGradePrompt` | 历史数据里 `exam_id=toefl` + `language=ko` 时，把托福模板套到韩语计划上 |
| 读缓存必须校验 `language` | `services/content.ts:122`、`services/practice.ts:220` | 切语种后仍返回旧语种的题与文章 |

---

## 2. 语种定义在哪（三处联合类型 + 一处外部包）

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| `server/src/domain/language.ts:3` | `type Language = 'en' \| 'ja' \| 'ko'` | 后端的**权威**定义；`LANGUAGE_PROFILE`（:47）集中放中文名、母语名、`textLabel`（批改里「引用原文用哪种语言」）、长度单位 |
| `server/src/catalog/types.ts:1` | 同一联合类型又写了一遍 | 历史遗留的重复定义，改一处必须改两处 |
| `web/src/types.ts:1` | 前端同一联合类型 | `Plan.language`、`PracticePrompt.language` 都挂在这 |
| `packages` 外部依赖 `@waiyubaodian/ui-kit` | `ui-kit-sdk/src/theme/index.ts:36,39` | `Language` 联合 + `DEFAULT_THEME = { en:'blue', ja:'pink', ko:'teal' }`。**在本仓库之外**（`file:../../2026-11-22-14-24-29/ui-kit-sdk`），加语种必须同时改那个包并重新 `npm install` |

`language.ts` 里的 `LANGUAGE_PROFILE` 是「按语种分叉」的**首选出口**：命题/批改/统计需要语种差异时，先看这里有没有字段，没有再加，不要在业务文件里写 `language === 'xx' ? ... : ...`。

---

## 3. 新增一门语言：改动清单

### 3.1 必改——不改编译不过（TypeScript 就是 checklist）

这些是 `Record<Language, ...>` 全量映射，加一个成员立刻满屏红，逐个补齐即可：

| 文件 | 映射 | 用途 |
| --- | --- | --- |
| `server/src/catalog/index.ts:18` | `CATALOG` | 语种 → 等级/考试/`speechLang` |
| `server/src/domain/language.ts:8,47` | `LANGUAGE_NAME`、`LANGUAGE_PROFILE` | 中文名、单位、引用语言 |
| `server/src/domain/rubrics.ts:438` | `BY_LANGUAGE` | 语种兜底评分标准（examId 对不上时用） |
| `server/src/content/paths.ts:298` | `PATHS` | 「学习路径」页文案 |
| `server/src/repositories/voices.ts:25,31` | `BCP47`、`SAMPLE_TEXT` | 语音标签、试听样句 |
| `server/src/services/voiceCatalog.ts:95` | `POPULAR_PRESETS` | 推荐音色 |
| `server/src/services/edgeTts.ts:42` | `EDGE_VOICES` | 本地 Edge 神经音色 |
| `server/src/services/asr.ts:35` | `LANGUAGE_HINT` | 识别语言与提示词 |
| `server/src/services/aiGen.ts:107,119` | `SYSTEM`、`NATIVE` | AI 加练提示词 |
| `server/src/services/grading.ts:843,961` | `UPGRADES_BY_LANGUAGE`、`GRADE_SYSTEM` | 高分替换建议、评分官身份 |
| `server/src/services/explainScript.ts:44` | `NARRATION_LANG_LABEL` | 解题视频旁白语言名 |
| `server/src/services/explainPedagogy.ts:418,445` | `LANG_NAME`、`DENSITY_SAMPLE` | 讲解密度与示例 |
| `server/src/services/explainNative.ts:19` | `LANG_LABEL` | 母语讲解 |
| `server/src/services/explainExport.ts:45` | `LANG_TAG` | 字幕轨标签（ISO 639-2） |
| `server/src/services/explainShots.ts:107` | `SYNTH` | 取词合成配置 |
| `server/src/services/explainVideo.ts:129` | `DEFAULT_NEURAL` | 默认神经音色 |
| `web/src/hooks/voiceUtils.ts:15,30` | `BCP47`、`SAMPLE_TEXT` | 前端语音 |
| `web/src/components/VoiceStudio.tsx:36,37` | `LANG_LABEL`、`LANGS` | 音色工作台 |
| `web/src/components/CreativeLoading.tsx:37` | `VERSE` | 生成等待文案 |

外加**穷举式 `z.enum(['en','ja','ko'])`**，漏了会让请求直接 400：

```
server/src/routes/plans.ts:20        server/src/routes/lexicon.ts:19
server/src/routes/voices.ts:46       server/src/routes/exams.ts:19
server/src/routes/paths.ts:9         server/src/routes/vocab.ts:22
server/src/routes/examImports.ts:24  server/src/agent/routes.ts:21,274
server/src/agent/lang/loader.ts:26   server/src/agent/evals/harness.ts:156
```

以及三个语种判断实现：`server/src/domain/language.ts:14 isLanguage`、`web/src/pages/Practice.tsx:17`（单位统计）、`web/src/hooks/useSpeaking.ts:59`（BCP47 → ASR ISO）。

### 3.2 必补——数据与内容（不改能跑，但内容是空的/英文的）

| 类别 | 参考实现（韩语） | 要点 |
| --- | --- | --- |
| 考纲目录 | `server/src/catalog/ko.ts`（187 行） | `LEVELS`（id/vocab/hoursFromZero/equiv）+ `EXAMS`（sections/targets/syllabus/topicPool/hoursModel/phases/textLength），最后在 `catalog/index.ts` 注册 |
| 考试日历 | `server/src/catalog/calendar.ts:353 topikCalendar`、`:475` 分派 | 报名/考试节点 |
| 考试场次 | `server/src/catalog/sessions.ts:133 topikSessions`、`:169` 分派 | 场次与截止 |
| 分级词库 | `server/src/content/koLexicon.ts`，出口 `content/lexicon.ts:84,128,189`（各 3 个 `if`） | 词库建议**精选精讲**而非全量；每条含读音/词性/释义/记忆法/例句 |
| 内置文章库 | `server/src/content/library.ko.ts` + `library.ko.extra.ts` | LLM 不可用时的兜底正文 |
| 内置写作/口语题 | `server/src/content/prompts.ts:384 KO_WRITING`、`:426 KO_SPEAKING`，分派在 `:450 pickPrompt` | 语音/无 Key 时的兜底题目 |
| 升级自测题库 | `server/src/data/exams/ko.ts`，注册在 `data/exams/index.ts` 的 `POOLS` | 按 `SeedPool` 写分项题池，逐年轮换组卷 |
| 评分标准 | `server/src/domain/rubrics.ts` 的 `TOPIK_WRITING` / `TOPIK_SPEAKING`，注册进 `:444 RUBRICS` | `label`/`taskType`/`wordRange`/`scale` 必须符合该考试真实口径 |
| 语音标识 | `catalog/ko.ts` 的 `speechLang: 'ko-KR'` | 朗读、浏览器 TTS、ASR 都用它 |

### 3.3 必补——静默退英文的黑名单（编译能过，最容易漏）

这几处是 `Record<string, ...>` 或 `if/else` 链，**不会报类型错**，新语种会掉进英文兜底。韩语 bug 就是从这类地方漏出去的：

| 位置 | 现状 | 不改的后果 |
| --- | --- | --- |
| `server/src/services/practice.ts:45 buildPromptMessages` | `if (ja) {...} if (ko) {...} return [英文命题人]` | 新语种拿到「熟悉托福/雅思的英语命题人」+ 英文题干 |
| `server/src/services/dayArticle.ts:66 SYSTEM`、`:68 LABEL` | `Record<string, string>`，取不到走 `?? EN_SYSTEM` | 每日材料用英语教研员提示词写，字段名也是英文 |
| `server/src/services/dayArticle.ts:371 localSegments` | `language === 'en' ? 按句号切 : 按「。」切` | 非英语语种全按日文标点切句 |
| `server/src/content/prompts.ts:450 pickPrompt` | 非 ja/ko 一律走英语题库 | 兜底题目是托福/雅思题 |
| `server/src/services/planner.ts:217 taskCopy`、`:473 ANGLES` | `if (ja) / if (ko) / else 英文` | 今日任务标题、主题角度用英文文案 |
| `server/src/services/grading.ts:284 analyze` | 只有 `if (ja)` 与 `if (ko)` 两套启发式，其余走英文（主谓一致/冠词/填充词 um-uh） | 新语种按英语语法规则打分，填充词永远 0 或误判 |
| `server/src/services/grading.ts:985 buildGradePrompt` | 评分官身份、引用语言、长度单位已全部走 `GRADE_SYSTEM` 与 `profileOf()`，属**已加固区** | 新增语种会编译报错逼你补齐；但 drills / 替换建议仍是软降级（见下一行） |
| `server/src/services/grading.ts:859 buildUpgrades` | 按语种取替换建议表（`:843 UPGRADES_BY_LANGUAGE`） | 新语种没有条目 → 建议为空（静默降级） |
| `server/src/services/content.ts:122`、`server/src/services/practice.ts:220` | 缓存守卫比对 `language` | 不校验就返回旧语种内容 |
| `web/src/pages/PracticeHub.tsx:11 SCALE_EXAMPLE` | `?? SCALE_EXAMPLE.en` | 页面写「托福 0–5」 |
| `web/src/pages/Path.tsx:64,251` | 三元链 `ja ? … : ko ? … : 英语` | 文案错 |
| `web/src/pages/Practice.tsx:19,49,175,220,311,437` | 单位 `字/语节/词`、`speechLang` 三元链 | 字数统计与语音语言错 |

> 约定：新增分支时**不要再写 `else 英文`**。要么显式 `if` 到每一种语种，要么把文案/提示词做成 `LANGUAGE_PROFILE` 或语种数据文件里的一项，让遗漏变成编译错误。

### 3.4 必须写数据库迁移（SQLite 的 CHECK 不会自己放宽）

语种白名单不只在前端和服务端，库里有硬约束。加语言**必须新增一个迁移**（不要改历史迁移文件）：

| 迁移 | 约束对象 |
| --- | --- |
| `005_materials.sql` | `materials`、`material_units`、`material_words` 的 `CHECK (language IN ('en','ja','ko'))` |
| `008_ai_bank.sql` | `ai_gen_runs`、`ai_bank_items` |
| `009_exams.sql` | `exam_papers`、`exam_items`、`exam_attempts` |
| `012_voices.sql` | `voices`、`voice_assignments`、`voice_prefs` |
| `015_listening_library.sql` | `listening_materials` |
| `003_vocab_levels.sql` → `004_korean.sql` | `vocab_items` 上的两个**触发器**（`trg_vocab_language_insert/update`） |

`004_korean.sql` 是现成范例：SQLite 不能 `ALTER` 触发器，所以先 `DROP TRIGGER` 再 `CREATE TRIGGER`，把 `NOT IN ('en','ja')` 放宽成 `NOT IN ('en','ja','ko')`。
带 `CHECK` 的表更麻烦——SQLite 改 `CHECK` 只能「建新表 → 拷数据 → 删旧表 → 改名」，迁移里要按这个套路写，并在事务里做。

`plans` / `day_contents` / `practice_prompts` 这些表的 `language` 列**没有 CHECK**，不用迁移，但服务端写入必须过 `requireLanguage`。

---

## 4. 事故复盘：选了韩语，为什么生成的是托福任务

**现象**：侧栏切到韩语，`/today` 左侧是韩语计划，右侧任务卡却是托福写作/口语。

**不是**「切语种没全局生效」——`switchLanguage → activate → reload → key 重挂载` 这条链是通的，`plans.language` 确实是 `ko`。真实原因是**生成端只有「日语」和「默认英文」两条分支**，韩语掉进英文兜底，再叠加缓存不校验语种，错的内容一直留着。

四处根因与修复：

| # | 根因 | 证据 | 修复 |
| --- | --- | --- | --- |
| 1 | `practice.ts` 命题提示词只有 ja + 默认英文 | 韩语计划下缓存的题：`scenario = "You are taking the TOPIK Speaking test…"`，题干英文 | 补 `ko` 分支（TOPIK 出题委员、题干韩文、hints 中文），并把 `language` 写进 `PracticePrompt` |
| 2 | `rubrics.ts` 的 `RUBRICS` 里没有 `topik`，兜底 `DEFAULT_EN` | `rubricFor('topik','ko','write')` 返回「Task 2 议论文（Band 0–9）」 | 新增 `TOPIK_WRITING/SPEAKING`，注册 `RUBRICS.topik`，`rubricFor` 改为**以计划语种为准**，examId 跨语种时 warn + 退本语种标准 |
| 3 | `grading.ts` 评分官是「托福/雅思/四六级」，且硬要求 `quote/fix/rewrite 用英文`；替换建议只有日语版；韩语填充词正则 `/음\|어/` 误伤「어려움」 | 韩语作文的评语里出现英语语法项，`어려움` 被算成填充词 | `GRADE_SYSTEM` 补 `ko`；韩语 drills/替换建议；`FILLERS_KO` 用 `(?<![가-힣])…(?![가-힣])` 限定独立成词；长度单位走 `profileOf()` |
| 4 | 缓存不校验语种 | 改库把 `day_contents.language` 改成 `en` 后，接口照旧返回英语文章 | `content.ts` 命中缓存先比对 `language`，不符则 `deleteDayContents` 重生成并打日志；`practice.ts` 同时比对 `language` 与 `formatLabel` |

一句话教训：**「切换」是前端/计划层的单点，真正容易散的是「生成」层。每加一个生成点，都要问一句：这门语言在这里走的是哪条分支？**

---

## 5. 缓存语义（切语种 / 换计划后旧内容怎么办）

| 表 | 键 | 语种处理 |
| --- | --- | --- |
| `plan_days` | `plan_id + date` | 计划自带 `language`，天然隔离 |
| `day_contents` | `day_id`（= 计划 × 日期） | `services/content.ts:133 cachedArticles` 守卫：缓存语种 ≠ 计划语种 → 整日内容作废重生成 |
| `practice_prompts` | `day_id + task_id` | **表里没有 language 列**，语种在 `payload` JSON 内（`getPrompt` 解析后比对）；`services/practice.ts:216 promptMatches` 守卫：`payload.language` 或 `formatLabel` 不符 → 重生成 |
| `vocab_items` | `user_id + language + term` | 唯一键带语种，触发器挡非法值 |
| `exam_papers` / `exam_attempts` | 按 `language` 查询 | 列表接口显式 `WHERE language = ?` |
| `ai_bank_items` / `materials` / `listening_materials` | 按 `language` 查询 | 分语种隔离 |

**副作用要知道**：历史上按英文生成的题，会在**下次打开该任务时自动作废重生成一次**。历史日期走内置库不耗 token；当日题若配了模型会消耗一次调用。

### 5.1 「每天各语种各目标只生成一次」是怎么保证的

生成键（`services/content.ts:125 dayContentKey`）：

```
day-content:<planId>:<date>:<language>
```

计划已经包含「语种 + 目标」，所以：

| 用户动作 | 结果 |
| --- | --- |
| 今天第二次进入今日任务 | 命中 `day_contents`（`UNIQUE(day_id, kind)`）→ `source: 'cached'`，不调模型 |
| 改动目标（新建同语种计划） | planId 变 → 键变 → 重新生成一份，旧目标的内容保留 |
| 改动语种（另一个计划） | planId 与 language 都变 → 重新生成，两语种内容并存互不覆盖 |
| 切回之前的目标/语种 | 键回到原来那个 → 直接读缓存 |

**并发只生成一次**靠 `server/src/lib/singleFlight.ts:27 runOnce`：同一个键的并发调用合并成一个 Promise，后来者直接复用结果。没有它时，React StrictMode 的双 effect、用户连点、开两个标签页都会让「先查缓存 → 没有 → 调模型」两段式同时读到空缓存，于是同一天的材料被生成两遍（`INSERT OR REPLACE` 不会留重复行，所以从库里看不出异常，只能从日志的 `day content generation started` 条数发现）。写作口语命题同理，键是 `practice-prompt:<planId>:<date>:<taskId>:<language>:<formatLabel>`（`services/practice.ts:225`）。

日志里搜 `generationKey` 就能确认「这天这个语种到底生成了几次」。

### 5.2 请求语种与激活计划不一致 → 409

前端每个取数请求都带 `?language=<当前计划语种>`；服务端 `server/src/lib/languageGuard.ts:19 assertRequestLanguage` 比对，不一致直接返回 `409 LANGUAGE_MISMATCH`（`details: { requested, active, planId }`）。

拦截的是**切换语种那一刻还在路上的旧请求**：它带的是旧语种，若照常返回，页面就会拿新计划的数据渲染旧语种的界面——「左边英语、右边日语」正是这么来的。前端收到这个码会广播 `app:language-mismatch`，`App.tsx` 监听后 `reload()` 并按新的 `planKey` 重挂载，页面自然重取。

覆盖的接口：`/days/:date`、`/tasks/:date/:taskId`、`/tasks/:date/regenerate`、`/practice/:date/:taskId`（及其 `/grade`）。练习的历史回看是例外：跨计划回看只在那一天当前语种完全没有记录时发生，且一律只读（不重新命题）。

---

## 6. 怎么验

### 6.1 自检脚本（首选）

```bash
PATH=/usr/local/bin:$PATH npm run check:lang   # scripts/checkLanguage.ts：内容是不是本语种
PATH=/usr/local/bin:$PATH npm run check:day    # scripts/checkDayGeneration.ts：生成次数与隔离
```

`check:lang` 遍历 `CATALOG` 里的每门语言，逐项断言（不联网、不碰真实库，自己 `mkdtemp` 隔离 `DATA_DIR`）：

1. `rubricFor` 的 `label + taskType` 落在本语种，且非英语语种不得出现 `0–5 分制 / Band 0–9`；
2. `buildPlan` 产出的今日任务标题是本语种；
3. `buildArticleMessages` 的 system 提示词是本语种；
4. `buildPromptMessages` 的 system/user 是本语种，且 user 里明确要求「用本语种作答」；
5. `buildGradePrompt` 的评分官身份是本语种，且包含 `quote / fix / rewrite 用<本语种>文`。

判定方式是**字符集 + 禁词**：出现韩文/假名/「托福|雅思|TOEFL|IELTS」即判串台。

`check:day` 验证的是「生成次数」（同样 `mkdtemp` 隔离，未配模型走内置库，不花 token）：

1. 6 个并发请求只触发生成 1 次（`singleFlightStats().started === 1`），且只写 2 行；
2. 同日同语种同目标第二次进入返回 `cached`，生成计数不变；
3. 换语种 / 换目标各自生成一份，两边的文章 id 与语种互不覆盖；
4. 把缓存行的 `language` 改成别的语种，会被识别为污染并作废重生成；
5. `assertRequestLanguage` 对不一致语种抛 `LANGUAGE_MISMATCH`，一致或未传时放行。

### 6.2 手工三连测（改了生成链路就跑一遍）

```bash
# 0) 用数据副本起服务，别在真实库上折腾
mkdir -p /tmp/wb-lang-test && cp .data/app.db* /tmp/wb-lang-test/ 2>/dev/null
DATA_DIR=/tmp/wb-lang-test PORT=4411 NODE_ENV=development \
  /usr/local/bin/node ./node_modules/tsx/dist/cli.mjs server/src/index.ts

# 1) 命题：应返回本语种的题型与分制
curl -s "http://127.0.0.1:4411/api/practice/2026-11-24/t5" | python3 -m json.tool | head -40

# 2) 批改：评分官身份、drills、引用语言都该是本语种
curl -s -X POST "http://127.0.0.1:4411/api/practice/2026-11-24/t5/grade" \
  -H 'content-type: application/json' \
  -d '{"text":"<本语种的一段作答>","submissionSource":"typed"}'

# 3) 缓存守卫：把某天文章 language 改成 en，再请求该日，应重生成并写回
sqlite3 /tmp/wb-lang-test/app.db \
  "UPDATE day_contents SET language='en' WHERE day_id='<id>';"
```

第 3 步成功的标志：服务端日志出现 `day content language mismatch, regenerating`，接口返回的 `articles[].language` 恢复为本语种。

### 6.3 类型与单测

```bash
npx tsc --noEmit
npm test        # explainSubtitle 单测
```

**Node 版本坑**：`.node-version` 是 `24.12.0`，本机 `PATH` 默认的 `node` 是 v22，`better-sqlite3` 会报 `NODE_MODULE_VERSION 137 vs 127`。跑任何脚本都加 `PATH=/usr/local/bin:$PATH`；换机器/换大版本后先 `npm rebuild better-sqlite3`。

---

## 7. 已知遗留

1. ~~**`server/src/agent/lang/` 只有 `en` 和 `ja`，没有 `ko`。**~~ **已解决（2026-11-26）**：`lang/ko/` 与 `adapters/ko.ts` 已落地，`/api/agent/scenes` 里 `ko ready=true`，四个场景全部可跑。学习台层的全貌见 `HANDOVER-LANGUAGE-MATRIX.md`，加新语种的操作步骤见 `HANDOVER-NEW-LANGUAGE.md`。**注意两层成本差异**：学习台加一门语言 ≈ 2 个数据文件 + 1 个适配器 + 4 行装配；主项目层是本文 §3 那 30 个文件 + 1 个迁移。
2. **`ui-kit` 是 `file:` 外部包**，`Language` 联合和 `DEFAULT_THEME` 在那边。只改本仓库会出现「前端类型对不上主题包」的怪错。
3. **韩语词库是精选精讲，不是 TOPIK 全量**（`koLexicon.ts` 顶部已注明），各等级标注的是本库收录量。新增语种同样建议先精选，别承诺词表覆盖率。
4. **`web/src/pages/UIKit.tsx:19`** 这类演示页仍写死三种语言，属展示用途，不接业务，优先级最低。
5. **`web/src/pages/Settings.tsx:1370`** 的配色说明是三元链，加语种时只会显示成「英语（默认海湾蓝）」，需手改。

---

## 8. 别踩的坑

- **不要用 `examId` 判断语种。** 历史数据里存在 `plan.language=ko` + `exam_id=toefl` 的组合；语种永远以 `plan.language` 为准，`findExamLanguage()` 只用来发现不一致并 warn。
- **不要给分析型正则加宽松的短词匹配。** 韩语 `/음|어/` 会把「어려움」「생각합니다」算成填充词，白扣分。用前后否定环视限定「独立成词」。
- **加语种不要只改前端下拉。** 下拉是 `catalog.languages` 驱动的（`LanguageSwitch.tsx` 无需改动），真正的门在 `CATALOG`、zod 枚举、数据库约束三处。
- **不要修改历史迁移文件。** 已经跑过的 `003`/`004` 是既成事实，新增 `018_<lang>.sql` 往前推。
- **不要删 `.data/`。** 里面有真实计划、作答与 Key 池；实验一律用 `DATA_DIR` 指向副本。
- **改了 `server/src/**` 必须重启**（`tsx watch` 只在 `npm run dev` 下有效）；改了 `web/**` 生产模式要 `npm run build`。

---

## 9. 一页速查：加一门语言要做什么

```
[ ] 1. 三个 Language 联合 + ui-kit 的 Language（4 处）
[ ] 2. LANGUAGE_NAME / LANGUAGE_PROFILE（中文名、nativeName、textLabel、unit、unitLabel）
[ ] 3. catalog/<code>.ts（LEVELS + EXAMS），注册 CATALOG；补 calendar / sessions
[ ] 4. rubrics：<EXAM>_WRITING / <EXAM>_SPEAKING，注册 BY_LANGUAGE 与 RUBRICS
[ ] 5. 内容：<code>Lexicon / library.<code> / prompts 题库 / data/exams/<code>
[ ] 6. 提示词分支：practice、dayArticle(SYSTEM/LABEL)、grading、planner(taskCopy/ANGLES)、aiGen
[ ] 7. 语音：catalog.speechLang、BCP47、SAMPLE_TEXT、POPULAR_PRESETS、EDGE_VOICES、ASR LANGUAGE_HINT
[ ] 8. 所有 Record<Language,...> 映射（编译器会点名，逐个补）
[ ] 9. 所有 z.enum(['en','ja','ko'])（11 处）与 isLanguage 实现（3 处）
[ ] 10. 迁移：CHECK 表重建 + vocab 触发器重建
[ ] 11. tsc --noEmit → npm run check:lang → 手工三连测
[ ] 12. （可选）agent/lang/<code>/ + 学习台场景支持
```
