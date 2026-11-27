/**
 * 词汇知识图谱 · 从 JLPT 分级词库派生
 *
 * 一棵语种知识树 = 手写骨架 + 语法库派生 + 词汇库派生（本文件），启动期合成一次落库。
 *
 * 节点设计：
 *   <lang>.vocab                 词汇技能（根）
 *   <lang>.vocab.topic-NN        主题中枢（13 个），kind=topic
 *   <lang>.vocab.jp-v-n5-0001    词条节点（10000 个），kind=vocab，挂在词汇技能下
 *     · name = 词形，nameLocal = 假名
 *     · levelBand = N5..N1，sectionKey = vocab，examId = jlpt
 *     · meta 存词性/释义/主题/频段/例句/词形变化/近义反义派生原文
 *
 * 关系设计（边类型沿用 019 迁移）：
 *   related  词条 → 主题中枢（词属于某主题）；similar 边由仓储自动成对展开
 *   similar  词条 ↔ 词条：由 syn / ant 字段的词形映射而来。
 *            syn/ant 存的是词形文本（如「逢う」），按词形索引映射到节点编码；
 *            一词多形（同名异读）只取词库里第一个匹配，避免误连。
 *   derivation 字段形如「会い（名）」，带词性标注，映射率低，只放 meta 不建边。
 *
 * 规模：10000 节点 + 13 主题节点 + 10000 主题边 + 约 2 万 similar 边（成对后）。
 * 种子边幂等重写，节点只增不删（见 repositories/knowledge.ts）。
 */
import type { Language } from '../../domain/language';
import { JLPT_WORDS } from '../jlptGraded';
import type { KnowledgeEdgeDef, KnowledgeNodeDef } from './types';

export interface VocabKnowledge {
  nodes: KnowledgeNodeDef[];
  edges: KnowledgeEdgeDef[];
}

/** 词汇技能节点编码：与语法技能 ja.grammar 平行 */
export function vocabSkillCode(language: Language): string {
  return `${language}.vocab`;
}

const THEME_CODES: Record<string, string> = {};

function themeCode(theme: string, index: number): string {
  const key = `topic-${String(index + 1).padStart(2, '0')}`;
  THEME_CODES[theme] = key;
  return key;
}

function nodeCode(wordCode: string): string {
  return `ja.vocab.${wordCode.toLowerCase()}`;
}

/** 从词形文本提取可能的词干，用于匹配 syn/ant（如「赤い」「愛嬌」原样，「会い（名）」去括号） */
function formKey(raw: string): string {
  return raw
    .replace(/（[^）]*）/g, '')
    .replace(/[〜~]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 派生词汇图谱。目前只有日语的 JLPT 全量词库；
 * 英语/韩语若将来接入同类分级词库，在此按语种扩展即可。
 */
export function vocabKnowledge(language: Language): VocabKnowledge | null {
  if (language !== 'ja') return null;
  const words = JLPT_WORDS();

  const nodes: KnowledgeNodeDef[] = [
    { code: vocabSkillCode(language), kind: 'skill', name: '词汇', sectionKey: 'vocab', sort: 2 },
  ];
  const edges: KnowledgeEdgeDef[] = [];

  // 主题中枢（按出现顺序稳定编号；词库顺序固定，编号不会漂移）
  const themes: string[] = [];
  const seenThemes = new Set<string>();
  for (const word of words) {
    if (!seenThemes.has(word.theme)) {
      seenThemes.add(word.theme);
      themes.push(word.theme);
    }
  }
  themes.forEach((theme, index) => {
    nodes.push({
      code: `${vocabSkillCode(language)}.${themeCode(theme, index)}`,
      kind: 'topic',
      name: theme,
      sectionKey: 'vocab',
      sort: index + 1,
    });
  });

  // 词形 → 节点编码索引（一词多形取第一个，保证关系边不连错）
  const termToNode = new Map<string, string>();
  for (const word of words) {
    const key = formKey(word.term);
    if (!termToNode.has(key)) termToNode.set(key, nodeCode(word.code));
  }

  // 词条节点 + 主题边
  words.forEach((word, index) => {
    nodes.push({
      code: nodeCode(word.code),
      kind: 'vocab',
      name: word.term,
      nameLocal: word.kana,
      parent: vocabSkillCode(language),
      examId: 'jlpt',
      sectionKey: 'vocab',
      levelBand: word.level,
      examWeight: word.freq === '超高频' ? 0.9 : word.freq === '高频' ? 0.7 : word.freq === '中频' ? 0.5 : 0.3,
      sort: index + 1,
      meta: {
        code: word.code,
        kana: word.kana,
        pos: word.pos,
        cn: word.cn,
        theme: word.theme,
        freq: word.freq,
        example: word.example,
        exampleCn: word.exampleCn,
        inflections: word.inflections,
        syn: word.syn,
        ant: word.ant,
        derivation: word.derivation,
      },
    });
    const topic = THEME_CODES[word.theme];
    if (topic) {
      edges.push({
        from: nodeCode(word.code),
        to: `${vocabSkillCode(language)}.${topic}`,
        type: 'related',
        weight: 1,
        confidence: 1,
      });
    }
  });

  // 近义 / 反义边：词形文本映射到节点。去重避免同一对重复声明。
  const declared = new Set<string>();
  const addRelation = (from: string, raw: string, type: 'similar'): void => {
    const toCode = termToNode.get(formKey(raw));
    if (!toCode || toCode === from) return;
    const key = [from, toCode].sort().join('|') + type;
    if (declared.has(key)) return;
    declared.add(key);
    edges.push({ from, to: toCode, type, confidence: type === 'similar' ? 0.85 : 1 });
  };
  for (const word of words) {
    const from = nodeCode(word.code);
    for (const raw of word.syn.split(/[、；;]/)) {
      if (raw.trim() && raw.trim() !== '—') addRelation(from, raw, 'similar');
    }
    // 反义也用 similar（无向类义边），与「易混对比」的语义一致
    for (const raw of word.ant.split(/[、；;]/)) {
      if (raw.trim() && raw.trim() !== '—') addRelation(from, raw, 'similar');
    }
  }

  return { nodes, edges };
}
