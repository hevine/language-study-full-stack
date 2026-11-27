# 速查 · 接入一门新语种（一页版）

> 详细推理与踩坑见 `HANDOVER-NEW-LANGUAGE.md`；主项目层（命题/批改/试卷）见 `HANDOVER-LANGUAGE.md` §3。
> 本页只回答「动手时按什么顺序敲、每步怎么算过」。

## 0. 铁律

**`core/` 一行不改。** 验收：`git diff --stat server/src/agent/core/` 为空。
（唯一会破坏它的写法：在 `tools/` 或产物里出现 `if (lang === 'xx')`。）

## 1. 要动的文件（只有这些）

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 数据 | `lang/<code>/lang.json` | 刻度、考试、场景支持、分词器名 |
| 数据 | `lang/<code>/errors.json` | ruleId 白名单（G5 靠它判「有据可依」） |
| 实现 | `adapters/<code>.ts` | 五个 Port |
| 实现 | `adapters/units.ts` | 加一行 `spokenUnitCount` |
| 用例 | `scenes/<scene>/evals/core.jsonl` | 至少 2 条本语种用例 |
| 装配 | `adapters/inprocess.ts`、`standalone/index.ts`、`evals/harness.ts` | 各 1 个 `LanguagePorts` + 分派 |
| 枚举 | `lang/loader.ts:26`、`routes.ts:116,529` | `z.enum` 放开，否则请求 400 / 语言包静默跳过 |

## 2. 实现顺序（不能乱）

| # | 步骤 | 完成判据 |
| --- | --- | --- |
| 0 | **找确定性判据**：这门语言里什么不需要词典就能算？ | 写成适配器头部一段话（韩语=收音，日语=假名类别，英语=空格） |
| 1 | `tokenize` | 带 `start/end` 原文偏移；`lemmatize` 做不到就返回原样 |
| 2 | `level` | 拿**三段不同难度**真实文本（入门/教材/新闻）各跑一遍，档位单调 |
| 3 | `taxonomy` | 先写 errors.json 再写规则；14 错句命中 + **10 正确句零命中** |
| 4 | `phonology` | 无音频/样本短 → `null`；`rate.unit` 与 `prosody` 由语言声明 |
| 5 | `syntax` | 规则定结构（可复现），LLM 只做 `contrast`，失败当没有 |

## 3. 三处「由语言自己声明」的口径

| 口径 | 位置 | 写错的后果 |
| --- | --- | --- |
| 语速单位 | `units.ts` 的 `spokenUnitCount` | 用词/分描述日语，数字小一半 |
| 挂了哪些波形量 | `PhonologyPort.score` 返回 `prosody` | 产物里挂不参与评分的数字，用户问「这 87 分哪来的」 |
| 跨刻度换算 | `LevelScalePort.toCommonScore` | i+1 控密度、可行性测算全错 |

## 4. 场景支持怎么声明

```json
"scenes": { "supported": ["vocab","...","peripheral"], "unsupported": { "writing": "JLPT 不考写作。要不要试试「句子升格」？" } }
```
不支持 = **一句话 + 出口**，不是「不支持」三个字。
`scene.json` 的 `lang.exams` 里给空数组 = 明确不派；`["*"]` = 全认。

## 5. 验收（照着敲）

```bash
export PATH=/usr/local/bin:$PATH          # Node 24，否则 better-sqlite3 报 NODE_MODULE_VERSION
npx tsc --noEmit                          # 1 无输出
git diff --stat server/src/agent/core/    # 2 空
curl -s localhost:4411/api/agent/scenes   # 3 新语种 ready=true、scale 对、unsupported 对
npm run check:agent                       # 4 全过，且新增了本语种用例
npm run check:lang                        # 5 主项目层语种贯穿
```
外加手工三件：长难句（G1–G5）、写作（正确作文 **0 处**命中）、口语（纯文本不得有发音分）。

## 6. 六个「不要」

1. 不改 `core/`；2. 不写 `if (lang === 'xx')`；3. 没音频不编分数；
4. 不在工具层判语种（要什么就加 Port 字段）；5. 不给不支持的场景跑通用兜底；6. 不删 `.data/`。

## 7. 误报急救表（规则引擎的 bug 几乎全是误报）

| 症状 | 先查这里 |
| --- | --- |
| 名词被当成谓语 / 整句报语体混用 | 语尾与助词的**判定顺序**（先剥助词会把 `한국어` 剥成 `한국`+`어`） |
| 正确句被报错 | 短词匹配缺前后环视（`(?<![가-힣])…(?![가-힣])`） |
| 建议文案出现 `undefined` | `fix` 没收到捕获组（`...match.slice(1)` 忘了传） |
| 「原文片段」是整段开头 60 字 | `quote` 用了 `text.slice(0,60)`，应指向**冲突的那个词** |
| 疑问句被判「句子没说完」 | 语尾 `when` 收到的是整词，不是去掉语尾的词干 |
| 共动/命令句被算成 한다体 | 语尾表缺 `-ㅂ시다 / -읍시다 / -십시오`（它们属正式体） |
| 形容词被当名词（韩语） | 不规则活用（ㅂ/ㄷ/ㅅ/ㄹ/르）不在表里 —— 这是**已知边界**，要根治得上词典 |

## 8. 加语言前先问一句

**这门语言的「词」在这一层能确定到什么粒度？**
能确定到词 → 规则就够（韩语 어절 / 英语空格）。
确定不到 → 别硬切，上词典（日语 kuromoji），或者明确降级（`pos` 只到三大类、`confidence` 标 guess）。
**错的标注比没有更糟** —— 学生会以为系统看懂了。
