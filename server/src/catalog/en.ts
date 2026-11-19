import type { ExamDef, LevelDef, PhaseDef } from './types';

export const EN_LEVELS: LevelDef[] = [
  {
    id: 'hs',
    name: '高中水平',
    cefr: 'A2–B1',
    vocab: 3500,
    hoursFromZero: 300,
    equiv: { toefl: 45, ielts: 4.5, cet6: 380, kaoyan: 40 },
    note: '能读懂日常短文，长难句与学术词汇是主要短板。',
  },
  {
    id: 'cet4',
    name: '大学英语四级',
    cefr: 'B1',
    vocab: 4500,
    hoursFromZero: 550,
    equiv: { toefl: 60, ielts: 5.0, cet6: 430, kaoyan: 48 },
    note: '四级 425–500 左右：日常阅读尚可，学术讲座听力与输出表达吃力。',
  },
  {
    id: 'cet6',
    name: '大学英语六级',
    cefr: 'B2',
    vocab: 6000,
    hoursFromZero: 800,
    equiv: { toefl: 75, ielts: 6.0, cet6: 500, kaoyan: 58 },
    note: '六级 425–500：能读一般学术文章，速度与同义替换识别仍需强化。',
  },
  {
    id: 'cet6plus',
    name: '六级 550+ / 雅思 6.5',
    cefr: 'B2+',
    vocab: 7000,
    hoursFromZero: 1000,
    equiv: { toefl: 85, ielts: 6.5, cet6: 560, kaoyan: 66 },
    note: '基础较扎实，主要差距在口语流利度与写作论证深度。',
  },
  {
    id: 'tem4',
    name: '英语专业四级 / 托福 90+',
    cefr: 'C1',
    vocab: 8500,
    hoursFromZero: 1400,
    equiv: { toefl: 95, ielts: 7.0, cet6: 620, kaoyan: 75 },
  },
];

const EN_FOUNDATION_MIX = {
  vocab: 0.3,
  read: 0.28,
  speak: 0.13,
  listen: 0.16,
  write: 0.07,
  grammar: 0.06,
} as const;

const EN_BUILD_MIX = {
  vocab: 0.2,
  read: 0.28,
  speak: 0.14,
  listen: 0.18,
  write: 0.1,
  grammar: 0.05,
  mock: 0.05,
} as const;

const EN_SPRINT_MIX = {
  vocab: 0.12,
  read: 0.22,
  speak: 0.14,
  listen: 0.16,
  write: 0.12,
  mock: 0.24,
} as const;

function threePhases(
  foundation: { goal: string; focus: string[] },
  build: { goal: string; focus: string[] },
  sprint: { goal: string; focus: string[] },
  mixes: { f: PhaseDef['mix']; b: PhaseDef['mix']; s: PhaseDef['mix'] } = {
    f: EN_FOUNDATION_MIX,
    b: EN_BUILD_MIX,
    s: EN_SPRINT_MIX,
  },
): PhaseDef[] {
  return [
    { key: 'foundation', name: '筑基期', startRatio: 0, ...foundation, mix: mixes.f },
    { key: 'build', name: '专项强化期', startRatio: 0.35, ...build, mix: mixes.b },
    { key: 'sprint', name: '冲刺模考期', startRatio: 0.72, ...sprint, mix: mixes.s },
  ];
}

export const EN_EXAMS: ExamDef[] = [
  {
    id: 'toefl',
    language: 'en',
    name: '托福 iBT',
    provider: 'ETS',
    scaleLabel: '0–120 分',
    scaleNote:
      '2026 年 1 月 21 日起官方并行 1–6 分制：总分 100 分约等于新制 5 分（CEFR C1）。本系统仍按 120 分制换算目标。',
    sections: [
      { id: 'reading', name: '阅读', minutes: 35, format: '2 篇学术文章 / 每篇 10 题，自适应出题' },
      { id: 'listening', name: '听力', minutes: 36, format: '2 篇对话 + 3 篇讲座，只播一遍' },
      { id: 'speaking', name: '口语', minutes: 16, format: '4 道题（1 独立 + 3 综合），机器评分' },
      { id: 'writing', name: '写作', minutes: 29, format: '综合写作 + 学术讨论写作' },
    ],
    targets: [
      {
        score: 80,
        label: '托福 80',
        sections: { reading: 21, listening: 20, speaking: 19, writing: 21 },
        vocabNeed: 7000,
        note: '多数美国研究生项目的最低门槛。',
      },
      {
        score: 90,
        label: '托福 90',
        sections: { reading: 23, listening: 23, speaking: 22, writing: 23 },
        vocabNeed: 8500,
      },
      {
        score: 100,
        label: '托福 100',
        sections: { reading: 26, listening: 25, speaking: 24, writing: 25 },
        vocabNeed: 10000,
        note: '美国 Top30 基础门槛，四项均需 24+，口语是最常见卡点。',
      },
      {
        score: 110,
        label: '托福 110',
        sections: { reading: 29, listening: 28, speaking: 28, writing: 27 },
        vocabNeed: 12000,
      },
    ],
    syllabus: [
      '学术词汇 8000–10000：高频词需会听会写会用，学科术语认识即可',
      '长难句拆解：定语从句嵌套、插入语、倒装与省略',
      '阅读 10 大题型：事实信息、否定事实、推断、修辞目的、词汇、指代、句子简化、插入文本、小结、表格',
      '听力笔记法：信号词（转折/举例/因果/列举）与考点预判',
      '口语四题结构：独立题 15 秒准备 / 综合题模板化转述',
      '综合写作：阅读三点 + 听力三点逐条反驳',
      '学术讨论写作：10 分钟内表明立场 + 例证 + 回应同学观点',
    ],
    topicPool: [
      '动物的行为与演化',
      '行星形成与板块运动',
      '从壁画到现代主义的艺术史',
      '记忆、注意力与决策偏差',
      '贸易、货币与城市化',
      '群体行为与制度变迁',
      '气候反馈与能源转型',
      '语言习得与语言消亡',
      '移民、工业与改革运动',
      '学习科学与课堂设计',
    ],
    hoursModel: { mode: 'perPoint', perPoint: 10 },
    phases: threePhases(
      {
        goal: '把词汇与语法底盘补齐，建立每日精读 + 精听节奏',
        focus: ['核心词汇 3000→6000', '长难句每日 5 句拆解', '听力跟读与听写', '学术话题背景知识'],
      },
      {
        goal: '按题型专项突破，阅读与听力稳到 25+',
        focus: ['阅读题型专项 10 类', '听力笔记法与考点预判', '口语四题模板内化', '综合写作三驳三立'],
      },
      {
        goal: '全真模考 + 错题复盘，把分数稳定在目标线以上',
        focus: ['每周 2 套全真模考', '错题归因表', '口语限时录音复听', '写作机评 + 人工精修'],
      },
    ),
    textLength: { intensive: 280, extensive: 180 },
  },
  {
    id: 'ielts',
    language: 'en',
    name: '雅思 Academic',
    provider: 'British Council / IDP',
    scaleLabel: '0–9 分（半分档）',
    sections: [
      { id: 'listening', name: '听力', minutes: 30, format: '4 个 Section / 40 题' },
      { id: 'reading', name: '阅读', minutes: 60, format: '3 篇长文 / 40 题' },
      { id: 'writing', name: '写作', minutes: 60, format: 'Task 1 图表 + Task 2 议论文' },
      { id: 'speaking', name: '口语', minutes: 14, format: 'Part 1–3 面对面' },
    ],
    targets: [
      {
        score: 6.5,
        label: '雅思 6.5',
        sections: { listening: 6.5, reading: 7, writing: 6, speaking: 6 },
        vocabNeed: 7000,
      },
      {
        score: 7,
        label: '雅思 7.0',
        sections: { listening: 7.5, reading: 7.5, writing: 6.5, speaking: 6.5 },
        vocabNeed: 8000,
        note: '英国 G5 与澳洲八大的常见门槛，写作 6.5 是多数人的瓶颈。',
      },
      {
        score: 7.5,
        label: '雅思 7.5',
        sections: { listening: 8, reading: 8, writing: 7, speaking: 7 },
        vocabNeed: 9500,
      },
    ],
    syllabus: [
      '听力四 Section：场景词 + 拼写准确性（人名地名数字）',
      '阅读：Heading、Matching、T/F/NG 三大高失分题型',
      'Task 1：图表描述的数据分组与趋势表达',
      'Task 2：四类题型（观点/讨论/利弊/问题解决）与论证展开',
      '口语 Part 2：1 分钟准备 + 2 分钟独白的故事线设计',
      '评分四维：流利度、词汇资源、语法多样性与准确性、发音',
    ],
    topicPool: [
      '教育与学习方式',
      '科技与工作变迁',
      '城市交通与住房',
      '环境与可持续生活',
      '健康与公共政策',
      '媒体与信息素养',
      '文化与旅游',
      '家庭与代际关系',
      '消费主义与幸福感',
      '全球化与本土产业',
    ],
    hoursModel: { mode: 'perPoint', perPoint: 220 },
    phases: threePhases(
      {
        goal: '打通听力拼写与阅读定位，建立写作句型库',
        focus: ['场景词汇 + 拼写训练', '同义替换识别', 'Task 1 趋势句型 30 条', '口语 Part 1 高频题'],
      },
      {
        goal: '三大高失分题型专项 + 写作按评分维度逐项提升',
        focus: ['Heading / Matching / T-F-NG 专项', 'Task 2 四大题型框架', 'Part 2 话题卡串讲', '发音连读弱读训练'],
      },
      {
        goal: '限时套题 + 写作精批，稳定 7.0',
        focus: ['每周 2 套听力阅读限时', '写作逐篇精批', '口语全真模拟', '高频错题清单'],
      },
    ),
    textLength: { intensive: 300, extensive: 200 },
  },
  {
    id: 'cet6',
    language: 'en',
    name: '大学英语六级',
    provider: '教育部教育考试院',
    scaleLabel: '0–710 分（425 合格）',
    sections: [
      { id: 'writing', name: '写作', minutes: 30, format: '1 篇 150–200 词' },
      { id: 'listening', name: '听力', minutes: 30, format: '长对话 + 听力篇章 + 讲座' },
      { id: 'reading', name: '阅读', minutes: 40, format: '选词填空 + 长篇匹配 + 仔细阅读' },
      { id: 'translation', name: '翻译', minutes: 30, format: '汉译英段落' },
    ],
    targets: [
      {
        score: 425,
        label: '六级 425（合格）',
        sections: { writing: 64, listening: 149, reading: 149, translation: 64 },
        vocabNeed: 5500,
      },
      {
        score: 500,
        label: '六级 500',
        sections: { writing: 75, listening: 175, reading: 175, translation: 75 },
        vocabNeed: 6000,
        note: '保研与部分外企校招的常见要求。',
      },
      {
        score: 550,
        label: '六级 550+',
        sections: { writing: 82, listening: 193, reading: 193, translation: 82 },
        vocabNeed: 6500,
        note: '六级 550 相当于托福 80 左右的基础，可衔接考研与出国备考。',
      },
    ],
    syllabus: [
      '核心词汇 6000 + 高频短语 500',
      '听力：长对话场景词、讲座信号词与速记',
      '阅读：长篇匹配的关键词定位、仔细阅读的干扰项识别',
      '翻译：中国文化与社会话题的固定表达',
      '写作：议论文三段式与万能但不说空话的论证',
    ],
    topicPool: [
      '中国传统文化与非遗',
      '城市化与乡村振兴',
      '数字经济与就业',
      '教育公平',
      '环境保护与碳中和',
      '科技创新',
      '人口结构变化',
      '社交媒体的影响',
    ],
    hoursModel: { mode: 'perPoint', perPoint: 1.6 },
    phases: threePhases(
      {
        goal: '词汇过线 + 听力适应语速',
        focus: ['高频词 2000 个', '听力精听 15 分钟/天', '长篇阅读定位训练'],
      },
      {
        goal: '按题型专项，把阅读与听力拉到 175+',
        focus: ['仔细阅读干扰项分析', '选词填空词性判断', '翻译固定句式', '写作模板去模板化'],
      },
      {
        goal: '真题限时 + 错题归因',
        focus: ['近 10 套真题限时', '听力错题复听', '翻译逐句批改'],
      },
      { f: EN_FOUNDATION_MIX, b: EN_BUILD_MIX, s: EN_SPRINT_MIX },
    ),
    textLength: { intensive: 260, extensive: 170 },
  },
  {
    id: 'kaoyan',
    language: 'en',
    name: '考研英语一',
    provider: '教育部',
    scaleLabel: '0–100 分',
    sections: [
      { id: 'cloze', name: '完形填空', minutes: 15, format: '20 题 × 0.5 分' },
      { id: 'reading', name: '阅读理解', minutes: 70, format: '4 篇 × 5 题，40 分' },
      { id: 'newtype', name: '新题型', minutes: 15, format: '七选五 / 排序 / 小标题，10 分' },
      { id: 'translation', name: '翻译', minutes: 20, format: '英译汉 5 句，10 分' },
      { id: 'writing', name: '写作', minutes: 50, format: '小作文 10 分 + 大作文 20 分' },
    ],
    targets: [
      {
        score: 60,
        label: '考研 60',
        sections: { reading: 24, writing: 15, translation: 6, newtype: 6, cloze: 6 },
        vocabNeed: 5500,
      },
      {
        score: 70,
        label: '考研 70',
        sections: { reading: 30, writing: 17, translation: 7, newtype: 7, cloze: 7 },
        vocabNeed: 6000,
      },
      {
        score: 80,
        label: '考研 80',
        sections: { reading: 36, writing: 19, translation: 8, newtype: 8, cloze: 8 },
        vocabNeed: 7000,
        note: '985 热门专业的竞争力分数，阅读最多错 2 题。',
      },
    ],
    syllabus: [
      '大纲词汇 5500，熟词僻义是命题重点',
      '长难句：三大从句 + 非谓语 + 插入语',
      '阅读六大题型与选项陷阱（偷换概念、过度推断、以偏概全）',
      '新题型：段落逻辑衔接与代词指代',
      '翻译：定语从句拆分与语序调整',
      '写作：小作文书信格式 + 大作文图画描述与立意',
    ],
    topicPool: [
      '科技与伦理',
      '经济政策与社会公平',
      '媒体与舆论',
      '教育改革',
      '环境治理',
      '法律与隐私',
      '心理学与行为',
      '全球化与产业链',
    ],
    hoursModel: { mode: 'perPoint', perPoint: 6 },
    phases: threePhases(
      {
        goal: '大纲词汇第一轮 + 长难句拆解能力',
        focus: ['大纲词汇 5500 第一轮', '每日 3 个长难句', '真题阅读精读（2005–2012）'],
      },
      {
        goal: '阅读正确率稳定 80%，翻译与写作成型',
        focus: ['真题阅读 2013–2020 精做', '干扰项归因表', '翻译逐句批改', '大作文素材库'],
      },
      {
        goal: '近五年真题限时模考 + 作文成稿背诵',
        focus: ['2021–2025 真题限时', '作文默写', '新题型专项'],
      },
    ),
    textLength: { intensive: 280, extensive: 180 },
  },
];
