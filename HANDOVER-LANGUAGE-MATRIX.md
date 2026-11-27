# HANDOVER-LANGUAGE-MATRIX · en / ja / ko 三语功能矩阵

> **给谁读**：想知道「这门语言到底做到哪一步了」「这个功能能不能承诺给用户」的人。
> 只回答「完成了什么、没完成什么、为什么」，不讲怎么做（怎么做见 `HANDOVER-NEW-LANGUAGE.md`）。
> 基线：`main@92fac05` + 本次韩语接入（工作区未提交）。
> 核对方式：逐文件读过实现 + 真实起服务跑过三语链路（命令见 §6）。

---

## 0. 一句话结论

**三语在学习台（`server/src/agent`）里已经同级**：分词 / 句法 / 错因 / 音韵 / 等级 五件套各自有实现，四个场景全部 `ready: true`，主项目层的考纲、评分标准、词库、内容、TTS、ASR 也都在。

但「同级」指的是**同一条链路上都通**，不是**能力完全一样**：英语没有音高维度（不评语调）、日语不考写作、韩语没有词形还原和词级发音定位。这些差异都是刻意的，理由在 §4。

---

## 1. 总览矩阵

图例：`✅` 完成 · `△` 有实现但能力受限（见 §4）· `—` 不做（有明确理由）

### 1.1 学习台层（`server/src/agent`）

| 能力 / Port | 英语 en | 日语 ja | 韩语 ko |
| --- | --- | --- | --- |
| **分词** `TokenizerPort` | ✅ 空格 + 标点正则（`whitespace`） | ✅ kuromoji 形态素（`kuromoji`） | ✅ 어절 切分 + 조사/语尾剥离（`eojeol`） |
| 词形还原 `lemmatize` | △ 仅小写化 | ✅ 辞書形（kuromoji 给） | △ 不还原音变（갑니다→갑，非 가） |
| **句法** `SyntaxPort.parse` | ✅ 走 LLM，`tree` 范式 | ✅ 文节规则 + LLM 讲解，`chunk` | ✅ 어절/조사/语尾规则 + LLM 讲解，`chunk` |
| 母语迁移 `contrast` | ✅ LLM（中文母语者学英语） | ✅ LLM（汉字同形异义等） | ✅ LLM（조사/语体/收音） |
| **错因** `ErrorTaxonomyPort` | ✅ 14 类，正则高精度低召回 | ✅ 11 类，规则 + 分词结果 | ✅ 11 类，规则 + 收音判定 |
| **音韵** `PhonologyPort` | △ 节奏三维（无语调） | ✅ 节奏三维 + 抑扬 | ✅ 节奏三维 + 语调 |
| 语速口径 `rate.unit` | 词/分钟 | モーラ/分 | 音节/分 |
| 词级发音定位 `wordLevel` | ✅ 慢词检测（需词级时间戳） | — 空 | — 空 |
| 波形量 `prosody` | — 不挂 | ✅ `pitch` + `closures` | ✅ `pitch` |
| **等级** `LevelScalePort` | ✅ CEFR 6 档 | ✅ JLPT 5 档（N5→N1） | ✅ TOPIK 6 档（1급→6급） |
| 跨刻度换算 `toCommonScore` | 按档位序号均分（17/33/50/67/83/100） | 15/35/55/75/92 | 10/26/44/62/79/93 |
| 语言包 `lang.json` | ✅ `cefr` / 4 考试 | ✅ `jlpt` / 5 考试 | ✅ `topik` / 1 考试 |
| 错因目录 `errors.json` | ✅ 14 条 | ✅ 11 条 | ✅ 11 条 |
| 适配器代码量 | 448 行 | 1378 行 | 1368 行 |

### 1.2 四个场景的支持情况

| 场景 | requires | 英语 | 日语 | 韩语 |
| --- | --- | --- | --- | --- |
| `sentence-parse` 长难句拆解 | tokenize, syntax | ✅ 全考试 | ✅ 全考试 | ✅ 全考试 |
| `reading-explain` 精读讲解 | levelScale | ✅ 全考试 | ✅ 全考试 | ✅ 全考试 |
| `speaking-practice` 口语练习 | tokenize, phonology, levelScale | ✅ ielts / toefl | ✅ jlpt | ✅ topik |
| `writing-exam` 写作批改 | tokenize, syntax, errorTaxonomy, levelScale | ✅ ielts / toefl / cet6 / kaoyan | — 明确拒绝 | ✅ topik |

日语写作是**双层拦截**：`lang/ja/lang.json` 的 `unsupported.writing` 给话术（「JLPT 不考写作。要不要试试『句子升格』或『敬语改写』？」），`writing-exam/scene.json` 的 `lang.exams.ja = []` 让路由直接不派。两层都拦，是因为前者管「话术友好」，后者管「工具不给跑」。

### 1.3 评测覆盖（`npm run check:agent`，10/10 通过）

| 场景 | 用例数 | 实际构成 | 缺口 |
| --- | --- | --- | --- |
| `sentence-parse` | 4 | ja 2（s-001/002）、ko 2（s-003/004） | **无英语用例** |
| `writing-exam` | 5 | **真批改 3 条**：en 1（w-001）、ko 1（w-005）；ja 1（w-003，测的是「必须拒绝」）；另 2 条（w-002/w-004）其实测路由（误抢拦截、意图模糊反问） | ja 无批改（JLPT 不考写作，属刻意） |
| `reading-explain` | 2 | en 2（r-001 精读、r-002 句子级困惑不该被抢） | **无 ja / ko 用例** |
| `speaking-practice` | 0 | — | 需真实音频，未进离线评测 |

合计 **11 条**，`npm run check:agent` 11/11。

这是当前评测体系的真实状态：**链路都通了，但用例分布不均**。加语言时最容易漏的就是补对应用例，补了才知道是「真跑」而不是「只是登记」。

韩语批改用例（w-005）已经补上，它替掉了一直存在的隐性风险：假 LLM 原来对 `write.diff_review` 只返回一份写死的**英文** diff（`ruleId: 'sva'`），给韩语喂这条会让 G5 判不合规。现在 `harness.ts` 按用例语种造假模型（`makeFakeLlm(lang)` + `CANNED_DIFFS`），韩语样例的两条 ruleId（`sino-korean` / `translationese`）都落在 `lang/ko/errors.json` 里。

用例断言的东西值得记一下：正文里埋了 4 处确定性错误（`음악를` 助词 / `좋아요` 语体 / `됬` 拼写 / `살수있` 分写），规则必须全部命中；批改条目的 ruleId 必须可追溯（G5）；双通道分差要落在 12 分内（G3）。**变异测试确认过 G5 不是橡皮章**：把 ruleId 换成 `sva`，G5 立刻 fail 并列出「出现未知 ruleId」。

### 1.4 主项目层（`server/src`，非 agent）

| 模块 | 英语 | 日语 | 韩语 |
| --- | --- | --- | --- |
| 考纲目录 `catalog/` | `en.ts` | `ja.ts` | `ko.ts`（`KO_LEVELS` ko0–ko6、`KO_EXAMS` topik） |
| 评分标准 `domain/rubrics.ts` | 托福 / 雅思 / 六级 / 考研 | JLPT | `TOPIK_WRITING` / `TOPIK_SPEAKING`（0–100 制） |
| 语种兜底 `BY_LANGUAGE` | ✅ | ✅ | ✅（`ko: { writing: TOPIK_WRITING, speaking: TOPIK_SPEAKING }`） |
| 分级词库 | `toeflLexicon.ts` | `jaLexicon.ts` | `koLexicon.ts`（精选精讲，非全量） |
| 内置文章库 | `library.en(.extra).ts` | `library.ja(.extra).ts` | `library.ko(.extra).ts` |
| 内置写作/口语题 | `prompts.ts` 英文题库 | `JA_WRITING` / `JA_SPEAKING` | `KO_WRITING` / `KO_SPEAKING` |
| 升级自测题库 | `data/exams/en.ts` | `data/exams/ja.ts` | `data/exams/ko.ts` |
| TTS 音色 | Edge 英语音色 | Edge 日语音色 | `ko-KR-SunHiNeural` / `ko-KR-InJoonNeural` |
| ASR | SenseVoice 号池 | 同（+ 禁 emoji） | 同（+ 禁 emoji） |
| 前端主题 | `blue` | `pink` | `teal` |
| 学习路径文案 `content/paths.ts` | ✅ | ✅ | ✅ |

主项目层的完整改动清单见 `HANDOVER-LANGUAGE.md` §3 —— 那张表是加第 4 门语言时真正的工作量所在（20 余张映射表 + 11 处 zod 枚举 + 6 处提示词分支 + 1 个迁移）。

---

## 2. 英语完成度细节

**分词**：`/[A-Za-z][A-Za-z'’-]*|\d+(?:[.,]\d+)?/g`。够用且确定，不引入词典。
**规则扫描**：14 类，`EN_CHECKS` 表驱动。设计取向是**高精度、低召回** —— 只报几乎不会误判的模式（如 `people is`、`students believes`），宁可漏也不误报，因为误报会直接毁掉学生对系统的信任。
**句法**：完全走 LLM，出口收口到统一 `SyntaxNode` IR。
**音韵**：`scoreProsody()` 纯函数，消费 `ProsodyMeasurement`（wpm / 停顿 / 发声比 / 词级时间戳）。三个维度 pace / pausing / continuity。**不评语调** —— 英语是语调语言，但整段音高跨度对英语的信息量远不如日语/韩语，挂了只会让人猜这个数字是干什么的。
**等级**：代理指标（平均句长 + 平均词长），`toCommonScore` 按档位序号均分。注释里已注明「M1 换词表覆盖算法」。

---

## 3. 日语完成度细节

**分词**：kuromoji，带 `lemmatize`（辞書形）与读音（片假名），这是振假名的数据来源。
**句法**：文节切分靠规则（自立語 + 助詞/助動詞），讲解交给 LLM。**结构算出来，讲解才交给模型** —— 同一句话每次切得一模一样。
**错因**：11 类，含 `kanji-homograph`（漢字同形异义，中文母语者的核心干扰）、`keigo`（敬语）、`transitivity`（自他动词）。
**音韵**：モーラ计时。语速区间 420–480 モーラ/分（NHK ニュース播报参照）。四个维度 pace / pausing / continuity / **pronunciation（抑扬）**。`closures` 只报「有没有测到闭塞」，不当促音计数用（60–220ms 短闭塞在正常日语里到处都有）。
**等级**：JLPT 5 档，`JLPT_COMMON = { N5:15, N4:35, N3:55, N2:75, N1:92 }`。
**写作**：不支持，见 §1.2。

---

## 4. 韩语完成度细节 + 三语刻意差异

### 4.1 韩语做了什么

**分词**：不装形态素分析器（mecab-ko 要绑 C++ 与 100MB 词典，在这个进程里不划算），做三件确定的事：

1. **어절 切分**：空格 + 标点就是词边界，不需要词典，结果稳定；
2. **尾部 조사 剥离**：조사 是封闭类（约 45 条），穷举得起，而且**决定了成分角色**（주격/목적격/관형격…）；
3. **语尾分类**：终结 / 连接 / 冠形，再叠时制与语体（합니다 / 해요 / 해 / 한다）——同样封闭，同样穷举得起。

地基是 **한글 收音判定**：`(code - 0xAC00) % 28`，0 = 无收音，8 = ㄹ，17 = ㅂ。조사 的字形（`-이/가`、`-을/를`、`-은/는`、`-과/와`、`-으로/로`）与语尾的形态（`-습니다/ㅂ니다`、`-입니까/ㅂ니까`）全部由前一个音节有没有收音决定。这一条判错，整个规则体系全错。

**句法**：어절 → 成分（주어/목적어/서술어/수식어）→ 子节点（冠形节 `산` 挂在 `책은` 下）。收缩形冠形节（`산` = `사`+ㄴ、`한` = `하`+ㄴ）需要还原词干再查常用用言表。
**错因**：11 类 —— `particle` / `ending` / `register` / `honorific` / `spacing` / `tense` / `counter` / `orthography` / `word-order` / `sino-korean` / `translationese`。
**音韵**：音节计时，240–380 音节/分（新闻播报 330–380，教材朗读 280–330，学习者对话 180–260）。四维 pace / pausing / continuity / **intonation**。韩语不是声调语言，但句末语调承担疑问/陈述区分，中文母语者常把整句压平。
**等级**：TOPIK 6 档，`TOPIK_COMMON = { 1급:10, 2급:26, 3급:44, 4급:62, 5급:79, 6급:93 }`。指标里有一条**长 어절（≥4 音节）占比 ≥0.28 → +3**，这是汉字词密度的代理；没有它，经济评论那种满篇 `경제성장 / 구조적인` 的文本会被评成 3급。

### 4.2 韩语明确没做（写在 `ko.ts` 头部，避免被当成已完成）

| 没做 | 为什么 | 后果 |
| --- | --- | --- |
| 词干内部音变不还原 | 갑니다 的词干记作「갑」（가 + ㅂ），还原需要真正形态分析；半吊子还原会让学生看到不存在的词形 | `lemmatize` 返回词干而非原形 |
| 词性只到「体言/用言/修饰语」 | 再细就要词典；**错的词性标注比没有更糟** —— 学生会以为系统看懂了 | `pos` 字段只有三档 |
| **不规则活用还原不了** | ㅂ/ㄷ/ㅅ/ㄹ/르 不规则谓词的词干会退化成「看起来像名词」的东西 | 见下方实测，这是当前最值得补的一块 |
| **해요体收缩形 `-요` 不成词** | ㅏ/ㅓ 开音节词干 + 요（가요/만나요/봐요/해요）判不出语尾，落到「名词 + 补词」；`먹어요/좋아요` 正常 | 「합니다 体里混一句 가요」这类最常见的语体混用抓不到 |
| 无词级发音定位 | 收音/连音的对错要落在音节上，需要强制对齐 | `wordLevel: []` |
| 词库非 TOPIK 全量 | 精选精讲而非全表；各等级标注的是本库收录量 | 不承诺词表覆盖率 |

**不规则活用实测**（15 个常见词逐一跑 `analyzeKo`，不是推测）：

| 词 | 实际原形 | 现判定 | 错在哪 |
| --- | --- | --- | --- |
| 도와요 / 추워요 / 매워요 | 돕다 / 춥다 / 맵다（ㅂ不规则） | `체언`（名词） | 词性错，**且 confidence 仍是 high** |
| 몰라요 | 모르다（ㄹ不规则） | `체언` | 同上 |
| 지어요 | 짓다（ㅅ不规则） | `용언`，词干「지」 | `lemmatize` 给出「지다」 |
| 들어요 | 듣다（ㄷ不规则） | `용언`，词干「들」 | `lemmatize` 给出「들다」 |
| 공부합니다 | 공부하다 | `용언`，词干「공부합」 | `lemmatize` 给出「공부합다」 |
| 했어요 / 갔습니다 | 하다 / 가다 | 词干「했」「갔」 | `lemmatize` 给出「했다」「갔다」 |

判定正确的：`먹었습니다`、`읽었습니다`、`한국어를`、`재미있어서`（词干 + 다 正好对）、`학생입니다`（识别为系词）。

**要不要为这个装 mecab-ko**：暂不。原因与替代路径已单独记在 `HANDOVER-NEW-LANGUAGE.md` §11；一句话结论是「原生绑定不划算，真要上词典就用 wasm 版，且等『词汇本/查词』真的落地再上」。当前更该做的是**别让它自信地错**：`체언` + `confidence: high` 这个组合比「判不出来」更危险，值得先改成低置信度。

### 4.3 三语能力差异一览（哪些是刻意不同）

| 差异点 | 英语 | 日语 | 韩语 | 是缺陷还是设计 |
| --- | --- | --- | --- | --- |
| 语速单位 | 词/分 | モーラ/分 | 音节/分 | **设计**。用词/分描述日语，数字会小一半 |
| 语调维度 | 不评 | 抑扬（3–14 半音为自然） | 语调（3–12 半音为自然） | **设计**。英语整段音高跨度信息量低 |
| 促音/闭塞 | 不挂 | 挂 `closures` | 不挂 | **设计**。韩语没有促音，挂上去是噪音 |
| 词形还原 | 小写化 | 辞書形 | 不还原音变 | 能力边界，非设计选择 |
| 写作场景 | 支持 | **拒绝** | 支持 | **设计**。JLPT 不考写作 |
| 等级刻度 | CEFR 6 | JLPT 5 | TOPIK 6 | 客观事实 |

---

## 5. 三语共用、与语言无关的已完成能力

这些不在语言层，但三语都吃到了：

- **五关校验 G1–G5**：产物落地前的结构校验，`verifyPass` 在评测里可断言；
- **三类产物**：`syntax-tree` / `speaking-report` / `annotated-diff`；
- **场景守则** `rules/`：Port 无状态，每次 parse 传 `opts.rules`；
- **黑板 `ctx.bag`**：场景间传递中间结论；
- **run trace**：可回放、可续跑、成本归因；
- **ASR 转写 emoji 清洗**：SenseVoice 会吐出 emoji，已在转写出口统一过滤；
- **贴文本兜底**：没有音频时 `speak.asr` 记「贴的文本」，`basis: typed`、`prosody: false`，不编发音分。

---

## 6. 怎么自己复核

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian

# 1) 类型
PATH=/usr/local/bin:$PATH npx tsc --noEmit

# 2) 离线评测（10 条，假 LLM）
PATH=/usr/local/bin:$PATH npm run check:agent

# 3) 语种注册与 ready 状态
curl -s http://127.0.0.1:4411/api/agent/scenes | python3 -m json.tool
#    期望：en/ja/ko 全 ready=true，ko scale=topik、unsupported=[]

# 4) 主项目层语种贯穿
PATH=/usr/local/bin:$PATH npm run check:lang
```

**Node 版本坑**：`.node-version` 是 `24.12.0`，本机 PATH 默认 v22，`better-sqlite3` 会报 `NODE_MODULE_VERSION 137 vs 127`。所有命令加 `PATH=/usr/local/bin:$PATH`。

---

## 7. 如果现在就要给用户承诺，能承诺什么

**可以承诺**：三语的长难句拆解（结构可复现、每条结论可追到规则）、精读讲解、口语节奏评测（有音频时）、写作批改（英/韩）。

**不能承诺**：音素级发音准确度（θ 读成 s 看不出来）、词级发音定位（英/韩）、词形还原与完整词性（韩）、TOPIK 词表覆盖率、日语写作。
