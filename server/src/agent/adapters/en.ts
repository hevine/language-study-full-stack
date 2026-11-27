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
import type { ProsodyMeasurement } from '../../domain/speech';
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

// ---------------------------------------------------------------------------
// 发音 / 节奏评测
// ---------------------------------------------------------------------------

/**
 * 这里评的是**节奏**，不是音素准确度。
 *
 * 音素级评测（θ 读成 s、重音放错、连读丢了）需要强制对齐或专门的发音模型，
 * 当前识别线路给不了。能拿到的是时间：每个词/每段几点开始、几点结束。
 * 由时间能诚实地算出三件事 —— 说得多快、停了几次、停顿有多长 ——
 * 这三件事恰恰是中国学生口语最明显的短板，所以值得评，但必须标明边界。
 *
 * 阈值取自常见口语评分描述（IELTS/TOEFL 的 fluency 档位）：
 * - 语速：母语者日常 150–190 wpm，考试里 110–165 属于「从容」；
 * - 停顿：每 100 词 5 次以内算自然换气，再多就是「找词」；
 * - 连贯：单次停顿 800ms 以内不打断听感。
 * 这些数字写在这里是为了可审计 —— 换个考试（比如托福更看重 26+ 的流利度）
 * 应该改这里，而不是散在界面文案里。
 */
const PACE_IDEAL_MIN = 110;
const PACE_IDEAL_MAX = 165;
const PAUSE_PER_100_WORDS_OK = 5;
const PAUSE_AVG_OK_MS = 800;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 词期望时长：按字母数估，短词封底 180ms、长词封顶 1.2s，避免虚词被误判 */
function expectedWordMs(word: string): number {
  const letters = word.replace(/[^A-Za-z]/g, '').length || 3;
  return clamp(90 + letters * 55, 180, 1200);
}

export function scoreProsody(measurement: ProsodyMeasurement): {
  overall: number;
  dimensions: Array<{ id: string; score: number; note: string }>;
  wordLevel: Array<{ word: string; score: number; hint?: string }>;
} {
  const { wpm, articulationWpm, pauseCount, longestPauseMs, speechRatio, wordCount, pauses } = measurement;

  // --- 语速 ---
  let pace: number;
  if (wpm < PACE_IDEAL_MIN) pace = 100 - (PACE_IDEAL_MIN - wpm) * 1.2;
  else if (wpm > PACE_IDEAL_MAX) pace = 100 - (wpm - PACE_IDEAL_MAX) * 1.0;
  else pace = 100;
  pace = clamp(Math.round(pace), 30, 100);

  const paceNote =
    wpm < PACE_IDEAL_MIN
      ? `实测 ${wpm} 词/分钟，偏慢。慢通常不是嘴慢，是边想边说 —— 先把要说的三点写下来再开口，速度会自然上来。`
      : wpm > PACE_IDEAL_MAX
        ? `实测 ${wpm} 词/分钟，偏快。去掉停顿后 ${articulationWpm}，说明是抢着说完而不是从容展开。`
        : `实测 ${wpm} 词/分钟（去掉停顿 ${articulationWpm}），在从容区间（${PACE_IDEAL_MIN}–${PACE_IDEAL_MAX}）。`;

  // --- 停顿 ---
  // 不用「每 100 词几次」直接扣分：10 个词里停 1 次会被算成 10 次/100 词，
  // 但那只是一次换气。改成跟「这个长度本该有几次」比，短样本才不会被冤枉。
  const expectedPauses = Math.max(0.5, (wordCount / 100) * PAUSE_PER_100_WORDS_OK);
  const pauseRatio = pauseCount / expectedPauses;
  let pausing = pauseRatio <= 1 ? 100 : pauseRatio <= 3 ? 100 - (pauseRatio - 1) * 20 : 60 - (pauseRatio - 3) * 10;
  if (longestPauseMs > 1500) pausing -= Math.min(15, (longestPauseMs - 1500) / 300);
  pausing = clamp(Math.round(pausing), 25, 100);

  const longestText = longestPauseMs >= 1000 ? `${(longestPauseMs / 1000).toFixed(1)} 秒` : `${longestPauseMs} 毫秒`;
  const per100 = wordCount > 0 ? (pauseCount / wordCount) * 100 : 0;
  // 样本太短时「每 100 词」是外推出来的，写出来会误导（10 个词停 1 次 ≠ 每 100 词停 10 次）
  const density = wordCount >= 20 ? `每 100 词 ${per100.toFixed(1)} 次` : '这段太短，不换算密度';
  // 建议只在样本够长、停顿确实偏多时才给：10 个词里停一次，谈不上「要找词」。
  // 判据与分数同源（都用 pauseRatio），否则会出现「95 分 + 你停顿偏多」这种自相矛盾。
  const needsAdvice = wordCount >= 20 && pauseRatio >= 2;
  const pausingNote =
    pauseCount === 0
      ? '这段没有出现 ≥350ms 的停顿 —— 要么一气说完，要么录音里没测到明显的换气。'
      : `一共停了 ${pauseCount} 次（${density}），最长一次 ${longestText}，` +
        `发声占 ${(speechRatio * 100).toFixed(0)}%。${
          needsAdvice
            ? '停顿偏多，多半是在找词：把常用连接词（well / I mean / the thing is）练成条件反射，能把这些停顿填掉。'
            : pauseRatio > 1
              ? '停顿次数略高于这个长度的常见值，还不算卡壳。'
              : '停顿频率正常。'
        }`;

  // --- 连贯 ---
  const avgPause = pauses.length > 0 ? pauses.reduce((sum, item) => sum + (item.endMs - item.startMs), 0) / pauses.length : 0;
  let continuity = 100 - Math.max(0, avgPause - PAUSE_AVG_OK_MS) / 25;
  if (measurement.leadInMs > 2000) continuity -= 10;
  continuity = clamp(Math.round(continuity), 30, 100);

  const continuityNote =
    pauses.length === 0
      ? '句与句之间没有长停顿，听感是连贯的。'
      : `平均每次停顿 ${Math.round(avgPause)}ms${
          avgPause > PAUSE_AVG_OK_MS ? '，超过 800ms 后听者会以为你说完了' : '，不打断听感'
        }${measurement.leadInMs > 2000 ? `；开口前还空了 ${(measurement.leadInMs / 1000).toFixed(1)} 秒` : ''}。`;

  // --- 慢词：只有词级时间戳才做得了 ---
  const wordLevel: Array<{ word: string; score: number; hint?: string }> = [];
  for (const item of measurement.words ?? []) {
    const actual = item.endMs - item.startMs;
    const expected = expectedWordMs(item.word);
    if (actual < 550 || actual < expected * 2.2) continue;
    wordLevel.push({
      word: item.word,
      score: clamp(Math.round((expected / actual) * 100), 25, 95),
      hint: `念了 ${(actual / 1000).toFixed(2)} 秒，约是同长度词的 ${(actual / expected).toFixed(1)} 倍 —— 多半是在这个词上卡了一下，不是发音错`,
    });
  }
  wordLevel.sort((a, b) => a.score - b.score);

  const overall = Math.round(pace * 0.4 + pausing * 0.35 + continuity * 0.25);

  return {
    overall: clamp(overall, 0, 100),
    dimensions: [
      { id: 'pace', score: pace, note: paceNote },
      { id: 'pausing', score: pausing, note: pausingNote },
      { id: 'continuity', score: continuity, note: continuityNote },
    ],
    wordLevel: wordLevel.slice(0, 6),
  };
}

/**
 * 没有音频对齐能力就返回 null —— 教育产品宁缺毋假。
 * 现在有了时间戳才开始评，评的是节奏；音素准确度仍然不评。
 */
export const enPhonology: PhonologyPort = {
  lang: 'en',
  async score(input) {
    const measurement = input.measurement;
    if (!measurement) return null;
    // 少于 8 个词，语速与停顿密度都不可靠 —— 与其给个 30 分吓人，不如说「太短，测不出」
    if (measurement.wordCount < 8 || measurement.durationMs < 2000) return null;
    return scoreProsody(measurement);
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
