/** 卷子的分项：听力 / 词汇 / 语法 / 阅读 / 写作 */
export type SectionKey = 'listening' | 'vocab' | 'grammar' | 'reading' | 'writing';

/** 题目形态：选择题（自动判分）或写作题（自由作答 + 参考范文） */
export type ItemKind = 'choice' | 'writing';

export interface SeedItem {
  /** 分项标识 */
  section: SectionKey;
  /** 界面上显示的分项名（如「漢字読み」「事实信息题」），不填则由分项名兜底 */
  label?: string;
  kind?: ItemKind;
  stem: string;
  /** 阅读材料；听力题不放正文 */
  passage?: string;
  /** 听力朗读稿：作答时只播不显，交卷后在解析里给原文 */
  audioText?: string;
  options?: string[];
  /** 正确选项下标（0 起），写作题为 undefined */
  answer?: number;
  explanation: string;
  /** 写作题参考范文 */
  sampleAnswer?: string;
  /** 写作题最少字数 */
  minWords?: number;
}

/** 阅读材料：一段材料配多道题，展开成多道 SeedItem */
export interface SeedReadingGroup {
  passage: string;
  label?: string;
  items: Array<Omit<SeedItem, 'section' | 'passage'>>;
}

export interface SectionPlan {
  key: SectionKey;
  label: string;
  /** 本卷该分项取几道题（阅读为取几段材料） */
  take: number;
  /** 建议用时（分钟） */
  minutes: number;
}

/** 一个语种的题库池：卷子由池子按年份轮换组合，避免手写 27 年 × 5 分项的重复劳动 */
export interface SeedPool {
  language: 'en' | 'ja' | 'ko';
  examName: string;
  levelLabel: string;
  plan: SectionPlan[];
  listening: SeedItem[];
  vocab: SeedItem[];
  grammar: SeedItem[];
  reading: SeedReadingGroup[];
  writing: SeedItem[];
}

export interface SeedPaper {
  id: string;
  language: 'en' | 'ja' | 'ko';
  year: number;
  examName: string;
  levelLabel: string;
  title: string;
  /** real = 真题原件导入；mock = 按考纲编写的仿真卷 */
  paperType: 'real' | 'mock' | 'ai';
  sourceNote: string;
  durationMin: number;
  /** 分项配置，界面据此排分项导航 */
  sections: Array<{ key: SectionKey; label: string; count: number; minutes: number }>;
  items: SeedItem[];
}
