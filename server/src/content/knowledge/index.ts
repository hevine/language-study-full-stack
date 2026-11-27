import type { Language } from '../../domain/language';
import { grammarKnowledge, grammarLibrary, GRAMMAR_LANGUAGES } from '../grammar';
import { EN_TREE } from './en';
import type { KnowledgeTree } from './types';

/**
 * 内置知识树登记处。
 *
 * 一棵语种知识树 = 手写的骨架（考试 / 技能 / 题型 / 匹配规则，content/knowledge/<code>.ts）
 *                + 内置语法库派生的节点与边（语法点、错因规则，content/grammar/<code>.json）。
 * 两部分在启动期合成一次再落库；节点编码重复时以手写骨架为准。
 *
 * 加一个语种的骨架 = 加一个 content/knowledge/<code>.ts + 在下面登记一行。
 * 只有语法库、没有骨架的语种（如现在的日语 / 韩语）也有一棵树：只有语法相关的节点，
 * 题目照常进题池，但对不上任何知识点（计入 untagged），不报错。
 * 这是刻意的 —— 「有题没知识点」比「启动失败」好，缺口能从统计里看到。
 */
const BASE_TREES: Partial<Record<Language, KnowledgeTree>> = {
  en: EN_TREE,
};

function compose(language: Language): KnowledgeTree | null {
  const base = BASE_TREES[language] ?? null;
  const grammar = grammarKnowledge(language);
  if (!base) {
    return grammar ? { language, nodes: grammar.nodes, edges: grammar.edges, matchers: [] } : null;
  }
  if (!grammar) return base;
  const declared = new Set(base.nodes.map((node) => node.code));
  return {
    ...base,
    nodes: [...base.nodes, ...grammar.nodes.filter((node) => !declared.has(node.code))],
    edges: [...base.edges, ...grammar.edges],
  };
}

const TREES = new Map<Language, KnowledgeTree>();
for (const language of GRAMMAR_LANGUAGES) {
  const tree = compose(language);
  if (tree) TREES.set(language, tree);
}

export const KNOWLEDGE_TREES: KnowledgeTree[] = [...TREES.values()];

export function treeFor(language: string): KnowledgeTree | null {
  return TREES.get(language as Language) ?? null;
}

/** 该语种是否有手写的骨架树（题型与匹配规则）。没有骨架的语种题目对不上知识点 */
export function hasBaseTree(language: string): boolean {
  return Boolean(BASE_TREES[language as Language]);
}

export * from './types';
