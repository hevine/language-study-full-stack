# 精读材料 · 解题答疑视频 · 交接文档

> 交接对象：接手「精读材料右侧 · 解题答疑视频」的新任务
> 交接时间：2026-11-21
> 项目：外语考证宝典
> 关联文档：`HANDOVER.md`（整体架构）· `HANDOVER-PLAYER.md`（播放器 / 媒体 SDK）

---

## 0. 开工前置（三条，缺一条会卡住）

### 0.1 项目位置与 Node 版本

```
/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
```

当前 PATH 默认 `node` 是 v22，而 `better-sqlite3` 按 Node 24 编译，**必须**：

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
PATH=/usr/local/bin:$PATH npm run dev
```

否则报 `NODE_MODULE_VERSION 137 / 127`。

### 0.2 ffmpeg 未安装（很重要）

```
$ which ffmpeg ffprobe
ffmpeg not found
ffprobe not found
```

这决定了视频方案的分叉：**如果只要页面内可播放的讲解视频，不需要 ffmpeg**（见第 6 节）；
**如果要导出可下载的 mp4，才需要** `brew install ffmpeg`。

### 0.3 配音环境已就绪

```
.voice-venv/bin/python  → edge-tts 7.3.1
```

实测可用（联网调微软接口）。当前脚本 `scripts/edge_tts_synth.py` 只输出 mp3 二进制，
但它依赖的 `edge_tts.Communicate.stream()` **同时返回句级时间戳**，见 6.2 —— 这是本方案的支点。

---

## 1. 当前项目速览

### 1.1 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18.3 + Vite 5 + HashRouter，无 UI 库、无状态库 |
| 后端 | Express 4.19 + tsx，三层结构（routes → services → repositories） |
| 数据 | better-sqlite3 单文件 `.data/app.db`，15 个迁移 |
| AI | 自建 OpenAI 兼容调用（`services/llm.ts`）+ 多线路池（`keyPool.ts`） |
| 语音 | 系统 Web Speech + 本地 Edge Neural（Python 子进程）+ 在线 TTS |
| 媒体 | 自研播放器 SDK `@waiyubaodian/hevc-player`（H.265 WASM 软解 + 音频） |

规模：约 5.4 万行（`styles.css` 单文件占 9287 行）。
数据：843 道试卷题 / 82 套卷 / 23 篇 AI 生成精读 / 22 条音色。

### 1.2 目录要点（与本次任务相关）

```
server/src
  services/dayArticle.ts      精读文章生成（LLM + 内置库兜底 + 分段）
  services/content.ts         ensureDayContent：生成后写 day_contents，带缓存
  services/tasks.ts           buildTaskDetail：把文章组装成前端 payload
  services/llm.ts             chat / chatJson（含截断修复、超大预算重试）
  services/keyPool.ts         多线路池：冷却、退避、轮换
  services/edgeTts.ts         spawn Python 合成 mp3，内存 LRU 60 条
  services/examImport.ts      长任务 job 模式范本（POST 创建 → GET 轮询）
  routes/tasks.ts             /days/:date/tasks/:taskId
  routes/examImports.ts       job 轮询接口范本
  repositories/content.ts     day_contents 读写

web/src
  pages/TaskPage.tsx          detail.kind === 'reading' 分支（本任务落点）
  components/ArticleView.tsx  正文渲染 + 词高亮 + 译文
  components/ReadingPlayer.tsx 文字朗读 / 真人媒体 双 tab
  components/Quiz.tsx         理解检测（题目 + 选项 + 解析）
  components/AiEnrichPanel.tsx AI 加练折叠面板（交互范式可抄）
  components/ui.tsx           SectionCard / Banner
  player/MediaPane.tsx        媒体播放面板（SDK 封装）
  player/mediaCoordinator.ts  全局播放权协调（单例）

scripts/edge_tts_synth.py     配音脚本（43 行）
```

---

## 2. 精读材料全链路（本任务主线）

### 2.1 数据从哪来

```
planner 生成 plan_days（排期）
   ↓  当天第一次打开任务
content.ts: ensureDayContent(plan, day)
   ├─ 查 day_contents 有则直接用（source='cached'）
   ├─ 否则调 dayArticle.generateArticle()  ← LLM 生成 + 内置库补齐
   └─ 写 day_contents 一行（UNIQUE(day_id, kind)）
   ↓
tasks.ts: buildTaskDetail → detail = { kind:'reading', payload:{ article, secondary, notice } }
   ↓
GET /api/days/:date/tasks/:taskId
```

`Article` 的关键字段（`web/src/types.ts:94-106`、`server/src/domain/types.ts:42`）：

```ts
{
  id: string;                 // = day_contents.id，本篇的稳定标识
  kind: 'intensive' | 'extensive';
  title, body, translation;
  vocab: VocabEntry[];        // 平均 9 个
  questions: Question[];      // 平均 3.1 道（少的时候 1-2 道）
  readingScript: { segments: ReadingSegment[] };   // 只含 text/translation/tips
  estMinutes, source: 'llm' | 'library', model
}

Question = { prompt, options: string[], answer: number, explain?: string }
```

**`article.id` 是视频缓存的正确绑定键**：点「换一篇」会重跑 `regenerateDay` → 生成新的 `day_contents` 行 → id 变化 → 旧视频自然失效。

### 2.2 前端渲染链（入口就挂在这条链上）

`web/src/pages/TaskPage.tsx:299-360`：

```tsx
{detail.kind === 'reading' ? (
  <div className="stack">
    <SectionCard title="精读材料" extra={模式提示 + 换一篇按钮}>
      {notice}
      {ArticleView}                          ← 正文 + 词高亮 + 译文
      <hr />
      {ReadingPlayer}                        ← 文字朗读 / 真人媒体
    </SectionCard>

    <SectionCard title="理解检测">            ← 题目在这张卡里
      <Quiz questions={article.questions} />
    </SectionCard>

    {secondary ? <SectionCard title="泛读对照">…</SectionCard> : null}
  </div>
) : null}
```

### 2.3 「右侧」到底挂在哪

现状是**单列** `stack`，没有右侧栏。三个可选落点：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 卡片内两栏**（推荐） | `.reading-split { grid: minmax(0,1fr) 320px }`，左栏放现有 ArticleView + ReadingPlayer，右栏放视频面板 | 视觉上就是「精读材料右侧」；与正文同屏对照 | 需改 TaskPage 的 reading 分支结构；窄屏要塌成单列 |
| B. 第三个 tab | 在 ReadingPlayer 的「文字朗读 / 真人媒体」后加「解题答疑」 | 改动最小 | 用户切走后看不到正文，与「讲解要对照原文」矛盾 |
| C. 悬浮抽屉 | 右侧固定浮球，点开抽屉 | 不占正文宽度 | 遮挡内容；移动端体验差 |

**推荐 A**，理由：解题答疑必须能对照原文（讲"第 2 段第 3 句"时要看到那句话），
侧栏常驻比 tab 切换更符合使用场景；断点 ≥1180px 生效，以下堆叠到正文下方。

右栏内容（未生成态）：

```
┌─────────────────────────────┐
│ 解题答疑 · 视频讲解          │
│ 3 道题 · 约 2 分 30 秒       │
│ 用「七海」讲解，可暂停跟读    │
│ [ ▶ 生成讲解视频 ]           │
│ 约 3k tokens · 约 30 秒      │
└─────────────────────────────┘
```

---

## 3. 产品定义：这个视频到底讲什么

### 3.1 用户看到的形态

点「生成讲解视频」→ 右栏就地变成播放器：

- 画面：**当前分镜的题目 / 原文段落 / 选项**，讲到哪高亮到哪
- 声音：讲解旁白（TTS）
- 字幕：当前句字幕，跟随旁白
- 控制：播放 / 暂停 / 上一镜 / 下一镜 / 倍速 / 点分镜跳转

**关键**：这不是 mp4，是「音频时间轴 + 结构化分镜」驱动的网页播放器（原因见第 6 节）。

### 3.2 分镜脚本结构

一篇文章 N 道题，分镜按「一题一组」：

```
cover       片头：本篇标题 + 主题 + 共几题
  ↓（每题循环）
question    题干 + 四个选项（读出题干）
passage     定位原文：高亮解题依据的那一句/几句
eliminate   逐项排除：每个错误选项一句理由
answer      正确答案 + 为什么对
  ↓
takeaway    本题考点 / 做题技巧（一句可记忆的话）
```

### 3.3 输入数据够不够

| 视频需要 | 现有数据 | 结论 |
|---|---|---|
| 题干、选项 | `question.prompt` / `options` | ✅ 直接可用 |
| 正确答案 | `question.answer`（索引） | ✅ 权威，**模型不得改写** |
| 现有解析 | `question.explain` | ✅ 可作为讲解底稿，但偏书面，需口语化 |
| 解题依据原文 | `article.body` 段落 | ✅ 但需模型指出「第几段第几句」，必须校验 |
| 译文 | `article.translation` | ✅ 用于中文对照 |
| 重点词 | `article.vocab` | ✅ 可选穿插 |
| 逐句时间轴 | `readingScript.segments` | ⚠️ 只有文本，**无时间戳** —— 需新合成时拿（6.2） |

**缺口只有一个：时间轴**，而它正好可由 edge-tts 的 SentenceBoundary 补上。

---

## 4. 独立 SDK 设计（重点）

### 4.1 先例：`@waiyubaodian/hevc-player` 是怎么接进来的

这是项目里已经跑通的「独立 SDK + 主项目引用」范式，新 SDK 照抄即可：

```json
// package.json
"@waiyubaodian/hevc-player": "file:../../2026-11-20-22-40-00/hevc-player-sdk"
```

```
node_modules/@waiyubaodian/hevc-player -> ../../../../2026-11-20-22-40-00/hevc-player-sdk
```

SDK 自身（`/Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk`）：

- `package.json` 有 `main / module / types / exports` 四件套，`./react` 子路径导出 React 封装
- `peerDependencies: react >=17`，不自带 React
- `sideEffects: false`，`files: ["dist", "README.md"]`
- `scripts`：`dev`（demo）/ `build`（tsc + vite）/ `typecheck` / `test`（vitest）
- 宿主侧用 `lazy(() => import('@waiyubaodian/hevc-player/react'))` 按需加载（WASM 体积大）

**结论：新 SDK 用同样形态，放在 `~/WorkBuddy/<新工作区>/explain-video-sdk`，用 `file:` 依赖接入。**

### 4.2 SDK 边界（明确划清，这决定后面所有设计）

| 职责 | 归属 | 理由 |
|---|---|---|
| 时间轴协议（types） | **SDK** | 契约核心，必须独立可复用 |
| 播放内核（音频 + 分镜渲染 + 字幕） | **SDK** | 与业务无关，任何「讲解视频」都能用 |
| 分镜组件（题目/原文/选项高亮） | **SDK** | 提供无语义的原子组件，业务传数据 |
| 脚本生成（LLM prompt） | 主项目后端 | 要复用 `llm.ts` / `keyPool.ts` / 鉴权 / 成本统计 |
| 配音合成 | 主项目后端 | 要复用 `edgeTts.ts` 与 `.voice-venv` |
| 存储与缓存 | 主项目后端 | `.data/` 统一管理，按用户隔离 |
| API Key | 主项目后端 | 铁律：Key 永不出后端 |

**为什么不做成独立服务进程**：`services/edgeTts.ts` 开头的注释已经写明项目的取舍 ——
「多一个常驻进程/端口就多一处会忘掉启动的地方」。SDK 的「独立」指**代码与发布独立**，
不是**进程独立**。若将来要对外提供服务，再在 SDK 仓库里加一层 thin server，不影响现在。

### 4.3 建议目录

```
explain-video-sdk/
  package.json           name: @waiyu/explain-video, version 0.1.0
  src/
    index.ts             类型 + 纯函数（时间轴计算、校验）
    types.ts             ExplainVideo / Shot / Cue / Timeline
    player/
      ExplainVideoPlayer.tsx   主组件（音频 + 分镜 + 字幕 + 控制条）
      useTimeline.ts           时间轴驱动（requestAnimationFrame + audio.currentTime）
      Coordinator.ts           与宿主播放器互斥（复用 mediaCoordinator 的思路）
    shots/
      CoverShot.tsx
      QuestionShot.tsx
      PassageShot.tsx    原文 + 高亮范围
      EliminateShot.tsx  选项逐个划掉
      AnswerShot.tsx
      TakeawayShot.tsx
    react.ts             导出 React 层（对应 /react 子路径）
    styles.css           自带样式，用 CSS 变量暴露主题
  demo/                  独立 demo 页（不依赖主项目）
  tests/                 vitest：时间轴、cue 查找、越界
```

### 4.4 对外 API（定契约，先写 types 再写实现）

```ts
// types.ts
export type ShotKind = 'cover' | 'question' | 'passage' | 'eliminate' | 'answer' | 'takeaway';

export interface Cue {
  text: string;        // 这一句旁白的字幕
  startMs: number;     // 相对整片
  endMs: number;
  shotIndex: number;   // 属于哪个分镜
}

export interface Shot {
  kind: ShotKind;
  narration: string;        // 该分镜旁白全文（TTS 输入）
  caption: string;          // 屏幕字幕（可与旁白不同，更短）
  questionNo?: number;
  highlight?: {
    paragraph?: number;     // 原文第几段（0 基）
    sentence?: string;      // 要高亮的原句（用于精确匹配）
    options?: number[];     // 高亮哪些选项
    picked?: number;        // 划掉的选项
  };
  audio: {                  // 由后端填入
    url: string;            // /api/explain-videos/:id/seg/:n
    durationMs: number;     // 来自 edge-tts boundary
  };
}

export interface ExplainVideo {
  id: string;
  articleId: string;
  language: 'en' | 'ja' | 'ko';
  voice: string;
  title: string;
  totalMs: number;
  shots: Shot[];
  cues: Cue[];
  createdAt: string;
}
```

组件签名：

```tsx
<ExplainVideoPlayer
  video={video}
  theme={{ accent: '#4f7cff', font: 'var(--serif)' }}
  onShotChange={(i) => {}}
  onEnded={() => {}}
  onPlay={() => claimMediaPlayback('explain')}   // 与 TTS/媒体互斥
/>
```

**能力约束**：SDK 只接受「已切好的 shot + 已合好的音频 URL」，不做任何网络请求、
不读 localStorage、不依赖宿主 store —— 这样才能在 demo 里独立跑起来。

---

## 5. 主项目集成点（三处改动）

### 5.1 依赖

```json
"@waiyu/explain-video": "file:../../<新工作区>/explain-video-sdk"
```

### 5.2 前端：右栏面板

新建 `web/src/components/ExplainVideoPanel.tsx`，交互照抄 `AiEnrichPanel` 的
`idle → loading → ready → error` 四态（含 token 预估、错误文案、重试）。

```tsx
const ExplainVideo = lazy(() => import('@waiyu/explain-video/react'));
```

`TaskPage.tsx` 的 reading 分支改成两栏：

```tsx
<div className="reading-split">
  <div>…现有 ArticleView + ReadingPlayer…</div>
  <aside className="reading-side">
    <ExplainVideoPanel articleId={article.id} questions={article.questions} />
  </aside>
</div>
```

配套样式（`styles.css` 末尾追加）：

```css
.reading-split { display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1180px) {
  .reading-split { grid-template-columns: minmax(0, 1fr) 320px; align-items: start; }
  .reading-side { position: sticky; top: 16px; }
}
```

### 5.3 后端：接口（照搬 exam-imports 的 job 模式）

```
POST /api/explain-videos                  { articleId, force?, depth?, coach? } → { job }
GET  /api/explain-videos/jobs/:id         → { stage, progress, videoId?, error? }
GET  /api/explain-videos/resolve          ?articleId=&depth=&coach=  → 缓存预检
GET  /api/explain-videos/estimate         ?articleId=               → 三档预估 + nativeCost
GET  /api/explain-videos?articleId=...    → { videos: ExplainVideoSummary[] }
GET  /api/explain-videos/:id              → ExplainVideo（完整 shots + cues）
PUT  /api/explain-videos/:id/transcript   → 保存逐字稿（只改文本，共享片走 copy-on-write）
POST /api/explain-videos/:id/coach        → 补中文讲师轨（不重跑脚本）
POST /api/explain-videos/:id/revoice      { voice? } → 换音色重配（只跑 TTS，0 token，见 15.1）
GET  /api/explain-videos/:id/seg/:n       ?track=zh → audio/mpeg（Authorization 头鉴权）
POST /api/explain-videos/:id/export       { track? } → { url, track }（见 15.2）
GET  /api/explain-videos/:id/export/file  ?track=    → video/mp4 流
DELETE /api/explain-videos/:id
```

`stage`：`script`（LLM 生成分镜）→ `speech`（逐段配音）→ `assemble`（算时间轴）→ `done`；
另有两条支线任务：`coach`（补中文轨）、`revoice`（换音色），同样用 job 轮询。
前端 1 秒轮询，与 `exam-imports` 完全一致，不引入 SSE/WebSocket。

---

## 6. 技术方案：视频怎么来

### 6.1 三条路线

| 路线 | 做法 | 依赖 | 生成耗时 | 可交互 | 建议 |
|---|---|---|---|---|---|
| **A. 音频驱动伪视频** | mp3 + 结构化分镜，前端按时间轴渲染 | 无（已有 edge-tts） | 20-40s | ✅ 可跳镜、可暂停、可对照原文 | **MVP 走这条** |
| B. 服务端 ffmpeg 合成 mp4 | 幻灯片 + 音轨 → 真视频 | 需 `brew install ffmpeg` | 40-90s | ❌ 只能整体播放 | M3 作为「导出/分享」 |
| C. 前端 canvas + MediaRecorder | 边播边录 | 无 | = 视频时长（实时录制） | ❌ | 不采用 |
| D. 大模型直接生视频 | Sora 类 | 外部 API | 分钟级 | ❌ | 不采用：题目文字会糊、成本不可控、答案不可控 |

**为什么 A 是正解**：题目、选项、原文必须**逐字精确**，生成式视频做不到；
而「PPT 式讲解 + 旁白 + 字幕」恰好是这个场景的真实形态，结构化数据还能让用户点选项看解析。

### 6.2 时间轴：不需要 ffprobe（实测验证）

`edge_tts.Communicate.stream()` 在输出音频的同时输出边界事件。实测：

```python
c = edge_tts.Communicate("Reading is a habit.", "en-US-AvaNeural", rate="-10%")
async for chunk in c.stream():
    # chunk['type'] == 'audio'        → mp3 分片
    # chunk['type'] == 'SentenceBoundary'
    #   { 'offset': 1000000, 'duration': 16805556, 'text': 'Reading is a habit.' }
```

- `offset` / `duration` 单位是 **100ns**，除以 10000 得毫秒
- 句子实际时长 1.68s，与音频严格同源，**不会漂移**
- 需要词级时把 boundary 设为 `WordBoundary`（7.3.1 支持）

**结论**：每个分镜合成一次 → 得到 `{mp3, durationMs}` → 累加即得分镜起点 →
再用 `durationMs` 与字幕字数做句内均分（或直接用每句的 SentenceBoundary 做 cue）。

### 6.3 配音脚本升级（向后兼容）

现有 `scripts/edge_tts_synth.py` 只写 stdout 二进制，不能改坏（`edgeTts.ts` 依赖它）。
新增一个脚本 `scripts/edge_tts_timeline.py`：

- 入参：`{ voice, rate, input }`
- 出参（stdout 一行 JSON）：`{ "audioBase64": "...", "boundaries": [{ "text", "offsetMs", "durationMs" }], "durationMs" }`
- 或分两个文件写盘（大音频 base64 会膨胀 33%，超过 1MB 建议直接落临时文件由 Node 移动）

`edgeTts.ts` 里加一个平行函数 `synthesizeWithTimeline()`，**不动** `synthesizeLocalEdge()`。

### 6.4 生成流水线

```
① 脚本（1 次 LLM 调用）
   chatJson(config, buildExplainMessages(article), ExplainScriptSchema)
   ├─ 输入：标题 / 全文 / 译文 / 全部题目（含答案与现有解析）
   ├─ 输出：shots[]（每镜 narration + caption + highlight）
   └─ 强约束：answer 索引由代码回填，模型只写"为什么"，不许写"选 X"

② 逐镜配音（N 次，N≈6-10）
   for shot of shots: synthesizeWithTimeline(shot.narration)
   ├─ 并发 2，失败重试 1 次
   └─ 单镜失败 → 该镜降级为"静音 + 字幕停留 3s"，不整片失败

③ 组装
   累加 durationMs → shots[i].audio.startMs + cues[]
   写 manifest.json + seg-0.mp3 … seg-N.mp3

④ 校验（代码，不信模型）
   ├─ 每道 question 都有 answer 镜
   ├─ answer 镜的 highlight.picked == question.answer
   ├─ passage 镜引用的原句必须能在 body 里精确找到（否则降级为段号）
   └─ 总时长 30s ~ 8min 之间，超界则砍 takeaway
```

### 6.5 Prompt 要点

写 `buildExplainMessages()` 时守住四条：

1. **给它答案，让它解释**：把 `question.answer` 和正确选项文本直接喂进去，避免模型猜错
2. **要求引用原文**：每个 passage 镜必须给「第几段 + 原句」，并附 `evidence` 字段便于代码校验
3. **口语化**：旁白是 TTS 输入，禁止 markdown、括号注释、表情符号；单句 ≤ 40 字
4. **控制时长**：每题 4 镜 × 平均 15 秒 ≈ 1 分钟；3 题约 3 分钟，超出要提示

### 6.6 存储与缓存

```
.data/explain-video/<articleId>/<hash>/
    manifest.json        ExplainVideo（含 shots + cues）
    seg-0.mp3 …
```

- `hash = sha1(articleId | voice | rate | scriptVersion | 题目文本)`
- 命中则直接返回，**不重新生成**（LLM 一次约 3k tokens，别浪费）
- 上限：按用户 500MB，LRU 清理；`resetEdgeTtsStatus()` 已有清缓存先例可参考
- 视频音频文件走鉴权 Blob（照 `routes/listening.ts` 的 `/file` 做法：`<audio>` 无法自带 Authorization 头，前端 fetch 成 Blob）

---

## 7. 分阶段实施

### M1：骨架打通（可演示）

- [ ] SDK 仓库初始化（照抄 hevc-player 的 package.json / tsconfig / vite 配置）
- [ ] `types.ts` 定稿 + `computeTimeline()` + 单测
- [ ] `ExplainVideoPlayer` 最小版：一个 mp3 + 一份手写 JSON 能播、能高亮字幕
- [ ] demo 页跑通（不依赖主项目）
- **验收**：`npm run dev` 起 demo，手写一份 3 镜 JSON，播放时字幕与画面同步

### M2：生成链路（真实可用）

- [ ] `edge_tts_timeline.py` + `synthesizeWithTimeline()`
- [ ] `buildExplainMessages()` + `ExplainScriptSchema` + 代码侧校验
- [ ] `/api/explain-videos` job 三件套 + `.data` 落盘
- [ ] `ExplainVideoPanel` 接入 TaskPage 右栏（含四态）
- **验收**：真文章点生成 → 40 秒内出片 → 3 道题的答案与库内 `answer` 完全一致

### M3：打磨与导出

- [ ] 分镜动画（选项划掉、原文划线、进度点）
- [ ] 播放器互斥（接 `mediaCoordinator`，避免与朗读同时出声）
- [ ] 可选：`brew install ffmpeg` + 导出 mp4（分享用）
- [ ] 成本面板：每次生成 token 与耗时，写进 `ai_gen_runs` 统计

---

## 8. 硬约束（不可破）

1. **答案权威**：`question.answer` 是唯一事实，模型输出只能是解释；代码必须覆盖校验
2. **Key 不出后端**：前端只调主项目接口，TTS/LLM 都在服务端
3. **不编造原文**：passage 引用的原句必须能在 `body` 中匹配到，匹配失败降级为段号
4. **不在请求处理器里跑长任务**：必须 job 模式（现有 `exam-imports` 就是范本）
5. **零重型依赖**：SDK 只允许 `react` 作为 peer，不引动画库/状态库/视频库
6. **复用音色**：用 `voice_assignments` 的 `article` 场景音色，不新开一套设置
7. **播放互斥**：新播放器出声前必须 `claimMediaPlayback`，否则会和 TTS 串台（`HANDOVER-PLAYER.md` P0-1 的老坑）
8. **`.data/` 不入库**：视频产物与缓存都放这里

---

## 9. 验收清单

```bash
PATH=/usr/local/bin:$PATH npm run typecheck
PATH=/usr/local/bin:$PATH npm run build
```

- [ ] 右栏在 ≥1180px 是侧栏，<1180px 堆叠到正文下方，不遮挡
- [ ] 未生成时显示题数、预计时长、token 预估
- [ ] 生成中能看到 stage 变化（脚本 → 配音 → 组装），可取消
- [ ] 播放时字幕与旁白对齐（误差 < 300ms）
- [ ] 点「下一镜」跳到下一题，正文对应段落高亮
- [ ] 每题讲解里的正确答案 === `questions[i].answer`
- [ ] 生成失败（断网 / 403 / 超时）有中文提示与重试，不白屏
- [ ] 与朗读同时点，只有一路出声
- [ ] 换一篇后旧视频不再出现（id 变了）
- [ ] 同一篇二次打开，命中缓存，秒开不重复扣 token

---

## 10. 待你确认的三个决策

1. **讲解语言**：日语/韩语文章，旁白用**中文**讲还是**目标语**讲？
   （JLPT 阅读建议中文讲更易懂；但若要做「日语沉浸式」，就用目标语 + 中文字幕。影响 prompt 与音色选择。）
2. **要不要真 mp4**：只要页面内可播放（不装 ffmpeg），还是要能下载/分享（需装 ffmpeg）？
3. **入口范围**：只挂精读（`kind==='reading'`），还是也挂「理解检测」卡片（题目在下面那张卡里）？

未定的部分我按默认假设写在了文档里：**中文讲解 + 页面内播放 + 只挂精读右栏**。

---

## 11. 给新任务的第一句话

> 先读第 2 节搞清精读数据从哪来，再读第 4 节定 SDK 边界（只做播放与协议，生成留在主项目）。
> 动手顺序：`types.ts` → demo 播放器 → `edge_tts_timeline.py` → job 接口 → 右栏面板。
> 起服务务必 `PATH=/usr/local/bin:$PATH npm run dev`；ffmpeg 没装，MVP 不要依赖它。

---

## 12. 大模型输出容错（2026-11-22 补充，必读）

### 12.1 为什么加

线上出现过「讲解脚本生成失败：大模型返回的 JSON 无法解析」。根因不是模型不会写 JSON，
而是它经常**写得不够干净**：前置一段分析、包 ```json 围栏、用中文标点当结构符、写注释、
字段名换拼法、甚至被 `max_tokens` 从中间截断。原先的链路是「严格 zod 不过 → 让模型重写一次
→ 还不过就整份作废」，代价是一整次重新生成（时间 + token），而且用户只看到一句「无法解析」。

### 12.2 现在的分层抢救（`server/src/services/explainScriptSalvage.ts`）

| 层 | 做的事 | 命中后 |
| --- | --- | --- |
| ① 严格 | `JSON.parse` | 直接用 |
| ② 通用修复 | `lib/jsonRepair.ts`：围栏 / 客套话 / 尾逗号 / 中文引号 / 注释 / 全角标点 / 裸换行 / 截断补全 | 直接用，`meta.localRepaired=true` |
| ③ 逐对象抓取 | 扫出每个括号配平的 `{...}` 单独解析，**半截对象自然跳过** | 保留已写完的分镜 |
| ④ 逐字段净化 | kind 中英别名归一化 + 缺字段互推；`"questionNo":"2"`→2；`"B"`→1；越界题号按 0 基纠正 | 单镜过 `ShotDraftSchema` |
| ⑤ 题库补镜 | `explainShots.ts` 的 `ensureCoverage`：缺 question 镜用题库补、缺 answer 镜按权威答案补 | 视频一定完整且答案正确 |

关键设计：

- **本地能救就不再调模型**。抢救器捞回 ≥ `min(2, 题数+1, 6)` 个镜就直接返回，
  省掉一次 6000 token 的重新生成；捞得太少才让模型重写（这种残缺脚本配不上几分钟的配音）。
- **两次调用都失败时的最后一道**：`chatJson` 会把最后一次原文挂在异常的 `rawOutput` 上，
  `explainScript` 拿它再抢救一次——只要还剩一镜，就按可用部分出片。
- **答案永远以题库为准**：补镜与答镜都会强制写 `picked = question.answer`，
  截断只影响「讲多少」，不影响「答案对不对」。

### 12.3 质量留痕（不要静默降级）

`ExplainVideo.meta.quality = { salvage, truncated, autoFilledShots }`：

- 生成中：job detail 会显示「模型输出不完整，已按可用部分生成（题库补齐 N 镜）」；
- 生成后：面板顶部出现琥珀色提示条（`.ev-quality-note`），说明哪些镜是补的；
- 日志：`explain script parse attempt` / `explain script rescued from failed parse` 带 `stage` 字段，
  一眼看出这次是 `repair:truncated:close` 还是 `scrape`，方便判断要不要调 prompt。

### 12.4 自检

```bash
npx tsx scripts/checkExplainParse.ts      # 10 种脏输出 + 嵌套结构，全离线
```

覆盖：围栏、前置分析、全角标点+注释+尾逗号、中文键名/中文 kind、缺 kind、单引号裸数组、
中文引号、两种截断、纯垃圾文本。每条都断言「救回几镜 + 补镜后答案是否仍与题库一致」。

### 12.5 附带的生成中动效

`web/src/components/ExplainProgressArt.tsx` 改为「手绘 + 液态玻璃」四层结构
（环境光晕 / 随进度上升的液面 / 镜面流光 / 折射光环），手绘线稿是一层模糊洇墨 + 一层清晰笔触。
样式在 `styles.css` 的 `.ev-art*`，复用全局 `--glass / --glass-edge / --blur`，换主题自动跟随；
`prefers-reduced-motion` 下全部动画关闭，只留静态画面与百分比。
组件新增 `elapsedSec`，把「已用 Ns」显示出来——生成要几分钟，用户需要看到它确实在走。

---

## 13. 分级教学法 + 三档深度 + 语种硬校验（v3–v5）

> §6.5 的四条是最初版 prompt 要点，只解决「别讲错」。这一节解决「讲得像教授」——
> 现在的契约、参数与预算都在这里，改教学法只动 `explainPedagogy.ts`，不要碰解析与抢救逻辑。

### 13.1 为什么单独一个文件

`server/src/services/explainPedagogy.ts` 只干三件事：把教案的方法论翻成提示词、定义三档参数、
算成本。分出来是因为**教案是「怎么教」，不是「怎么生成 JSON」**——两者混在一起后，
调语气会误伤解析、调节奏会漏改预算。

### 13.2 五份教案 → 五套工具链

| 级别 | 学生卡在哪 | 核心工具 | 干扰项命名 |
|---|---|---|---|
| N5 | 单词查得出，整句读不出主干 | 骨架还原、助词换位测试、朗读停顿 | 主语看错／场所时间错位／否定看漏／时态看错 |
| N4 | 先后与条件关系排错 | 时间轴、四条件形对比、授受箭头、接续词方向 | 先后颠倒／条件形误用／授受方向反／接续关系判反 |
| N3 | 每句都懂全文不懂 | 段落功能标签、主题句定位、指代箭头、事实评价分栏 | 以偏概全／张冠李戴／文中未提／指代对象错 |
| N2 | 分不清主张与让步 | 论证四格、转折回收、长句三步 | 範囲拡大／因果逆転／主客転倒／程度偏移／文中未出 |
| N1 | 把字面当立场 | 立场尺度（±强度）、限定词与删词测试、婉曲双栏、隐含前提 | 同 N2 + 程度偏移 |
| TOPIK 1 | 音变还原不出词典形；이/가 与 은/는 混用 | 音变还原（连音·紧音化·鼻音化）、助词角色钉定、新信息测试 | 收音读断／이·가 은·는 混用／丢助词／音变位置标错 |
| TOPIK 2 | 分句关系读反；阶称跳级 | 方向牌（七词尾）、换词尾测试、后句语气检验、阶称扫描 | -고 当因果／命令句误用 -아서／-는데 译「但是」／阶称跳级 |
| TOPIK 3 | 长名词短语中心错位；指代追丢 | 括号法三步、冠形词尾定时制、指代链、主题句定位 | 中心名词错位／-(으)ㄹ 时制误读／-던 读成将来／指代对象错 |
| TOPIK 4 | 把让步段当作者立场 | 论证四段（주장—근거—양보—결론）、让步强度表、名词化还原、被动施事追问 | 让步当立场／强度混同／否定落点错／责任错位 |
| TOPIK 5 | 把字面语气当作者态度 | 强度尺 0–5（含反向档）、删词测试、责任落点两问、贬抑读法 | 强度混同／推测当事实／贬抑漏读／责任落点错 |
| TOPIK 6 | 双文本各读各的；反讽按字面读 | 三格矩阵、引用还原、语域三同步、反讽线索三问 | 承认当同意／转述当主张／只换语尾／反讽按字面读 |

英语（TOEFL / IELTS / 四六级 / 考研）是同构迁移：段落功能 + 同义替换、定位 + 改写。
韩语 TOPIK 1–6 级自 v6 起有独立六套 profile（源教案：`docs/教案/韩语/` 六份通用教案），
级别从 `plans.target_label`（「TOPIK 3 级」）提取，TOPIK 6 级有自己的教案、不再回落 5 级；
拿不到级别信息时韩语回落 topik3、日语 N3、英语四六级。

### 13.3 七个节拍 = 七种分镜，每拍写清「必须说出口的动作」

`HOOK(question) → LOCATE(passage) → DISMANTLE(grammar) → ELIMINATE(eliminate) → RESOLVE(answer) → TRANSFER(point) → ANCHOR(takeaway)`

v4 的教训：只写方法论，模型会写成电文体——`ここが根拠。声が「相次いだ」とある。`（18 字）
语法全对、信息全在，但那是答案卡。v5 因此给每一拍配上 a/b/c 动作清单（例：passage 镜必须
「指出那个词 → 读它所在的从句 → 说明上一句为什么不是证据」），并给出单镜字数下限与一段
同语种的密度示范。**想加讲解深度，加动作，不要加形容词。**

### 13.4 三档：一套数字，四处消费

参数唯一定义在 `DEPTH_PLANS`，前端不许再抄一份：

| 档位 | 每题镜数 | 每题字数 | 单镜下限/上限 | 语法镜 | maxTokens | 请求超时 | 脚本超时 |
|---|---|---|---|---|---|---|---|
| `short` 精简 | 3 | 130–200 | 32 / 90 | 1 | 5 000 | 240s | 9min |
| `medium` 标准 | 5 | 320–440 | 48 / 100 | 2 | 10 500 | 300s | 12min |
| `long` 精讲 | 6 | 520–680 | 66 / 110 | 3 | 15 000 | 420s | 15min |

输出预算按实测反推：标准档 19 镜实测输出 9 193（≈484/镜），给 9 000 会周期性触发
「截断 → 翻倍重试」，白花一倍时间，所以提到 10 500；精讲 23 镜要 ~14k，`MAX_TOKEN_BUDGET`
同步从 12 000 提到 16 000。**改预算前先看 `tokOut` 日志，不要凭感觉。**

字数区间是实测值，不是理想值：标准档「5 个内容镜 + 1 个语法镜」各自的必做动作加起来已经接近 300 字，
把上限压到 330 只会让模型删掉动作。**改预算前先跑一遍，看 `avgCharsPerQuestion`。**

消费方：① `buildSystem` 里的提示词预算；② `chatJson` 的 `maxTokens` / `timeoutMs`；
③ 配音阶段超时 `Math.max(90s, 90s + 镜数 × 6s)`；④ `validateExplainVideo(video, { maxMs })`。
缓存键含 `depth`，三档是三条独立缓存——切档读到旧片是 bug，读到「这一档还没生成」才对。

### 13.5 两个坑，都是踩出来的

1. **默认 90s 请求超时会把长档误杀**。`ChatOptions.timeoutMs` 就是为了透传这个预算；
   透传会 `{...config}` 造副本，而用量记在副本上——`config.usage` 于是永远为空，成本面板归零。
   `callOnce` 的 `finally` 里必须把用量搬回去，`chat()` 换线路时也要 `absorbUsage`，
   否则前面那条线路已花的 token 会凭空消失。
2. **阶段超时 ≠ 请求超时**。曾出现「报脚本超时，但后台日志显示视频已 done」——
   那是 `stageTimer` 卡在配音阶段。脚本与配音要分别计时，配音按镜数动态放宽。

### 13.6 旁白语种硬校验（宁可不生成，也不出乱码）

模型最常见的退化是把中文解析写进 `narration`：字幕看着像样，但 TTS 用日语音色念中文就是乱码。
`narrationInTargetLanguage()` 按假名/谚文/拉丁字母占比判断（阈值 0.08，正常日语旁白 ≥ 0.3，
纯中文夹引文常 < 0.05），≥70% 镜合格才通过；不合格带明确纠错重写一次，仍不合格则抛
`UpstreamError` 并标记 `narrationLanguage`——**这个标记必须跳过「拿残缺原文抢救」的分支**，
否则会把不合格脚本当可用脚本出片。

### 13.7 成本可见

`GET /api/explain-videos/estimate?articleId=` 一次返回三档：镜数、成片时长、
生成等待、token 区间、是否已缓存。两个时长概念不能混：

- **成片时长**（`secLow/secHigh`）：学生要看的长度；
- **生成等待**（`genSecLow/genSecHigh`）：用户要等的时间，约为成片的 1.5–2.5 倍。

UI 里 loading 态必须用 `gen*`，idle 态标注「成片 X–Y 分钟」，否则用户会以为 3 分钟就能出片。

### 13.8 校准口径

`explain script generated` 日志带 `avgCharsPerQuestion`；低于计划下限 80% 会另打一条
`explain narration thinner than planned`。调 prompt 时看这两个数，不要凭观感——
v4 → v5 就是把 21 字/镜拉到 48 字/镜下限的过程。

### 13.9 实测校准（标准档 · 3 题 · N1）

| 版本 | 镜数 | 旁白字数 | 每题字数 | 成片 | token | 生成耗时 | 质量标记 |
|---|---|---|---|---|---|---|---|
| v4 | 19 | 400 | ~133 | 1:42 | 未回传 | 9min | — |
| v5 | 16 | 924 | ~308 | 3:15 | 42.6k（含换线） | 4m11 | salvage + truncated |
| v6 | 21 | 1 406 | ~430 | 5:02 | 12.5k | 4m23 | 干净 |
| v7 | 18 | 1 308 | ~420 | 4:35 | 8.9k | 2m26 | 干净（1 个结尾镜） |
| v8 | 预估 | — | 320–440 | 3:35–4:51 | 7–10k | 3–5.6m | — |

三条经验：

1. **只给上限不给下限，模型会写成电文体**（v4：21 字/镜）。给下限 + 每镜动作清单 + 同语种密度示范，
   字数立刻翻倍，而且讲的确实是有内容的动作（邻居句检查、错项命名、触发词）。
2. **让模型抄题干选项是纯亏损**：组装时题库一律覆盖，模型抄的那份被丢弃，还撑爆输出预算
   （v5 的首个 10k 输出被截断，结尾镜丢了）。v6 去掉后同一篇只花 8 957 输出 token。
3. **`takeaway` 要写死「全片一个」**，否则模型会在每题后各加一个（v6 出现 3 个），
   视频像个三连小结。v7 加限制，同时在 `ensureCoverage` 里补了兜底：
   模型截断导致没有结尾镜时，用一句可复述的方法句补上，并计入 `autoFilledShots`。

### 13.10 思考型模型会吃掉输出预算

池里前四条线路（hy4 / hy3 / glm-5.3-flash）在长输出任务上全部返回空：
`finish_reason=length`，`reasoning_content` 有内容，正文 0 字——思考把 `max_tokens` 吃光了。
一次要等 ~2 分钟，四条就是 8 分钟，还没开始写脚本。

处理方式（`llm.ts`）：

- 长输出调用（`maxTokens >= 6000`）把「思考吃满预算」的线路排到最后；
- 判据有两个：本次进程内学到的（`reasoningHungry`）、号池里持久化的 `llm_keys.last_error`。
  后者让重启后也生效，线路恢复成功后 `last_error` 会被清空，自动回到正常顺位；
- 若全部线路都被判为不适合，仍按原顺序尝试——记忆只能调顺序，不能拒绝服务。

配套的坑：`callOnce` 为了透传超时会 `{...config}` 造副本，用量记在副本上，外层 `config.usage`
永远是空（成本显示 0）。`finally` 里搬回去；`chat()` 换线路时用 `absorbUsage()` 累加，
否则前面线路已经花掉的 token 会凭空消失——用户看到的成本必须是真花了多少。

---

## 14. 跨用户共享 + 双语讲师（v9）

> 两个需求合在一版做，因为它们是同一个问题：**同一份材料不该被重复讲两遍**。
> 共享解决「不同人看同一篇」，双语解决「同一个人听不懂原文」。

### 14.1 共享的边界

共享粒度 = **文章 + 教案档位（band）+ 讲解深度 + 脚本版本**。

- 为什么含 band：N3 与 N1 的提示词不是一套（`resolveLevelProfile` 决定七拍怎么落地），产物不能混用。
  band 来自 `plans.target_label`（「N3 合格」「N1 合格」），从文章所属计划推断。
- 为什么含 depth：精简/标准/精讲是三条不同的分镜计划。
- 为什么**不含** userId 与音色：这两个正是要跨过去的东西。代价是「讲师音色跟随首个生成者」，
  UI 不承诺「一定是你的音色」；要换音色属于「重配音」能力，不该靠改缓存键实现。

`hashFor` 因此不再接收 `voice`，改接收 `band`。缓存键口径变了，`SCRIPT_VERSION` 随之升到 9，
旧缓存自然作废——不要试图兼容老 hash，那样只会命中一堆没有 band 的片。

### 14.2 两层目录，读写优先级不同

```
.data/explain-video/shared/<articleId>/<hash>/     ← 新生成的片都落这里
.data/explain-video/<userId>/<articleId>/<hash>/   ← 个人副本（改过逐字稿才产生）
```

- 读：个人副本优先 → 再读共享层。这样「我改过的稿」不会被共享片覆盖。
- 写（生成）：共享层。
- 写（逐字稿编辑）：`updateManifest` 检测到「共享片 + 非 owner」时做 **copy-on-write**——
  复制音频与 manifest 到个人目录再改，只复制文件、不复制 `export.mp4`（几十 MB 没必要）。
- 删：个人副本直接删；共享片只有 `meta.ownerId` 能删，其他人会收到明确提示而不是静默失败。

`getSegment(videoId, index, track)` 按同一优先级读 `seg-N.mp3` / `seg-N.zh.mp3`，
所以「看共享片、改自己的稿、听自己的中文轨」三者可以同时成立。

### 14.3 双语契约

三种东西容易混，写清楚：

| 概念 | 字段 | 作用 |
|---|---|---|
| 目标语旁白 | `shot.narration` | 目标语 TTS 输入（主轨） |
| 中文讲师口播 | `shot.narrationZh` | **中文 TTS 输入**（母语轨），不是字幕 |
| 中文屏幕字幕 | `shot.caption` / `cue.text` | 屏上那行中文 |

母语轨是「第二个人在讲」，不是「把外语旁白翻译成字幕」。所以它要单独生成、单独配音。

`cue.text` 的语义这次一并修正：以前除第一个 cue 外会塞进目标语，导致「中文字幕」变外语。
现在恒为中文（有 `narrationZh` 就按句对齐，没有就整镜用 `caption`），`cue.narration` 才是目标语。

### 14.4 切轨不重排时间轴

两条轨时长不同。如果按母语轨重算 cue，切一次轨画面和字幕会整体错位——比语速略偏难受得多。

做法：**主轨时间轴是唯一时钟**。母语轨按「本镜两轨时长比例」映射：

```
ms = range.startMs + (audio.currentTime / native.durationMs) × range.duration
```

seek 时反向换算（主轨偏移 → 母语轨偏移）。代码在 `useTimeline.loadInto` 与 rAF 循环里，
`trackRef` 保证 rAF 闭包读到最新轨。切轨时强制 `activeShotRef = -1` 重载音源，
否则同 index 下可能命中上一次的 blob，留在旧轨上。

### 14.5 两条路径，一条省钱

1. **生成时就要双语**：`POST /api/explain-videos { coach: 'bilingual' }`。
   脚本跑完、主轨落盘后，补一次 `generateNativeNarration()` + 中文 TTS。失败只记 warn，
   目标语版照常可用（不因为中文失败让整片报废）。
2. **事后补轨（推荐默认）**：先出目标语版；用户真去点「中文讲师」时再
   `POST /api/explain-videos/:id/coach`。**不重跑脚本**，只做「转述 + 配音」，
   成本约为整片重生成的 1/5，耗时 1–3 分钟。

所以默认 `coach: 'target'`。`createExplainJob` 里有个细节：命中缓存但缓存没有母语轨、
而用户这次选了 bilingual 时，直接转成补轨 job，而不是重生成——前端一次点击就能拿到双语。

### 14.6 中文稿的生成约束

`explainNative.ts` 用一次低预算调用（`400 + 镜数 × 160` token，温度 0.3）把每条旁白转述成中文口播。
提示词里写死：只转述不新增、外语原句用「」保留不译、1–3 句、术语用通行译名。

代码侧校验**反向语种**：汉字占比 < 0.25 判该条不合格（模型可能又写成外语），
不合格超过三成整批作废并抛 `UpstreamError`。宁可没有中文轨，也不要一条念起来是外语的中文稿。

### 14.7 成本口径

- 共享命中：0 token。
- 补母语轨：`/estimate` 的 `nativeCost`（约 `600 + 镜数 × 340`，上下浮动 20%/30%）。
  实测标准档 19 镜 = 6 321 token（prompt 1 473 + 输出 4 848）、约 2 分钟。
- 整片重生成：三档各自的 `tokenLow/tokenHigh`。

UI 上三处必须分开显示，不要加在一起说「约 X token」——用户会以为切一次中文讲师要重花整片的钱。

### 14.8 已知取舍

- ~~导出 MP4 只含主轨~~ → v10 已补，见 15.2。
- ~~共享片的音色跟随首个生成者，换音色要重生成~~ → v10 已补「重配音」，见 15.1。
- **共享配额**：`shared/` 上限 8 GB，超了按最旧清理。共享片被清会让下一个用户重新付费生成，
  所以顺序是先清个人副本（200 MB/人）再清共享层。真上线要换成「热度 + 年龄」的淘汰策略。

---

## 15. 重配音 + 双语导出（v10）

这两件事都是「已经有一条讲解，只是想换个听法」，核心约束是**别再碰大模型**。

### 15.1 重配音：只跑 TTS，0 token

共享缓存的 hash 里故意不含音色（14.1），代价是成片音色跟随首个生成者。
让用户为此重新生成整片是纯浪费——旁白一个字都不用改，只是换个人念。

```
POST /api/explain-videos/:id/revoice   { voice?: 'ja-JP-KeitaNeural' }
  → 202 { job }（stage: 'revoice'，轮询方式与生成任务一致）
```

- `voice` 不传就用当前用户在该语种「文章讲解」场景配的音色（`resolveVoice`）。
- 校验只认 Edge Neural 名（`xx-XX-XxxNeural`），否则 400。
- **写盘前必先 `promoteToPersonal()`**：共享片是全站资产，把它的 `seg-N.mp3`
  换成我的音色等于替所有人改了讲师。个人副本存在后，后续读取自然优先命中它。
- 逐镜重合成 → 重算时间轴 → 写 `manifest.json` → `clearExports()`（旧导出已失效）。
- **顺序不能反**：manifest 是唯一事实来源，先写它；导出文件是可再生的派生文件，
  清不掉只记 warn。曾因为先清导出、清理抛异常，导致「音频已换好但 manifest 还是旧音色」。
- **逐字稿编辑是用户的劳动**：按 cue id 把 `edited: true` 的文案贴回新时间轴（时间用新算的）。
  重配音不该把用户改过的字幕冲掉。
- 音色没变（`target === video.voice`）直接返回 done，一次 TTS 都不跑。
- 单镜合成失败保留旧音频与旧时长（混一个声音也好过静音空档），全失败才报错。

实测：11 镜约 10 秒（并发 2），`tokens` 恒为 `{0,0,0}`。UI 里这个任务的成本药丸是绿色的
「0 token · 只重配音频」，与「要花钱」的 token 药丸刻意不同色。

### 15.2 双语导出：一个 MP4 里两条音轨

```
POST /api/explain-videos/:id/export   { track?: 'target' | 'native' | 'both' }
GET  /api/explain-videos/:id/export/file?track=...
```

| track | 音频来源 | 落盘 |
|---|---|---|
| `target`（默认） | `seg-N.mp3` | `export.mp4` |
| `native` | `seg-N.zh.mp3`，缺镜回落 `seg-N.mp3` | `export-zh.mp4` |
| `both` | 两条都进容器（`-map` 两个 audio stream） | `export-both.mp4` |

不传 `track` 时回落 `target`，老调用方一行不用改。body 里拼错音轨名返回 400（写代码的人该立刻看到），
query 里拼错则回落 `target`（分享出去的直链不该因为参数脏就打不开）。

实现上有四个踩过的点：

1. **拼接不能 `-c copy` + concat demuxer**。配音降级的分镜没有 mp3 文件，缺一镜
   后面所有字幕就整体前移（旧实现会音画错位）。现在缺镜插等长静音（`anullsrc`），
   统一 `aresample` + `aformat` 后走 filter `concat`，顺便抹平不同来源 mp3 的参数差异。
2. **双语要 `apad` + `-t`**。中文轨总时长与主轨不同，直接用 `-shortest` 会让容器
   跟着短的那条走。现在两条音轨都补静音到主轨时长，三路流实测同为 119.79s。
3. **字幕折行**。drawtext 不自动换行，长句会排出画面。`wrapText()` 按显示宽度硬折
   （全角 1 单位、拉丁 0.55），最多三行，并做避头标点（句号逗号不落行首）。
4. **字体按「这一行用到哪些文字系统」选，不是全局一个字体**。drawtext 一个滤镜只能挂
   一个 fontfile，而且不做字形回退：中文字体（Hiragino Sans GB 等）没有谚文字形，
   韩语字幕整行豆腐块；反过来韩文字体（Apple SD Gothic Neo）的汉字覆盖不全
   （「尘」「积」缺字）。现在逐行判断（`explainSubtitle.ts`）：
   纯中文/日文 → Hiragino → STHeiti → Songti → Noto → PingFang；
   纯韩文 → Apple SD Gothic Neo → Nanum/Noto KR → Noto CJK；
   中韩混排（中文正文里嵌韩文引号）→ Arial Unicode / Noto Sans CJK 这类全字库字体。
   PingFang 仍只做兜底：freetype 下会漏 U+8FDC「远」。**漏字比换字体难看得多**。
   `npm test` 覆盖文字系统判定、字体回退顺序与折行。
5. **旧导出必须失效**。韩语乱码的 mp4 一旦命中缓存，用户再点导出拿到的还是旧文件。
   视频目录里的 `.export-render-version` 与当前渲染版本不一致时，先删掉三条导出再重做。
   只对 `language === 'ko'` 生效：这次修的是谚文缺字体，中/日文旧导出本来是好的，
   不能顺手把别人可用的分享文件删掉。

导 `native` 时画面第二行换成 `narrationZh`（中文口播稿），否则会出现「中文在讲、屏幕上是日文」。

### 15.3 UI 口径

- 脚部两个小浮层（`.ev-menu`）：「换音色 ▾」「导出 MP4 ▾」。**向下展开**——
  脚部是面板最后一行，向上弹会盖住播放器和档位条（第一版就是这么盖的）。
- 选「中文讲师音轨 / 双语双音轨」在没有中文轨时置灰，并写明原因，不是静默失败。
- 历史浮层新增「我改过」标签：`summary.revised` = 个人副本且非 owner。
  共享片被你改过逐字稿或换过音色后，它就不再是「共享」，但也不是「我生成的」。
- loading 态分三种（生成 / 补中文轨 / 重配音），标题、等待区间、成本药丸各自一套。
  不要复用「生成」那套数字：重配音是 0 token 且只要十几秒。
