import type { Language } from '../../domain/language';

/**
 * 知识图谱 · 内容层声明
 *
 * 这里只描述「有哪些知识点、它们之间是什么关系、题目怎么对上知识点」，
 * 不含任何数据库操作；落库由 repositories/knowledge.ts 负责。
 *
 * 分层：
 *   exam          考试（toefl / ielts / cet6 / kaoyan …）        根
 *   skill         技能（listening / vocab / grammar / reading / writing） 根
 *   question_type 题型（事实信息题 / 推理题 …）                    挂在 skill 下
 *   topic         主题（校园生活 / 生命科学 …）                    挂在 skill 下
 *   vocab         词汇（词元级节点，后续词库扩充时使用）
 *   grammar       语法点（来自内置语法库 content/grammar，挂在 skill 语法节点下）
 *   error_rule    错因规则：独立的诊断单元，描述一种典型错误的触发 / 表现 / 判定，
 *                 可被多个语法点共用；语法点用 explains 边指向它
 *
 * 技能挂在语种下而不是考试下：「阅读推理」对托福、雅思、六级是同一件事；
 * 它与某场考试的关系用 tested_in 边表达，权重放在边上。
 */

export type KpKind = 'exam' | 'skill' | 'question_type' | 'topic' | 'vocab' | 'grammar' | 'error_rule';

/**
 * prereq    from 是 to 的前置 —— 学 to 之前应先会 from
 * similar   类义 / 易混点，需要对比着学（无向，声明时写单向，落库时成对展开）
 * tested_in from 这个知识点被 to 这场考试考查，weight 是考查权重
 * explains  from（语言知识）能解释 to 的典型错误
 * related   其它关联（同一主题、常搭配出现等）
 */
export type KpEdgeType = 'prereq' | 'similar' | 'tested_in' | 'explains' | 'related';

export interface KnowledgeNodeDef {
  /** 稳定编码：语种.类别.名称，小写字母数字与连字符。一经发布不复用、不改义 */
  code: string;
  kind: KpKind;
  /** 界面显示名（中文） */
  name: string;
  /** 语种内的写法，可为空 */
  nameLocal?: string;
  /** 父节点编码；不填即根 */
  parent?: string;
  /** 归属考试；不填为 '*'（该语种所有考试通用） */
  examId?: string;
  /** 对齐 exam_items.section_key；通用节点不填 */
  sectionKey?: string;
  /** 级别档位（英语用 CEFR）；通用节点不填 */
  levelBand?: string;
  /** 考试权重 0~1，默认 0.5 */
  examWeight?: number;
  sort?: number;
  meta?: Record<string, unknown>;
}

export interface KnowledgeEdgeDef {
  from: string;
  to: string;
  type: KpEdgeType;
  weight?: number;
  /** 1 = 人工审定。模型推断的关系边应低于 1，留给人工复核 */
  confidence?: number;
}

/**
 * 题目 → 知识点的匹配规则：分项 + 卷面大题名命中即归到该节点；
 * stemAny 给出时，题干还必须包含其中任一片段（写作题的大题名都叫 Writing，靠题干区分）。
 * 同一分项内按声明顺序取第一个命中的规则。
 */
export interface QuestionMatcher {
  code: string;
  sectionKey: string;
  labels: string[];
  stemAny?: string[];
}

export interface KnowledgeTree {
  language: Language;
  nodes: KnowledgeNodeDef[];
  edges: KnowledgeEdgeDef[];
  matchers: QuestionMatcher[];
}
