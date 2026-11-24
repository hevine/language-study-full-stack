# Lingua Agent · M0 骨架 + Studio 工作台

> 外语学习垂类 Agent 的内核。设计文档在外层工作区 `lingua-agent-design.md`，这里只写**怎么用、怎么扩、怎么拆**。

## 一句话

同进程跑在 `baodian` 里，但所有外部能力都走 Port —— 将来要拆成独立进程，改 `adapters/` 一个文件就够，`core/` 一行不用动。

## 目录

```
server/src/agent/
  types.ts            # 跨边界类型（SyntaxNode IR / ErrorRecord / LearnerProfile …）
  ports.ts            # ★ 10 个 Port：5 语言能力 + 5 基础设施
  protocols.ts        # 四个协议（AgentRun / ToolCall / Artifact / LearnerPatch）+ zod schema
  core/
    router.ts         # ② 意图路由（字符二元组打分，不调模型）
    planner.ts        # ③ 工具 DAG + 预算裁剪
    executor.ts       # ④ 单步执行（超时 + 仅幂等重试）
    verifier.ts       # ⑤ Lingua CI 五关
    index.ts          # 六步回路，产出 AsyncGenerator<AgentEvent>
  tools/
    registry.ts       # defineTool / artifact 助手 / 注册表
    builtin.ts        # 8 个工具（含 explain.video）
  lang/
    loader.ts         # Language Pack 加载（语言差异进数据）
    en/ ja/           # lang.json + errors.json
  scenes/
    loader.ts         # Scene Pack 加载
    writing-exam/     # scene.json + rules.md + evals/
    sentence-parse/   # scene.json + rules.md
    reading-explain/  # scene.json + rules.md + evals/（用上 MediaPort）
  adapters/
    inprocess.ts      # ★ 装配点：拆分时只改这里
    llm.ts            # 复用 services/llm 的号池与 JSON 修复
    storage.ts        # LearnerStore / Trace 的文件实现
    tasks.ts          # TaskPort：产物挂回 plan_days.tasks
    media.ts          # MediaPort：edge-tts 合成 + 讲解作业起/轮询
    en.ts             # 英语分词 / 规则扫描 / 句法 / 等级
  evals/harness.ts    # 离线评测（npm run check:agent）
  routes.ts           # /api/agent/*
```

工作台在前端（不在这个目录里，但和这套协议一对一）：

```
web/src/
  agentTypes.ts                 # 前端持有的协议副本（拆进程后两端分仓，各持声明）
  pages/AgentStudio.tsx         # 三栏工作台：上下文 / 执行过程 / 产物
  components/agent/
    RunTimeline.tsx             # SSE 事件 → 步骤时间轴 + Lingua CI 五关
    ArtifactView.tsx            # 按 artifact.type 分派：diff / syntax / video
    AdoptBar.tsx                # 采纳两步：预览落点 → 确认写入
    labels.ts                   # 工具名与技能名的用户语言映射
```

## 跑起来

```bash
npm run check:agent      # 离线评测，不需要模型 Key，6/6 应通过
npm run typecheck
npm run dev              # 主服务 :4399，Agent 挂在 /api/agent/*
```

> **Node 版本必须是 24**。`better-sqlite3` 的原生模块按 ABI 137 编译，Node 22（ABI 127）会报
> `NODE_MODULE_VERSION 137 vs 127`。仓库根有 `.node-version`；用 `/usr/local/bin/node`（v24）跑，
> 不要 `npm rebuild` —— 那会换掉正在运行实例的 ABI，把服务搞挂。

```bash
curl http://127.0.0.1:4399/api/agent/scenes

# SSE：边跑边推
curl -N -X POST http://127.0.0.1:4399/api/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"lang":"en","mode":"craft","exam":"ielts","query":"帮我改这篇作文","text":"..."}'

# 同步：方便脚本断言
curl -s -X POST http://127.0.0.1:4399/api/agent/run/sync \
  -H 'Content-Type: application/json' -d '{...}' | jq '.run.verify'
```

事件类型：`start` / `step` / `artifact` / `verify` / `done` / `clarify` / `error`。

### 采纳（闭环的计量点）

```bash
# 先预览会写什么，不落盘
curl -s -X POST :4399/api/agent/adopt -H 'Content-Type: application/json' \
  -d '{"runId":"run_xxx","artifactId":"art_annotated-diff_1","confirm":false}'

# 确认：挂进今日任务 + 错因进复诊队列
curl -s -X POST :4399/api/agent/adopt -H 'Content-Type: application/json' \
  -d '{"runId":"run_xxx","artifactId":"art_annotated-diff_1","confirm":true}'
```

`closedLoop=true` 才计一次「有效学习闭环」。**刻意不做自动挂载**：自动挂载等于
每跑一次就算学一次，北极星指标立刻失去意义。

预览（`confirm:false`）走的是 `TaskPort` 的 `dryRun`：落点算得出来，但一个字都不写。
所以确认前用户看得到「会挂到哪条任务、记哪几笔错因」，而不是只能选择信或不信。

### Studio 工作台

`/#/studio`（侧栏「AI 学习台」）。三栏同屏，各自滚动：

| 栏 | 内容 | 为什么这么设计 |
| --- | --- | --- |
| 左 | 场景 / 输入 / 帮助档位 / 历史 run | 上下文是你唯一能控制的东西，得摆在最前 |
| 中 | 步骤时间轴 + Lingua CI 五关 + 上下文摘要 | 一次安静 80 秒的等待会被当成卡死；也让「凭什么可信」有据可查 |
| 右 | 产物渲染 + 采纳条 | 产物由你决定要不要采纳，界面不替你做决定 |

`/#/studio?run=<id>` 是深链，可直接回放某次执行（把一次批改发给别人看）。
每次 run 结束都会把 URL 换成这条 deep link。

### 媒体

```bash
# 任意句子朗读（本地 edge-tts，按 音色|语速|文本 落盘缓存）
curl -s -X POST :4399/api/agent/media/tts -H 'Content-Type: application/json' \
  -d '{"text":"The only way out is through.","lang":"en","rate":0.9}'

# 讲解作业进度（artifact.data.pollUrl 就是它）
curl -s :4399/api/agent/media/explain/<jobId>
```

## 加一个场景（不改 core/）

1. 建 `scenes/<id>/scene.json`：`category` 必须是九垂类之一，`tools` 按顺序声明；
2. 写 `rules.md`（场景守则，用户可在 `~/.lingua/rules/` 覆盖）；
3. 放 `evals/*.jsonl` 金标（**没有金标不许上线**）；
4. `POST /api/agent/reload` 热加载。

## 加一门语言（不修改 core/）

1. 建 `lang/<code>/lang.json` + `errors.json`；
2. 在 `adapters/` 实现 5 个 Port（`tokenizer` / `syntax` / `taxonomy` / `phonology` / `level`）；
3. 在 `adapters/inprocess.ts` 的 `deps.language()` 里挂上。

**验收线：`git diff --stat core/` 必须为空。** 不为空说明 Port 抽象没做对，回头补，别绕过。

日语（M2）前置条件：kuromoji 形态素分析、助词/活用/敬语规则集、`syntax: chunk` 的 IR 填充、JLPT 不考写作（已写在 `lang/ja/lang.json` 的 `unsupported`）。

## 关键实现约定（改代码前先读）

| 约定 | 原因 |
| --- | --- |
| 工具拿参数走黑板 `ctx.bag[toolName]` | M0 简化；M1 换显式参数槽，不要在外层加隐藏依赖 |
| `profile.patch` 默认 `confirm=false` | 档案写错会污染后续所有推理，必须人工确认 |
| 三振升级（`PROMOTE_AT=3`） | 一次误判不该变成"长期错因" |
| 错因按 `lang` 物理隔离 | 英语错因不许喂给日语（主项目 DB 也是这么锁的） |
| `phonology.score()` 无能力就返回 `null` | 宁缺毋假：不编发音分数 |
| 路由器不用大模型分类 | 太贵、不可复现，评测做不了 |
| 意图置信度 < 0.16 就反问 | 猜错要跑一整套工具，代价几万 token |
| 模型侧 schema 故意宽松、进内核前归一 | 严格契约卡模型只会得到「JSON 无法解析」，用户看到的是产品坏了 |
| `SyntaxNode.id` 由 `assignIds` 生成 | 模型生成的 id 会重号，前端拿它当 React key，冲突就整棵树重渲染 |
| 讲解视频只起作业、不等完成 | 一条片要几分钟，同步等会把 SSE 拖成假死，断线还要重跑整条流水线 |
| 内核超时 ≥ `env.llm.timeoutMs × 2` | 号池一条线 90s 超时后还会换下一条，超时给少了等于替 LLM 层做决定 |
| 批改模型失败要降级成「规则通道 + note」 | 规则引擎已经确定性命中了几处，没理由让用户一条都看不到；但降级不写 `note` 就是拿半份结论骗人 |
| 空产物时 G1 判 `fail`，不判 `pass` | 「0 个产物结构合法」是最容易骗过自己的绿灯：运行明明失败了，界面却显示校验通过 |

## M0.5 已知缺口（按优先级）

1. **池里全是思考型模型，交互步很慢**：`混元4` 会把 max_tokens 全花在 reasoning 上（日志 `返回内容为空（思考占满 max_tokens）`），`混元3` 单次 90s 超时。实测一次长难句拆解 46–79s，跨线路故障切换时更久。
   **建议给 Agent 单独配一条非思考模型线路**（如 `gpt-4o-mini` / `glm-4-flash` 之类），交互场景不该用思考型模型。
2. **档案存储是 JSONL**：`LearnerStorePort` 已定型，换 SQLite（DDL 见下），调用方零改动。
3. **规则扫描是 M0 占位**：7 条高精度模式，召回很低。实测一篇满是 `many student choose` / `I am disagree` / `think careful` 的作文，规则命中 **0**，模型又只回了空结构 —— 于是「4 条批改」变成「0 条」。M1 换 `services/grading.ts` 的 14 类引擎。
   这是当前**质量上最该先修的**：召回低会让界面看起来「没发现问题」，比报错更能骗人。
4. **G4 回译校验跳过**：`trans.backtranslate` 未接，verifier 如实标 `skip` 并写进 `review`。
5. **等级估算是代理值**：`en.ts` 里按句长与词长估 CEFR，M1 接真实词表覆盖。
6. **讲解视频的播放器已接，分镜渲染仍归主项目**：Studio 里作业完成后用 `explain-video/react` 播放，但成品页的更完整交互（切档、双语讲师、导出）仍在精读页。
7. **日语只有语言包，没有能力实现**：`deps.language('ja')` 返回 `null`，虽然 `/scenes` 里 `ready:false` 会如实标出来。

### M0.5 建表 DDL（换 SQLite 时用）

```sql
CREATE TABLE IF NOT EXISTS agent_error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  op TEXT NOT NULL,              -- inc | promote | resolve
  evidence TEXT NOT NULL DEFAULT '',
  quote TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_err_user ON agent_error_events(user_id, lang, rule_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scene TEXT NOT NULL,
  lang TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_profile_patches (
  patch_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  payload TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

## 拆分手册（触发条件达成时照着做）

触发条件（任一）：Agent 拖累主站 P95 超 300ms / run P95 超 8s 且并发 > 5 / 需要独立灰度 / 需要异构运行时（GPU 音素对齐）。

1. 新建进程，把 `adapters/inprocess.ts` 抄一份改成 `adapters/http.ts`，四个实现换成 fetch；
2. `deps.language()` 改成按 code 拿到远端能力描述（或本进程内实现）；
3. 反代把 `/api/agent/*` 整体转发到新进程；
4. **`core/`、`tools/`、`scenes/`、`lang/` 不动。** 动了就是抽象漏了。

前置检查：`run` 状态是否都落在 `data/agent/runs/`（不是进程内 Map）✓；长任务是否都已 job 化（讲解视频/TTS 走现有 job 范式）。
