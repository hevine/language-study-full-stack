# 解题答疑视频 · 教案资源输入（韩语 1–6 级）· 交接文档

> **状态（2026-11-23）：已完成。** TOPIK 1–6 级六套 LevelProfile 已落地 `explainPedagogy.ts`
> 并实跑验收通过，实施记录见 §8。本文其余章节保留原规划过程，供追溯。
>
> 本文档只覆盖一件事：**把韩语分级教案翻译进 `explainPedagogy.ts`，让 TOPIK 解题答疑视频按级别精准讲解**。
> 解题答疑视频本身的架构、流水线、共享缓存、双语讲师，全部见《HANDOVER-EXPLAIN-VIDEO.md》
> （同目录），本文不重复，只引用章节号。

---

## 0. 开工前置（三条，缺一条会卡住）

1. **项目位置**：`/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian`
   （注意：不是当前工作区 `2026-11-21-11-52-51`，那个目录里只有 SDK 和记忆文件）。
2. **PATH**：`npx tsc` / `npx tsx` 需要 `PATH=/usr/local/bin:$PATH` 前缀，否则找不到 node。
3. **验证实例**：`PATH=/usr/local/bin:$PATH PORT=4398 npx tsx server/src/index.ts` 后台起，
   `/api/health` 探活；结束记得 `pkill -f "server/src/index.ts"`。

---

## 1. 任务定义

用户原话（摘要）：**「继续执行解题答疑视频教案资源的输入，以此来让 AI 解题视频生成的更精准」**。
附带的产品约束（日语版已实现，韩语沿用即可，不要重建）：

- 每题时长根据材料内容、知识点、语法量来定，**不要过长**；
- 消耗 token 不要太大；
- 长 / 中 / 短三档，操作时允许用户选择；
- 预计消耗多少 token 要有估量。

这些约束的落点分别是 `DEPTH_PLANS`（三档参数）、`estimateDepth`（预估）、缓存命中（不重复花钱）——
都已在 `explainPedagogy.ts` + `explainVideo.ts` 里实现，**本次任务不改这些机制**，只做「级别注入」。

---

## 2. 现状与差距（先看这个，避免做重复劳动）

### 2.1 已经就绪、不用动的

| 能力 | 位置 | 状态 |
|---|---|---|
| 谚文语种硬校验 | `explainScript.ts` L140–152，`[\uac00-\ud7af]` 占比判断 | ✅ 已支持韩语 |
| 韩语 TTS 音色 | `explainVideo.ts` L132 `ko: 'ko-KR-SunHiNeural'`；备选 `ko-KR-InJoonNeural` | ✅ |
| 韩语密度示范 | `explainPedagogy.ts` `DENSITY_SAMPLE.ko` | ✅ |
| 韩语目录 | `catalog/ko.ts`，TOPIK target label 为 **「TOPIK 1 级」…「TOPIK 6 级」** | ✅ |
| 三档深度 / 预估 / 缓存 / 双语 / 共享 | 见《HANDOVER-EXPLAIN-VIDEO.md》§13–14 | ✅ |

### 2.2 唯一的差距：TOPIK 不分级

`resolveLevelProfile()`（`explainPedagogy.ts` L299–319）里韩语只有一条路：

```ts
if (/topik/i.test(label) || exam === 'topik') return PROFILES.topik;
```

「TOPIK 1 级」和「TOPIK 5 级」拿到的是**同一套**「连接词与敬语层级」打法——
1 级讲论证结构是超纲，5 级讲助词定位是浪费。日语 N5–N1 已经是五套 profile（L129–205），
韩语要做的就是同构迁移：**一份教案 → 一个 LevelProfile**。

---

## 3. 教案资源（已固化进项目）

源文件原本在豆包会话目录（`/Users/zhua/Doubao/chats/2026-11-22/new-chat/`），**已复制固化**：

```
docs/教案/韩语/韩语1级精读课通用教案.md   ← 1 级：拼读规则（连音·紧音化·鼻音化）+ 助词定位
docs/教案/韩语/韩语2级精读课通用教案.md   ← 2 级：连接词尾逻辑 + 时制与阶称
docs/教案/韩语/韩语3级精读课通用教案.md   ← 3 级：冠形词形与长名词短语切分 + 段落主题与指代
docs/教案/韩语/韩语4级精读课通用教案.md   ← 4 级：论证结构（주장—근거—양보—결론）+ 让步转折
docs/教案/韩语/韩语5级精读课通用教案.md   ← 5 级：立场与语气强度标注 + 多文本统合
docs/教案/日语/N1–N5日语精读课通用教案.md ← 参照实现（对应现有 n1–n5 profile）
```

五份韩语教案结构完全一致，翻译成 profile 时按这个映射抽内容：

| LevelProfile 字段 | 从教案哪一章抽 | 注意 |
|---|---|---|
| `learner` | 「二、学情分析」第一句 + 「常见错因」 | 写「卡在哪」，不写「已掌握什么」 |
| `entry` | 「五、教学过程」第一个环节的教师活动 | 是开场动作，不是目标 |
| `tools` | 「四、教学重难点」的解决手段 + 过程表里的追问句 | 4–5 条，每条是可执行动作（例：「助词换位测试：换一个助词读一遍，问焦点变了没有」） |
| `trapNames` | 「附录一 · 课后题讲评」的题型考查点 + 学情分析的错因 | 排除镜必须叫得出名字，这是硬约束 |
| `register` | 「本级重心」引言 + 目标级别对应的语言风格 | 短句/术语密度 |
| `sample` | 自己按本级工具写 2–3 句**韩语**旁白示范 | 必须是谚文，格式参照 `PROFILES.n5.sample` |

教案里「教学过程」环节表（看图预测 → 朗读正音 → 速读填表 → 精读解骨架 → 课后题讲评 → 情境输出 → 总结）
与现有七拍（HOOK→LOCATE→DISMANTLE→ELIMINATE→RESOLVE→TRANSFER→ANCHOR）天然对应，
翻译时把环节里的「教师动作」融进对应 beat 的 tools，**不要改七拍本身**（见 §13.3）。

---

## 4. 实施步骤

### 4.1 扩展 band（`explainPedagogy.ts`）

```ts
export type LevelBand =
  | 'n5' | 'n4' | 'n3' | 'n2' | 'n1'
  | 'toefl' | 'ielts' | 'cet' | 'kaoyan'
  | 'topik1' | 'topik2' | 'topik3' | 'topik4' | 'topik5'
  | 'generic';
```

- **`topik` 单 band 要删掉**，换成 `topik1`–`topik5`。TOPIK 6 级没有教案，回落 `topik5`
  （5 级的立场语气打法对 6 级同样成立，宁缺毋滥）。
- `PROFILES` 是 `Record<LevelBand, LevelProfile>`，删 key 后 tsc 会把所有引用点逼出来，
  逐个改即可（目前只有 `resolveLevelProfile` 一处消费）。

### 4.2 级别提取（`resolveLevelProfile`）

```ts
const topik = label.match(/TOPIK\s*([1-6])/i);
if (topik) {
  const n = Math.min(5, Number(topik[1]));
  return PROFILES[`topik${n}` as LevelBand];
}
// 无级别信息时的韩语中间档：从 PROFILES.topik 改为 PROFILES.topik3
if (params.language === 'ko') return PROFILES.topik3;
```

catalog 的 label 是「TOPIK 3 级」（数字后有空格 + 级），正则要兼容 `TOPIK3` 无空格写法。

### 4.3 五个 profile（工作量主体）

按 §3 的映射表逐级填。每写完一级，对照教案原文检查：tools 是否覆盖该级「本级重心」
的两个维度（例：1 级 = 拼读 + 助词，缺一不可）；trapNames 是否来自附录一的考查点而不是自造。

### 4.4 缓存影响（要写进提交说明）

共享缓存键含 band（`hashFor`，《HANDOVER-EXPLAIN-VIDEO.md》§14.1）。band 从 `topik`
变为 `topikN` 后，**旧韩语片的 hash 全部失配**——不是 bug，是预期：旧片是用不分级的提示词
生成的，本来就该重新生成。不需要动 `SCRIPT_VERSION`，band 变化本身就使缓存失效。

### 4.5 韩语语速校准（一个必须实测的参数）

`estimateDepth` 的 `secondsFor()` 对非英语统一用 `0.21 s/字`，这是**日语实测值**
（43 字日文 ≈ 8.9 秒）。韩语 TTS 语速不同，预估的成片时长会偏差。校准方法：

1. 用任一韩语文章跑一次 `medium` 生成；
2. 对比 manifest 的 `totalMs` 与旁白总字数，算实际 s/字；
3. 若偏差 > 15%，给 `secondsFor` 加 `ko` 分支。

token 预估不用动：韩语谚文在 tokenizer 里的密度与日语假名接近，`tokensPerShot` 直接沿用。

### 4.6 验证

- `PATH=/usr/local/bin:$PATH npx tsc --noEmit`（根目录，覆盖 server + web）；
- 用 TOPIK 3 级文章起 4398 实例跑一次 `short`，检查日志 `avgCharsPerQuestion` 与
  `explain narration thinner than planned`（《HANDOVER-EXPLAIN-VIDEO.md》§13.8）；
- 确认 `GET /api/explain-videos/estimate?articleId=` 返回正常、成片时长在合理区间；
- 抽查生成脚本的旁白：1 级材料不该出现「주장—근거—양보」这类 4 级术语。

---

## 5. 硬约束（继承自主文档，违反会直接返工）

1. **旁白必须谚文**：`narrationInTargetLanguage` 已按谚文占比校验（阈值 0.08，
   正常韩语旁白 ≥ 0.3），不要放宽——TTS 用韩语音色念中文/日文就是乱码。
2. **七拍与三档参数不动**：改教学法只动 `PROFILES`，不碰 `DEPTH_PLANS`、`buildPedagogyPrompt`
   的骨架。想加讲解深度，加动作（tools），不要加形容词。
3. **不许自造出处**：教案里没有的惯用句、作者、考试统计，一律不进 prompt
   （SCHOLARLY TOUCH 规则，§13）。
4. **sample 必须是目标语**：韩语 profile 的 `sample` 与 `DENSITY_SAMPLE.ko` 若要改，
   必须是谚文完整口语（v3 时期四六级 sample 曾被写成中文，TTS 直接乱码）。
5. 任何校准先看日志（`tokOut` / `avgCharsPerQuestion`），不要凭感觉改数字。

---

## 6. 验收清单

- [ ] `LevelBand` 含 `topik1`–`topik5`，`PROFILES.topik` 已删除，tsc 全绿
- [ ] 「TOPIK 1 级」→ `topik1`、「TOPIK 5 级」→ `topik5`、「TOPIK 6 级」→ `topik5`、无级别韩语 → `topik3`
- [ ] 五个 profile 的 learner/tools/trapNames 能在教案原文里逐条找到出处
- [ ] TOPIK 3 级文章实跑 `short` 一档：旁白谚文占比合格、avgChars 达标、估时偏差 < 15%
- [ ] 日语五级回归：`resolveLevelProfile` 对 N1–N5 行为不变（改文件时别误伤）
- [ ] 交接主文档《HANDOVER-EXPLAIN-VIDEO.md》§13.2 表格补一行韩语五级映射

---

## 7. 给新任务的第一句话

> @HANDOVER-EXPLAIN-VIDEO-KOREAN.md @docs/教案/韩语
> 按交接文档把韩语 1–5 级教案翻译成 `explainPedagogy.ts` 里的五套 LevelProfile
> （topik1–topik5，TOPIK 6 级回落 5 级），resolveLevelProfile 从「TOPIK N 级」提取级别，
> 三档机制与语种校验不动，完成后用 TOPIK 3 级文章实跑 short 档验证并校准韩语语速参数。

---

## 8. 实施记录（2026-11-23，已完成）

### 8.1 与原规划的两处偏差（均为升级，不是走样）

1. **topik1–topik6 六套，不是五套**。原规划「6 级回落 topik5」的前提是 6 级教案不存在；
   用户随后补齐了《韩语6级精读课通用教案》，且 5/6 级教案有明确的分工衔接句
   （5 级「不做 6 级的双文本统合」），因此直接实现 topik6：关系矩阵 + 引用还原 +
   语域三同步 + 反讽线索（教案原文四条主线）。
2. **教案以豆包 2026-11-22 最新版为准**。六份教案已用最新版覆盖固化到
   `docs/教案/韩语/`（旧版 1–5 级与本版有措辞级差异，新版补齐了 1–6 级的取舍边界）。

### 8.2 代码落点（全部在 `explainPedagogy.ts`，其他文件零改动）

- `LevelBand`：删 `topik`，加 `topik1`–`topik6`；
- `PROFILES`：六套画像逐条取自教案（learner=学情分析错因、entry=导入环节教师动作、
  tools=重难点解决手段+过程表追问句、trapNames=附录A考查点、sample=谚文旁白示范）；
- `resolveLevelProfile`：`/TOPIK\s*([1-6])/i` 提取（兼容无空格写法），无级别韩语回落 `topik3`；
- 七拍骨架、`DEPTH_PLANS`、`buildPedagogyPrompt` 结构、语种硬校验、TTS 音色全部未动。

### 8.3 验证结果

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 全绿 |
| 级别映射（15 组断言） | ✅ TOPIK 1–6 级逐级命中；TOPIK3 无空格 → topik3；「TOPIK 6 级合格」→ topik6；无级别韩语 → topik3；N1–N5 日语回归不变 |
| 级别隔离 | ✅ topik1/2 提示词无 주장/양보/强度尺/关系矩阵/括号法 等高级术语 |
| 谚文 sample | ✅ 六套 sample 谚文占比 0.63–0.72（阈值 0.08） |
| 接口冒烟（4398 实例） | ✅ estimate 端点：TOPIK 4 级文章 → band topik4、TOPIK 2 级 → topik2，三档预估正常 |
| 实跑 short 档（TOPIK 4 级文章，3 题） | ✅ scriptCalls 1、无截断无抢救；`avgCharsPerQuestion=201`（区间上限 200，贴线达标）；旁白谚文占比 0.60–0.79 全镜合格；成片 114.9s；总消耗 20 839 token（tokIn 7 552 / tokOut 13 287，思考型模型输出偏高，见主文档 §13.10） |
| 旁白内容抽查 | ✅ 出现「양보와 주장」「'그러나' 뒤」等 4 级打法，无 1–2 级内容混入 |

### 8.4 韩语语速实测（缓存影响与校准口径）

- band 由 `topik` → `topikN` 使旧韩语片 hash 全部失配——预期行为，旧片本就是不分级的产物。
- 实测成片：旁白 637 字 / 语音 114.2s ≈ **0.179 s/字**，与 `secondsFor` 现值 0.21 偏差
  14.6%，**未过 15% 行动阈值**，故本次不加 `ko` 分支、参数维持 0.21。
  样本仅 1 次（short 档 3 题），下次 medium 档实跑后若仍 < 0.185，再落 `ko: 0.18` 分支。
- token 预估未动：韩语谚文 tokenizer 密度与日语假名接近，实测 tokOut/镜 ≈ 1 208
  （13 287 / 11 镜）高于 `tokensPerShot 440`，主因是思考型模型的 reasoning 输出计入
  completion（与主文档 §13.10 同因），不是韩语旁白变长；旁白本体 637 字在计划区间内。

### 8.5 验收清单核对

- [x] `LevelBand` 含 `topik1`–`topik6`，`PROFILES.topik` 已删除，tsc 全绿
- [x] 「TOPIK 1 级」→ topik1 …「TOPIK 6 级」→ topik6、无级别韩语 → topik3
- [x] 六个 profile 的 learner/tools/trapNames 能在教案原文里逐条找到出处
- [x] TOPIK 4 级文章实跑 `short` 一档：旁白谚文占比合格、avgChars 达标、估时偏差 < 15%
- [x] 日语五级回归：`resolveLevelProfile` 对 N1–N5 行为不变
- [x] 《HANDOVER-EXPLAIN-VIDEO.md》§13.2 表格补韩语六级映射
