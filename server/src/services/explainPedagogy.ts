/**
 * 解题答疑视频 · 分级教学法（把五份 N5–N1 通用教案的方法论翻译成提示词）
 *
 * 为什么单独成文件：
 *   1. 教案是「怎么教」，不是「怎么生成 JSON」。混进 explainScript 会让契约与教学法纠缠，
 *      以后调教学法不该碰解析与抢救逻辑；
 *   2. 五个级别的工具（骨架 / 时间轴 / 指代 / 论证四格 / 立场尺度）差别很大，
 *      而模型拿到「N1 材料 + N5 讲法」会讲成逐句翻译，必须按级别注入；
 *   3. 长度档位（短/中/长）同时影响分镜数、旁白字数、maxTokens 与超时，
 *      这些数字只应有一处定义（这里），路由、流水线、预估接口都读它。
 *
 * 对应教案：
 *   N5 骨架与助词换位 / N4 时间轴与四条件形 / N3 段落功能与指代 /
 *   N2 论证四格与干扰项五类 / N1 立场尺度与删词测试。
 *   TOPIK 1–6 级（韩语 1–6 级精读课通用教案，docs/教案/韩语/）：
 *   1 音变还原与助词定角色 / 2 连接词尾方向与阶称 / 3 括号法与指代链 /
 *   4 论证四段与让步强度 / 5 强度尺与责任落点 / 6 关系矩阵与语域反讽。
 * 英语级别是同构迁移（段落功能 + 同义替换），在 profile 里注明。
 */
import type { Language } from '../domain/language';

// --------------------------------------------------------------- 长度档位

export type ExplainDepth = 'short' | 'medium' | 'long';

export const DEPTH_IDS: readonly ExplainDepth[] = ['short', 'medium', 'long'];

export function isExplainDepth(value: unknown): value is ExplainDepth {
  return typeof value === 'string' && (DEPTH_IDS as readonly string[]).includes(value);
}

export interface DepthPlan {
  id: ExplainDepth;
  label: string;
  blurb: string;
  /** 每题分镜数（不含 cover / takeaway） */
  shotsPerQuestion: number;
  /** 每题旁白字数区间（目标语字符 / 英文按词） */
  charsPerQuestion: [number, number];
  /** 单镜旁白下限：低于这个数就是在念答案，不是在讲课 */
  shotFloor: number;
  /** 单镜旁白上限，防止一镜讲两分钟、画面卡住 */
  charCap: number;
  /** 全片允许的 grammar 镜上限 */
  grammarShots: number;
  maxTokens: number;
  /** 单次上游请求超时：输出越多，模型吐得越久，90s 的默认值会把长档误杀 */
  requestTimeoutMs: number;
  /** 脚本阶段总超时（含线路轮换）：长档输出多，给更宽的预算 */
  scriptTimeoutMs: number;
  /** 成片时长上限（校验用） */
  videoCapMs: number;
  /** 每镜平均输出 token（含 JSON 结构），用于预估 */
  tokensPerShot: number;
}

export const DEPTH_PLANS: Record<ExplainDepth, DepthPlan> = {
  short: {
    id: 'short',
    label: '精简',
    blurb: '每题三镜：题 → 证据 → 答案。适合复习与快速过题。',
    shotsPerQuestion: 3,
    charsPerQuestion: [130, 200],
    shotFloor: 32,
    charCap: 90,
    grammarShots: 1,
    maxTokens: 5000,
    requestTimeoutMs: 240_000,
    scriptTimeoutMs: 9 * 60_000,
    videoCapMs: 20 * 60_000,
    tokensPerShot: 440,
  },
  medium: {
    id: 'medium',
    label: '标准',
    blurb: '每题五镜：定位 → 拆解 → 排除 → 答案 → 迁移。日常主用。',
    shotsPerQuestion: 5,
    charsPerQuestion: [320, 440],
    shotFloor: 48,
    charCap: 100,
    grammarShots: 2,
    // 实测标准档输出 8.9–9.2k：给 9000 会周期性触发「截断 → 翻倍重试」，白花一倍时间
    maxTokens: 10_500,
    requestTimeoutMs: 300_000,
    scriptTimeoutMs: 12 * 60_000,
    videoCapMs: 20 * 60_000,
    tokensPerShot: 480,
  },
  long: {
    id: 'long',
    label: '精讲',
    blurb: '每题六到七镜，含语法专镜与第二个视角。难题、长文用。',
    shotsPerQuestion: 6,
    charsPerQuestion: [520, 680],
    shotFloor: 66,
    charCap: 110,
    grammarShots: 3,
    maxTokens: 15_000,
    requestTimeoutMs: 420_000,
    scriptTimeoutMs: 15 * 60_000,
    videoCapMs: 20 * 60_000,
    tokensPerShot: 600,
  },
};

// --------------------------------------------------------------- 级别画像

export type LevelBand =
  | 'n5' | 'n4' | 'n3' | 'n2' | 'n1'
  | 'toefl' | 'ielts' | 'cet' | 'kaoyan'
  | 'topik1' | 'topik2' | 'topik3' | 'topik4' | 'topik5' | 'topik6'
  | 'generic';

export interface LevelProfile {
  band: LevelBand;
  /** 展示名，例如「N1 · 立场与语气」 */
  label: string;
  /** 一句话学情：学生卡在哪 */
  learner: string;
  /** 开场怎么切入（教案的第一环节） */
  entry: string;
  /** 拆解工具：讲证据句时必须用其中至少两项 */
  tools: string[];
  /** 干扰项命名表：排除时必须叫出名字，不许说「感觉不对」 */
  trapNames: string[];
  /** 语言风格：语速、句长、术语密度 */
  register: string;
  /** 一句示范旁白：给模型定调（目标语） */
  sample: string;
}

const PROFILES: Record<LevelBand, LevelProfile> = {
  n5: {
    band: 'n5',
    label: 'N5 · 句子骨架与助词',
    learner: '单词查得出意思，但整句读不出主干；は/が、に/で 常混。',
    entry: '先给一个具体画面（谁、在哪、做什么），让学生用一句话说出来，再回到原句。',
    tools: [
      '骨架还原：把句子压成「誰が｜どこで｜何を｜しました」，再还原成完整句',
      '助词换位测试：把 は/が 或 に/で 换成另一个读一遍，问「意思变了没有、变成什么」',
      '朗读停顿：在助词后画一道斜线，说明为什么在这里换气',
      '依据句：每一题都指出文中第几句是证据，不用排除法代替',
    ],
    trapNames: ['主语看错（は/が）', '场所与时间错位（に/で）', '否定看漏', '时态看错'],
    register: '短句，一句不超过 20 字，但一镜要用两三个短句连成一段话，不要只丢一个词组；语速慢；术语出现即解释。',
    sample: 'まず主語を探しましょう。「わたしは」——ここが主題です。じゃあ「どこで」は？「で」が付いた言葉が場所なんです。',
  },
  n4: {
    band: 'n4',
    label: 'N4 · 时间轴与条件形',
    learner: '事件能看懂，但先后顺序与条件关系常排错；授受方向容易画反。',
    entry: '先问「这两件事哪个先发生」，把学生的直觉写在时间轴上，再回原文核对。',
    tools: [
      '时间轴：てから／あとで／前に／ながら 各标一个点，顺序错就指回标记所在句',
      '四条件形对比：と・ば・たら・なら 同一情境各读一遍，找出「哪一句不能用、为什么」',
      '授受箭头：谁→谁画箭头，箭头画反就回到授受动词重读',
      '接续词方向：だから（顺）／しかし（逆）／そのため（因果）先判方向再选词',
    ],
    trapNames: ['先后颠倒', '条件形误用', '授受方向反了', '接续关系判反'],
    register: '句子短而完整，一镜至少两三个句子；多用「まず／次に／ここで」这类路标词；术语少。',
    sample: 'まず時間の順番を見ましょう。どちらが先ですか。「てから」があるから、こちらが先です。逆に読むと、話が合わなくなります。',
  },
  n3: {
    band: 'n3',
    label: 'N3 · 段落功能与指代',
    learner: '每句都懂、全文不懂；概括时爱抄原句；こ・そ・あ 追丢。',
    entry: '先问「这段话到底在回答什么问题」，把学生的答案与标题并置，制造落差。',
    tools: [
      '段落功能标签：提出／例示／对比／让步／结论，一段一个标签',
      '主题句定位：段首、段末、或「つまり／要するに」之后',
      '指代箭头：それ・これ 指向哪一句，写清「これ＝何」，注意跨句回指',
      '事实／评价分栏：这句是客观陈述还是作者判断，分两栏抄',
      '选项回填：把选项放回原文对应位置，标「一致／矛盾／文中未提」',
    ],
    trapNames: ['以偏概全', '张冠李戴（把引用当主张）', '文中未提', '指代对象错'],
    register: '中等句长；用「这段在做什么」组织语言；少背定义，多给判断动作。',
    sample: 'この段落は、新しい主張ですか、それとも例を挙げていますか。「たとえば」があるなら、答えはもう決まっています。',
  },
  n2: {
    band: 'n2',
    label: 'N2 · 论证结构与干扰项',
    learner: '能读长句，但分不清「主张」与「让步」；错项说不出错在哪。',
    entry: '先抛出常识看法，再问「作者会同意吗」，让让步与转折的必要性显形。',
    tools: [
      '论证四格：主張—根拠—譲歩—結論，先说这句填哪一格',
      '转折回收：しかし／むしろ／とはいえ 之后才是真意，前面是让步',
      '长句三步：先找谓语 → 再切修饰 → 最后补省略，写出还原后的短句',
      '干扰项五类：範囲拡大／因果逆転／主客転倒／程度偏移／文中未出',
    ],
    trapNames: ['範囲拡大', '因果逆転', '主客転倒', '程度偏移', '文中未出'],
    register: '可以用「前提／让步／结论」这类术语，但每个术语后面必须接一句白话。',
    sample: 'この文は主張ではなく、譲歩です。だから後ろに「しかし」が来る。譲歩を主張と読んでしまうと、真意が正反対になります。',
  },
  n1: {
    band: 'n1',
    label: 'N1 · 立场与语气',
    learner: '句子读得太顺，把字面当立场；选项都「像对的」，分不出程度差。',
    entry: '用一个日常现象开场，把它和作者的判断并置：「这句听起来像在夸，其实在降温。」',
    tools: [
      '立场尺度：给关键句标 ＋／－／± 与强度 1–3，并指出依据词',
      '限定词与删词测试：すべて／多くの／必ずしも／おそらく／にすぎない／とは限らない —— 删掉再读，看结论是否从稳妥变绝对',
      '婉曲双栏：字面义 vs 实际义，用上下文反证（「～ではないか」多为委婉主张）',
      '隐含前提：问「这个主张要成立，必须先承认什么」，必要时用反证法',
      '多文本统合：B 对 A 是补充、修正还是对立，三列对照',
    ],
    trapNames: ['範囲拡大（すべて）', '程度偏移', '主客転倒', '因果逆転', '文中未出'],
    register: '允许抽象，但每抽象一步必须落回原文一个具体的词；少用「总之」，多指出限定。',
    sample: 'ここは「にすぎない」。つまり、筆者は評価を下げているんです。友だちの料理に「食べられないことはない」と言うのと同じで、褒める形で距離を置いている。',
  },
  toefl: {
    band: 'toefl',
    label: 'TOEFL · 段落功能与同义替换',
    learner: '能读懂大意，但选项改写一多就认不出对应；推断题容易过度。',
    entry: '先问「作者为什么要提这个例子」，把修辞目的摆到前面，再回到句子。',
    tools: [
      '段落功能：claim／evidence／concession／counter-argument，一句一格',
      '同义替换对照：选项与原文的改写一一对上，指不出对应就不能选',
      '修辞目的：举例、对比、让步各自服务什么，先答目的再答内容',
      '干扰项：过度推断／绝对化／偷换概念／答非所问',
    ],
    trapNames: ['过度推断', '绝对化（all/never）', '偷换概念', '答非所问', '文中未提'],
    register: '英文旁白用口语短句；术语（claim/evidence）出现时立刻用一句白话解释。',
    sample: 'Notice the word "some", not "all". Option B says "all students agree", so that single word already kills it. The author only suggests.',
  },
  ielts: {
    band: 'ielts',
    label: 'IELTS · 定位与改写',
    learner: '能定位，但 T/F/NG 分不清；标题题爱选细节。',
    entry: '先圈题干里的限定条件（时间、范围、比较对象），再回原文找对应。',
    tools: [
      '题干条件圈定：时间／范围／比较对象，先圈后找',
      '同义替换链：题干词 → 原文词，一条链指出来',
      'T/F/NG 判据：原文明确反对=F，原文没提=NG，别用常识补',
      '标题题：看全段功能，不看某一句细节',
    ],
    trapNames: ['用常识代替原文（NG 误判为 T）', '范围扩大', '比较对象错位', '细节代替主旨'],
    register: '旁白简洁，一步一个动作；避免长定语从句。',
    sample: 'The passage never says this. It is not false — simply not given. If you need your own common sense to make it true, the answer is NG.',
  },
  cet: {
    band: 'cet',
    label: '四六级 · 定位与排除',
    learner: '词汇量够，但长句切不开；选项爱选「看起来很对」的。',
    entry: '先问「这道题问的是整篇还是某一段」，把范围定死再找。',
    tools: [
      '范围先定：全文题／段落题／细节题，方法不同',
      '长句切分：主干＋修饰，先划掉插入语',
      '同义替换对照：选项词与原文词一一对应',
      '干扰项：范围扩大／偷换主体／因果倒置／文中未提',
    ],
    trapNames: ['范围扩大', '偷换主体', '因果倒置', '文中未提'],
    register: '旁白用完整英文句，长句先给主干再接修饰；一镜至少两句话；语速稳，不赶。',
    sample: 'Cross out the parenthetical first. The main clause is just "the research shows", and now option C matches it word for word.',
  },
  kaoyan: {
    band: 'kaoyan',
    label: '考研 · 长难句与作者态度',
    learner: '长难句能硬读，但作者态度题常凭感觉；例证题容易答成细节。',
    entry: '先问「作者站哪一边」，再处理句子结构，避免读完不知道立场。',
    tools: [
      '长难句：找谓语 → 切从句 → 补省略，先写主干再翻译',
      '态度词：fortunately／alas／arguably 这类词定调',
      '例证题：先答「例子证明什么」，再回细节',
      '干扰项：过度推断／张冠李戴／绝对化',
    ],
    trapNames: ['过度推断', '张冠李戴', '绝对化', '答非所问'],
    register: '术语可用，但要立刻白话化；语速稳，长句拆成两三个短句说。',
    sample: 'Look at "fortunately". The author has already told you his attitude through that one adverb, so you do not have to guess.',
  },
  // ---- TOPIK 1–6：韩语 1–6 级精读课通用教案（docs/教案/韩语/）逐级翻译 ----
  // 1 级：音变还原 + 助词定角色；不碰从句、逻辑连接与论证（教案「本级重心」）
  topik1: {
    band: 'topik1',
    label: 'TOPIK 1 · 音变还原与助词定角色',
    learner: '字母能拼读但语流中漏音严重，밥을 读成三个音节；이/가 与 은/는 不分全用 은/는；套汉语语序把 을/를 丢掉。',
    entry: '先把证据句慢读一遍，标出音变点（连音·紧音化·鼻音化），把听到的音还原成词典形，再问「谁做什么」用助词钉住角色。',
    tools: [
      '音变还原：在证据句里标出连音（밥을→바블）、紧音化（학교→학꾜）、鼻音化（입니다→임니다）的位置，先还原词典形再谈词义',
      '助词角色钉定：이/가、은/는、을/를、에/에서 各钉一个角色，说清「谁｜什么｜在哪做」',
      '新信息测试：第一次提到的人或物用 이/가，第二次提到换 은/는，问句义焦点变了没有',
      '助词换位测试：把 에 换成 에서 读一遍，问意思变了没有（에＝去向·存在，에서＝动作发生地）',
      '朗读停顿：在助词后画一道斜线慢读，说明为什么在这里换气',
    ],
    trapNames: ['收音读断（밥을 读成三个音节）', '이/가 与 은/는 混用', '套汉语语序丢助词', '音变位置标错（ㅂ+ㄴ 误标成脱落）'],
    register: '句子极短，一镜用两三个短句连成话，不要只丢一个词组；语速慢；术语出现立即用例词演示。',
    sample: '먼저 받침을 찾아 보세요. "밥을"은 "바블"로 연음됩니다. 그다음에 조사를 보세요. "이/가"는 새 정보이고, "은/는"은 이미 아는 이야기입니다.',
  },
  // 2 级：连接词尾定分句逻辑方向 + 时制与阶称一致（教案「本级重心」）
  topik2: {
    band: 'topik2',
    label: 'TOPIK 2 · 连接词尾方向与阶称',
    learner: '单句能读，两个分句就连着往下译：-고 当「因为」、-는데 译成「但是」、命令句前误用 -아서；阶称在同一段里跳级自己察觉不到。',
    entry: '先问「前后两句是什么关系」，再让学生看前句动词末尾的连接词尾定方向，而不是靠翻译猜。',
    tools: [
      '方向牌：-고（并列先后）／-아서·어서（顺接因果，后句禁命令）／-니까（理由，可接命令）／-지만（逆转）／-으면（条件）／-으려고（目的）／-는데（背景对照）',
      '换词尾测试：把 -아서 换成 -니까 读一遍，问句义与合法性变了没有（비가 오니까 우산을 사세요 才成立）',
      '后句语气检验：先看后句是陈述、命令还是劝诱，再回头定前句词尾',
      '阶称扫描：해／해요／합니다 在同一段是否一致，不一致处标出来并统一',
      '时制叠加：词干 + 时制(-았/었-, -겠-) + 连接词尾的顺序读出来',
    ],
    trapNames: ['-고 当因果', '命令句前误用 -아서', '-는데 译成「但是」', '阶称跳级'],
    register: '短句完整，一镜至少两三个句子；多用「先看词尾」「后句是什么语气」这类路标句；术语少。',
    sample: '먼저 어미를 보세요. "-아서" 뒤에는 명령문이 올 수 없습니다. "비가 오니까 우산을 사세요"가 맞습니다. 어미가 문장의 방향을 정합니다.',
  },
  // 3 级：括号法切分长名词短语 + 段落指代链（教案「本级重心」）
  topik3: {
    band: 'topik3',
    label: 'TOPIK 3 · 长名词短语与指代链',
    learner: '复句能处理，但长名词短语从左往右逐词译，把第一个名词当中心；-(으)ㄹ 全读成「将要」；이/그 一律译「这/那」，第三句就不知道 그것 指什么。',
    entry: '先问「这句话讲的是谁」，把学生的答案与最右边的中心名词并置，暴露中心名词错位。',
    tools: [
      '括号法三步：①找最右边的名词 → ②看紧挨它左边的冠形词尾 → ③整块加括号（[어제 만난 사람이 준] 책，中心是 책）',
      '冠形词尾定时制：-은 过去／-는 现在／-(으)ㄹ 将来·推测／-던 过去回想，用 갈 사람／온 사람／오는 사람 三句对照',
      '指代链：이／그／저 与 이런／그런 的箭头必须落在具体短语上，写清「그것＝什么」',
      '主题句定位：段首或说明文结论后置处，先标主题句再读细节',
      '选项回填：放回原文对应位置，标一致／矛盾／文中未提',
    ],
    trapNames: ['中心名词错位（取第一个名词）', '-(으)ㄹ 时制误读', '-던 读成将来', '指代对象错'],
    register: '中等句长；用「先找中心」「箭头落在哪个短语」组织语言；少背定义，多给切分动作。',
    sample: '중심 명사는 맨 오른쪽에 있습니다. "[어제 도서관에서 만난 사람이 준] 책" — 이 문장의 주인공은 책입니다. 괄호를 치고 나면 긴 문장도 무너지지 않습니다.',
  },
  // 4 级：论证四段定位 + 让步强度分档 + 名词化还原（教案「本级重心」）
  topik4: {
    band: 'topik4',
    label: 'TOPIK 4 · 论证结构与让步强度',
    learner: '句子读得懂但立场读不准：把作者先承认对方的那一段当作者观点；-지만 与 -는데도 一律译「但是」；名词化句只按词义译，说不出否定落点。',
    entry: '先出示「물론 비용 문제도 있다. 그러나…」两句，问哪一句是作者真正的立场，让让步与主张的分界显形。',
    tools: [
      '论证四段：주장（主张）—근거（依据）—양보（让步）—결론（回收），主张通常不在第一段，转折词尾是回收信号',
      '让步强度表：-지만（弱·承认）→ -는데도（强·不满）→ -더라도（假设）→ -(ㄴ)다 해도（引用式让步），先排序再判档',
      '名词化还原：-ㅁ/-음、-다는 것、-라는 지적 先还原成从句，再问否定与评价落在哪个动作上（설명하기는 어렵다 ≠ 이유가 없다）',
      '新闻被动追问：지적되었다／밝혀졌다 缺施事，问「谁指出？不说出来责任归属怎么变了」',
    ],
    trapNames: ['让步当立场', '让步强度混同', '名词化否定落点错', '被动句责任错位'],
    register: '可用「주장／양보／명사화」这类术语，但每个术语后面必须接一句白话；语速稳。',
    sample: '"물론" 다음 문장을 보세요. 그것은 양보이지 주장이 아닙니다. "그러나" 뒤에야 작가의 진짜 위치가 나옵니다. 양보를 주장으로 읽으면 결론이 정반대가 됩니다.',
  },
  // 5 级：语气强度尺 + 责任落点定位 + 删词测试（教案「本级重心」）
  topik5: {
    band: 'topik5',
    label: 'TOPIK 5 · 语气强度与责任落点',
    learner: '长文不缺词汇缺「读语气」：-(으)ㄹ 수도 있다 与 -(으)ㄹ 수 있다 当同义；-에 지나지 않는다 译成「只是」丢掉贬抑；推测句当事实报道。',
    entry: '用最小对立组开场：同一命题的三句（있다／있을 수 있다／있을 수도 있다）并排，问哪一句作者最确定。',
    tools: [
      '强度尺 0–5：0 断言｜1 -(으)ㄹ 수도 있다｜2 -(으)ㄹ 것 같다·듯하다｜3 -(으)ㄹ 수 있다｜4 -기 마련이다｜5 -(으)ㄹ 수밖에 없다；反向档 -(으)ㄹ 리가 없다 单列不进正向尺',
      '删词测试：删掉情态或评价词再读，看判断是否从保留变成绝对断言，据此修正选项',
      '责任落点两问：-아/어야 한다 把义务压给行为者，-는 것이 바람직하다 把责任移到做法上——问「谁被要求、谁被评价」',
      '贬抑读法：-에 지나지 않는다 不只是「只是」，是「不值得这么评价」，回上下文核对是否吻合',
    ],
    trapNames: ['情态强度混同（수도 있다 当 수 있다）', '推测当事实', '贬抑漏读（에 지나지 않는다）', '责任落点错'],
    register: '允许抽象，但每一步都要落回原文一个具体的词尾；少说「总之」，多指出强度差。',
    sample: '"-ㄹ 수도 있다"는 여지를 남기는 표현입니다. "-ㄹ 수 있다"와 같은 뜻이 아닙니다. 이 어미를 지우면 문장이 단언으로 변합니다. 작가의 확신도는 바로 여기에 있습니다.',
  },
  // 6 级：关系矩阵 + 引用还原 + 语域三同步 + 反讽线索（教案「本级重心」）
  topik6: {
    band: 'topik6',
    label: 'TOPIK 6 · 文本关系与语域反讽',
    learner: '单篇读得准，双文本就退回各读各的：把 B 篇首句「물론」当完全同意；引用句只译「有人说」；反讽按字面读成称赞。',
    entry: '出示一对最小对立句（효과가 있다／있기는요），问 B 是同意、否认还是讽刺，依据是什么。',
    tools: [
      '三格矩阵：B 篇的主张／依据／对 A 的态度三格填满再判关系（互补·对立·修正·前提），判定看结论落点与 -지만／-ㄴ 반면／-다는 점에서 信号',
      '引用还原：-다고 하다（转述）／-라는 주장（被引主张）还原成「谁对谁说了什么」，区分作者观点与被引观点',
      '语域三同步：해요体／합쇼体／문어体(-ㄴ다·-(으)ㅁ) 的距离感不同，改写时语尾、称呼、청유 三处必须同步',
      '反讽线索三问：字面义 → 线索（语尾·称呼·前后是否矛盾）→ 意图义（-기는요：谦辞还是反讽；-다니：惊讶还是否定）',
    ],
    trapNames: ['承认当同意（물론 后有修正）', '转述当作者主张', '语域改写只换语尾', '反讽按字面读'],
    register: '术语密度最高的一级，但每个术语都要落回原文线索；反讽判定必须给出线索，不许说「感觉像」。',
    sample: '"있기는요"는 단순한 동의가 아닙니다. 누가 말했는지, 앞뒤가 모순되는지 보세요. 글자 그대로 읽으면 빈정거림을 칭찬으로 읽는 꼴이 됩니다.',
  },
  generic: {
    band: 'generic',
    label: '通用 · 证据与排除',
    learner: '能读大意，但说不清依据句；错项靠感觉排除。',
    entry: '先问「如果只能留一句原文当证据，你留哪句」，把注意力压到证据上。',
    tools: [
      '证据句：每题指出一句原文，并说明为什么不是相邻句',
      '句法拆解：主干＋修饰，先划掉插入成分',
      '选项对照：选项与原文逐词对应，指不出对应就不选',
      '干扰项：范围扩大／因果倒置／主体错位／文中未提',
    ],
    trapNames: ['范围扩大', '因果倒置', '主体错位', '文中未提'],
    register: '短句、口语；术语出现即解释。',
    sample: 'Find the one sentence that proves it. Everything else is noise. If no single sentence can carry the answer, the option is simply too broad.',
  },
};

/** 从计划的 target_label / exam_id 推断级别；拿不到就按语种给中间档 */
export function resolveLevelProfile(params: {
  language: Language;
  examLabel?: string | null;
  examId?: string | null;
}): LevelProfile {
  const label = (params.examLabel ?? '').trim();
  const exam = (params.examId ?? '').trim().toLowerCase();

  const jlpt = label.match(/N\s*([1-5])/i);
  if (jlpt) return PROFILES[`n${jlpt[1]}` as LevelBand];

  // TOPIK 1–6 级：catalog 的 label 是「TOPIK 3 级」（数字后有空格 + 级），
  // 正则兼容「TOPIK3」无空格写法；6 级有独立教案（docs/教案/韩语/韩语6级…），不再回落 5 级
  const topik = label.match(/TOPIK\s*([1-6])/i);
  if (topik) return PROFILES[`topik${Number(topik[1])}` as LevelBand];

  if (/托福|toefl/i.test(label) || exam === 'toefl') return PROFILES.toefl;
  if (/雅思|ielts/i.test(label) || exam === 'ielts') return PROFILES.ielts;
  if (/六级|四级|cet/i.test(label) || exam === 'cet') return PROFILES.cet;
  if (/考研|kaoyan/i.test(label)) return PROFILES.kaoyan;

  // 没有级别信息时按语种给一个中间档：日语按 N3（结构问题最常见），
  // 韩语按 TOPIK 3 级（长名词短语与指代是中级最常见的失分点），英语按四六级
  if (params.language === 'ja') return PROFILES.n3;
  if (params.language === 'ko') return PROFILES.topik3;
  return PROFILES.cet;
}

// --------------------------------------------------------------- 提示词拼装

const LANG_NAME: Record<Language, string> = { en: 'English', ja: '日本語', ko: '한국어' };

function lengthUnit(language: Language): string {
  return language === 'en' ? 'words' : 'characters';
}

function shotPlan(plan: DepthPlan): string {
  if (plan.id === 'short') {
    return `cover, then for EACH question in order: question -> passage -> answer; at most ${plan.grammarShots} "grammar" shot in the whole video (only if one structure blocks everything); finally one takeaway.`;
  }
  if (plan.id === 'medium') {
    return `cover, then for EACH question in order: question -> passage -> eliminate -> answer -> point; at most ${plan.grammarShots} "grammar" shots in the whole video (put one right after the passage it explains); finally one takeaway.`;
  }
  return `cover, then for EACH question in order: question -> passage -> grammar (only when the sentence's structure is the real obstacle) -> eliminate -> answer -> point, plus ONE extra point shot for the 1st and 2nd question only if it adds a genuinely different angle; at most ${plan.grammarShots} grammar shots in the whole video; finally one takeaway.`;
}

/** 单镜字数下限：以 shotFloor 为基准，按「这一镜要干几件事」伸缩，且不越过上限 */
function kindFloor(plan: DepthPlan, factor: number): number {
  return Math.min(plan.charCap, Math.max(18, Math.round(plan.shotFloor * factor)));
}

/**
 * 密度示范：一段「合格」的旁白长什么样。
 *
 * 只给规则不给样子，模型会写成电文体（「ここが根拠。声が『相次いだ』。」）——
 * 语法全对、信息全在，但那是答案卡，不是讲课。这一段是长度与质感的锚点。
 */
const DENSITY_SAMPLE: Record<Language, string> = {
  ja: '「すべて」に注目してください。本文は「多くの人が」としか言っていません。範囲を広げた瞬間、この選択肢はもう終わりです。',
  en: 'Watch the word "many". The passage never says "all". The moment an option widens the scope, it is already dead.',
  ko: '「모든」를 보세요. 본문은 「많은 사람이」라고만 합니다. 범위를 넓히는 순간 그 선지는 이미 틀린 것입니다.',
};

/**
 * 生成「教学法 + 长度档位」这一段提示词。
 * 注意：它会被拼在 system prompt 里，每个 token 都要付钱，所以只写能改变输出的规则，
 * 不写「你要认真」「你是专家」这类没有约束力的鼓励。
 */
export function buildPedagogyPrompt(
  profile: LevelProfile,
  plan: DepthPlan,
  language: Language,
): string {
  const unit = lengthUnit(language);
  const target = LANG_NAME[language] ?? 'English';
  const [charsLow, charsHigh] = plan.charsPerQuestion;
  const f = (factor: number) => kindFloor(plan, factor);

  return `TEACHING BAR (this is what separates you from a solution manual)
You are a master teacher giving one student a private lesson, not a narrator reading an answer key.
Success = after this video the student can solve the NEXT question of the same type alone.
Every question must leave the student with ONE reusable move, not a memorised answer.
Speak in full sentences, the way a teacher talks. Never telegram style: "ここが根拠。声が相次いだ。" is a note, not a lesson.

THE SEVEN BEATS — each beat is one shot; each beat says what must be SPOKEN in it
1. HOOK ("question", >= ${f(0.9)} ${unit}): (a) open on a concrete scene or the wrong intuition most students have; (b) name in one sentence what the question is really testing; (c) tell them what to hunt for while reading. Never read the prompt aloud.
2. LOCATE ("passage", >= ${f(1)} ${unit}): (a) point at the exact word ("look at this に"); (b) read the clause around it; (c) say why the sentence above is NOT the proof. The neighbour check is mandatory.
3. DISMANTLE ("grammar", >= ${f(1.3)} ${unit}): (a) quote the surface form; (b) use two LEVEL TOOLS by name; (c) swap it and show what changes — one concrete contrast, not a definition.
4. ELIMINATE ("eliminate", >= ${f(1.2)} ${unit}): kill at least two options. For each: (a) name the trap from TRAP NAMES; (b) quote the betraying word; (c) say what the student probably thought. Never "this one feels wrong".
5. RESOLVE ("answer", >= ${f(1)} ${unit}): (a) quote the evidence word-for-word; (b) line the correct option up against it, word by word; (c) one sentence on why nothing else fits. Add no new information.
6. TRANSFER ("point", >= ${f(0.6)} ${unit}): (a) the first move for next time; (b) the trigger word to watch for; (c) when NOT to use it.
7. ANCHOR ("takeaway", exactly ONE for the whole video, at the very end): one line they could repeat from memory. Short. No summary of everything. Do not add a takeaway after each question.

LEVEL PLAYBOOK — ${profile.label}
Learner: ${profile.learner}
Open with: ${profile.entry}
Use these tools (name them when you use them):
${profile.tools.map((tool, i) => `  ${i + 1}. ${tool}`).join('\n')}
When eliminating, the only allowed trap names are: ${profile.trapNames.join(' / ')}.
Register: ${profile.register}
Voice reference (match this tone in ${target}): ${profile.sample}

SCHOLARLY TOUCH (引经据典) — allowed and encouraged, but never invented
Allowed: the grammar point's typical use in other real contexts at this level; genuinely existing idioms / 四字熟語 / 慣用句; kanji-morpheme logic; cultural background that explains the wording (e.g. why Japanese hedges with ～ではないか).
Forbidden: invented quotations, invented authors or sources ("夏目漱石曾说过…"), invented exam years or statistics, invented dictionary definitions.
If unsure, say "many textbooks treat this as…" instead of fabricating a source.
Dose: at most ONE scholarly reference per question, and only if it shortens the explanation. It must earn its seconds.

VOICE & RHYTHM (make it alive)
- Talk, don't read. Contractions, short sentences, occasional "you" and "we".
- Ask a real question every 2–3 sentences, then answer it yourself ("So why に and not で? Because…").
- Use one analogy per question for anything abstract, drawn from daily life, not from grammar terminology.
- Vary rhythm: after a dense sentence, drop one very short sentence ("That's the whole trick.").
- Banned filler: "首先/其次/接下来我们来看/综上所述", "这道题的答案是" repeated in every shot, "让我们". Banned: reading the prompt twice.

LENGTH PLAN — ${plan.label} (${plan.id})
- HARD FLOOR: each question's narration must total >= ${charsLow} ${unit}. A question under the floor is a solution key, not a lesson — add the move you skipped.
- CEILING: stop at ${charsHigh} ${unit} per question. Over the ceiling, cut the weakest beat instead of adding another shot; the student's attention is the scarce resource, not your token budget.
- Per shot: ${plan.shotFloor}–${plan.charCap} ${unit}. Content shots (question / passage / grammar / eliminate / answer) never go below ${plan.shotFloor}; "point" may be shorter; "cover" <= 30; "takeaway" <= 35.
- Shot plan: ${shotPlan(plan)}
- Captions are Chinese and may be shorter than narration, but must carry the same logic (not a summary label).
- COUNT BEFORE YOU ANSWER: add up the narration ${unit} per question. If it is short, the missing part is a BEAT, not words — add the move you skipped (the wrong intuition, the neighbour check, the betraying word, the trigger word). Never pad by restating the prompt.
- If the material is short and the budget is not used up, go deeper on the evidence sentence.

DENSITY REFERENCE (this is the length and texture required, in ${target}) — one "eliminate" shot
${DENSITY_SAMPLE[language]}`;
}

// --------------------------------------------------------------- 成本预估

export interface DepthEstimate {
  id: ExplainDepth;
  label: string;
  blurb: string;
  shots: number;
  /** 成片时长（秒）：这是学生要看的长度 */
  secLow: number;
  secHigh: number;
  /** 生成等待（秒）：大模型写脚本 + 配音 + 组装，和成片时长是两件事 */
  genSecLow: number;
  genSecHigh: number;
  tokenLow: number;
  tokenHigh: number;
}

/** 旁白字符 → 秒：实测 43 字日文 ≈ 8.9 秒（rate 0.92），取 0.21 s/字；英语按词 0.42 s/词 */
function secondsFor(chars: number, language: Language): number {
  return language === 'en' ? chars * 1.7 : chars * 0.21;
}

/**
 * 预估分镜数 / 时长 / token。只给量级，不承诺精确值；
 * 校准样本：4 题 22 镜 6.7k token（旧提示词），3 题 15 镜 6.7k。
 */
export function estimateDepth(
  plan: DepthPlan,
  params: { questionCount: number; bodyChars: number; translationChars?: number; language: Language },
): DepthEstimate {
  const q = Math.max(1, params.questionCount);
  // 语法镜是计划内的额外镜（最多 grammarShots 个），不占每题五镜的名额
  const shots = plan.shotsPerQuestion * q + 2 + Math.min(plan.grammarShots, q);

  const [low, high] = plan.charsPerQuestion;
  const coverOutro = 65;
  const secondsLow = secondsFor(low * q + coverOutro, params.language);
  const secondsHigh = secondsFor(high * q + coverOutro, params.language);

  // 提示词：系统提示（含教学法，约 1.6k）+ 正文 + 译文 + 题干 + 词汇表
  // 系数按一次真实生成反推（标准档实测 prompt 约 2.5k），不是拍脑袋的上限
  // 实测（标准档 19 镜、3 题、正文 324 字）：prompt 3 609，输出 9 193。
  // 常数量级由实测反推：系统提示含教学法约 2.5k，每题题干 + 选项约 250。
  const promptTokens =
    2_500 +
    params.bodyChars * 0.45 +
    (params.translationChars ?? 0) * 0.45 +
    q * 250 +
    200;
  const completionTokens = shots * plan.tokensPerShot + 300;
  const total = promptTokens + completionTokens;

  const round500 = (n: number) => Math.max(500, Math.round(n / 500) * 500);

  // 生成等待：脚本约占大头，配音/组装按镜数累加。
  // 校准样本：标准档 19 镜、输出 9 193 token，脚本段实测约 120s ≈ 76 token/s；
  // 换线/重试会翻倍，所以取 55 偏保守，让区间上界覆盖坏情况。
  const scriptSeconds = 35 + completionTokens / 55 + promptTokens / 300;
  const speechSeconds = shots * 2.5;
  const genBase = scriptSeconds + speechSeconds;

  return {
    id: plan.id,
    label: plan.label,
    blurb: plan.blurb,
    shots,
    secLow: Math.max(45, Math.round(secondsLow)),
    secHigh: Math.max(60, Math.round(secondsHigh)),
    genSecLow: Math.round(genBase * 0.8),
    genSecHigh: Math.round(genBase * 1.5),
    tokenLow: round500(total * 0.85),
    tokenHigh: round500(total * 1.2),
  };
}

export function estimateAllDepths(params: {
  questionCount: number;
  bodyChars: number;
  translationChars?: number;
  language: Language;
}): DepthEstimate[] {
  return DEPTH_IDS.map((id) => estimateDepth(DEPTH_PLANS[id], params));
}
