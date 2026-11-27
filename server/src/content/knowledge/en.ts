import type { KnowledgeTree } from './types';

/**
 * 英语知识树（以托福 iBT 为打样考试）。
 *
 * 为什么只有三层（技能 → 题型）：现在的英语题池是按托福题型编写的，
 * 题型是唯一能从卷面确定匹配到知识点的信息。词汇节点、语法点节点
 * 要等词库与语法库扩充后才能挂上来 —— 在那之前不预建空壳，
 * 否则诊断报告会出现「永远没有作答证据」的节点。
 *
 * 边上的权重与级别是教研估值（seed），不是统计结果；
 * 等作答数据积累起来再校准。
 */
export const EN_TREE: KnowledgeTree = {
  language: 'en',
  nodes: [
    // ---- 考试 ----
    { code: 'en.exam.toefl', kind: 'exam', name: '托福 iBT', sort: 1 },
    { code: 'en.exam.ielts', kind: 'exam', name: '雅思 Academic', sort: 2 },
    { code: 'en.exam.cet6', kind: 'exam', name: '大学英语六级', sort: 3 },
    { code: 'en.exam.kaoyan', kind: 'exam', name: '考研英语一', sort: 4 },

    // ---- 技能 ----
    { code: 'en.listening', kind: 'skill', name: '听力', sectionKey: 'listening', sort: 1 },
    { code: 'en.vocab', kind: 'skill', name: '词汇', sectionKey: 'vocab', sort: 2 },
    { code: 'en.grammar', kind: 'skill', name: '语法', sectionKey: 'grammar', sort: 3 },
    { code: 'en.reading', kind: 'skill', name: '阅读', sectionKey: 'reading', sort: 4 },
    { code: 'en.writing', kind: 'skill', name: '写作', sectionKey: 'writing', sort: 5 },

    // ---- 听力题型 ----
    {
      code: 'en.listening.conversation',
      kind: 'question_type',
      name: '对话理解（校园场景）',
      parent: 'en.listening',
      sectionKey: 'listening',
      levelBand: 'B2',
      examWeight: 0.6,
      sort: 1,
      meta: { note: '学生与教授 / 图书管理员 / 顾问之间的对话，抓问题和解决办法' },
    },
    {
      code: 'en.listening.lecture',
      kind: 'question_type',
      name: '讲座理解（学术篇章）',
      parent: 'en.listening',
      sectionKey: 'listening',
      levelBand: 'C1',
      examWeight: 0.9,
      sort: 2,
      meta: { note: '学术讲座，抓主旨、举例作用与信号词' },
    },

    // ---- 词汇题型 ----
    {
      code: 'en.vocab.in-context',
      kind: 'question_type',
      name: '语境词义辨析',
      parent: 'en.vocab',
      sectionKey: 'vocab',
      levelBand: 'B2',
      examWeight: 0.7,
      sort: 1,
      meta: { note: '根据上下文推断词义，而不是背中文对应词' },
    },

    // ---- 阅读题型 ----
    {
      code: 'en.reading.factual-information',
      kind: 'question_type',
      name: '事实信息题',
      parent: 'en.reading',
      sectionKey: 'reading',
      levelBand: 'B2',
      examWeight: 0.9,
      sort: 1,
    },
    {
      code: 'en.reading.negative-fact',
      kind: 'question_type',
      name: '否定事实题（EXCEPT）',
      parent: 'en.reading',
      sectionKey: 'reading',
      levelBand: 'B2',
      examWeight: 0.6,
      sort: 2,
    },
    {
      code: 'en.reading.inference',
      kind: 'question_type',
      name: '推理题',
      parent: 'en.reading',
      sectionKey: 'reading',
      levelBand: 'C1',
      examWeight: 0.8,
      sort: 3,
    },
    {
      code: 'en.reading.rhetorical-purpose',
      kind: 'question_type',
      name: '修辞目的题',
      parent: 'en.reading',
      sectionKey: 'reading',
      levelBand: 'C1',
      examWeight: 0.8,
      sort: 4,
    },
    {
      code: 'en.reading.sentence-simplification',
      kind: 'question_type',
      name: '句子简化题',
      parent: 'en.reading',
      sectionKey: 'reading',
      levelBand: 'C1',
      examWeight: 0.6,
      sort: 5,
    },
    {
      code: 'en.reading.authors-attitude',
      kind: 'question_type',
      name: '作者态度题',
      parent: 'en.reading',
      sectionKey: 'reading',
      levelBand: 'C1',
      examWeight: 0.5,
      sort: 6,
    },

    // ---- 写作题型 ----
    {
      code: 'en.writing.independent-opinion',
      kind: 'question_type',
      name: '独立写作 · 同意或反对',
      parent: 'en.writing',
      sectionKey: 'writing',
      levelBand: 'C1',
      examWeight: 0.8,
      sort: 1,
    },
    {
      code: 'en.writing.independent-preference',
      kind: 'question_type',
      name: '独立写作 · 二选一',
      parent: 'en.writing',
      sectionKey: 'writing',
      levelBand: 'C1',
      examWeight: 0.8,
      sort: 2,
    },
    {
      code: 'en.writing.integrated',
      kind: 'question_type',
      name: '综合写作（读听结合）',
      parent: 'en.writing',
      sectionKey: 'writing',
      levelBand: 'C1',
      examWeight: 0.7,
      sort: 3,
    },
  ],
  edges: [
    // ---- 前置：先会 from，再学 to ----
    { from: 'en.listening.conversation', to: 'en.listening.lecture', type: 'prereq' },
    { from: 'en.vocab.in-context', to: 'en.reading.factual-information', type: 'prereq' },
    { from: 'en.vocab.in-context', to: 'en.reading.negative-fact', type: 'prereq' },
    { from: 'en.vocab.in-context', to: 'en.reading.inference', type: 'prereq' },
    { from: 'en.vocab.in-context', to: 'en.reading.rhetorical-purpose', type: 'prereq' },
    { from: 'en.vocab.in-context', to: 'en.reading.sentence-simplification', type: 'prereq' },
    { from: 'en.vocab.in-context', to: 'en.reading.authors-attitude', type: 'prereq' },
    { from: 'en.vocab.in-context', to: 'en.writing.independent-opinion', type: 'prereq' },
    { from: 'en.reading.factual-information', to: 'en.reading.negative-fact', type: 'prereq' },
    { from: 'en.reading.factual-information', to: 'en.reading.inference', type: 'prereq' },
    { from: 'en.reading.factual-information', to: 'en.reading.rhetorical-purpose', type: 'prereq' },
    { from: 'en.reading.factual-information', to: 'en.reading.sentence-simplification', type: 'prereq' },
    { from: 'en.reading.factual-information', to: 'en.reading.authors-attitude', type: 'prereq' },
    { from: 'en.reading.inference', to: 'en.reading.authors-attitude', type: 'prereq' },
    { from: 'en.reading.inference', to: 'en.reading.rhetorical-purpose', type: 'prereq' },
    { from: 'en.writing.independent-opinion', to: 'en.writing.independent-preference', type: 'prereq' },
    { from: 'en.writing.independent-opinion', to: 'en.writing.integrated', type: 'prereq' },
    { from: 'en.listening.lecture', to: 'en.writing.integrated', type: 'prereq' },
    { from: 'en.reading.factual-information', to: 'en.writing.integrated', type: 'prereq' },

    // ---- 类义：对比着学 ----
    { from: 'en.reading.inference', to: 'en.reading.authors-attitude', type: 'similar' },
    { from: 'en.reading.factual-information', to: 'en.reading.negative-fact', type: 'similar' },
    { from: 'en.writing.independent-opinion', to: 'en.writing.independent-preference', type: 'similar' },

    // ---- 考查于：权重是教研估值，待作答数据校准 ----
    { from: 'en.listening.conversation', to: 'en.exam.toefl', type: 'tested_in', weight: 0.6 },
    { from: 'en.listening.lecture', to: 'en.exam.toefl', type: 'tested_in', weight: 0.9 },
    { from: 'en.vocab.in-context', to: 'en.exam.toefl', type: 'tested_in', weight: 0.7 },
    { from: 'en.reading.factual-information', to: 'en.exam.toefl', type: 'tested_in', weight: 0.9 },
    { from: 'en.reading.negative-fact', to: 'en.exam.toefl', type: 'tested_in', weight: 0.6 },
    { from: 'en.reading.inference', to: 'en.exam.toefl', type: 'tested_in', weight: 0.8 },
    { from: 'en.reading.rhetorical-purpose', to: 'en.exam.toefl', type: 'tested_in', weight: 0.8 },
    { from: 'en.reading.sentence-simplification', to: 'en.exam.toefl', type: 'tested_in', weight: 0.6 },
    { from: 'en.reading.authors-attitude', to: 'en.exam.toefl', type: 'tested_in', weight: 0.5 },
    { from: 'en.writing.independent-opinion', to: 'en.exam.toefl', type: 'tested_in', weight: 0.8 },
    { from: 'en.writing.independent-preference', to: 'en.exam.toefl', type: 'tested_in', weight: 0.8 },
    { from: 'en.writing.integrated', to: 'en.exam.toefl', type: 'tested_in', weight: 0.7 },
  ],
  matchers: [
    { code: 'en.listening.conversation', sectionKey: 'listening', labels: ['Conversation'] },
    { code: 'en.listening.lecture', sectionKey: 'listening', labels: ['Lecture'] },
    { code: 'en.vocab.in-context', sectionKey: 'vocab', labels: ['Vocabulary'] },
    { code: 'en.reading.factual-information', sectionKey: 'reading', labels: ['Factual information'] },
    { code: 'en.reading.negative-fact', sectionKey: 'reading', labels: ['Negative fact'] },
    { code: 'en.reading.inference', sectionKey: 'reading', labels: ['Inference'] },
    {
      code: 'en.reading.rhetorical-purpose',
      sectionKey: 'reading',
      labels: ['Rhetorical purpose'],
    },
    {
      code: 'en.reading.sentence-simplification',
      sectionKey: 'reading',
      labels: ['Sentence simplification'],
    },
    {
      code: 'en.reading.authors-attitude',
      sectionKey: 'reading',
      labels: ['Author’s attitude', "Author's attitude"],
    },
    {
      // 写作题的大题名都叫 Writing，按题干区分三种题型
      code: 'en.writing.independent-opinion',
      sectionKey: 'writing',
      labels: ['Writing'],
      stemAny: ['agree or disagree'],
    },
    {
      code: 'en.writing.independent-preference',
      sectionKey: 'writing',
      labels: ['Writing'],
      stemAny: ['Which view do you find more convincing'],
    },
    {
      code: 'en.writing.integrated',
      sectionKey: 'writing',
      labels: ['Writing'],
      stemAny: ['Summarise the lecture'],
    },
  ],
};
