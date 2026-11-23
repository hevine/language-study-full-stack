# 播放器优化 · 交接文档

> 交接对象：接手「朗读 / 听力播放器」优化的新任务
> 交接时间：2026-11-20
> 项目：外语考证宝典（英语 / 日语 / 韩语备考生成器）
> 本文件只讲播放链路，整体架构见根目录 `HANDOVER.md`

---

## 0. 开工前必读（不做这一步，服务起不来）

### 0.1 项目位置

```
/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
```

注意：当前会话工作区 `/Users/zhua/WorkBuddy/2026-11-06-10-54-08` 是空的，不要在那里找源码。

### 0.2 Node 版本坑（最容易踩）

`better-sqlite3` 是按 **Node 24** 编译的原生模块，而 PATH 里默认的 Node 是 **22**：

```
$ node -v          # v22.22.2  ← 直接跑会崩
$ /usr/local/bin/node -v   # v24.12.0  ← 必须用这个
```

用 Node 22 启动会立刻报：

```
Error: The module '.../better_sqlite3.node' was compiled against a
different Node.js version using NODE_MODULE_VERSION 137.
This version of Node.js requires NODE_MODULE_VERSION 127.
```

正确启动方式（把 Node 24 放到 PATH 最前）：

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
PATH=/usr/local/bin:$PATH npm start          # 生产模式，端口 4399
PATH=/usr/local/bin:$PATH npm run dev        # 开发模式，前端 5199 + 后端 4399
```

已实测：`/usr/local/bin/node -e "require('better-sqlite3')"` 可正常加载 `.data/app.db`（843 条题目）。

### 0.3 常用命令

| 命令 | 用途 | 备注 |
|---|---|---|
| `npm run dev` | 前端热更新 + 后端 watch | 改前端首选 |
| `npm run build && npm start` | 生产模式 | 后端改动必须重启，启动约 50 秒 |
| `npm run typecheck` | 类型检查 | 改完必跑 |
| `npm run voice:setup` | 安装 `.voice-venv` + edge-tts | 云端本地音色依赖它 |
| `npm run clean:cache` | 清 Vite 缓存残留 | 最近新增 |

### 0.4 没有 `.env`

配置全走环境变量 + 代码默认值（`server/src/config/env.ts`）。默认即：端口 4399、游客模式、无外部 LLM Key。
`.data/.authkey`、`.data/.llmkey` 是自动生成的主密钥，不要提交、不要外传。

### 0.5 数据库现状（与播放相关）

| 数据 | 数量 | 说明 |
|---|---|---|
| `exam_items` 总数 | 843 | 试卷题 |
| 其中有 `audio_text`（朗读稿） | 191 | 听力题靠它现场合成 |
| 其中有 `audio_url`（真人音频） | **0** | 这条分支是死路，见 P2-1 |
| `voices` | 22 | browser 11 + cloud 11（三语种） |
| `voice_assignments` | 12 | 4 场景 × 3 语种，全部已分配 |
| `voice_prefs.global_rate` | 0.9 | 三语种一致 |

---

## 1. 现状：一次朗读是怎么走完的

```
点击「▶ 全文连读」
   │
   ├─ useVoicePlayer(scene)                       web/src/hooks/useVoicePlayer.ts
   │     │
   │     ├─ 音色解析 useVoiceSystem().resolve(scene)
   │     │     └─ voice_assignments[scene] → voices 行 → provider
   │     │
   │     ├─ provider === 'browser' ─────────────► useSpeech(lang)
   │     │     最本机系统声音                        │ 队列预读 2 句
   │     │                                          │ speechSynthesis.speak()
   │     │                                          └─ onstart 置 speakingId → 逐段高亮
   │     │
   │     └─ provider === 'cloud' ───────────────► 逐条串行
   │            │                                    │
   │            │  ① POST /api/voices/:id/synthesize │  每句一次请求
   │            │  ② 服务端 spawn Python 合成 mp3    │  edgeTts.ts，30s 超时
   │            │  ③ 返回 buffer → blob URL          │
   │            │  ④ new Audio(url).play()           │  播完才取下一句
   │            └─ 失败则整段降级回系统音色（带提示）
   │
   └─ 结束 / 停止 → stop() 清空队列
```

两条通道的差别决定了所有体验差异，**优化时必须分开考虑**。

---

## 2. 同一件事，现在写了四遍

| # | 入口 | 文件 | 通道 | 现有能力 |
|---|---|---|---|---|
| 1 | `useSpeech` | `web/src/hooks/useSpeech.ts`（401 行） | browser | 队列、2 句预读、音色打分、重启防吞字 |
| 2 | `useVoicePlayer` | `web/src/hooks/useVoicePlayer.ts`（187 行） | 两者分发 | 场景音色解析、云端串行、失败降级 |
| 3 | `VoiceStudio` 试听 | `web/src/components/VoiceStudio.tsx:90,186-215` | 两者 | 自建 `audioRef` + `speechSynthesis.cancel()` |
| 4 | 考试页原生控件 | `web/src/pages/ExamTake.tsx:405` | `<audio controls>` | 依赖 `audio_url`，实际全库 0 条 |

其中 **3 是 1/2 的重复实现**：自己 `new Audio`、自己 cancel、没有降级、错误提示各写一套。这是重构最该先收口的地方。

调用点（改签名会牵动这 5 处）：

```
web/src/components/ArticleView.tsx:68     useVoicePlayer('article')
web/src/components/WordDeck.tsx:44        useVoicePlayer('word')
web/src/components/VoiceStudio.tsx:192    （独立实现）
web/src/pages/ExamTake.tsx:66             useVoicePlayer('listening')
web/src/pages/Vocab.tsx:92                useVoicePlayer('word')
web/src/components/ReadingPlayer.tsx:23   useVoicePlayer(scene)
web/src/hooks/useVoicePlayer.ts           （被上面全部复用）
```

---

## 3. 能力矩阵（优化的设计前提）

| 能力 | browser（系统音色） | cloud（本地 Edge / 在线 TTS） |
|---|---|---|
| 播放 | ✅ `speechSynthesis` | ✅ `Audio` 播 mp3 |
| 暂停 / 续播 | ⚠️ 有 `pause/resume`，但队列状态会乱 | ✅ `audio.pause()` 天然支持 |
| 精确时长 | ❌ 拿不到 | ✅ `audio.duration` |
| 进度条 / 拖动 | ❌ 只能按段落数估算 | ✅ 可按秒 seek |
| 句间无缝 | ✅ 预读 2 句 | ❌ **每句都要等合成** |
| 离线可用 | ✅ | ❌（本地 Edge 仍需联网调微软接口） |
| 音质 | 看系统装了哪些声音 | 明显更好 |
| 语速即时生效 | ❌ 创建 utterance 时定死 | ❌ 需重新合成 |
| 失败降级 | —（本身就是兜底） | ✅ 自动回落系统音色 |

**结论**：不要试图做一个"完全统一"的播放器。应该统一**状态机与事件**，但把「可 seek / 有时长」做为可选能力位暴露给 UI（capability flags），UI 按能力降级渲染。

---

## 4. 已知问题清单

### P0（影响可用性，建议先修）

**P0-1 两个播放器同屏会互相打断且状态卡死**

`TaskPage` 的 article 分支同时渲染 `ArticleView`（自带 `useVoicePlayer('article')`）和 `ReadingPlayer`（同样 scene=article）：

- `TaskPage.tsx:338-352`（ArticleView + ReadingPlayer 同屏）
- `Today.tsx:181-211` 同样是 ArticleView 与 ReadingPlayer 并存

两个组件各自 `useVoicePlayer` → 各自 `useSpeech` → **共享同一个全局 `window.speechSynthesis`**。
A 在播时点 B：B 的 `play()` 内部 `speechSynthesis.cancel()`（`useSpeech.ts:340`）把 A 的 utterance 也取消了；而 A 的 `onerror` 对 `canceled/interrupted` 只减引用就 return（`useSpeech.ts:321-328`），**不更新 `playing` / `speakingId`**。

结果：A 的按钮永远停在「停止」，且点它也不会真正恢复；`onDone` 回调永不触发。

修复方向：播放内核做成**模块级单例**，全局只有一个 owner，任一实例播放时广播 `stop` 给其他实例。详见阶段 A。

---

**P0-2 云端连读句间有明显空档**

`useVoicePlayer.ts:92-118` 是 `for` 循环里 `await synthesize → await play`，播完一句才请求下一句：

```
合成(0.3~1s) → 播放(3s) → 合成(0.3~1s) → 播放(3s) → ...
```

本地 Edge 每次都 `spawn` 一个 Python 子进程（`edgeTts.ts:126`），启动开销叠加网络往返，20 段的文章会断成 20 截。

修复方向：当前句播放时并行预取下一句（并发上限 2），句间等待可压到 ~0ms。见阶段 C。

---

**P0-3 只有「停止」，没有「暂停」**

`ReadingPlayer.tsx:55` 只有停止按钮；`stop()` 会清空队列并重置游标（`useSpeech.ts:261-273`），**无法从第 N 段继续**。

对跟读场景是硬伤：用户听第 3 句 → 想自己念一遍 → 只能重头再来或手点单句。

修复方向：引入「会话游标 + pause/resume」，browser 走 `speechSynthesis.pause()`，cloud 走 `audio.pause()`。见阶段 B。

### P1（体验明显不足）

**P1-1 播放中改语速不生效**
`utterance.rate` 在创建时快照（`useSpeech.ts:294`），预读的 2 句已带旧语速；cloud 侧缓存键含 rate（`edgeTts.ts:201`），改语速必须重新合成。用户点 0.7× 后发现没变化，会以为坏了。

**P1-2 没有进度与时长**
`ReadingSegment` 只有 `text / translation / tips`（`web/src/types.ts:88-92`），**没有时长字段**。
→ cloud 模式可用 `audio.duration` 算出真实进度；browser 模式只能按「第 3/12 段」显示。要做统一进度条，先得承认这个能力差。

**P1-3 单词没有连播 / 循环 / 听写模式**
`WordDeck.tsx:231`、`Vocab.tsx:290` 都是单次 `speak(term)`，点一次念一个。背词场景实际需要：自动下一个、间隔可调、重复 2~3 遍、"只听不看"。

**P1-4 VoiceStudio 试听重复实现一套播放**
`VoiceStudio.tsx:186-215`：自己 `new Audio`、自己 `URL.revokeObjectURL`、自己 `speechSynthesis.cancel()`。缺云端失败降级、错误文案与 `useVoicePlayer` 不一致。

**P1-5 服务端缓存是内存 Map，重启即失效，且不是真 LRU**
`edgeTts.ts:31,186-223`：`CACHE_LIMIT = 60`，`Map.keys().next()` 删最老的 —— 命中时不刷新顺序，所以是 FIFO 不是 LRU；进程重启全部丢失，同一篇文章下次启动重新合成。

### P2（可延后）

- **P2-1** 考试页 `<audio controls>` 是死路：`exam_items.audio_url` 全库 0 条（191 条有 `audio_text`）。将来接真人录音需另设计。位置 `ExamTake.tsx:405`。
- **P2-2** 听力「最多两遍」只在前端 state（`ExamTake.tsx:60,222-241`），刷新即重置。自测工具可接受，若要防刷需落库。
- **P2-3** `player-bar` 窄屏未验证：`styles.css:1411` 是 flex，未测 375px 换行。
- **P2-4** 无键盘快捷键（空格播放/暂停、← → 切句）。
- **P2-5** `NOVELTY` 正则在 `useSpeech.ts:5` 和 `voiceUtils.ts:6` 各写一份，已出现漂移风险，应合并到 `voiceUtils`。

---

## 5. 建议路线（三档，可独立交付）

### 阶段 A：抽「播放内核」，不动 UI（前提）

**目标**：解决 P0-1，为后续所有能力打底。

新建 `web/src/player/engine.ts`：

```ts
type EngineState = {
  status: 'idle' | 'playing' | 'paused';
  sessionId: number;
  index: number;          // 当前第几段
  total: number;
  speakingId: string | null;
  mode: 'browser' | 'cloud';
  error: string | null;
};

// 模块级单例：全局只有一份播放状态
export const playerEngine = {
  play(items, opts), pause(), resume(), stop(), seekTo(index), subscribe(fn),
};
```

要点：
1. **单例 + 订阅**，用 `useSyncExternalStore` 接进 React。任一实例 `play()` 前先 `stop()` 全局，并广播，彻底消除跨实例残留。
2. `useVoicePlayer` 改成薄包装，**保持现有返回签名不变** → 5 个调用点零改动。
3. `VoiceStudio` 的试听改为复用同一个 engine，删掉自建 `audioRef`。
4. 保留现有失败降级逻辑（`useVoicePlayer.ts:117-137`），这段是有价值的，别重写。

验收：TaskPage 同屏两个播放器互不串台；点任意一个，另一个立即复位为 idle。

风险：`speechSynthesis` 是全局的，单例是唯一正确解法；但要注意 SSR/严格模式下的重复订阅（项目用 HashRouter + StrictMode 需实测）。

### 阶段 B：体验补齐

按性价比排序：

1. **暂停/继续 + 上一句/下一句**（P0-3）—— ReadingPlayer 工具条加 4 个按钮，engine 支持 `seekTo`。
2. **点任意段落从该句起播**（现在只有单句 ▶，没有"从这里连播"）。
3. **语速即时生效**（P1-1）：播放中改语速 → 暂停 → 改 rate → 从当前句续播；cloud 加 loading 态。
4. **单词连播**（P1-3）：`WordDeck` 加「连读」模式，间隔 0.8s 可调、每词重复 1~3 遍。
5. **进度显示**（P1-2）：cloud 显示真实秒数 + 可拖；browser 显示 `3/12 段`。用 capability flag 区分，不要假装统一。
6. **键盘快捷键**（P2-4）：空格 / ← → / Esc。

约束：**不引第三方音频库、不引状态管理库**（项目目前 0 UI 依赖，保持这一点）。

### 阶段 C：性能

1. **云端预取**（P0-2）：播放第 N 句时并行请求第 N+1 句，`Map<index, Promise<blobUrl>>` 缓存，并发上限 2，`stop()` 时 abort 未完成请求（`AbortController`）。
2. **服务端落盘缓存**（P1-5）：`.data/tts-cache/<sha1(voice|rate|text)>.mp3` + 内存 LRU 前置；加容量上限（建议 500MB）与 30 天清理。`resetEdgeTtsStatus()` 已存在，可复用为清缓存入口。
3. **真 LRU**：`Map` 命中时 `delete` 再 `set`。

预期收益：同一篇文章第二次播放，句间空档从 0.3~1s 降到 50ms 以内；重启后仍有缓存。

---

## 6. 硬约束（改之前先看一眼，别破）

1. **云端 API Key 永不出后端**：前端只调 `/api/voices/:id/synthesize`，绝不直接拿 Key 调 TTS。
2. **考试作答时不下发答案**：`server/src/routes/exams.ts` 取卷接口特意剥离答案与解析，播放器改动不要动 item 结构。
3. **音色按场景隔离**：`voice_assignments` 有 `word / sentence / article / listening` 四类，不能为了省事全局覆盖。
4. **播放失败必须降级**：云端 403/超时时自动回落系统音色并给中文提示（`useVoicePlayer.ts:117-137`），这是核心容错，别删。
5. **`.data/` 不进版本库**：`.gitignore` 已忽略；播放缓存若要落盘，放 `.data/` 下。
6. **零重型依赖**：不引入 howler / tone / zustand 之类。
7. **Edge TTS 是非官方接口**：随时可能 403，任何新逻辑都要考虑"语音不可用"的降级路径。

---

## 7. 验收清单（改完逐条过）

```bash
PATH=/usr/local/bin:$PATH npm run typecheck     # 必须 0 error
PATH=/usr/local/bin:$PATH npm run build         # 必须过
```

功能：

- [ ] TaskPage 同屏两个播放器互不串台，点一个另一个立即复位
- [ ] 「暂停 → 继续」能从当前句接上，不重头
- [ ] 「上一句 / 下一句」定位准确，高亮跟随
- [ ] 播放中改语速，下一句即生效
- [ ] 云端模式连读 10 段，句间空档 < 150ms（DevTools Network 可验）
- [ ] 断网 / 伪造 403 时，自动切系统音色并有中文提示，不哑
- [ ] 停止后所有 `playing` 均为 false，无残留高亮
- [ ] 单词连读：间隔、重复次数生效
- [ ] 375px 宽下 `player-bar` 不溢出
- [ ] 刷新页面后音色分配、语速偏好保持

---

## 8. 排查手册

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即报 `NODE_MODULE_VERSION 137` | Node 版本不对 | 用 `PATH=/usr/local/bin:$PATH` |
| 点朗读没声音、无报错 | 系统没装该语种声音，或 Chrome 首次 `getVoices()` 为空 | 代码已补 5 次轮询（`useSpeech.ts:236`）；到「设置 → 音色库」换音色 |
| 云端合成报 403 / 握手失败 | 微软非官方接口限制 | 换系统音色；或稍后重试 |
| 报「本地 edge-tts 未安装」 | `.voice-venv` 不存在 | `npm run voice:setup` |
| 首句要等 1 秒才出声 | 本地 Edge 每次 spawn Python | 阶段 C 的预取 + 落盘缓存 |
| 句间像卡了一下 | 云端逐句串行合成 | 同上（P0-2） |
| 点了别人的播放器，前一个按钮卡住 | 跨实例状态残留 | P0-1，阶段 A |
| 重启后要等 50 秒 | `tsx` 冷启动 + 迁移检查 | 正常现象，不是 bug |

---

## 9. 相关文件速查

```
web/src/hooks/useSpeech.ts          401 行  浏览器语音：打分、队列、预读、重启防吞字
web/src/hooks/useVoicePlayer.ts     187 行  场景音色分发 + 云端串行 + 降级
web/src/hooks/useVoiceSystem.tsx    168 行  全局音色上下文（音色库、场景分配、偏好）
web/src/hooks/voiceUtils.ts          76 行  系统音色匹配、BCP47、场景文案
web/src/components/ReadingPlayer.tsx 165 行  朗读工具栏 + 分段高亮（优化主战场）
web/src/components/VoiceStudio.tsx  893 行  音色库管理 + 试听（含重复播放实现）
web/src/pages/ExamTake.tsx          578 行  听力播放 + 两遍限制
web/src/pages/Today.tsx / TaskPage.tsx      ReadingPlayer 使用方（同屏两实例问题现场）
server/src/services/edgeTts.ts      261 行  本地 Edge 合成：spawn Python、内存缓存、错误翻译
server/src/services/voiceCatalog.ts 510 行  在线 TTS 目录与 OpenAI 兼容调用
server/src/routes/voices.ts         325 行  音色 CRUD、分配、合成端点
server/src/repositories/voices.ts   357 行  音色表读写（Key 密文）
server/src/db/migrations/012_voices.sql     voices / assignments / prefs 三张表
scripts/edge_tts_synth.py            43 行  Python 合成脚本（stdin JSON → stdout mp3）
```

样式集中在 `web/src/styles.css`：`.player-bar`(1411) `.segment`(1441) `.seg-actions`(1497) `.icon-btn`(1503) `.rate-group`(1531) `.exam-audio`(7041)。

---

## 10. 给新任务的第一句话

> 先修 P0-1（跨实例状态残留）和 P0-3（没有暂停），再补 P0-2（云端预取）。
> 起点是 `web/src/hooks/useVoicePlayer.ts` 与 `web/src/components/ReadingPlayer.tsx`，
> 记得用 `PATH=/usr/local/bin:$PATH` 起服务。
