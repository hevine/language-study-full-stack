# HANDOVER-NEW-LANGUAGE · 接入一门新语种

> **给谁读**：要给这个产品加第 4、第 5 门语言（法语 / 德语 / 西班牙语 / 俄语 / 泰语 …）的人。
> 以本轮韩语接入（`adapters/ko.ts` + `lang/ko/`）为范例，写清**顺序、判据来源、验收线、踩过的坑**。
> 姊妹文档：`HANDOVER-LANGUAGE.md` 管**主项目层**（计划/命题/批改/试卷/语音），本文管**学习台层**（`server/src/agent`）并以它为主线，§9 只做交叉引用。
> 项目根目录：`/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian`（**不是**会话 workspace）。

---

## 0. 一条铁律，先记住

```
core/ 下一行不改。
```

`server/src/agent/core/` 里是 router / planner / executor / verifier，它们**只认 Port，不认语言**。验收线就是：加完一门语言，`git diff --stat server/src/agent/core/` 必须是空的。

这条线只在一种情况下会被破坏：你在 `tools/builtin.ts`、`protocols.ts`、产物渲染里写了 `if (lang === 'ja')`。这轮韩语接入时 `builtin.ts` 里就有这么一处（`ctx.lang === 'ja' && measurement.pitch ? ...`），最后是靠**给 Port 加字段**解决的，不是靠再加一个 `if (lang === 'ko')`。详例见 §6。

---

## 1. 心智模型：两棵树 + 四处装配

```
        ┌─ 数据（语言差异在这里）
        │    lang/<code>/lang.json     ← 声明：刻度、考试、场景支持、分词器名字
        │    lang/<code>/errors.json   ← 错因目录：ruleId 白名单（G5 校验靠它）
        │
语言 ───┤
        │    adapters/<code>.ts        ← 实现：五个 Port 的具体算法
        └─ 装配（改四行）
             adapters/inprocess.ts    ← 主项目内嵌运行
             standalone/index.ts      ← 独立端
             evals/harness.ts         ← 离线评测
             lang/loader.ts           ← zod 枚举放开 code
```

运行期数据流：

```
/api/agent/scenes
  ├─ loadLanguagePacks()  扫描 lang/*/lang.json
  └─ ready: Boolean(deps.language(pack.code))
        │
        └─ 返回 null 时，该语种在 UI 上是「未接通」，场景一律拒绝
           返回 LanguagePorts 时，四场景全部可跑
```

**`ready` 的判据只有一条**：`deps.language(code)` 返回非 null。所以「加了 `lang/<code>/` 目录但没实现 Port」= UI 上仍然不可用（`ready: false`）。这是刻意的，避免「看起来支持、跑起来报错」。

---

## 2. Port 契约：五个接口，逐条说清

`server/src/agent/ports.ts`。**方法签名不能改**，要加能力只能在返回对象里加可选字段（§6 就是这么做的）。

### 2.1 `TokenizerPort` —— 一切的底座

```ts
interface TokenizerPort {
  readonly lang: LangCode;
  tokenize(text: string): Promise<LangToken[]>;
  lemmatize(token: LangToken): Promise<string>;
}

interface LangToken {
  surface: string;   // 原样
  base?: string;     // 原形（英语 lemma / 日语辞書形 / 韩语词干+다）
  reading?: string;  // 读音（日语假名 → 振假名的数据来源）
  pos?: string;      // 词性（UPOS 或简写）
  start: number;     // 原文字符偏移，产物要高亮必须准
  end: number;
}
```

**注意 `start/end`**：这是原文字符偏移，不是 token 序号。产物里「点击成分高亮原句」全靠它。切分时千万别用 `text.split(' ')` 之后重新拼偏移 —— 标点、全角空格、连续空格全都会错位。

**`lemmatize` 做不到就返回原样，不要抛错。** 韩语这里只做到「词干 + 다」（먹었어요 → 먹다），音变不还原，注释里写清了原因（半吊子还原会让学生看到不存在的词形）。

### 2.2 `SyntaxPort` —— 结构算出来，讲解交给模型

```ts
interface SyntaxPort {
  readonly lang: LangCode;
  parse(text: string, opts?: { rules?: string }): Promise<{
    nodes: SyntaxNode[];
    summary: string;
    difficulty: number;   // 0–10
  }>;
  contrast(text: string, nativeLang: 'zh'): Promise<Array<{ point: string; note: string }>>;
}

interface SyntaxNode {
  id: string;      // 由适配器深度优先编号：n1 / n1.1
  role: 'head' | 'modifier' | 'subject' | 'predicate' | 'object' | 'particle' | 'clause' | 'other';
  text: string;
  surface?: string;  // 注音/原形（日语 furigana 走这里）
  note?: string;     // 该成分的教学提示
  children: SyntaxNode[];
}
```

三条硬要求：

1. **`id` 由适配器生成，绝不让模型生成** —— 模型会重号或编出不稳定的 id，前端 key 一冲突整棵树重渲染。
2. **`role` 只能取这 8 个值**。渲染层只认 role、不认语言。你的语言如果有 role 表达不了的东西（比如韩语的冠形节），用 `clause` + `children` 表达，不要去扩枚举。
3. **`parse` 优先确定性**。英语可以整棵树交给 LLM（`tree` 范式），但日韩都是「规则切分 + 规则定角色」→ 模型只负责 `contrast`（母语迁移解释），且**失败就当没有**（`try/catch` 包住，`points` 里规则部分照常返回）。

`opts.rules` 是场景守则原文 —— Port 本身无状态，但需要知道「这次按哪套规矩讲」。别把守则读进适配器。

### 2.3 `ErrorTaxonomyPort` —— ruleId 必须能在 errors.json 里查到

```ts
interface ErrorTaxonomyPort {
  readonly lang: LangCode;
  scan(text: string): Promise<Array<{
    ruleId: string;    // 必须来自 lang/<code>/errors.json
    quote: string;     // 原文片段，用于高亮
    problem: string;
    suggestion: string;
    severity: 'must-fix' | 'should-fix' | 'style';
  }>>;
  ruleIds(): string[];
}
```

**G5 校验靠 `ruleIds()` 判断「有据可依」**：`scan` 返回了 errors.json 里没有的 ruleId，产物会被判不合规。所以**先写 errors.json，再写规则表**，别反过来。

设计取向（英语那条注释值得抄过来）：**高精度、低召回**。只报几乎不会误判的模式，宁可漏也不误报 —— 误报会直接毁掉学生对系统的信任，而且「改了还是错」比「没提」更伤。

### 2.4 `PhonologyPort` —— 没有音频就返回 null，绝不编分数

```ts
score(input: {
  audioRef: string;
  transcript: string;
  target?: string;
  measurement?: ProsodyMeasurement | null;
}): Promise<null | {
  overall: number;
  dimensions: Array<{ id: string; score: number; note: string }>;
  wordLevel: Array<{ word: string; score: number; hint?: string }>;
  rate?: { value: number; articulation: number; unit: string; label: string };
  prosody?: { pitch?: PitchProfile; closures?: ClosureSpan[] };
}>
```

四个必须遵守的点：

| 点 | 规则 |
| --- | --- |
| 无音频 | `measurement` 为空 → 返回 `null`。教育产品宁缺毋假 |
| 样本太短 | 也要 `null`。英语 <8 词或 <2s；日/韩 <20 单位或 <2s。「20 个音节说 2 秒」什么结论都不成立 |
| `rate.unit` | **由语言自己声明**。拿「词/分钟」描述日语，用户看到的数字会莫名偏小一半 |
| `prosody` | 声明「这次评分真的用到了哪些波形量」。英语不挂、日语挂 `pitch + closures`、韩语挂 `pitch` |

### 2.5 `LevelScalePort` —— 刻度必须能互相换算

```ts
interface LevelScalePort {
  readonly lang: LangCode;
  readonly scale: string;    // 'cefr' | 'jlpt' | 'topik' | ...
  readonly bands: string[];
  estimateTextLevel(text: string): Promise<{ band: string; vocabCoverage: number; avgSentence: number }>;
  toCommonScore(band: string): number;   // 0–100，跨刻度换算
}
```

`toCommonScore` 是「英语 B2 换成日语大概 N3」这类问题的基础，也是 i+1 控密度的输入。**必须单调递增**，且两端不要用 0 / 100（留出「更低/更高」的空间）。现有三套参照：CEFR 按序号均分、JLPT `15/35/55/75/92`、TOPIK `10/26/44/62/79/93`。

`estimateTextLevel` 在 M0/M3 都是**代理指标**（句长 + 词长/音节长 + 结构复杂度），不是真词表覆盖。promise 出去之前想清楚：接口稳定，算法可以换。

---

## 3. 两个数据文件

### 3.1 `lang/<code>/lang.json`

```json
{
  "code": "ko",
  "name": "한국어",
  "script": ["hangul"],
  "tokenizer": "eojeol",
  "syntax": "chunk",
  "phonology": "syllable",
  "levelScale": { "id": "topik", "bands": ["1급","2급","3급","4급","5급","6급"] },
  "exams": ["topik"],
  "scenes": {
    "supported": ["vocab","grammar","sentence","reading","writing","speaking","exam","translation","peripheral"],
    "unsupported": {}
  }
}
```

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `code` | **zod 枚举 `['en','ja','ko']`，必须放开** | `lang/loader.ts:26`。这是唯一硬编码语言列表的地方 |
| `name` | 任意 | 用**母语名**（`한국어` 而不是「韩语」），UI 上作为语言标签 |
| `tokenizer` / `phonology` | 自由字符串 | 只是标识，实现由 `adapters/` 按名字装配，**加载器不读它做分支** |
| `syntax` | `'tree' \| 'chunk'` | 英语 `tree`（整棵交 LLM），日韩 `chunk`（规则切分）。决定 `SyntaxPort` 内部形状 |
| `levelScale.id` / `bands` | 非空 | 与 `LevelScalePort.scale` / `bands` 保持一致，两处都要改 |
| `exams` | 数组 | 该语言有哪些考试 ID，与主项目 `catalog/<code>.ts` 的 `EXAMS` 对应 |
| `scenes.supported` | 白名单 | 空数组 = 全支持 |
| `scenes.unsupported` | `{ sceneId: 理由 }` | **理由必须是给人看的一句话**，会直接显示在 UI 上 |

`unsupported` 的写法参考日语：

```json
"unsupported": { "writing": "JLPT 不考写作。要不要试试「句子升格」或「敬语改写」？" }
```

不是「不支持」，而是「不支持 + 给出口」。这是产品语气问题，不是技术问题。

### 3.2 `lang/<code>/errors.json`

```json
{
  "rules": [
    { "id": "particle", "label": "助词（조사）误用", "severity": "must-fix" },
    { "id": "ending",   "label": "语尾形态错误",     "severity": "must-fix" }
  ]
}
```

`id` 是 `ErrorTaxonomyPort.scan` 的合法返回值集合。**`severity` 是默认值，工具可以覆盖**（同一个 ruleId 在口语场景可能是 `style`）。

规模参照：英语 14 条、日语 11 条、韩语 11 条。不要一开始就写 50 条 —— 写不出确定性规则的类别先不写，占位会让 G5 误判「有据可依」。

---

## 4. 实现顺序：五步，顺序不能乱

每一步都以「能跑通一个真实句子」为完成标准，不要五个文件一起写。

### 第 1 步：地基 —— 找出这门语言的「确定性判据」

写代码之前先回答一个问题：**这门语言里，什么是不需要词典就能算出来的？**

| 语言 | 词边界 | 不需要词典就能算的 | 必须靠词典/模型的 |
| --- | --- | --- | --- |
| 英语 | 空格 + 标点 | 词形、大小写、句长 | 词性、成分 |
| 日语 | **没有空格** | 假名/汉字类别、モーラ数 | 切分本身（kuromoji） |
| 韩语 | **空格就是词边界** | 收音、조사 字形、语尾形态、音节数 | 词干内部音变、词性细分 |

韩语的答案是**收音**：

```ts
const HANGUL_START = 0xac00;
const JONG_COUNT = 28;      // 中声 21 × 终声 28
const JONG_RIEUL = 8;       // ㄹ
const JONG_BIEUP = 17;      // ㅂ

export function jongseongOf(char: string | undefined): number {
  if (!char) return -1;                       // -1 = 非한글，调用方据此跳过判断
  const code = char.codePointAt(0) ?? 0;
  if (code < HANGUL_START || code > 0xd7a3) return -1;
  return (code - HANGUL_START) % JONG_COUNT;  // 0 = 无收音
}
```

`0` 和 `-1` 必须区分：`0` 是「한글 且无收音」，`-1` 是「不是한글」。混用会让 `-ㄹ` 之类规则误命中英文词。

这一条判对之后，조사 与语尾的字形选择全部自动成立：`-이/가`、`-을/를`、`-은/는`、`-과/와`、`-으로/로` 都是「有收音取前，无收音取后」（`-으로/로` 多看一个 ㄹ 特例）。

### 第 2 步：`tokenize` —— 先跑通切分，再想别的

韩语的切分只有三件事：

```ts
export function splitEojeol(text: string): RawEojeol[]   // 空格 + 标点，带 start/end 偏移
export function analyzeKo(text: string): KoEojeol[]      // 每个 어절 → { stem, particle, auxiliary, ending, adnominal, pos, register, confidence }
export function koTokens(eojeol: KoEojeol[]): LangToken[] // 转成统一 token，拆出 조사 作为独立 token
```

`analyzeKo` 里有一组**判定顺序**，这是整个韩语实现最容易写错的地方，顺序错了会连锁误报：

```
1. 整词先试语尾（matchEnding），但只认两种：
   a. 语尾本身 ≥2 字（-습니다 / -어요 / -습니다만）
   b. 单音节词干 + 单字语尾（가 + ㅂ니다）
   否则 한국어 会被剥成 한국 + 어（误判为 해体语尾）
2. 语尾没命中 → 剥 조사（长助词优先：-에서는 / -으로는 / -에게서）
3. 조사也没有 → 试冠形节（ADNOMINAL_RE = /(던|을|은|는)$/），收缩形要还原词干（산 → 사 + ㄴ）
4. 都不中 → other
```

**两字 어절要特殊保护**。`저는`、`비가`、`사과`、`하나`、`종이` 本身就以助词字形结尾。规则：

```ts
const PRONOUN_STEMS = new Set(['나','저','너','그','이','우리','제','누','내','네']);
const SHORT_NOUNS = new Set([/* 约 60 个单音节名词 */]);

// 两字 어절只在「词干是代词」或「在 SHORT_NOUNS 里」时才剥，其余返回 null
```

不这么写，`사과`（苹果）会被剥成 `사` + `과`，句子成分直接错。

**`register`（语体）要跟着语尾走**：`합니다`→formal、`해요`→polite、`해`→casual、`한다`→written。韩语的语体混用检测全靠这个字段。

### 第 3 步：`level` —— 最便宜，先用它验证 tokenizer

等级估算是**唯一不需要模型、不需要音频、输入输出都是数字**的 Port。它跑对了，说明 tokenizer 至少没把句子切烂。

韩语的打分（`score` 累加分档）：

| 指标 | 加分 | 为什么是它 |
| --- | --- | --- |
| 平均句长（어절/句） | ≥12→4，≥8→3，≥6→2，≥4→1 | 长句是高级阅读的前提 |
| 平均音节/어절 | ≥3.6→2，≥3.0→1 | 初级 어절 短（저는/학생），中高级出现汉字词 |
| **长 어절（≥4 音节）占比** | ≥0.28→3，≥0.14→1 | 汉字词密度代理 |
| 连接语尾种类 | ≥3→2，≥1→1 | 逻辑连接的数量 |
| 正式/书面语尾（합니다·한다）出现 ≥2 次 | →1 | 敬语与书面语密度 |
| 한다体出现 | →1 | 只在书面语出现，一到这一段就不是口语记录 |

分档：`≥8→6급, ≥6→5급, ≥4→4급, ≥2→3급, 其余→2급`，`score < 1` 时 `1급`。

> **长 어절占比这一条是实测补出来的。** 没有它，一篇满篇 `경제성장 / 구조적인 / 직면하다` 的经济评论会被评成 3급。加完变 5급。代理指标的失效模式，只能靠真实语料试出来 —— 所以第 3 步一定要拿**三段不同难度的真实文本**（入门对话 / 教材课文 / 新闻评论）各跑一遍。

### 第 4 步：`taxonomy` —— 规则表 + 可复现的证据

先写 `errors.json`，再写规则。每条规则的形状：

```ts
interface KoCheck {
  ruleId: string;                                  // 必须在 errors.json 里
  severity: 'must-fix' | 'should-fix' | 'style';
  pattern: RegExp;
  problem: string;
  suggestion: string | ((matched: string, ...groups: string[]) => string);
}
```

**`suggestion` 必须能拿到捕获组。** 这轮踩过：`fix` 签名只收 `matched`，分写建议渲染成 `undefined 수 undefined`。改成 `(matched: string, ...groups: string[])` 并调用 `rule.fix(match[0], ...match.slice(1))`。

**前后否定环视是必需品，不是优化。** 韩语 `/음|어/` 会把 `어려움`、`생각합니다` 算成填充词，白扣分。必须写成：

```ts
/(?<![가-힣])어(?![가-힣])/g
```

英语同理：`\b(people|students)\s+(is|was)\b` 里的 `\b` 不能省。

规则写完后做两件事，缺一不可：

1. **错句集**：准备 12–15 个真实错误句，逐条断言命中对应 ruleId；
2. **正确句集**：准备 10 个正确句，断言**零命中**。

第 2 条比第 1 条重要。误报不会在开发时暴露，只会在用户面前暴露。

### 第 5 步：`syntax` —— 最后写，因为它消费前四步的全部结论

```ts
export function createKoSyntax(llm: LlmPort | null = null): SyntaxPort {
  return {
    lang: 'ko',
    async parse(text, opts) {
      const eojeol = analyzeKo(text);
      // 1. 找谓语：从后往前找最后一个终结语尾（不是第一个！多句文本时第一个会错）
      // 2. 定角色：조사 的 caseType 直接映射 role
      // 3. 挂子节点：冠形节并进后面的名词
      // 4. 排错的成分加 note：「它排在谓语之后 —— 韩语谓语固定在句末」
      return { nodes, summary, difficulty };
    },
    async contrast(text) { /* 规则部分 + llm 补充，llm 失败不影响规则部分 */ },
  };
}
```

三个具体经验：

- **`findPredicate` 从后往前。** 第一版从前往后找第一个终结语尾，两句话的文本直接被报语序错误 —— 第一句的谓语后面当然还有东西。
- **`difficulty` 要能被解释。** 韩语的算法：어절 数分档（0/1.5/3/4.5）+ 嵌套层数 + 敬语过去式 + 连接语尾 + 长词密度，上限 10。
- **`contrast` 的 tag 命名有约定**：`gra.contrast.<code>`（`gra.contrast.ja` / `gra.contrast.ko`）。英文没有后缀（`gra.contrast`）。离线评测的假 LLM 按 tag 分派，命名不一致会直接抛「未覆盖的模型调用」。

---

## 5. 语速口径：`spokenUnitCount`

新语种的「说出来了多少单位」必须挂到这里，不许在测量层写 `if`：

```ts
// server/src/agent/adapters/units.ts
export async function spokenUnitCount(text: string, lang: LangCode): Promise<number | undefined> {
  if (lang === 'ja') return jaMoraCount(text);
  if (lang === 'ko') return koSyllableCount(text);
  return undefined;   // 英语交给测量层按空格数词
}
```

返回 `undefined` 的语义是「这门语言的单位交给测量层默认逻辑」。目前只有英语走这条路，**新语种不要偷懒返回 undefined** —— 除非它的词边界真的就是空格。

| 语言 | 单位 | 为什么不能换 |
| --- | --- | --- |
| 英语 | 词 | 空格与标点就是词边界 |
| 日语 | モーラ（拍） | 是拍语言；按字数算会少一半 |
| 韩语 | 音节（음절） | 一字一音节，收音不独立成拍；按 어절 算会被词长带偏 |

调用点（加新语种时确认这三处都走到 `units.ts`，不要有残留的 `lang === 'ja' ? await jaMoraCount(...) : undefined`）：

```
server/src/agent/routes.ts
server/src/agent/adapters/asr.ts
server/src/agent/standalone/asr.ts
```

---

## 6. 「哪些波形量参与评分」必须由语言声明

**这是本轮最重要的一次架构修正，新语种接入时容易再犯。**

错误写法（曾经在 `tools/builtin.ts` 里）：

```ts
...(ctx.lang === 'ja' && measurement.pitch ? { pitch: measurement.pitch } : {})
```

问题：`types.ts` 明令禁止 `if (lang === 'xx')`，而且这句话在**工具层**，把「日语用 pitch」这条语言知识泄漏到了与语言无关的编排逻辑里。加韩语时唯一的选择就是再写一个 `if (lang === 'ko')` —— 越写越像规则引擎里的 if-else 树。

正确写法：**Port 的返回值里声明**。

```ts
// ports.ts
prosody?: { pitch?: PitchProfile; closures?: ClosureSpan[] };
```

```ts
// adapters/ja.ts
...(pitch ? { prosody: { pitch, ...(closures.length ? { closures } : {}) } } : {})

// adapters/ko.ts
...(pitch ? { prosody: { pitch } } : {})

// adapters/en.ts —— 什么都不返回，英语不评语调

// tools/builtin.ts
...(phonologyScore.prosody ?? {})
```

判断标准很简单：**这个数字如果不是这门语言评分算出来的，就不要挂到产物上。** 英语报告挂着两个不参与评分的音高/闭塞数字，只会让人猜它们是什么意思，而且会诱发「这个 87 分是怎么来的」的客服问题。

顺带一条配套规则：维度 id 要能被通用渲染。现有 id 集合 `pace` / `pausing` / `continuity` / `pronunciation` / `intonation`，工具的 `rhythmLabel` 要给出对应中文名（`发音·抑扬`、`语调`）。新语种如果引入新维度 id，记得加映射，否则前端显示原始 id。

---

## 7. 装配：四处，缺一处就是「单端起、另一端起不来」

```ts
// 1) adapters/inprocess.ts（主项目内嵌）
const koPorts: LanguagePorts = {
  tokenizer: koTokenizer,
  syntax: createKoSyntax(llm),
  taxonomy: koTaxonomy,
  phonology: koPhonology,
  level: koLevel,
};
language: (code) => (code === 'en' ? enPorts : code === 'ja' ? jaPorts : code === 'ko' ? koPorts : null),

// 2) standalone/index.ts（独立端）—— 同上，别漏
// 3) evals/harness.ts（离线评测）—— 同上，syntax 传 fakeLlm
// 4) lang/loader.ts:26 —— z.enum(['en','ja','ko']) 放开新 code
```

四处都改完的表现：`/api/agent/scenes` 里 `ready: true`。**只改 1、2 不改 3**，评测跑不到新语种，等于没验；**只改 1、2、3 不改 4**，语言包加载被 zod 静默跳过（日志会有 `语言包字段不合法，已跳过`），`ready` 永远是 false。

另外两处 zod 枚举也要放开（否则请求直接 400）：

```
server/src/agent/routes.ts:116, 529
```

---

## 8. 场景声明：`requires` 与 `lang.exams`

新语种不一定要开全部场景。`scene.json` 里两处要动：

```json
{
  "lang": {
    "requires": ["tokenize", "phonology", "levelScale"],
    "exams": { "en": ["ielts","toefl"], "ja": ["jlpt"], "ko": ["topik"], "fr": ["delf"] }
  }
}
```

- `requires`：该场景依赖哪几个 Port。**这是自检项** —— 如果你的语言某个 Port 是「假实现」（比如 phonology 永远返回 null），就不该让它出现在需要它的场景里。
- `lang.exams`：该语种在该场景下认哪些 `exam` 参数。空数组 = 明确不派这个场景（日语写作就是这么拦的）。`["*"]` = 全认。

`exam` 参数对不上时行为要明确：不派场景 + 给一句话，不要「兜底跑一个通用版本」。

---

## 9. 主项目层：不要把这份文档当全部

学习台只是产品的一半。**主项目层**（计划、每日材料、命题、批改、加练、试卷、朗读）的改动清单在 `HANDOVER-LANGUAGE.md` §3，那里比这里长得多：

- 必改（否则编译不过）：20 余张 `Record<Language, ...>` 映射表
- 必补（否则内容是空的）：考纲、评分标准、词库、文章库、题库、语音
- **黑名单**（编译能过、运行期静默退英文）：11 处 `if/else` 链，`HANDOVER-LANGUAGE.md` §3.3 逐行列了
- 必须写迁移：SQLite 的 `CHECK` 与触发器不会自己放宽

一句话：**学习台加一门语言 ≈ 2 个数据文件 + 1 个适配器 + 4 行装配；主项目加一门语言 ≈ 30 个文件 + 1 个迁移。** 别用小头估算大头。

---

## 10. 验收清单

按顺序做，每步有明确的通过标准。

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
export PATH=/usr/local/bin:$PATH      # .node-version 是 24.12.0，系统默认 v22 会让 better-sqlite3 报 NODE_MODULE_VERSION 137 vs 127
```

| # | 命令 / 动作 | 通过标准 |
| --- | --- | --- |
| 1 | `npx tsc --noEmit` | 无输出 |
| 2 | 检查 `git diff --stat server/src/agent/core/` | **空**（铁律） |
| 3 | 起服务，`curl -s .../api/agent/scenes` | 新语种 `ready: true`、`scale` 正确、`unsupported` 符合预期 |
| 4 | 长难句：`sentence-parse` 跑一句典型长句 | 产出 `syntax-tree`，G1–G5 全 pass，`difficulty` 在合理区间 |
| 5 | 写作：`writing-exam` 跑一篇真实作文 | 规则命中数正确（正确作文应为 **0 处**），档位换算落在本语种刻度上 |
| 6 | 口语（纯文本）：不传音频 | `basis: typed`、`prosody: false`、**不出现编造的发音分** |
| 7 | 口语（真音频） | `paceLabel` 是本语种单位、`rate.unit` 正确、`prosody` 挂的量与语言声明一致 |
| 8 | `npm run check:agent` | 全通过，且**新增了该语种的评测用例** |
| 9 | 错因扫描：12–15 个错句 + 10 个正确句 | 错句命中对应 ruleId；正确句 **零命中** |
| 10 | 回归：原有语言的同一批用例 | 数字与加语言前一致（这轮英语 `8.5/9`、日语 `40/50`、`closures: 4` 都没变） |
| 11 | 主项目层 `npm run check:lang` | 全通过 |

第 8 步特别容易漏：**只加实现不加用例，等于「跑起来了」但没人知道它跑得对不对。** 用例写在 `scenes/<scene>/evals/core.jsonl`：

```json
{"id":"s-003","note":"韩语长句：冠形节嵌套，必须真跑",
 "input":{"lang":"ko","mode":"craft","query":"这句读不懂",
          "text":"내가 어제 산 책은 아주 재미있어서 밤늦게까지 읽었습니다."},
 "expect":{"scene":"sentence-parse","tools":["profile.read","gra.parse","gra.contrast"],
           "artifacts":["syntax-tree"],"verifyPass":["G1"],"minConfidence":0.5}}
```

字段：`input.lang / mode / query / text / exam / articleId / helpLevel`，`expect.scene / tools / artifacts / maxItems / verifyPass / minConfidence / error / clarify`。假 LLM 按 `req.tag` 返回固定结果，所以**新语种的 `contrast` tag 要在 `harness.ts` 里补分支**，否则抛「eval harness 未覆盖的模型调用」。

---

## 11. 已知边界：写清楚「不做什么」

新语种接入时，最容易被后来人当成 bug 的，是「刻意不做」。**在适配器文件头写一节「明确不做的事」，比写在交接文档里有效** —— 因为读代码的人比读文档的人多。

韩语头部那段值得照抄格式：

```
明确不做的四件事，写在这里免得被当成已完成：
- 词干内部的音变不还原：갑니다 的词干记作「갑」（가 + ㅂ），不是「가」。
  还原需要真正的形态分析，半吊子的还原会让学生看到不存在的词形。
- 词性只分到「体言 / 用言 / 修饰语」这一层，不再往下细分。
  再细就需要词典；而错的词性标注比没有更糟 —— 学生会以为系统看懂了。
- 不规则活用还原不了（ㅂ/ㄷ/ㅅ/ㄹ/르）：도와요 / 추워요 / 몰라요 会判成「名词」。
- 해요体的收缩形 -요 不成词：가요 / 만나요 / 봐요 判不出语尾（먹어요 / 좋아요 正常）。
```

通用原则：

| 原则 | 表现 |
| --- | --- |
| 宁缺毋假 | 没有音频 → `null`，不编分数；没有词典 → 不标词性，不猜 |
| 半吊子不如不做 | 词形还原做不到就返回原样；错误的「正确」比没有更伤人 |
| 明确拒绝优于低质产出 | 场景不支持就给话术，不跑通用兜底 |
| 结构算出来，讲解交给模型 | 同一句每次切得一模一样，每条结论可追到规则 |

### 11.1 「要不要上词典」的决策记录（以韩语 mecab-ko 为例）

**结论：现在不装 C++ 原生绑定。** 判断依据是「有没有功能真的需要它」，不是「装了是否更强」。

事实先摆出来（2026-11 核查）：

| 路径 | 形态 | 体量 | 风险 |
| --- | --- | --- | --- |
| 原生 mecab-ko（C++ + node-gyp 绑定） | 系统库 + 编译 | 词典 ~90MB 起 | 要跟 Node ABI 绑（本项目 Node 24）；换机器/换大版本要 `npm rebuild`；部署镜像变重 |
| `@mecab-ko/node`（Rust 重写 + napi） | 预编译二进制 | 中 | npm 周下载 ≈ 0，单维护者，2026 年新包 |
| `kuromoji-ko`（纯 JS，kuromoji 移植） | 纯 JS + 自建二进制词典 | 词典需自己 `build:dict` | 同上，且多一个构建步骤进 CI |
| `mecab-ko-wasm`（Rust → wasm） | 单 wasm，词典内置 | 包自述 2–5MB | 同上；最少依赖，最接近「装上就能用」 |

**为什么现在不值得**：当前没有任何工具依赖细词性或真原形 —— `lemmatize` 只被 `koTokenizer` 调，词汇本/查词还没上线。花 90MB 与一个构建步骤换「更准的 pos」，收益落不到用户可见的地方。

**什么信号出现时才值得装**（任一条成立就重新评估）：

1. 「词汇本 / 生词去重」上线 —— `먹었어요 / 먹습니다 / 먹다` 必须归为一条；
2. 教学上要按词性出题（动词/形容词专项），而三大类粒度不够；
3. 不规则活用的误判开始出现在**用户可见的地方**（句法树里谓语被标成名词），而不只是内部字段。

**装的时候怎么装才不破坏架构**：只替换 `koTokenizer` 的 `tokenize` / `lemmatize` 内部实现，`LangToken` 的输出形状不变 → `core/` 与四个场景一行不改。这是 Port 契约真正的价值：**换实现不改调用方**。

**如果暂时不装，至少别自信地错**：`pos: '체언'` + `confidence: 'high'` 用在 `도와요` 上是错误标注，比「判不出来」更危险。改法是把这类「词干以 워/와/라/러 结尾、且没有匹配到语尾」的 어절降为 `confidence: 'guess'`，让下游知道这一条不可靠。

---

## 12. 踩坑记录（韩语接入实测，按踩到的顺序）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `한국어를` 被读出 `[casual]` 语尾，整句误报「语体混用」 | 先剥助词再匹配语尾的顺序不对：`를` 剥完剩 `한국어`，末音 `어` 命中 해体 | 整词先试语尾，但只认「语尾 ≥2 字」或「单音节词干 + 单字语尾」；有助词就判名词 |
| 2 | `저는`、`비가` 被剥成 `저`+`는` | 两字 어절的末字本身就是助词字形 | 两字 어절只在词干是代词或 `SHORT_NOUNS` 时剥 |
| 3 | `않 왔습니다` 没命中 | 正则只匹配「않 + 动词」紧邻 | 补 `/(?<=^\|\s)않(?=\s\|$)/g` 独立成词分支 |
| 4 | 分写建议渲染成 `undefined 수 undefined` | `fix` 只收到 `matched`，捕获组丢了 | 签名改 `(matched, ...groups)`，调用传 `...match.slice(1)` |
| 5 | 正确作文被报「합니다 体与 해 体混用」 | `풀어 주기` 的 `-어` 被当成终结语尾 | 句中出现的 `-어/-아` 改判 `connective` + `register: 'none'` |
| 6 | 两句文本被报语序错误 | `findIndex` 找第一个终结语尾 | 改成从后往前找最后一个 |
| 7 | `재미있어서 / 산 / 온` 全落到 `other` | 冠形节与连接语尾未识别 | 补 `ADNOMINAL_RE` 与收缩形 `-ㄴ` 判定 |
| 8 | 经济评论被评 `3급` | 缺汉字词密度指标 | 加「长 어절（≥4 音节）占比」+「한다体」加分，现为 `5급` |
| 9 | 口语档位显示模型编的「TOPIK 말하기 4급 수준」 | 100 点制被 `if (rubric.scale.max !== 100)` 跳过换算 | 去掉条件，一律走 `toBand`，显示 `82 / 100` |
| 10 | 产物里挂着一堆不参与评分的音高数字 | 工具层 `if (lang === 'ja')` 的副作用 | 新增 `PhonologyPort.prosody`，由语言声明（§6） |
| 11 | **`갑니까` / `합니까` 被判成连接语尾**，疑问句被报「句子没说完」 | 语尾的 `when` 收到的是**整词**，`lastChar('갑니까')` 是「까」，「词干末音是 ㅂ」永不成立 | `matchEnding` 先算出 `base = word - suffix` 再传给 `when` |
| 12 | **`합시다` 被判成 한다体**，通篇 `-ㅂ니다` 的作文被报「语体混用」 | 语尾表缺共动形 `-ㅂ시다 / -읍시다 / -십시오`，`합시다` 落到 `-다` | 补三条正式体语尾（共动当 ㅂ 收音，`좋으시다` 不会误中） |
| 13 | 批改产物里「原文片段」是段落开头 60 字 | `quote: text.slice(0, 60)` 图省事 | 引用**冲突的那个 어절**（`좋아요`），并在 problem 里点名基准语体 |
| 14 | 韩语写作没法进离线评测 | 假 LLM 只有一份英文 diff，`ruleId: 'sva'` 不在韩语错因表里 | harness 按用例语种造假模型（`makeFakeLlm(lang)`），缺样例时**报错而不是退回英文** |

14 条里有 10 条不是「写不出来」，而是「写出来之后报错了」。**所以每加一条规则，就要跑一遍正确句集** —— 规则引擎的 bug 全是误报，不是漏报。

第 11–13 条是补韩语写作评测用例时连带发现的：**为了让一条用例真的立起来，得先把被测功能跑对**。写用例的过程本身就是一次验收，这也是为什么「先补用例再说功能完成」比反过来靠谱。

---

## 13. 一页速查

打印版在 `HANDOVER-NEW-LANGUAGE-QUICKREF.md`（含「误报急救表」）。下面是同内容的清单形态：

```
[ ] 1. lang/<code>/lang.json + errors.json（先写 errors.json）
[ ] 2. lang/loader.ts:26 的 z.enum 放开；routes.ts:116,529 的 z.enum 放开
[ ] 3. 找出「不需要词典就能算」的确定性判据（音系/字形/词形），写在适配器头部
[ ] 4. adapters/<code>.ts：
       tokenizer（含 start/end 偏移、lemmatize 诚实降级）
     → level（先用它验证 tokenizer，拿三段不同难度真实文本试）
     → taxonomy（规则表 + 前后环视；错句集 12–15 + 正确句集 10）
     → phonology（无音频/样本短 → null；rate.unit 由语言声明；prosody 由语言声明）
     → syntax（规则定结构，LLM 只做 contrast，tag 用 gra.contrast.<code>）
[ ] 5. adapters/units.ts 挂 spokenUnitCount（别返回 undefined，除非词边界真是空格）
[ ] 6. 装配四处：inprocess / standalone / harness / loader；harness 补 makeFakeLlm 的语种样例
[ ] 7. scene.json 的 lang.requires 与 lang.exams；不支持的场景给一句话 + 出口
[ ] 8. evals/core.jsonl 补 2 条以上该语种用例
[ ] 9. 主项目层：走 HANDOVER-LANGUAGE.md §3（含 §3.3 黑名单与迁移）
[ ] 10. 验收 11 步（§10），含「原有语言无回归」
```
