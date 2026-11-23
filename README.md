# 外语考证宝典

输入「当前水平」和「目标分数」，自动生成一份逐日可执行的备考计划，并为每一天准备好**要背的文章、要朗读的稿子、要复习的生词**。

支持英语（托福 / 雅思 / 六级 / 考研）、日语（JLPT N5–N1）与韩语（TOPIK 1–6 级）。

## 快速开始

```bash
npm install
cp .env.example .env      # 可选：填入大模型 API Key
npm run dev               # 前端 http://localhost:5199，后端 http://localhost:4399
```

只想跑一个进程（生产模式）：

```bash
npm run build
npm start                 # 打开 http://localhost:4399
```

自检（服务已启动后执行，只读、不写业务数据）：

```bash
npm run smoke
```

> 依赖 Node 18+（开发使用 Node 22 验证）。数据全部保存在本机 `.data/app.db`（SQLite），删掉该文件即清空数据。

## 两种内容模式

| 模式 | 触发条件 | 每日材料来源 |
| --- | --- | --- |
| 演示模式 | 未配置模型 | 内置考纲题库（内容固定，流程完整，可离线使用） |
| 大模型模式 | 在「设置」里填入任意 OpenAI 兼容 Key，或写 `.env` | 按当日主题 + 考纲 + 目标分实时生成精读文章、生词表、理解题与朗读稿 |

`.env` 中的示例：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxxx
LLM_MODEL=deepseek-chat
```

也可以在界面「设置」里配置，配置会写入本地数据库并优先生效。

### 可选服务商（设置页点一下就填好 Base URL 与推荐模型）

| 服务商 | Base URL | 推荐模型 | 免费档 |
| --- | --- | --- | --- |
| 智谱 GLM（BigModel） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash` | GLM-4.7-Flash 免费，200K 上下文、30 QPS |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-lite` | Hunyuan-Lite 永久免费（并发 5） |
| 魔搭 ModelScope | `https://api-inference.modelscope.cn/v1` | `Qwen/Qwen3-8B-Instruct` | 每天 2000 次免费调用 |
| 通义千问 / DeepSeek / Kimi / OpenAI | 见设置页预设 | 各自旗舰或轻量档 | 各有试用额度 |
| 自定义 | 任意 OpenAI 兼容地址 | 手填 | 自建网关、one-api、Ollama 等 |

- **模型名不用背**：模型输入框旁边有「拉取列表」，会调该平台的 `GET /models` 把真实可用的模型 ID 拉回来；魔搭的 `Qwen/Qwen3-8B-Instruct` 这种名字建议直接选，别手打。
- **JSON 模式自动降级**：有些平台不支持 `response_format: json_object`（混元、魔搭默认不发）。系统先按服务商预设决定发不发；万一仍被 400 拒绝，会去掉该参数重发一次并记住，之后不再发，靠提示词约束 + 一次修复重试保证结构化输出。

## 它到底做了什么

1. **可行性测算**：按考纲与历年提分数据，把「当前水平 → 目标分数」折算成所需小时数，再和你的时间预算（周数 × 每周小时）对比，给出覆盖率、达标概率与建议周期。不达标时会直接说出来，并给出阶梯目标。
2. **三阶段排程**：筑基 → 专项强化 → 冲刺模考，按周排到每一天；每周第 7 天固定为复盘日。
3. **每日任务切分**：词汇 / 精读 / 朗读 / 听力 / 写作 / 模考按阶段配比切分到你设定的每日分钟数，词汇时长跟着「新词个数」走。
4. **每日材料生成**：文章 + 中文译文 + 音标/假名 + 生词表 + 理解题 + 分段朗读稿（含停顿、重音提示）。
5. **跟读与复习**：浏览器语音合成逐句朗读（0.6×–1.0× 变速，自动筛出系统里最拟真的 15 个音色供选择）；生词按 SM-2 间隔重复进入复习队列。
6. **写作 / 口语自动批改**：见下节。
7. **学习之路**：把大目标拆成一级级台阶（英语：六级 → 托福 90 → 托福 100；日语：N3 → N2 → N1），每级给出工时、周数、词汇增量、学习动作、常见坑与升级自测线。
8. **真实考试场次**：设置计划不再选「3 个月 / 6 个月」这种抽象周期，而是直接选「哪一年哪一月的那一场」——JLPT 按官方固定节奏列出每年 7 月、12 月第一个周日的场次（日期精确），托福按 NEEA 全年滚动排考生成月度场次（当月第 2 个周六为示例日，可手动微调），自动过滤掉报名已来不及的场次；设置页右栏同时给出报名官网与资讯入口直达链接。
9. **报考日历与费用指引**：按教育部教育考试院（NEEA）官方节奏，从考试日期倒推报名、选考场、缴费、打印准考证、考前检查、查分等关键节点；节点当天自动生成「报考事务」任务（含官方报名入口链接与操作指引），设置计划页与学习计划页提供完整时间线与费用说明（托福 ¥2100 体系 / JLPT N1N2 ¥550、N3–N5 ¥450），逾期报名、转退考、复议等附加费用一并列明。
9. **分级词库**：英语按「过渡词 / 托福核心 / 冲 100 拉分」、日语按「N3 / N2 / N1」三级收录（含释义、音标·假名、记忆法、例句与主题），支持整级一键加入词汇本；词汇本按语种完全隔离——英语与日语各自成册，复习队列、级别进度、统计互不相通，数据库层还有触发器锁死跨语种写入。
8. **语种切换与配色**：首页一键切换 English ⇄ 日本語（自动启用对应语种的计划）；界面为 Liquid Glass 风格，配色取自 Apple 系统色（海湾蓝 / 午夜靛 / 紫罗兰 / 樱花粉 / 青瓷 / 苔绿 / 琥珀 / 石墨），默认按语种适配（英语=蓝、日语=粉），可手动固定。

## 写作 · 口语自动批改

「写作·口语」页把计划里的写作与口语任务变成可评分的闭环：

1. **命题**：按目标考试的真题形态出题（托福学术讨论含两位同学观点、雅思 Task 2、六级/考研短文、JLPT 記述・スピーチ），给出构思提示与提交前自检清单；配置大模型后按当日主题实时命题。
2. **作答**：写作有计时与字数统计；口语支持浏览器语音识别自动转写 + 录音回放（Chrome/Edge），也可直接手打转写稿。
3. **批改**：按官方评分维度加权打分（如托福写作 = 内容 35% + 组织 20% + 语言 25% + 词汇 20%），输出：
   - 综合分 0–100 + 考试分制档位（托福 0–5、雅思 Band、六级 15 分、考研 20 分）
   - 逐维度分数与评语、量化指标（句长、去重比、填充词、语速）
   - 逐条批改：引用原文片段 → 改后写法 → 错因说明
   - 表达升级（from → to）、「改错版」重写、下一步训练动作
4. **回写**：批改完成后任务自动标记完成，得分写入任务卡与学习日志；「批改中心」汇总写作/口语均分与分数走势。

两种批改引擎：

| 引擎 | 触发条件 | 能力边界 |
| --- | --- | --- |
| 启发式（默认） | 未配置大模型，或模型调用失败 | 篇幅、分段、衔接词、重复率、语速与 14 类可检测语法/用词错误（主谓一致、冠词、时态跳跃、标点等），并明确提示不含语义判断 |
| 大模型 | 已配置 OpenAI 兼容 Key | 逐句批改、语义与论证评价、整段改错版、个性化训练建议；失败自动回退启发式 |

口语的「语音与语调」维度只能基于转写文本与识别置信度估算，务必回听录音自行核对。

## 目录结构

```
server/src
  catalog/        考纲知识库（考试结构、目标分、词汇量、阶段配比）
  domain/         rubrics（评分维度与分制换算）、practice（批改数据结构）
  content/        内置精读库 + 命题题库（演示模式）
  services/       planner（排程与可行性）· content（材料生成/兜底）· grading（启发式+大模型批改）· practice（命题与批改编排）· llm · srs
  repositories/   SQLite 数据访问（auth.ts 为用户与会话表）
  routes/         REST 接口（auth.ts 为登录与用户管理端点）
  services/       auth（登录编排）、oauthProviders（微信 / 钉钉官方 OAuth 客户端）
  middleware/     auth（Cookie、令牌解析、RBAC、CSRF、限流）
  auth/           基础设施：请求作用域(AsyncLocalStorage)、JWT、密码哈希、常量
  db/             连接、迁移（顺序执行、可回滚）
web/src
  pages/          Setup / Dashboard / Today / Path / PracticeHub / Practice / Plan / Vocab / Settings / Login / AuthCallback / UIKit
  components/     文章阅读器、朗读器、理解题、语种切换、UserMenu、UI 基础件
  auth/           AuthProvider（登录态、静默刷新、401 重试广播）
  hooks/          useSpeaking（语音识别 + 录音）
  uikit.css       UI 组件库预览页布局（组件本体样式来自 SDK）
```

## UI 组件库（SDK）

表单、下拉、开关、滑块、播放器与主题换肤已抽成独立包 `@waiyubaodian/ui-kit`，
本项目与本机其它系统共用同一份源码：

- 源码目录：`/Users/zhua/WorkBuddy/2026-11-22-14-24-29/ui-kit-sdk`
- 说明文档：SDK 内 `README.md`（用法）· `INTEGRATION.md`（对接文档，含三种接入方式）
- 本项目依赖：`"@waiyubaodian/ui-kit": "file:../../2026-11-22-14-24-29/ui-kit-sdk"`
- 引入方式：`main.tsx` 引 `import '@waiyubaodian/ui-kit/styles.css'`；组件从 `@waiyubaodian/ui-kit` 导入，
  主题 API 从 `@waiyubaodian/ui-kit/theme` 导入
- 独立演示：`cd ui-kit-sdk && npm run dev:demo`（React 演示页）；`open ui-kit-sdk/demo/static-preview.html`（零依赖静态预览）
- 接入别的系统：`npm i file:/Users/zhua/WorkBuddy/2026-11-22-14-24-29/ui-kit-sdk`，
  或 `npm i @waiyubaodian/ui-kit`（已发布），或无 Node 环境时 `node ui-kit-sdk/scripts/copy-into.mjs --target <工程目录>` 直接拷 CSS

## 分级教材（0 → N2）

设置页「我的教材」可以导入自有电子书（PDF / EPUB / DOCX / TXT / MD），解析成章节与词条后接进每日计划。教材按**级别**管理，同一个语种可以放多本：

| 类型 | 进哪个任务 | 说明 |
| --- | --- | --- |
| `textbook` 教材 | 精读 / 精听 / 朗读 / 拆句 / 词汇 | 按计划进度自动推进：N5 → N4 → N3 → N2，每章 2 天 |
| `vocab` 词表 | 只用词汇任务 | 词表包按目标级别出词，最多占当日词汇的四成 |
| `notes` 资料 | 不进每日任务 | 答疑、题型整理等，可在教材库里查看目录 |

- **级别识别**：文件名带 `N2` / `二级` / `零基础` 会自动分级；识别不出时在上传前手动选。
- **推进规则**：按考纲各级别所需小时数把计划天数切段，走到哪一级就用哪一级的教材；没书的级别自动顺延到下一本有书的级别。
- **生词表解析**：日语教材里 `食べる（たべる） ② 动1 吃` 这类生词表行会被识别成「词形 + 假名 + 词性 + 释义」，直接进背诵，不依赖内置词库是否收录。
- **推广词清洗**：入库前统一剥掉网校署名（沪江日语 / 沪江网校 / Class.YesHJ.com）、下载站水印（pdfFactory、fineprint）、公众号与群号、版权声明和裸链接（`services/sanitize.ts`）；页脚广告卡在句子中间时会把后半句接回去。老数据用 `npm run clean:materials -- --write` 回洗。

批量导入（终端）：

```bash
npm run import:material -- --lang ja --dir ~/Downloads --match "N5" --level n5
npm run import:material -- --lang ja --file ~/Downloads/某本教材.pdf   # 级别从文件名识别
npm run import:material -- --lang ja --dir ~/Downloads --dry           # 只看会导入什么
npm run clean:materials                                               # 预演清洗，加 --write 落库
```

## 语法书：句型按天进「拆句」出题

句型手册（【～あげくに（の）】这种）不能按教材的方式切：教材按 4200 字符切章，语法书必须**一个句型一条**。

```bash
npm run import:grammar -- --file "~/Documents/精编语法.pdf" --level n2
npm run import:grammar -- --file ... --dry     # 只看解析结果，不写库
npm run import:grammar -- --file ... --force   # 同名的旧版本先删再导
```

- **解析**（`server/src/services/grammarBook.ts`）：按【句型】切块，每条拆成「接续 / 释义 / 类义形 / 例句 / 译文」。PDF 折行造成的粘连用两条结构性规则还原——「接在…之后，表示…」从「表示」断开；「最后一行是中文译文、其上一行是日文例句」，其余行才算接续与释义（靠「像不像日文」判定会被释义里引用的日文词骗到）。178 条原文里 175 条能完整取出。
- **入库**：`materials.kind = 'grammar'`，一条句型一章；`level` 落在计划区间内才参与（N3 → N2 的计划用 n2 的语法书），教材库里标「语法书 · 按天轮换进拆句」。
- **出题**：「AI 加练 · 拆句」生成时按「周序号 × 7 + 日序号」取当天该练的 3 个句型，塞进提示词的【今日语法点】，并要求每个句型至少造一句、tips 写明接续与易错点。取句型时按书长等距跨步，避免连着三个都是同一活用形的近邻句型；同一天反复生成拿到同一批，换天才往后挪。

## 词汇书：按课入库，初級词表也能「补基础」

《日本语精编词汇》这类扫描书是**双栏、按课列词**，每行一个词条：`きょうじゅ（教授）〔名〕教授`。直接 OCR 再按行切会两栏串行，所以走专用的解析链：

```bash
npm run import:vocab -- --file "~/Downloads/日本语精编词汇.pdf" --level n4 --title 日本语精编词汇
npm run import:vocab -- --file ... --dry            # 只解析与统计，不写库
npm run import:vocab -- --ocr /tmp/vocab_xy.txt ...  # 复用已识别的文本（跳过 OCR）
npm run import:vocab -- --file ... --force          # 同名的旧版本先删再导
npm run import:vocab -- --file ... --no-llm         # 不调模型，直接导 OCR 原文（错字会保留）
```

- **OCR 要带坐标**：`OCR_XY=1 swift scripts/ocrPdf.swift …` 每行输出 `x<TAB>y<TAB>文字`。双栏书按 `x` 分左右栏、`y` 排序才是正确阅读顺序；课号「第 N 課」横跨两栏，用它的 `y` 当水平分隔线切课最稳（整行漏识别的课号，按相邻课号把词条等分补上）。
- **错字交给模型、结构留给代码**：扫描件的假名几乎不出错，错的是汉字与中文释义（「先生」→「老姉」、「職員」→「現景」）。所以代码只负责「哪一课、哪一行、假名是什么」，模型按假名还原汉字表记与释义，并给每个词补一句 N4 以内语法的例句。校正结果缓存在 `.data/vocab-clean-*.json`，中断重跑不重复花钱。
- **入库**：`materials.kind = 'vocab'`，一课一单元，词条进 `material_words`；教材库里标「词表 · 随词汇任务取词」。
- **补基础**：`vocabPacksFor()` 先给落在计划区间内的词表（N3→N2 计划就是 N3/N2 词表），再把**低于当前级别**的词表排在后面一起参与——初級词表配 N3 计划时属于补漏，不该盖过当前级别的词，但也不至于永远用不上。

## 升级自测：按原卷大题顺序考

导入一份真卷时，程序不再把整份文档压成一两段丢给模型（那样模型只会交出第一块的题，于是「只想测文字・語彙」），而是：

1. **先拆大题**：按原文的「問題1 / 問題2 / Part A」切块（`server/src/services/examStructure.ts`），每块单独一次抽取，整卷的题型都能覆盖到；
2. **再逐块抽题**：每块带上课末答案区，要求按原卷顺序逐题输出；题库里同时记下 `question_no`（原卷大题号）与 `answer_source`（原卷答案 / 据解析推导 / 模型作答）；
3. **题数校验**：按原文的小题标记（`19.______`、`1番`）核对每块抽出的题数，抽少了自动补抽一次，并在导入结果里提示「原文有 N 处小题，只抽出 M 道」；
4. **按考场顺序作答**：前端按 `文字・語彙 → 文法 → 読解 → 聴解` 的分块顺序出题，两个科目分别计时（JLPT 为 言語知識・読解 / 聴解），交卷后不能返回上一科目；
5. **结果按块给分**：结果页的分部分得分与逐题解析都按原卷大题排列，答案不是原卷给出时会逐题标注来源。

### 线路不稳时怎么补题（不重导整卷）

整卷重导一次要跑 17 块、半小时，模型线路一抖就可能把已经导好的题一起覆盖掉。所以缺题时只补缺的那几块：

```bash
# 1) 定点补抽：只对「原卷小题数 > 库内题数」的大题重抽，新结果题数更多才替换
npm run topup:exam -- --paper imp-ja-2026-dfbbb792 \
  --file "~/Documents/2026年7月新日本语能力考试N3.pdf" \
  --expect 7=2 --context 7=/tmp/p20.txt --passage 7=/tmp/p20.txt

# 2) 补听力朗读稿：题从同卷旧题或答案区的【听力原文】里接过来，不重抽
npm run fill:audio -- --paper <id> --file <pdf> [--from-backup .data/topup-backup-*.json] [--only 79,80|--redo]

# 3) 图片型大题（発話表現，题面全是图）：直接按答案区重建，答案由人给下标
npm run build:speech -- --paper <id> --file <pdf> --block 4 --answers 1,2,0,1
```

三个脚本都是「先备份 `.data/*-backup-*.json` → 只动指定块 → 其余题原样保留」，`--dry` 只报告不写库。
`--expect` 用于题号排版让「小题数」数不出来的大题（如情報検索）；`--context` / `--passage` 把该页 OCR 文本喂给模型并写成阅读材料（配図是图片时必需）。

## 用户与登录

默认是**游客模式**：不登录照样用，行为与老版本完全一致，数据仍归属本机 `local` 用户。
登录后切换到**按账号隔离的独立空间**，计划、词汇本、作答记录、批改记录、音色配置互不串号；
内置真题库与模型 Key 池是全局共享的系统资源。

### 用户主表与数据归属

迁移 `014_auth.sql` 新增五张表，不改动任何原有业务表；`016_auth_extensions.sql` 在 014 基础上**只增不改**地重建 `users` 表，扩展角色与账号安全字段：

| 表 | 作用 |
| --- | --- |
| `users` | 用户主表：ID、用户名（`COLLATE NOCASE` 大小写不敏感）、密码哈希（scrypt）、昵称、头像、角色 `admin/teacher/student/user`、状态 `active/pending/disabled`、预留 `email/phone/jlpt_level`（教师能力等级 N1–N5）、失败计数 `failed_attempts` 与锁定时间 `locked_until`、最后登录时间 |
| `user_identities` | 外部身份：微信 `unionid ?? openid`、钉钉 `unionId`，一个真人可绑两个渠道 |
| `auth_sessions` | 刷新令牌会话，只存 SHA-256 摘要；`family_id` 用于重放检测与整链撤销 |
| `auth_login_tickets` | 扫码票据状态机，`state` / 票据密钥 / 兑换码都只存摘要 |
| `auth_audit_logs` | 登录、刷新、失败、绑定、重放检测等审计事件 |

启动时把历史数据一直在用的 `local` 注册为**管理员**（用户名 `admin`），82 套卷 / 843 道题等既有数据原地归属它，零迁移。
数据隔离靠 `AsyncLocalStorage` 请求作用域实现：仓储层统一取 `currentUserId()`，没有请求上下文（脚本、启动期种子任务）时回落 `local`。

### 三种登录方式

1. **微信扫码**：微信开放平台「网站应用」QRConnect（`snsapi_login`）。需要已审核的网站应用与 AppID/AppSecret。
2. **钉钉扫码**：钉钉新版 OAuth2 统一授权登录（`scope=openid`、`prompt=consent`）。需要应用 AppKey/AppSecret，并申请「通讯录个人信息读权限」才能拿到 `unionId`。
3. **账号密码**：作为扫码的兜底与本地管理入口。首次设置密码：

```bash
NEW_ADMIN_PASSWORD='至少8位' npm run admin:passwd
# 或在 .env 里写 AUTH_ADMIN_PASSWORD（只在首次启动生效）
```

### 自助注册与账号体系

登录页顶部有「登录 / 注册」两个 tab。注册只需账号 + 密码（+ 可选昵称），密码规则 8–72 位、含字母与数字、不得与账号相同；
成功后直接进入属于自己的独立空间，与游客及其它账号的数据完全隔离。

- **角色**：注册身份可选「学生」或「教师」（默认学生），**不能自助注册管理员**；教师可预留能力等级 N1–N5。
  教师能力判定、证书上传、测评考核与按角色定制的左侧菜单属于后续迭代，本版仅落库预留字段。
- **开关**：`AUTH_ALLOW_REGISTER=false` 关闭自助注册，此时只能由管理员建号；
  `AUTH_NEW_USER_STATUS=pending` 让新用户注册后待管理员审核（本机自用保持默认 `active`）。
- **游客数据认领**：新账号默认空空间，游客 `local` 名下的历史数据不会自动搬迁。
  在「账号中心 → 认领本机游客数据」可预览分项条数，二次确认后在一个事务内逐表搬移，**不可逆**；
  注意会一并搬走本机配置的大模型 API Key（`llm_keys`）。
- **账号维护**：账号中心可自助改昵称/头像、改密码（改后其它设备立即下线）；忘记密码由管理员在用户表里重置（云端无邮件通道）。
- **失败锁定**：连续 5 次密码错误锁定 15 分钟（可用 `AUTH_LOCK_THRESHOLD` / `AUTH_LOCK_MINUTES` 调整，N=0 关闭）。

自检：`npm run check:auth`（全离线临时库，覆盖注册/登录/改密/锁定/重置/refresh 重放/认领/登出）。

### 接入微信 / 钉钉（必须公网 HTTPS 回调）

```bash
# .env
AUTH_PUBLIC_BASE_URL=https://your-domain.example.com
WECHAT_APP_ID=wxXXXXXXXX
WECHAT_APP_SECRET=xxxxxxxx
DINGTALK_CLIENT_ID=dingXXXXXXXX
DINGTALK_CLIENT_SECRET=xxxxxxxx
```

| 渠道 | 在开放平台登记的回调地址 |
| --- | --- |
| 微信 | `https://your-domain.example.com/api/auth/callback/wechat` |
| 钉钉 | `https://your-domain.example.com/api/auth/callback/dingtalk` |

也可用 `WECHAT_REDIRECT_URI` / `DINGTALK_REDIRECT_URI` 单独覆盖。凭证全部走环境变量，未配置的渠道在登录页显示「未启用」并给出配置提示，**不会构造模拟扫码或假身份**。
微信侧按官方流程依次调用 `qrconnect` → `sns/oauth2/access_token` → `sns/userinfo`；钉钉侧调用
`login.dingtalk.com/oauth2/auth` → `POST /v1.0/oauth2/userAccessToken` → `GET /v1.0/contact/users/me`（请求头 `x-acs-dingtalk-access-token`）。

扫码状态用短轮询：浏览器拿 `ticketId + ticketSecret`（只存当前标签页 `sessionStorage`），跳转到官方扫码页；
回调只把票据标为 `confirmed` 并 302 回前端，**URL 上不出现任何可用凭证**，浏览器再凭票据密钥兑换令牌。

### 开启强制登录

```bash
AUTH_REQUIRED=true
```

此时除 `/api/health`、`/api/ready` 与 `/api/auth/*` 公开端点外，所有业务接口都要求有效令牌，
前端在任意页面未登录时直接渲染登录页。默认是 `false`，保留本机自用的习惯。

`AUTH_NEW_USER_STATUS=pending` 可让新扫码用户先进入待审核状态，管理员在「账号中心 → 用户主表」里启用。

### 令牌与安全约定

- JWT HS256 访问令牌有效期 15 分钟，**只存在浏览器内存**，刷新页面靠 HttpOnly Cookie 静默换回；
- 刷新令牌 30 天、每次使用轮换；旧令牌被重用会撤销整条会话家族；
- Cookie：`HttpOnly` + `SameSite=Lax` + `Path=/api/auth`，生产自动加 `Secure`；依赖 Cookie 的 POST 还做同源校验；
- 令牌不写 `localStorage`、不出现在 URL；密码用 scrypt 加盐哈希，日志与接口都不回传密钥或令牌；
- 401 自动刷新重试一次（4xx 不重试、5xx 最多 3 次），刷新也失败才提示重新登录；
- 登录、刷新、二维码接口按 IP 限流；密钥不填时自动生成 `.data/.authkey`（权限 600）。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/catalog` | 语言、考试、等级、目标分目录 |
| POST | `/api/plans` | 生成计划（同时替换当前计划） |
| GET | `/api/plans/active` | 当前计划 + 逐日摘要 |
| GET | `/api/plans` | 全部计划（含两种语种，供首页切换） |
| POST | `/api/plans/:id/activate` | 切换当前计划（语种切换） |
| GET | `/api/paths/:language` | 学习之路：分级台阶与当前进度 |
| GET | `/api/days/:date` | 某日任务与材料（首次访问时生成） |
| POST | `/api/days/:date/tasks/:id` | 勾选/取消任务 |
| GET | `/api/practice/overview` | 批改中心：今日输出任务 + 记录 + 均分 |
| GET | `/api/practice/:date/:taskId` | 题目、评分标准与本次批改历史 |
| POST | `/api/practice/:date/:taskId/grade` | 提交作文/口语转写稿，返回批改结果 |
| GET | `/api/practice/attempts` | 批改记录与分数走势 |
| GET | `/api/vocab/due` | 今日到期词 |
| POST | `/api/vocab/:id/review` | 记忆评级（0–3） |
| GET | `/api/stats` | 连续打卡、累计时长、达标概率、批改均分 |
| GET/PUT | `/api/settings` | 模型配置与个人信息（含服务商预设） |
| POST | `/api/settings/test` | 用表单里的地址/Key 试连一次 |
| POST | `/api/settings/models` | 拉取该平台的模型列表（`GET /models`） |
| GET | `/api/health` · `/api/ready` | 存活 / 就绪检查（永远公开） |
| GET | `/api/exams` | 试卷列表（含导入卷与内置卷） |
| GET | `/api/exams/:id` | 单份试卷与题目 |
| DELETE | `/api/exams/:id` | 删除自己导入的卷子（内置卷拒删，连带清题目与作答） |
| POST | `/api/exams/:id/attempts` · `PUT .../attempts/:attemptId` | 开始 / 交卷自测 |
| POST | `/api/exam-imports` | 上传 PDF 导入真卷 |
| GET | `/api/exam-imports/jobs/:id` | 查询导入任务进度 |
| DELETE | `/api/exam-imports/:id` | 旧版删除入口（与 `/api/exams/:id` 行为一致，建议收敛到新接口） |

### 用户与鉴权接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | 公开 | 登录页配置：是否强制登录、可用渠道、当前用户 |
| POST | `/api/auth/login` | 公开 | 账号密码登录，返回 accessToken + 设置 refresh Cookie |
| POST | `/api/auth/register` | 公开 | 自助注册（学生/教师）；成功直接登录，pending 时返回待审核 |
| PATCH | `/api/auth/me` | 登录 | 改自己的昵称 / 头像（同步 profile 昵称） |
| POST | `/api/auth/password` | 登录 | 旧密码改新密码，撤销其它设备会话 |
| GET | `/api/auth/guest-data` | 登录 | 认领预览：游客名下各业务表待搬移条数 |
| POST | `/api/auth/claim-guest` | 登录 | 确认认领游客数据（事务逐表搬移，不可逆） |
| POST | `/api/auth/qr/start` | 公开 | 创建扫码票据，返回 `authorizeUrl` 与 `ticketSecret` |
| GET | `/api/auth/qr/:ticketId` | 票据密钥 | 轮询扫码状态（pending / confirmed / failed / expired / consumed） |
| POST | `/api/auth/qr/exchange` | 票据密钥 | 凭票据兑换令牌（一次性） |
| GET | `/api/auth/callback/:provider` | 平台回调 | 微信 / 钉钉 OAuth 回调，处理后 302 回前端 |
| POST | `/api/auth/refresh` | Refresh Cookie | 轮换令牌；检测重放会撤销整条会话家族 |
| POST | `/api/auth/logout` | Refresh Cookie | 撤销会话并清 Cookie |
| GET | `/api/auth/me` | 登录 | 当前用户资料 |
| GET/DELETE | `/api/auth/sessions[/:id]` | 登录 | 会话列表 / 下线指定设备 |
| GET | `/api/auth/admin/users` | 管理员 | 用户主表（含身份与活跃会话数） |
| POST | `/api/auth/admin/users` | 管理员 | 新建本地账号（用户名 + 密码 + 可选昵称/角色/教师等级） |
| PATCH | `/api/auth/admin/users/:id` | 管理员 | 改角色 / 状态 / 昵称（禁止停用唯一管理员） |
| POST | `/api/auth/admin/users/:id/password` | 管理员 | 重置指定用户密码（找回场景，撤销其全部会话） |
| GET | `/api/auth/admin/audit` | 管理员 | 登录审计日志 |

## 说明与边界

- 达标概率是**基于时间的统计估算**，不是承诺；它存在的意义是让你在开始前就知道这份计划是否现实。
- 大模型生成的文章为原创练习题，不复制真题原文；正式备考仍建议配合官方 TPO/過去問。
- 模型 API Key 用 AES-256-GCM 加密后写入 `.data/app.db`，主密钥在 `.data/.llmkey`（600）或 `LLM_MASTER_KEY` 环境变量里；JWT 签名密钥独立放在 `.data/.authkey`（600）或 `AUTH_JWT_SECRET`。两个主密钥都不入库。
- 用户数据按账号隔离，但内置真题库（`exam_papers`）、全局设置与模型 Key 池是系统级共享；同一台机器上的管理员仍可直接读取 SQLite 文件，这不是多租户云服务的隔离级别。
