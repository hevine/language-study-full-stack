# HANDOVER-VOICE · 语音系统专项交接

> **给谁读**：接手「完善语音系统」任务的 AI agent 专家 / 工程师。
> **范围**：只讲语音与听力这一块——音色库、文字转语音（TTS）、语音输入（识别/录音）、听力材料库、媒体播放器、讲解视频配音。计划、词汇、解题、鉴权等业务只在必须联动时提及。
> **基线**：`main@2d8f82a`。注意：语音链路里**有 6 个文件仍处于未提交（staged / 新增）状态**，详见 §1.5，接手后第一件事是先确认这些改动已被妥善纳入版本管理，不要误当垃圾清理。
> **配套文档**：整体架构见 `README.md` 与 `HANDOVER.md`；鉴权见 `HANDOVER-AUTH.md`；播放器 SDK 演进见 `HANDOVER-PLAYER.md`；讲解视频见 `HANDOVER-EXPLAIN-VIDEO.md`。

---

## 0. 一句话现状

语音系统**功能齐全但结构分散**：后端已实现「音色库 CRUD + 本地 Edge / 云端双 TTS 通道 + 听力库上传播放 + 讲解视频配音」，前端对应「配置面 / 朗读面 / 媒体面 / 输入面 / 听力库」五条线。真正能跑通，但存在三类问题——**功能性 Bug（讲解视频换音色不生效、朗读回调丢失）、缺少统一音频仲裁（多套系统各自出声）、环境不可移植（Python 路径写死）**。本次任务的本质是把这套「能跑的拼装」收敛成一套「可靠、可维护、可扩展」的语音子系统。

---

## 1. 先跑起来（开工前必读）

### 1.1 项目位置

```
/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
```

注意：当前会话工作区 `/Users/zhua/WorkBuddy/2026-11-22-13-05-03` 不是源码目录，不要在那里找代码。

### 1.2 Node 版本坑（最容易踩，会让你以为代码坏了）

`better-sqlite3` 是按 **Node 24** 编译的原生模块，PATH 里默认的 Node 是 **22**：

```
$ node -v                  # v22.22.2  ← 直接跑会崩
$ /usr/local/bin/node -v   # v24.12.0  ← 必须用这个
```

Node 22 下加载会报 `NODE_MODULE_VERSION 137 vs 127`。所有脚本 / 服务统一用：

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
PATH=/usr/local/bin:$PATH npm run dev        # 开发：后端 4399 + 前端 5199
PATH=/usr/local/bin:$PATH npm run build      # 前端构建
PATH=/usr/local/bin:$PATH npm run typecheck  # 类型检查
/usr/local/bin/node node_modules/.bin/tsx scripts/xxx.ts   # 单跑脚本
```

换机器 / 换 Node 大版本后先 `npm rebuild better-sqlite3`。

### 1.3 常用命令

| 命令 | 用途 | 备注 |
|---|---|---|
| `npm run dev` | 前端热更新 + 后端 watch | 改前端首选；vite 代理 `/api` → 4399 |
| `npm run build && npm start` | 生产模式，仅 4399 | 后端改动必须重启，启动约数十秒 |
| `npm run typecheck` | 全项目类型检查 | 改完必跑 |
| `npm run voice:setup` | 建 `.voice-venv` 并装 edge-tts | **本地 Neural 音色唯一安装入口，版本不锁定** |
| `npm run clean:cache` | 清 Vite 缓存残留 | 改配置后若热更异常用 |
| `npm run check:auth` | 认证闭环自检 | 语音不涉及，但回归时确认没破坏鉴权 |

### 1.4 配置现状（`.env` / 环境变量）

**没有语音专属的 zod 配置项**。相关只有：

| 变量 | 来源 | 默认值 | 用途 |
|---|---|---|---|
| `DATA_DIR` | env schema | `./.data` | SQLite + 听力音频落点（听力：`$DATA_DIR/listening/<user>/`） |
| `AUTH_REQUIRED` | env schema | `false` | 为 `true` 时业务接口全局强制登录（见 §5 P0-2 风险） |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT_MS`（默认 90s） | env schema | 空 | `discoverVoices()` 推荐音色走全局 LLM |
| `EDGE_TTS_PYTHON` | **直接 `process.env` 读取，未经校验、未在 `.env.example`** | 无 | 覆盖 Python 解释器路径 |
| ffmpeg | 运行时探测 | `@ffmpeg-installer/ffmpeg` → PATH `ffmpeg` | 讲解视频 MP4 导出 |

`.data/.authkey`、`.data/.llmkey` 是自动生成的主密钥，不要提交/外传。

### 1.5 ⚠️ 工作区未提交改动（接手第一要务）

以下语音相关文件当前是**新增且未提交**（`git status` 显示 `A`）：

```
scripts/edge_tts_timeline.py                  # 讲解视频带时间轴 TTS 桥接
server/src/db/migrations/015_listening_library.sql
server/src/repositories/listening.ts
server/src/routes/listening.ts
server/src/services/explainTts.ts
web/src/pages/ListeningMaterial.tsx
```

它们是听力库 + 讲解视频配音链路的核心，不是临时垃圾。接手后请先 `git add`/确认纳入版本管理，避免误清理导致功能缺失。

### 1.6 数据库现状（`.data/app.db`，实测 2026-11-22）

| 表 | 数量 | 说明 |
|---|---|---|
| `voices` | 34 | browser 23 + cloud 11，按 `user_id + language` 分散 |
| `voice_assignments` | 12 | 4 场景 × 3 语种 |
| `voice_prefs` | 7 | 试听语料 + 全局语速 |
| `listening_materials` | 1 | 音频本体在文件系统，不在 SQLite |
| `users` | 3 | `local`(admin) + `bestfancy`(student) + `teacher01`(teacher) |

> 数据量会随用户操作变化，以实测为准。老文档 `HANDOVER-PLAYER.md` 里的 `voices=22` 已过时。

---

## 2. 系统全景（先建立心智模型）

前端实际是**五条彼此独立、只做了局部互斥**的链路，这是所有并发/串台问题的根源：

| # | 链路 | 入口 | 播放/处理对象 | 全局互斥 |
|---|---|---|---|---|
| A | 文字朗读（TTS） | `useVoiceSystem` → `useVoicePlayer` → `useSpeech` | 文字（浏览器 SpeechSynthesis 或云端合成音频） | 各处手工 `speechSynthesis.cancel()` + `stop()`，**不经过协调器** |
| B | 真人媒体播放 | `MediaPane` → `@waiyubaodian/hevc-player` SDK | mp4 / wav / mp3 文件 | `mediaCoordinator` 模块级单例注册表 |
| C | 语音输入/录音 | `useSpeaking` | 麦克风 → SpeechRecognition + MediaRecorder | **无任何协调**，独立持有麦克风流 |
| D | 听力材料库 | `ListeningMaterial` 页 | 用户上传音频 → 带鉴权下载 blob | 走 B 链播放 |
| E | 讲解视频配音 | `explainTts.ts` + 后端 job | 分段音频 + 时间轴 → MP4 | 服务端 job，前端 `ExplainVideoPanel` |

三条朗读**音色通道**（A 链的城端）：

- **browser**：前端 Web Speech API，后端只存音色引用/匹配规则，不产音频；
- **cloud**：服务端代理 OpenAI 兼容 `/audio/speech`，API Key 用 AES-256-GCM 加密存储（`local://edge` 除外）；
- **local Edge**：后端 spawn Python 子进程跑 `edge-tts`（非官方微软接口），`local://edge` 标识，内存缓存 mp3。

讲解视频配音是**平行的第四条通道**（`explainTts.ts` + `edge_tts_timeline.py`），与朗读链路刻意隔离、互不替换。

```
                          ┌──────────── 前端 ────────────┐
   文字 ──> useVoicePlayer ─┬─ browser ─> speechSynthesis
                            └─ cloud ───> api.synthesizeVoice ─┐
   麦克风 ─> useSpeaking (识别/录音)                            │
   上传音频 ─> ListeningMaterial ─> MediaPane ─┐                │
   H265/媒体 ─> MediaPane ────────────────────┤                │
                            mediaCoordinator（仅管 B/D/E 媒体） │
                          └────────────────────────────────────┘
                                       │ HTTP /api
                          ┌──────────── 后端 ────────────┐
                    voicesRouter  listeningRouter  explainVideosRouter
                          │            │              │
                   voiceCatalog   listening repo   explainVideo job
                     ├─ cloud TTS     文件存储        └─ explainTts
                     └─ edgeTts ─> Python .voice-venv ─> edge-tts(微软)
                          └────────────────────────────────────┘
```

**数据隔离**：`AsyncLocalStorage` 的 `currentUserId()`（游客回落 `local`）。voices 仓储显式传 `userId + language`；listening 仓储隐式取 `currentUserId()`；文件路径对 userId / 文件 id 白名单化，杜绝路径穿越。

**语言白名单**：仅 `en | ja | ko`（`server/src/domain/language.ts`），BCP47 映射 `en-US / ja-JP / ko-KR`。

---

## 3. 后端地图

### 3.1 文件清单

| 层 | 文件 |
|---|---|
| 路由 | `server/src/routes/voices.ts`、`routes/listening.ts`（挂载于 `routes/index.ts` 第 48/51 行 `/api`） |
| 服务 | `server/src/services/edgeTts.ts`、`voiceCatalog.ts`、`explainTts.ts`（消费方 `explainVideo.ts`、`explainExport.ts`） |
| 仓储 | `server/src/repositories/voices.ts`、`listening.ts` |
| 迁移 | `server/src/db/migrations/012_voices.sql`（3 表）、`015_listening_library.sql`（1 表） |
| 领域 | `server/src/domain/language.ts`（语种白名单）、`domain/types.ts`（无独立 Voice 类型） |
| 桥接脚本 | `scripts/edge_tts_synth.py`（朗读）、`scripts/edge_tts_timeline.py`（讲解视频） |

### 3.2 路由契约

`voices.ts` 与 `listening.ts` **均无端点级 `requireAuth`**；靠全局 `optionalAuthenticate` + `AUTH_REQUIRED` 兜底。所有归属来自 `currentUserId()`。

**音色库 `/api/voices`**

| 方法 + 路径 | 作用 | 关键请求/响应 |
|---|---|---|
| `GET /voices?language=` | 全量快照；首次自动播种 3 条浏览器音色 | → `{language,bcp47,voices,assignments,prefs,scenes,presets}` |
| `POST /voices/discover` | LLM 按语种推荐候选，不落库 | body `{language?}` → `{items,source:'ai'\|'builtin',notice,model}` |
| `POST /voices/import` | 批量导入候选 | body `{language?,items:ImportItem[1..12]}` → 快照 |
| `GET /voices/edge/status?refresh=1` | 本地 Edge 自检（5 分钟缓存） | → `{available,python,version,hint}` |
| `POST /voices/edge/enable` | 一键启用本地 Neural（补音色 + 设默认 + 四场景绑定） | → 快照 + `{enabled:{added,primaryId,names}}` |
| `PUT /voices/assignments` | 场景→音色绑定，`null`=跟随默认 | body `{language?,assignments}` |
| `PUT /voices/prefs` | 试听语料 / 全局语速 | body `{language?,sampleText≤600,globalRate:0.5–1.4}` |
| `POST /voices/:id/synthesize` | 服务端代理合成，返回音频二进制 | body `{text:1–3000,rate?,language?}`；`content-type` 透传，`cache-control:no-store` |
| `POST /voices/:id/default` | 设默认音色 | body/query `language` |
| `POST /voices` | 新建音色 | `VoiceCreate`（201） |
| `PUT /voices/:id` | 更新音色 | 全字段 optional + `apiKey?` + `clearKey?` |
| `DELETE /voices/:id` | 删应用内记录（不动系统音色），默认被删则顶补 | **body/query 必须带 `language`** |

音色字段 `VoiceFields`：`name(1..40)`、`provider('browser'|'cloud')`、`engineVoice`、`matchHint`、`model`、`baseUrl`、`voiceId`、`style`、`persona`、`tags(≤8)`、`rate(0.5–1.4)`、`pitch`、`volume`、`source('system'|'preset'|'ai'|'custom')`。

**安全要点**：`publicVoice()` 从响应中剥离 `apiKey`，只回 `hasKey` 与 `maskedKey`（`首3位••••末4位`）。明文 Key 只在写入时进入服务端，立即加密。

**听力库 `/api/listening`**

| 方法 + 路径 | 作用 | 关键请求/响应 |
|---|---|---|
| `POST /listening/materials` | 上传音频 | `express.raw({type:()=>true, limit:300MB})`；query `language`(必填)/`name`(必填)/`title?`/`durationSec?`；扩展名白名单 mp3/m4a/aac/wav/ogg/flac；→ 201 `{material}` |
| `GET /listening/materials?language=` | 列出当前账号资料 | → `{materials}` |
| `GET /listening/materials/:id/file` | 流式返回音频 | `Content-Type`/`Content-Length`/`Accept-Ranges:bytes`；`createReadStream().pipe(res)` |
| `PATCH /listening/materials/:id` | 改标题/备注 | → `{material}` |
| `DELETE /listening/materials/:id` | 删元数据 + 磁盘文件 | → `{ok:true}` |

> `<audio>`/播放器无法自带 `Authorization` 头，所以前端必须带 token `fetch` 成 Blob URL 再交给播放器（`api.downloadListeningMaterial`）。

### 3.3 数据模型（`012` + `015`）

**`voices`**：`id TEXT PK`、`user_id`、`language CHECK(en/ja/ko)`、`name`、`provider CHECK(browser/cloud)`、`engine_voice/match_hint/model/base_url/api_key/voice_id/style/persona TEXT DEFAULT ''`、`tags TEXT DEFAULT '[]'`(JSON 串)、`rate REAL DEFAULT 0.9`、`pitch/volume REAL DEFAULT 1`、`source CHECK(...)`、`is_default INTEGER DEFAULT 0`、`created_at/updated_at`。索引 `(user_id,language,is_default)`。

**`voice_assignments`**：`PK(user_id,language,scene)`，`scene CHECK(word/sentence/article/listening)`，`voice_id TEXT 可空`，无外键。

**`voice_prefs`**：`PK(user_id,language)`，`sample_text`、`global_rate DEFAULT 0.9`。

**`listening_materials`**：`id TEXT PK`、`user_id`、`language`、`title`、`file_name`、`file_size`、`mime`、`ext`、`duration_sec`、`note 可空`、`created_at`。索引 `(user_id,language,created_at DESC)`。音频本体落 `$DATA_DIR/listening/<safeUserId>/<uuid><ext>`。

### 3.4 仓储层函数速查（`repositories/voices.ts`）

均显式接 `userId + language` 并写进 WHERE：`listVoices` / `countVoices` / `getVoice` / `insertVoice` / `updateVoice` / `deleteVoice` / `setDefaultVoice`（事务维护单语种单默认）/ `getAssignments` / `setAssignments`（**校验目标音色必须属于本用户+本语种**）/ `getPrefs` / `setPrefs`。常量：`VOICE_SCENES`、`SCENE_LABEL`、`BCP47`、`SAMPLE_TEXT`。

`repositories/listening.ts`：`storagePathFor` / `listListeningMaterials` / `getListeningMaterial` / `saveListeningMaterial`（先写文件再插元数据，失败回滚删文件）/ `updateListeningMaterial` / `deleteListeningMaterial`；`userDir()` 把 userId 白名单化为 `[A-Za-z0-9_-]`。

### 3.5 服务层三条通道

**`edgeTts.ts`（local Edge）**：常量 `LOCAL_EDGE_BASE='local://edge'`、`LOCAL_EDGE_KEY='local-edge-tts'`（占位 Key 让前端"已配置"状态正确）、脚本 `scripts/edge_tts_synth.py`、venv Python `.voice-venv/bin/python`、`MAX_AUDIO_BYTES=20MB`、缓存上限 60。

- `resolvePython()`：`EDGE_TTS_PYTHON` → `.voice-venv/bin/python` → `python3`；
- `toRateArg(rate)`：`0.9 → "-10%"`；
- `synthesizeLocalEdge({voice,input,rate})`：音色名需匹配 `/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/`，文本截 3000 字，缓存键 `voice|rate|text`，spawn Python，stdout 即 mp3 二进制（**无 SSML**，输出 `audio/mpeg`）；
- `getEdgeTtsStatus(force)`：`--probe` 探活，进程内缓存 5 分钟；
- `EDGE_VOICES` 每语种硬编码一女一男（如 `en-US-AvaNeural`/`en-US-AndrewNeural`）。

**`voiceCatalog.ts`（总入口）**：

- `POPULAR_PRESETS`：每语种 3 条 browser + 2 条 cloud（默认 `gpt-4o-mini-tts` / `https://api.openai.com/v1`）+ 2 条 local Edge；
- `ensureVoiceSeed` / `enableLocalEdgeVoices` / `sealVoiceKey`；
- `discoverVoices(language)`：有 LLM 配置走 `chatJson()`（temp 0.8 / maxTokens 2200），异常回退内置目录；
- `synthesizeSpeech(voice,text,rate)`：`provider!=='cloud'` 报错 → 本地 Edge 分支 → 否则解密 Key、校验 `baseUrl ^https?://`、`POST ${baseUrl}/audio/speech`，`/mini-tts/i` 才附加 `instructions`，30s 超时，响应需 `audio/*`。

**`explainTts.ts`（讲解视频配音）**：脚本 `edge_tts_timeline.py`，stdout 一行 JSON `{audioBase64,boundaries,durationMs}`；`synthesizeWithTimeline` 默认 rate 0.92、缓存上限 80；`estimateDurationMs(text,language)` 按 4.2 字符/秒兜底。`resolvePython`/`toRateArg` 与 edgeTts 各写一份（已出现漂移）。

### 3.6 讲解视频与朗读的联动（⚠️ 有 Bug，见 §5 P0-1）

`services/explainVideo.ts` 的 `resolveVoice()`（第 98–116 行）试图从 `voice_assignments.article` 取音色，但**期待的是 Neural 音色名或 `local://edge:xxx` 前缀**；而 `setAssignments()` 实际存的是 **voice 记录 UUID**。结果该分支永远不命中，讲解视频配音**永远用语言默认值**，换音色不生效，缓存指纹也因 `voice` 恒定而不失效。

### 3.7 Python 环境与桥接脚本

`.voice-venv`：`pyvenv.cfg` 指向本机绝对路径 `/Users/zhua/.workbuddy/binaries/python/versions/3.13.12/bin`；`bin/python3` 是该路径的符号链接。已装 `edge-tts 7.3.1` + aiohttp 等。**无 requirements.txt / pyproject，被 `.gitignore` 忽略，`voice:setup` 装的是不锁版本的最新 edge-tts**。换机器基本必然要重装（见 §5 P0-4）。

两个 Python 脚本从 stdin 读 JSON `{input,voice,rate}`，走 `edge_tts.Communicate().stream()`：`edge_tts_synth.py` 只把 `type=='audio'` 的 chunk 写 stdout；`edge_tts_timeline.py` 额外收集 `SentenceBoundary|WordBoundary`（100ns ÷ 10000 = ms），输出 base64 音频 + 边界。

> 注意：`scripts/buildSpeechBlock.ts` 与 `scripts/fillListeningAudio.ts` 名字含 speech/listening，但**只是考试题库文本修复脚本，不产生任何音频**，别误认成合成链路。`server/src/services/XX0qD0UY` 是无扩展名残留文件，建议核对后清理。

---

## 4. 前端地图

### 4.1 Hooks

| Hook | 签名 | 职责 |
|---|---|---|
| `useSpeech.ts` | `useSpeech(lang: string)` | 底层浏览器语音合成队列引擎。返回 `{rate,setRate,speak,play,stop,speakingId,playing,supported,voiceOptions,voiceURI,setVoiceURI}`。见 §5 P0-3 回调 Bug。 |
| `useSpeaking.ts` | `useSpeaking(lang: string): SpeakingController` | 语音识别（`SpeechRecognition ?? webkitSpeechRecognition`）+ 可选录音（`MediaRecorder`）。返回 `{recognitionSupported,recorderSupported,active,elapsed,finalText,interim,confidence,audioUrl,error,start,stop,reset,clearAudio}`。 |
| `useVoicePlayer.ts` | `useVoicePlayer(scene: VoiceScene): VoicePlayer` | 业务朗读门面，按 scene 解析绑定音色，分派 browser / cloud 双通道，含云端失败回退系统音色。 |
| `useVoiceSystem.tsx` | `VoiceProvider` + `useVoiceSystem()` | 全局音色 Context（`App.tsx` 内、HashRouter 里）。`resolve(scene)` 回退链：assignment → 默认 → 首个。 |
| `voiceUtils.ts` | 纯函数 | `BCP47`、`SCENES`、`SAMPLE_TEXT`、`SCENE_LABEL`、`isLocalEdge`、`matchSystemVoice`（四级回退）、`NOVELTY`/`prettyName`（**与 useSpeech 内重复定义**）。 |

`useSpeech` 播放状态机：`play()` → 先 `synth.cancel()` 清场 → 90ms 喘息 → `pump()` 保持 ≤2 句在途 → `onend` 推进队列；音色评分靠硬编码正则（neural/google/premium 分级 + 语区加分），列表在 `voiceschanged` + 5 个硬编码定时器 `[80,240,600,1200,2400]ms` 时刷新。持久化 `localStorage['wb-speech-rate']` 与 `wb-voice:${lang}`。

`useVoicePlayer` 双通道：browser → `speech.play()`；cloud → 逐条 `api.synthesizeVoice()` → `new Audio(url)`，用递增 token 丢弃过期异步结果，失败时回退系统音色并从失败条续播。

### 4.2 组件 / 页面

- **`VoiceStudio.tsx`**（893 行，`/settings` 内）：音色库工作台，6 个区块——语种切换、本地 Neural 引擎状态/一键启用、试听语料+语速、四场景分配、音色列表（试听/默认/编辑/删除）、添加音色（system / popular / cloud 三 tab）。与 12 个 `api.*` 方法交互。自身持有三语种 `snapshot`，与全局 `VoiceProvider.data` 并存（见 §5 P1-3）。
- **`ReadingPlayer.tsx`**：精读/长难句/精听共用，两个 tab——文字朗读（`useVoicePlayer`）+ 真人媒体（`MediaPane` lazy 挂载）。
- **`ListeningMaterial.tsx`**（`/listening`）：上传/列表/播放/改名/删除听力材料；带鉴权下载为 Blob URL；`loadSeqRef` 丢弃过期加载结果。
- **`MediaPlayerDemo.tsx`**（`/media-player`）：并排两个 `MediaPane`，验证播放权协调的演示页。
- **`Practice.tsx`**（`/practice/:date/:taskId`）：口语练习，`useSpeaking` 转写追加到作答框，提交带 `durationSeconds`/`confidence`/`submissionSource:'speech'` 给 `api.gradePractice`。

### 4.3 播放器核心（`web/src/player/`）

- **`mediaCoordinator.ts`**：模块级单例，`registerMediaPlayer` / `claimMediaPlayback` / `releaseMediaPlayback` / `subscribeActiveMedia`，只协调"谁在播"，**不碰 speechSynthesis**。
- **`MediaPane.tsx`**：封装 `@waiyubaodian/hevc-player` SDK（`MediaPlayerView`），Handle `{play,pause,stop}`；`load→setVolume/setRate→claimMediaPlayback→play`；200ms 轮询 `getStats()`；`standalone`/`bare` 两种 UI；SDK 时间为**微秒**。`@waiyubaodian/hevc-player` 是本地 `file:../../2026-11-20-22-40-00/hevc-player-sdk` 软链，交接部署需确认路径存在。

### 4.4 API 与类型

`api.ts` 语音相关方法（基址 `/api`）：`voices` / `createVoice` / `updateVoice` / `deleteVoice` / `setDefaultVoice` / `setVoiceAssignments` / `setVoicePrefs` / `discoverVoices` / `importVoices` / `edgeTtsStatus` / `enableEdgeVoices` / `synthesizeVoice`（→ blob URL，调用方负责 revoke）/ `uploadListeningMaterial` / `downloadListeningMaterial` / `listeningMaterials` / `renameListeningMaterial` / `deleteListeningMaterial` / `explainSegmentBlob` / `gradePractice`。请求基建：`fetchWithAuth` 处理 raw body 与音频字节，401 时静默刷新重试一次；access token 只存内存。

`types.ts` 关键类型：`VoiceScene`、`VoiceProvider`、`VoiceSource`、`EdgeTtsStatus`、`VoiceItem`（22 字段，**无明文 Key**）、`VoicePreset`、`VoiceAssignmentMap`、`VoicePrefs`、`VoicesResponse`、`VoiceCandidate`、`VoiceDiscoverResponse`、`VoiceDraft`、`ListeningMaterial*`、`ReadingSegment`。类型债：`VoiceItem.pitch/volume`、`VoicePreset.highlight`、`VoicesResponse.scenes` 均无消费者。

### 4.5 浏览器 API 使用

SpeechSynthesis（朗读核心）、SpeechRecognition / webkitSpeechRecognition（`useSpeaking`）、Audio / `<audio>`、MediaRecorder + getUserMedia、URL.createObjectURL/revokeObjectURL、localStorage（rate/voiceURI）。**未使用**：MediaSource（H265 由 SDK 封装）、WebSocket（SDK 有但未启用）、MediaSession、AudioContext。

### 4.6 路由（`App.tsx`）

`/media-player`、`/listening`、`/settings`（含 VoiceStudio）、`/practice/:date/:taskId`、`/exams/:paperId/take`（`useVoicePlayer('listening')` + `MediaPane`）均为 lazy。`VoiceProvider` 包在 `HashRouter` 内；`<Routes key={planKey}>` 在切语种/换计划时整棵重挂载，会中断正在播放的语音（设计选择）。

---

## 5. 已知问题与技术债（本次改造的核心 backlog）

> 按优先级排列。每条含 **现象 / 根因 / 位置 / 建议修法**，可直接当任务卡用。

### P0 — 功能性缺陷 / 安全（必须先修）

**P0-1｜讲解视频换音色完全不生效**
- 现象：用户在音色库选了声音，讲解视频配音仍用语言默认音色；换音色不触发缓存失效。
- 根因：`resolveVoice()` 期待 `voice_assignments.article` 存 Neural 名 / `local://edge:xxx`，实际存的是 voice UUID，正则与前缀判断永不命中。
- 位置：`server/src/services/explainVideo.ts:98-116`；对照 `repositories/voices.ts` 的 `setAssignments` 与 `voiceCatalog.ts:315-318`。
- 修法：改为「assignment(UUID) → `getVoice(userId,language,id)` → `voiceId` / provider / baseUrl」解析，并把解析出的音色纳入 `fingerprint()`。

**P0-2｜合成端点无鉴权无限流，存在 SSRF / 成本风险**
- 现象：`POST /api/voices/:id/synthesize` 无 `requireAuth`、无 rate limit，`AUTH_REQUIRED` 默认 false；游客可反复触发 spawn Python / 外部请求。
- 根因：`baseUrl` 完全用户输入（仅校验 `^https?://`），服务端会向其 POST 并附带解密后的 Key。
- 位置：`server/src/routes/voices.ts`（synthesize 端点）、`services/voiceCatalog.ts` 的 `synthesizeSpeech`。
- 修法：端点级鉴权 + 按用户/IP 限流；`baseUrl` 白名单或拦截内网地址；限制并发 spawn。

**P0-3｜`useSpeech` 在"外部 cancel"时回调丢失、`playing` 卡死**
- 现象：外部直接调 `window.speechSynthesis.cancel()` 后，`onDone` 永不执行、`playing` 停在 true（ExamTake"停止"按钮状态错乱）。
- 根因：`onerror` 的 `canceled/interrupted` 分支只 `inflight--`，不 `settle()`。
- 位置：`web/src/hooks/useSpeech.ts:321-328`。
- 修法：统一走 `settle(false)`，由 `cancelledRef` 决定是否回调 onDone。

**P0-4｜Python 环境不可移植**
- 现象：换机器后本地 Neural 音色必然失效；`.voice-venv/bin/python3` 硬链到本机绝对路径，被 gitignore，无 requirements，`voice:setup` 不锁版本，`EDGE_TTS_PYTHON` 不在 `.env.example`。
- 位置：`.voice-venv/pyvenv.cfg`、`package.json:13`、`services/edgeTts.ts:resolvePython`、`services/explainTts.ts`。
- 修法：提供 `requirements.txt`/constraints 并锁版本；启动时自动校验环境并给可执行修复指引；把 `EDGE_TTS_PYTHON` 纳入 env schema 与示例。

**P0-5｜TTS 与媒体两套系统互斥不完整**
- 现象：TTS 朗读可与媒体/试听/录音/讲解音频同时出声。
- 根因：`mediaCoordinator` 只管 `MediaPane`，`speechSynthesis` 单例不在注册表；`ReadingPlayer.switchTab` 只处理 voice→media 单向。
- 位置：`web/src/player/mediaCoordinator.ts`、`ReadingPlayer.tsx`、`VoiceStudio.tsx`、`ExplainVideoPanel.tsx`、`Practice.tsx`。
- 修法：抽象统一"全局出声权" `claimAudio` 覆盖三套系统；媒体卸载时 `ctl.stop()`（`mediaCoordinator` 的 unregister 当前不 stop）。

**P0-6｜云端合成失败且无回退时仍执行 `onDone`**
- 现象：回退音色找不到时调用方误以为播放成功（ExamTake 已计入播放次数）。
- 位置：`web/src/hooks/useVoicePlayer.ts:117-137`。
- 修法：失败分支显式 return / 抛结构化错误，不触发成功回调。

### P1 — 健壮性 / 状态管理

**P1-1｜Edge TTS 非官方接口，无后端自动故障转移**：微软随时可能 403/握手失败，当前仅中文提示 + 前端降级；`EDGE_VOICES` 硬编码，音色下线需发版。建议 `edge_tts.list_voices()` 动态拉取 + 服务端重试/切换通道。
**P1-2｜缓存薄弱**：`Map` 按插入顺序 FIFO（注释写 LRU 但未刷新命中顺序），进程重启全丢；`resetEdgeTtsStatus()` 清空所有用户缓存；无磁盘/共享缓存。建议真 LRU + 持久化 + 分用户键。
**P1-3｜无并发控制 / 输出截断风险**：每次试听 spawn 独立 Python 进程，无队列与上限；stdout 超 20MB 后丢 chunk 却仍可能当成功返回半个 mp3（`explainTts` 24MB 同理）。建议并发信号量 + 截断检测报错。
**P1-4｜完全没有 SSML**：`style`/`persona` 只用于展示，无法控制停顿/重音/多音字/数字读法——语言学习场景的明显能力缺口。建议引入 SSML 构造层。
**P1-5｜Range 头声明但未实现**：`GET /listening/.../file` 设了 `Accept-Ranges` 却不解析 `Range`、不返 206/`Content-Range`，长音频拖拽退化为整段下载。
**P1-6｜"音色/语速"两套持久化打架**：`useSpeech` 写 localStorage，`useVoicePlayer` 挂载时用后端 `prefs.globalRate` 覆盖，`setRate()` 只写后端。建议以服务端 prefs 为唯一真源。
**P1-7｜`useVoiceSystem` context value 未 `useMemo`**，任何 state 变化让所有 consumer 重渲染；`useVoicePlayer.playCloud` 依赖混用 `speech` 对象与 `speech.play/stop`，回调频繁重建。
**P1-8｜`VoiceStudio.snapshot` 与全局 `data` 双状态**，靠 `response.language === planLanguage` 判断刷新，跨语种编辑会不一致；`previewId` 用 name 判重（不唯一）；`stopPreview()` 泄漏 blob URL（未 revoke）。
**P1-9｜云端链路串行无缓存**：逐条先合成再等播放，首字延迟高，同句重复请求。建议按 `voiceId+text+rate+lang` 缓存 blob + 预取。
**P1-10｜`useSpeaking` 生命周期缺口**：`onend` 不停 recorder/stream（麦克风常开）；`start()` 无并发保护（连点双实例）；`reset()` 不清 `audioUrl`；`confidence` 常为 0/1 却当有效数据提交；静音后无自动续听。

### P2 — 体验 / 清理项

- `ListeningMaterial`：300MB 上限只写文案无前端校验；扩展名可伪造（应校验 MIME/魔数）；无分页/搜索；原生 `confirm`。
- 魔法数字散布：`RATES` 在 `ReadingPlayer`(0.7/0.85/0.9/1/1.15) 与 `VoiceStudio`(0.7/0.8/0.9/1/1.15) 不一致；`local-edge-tts`、`https://api.openai.com/v1`、name 截断 40、sampleText 截断 600 全硬编码。
- `useVoicePlayer.supported` 对 cloud 硬编码 `true`；错误只有字符串，无结构化错误码，UI 无法区分"需重试/需配 Key/引擎 403"。
- `NOVELTY` 正则与 `prettyName()` 在 `useSpeech.ts` 与 `voiceUtils.ts` 各一份，易漂移。
- 讲解视频仓储硬编码 `<projectRoot>/.data/explain-video`，不读 `DATA_DIR`，改目录后与听力音频分离。
- `discoverVoices()` 走全局 `LLM_TIMEOUT_MS`（90s），阻塞感强，应单独设超时。
- 数据库约束弱：`voices` 无 `(user_id,language,name)` 唯一约束（导入去重仅应用层 Set，有并发竞态）；`voice_assignments.voice_id` 无外键。
- `services/XX0qD0UY` 残留文件待核；`build:speech`/`fill:audio` 名不副实。
- 本地 `file:` SDK 依赖（`hevc-player`、`explain-video`）部署时需确认相对路径存在。

---

## 6. 建议改造路线图

| 阶段 | 目标 | 涵盖任务 | 出口条件 |
|---|---|---|---|
| **S1 止血** | 修功能性 Bug 与安全风险 | P0-1、P0-2、P0-3、P0-6 | typecheck 绿；讲解视频换音色实测生效；synthesize 需鉴权；外部 cancel 后回调正常 |
| **S2 统一** | 建立全局音频仲裁 + 环境可移植 | P0-4、P0-5、P1-5、P1-10 | 任一时刻只有一个音源出声（朗读/媒体/录音/试听/讲解）；换机器 `voice:setup` 可复现 |
| **S3 增强** | 缓存/并发/SSML/体验 | P1-1~P1-4、P1-6~P1-9、P2 前半 | LRU+持久化缓存、SSML 停顿控制、语速单源、试听无泄漏 |
| **S4 清理** | 技术债收尾 | P2 后半、残留文件、约束、文档同步 | 无重复工具实现、约束补全、README/HANDOVER 同步 |

> 建议顺序理由：P0 是"用户可感知的错误 + 公网部署风险"，必须先于任何增强；S2 的统一仲裁是后续一切语音体验的地基，应在加功能前完成。

---

## 7. 验收清单

改完后按此逐条验收（对应 `README.md` 与 `HANDOVER-AUTH.md` 的回归要求）：

1. `npm run typecheck` + `npm run build` 全绿；`npm run check:auth` 不回归。
2. **音色库**：三语种各自 seeding、新增/编辑/删除、设默认、场景绑定、导入候选、Edge 一键启用均正常；`apiKey` 不明文出现在任何响应。
3. **三条通道**：browser 朗读队列（连续多句、停止、变速）；cloud 合成（`new Audio` 播放、失败回退系统音色）；local Edge（status 探活、合成返回 mp3）。
4. **讲解视频**：在音色库把 `article` 场景换成非默认音色 → 重新生成 → 实际配音音色随之变化（P0-1 回归点）。
5. **听力库**：上传 → 列表 → 带鉴权下载播放 → 改名 → 删除（元数据与磁盘文件同步清除）；大数据与非法扩展名被拒。
6. **全局互斥**：同时触发朗读/媒体/试听/录音/讲解，任意时刻只有一个在出声；切 tab / 卸载后不再残留声音（P0-5 回归点）。
7. **安全**：未登录（或关闭 `AUTH_REQUIRED`）时 synthesize 被拒；构造内网 `baseUrl` 被拦；高频调用被限流（P0-2 回归点）。
8. **环境**：在干净机器执行 `npm run voice:setup` + 一键启用本地音色可成功；`EDGE_TTS_PYTHON` 可被 env 覆盖。
9. **数据隔离**：不同账号（如 `bestfancy` / `teacher01`）的音色、场景绑定、听力材料互不可见。

---

## 8. 特别提醒（别踩）

1. **先处理未提交文件**（§1.5）——6 个语音核心文件还是新增状态。
2. **Node 用 `/usr/local/bin/node`**（§1.2），否则 `better-sqlite3` 直接崩。
3. **`build:speech` / `fill:audio` 不产音频**，是题库文本修复脚本。
4. **Edge TTS 是非官方接口**，任何"永久可用"的假设都不成立，务必保留回退通道。
5. **`synthesizeVoice` / `explainSegmentBlob` 返回的是 blob URL**，调用方必须 `URL.revokeObjectURL`，否则内存泄漏。
6. **`@waiyubaodian/hevc-player` 与 `@waiyubaodian/explain-video` 是本地 `file:` 软链**，路径在 `package.json`，部署/换机需确认。
7. **`serviceWorker`/SDK 内联 WASM 体积大**，播放器入口已做 `lazy`，新增入口请沿用。
8. **`VoiceProvider` 必须等登录态恢复完再取音色库**（`useVoiceSystem.tsx` 里的 `authReady` / `userId` 闸门，2026-11-27 修复）。React 子组件 effect 先于父组件执行，去掉闸门会让 `/api/voices` 抢在 `AuthProvider` 静默刷新之前发出、以游客（`local`）身份拿到**别人账号的音色 id**；登录态落定后这些 id 在当前账号下不存在，朗读合成 404「音色不存在或不属于当前语种」并回退系统音色——表现出来就是「每次刷新页面都要去设置里再点一次一键启用」。同理，`useVoicePlayer` 的 404 自愈（重拉快照后按场景重绑）也不要删。

---

*本交接文档基于对 `server/src` 与 `web/src` 语音相关全部文件的逐行调查，以及 `.data/app.db` 实测数据整理。调查为只读，未改动任何源码或数据。*
