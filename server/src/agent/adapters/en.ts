/**
 * 英语语言能力实现（M0）。
 *
 * 三个能力是「真」的：
 * - 分词：英语按空格与标点切，够用且确定；
 * - 规则扫描：高精度、低召回 —— 只报几乎不会误判的模式，宁可漏也不误报；
 * - 句法：走 LLM，但用统一 IR 收口，所以日语接入时渲染层不用改。
 *
 * 两个能力在 M0 明确「不做」：
 * - 发音评测：没有音频对齐能力就返回 null，绝不编分数；
 * - 等级估算：只给粗糙代理值，接口保持稳定，M1 换成词表覆盖算法。
 */
import { z } from 'zod';
import type { LlmPort, ErrorTaxonomyPort, LevelScalePort, PhonologyPort, SyntaxPort, TokenizerPort } from '../ports';
import { SyntaxTreeSchema } from '../protocols';
import type { LangToken, SyntaxNode } from '../types';

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------
export const enTokenizer: TokenizerPort = {
  lang: 'en',
  async tokenize(text) {
    const out: LangToken[] = [];
    const re = /[A-Za-z][A-Za-z'’-]*|\d+(?:[.,]\d+)?/g;
    let match: RegExpExecArray | null = re.exec(text);
    while (match) {
      out.push({
        surface: match[0],
        base: match[0].toLowerCase(),
        start: match.index,
        end: match.index + match[0].length,
      });
      match = re.exec(text);
    }
    return out;
  },
  async lemmatize(token) {
    // M0 只做小写化；真正的词形还原（running → run）留给 M1 的词典表，避免现在写出半吊子规则
    return (token.base ?? token.surface).toLowerCase();
  },
};

// ---------------------------------------------------------------------------
// 规则扫描（确定性命中，绝不猜）
// ---------------------------------------------------------------------------
interface EnCheck {
  ruleId: string;
  severity: 'must-fix' | 'should-fix' | 'style';
  pattern: RegExp;
  problem: string;
  fix: (matched: string) => string;
}

const EN_CHECKS: EnCheck[] = [
  {
    ruleId: 'sva',
    severity: 'must-fix',
    pattern: /\b(people|students|children|they|we)\s+(is|was)\b/gi,
    problem: '主语是复数，be 动词用了单数形式',
    fix: (matched) => matched.replace(/\b(is|was)\b/i, (verb) => (verb.toLowerCase() === 'is' ? 'are' : 'were')),
  },
  {
    ruleId: 'redundancy',
    severity: 'style',
    pattern: /\bin my opinion,?\s+i (think|believe)\b/gi,
    problem: '观点引导语重复：in my opinion 与 I think 表达同一件事',
    fix: () => 'I would argue',
  },
  {
    ruleId: 'redundancy',
    severity: 'style',
    pattern: /\b([A-Za-z]{3,})\s+\1\b/g,
    problem: '相邻重复词',
    fix: (matched) => matched.split(/\s+/)[0],
  },
  {
    ruleId: 'collocation',
    severity: 'should-fix',
    pattern: /\bmore\s+(better|easier|faster|bigger|worse|cheaper)\b/gi,
    problem: '比较级重复：more 与 -er 不能同用',
    fix: (matched) => matched.replace(/\bmore\s+/i, ''),
  },
  {
    ruleId: 'collocation',
    severity: 'should-fix',
    pattern: /\bcould\s+of\b/gi,
    problem: '情态动词后应接 have，不是 of（听音误写）',
    fix: () => 'could have',
  },
  {
    ruleId: 'spelling',
    severity: 'must-fix',
    pattern: /\b(alot|recieve|seperate|definately|enviroment|occured)\b/gi,
    problem: '常见拼写错误',
    fix: (matched) =>
      ({
        alot: 'a lot',
        recieve: 'receive',
        seperate: 'separate',
        definately: 'definitely',
        enviroment: 'environment',
        occured: 'occurred',
      })[matched.toLowerCase()] ?? matched,
  },
  {
    ruleId: 'punctuation',
    severity: 'should-fix',
    pattern: /\s+[,.;:!?]/g,
    problem: '标点前多了空格',
    fix: (matched) => matched.trimStart(),
  },
];

export function scanEnglish(text: string): Array<{
  ruleId: string;
  quote: string;
  problem: string;
  suggestion: string;
  severity: 'must-fix' | 'should-fix' | 'style';
}> {
  const out: Array<{
    ruleId: string;
    quote: string;
    problem: string;
    suggestion: string;
    severity: 'must-fix' | 'should-fix' | 'style';
  }> = [];
  for (const check of EN_CHECKS) {
    // 每次新建 RegExp，避免 lastIndex 在多次调用间串味
    const re = new RegExp(check.pattern.source, check.pattern.flags);
    let match: RegExpExecArray | null = re.exec(text);
    while (match) {
      const quote = match[0];
      if (quote.trim().length > 0) {
        out.push({
          ruleId: check.ruleId,
          quote,
          problem: check.problem,
          suggestion: check.fix(quote),
          severity: check.severity,
        });
      }
      // 零宽匹配保护
      if (match.index === re.lastIndex) re.lastIndex += 1;
      match = re.exec(text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 句法（LLM + 统一 IR）
// ---------------------------------------------------------------------------
const ROLE_HINT = `role 只能取以下之一：head（主干核心词）/ subject（主语）/ predicate（谓语）/ object（宾语）/ modifier（修饰成分）/ clause（从句或非谓语结构）/ particle（助词，日语用）/ other。`;

type RawSyntaxNode = {
  id?: string;
  role: SyntaxNode['role'];
  text: string;
  surface?: string;
  note?: string;
  children?: RawSyntaxNode[];
};

/**
 * 模型侧 schema：**故意宽松**。
 *
 * 实测（hy4）它会把整棵树直接当根节点返回（{text, role, children}），
 * 而不是套一层 {nodes, summary, difficulty} —— 而这两种形状对人来说都算「说清楚了」。
 * 拿严格契约去卡模型，只会得到一句「JSON 无法解析」，用户看到的是产品坏了。
 * 所以：模型侧宽松收，进内核前用 assignIds 归一。契约严格的地方是下游，不是入口。
 */
const RawSyntaxTreeSchema = z.union([
  z.object({
    nodes: z.array(z.any()),
    summary: z.string().optional(),
    difficulty: z.number().optional(),
  }),
  z.any().transform((value) => ({ nodes: [value] as unknown[], summary: undefined, difficulty: undefined })),
]) as unknown as z.ZodType<{ nodes: unknown[]; summary?: string; difficulty?: number }>;

/**
 * 统一编号。模型只负责「拆成什么结构」，id 由这里按深度优先给。
 *
 * 让模型生成 id 是经典陷阱：它会重号，而前端拿 id 当 React key，
 * 一冲突整棵树重渲染。实测模型也确实会直接省掉这个字段。
 */
function assignIds(nodes: RawSyntaxNode[], prefix = 'n'): SyntaxNode[] {
  return nodes.map((node, index) => {
    const id = `${prefix}${index + 1}`;
    return {
      id,
      role: node.role,
      text: node.text,
      surface: node.surface,
      note: node.note,
      children: assignIds(node.children ?? [], `${id}.`),
    };
  });
}

export function createEnSyntax(llm: LlmPort): SyntaxPort {
  return {
    lang: 'en',
    async parse(text, opts) {
      const system = [
        '你是句法分析器，把英语句子拆成成分树，只输出 JSON。',
        ROLE_HINT,
        '规则：主干必须能独立成句；每个修饰成分单独成节点；从句作为 clause 节点，其内部继续拆。',
        '不需要给节点 id，也不需要给叶子节点写空的 children —— 结构用嵌套表达即可。',
        '输出**紧凑 JSON**：不要换行缩进、不要空格对齐，能省一半输出长度。',
        'note 只给最值得讲的两三个节点写，其余全省略；summary 用一句中文说清「按主干→修饰的顺序怎么读」。',
        'difficulty 取 0–10：每层从句 +2，非谓语结构 +1，生僻词多再 +1。',
        // 不给形状示例，模型会直接把根节点当整个响应返回（实测如此）。骨架比形容词管用。
        '严格按这个形状输出（顶层必须有 nodes 数组）：',
        '{"nodes":[{"role":"subject","text":"...","children":[{"role":"head","text":"..."}]},{"role":"predicate","text":"...","children":[]}],"summary":"先抓主干，再看从句","difficulty":5}',
        opts?.rules ? `【场景守则】\n${opts.rules}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const { data } = await llm.json({
        system,
        user: `句子：\n${text}`,
        schema: RawSyntaxTreeSchema,
        /**
         * 预算给到 5000 而不是「句子拆解需要多少」：池里是思考型模型（hy4），
         * reasoning 与正文共用同一份 max_tokens。给少了，正文被截成半截 JSON，
         * 上层只能报「无法解析」—— 这类失败看起来像解析 bug，其实是预算不够。
         */
        maxTokens: 5000,
        temperature: 0.2,
        tag: 'gra.parse',
      });

      const raw = data as unknown as { nodes: RawSyntaxNode[]; summary: string; difficulty: number };
      return {
        nodes: assignIds(raw.nodes ?? []),
        summary: raw.summary ?? '',
        difficulty: raw.difficulty ?? 0,
      };
    },

    async contrast(text) {
      const system = [
        '你是对比语言学老师，服务对象是中文母语者。只输出 JSON。',
        '任务：指出这句话里中文母语者最容易受母语干扰的点（语序、冠词有无、时态标记、介词、及物性）。',
        '每条 point 是一句话的要点，note 说明「中文里怎样 → 英语里为什么要改」，不超过 40 字。',
        '没有明显迁移点就返回空数组，不要凑数。',
      ].join('\n');

      const { data } = await llm.json({
        system,
        user: `句子：\n${text}`,
        schema: z.object({ points: z.array(z.object({ point: z.string(), note: z.string() })).default([]) }),
        maxTokens: 700,
        temperature: 0.3,
        tag: 'gra.contrast',
      });
      return data.points;
    },
  };
}

// ---------------------------------------------------------------------------
// 等级估算（M0 代理值）
// ---------------------------------------------------------------------------
export const enLevel: LevelScalePort = {
  lang: 'en',
  scale: 'cefr',
  bands: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
  async estimateTextLevel(text) {
    const words = text.split(/\s+/).filter(Boolean);
    const sentences = Math.max(1, (text.match(/[.!?]+/g) ?? []).length);
    const avgSentence = words.length / sentences;
    const avgLen = words.length ? words.reduce((sum, word) => sum + word.length, 0) / words.length : 0;
    // 代理指标：短词占比越高，越可能是基础词汇（真正的词表覆盖在 M1 接 lexicon）
    const basic = words.filter((word) => word.length <= 6).length;
    const vocabCoverage = words.length ? Number((basic / words.length).toFixed(3)) : 0;

    const band =
      avgSentence < 12 && avgLen < 4.6
        ? 'A2'
        : avgSentence < 16 && avgLen < 4.9
          ? 'B1'
          : avgSentence < 22 && avgLen < 5.3
            ? 'B2'
            : avgSentence < 28
              ? 'C1'
              : 'C2';

    return { band, vocabCoverage, avgSentence: Number(avgSentence.toFixed(1)) };
  },
  toCommonScore(band) {
    const index = this.bands.indexOf(band);
    return index < 0 ? 0 : Math.round(((index + 1) / this.bands.length) * 100);
  },
};

/** 没有音素对齐能力就返回 null —— 教育产品宁缺毋假 */
export const enPhonology: PhonologyPort = {
  lang: 'en',
  async score() {
    return null;
  },
};

export const enTaxonomy: ErrorTaxonomyPort = {
  lang: 'en',
  async scan(text) {
    return scanEnglish(text);
  },
  ruleIds() {
    return [...new Set(EN_CHECKS.map((check) => check.ruleId))];
  },
};
