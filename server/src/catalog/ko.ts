import type { ExamDef, LevelDef, PhaseDef } from './types';

/**
 * TOPIK（한국어능력시험 韩国语能力考试）考纲数据。
 * 级别与词汇量口径参考 TOPIK 官方（国立国际教育院）公布的级别描述与主流韩语词书；
 * 小时数为「从零开始」的保守累计值，供可行性测算使用。
 */
export const KO_LEVELS: LevelDef[] = [
  {
    id: 'ko0',
    name: '零基础（还没考过级）',
    cefr: 'Pre-A1',
    vocab: 0,
    hoursFromZero: 0,
    equiv: { topik: 0 },
    note: '还没系统学过韩语：从 한글（韩文字母）与发音规则开始。',
  },
  {
    id: 'ko1',
    name: 'TOPIK 1 级（初级）',
    cefr: 'A1',
    vocab: 800,
    hoursFromZero: 140,
    equiv: { topik: 1 },
    note: 'TOPIK I 合格线 80/200：能完成自我介绍、购物、点餐等生存表达。',
  },
  {
    id: 'ko2',
    name: 'TOPIK 2 级（初级）',
    cefr: 'A2',
    vocab: 1500,
    hoursFromZero: 280,
    equiv: { topik: 2 },
    note: 'TOPIK I 合格线 140/200：能应对银行、邮局、电话预约等日常事务。',
  },
  {
    id: 'ko3',
    name: 'TOPIK 3 级（中级）',
    cefr: 'B1',
    vocab: 3000,
    hoursFromZero: 520,
    equiv: { topik: 3 },
    note: 'TOPIK II 合格线 120/300：语学院与韩国本科预科最常用的门槛。',
  },
  {
    id: 'ko4',
    name: 'TOPIK 4 级（中高级）',
    cefr: 'B2',
    vocab: 4500,
    hoursFromZero: 780,
    equiv: { topik: 4 },
    note: 'TOPIK II 合格线 150/300：韩国大学本科入学的通用线。',
  },
  {
    id: 'ko5',
    name: 'TOPIK 5 级（高级）',
    cefr: 'C1',
    vocab: 6000,
    hoursFromZero: 1100,
    equiv: { topik: 5 },
    note: 'TOPIK II 合格线 190/300：研究生申请与求职的常用线。',
  },
  {
    id: 'ko6',
    name: 'TOPIK 6 级（高级）',
    cefr: 'C1+',
    vocab: 8000,
    hoursFromZero: 1400,
    equiv: { topik: 6 },
    note: 'TOPIK II 合格线 230/300：能读懂专业论文与公文，写作几乎无障碍。',
  },
];

const KO_FOUNDATION_MIX = { vocab: 0.3, grammar: 0.17, read: 0.25, listen: 0.18, speak: 0.1 } as const;
const KO_BUILD_MIX = { vocab: 0.22, grammar: 0.15, read: 0.27, listen: 0.21, speak: 0.07, mock: 0.08 } as const;
const KO_SPRINT_MIX = { vocab: 0.14, grammar: 0.1, read: 0.26, listen: 0.25, speak: 0.05, mock: 0.2 } as const;

const phases: PhaseDef[] = [
  {
    key: 'foundation',
    name: '발음·어휘 다지기（发音·词汇筑基期）',
    startRatio: 0,
    goal: '先把字母、收尾音（받침）与助词体系打牢，养成每天出声朗读的习惯',
    focus: ['한글 字母与发音规则（连音、紧音化）', '助词 은/는/이/가/을/를 的分工', '动词·形容词基本语尾', '短文朗读 10 分钟/天'],
    mix: KO_FOUNDATION_MIX,
  },
  {
    key: 'build',
    name: '읽기·듣기·쓰기 专项期',
    startRatio: 0.36,
    goal: '长句拆解、连接语尾与写作 51–54 题专项突破',
    focus: ['连接语尾（-지만 / -아서 / -(으)면）辨析', '阅读长句主干提取', '写作 51–54 题模板化训练', '听力判断与内容理解'],
    mix: KO_BUILD_MIX,
  },
  {
    key: 'sprint',
    name: '기출문제 冲刺期',
    startRatio: 0.74,
    goal: '真题限时训练 + 错题归类，把正确率稳在合格线上方',
    focus: ['每周 2 套 기출문제（真题）', '写作 54 题大作文限时 50 分钟', '听力关键词速记', '时间分配演练'],
    mix: KO_SPRINT_MIX,
  },
];

export const KO_EXAMS: ExamDef[] = [
  {
    id: 'topik',
    language: 'ko',
    name: 'TOPIK 韩国语能力考试',
    provider: '韩国国立国际教育院 / 教育部教育考试院',
    scaleLabel: '1–6 级（TOPIK I / TOPIK II）',
    scaleNote:
      'TOPIK I（1–2 级）只考听力 + 阅读各 100 分，满分 200；TOPIK II（3–6 级）考听力 + 写作 + 阅读各 100 分，满分 300。等级按总分划定，无单项合格线。',
    sections: [
      { id: 'listening', name: '听力（듣기）', minutes: 60, format: 'TOPIK I 30 分钟 30 题 / TOPIK II 60 分钟 50 题' },
      { id: 'writing', name: '写作（쓰기）', minutes: 50, format: '仅 TOPIK II：补完句子 2 题 + 短文 54 题 200–300 字' },
      { id: 'reading', name: '阅读（읽기）', minutes: 70, format: 'TOPIK I 40 分钟 40 题 / TOPIK II 70 分钟 50 题' },
    ],
    targets: [
      {
        score: 1,
        label: 'TOPIK 1 级',
        sections: { listening: 40, reading: 40 },
        vocabNeed: 800,
        note: '合格线 80/200（TOPIK I）。',
      },
      {
        score: 2,
        label: 'TOPIK 2 级',
        sections: { listening: 70, reading: 70 },
        vocabNeed: 1500,
        note: '合格线 140/200（TOPIK I）。',
      },
      {
        score: 3,
        label: 'TOPIK 3 级',
        sections: { listening: 40, writing: 40, reading: 40 },
        vocabNeed: 3000,
        note: '合格线 120/300（TOPIK II）；语学院结业与本科预科常用门槛。',
      },
      {
        score: 4,
        label: 'TOPIK 4 级',
        sections: { listening: 50, writing: 50, reading: 50 },
        vocabNeed: 4500,
        note: '合格线 150/300；韩国大学本科入学通用线。',
      },
      {
        score: 5,
        label: 'TOPIK 5 级',
        sections: { listening: 63, writing: 63, reading: 64 },
        vocabNeed: 6000,
        note: '合格线 190/300；研究生与求职常用线。',
      },
      {
        score: 6,
        label: 'TOPIK 6 级',
        sections: { listening: 77, writing: 76, reading: 77 },
        vocabNeed: 8000,
        note: '合格线 230/300；专业文章与公文阅读写作无障碍。',
      },
    ],
    syllabus: [
      '发音：收尾音（받침）、连音、紧音化与鼻音化等音变规则',
      '词汇：汉字词占比约六成，按主题分类记忆；副词与拟声拟态词是高级拉分点',
      '语法：助词体系 + 连接语尾（-아서/-니까/-느라고/-는 바람에）辨析',
      '阅读：长句主干提取、新闻标题的缩略表达、图表与广告的信息检索',
      '写作：51–53 题按给定信息补写；54 题议论文按「主张—理由—结论」三段成文',
      '应试：TOPIK II 三科连考 3 小时，阅读 50 题要留足 70 分钟',
    ],
    topicPool: [
      '일상과 환경（日常生活与环境）',
      '학교 생활과 진로（校园与出路）',
      '직장과 업무 방식（职场与工作方式）',
      '한국 문화와 예절（韩国文化与礼仪）',
      '과학 기술과 사회（科技与社会）',
      '소비와 경제（消费与经济）',
      '미디어와 소통（媒体与沟通）',
      '건강과 생활 습관（健康与生活习惯）',
      '여행과 지역 문화（旅行与地方文化）',
      '환경 문제와 에너지（环境问题与能源）',
    ],
    hoursModel: { mode: 'perPoint', perPoint: 220 },
    phases,
    textLength: { intensive: 420, extensive: 280 },
  },
];
