import type { Language } from '../catalog/types';

export type PracticeKind = 'write' | 'speak';

export type DimensionId =
  | 'content'
  | 'organization'
  | 'language'
  | 'lexical'
  | 'fluency'
  | 'pronunciation';

export interface RubricDimension {
  id: DimensionId;
  name: string;
  /** 权重，同一题型内合计为 1 */
  weight: number;
  /** 给评分模型的判定标准 */
  criteria: string;
}

export interface PracticeScale {
  max: number;
  /** 分数最小刻度（托福 0.5、雅思 0.5、六级 1） */
  step: number;
  label: string;
  note: string;
}

export interface PracticeFormat {
  kind: PracticeKind;
  /** 展示用题型名，如「学术讨论写作」 */
  label: string;
  /** 一句话说明考试里的真实形态 */
  taskType: string;
  minutes: number;
  /** 写作：目标字数区间 */
  wordRange?: [number, number];
  /** 口语：准备秒数 / 作答秒数 */
  prepSeconds?: number;
  responseSeconds?: number;
  dimensions: RubricDimension[];
  scale: PracticeScale;
  /** 考场提醒 */
  remarks: string[];
}

export interface ExamRubric {
  writing: PracticeFormat;
  speaking: PracticeFormat;
}

const TOEFL_WRITING: PracticeFormat = {
  kind: 'write',
  label: '学术讨论写作',
  taskType: '10 分钟，读教授提问与两位同学观点后写一段回复（≥100 词）',
  minutes: 10,
  wordRange: [100, 180],
  dimensions: [
    {
      id: 'content',
      name: '内容与论证',
      weight: 0.35,
      criteria: '是否明确表态、给出至少两个具体理由或例证，并回应题目中其他同学的观点；不得空泛复述题干。',
    },
    {
      id: 'organization',
      name: '组织与连贯',
      weight: 0.2,
      criteria: '是否有一段完整的论证结构（立场—理由—例证—收束），衔接自然，指代清晰。',
    },
    {
      id: 'language',
      name: '语言准确性',
      weight: 0.25,
      criteria: '语法、时态、主谓一致、冠词、介词是否正确；句子是否完整、无残句与逗号粘连。',
    },
    {
      id: 'lexical',
      name: '词汇与句式',
      weight: 0.2,
      criteria: '词汇是否准确、多样、搭配地道；句式是否有变化而非全篇简单句堆叠。',
    },
  ],
  scale: { max: 5, step: 0.5, label: '0–5 分制', note: '换算参考：5.0 ≈ 写作 30 分，4.0 ≈ 24–26 分，3.0 ≈ 17–20 分' },
  remarks: ['不要求开头段铺垫，直接表态更省时间。', '例子要具体到人名、数据或经历，不要写 "for example, many people"。'],
};

const TOEFL_SPEAKING: PracticeFormat = {
  kind: 'speak',
  label: '独立口语',
  taskType: '15 秒准备 + 45 秒作答，说明立场并用一个具体例子支撑',
  minutes: 3,
  prepSeconds: 15,
  responseSeconds: 45,
  dimensions: [
    {
      id: 'content',
      name: '内容完整与切题',
      weight: 0.3,
      criteria: '是否直接回答问题、给出明确立场，并用一个具体例子或细节支撑（时间/地点/结果）。',
    },
    {
      id: 'fluency',
      name: '流利与连贯',
      weight: 0.25,
      criteria: '语速是否自然、停顿是否在语义边界、是否避免大量 um/uh/like 填充词与自我重复。',
    },
    {
      id: 'language',
      name: '语法与词汇',
      weight: 0.25,
      criteria: '句型是否完整，时态是否一致，是否有可理解的连接手段；词汇是否准确而非生硬直译。',
    },
    {
      id: 'pronunciation',
      name: '语音与语调',
      weight: 0.2,
      criteria: '发音是否清晰可懂、重音是否正确、语调是否有起伏（本项由转写文本与录音回听共同判断）。',
    },
  ],
  scale: { max: 4, step: 0.5, label: '0–4 分制', note: '换算参考：4.0 = 口语 30 分，3.0 ≈ 23 分，2.5 ≈ 19 分' },
  remarks: ['45 秒大约 100–130 词，练到不用看表也能收在 40–45 秒。', '开口第一句就给答案，不要复述题干。'],
};

const IELTS_WRITING: PracticeFormat = {
  kind: 'write',
  label: 'Task 2 议论文',
  taskType: '40 分钟，就一个社会议题写 250 词以上的论证文',
  minutes: 40,
  wordRange: [250, 330],
  dimensions: [
    {
      id: 'content',
      name: '任务回应',
      weight: 0.25,
      criteria: '是否完整回应题目所有问句，立场一贯，观点有展开而非罗列，例证相关且具体。',
    },
    {
      id: 'organization',
      name: '连贯与衔接',
      weight: 0.25,
      criteria: '分段是否合理（引言—两个主体段—结论），每段一个中心，衔接手段自然不堆砌。',
    },
    {
      id: 'lexical',
      name: '词汇资源',
      weight: 0.25,
      criteria: '是否有足够词汇量支撑观点，搭配地道、用词精准，允许少量不影响理解的错误。',
    },
    {
      id: 'language',
      name: '语法多样性与准确性',
      weight: 0.25,
      criteria: '是否使用多种复杂结构（定语从句、状语从句、非谓语），且多数句子无错误。',
    },
  ],
  scale: { max: 9, step: 0.5, label: 'Band 0–9', note: '换算参考：Band 7 ≈ 写作 6.5–7.0；多数院校要求 6.5 起' },
  remarks: ['先花 3 分钟列提纲：立场 + 两个理由 + 各自例证。', '结论段不要引入新观点。'],
};

const IELTS_SPEAKING: PracticeFormat = {
  kind: 'speak',
  label: 'Part 2 个人陈述',
  taskType: '1 分钟准备 + 2 分钟独白，按题卡要点展开',
  minutes: 4,
  prepSeconds: 60,
  responseSeconds: 120,
  dimensions: [
    {
      id: 'fluency',
      name: '流利与连贯',
      weight: 0.25,
      criteria: '能否持续输出、少自我纠正，用连接词推进叙述而不是靠填充词拖延。',
    },
    {
      id: 'lexical',
      name: '词汇资源',
      weight: 0.25,
      criteria: '是否使用话题相关词汇与地道搭配，能否用同义替换避免重复。',
    },
    {
      id: 'language',
      name: '语法多样性与准确性',
      weight: 0.25,
      criteria: '是否灵活使用多种时态与复杂句，错误是否影响理解。',
    },
    {
      id: 'pronunciation',
      name: '发音',
      weight: 0.25,
      criteria: '单词重音、句子重音、语调与连读是否自然，听者是否需要费力理解（结合录音回听判断）。',
    },
  ],
  scale: { max: 9, step: 0.5, label: 'Band 0–9', note: '换算参考：Band 7 = 能流利展开、偶有错误但不影响理解' },
  remarks: ['题卡四个要点都要覆盖，最后补一句感受或影响。', '2 分钟约 250–300 词，宁可用例子展开也不要空转。'],
};

const CET6_WRITING: PracticeFormat = {
  kind: 'write',
  label: '六级议论文',
  taskType: '30 分钟，150–200 词短文（占 15%）',
  minutes: 30,
  wordRange: [150, 220],
  dimensions: [
    {
      id: 'content',
      name: '内容切题',
      weight: 0.3,
      criteria: '是否紧扣题目、中心明确，有具体支撑而非空喊口号。',
    },
    {
      id: 'organization',
      name: '结构条理',
      weight: 0.25,
      criteria: '三段式是否清晰（现象/观点—论证—结论），段落之间有过渡。',
    },
    {
      id: 'language',
      name: '语言表达',
      weight: 0.3,
      criteria: '语法是否正确，是否避免中式英语，句子是否完整。',
    },
    {
      id: 'lexical',
      name: '词汇与拼写',
      weight: 0.15,
      criteria: '用词是否准确得体，拼写与标点是否规范，是否有亮点表达。',
    },
  ],
  scale: { max: 15, step: 1, label: '15 分制', note: '写作占 15%，折合 106.5 分；11 分以上为较稳的及格线' },
  remarks: ['开头两句内必须出现观点句，阅卷时间很短。', '留 3 分钟通读，重点改主谓一致与拼写。'],
};

const KAOYAN_WRITING: PracticeFormat = {
  kind: 'write',
  label: '考研大作文（图画/图表）',
  taskType: '30 分钟，160–200 词，描述图画 + 解释寓意 + 给出评论',
  minutes: 30,
  wordRange: [160, 220],
  dimensions: [
    {
      id: 'content',
      name: '内容要点',
      weight: 0.3,
      criteria: '是否完整覆盖「描述图画—解释寓意—个人评论」三个要点，寓意解读合理。',
    },
    {
      id: 'organization',
      name: '结构与衔接',
      weight: 0.25,
      criteria: '三段是否各司其职，段内是否有主题句，衔接是否自然。',
    },
    {
      id: 'language',
      name: '语言准确性',
      weight: 0.3,
      criteria: '语法、时态、搭配是否正确，是否出现影响理解的错误。',
    },
    {
      id: 'lexical',
      name: '语言丰富度',
      weight: 0.15,
      criteria: '是否有句式变化与恰当的高级表达，避免全篇简单句。',
    },
  ],
  scale: { max: 20, step: 1, label: '20 分制', note: '英语一 大作文 20 分；14 分以上属于较好水平' },
  remarks: ['第一段只描述、不评价；寓意放到第二段。', '不要背模板套话，阅卷老师对 "with the development of society" 极度敏感。'],
};

const JLPT_WRITING: PracticeFormat = {
  kind: 'write',
  label: '記述（意見文）',
  taskType: '30 分钟，200–250 字，就一个议题表明立场并说明理由',
  minutes: 30,
  wordRange: [200, 260],
  dimensions: [
    {
      id: 'content',
      name: '内容与任务达成',
      weight: 0.3,
      criteria: '是否明确回答问题、立场清楚，理由具体且与题目直接相关。',
    },
    {
      id: 'organization',
      name: '结构与连贯',
      weight: 0.2,
      criteria: '是否有「主张—理由—例示—总结」结构，段落与接续词使用是否得当。',
    },
    {
      id: 'language',
      name: '语法准确性',
      weight: 0.25,
      criteria: '助词、活用、时态、敬语层级是否正确，句子是否完整。',
    },
    {
      id: 'lexical',
      name: '词汇与表达',
      weight: 0.25,
      criteria: '是否使用与话题匹配的词汇与惯用表达，是否避免重复同一句式。',
    },
  ],
  scale: { max: 50, step: 5, label: '50 点制', note: 'JLPT 本身不设写作题型；此处按 EJU 記述 50 点制训练输出能力' },
  remarks: ['避免口语体（「〜だと思う」连用），书面语用「〜と考えられる」。', '字数不足会直接扣分，写满 200 字以上。'],
};

const JLPT_SPEAKING: PracticeFormat = {
  kind: 'speak',
  label: '音読＋スピーチ',
  taskType: '30 秒准备 + 60 秒，就一个话题陈述观点',
  minutes: 3,
  prepSeconds: 30,
  responseSeconds: 60,
  dimensions: [
    {
      id: 'content',
      name: '内容与切题',
      weight: 0.3,
      criteria: '是否直接回答、给出理由与具体例子，内容与题目相关。',
    },
    {
      id: 'fluency',
      name: '流利与连贯',
      weight: 0.25,
      criteria: '是否停顿自然、少「えーと」「あのー」，句子之间是否用接续词衔接。',
    },
    {
      id: 'language',
      name: '语法与词汇',
      weight: 0.25,
      criteria: '助词与活用是否正确，是否使用符合场景的敬语/普通体，词汇是否准确。',
    },
    {
      id: 'pronunciation',
      name: '发音与语调',
      weight: 0.2,
      criteria: '长音、促音、拨音是否清晰，高低音调是否自然（结合录音回听判断）。',
    },
  ],
  scale: { max: 50, step: 5, label: '50 点制', note: 'JLPT 不设口语题型；此处按 JF 口语评价标准训练，重点在「伝わる日本語」' },
  remarks: ['60 秒约 180–240 字，先给结论再补理由。', '录音回听时重点听助词是否吞音。'],
};

const DEFAULT_EN: ExamRubric = { writing: IELTS_WRITING, speaking: IELTS_SPEAKING };

const RUBRICS: Record<string, ExamRubric> = {
  toefl: { writing: TOEFL_WRITING, speaking: TOEFL_SPEAKING },
  ielts: { writing: IELTS_WRITING, speaking: IELTS_SPEAKING },
  cet6: { writing: CET6_WRITING, speaking: TOEFL_SPEAKING },
  kaoyan: { writing: KAOYAN_WRITING, speaking: TOEFL_SPEAKING },
  jlpt: { writing: JLPT_WRITING, speaking: JLPT_SPEAKING },
};

export function rubricFor(examId: string, language: Language, kind: PracticeKind): PracticeFormat {
  const key = kind === 'write' ? 'writing' : 'speaking';
  const entry = RUBRICS[examId];
  if (entry) return entry[key];
  const fallback = language === 'ja' ? { writing: JLPT_WRITING, speaking: JLPT_SPEAKING } : DEFAULT_EN;
  return fallback[key];
}

/** 0–100 综合分换算成考试分制 */
export function toBand(overall: number, scale: PracticeScale): { value: number; max: number; label: string; note: string } {
  const raw = (Math.max(0, Math.min(100, overall)) / 100) * scale.max;
  const value = Math.round(raw / scale.step) * scale.step;
  return {
    value: Number(value.toFixed(2)),
    max: scale.max,
    label: `${Number(value.toFixed(2))} / ${scale.max}`,
    note: scale.note,
  };
}

export function dimensionWeight(format: PracticeFormat, id: DimensionId): number {
  return format.dimensions.find((item) => item.id === id)?.weight ?? 0;
}
