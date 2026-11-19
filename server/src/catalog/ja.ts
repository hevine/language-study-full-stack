import type { ExamDef, LevelDef, PhaseDef } from './types';

export const JA_LEVELS: LevelDef[] = [
  {
    id: 'n5',
    name: 'JLPT N5（入门）',
    cefr: 'A1',
    vocab: 800,
    hoursFromZero: 460,
    equiv: { jlpt: 5 },
    note: '掌握五十音、基础助词与日常寒暄。',
  },
  {
    id: 'n4',
    name: 'JLPT N4（初级）',
    cefr: 'A2',
    vocab: 1500,
    hoursFromZero: 790,
    equiv: { jlpt: 4 },
    note: '能应对熟悉场景的日常会话，动词变形基本掌握。',
  },
  {
    id: 'n3',
    name: 'JLPT N3（中级）',
    cefr: 'A2–B1',
    vocab: 3700,
    hoursFromZero: 1330,
    equiv: { jlpt: 3 },
    note: '能读懂日常话题文章，但长句与抽象表达仍吃力。',
  },
  {
    id: 'n2',
    name: 'JLPT N2（中高级）',
    cefr: 'B1–B2',
    vocab: 6000,
    hoursFromZero: 2200,
    equiv: { jlpt: 2 },
    note: '日企就业与赴日留学的最低门槛，阅读速度是关键。',
  },
  {
    id: 'n1',
    name: 'JLPT N1（高级）',
    cefr: 'B2–C1',
    vocab: 10000,
    hoursFromZero: 3900,
    equiv: { jlpt: 1 },
    note: '能读社论与抽象评论，合格线 100/180 且单项不得低于 19 分。',
  },
];

const JA_FOUNDATION_MIX = { vocab: 0.3, grammar: 0.16, read: 0.26, listen: 0.18, speak: 0.1 } as const;
const JA_BUILD_MIX = { vocab: 0.22, grammar: 0.15, read: 0.28, listen: 0.22, speak: 0.08, mock: 0.05 } as const;
const JA_SPRINT_MIX = { vocab: 0.15, grammar: 0.1, read: 0.25, listen: 0.25, speak: 0.05, mock: 0.2 } as const;

const phases: PhaseDef[] = [
  {
    key: 'foundation',
    name: '語彙・文法筑基期',
    startRatio: 0,
    goal: '先把词汇与助词/活用体系打通，建立每天朗读的习惯',
    focus: ['核心词汇与汉字音训读', '助词与动词活用', '短文音読 10 分钟/天', '听力适应自然语速'],
    mix: JA_FOUNDATION_MIX,
  },
  {
    key: 'build',
    name: '読解・聴解专项期',
    startRatio: 0.36,
    goal: '阅读长句拆解与听力即时应答专项突破',
    focus: ['长句接续与指代关系', '情報検索题', '听力即时应答', '敬语体系'],
    mix: JA_BUILD_MIX,
  },
  {
    key: 'sprint',
    name: '過去問冲刺期',
    startRatio: 0.74,
    goal: '真题限时 + 错题复盘，把正确率稳在合格线上方 10%',
    focus: ['每周 2 回過去問', '汉字书写纠错', '听力关键词速记', '时间分配演练'],
    mix: JA_SPRINT_MIX,
  },
];

export const JA_EXAMS: ExamDef[] = [
  {
    id: 'jlpt',
    language: 'ja',
    name: 'JLPT 日本语能力测试',
    provider: '日本国际交流基金会 / 教育部教育考试院',
    scaleLabel: '0–180 分（含单项合格线）',
    scaleNote:
      'N1/N2 分「语言知识·阅读」（N1 110 分钟 / N2 105 分钟）与「听力」（N1 约 55 分钟 / N2 约 50 分钟）两科；合格需总分达标且每项不低于 19 分。',
    sections: [
      { id: 'language', name: '语言知识（文字·词汇·语法）', minutes: 60, format: '汉字读音、词汇用法、语法选择、句子重组' },
      { id: 'reading', name: '阅读', minutes: 50, format: '短文 / 中文 / 长文 / 综合理解 / 信息检索' },
      { id: 'listening', name: '听力', minutes: 55, format: '课题理解、要点理解、概要理解、即时应答、综合理解' },
    ],
    targets: [
      {
        score: 5,
        label: 'N5 合格',
        sections: { language: 60, reading: 60, listening: 60 },
        vocabNeed: 800,
        note: '合格线 80/180。',
      },
      {
        score: 4,
        label: 'N4 合格',
        sections: { language: 60, reading: 60, listening: 60 },
        vocabNeed: 1500,
        note: '合格线 90/180。',
      },
      {
        score: 3,
        label: 'N3 合格',
        sections: { language: 60, reading: 60, listening: 60 },
        vocabNeed: 3700,
        note: '合格线 95/180。',
      },
      {
        score: 2,
        label: 'N2 合格',
        sections: { language: 60, reading: 60, listening: 60 },
        vocabNeed: 6000,
        note: '合格线 90/180，日企与专门学校申请常用门槛。',
      },
      {
        score: 1,
        label: 'N1 合格',
        sections: { language: 60, reading: 60, listening: 60 },
        vocabNeed: 10000,
        note: '合格线 100/180，单项需 ≥19 分；阅读时间压力最大。',
      },
    ],
    syllabus: [
      '汉字：音读/训读区分、熟字训、同音异义',
      '词汇：复合动词、拟声拟态词、惯用句、カタカナ外来语',
      '语法：被动·使役·使役被动、敬语三分类、接续助词辨析',
      '阅读：指示代词指代、段落逻辑、意见文与评论的论点定位',
      '听力：即时应答的省略表达、课题理解的要点预判、概要理解的主旨抓取',
      '应试：时间分配（语言知识 20 分钟内完成，留 30 分钟给长文）',
    ],
    topicPool: [
      '日常生活とゴミ問題',
      '睡眠と記憶',
      '働き方とテレワーク',
      '少子高齢化',
      '外来語と日本語',
      '環境とエネルギー',
      '教育と受験',
      'SNSと人間関係',
      '食文化の変化',
      '科学技術と倫理',
    ],
    hoursModel: { mode: 'levelHours', perPoint: 0 },
    phases,
    textLength: { intensive: 450, extensive: 300 },
  },
];
