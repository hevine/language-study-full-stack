import { z } from 'zod';
import type { Language } from '../catalog/types';
import type {
  GradeDimension,
  GradeFeedback,
  GradeIssue,
  GradeResult,
  GradeStats,
  PracticePrompt,
} from '../domain/practice';
import { toBand, type PracticeFormat } from '../domain/rubrics';
import { profileOf } from '../domain/language';
import { logger } from '../lib/logger';
import { chatJson, resolveLlmConfig } from './llm';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const round = (value: number): number => Math.round(value);

/* ------------------------------------------------------------------ */
/* 文本分析                                                            */
/* ------------------------------------------------------------------ */

const EN_WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;
const JA_CHAR_RE = /[\u3040-\u30ff\u4e00-\u9fff々]/g;
const FILLERS_EN = /\b(um+|uh+|erm+|you know|i mean|sort of|kind of|basically|actually|like)\b/gi;
const FILLERS_JA = /(えーと|えっと|あのー|そのー|なんか|まあ)/g;
/** 韩语的单音节填充词必须「独立成词」才算：어/음 出现在 어려움、생각합니다 里是正常词汇，不是填充词 */
const FILLERS_KO = /(?<![가-힣])(?:음+|어+|그+|저기|약간|뭐|그니까|뭐였지)(?![가-힣])/g;

const CONNECTIVES_EN = [
  'however', 'moreover', 'furthermore', 'therefore', 'thus', 'consequently', 'in addition',
  'for example', 'for instance', 'first', 'second', 'finally', 'although', 'while', 'whereas',
  'because', 'since', 'as a result', 'in contrast', 'on the other hand', 'in conclusion',
  'to sum up', 'nevertheless', 'similarly', 'meanwhile', 'besides',
];

const CONNECTIVES_JA = [
  'しかし', 'また', 'したがって', 'そのため', 'なぜなら', '例えば', '一方', 'さらに', 'つまり',
  'ところが', 'それにもかかわらず', 'まず', '次に', '最後に', '結論として',
];

const CONNECTIVES_KO = [
  '그러나', '하지만', '그런데', '따라서', '그래서', '그러므로', '예를 들면', '예컨대',
  '반면에', '또한', '게다가', '즉', '결국', '먼저', '다음으로', '마지막으로', '결론적으로',
  '한편', '이에 반해', '그럼에도',
];

const STANCE_KO =
  /(나는|저는)\s*(생각한다|생각해요|믿는다|주장한다|동의한다|반대한다)|~?해야\s*한다|필요하다고\s*생각/g;

const STANCE_EN = /\b(i (?:believe|think|argue|agree|disagree)|in my (?:view|opinion)|should|must|ought to|it is (?:clear|evident))\b/gi;
const STANCE_JA = /(と考える|べきだ|べきである|と思う|と主張する|が必要だ|ではないか)/g;

const ADVANCED_UPGRADES: Array<{ from: RegExp; to: string; note: string }> = [
  { from: /\bvery important\b/gi, to: 'crucial / decisive', note: 'very + 形容词是典型的中式表达，单个精准形容词更有力' },
  { from: /\bvery big\b/gi, to: 'substantial', note: '避免 very big 这类小学词汇组合' },
  { from: /\bvery good\b/gi, to: 'compelling / highly effective', note: '按语境选词，不要一律 good' },
  { from: /\ba lot of\b/gi, to: 'numerous / a considerable amount of', note: '书面语中 a lot of 偏口语' },
  { from: /\bmore and more\b/gi, to: 'an increasing number of / growing', note: 'more and more 是阅卷高频套话' },
  { from: /\bthink\b/gi, to: 'argue / maintain / contend', note: '论证动词可替换 think，提高学术感' },
  { from: /\bbecause of this\b/gi, to: 'as a result / consequently', note: '衔接手段单一，换用结果类连接词' },
  { from: /\bget better\b/gi, to: 'improve markedly', note: '避免 get + 形容词的口语搭配' },
];

interface Analysis {
  stats: GradeStats;
  sentences: string[];
  paragraphs: string[];
  connectives: number;
  stance: number;
  errors: GradeIssue[];
  endingRepeat: number;
  styleMix: boolean;
  advancedRatio: number;
}

function splitSentences(text: string, language: Language): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const raw =
    language === 'ja'
      ? normalized.split(/(?<=[。！？!?])\s*|\n+/)
      : normalized.split(/(?<=[.!?])\s+|\n+/);
  return raw.map((item) => item.trim()).filter((item) => item.length > 1);
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const IRREGULAR: Record<string, string> = {
  go: 'goes', have: 'has', do: 'does', make: 'makes', like: 'likes', want: 'wants',
  need: 'needs', think: 'thinks', say: 'says', take: 'takes', get: 'gets', feel: 'feels',
  know: 'knows', use: 'uses', help: 'helps', become: 'becomes', seem: 'seems',
};

const THIRD_TO_BASE: Record<string, string> = {
  goes: 'go', has: 'have', does: 'do', makes: 'make', likes: 'like', wants: 'want',
  needs: 'need', thinks: 'think', says: 'say', takes: 'take', gets: 'get', feels: 'feel',
  knows: 'know', uses: 'use', helps: 'help', becomes: 'become', seems: 'seem',
};

const PAST_FORM: Record<string, string> = {
  live: 'lived', feel: 'felt', have: 'had', go: 'went', think: 'thought', want: 'wanted',
  need: 'needed', make: 'made', take: 'took', get: 'got', say: 'said', know: 'knew',
  use: 'used', like: 'liked', eat: 'ate', come: 'came', find: 'found', spend: 'spent',
};

interface Rule {
  pattern: RegExp;
  kind: string;
  problem: string;
  fix: (match: RegExpMatchArray) => string;
  reason: string;
}

const EN_RULES: Rule[] = [
  {
    pattern: /\b([A-Za-z]{2,})\s+\1\b/gi,
    kind: '语法',
    problem: '重复词',
    fix: (match) => match[1],
    reason: '同一个词连续出现两次，多半是删改时漏删。',
  },
  {
    pattern: /\ba\s+([aeiouAEIOU][a-z]{2,})\b/g,
    kind: '语法',
    problem: '冠词错误：元音音素前应用 an',
    fix: (match) => `an ${match[1]}`,
    reason: '冠词取决于读音而非拼写；注意 university / useful 这类读 /juː/ 的词除外。',
  },
  {
    pattern: /\ban\s+([bcdfgjklmnpqrstvwxyz][a-z]{2,})\b/gi,
    kind: '语法',
    problem: '冠词错误：辅音音素前应用 a',
    fix: (match) => `a ${match[1]}`,
    reason: 'an 只用于元音音素开头的词前，hour / honest 这类不发音 h 的词除外。',
  },
  {
    pattern: /\s+([,.;:!?])/g,
    kind: '语法',
    problem: '标点前多余空格',
    fix: (match) => match[1],
    reason: '英文标点紧贴前一个词，后面才加空格。',
  },
  {
    pattern: /\b(he|she|it)\s+(go|have|do|make|like|want|need|think|say|take|get|feel|know|use|help|become|seem)\b/gi,
    kind: '语法',
    problem: '主谓一致：第三人称单数漏加 -s',
    fix: (match) => `${match[1]} ${IRREGULAR[match[2].toLowerCase()] ?? `${match[2]}s`}`,
    reason: '一般现在时中 he/she/it 后动词要加 -s（have→has）。',
  },
  {
    pattern: /\b(they|we|you)\s+(goes|has|does|makes|likes|wants|needs|thinks|says)\b/gi,
    kind: '语法',
    problem: '主谓一致：复数主语误用第三人称单数',
    fix: (match) => `${match[1]} ${THIRD_TO_BASE[match[2].toLowerCase()] ?? match[2]}`,
    reason: '复数主语后用动词原形。',
  },
  {
    pattern: /\bthere is\s+(many|several|two|three|a lot of|lots of)\b/gi,
    kind: '语法',
    problem: 'There be 句型单复数不一致',
    fix: (match) => `there are ${match[1]}`,
    reason: '后接复数名词时须用 there are。',
  },
  {
    pattern: /\bdiscuss about\b/gi,
    kind: '用词',
    problem: 'discuss 后不接 about',
    fix: () => 'discuss',
    reason: 'discuss 是及物动词，直接跟宾语。',
  },
  {
    pattern: /\bcan be able to\b/gi,
    kind: '语法',
    problem: '语义重复',
    fix: () => 'can',
    reason: 'can 与 be able to 表意重复，保留其一。',
  },
  {
    pattern: /\baccording to me\b/gi,
    kind: '用词',
    problem: '表达不地道',
    fix: () => 'in my view',
    reason: 'according to 用于引用他人，不用来引出自己的观点。',
  },
  {
    pattern: /\bin my opinion,?\s*i (?:think|believe)\b/gi,
    kind: '用词',
    problem: '语义重复',
    fix: () => 'in my opinion',
    reason: 'in my opinion 与 I think 重复，删除其一。',
  },
  {
    pattern: /\b(very|really)\s+(important|good|big|bad|difficult|hard|happy)\b/gi,
    kind: '用词',
    problem: '弱化表达',
    fix: (match) => {
      const map: Record<string, string> = {
        important: 'crucial', good: 'effective', big: 'substantial',
        bad: 'harmful', difficult: 'demanding', hard: 'demanding', happy: 'delighted',
      };
      return map[match[2].toLowerCase()] ?? match[2];
    },
    reason: 'very/really + 基础形容词会削弱说服力，换成更精准的单词。',
  },
  {
    pattern:
      /\b(?:when i was|last (?:year|week|month|night)|yesterday|\d+ years? ago)\b[^.!?]{0,140}?\b(i|he|she|they|we)\s+(live|feel|have|go|think|want|need|make|take|get|say|know|use|like|eat|come|find|spend)\b/gi,
    kind: '语法',
    problem: '时态不一致：叙述过去事件却用了现在时',
    fix: (match) => {
      const verb = match[2].toLowerCase();
      const past = PAST_FORM[verb] ?? `${verb}ed`;
      return `${match[1]} ${past}`;
    },
    reason: '讲过去的经历要统一用过去时，时态跳跃会让评分官判定语法控制不足。',
  },
  {
    pattern:
      /\b(?:was|were|had|did|went|said|felt|told|decided|started|moved|joined|spent)\b[^.!?]{0,100}?\b(i|he|she|they|we)\s+(live|feel|have|go|want|need|make|take|get|say|know|use|like|eat|come|find|spend)\b/gi,
    kind: '语法',
    problem: '时态不一致：前文已用过去时，这里又跳回现在时',
    fix: (match) => `${match[1]} ${PAST_FORM[match[2].toLowerCase()] ?? `${match[2]}ed`}`,
    reason: '同一段经历里时态必须统一，否则会被判为语法控制不足。',
  },
];

function detectEnIssues(text: string, sentences: string[]): GradeIssue[] {
  const issues: GradeIssue[] = [];
  const seen = new Set<string>();
  const tenseQuotes = new Set<string>();

  for (const rule of EN_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      if (match[0].length === 0) break;
      const key = `${rule.problem}|${match[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const quote = rule.problem.startsWith('时态') ? `${match[1]} ${match[2]}` : match[0].trim();
      if (rule.problem.startsWith('时态')) {
        const tenseKey = quote.toLowerCase();
        if (tenseQuotes.has(tenseKey)) continue;
        tenseQuotes.add(tenseKey);
      }

      issues.push({
        quote,
        kind: rule.kind,
        problem: rule.problem,
        fix: rule.fix(match),
        reason: rule.reason,
      });
      if (issues.length >= 8) return issues;
    }
  }

  // 句首未大写
  for (const sentence of sentences) {
    const first = sentence.match(/[A-Za-z]/);
    if (!first) continue;
    if (first[0] === first[0].toLowerCase()) {
      issues.push({
        quote: sentence.slice(0, 40),
        kind: '语法',
        problem: '句首字母未大写',
        fix: sentence.charAt(0).toUpperCase() + sentence.slice(1, 60),
        reason: '英文句子首字母必须大写，机考录入时尤其容易漏。',
      });
      break;
    }
  }

  return issues;
}

function analyze(
  text: string,
  language: Language,
  durationSeconds: number | null,
  targetMin: number | null,
  countFillers: boolean,
): Analysis {
  const clean = text.trim();
  const sentences = splitSentences(clean, language);
  const paragraphs = splitParagraphs(clean);
  const lower = clean.toLowerCase();

  if (language === 'ja') {
    const chars = clean.match(JA_CHAR_RE)?.length ?? 0;
    const length = clean.replace(/\s/g, '').length;
    const bigrams = new Map<string, number>();
    const pure = clean.replace(/\s/g, '');
    for (let index = 0; index < pure.length - 1; index += 1) {
      const gram = pure.slice(index, index + 2);
      bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
    }
    const totalGrams = Math.max(0, pure.length - 1);
    const uniqueRatio = totalGrams === 0 ? 0 : bigrams.size / totalGrams;

    const connectives = CONNECTIVES_JA.reduce(
      (sum, word) => sum + (clean.split(word).length - 1),
      0,
    );
    const stance = (clean.match(STANCE_JA) ?? []).length;
    const fillers = countFillers ? (clean.match(FILLERS_JA) ?? []).length : 0;
    const endings = sentences.map((sentence) => sentence.slice(-3));
    const counts = new Map<string, number>();
    for (const ending of endings) counts.set(ending, (counts.get(ending) ?? 0) + 1);
    const maxEnding = Math.max(0, ...counts.values());
    const endingRepeat = endings.length === 0 ? 0 : maxEnding / endings.length;

    const polite = (clean.match(/です|ます/g) ?? []).length;
    const plain = (clean.match(/だ。|である|だった/g) ?? []).length;
    const styleMix = polite >= 2 && plain >= 2;

    const stats: GradeStats = {
      unit: 'chars',
      length,
      sentences: sentences.length,
      paragraphs: paragraphs.length,
      avgSentence: sentences.length === 0 ? 0 : round((chars / sentences.length) * 10) / 10,
      uniqueRatio: round(uniqueRatio * 100) / 100,
      fillerCount: fillers,
      durationSeconds,
      wpm: durationSeconds && durationSeconds > 0 ? round((chars / durationSeconds) * 60) : null,
      targetMin,
    };

    return {
      stats,
      sentences,
      paragraphs,
      connectives,
      stance,
      errors: [],
      endingRepeat,
      styleMix,
      advancedRatio: 0,
    };
  }

  // 韩语按「语节」（空格分隔的单位）统计：TOPIK 写作也按语节近似估字数
  if (language === 'ko') {
    const words = clean.split(/\s+/).filter((item) => item.length > 0);
    const unique = new Set(words);
    const uniqueRatio = words.length === 0 ? 0 : unique.size / words.length;
    const advanced = words.filter((word) => word.length >= 5).length;
    const advancedRatio = words.length === 0 ? 0 : advanced / words.length;

    const connectives = CONNECTIVES_KO.reduce(
      (sum, phrase) => sum + (clean.split(phrase).length - 1),
      0,
    );
    const stance = (clean.match(STANCE_KO) ?? []).length;
    const fillers = countFillers ? (clean.match(FILLERS_KO) ?? []).length : 0;

    // 语体一致性：TOPIK 评分里 해요体与 습니다体混排是明确扣分项
    const polite = (clean.match(/(어요|아요|해요|예요|이에요)/g) ?? []).length;
    const formal = (clean.match(/(습니다|ㅂ니다|입니다)/g) ?? []).length;
    const plain = (clean.match(/(한다|된다|이다|있다|없다)(?=[.\n]|$)/g) ?? []).length;
    const styleMix = polite >= 2 && formal + plain >= 2;

    const stats: GradeStats = {
      unit: 'words',
      length: words.length,
      sentences: sentences.length,
      paragraphs: paragraphs.length,
      avgSentence: sentences.length === 0 ? 0 : round((words.length / sentences.length) * 10) / 10,
      uniqueRatio: round(uniqueRatio * 100) / 100,
      fillerCount: fillers,
      durationSeconds,
      wpm: durationSeconds && durationSeconds > 0 ? round((words.length / durationSeconds) * 60) : null,
      targetMin,
    };

    return {
      stats,
      sentences,
      paragraphs,
      connectives,
      stance,
      errors: [],
      endingRepeat: 0,
      styleMix,
      advancedRatio,
    };
  }

  const words = lower.match(EN_WORD_RE) ?? [];
  const unique = new Set(words);
  const uniqueRatio = words.length === 0 ? 0 : unique.size / words.length;
  const advanced = words.filter((word) => word.length >= 8).length;
  const advancedRatio = words.length === 0 ? 0 : advanced / words.length;

  const connectives = CONNECTIVES_EN.reduce(
    (sum, phrase) => sum + (lower.split(phrase).length - 1),
    0,
  );
  const stance = (clean.match(STANCE_EN) ?? []).length;
  const fillers = countFillers ? (clean.match(FILLERS_EN) ?? []).length : 0;

  const stats: GradeStats = {
    unit: 'words',
    length: words.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    avgSentence: sentences.length === 0 ? 0 : round((words.length / sentences.length) * 10) / 10,
    uniqueRatio: round(uniqueRatio * 100) / 100,
    fillerCount: fillers,
    durationSeconds,
    wpm: durationSeconds && durationSeconds > 0 ? round((words.length / durationSeconds) * 60) : null,
    targetMin,
  };

  return {
    stats,
    sentences,
    paragraphs,
    connectives,
    stance,
    errors: detectEnIssues(clean, sentences),
    endingRepeat: 0,
    styleMix: false,
    advancedRatio,
  };
}

/* ------------------------------------------------------------------ */
/* 启发式评分                                                          */
/* ------------------------------------------------------------------ */

function lengthScore(length: number, targetMin: number | null, targetMax?: number): number {
  if (!targetMin) return 80;
  const ratio = length / targetMin;
  if (ratio >= 1) {
    const overflow = targetMax && length > targetMax * 1.4 ? 6 : 0;
    return clamp(88 + Math.min(8, (ratio - 1) * 20) - overflow, 60, 97);
  }
  return clamp(40 + ratio * 50, 32, 88);
}

function connectiveScore(count: number, sentences: number): number {
  if (sentences === 0) return 50;
  const density = count / sentences;
  return clamp(46 + density * 42, 42, 94);
}

function paragraphScore(paragraphs: number, length: number): number {
  if (paragraphs >= 3) return 90;
  if (paragraphs === 2) return length > 140 ? 74 : 84;
  return length > 90 ? 58 : 70;
}

function fluencyScore(stats: GradeStats, sentences: number): number {
  let score = 90;
  const fillerRate = stats.length === 0 ? 0 : stats.fillerCount / stats.length;
  score -= Math.min(30, fillerRate * 700);

  if (stats.wpm !== null) {
    const unit = stats.unit === 'chars' ? stats.wpm / 1.7 : stats.wpm;
    if (unit < 85) score -= Math.min(16, (85 - unit) * 0.5);
    if (unit > 180) score -= Math.min(12, (unit - 180) * 0.4);
  }
  if (sentences > 0 && stats.avgSentence < 5) score -= 6;
  return clamp(round(score), 35, 96);
}

function pronunciationScore(stats: GradeStats, confidence: number | null): number {
  if (confidence !== null && Number.isFinite(confidence) && Math.abs(confidence) > 0) {
    return clamp(round(42 + confidence * 46), 42, 88);
  }
  // 文本无法判断发音：给中性分并在评语里说明
  const lengthBonus = stats.length > 60 ? 4 : 0;
  return clamp(70 + lengthBonus, 60, 84);
}

function buildIssuesFromMetrics(
  analysis: Analysis,
  format: PracticeFormat,
  language: Language,
): GradeIssue[] {
  const issues: GradeIssue[] = [...analysis.errors];
  const { stats } = analysis;
  const target = format.wordRange?.[0] ?? null;
  const unitLabel = profileOf(language).unitLabel;

  if (target && stats.length < target * 0.85) {
    issues.push({
      quote: '',
      kind: '任务完成',
      problem: `篇幅不足：${stats.length} ${unitLabel}，要求至少 ${target} ${unitLabel}`,
      fix: `再补 ${Math.max(1, target - stats.length)} ${unitLabel}：加一个具体例证，或把最后一个理由展开成「因为—所以—例如」三句。`,
      reason: '机考与人工评分都会先看篇幅，不足会直接压到低档。',
    });
  }

  if (language === 'en' && stats.avgSentence > 30) {
    issues.push({
      quote: analysis.sentences.sort((a, b) => b.length - a.length)[0]?.slice(0, 60) ?? '',
      kind: '结构',
      problem: `句子偏长：平均 ${stats.avgSentence} 词/句`,
      fix: '在从句结束处断句，拆成两句；每句只承载一个主要动作。',
      reason: '长句容易失控，出现逗号粘连或主谓丢失。',
    });
  }

  if (language === 'en' && stats.sentences > 2 && stats.avgSentence < 8) {
    issues.push({
      quote: '',
      kind: '结构',
      problem: `句子过碎：平均 ${stats.avgSentence} 词/句`,
      fix: '用 because / which / while 把两个短句合并，形成主从结构。',
      reason: '全篇短句会显得语言能力停留在初级水平。',
    });
  }

  if (stats.length > 100 && stats.paragraphs < 2) {
    issues.push({
      quote: '',
      kind: '结构',
      problem: '没有分段',
      fix:
        language === 'ja'
          ? '按「主張／理由・例／まとめ」分成 2〜3 段。'
          : language === 'ko'
            ? '按「주장—근거—결론（主张—根据—结论）」分成 2–3 段，段间空一行。'
            : '按「立场—论证—收束」分成 2–3 段，段间空一行。',
      reason: '分段是评分标准里「组织」一项的直接依据。',
    });
  }

  if (language === 'en' && stats.uniqueRatio < 0.42 && stats.length > 60) {
    issues.push({
      quote: '',
      kind: '用词',
      problem: `词汇重复度偏高（去重比 ${stats.uniqueRatio}）`,
      fix: '把重复出现的高频词各换一次同义表达，尤其是动词与连接词。',
      reason: '重复用词会拉低词汇资源分。',
    });
  }

  if (analysis.connectives === 0 && stats.length > 60) {
    issues.push({
      quote: '',
      kind: '衔接',
      problem: '几乎没有衔接词',
      fix:
        language === 'ja'
          ? '补「しかし」「例えば」「したがって」各一处。'
          : language === 'ko'
            ? '补 그러나 / 예를 들면 / 따라서 各一处，放在句首。'
            : '补 however / for example / as a result 各一处，放在句首并用逗号隔开。',
      reason: '缺少衔接手段会让论证读起来像句子罗列。',
    });
  }

  if (language === 'ko' && analysis.styleMix) {
    issues.push({
      quote: '',
      kind: '语体',
      problem: '해요体与 습니다体混用（口语语尾混进书面语）',
      fix: '全文统一：说明文、议论文一律用 -ㅂ니다/습니다 或 -다 体，把 -아요/어요 全部改掉。',
      reason: '语体不统一是 TOPIK 写作最常见的扣分点，评分类别里直接算「언어 사용」失分。',
    });
  }

  if (language === 'ja' && analysis.styleMix) {
    issues.push({
      quote: '',
      kind: '语体',
      problem: '敬体与常体混用（です・ます 与 だ・である 混杂）',
      fix: '全文统一为常体（だ・である），记述文通常不使用敬体。',
      reason: '语体不统一是日语写作中最常见的扣分点。',
    });
  }

  if (language === 'ja' && analysis.endingRepeat > 0.6 && analysis.sentences.length >= 3) {
    issues.push({
      quote: '',
      kind: '表达',
      problem: '句尾重复过多',
      fix: '把其中一半句尾改成「〜のではないだろうか」「〜点が重要だ」等不同句式。',
      reason: '句尾单一是评分中「表現の多様性」的直接减分项。',
    });
  }

  if (format.kind === 'speak' && stats.length > 0) {
    const fillerRate = stats.fillerCount / stats.length;
    if (fillerRate > 0.03) {
      issues.push({
        quote: '',
        kind: '流利度',
        problem: `口头填充词偏多（${stats.fillerCount} 处，占 ${Math.round(fillerRate * 100)}%）`,
        fix:
          language === 'ja'
            ? '把「えーと」「あのー」换成 0.5 秒的静默停顿——停顿不扣分，填充词才扣分。'
            : language === 'ko'
              ? '把 음 / 어 / 그니까 换成 0.5 秒的静默停顿——停顿不扣分，填充词才扣分。'
              : '把 um / uh 换成 0.5 秒的静默停顿——停顿不扣分，填充词才扣分。',
        reason: '评分官把填充词视为组织语言能力不足的信号。',
      });
    }
    if (stats.wpm !== null) {
      const unit = stats.unit === 'chars' ? stats.wpm / 1.7 : stats.wpm;
      if (unit < 85) {
        issues.push({
          quote: '',
          kind: '流利度',
          problem: `语速偏慢（约 ${stats.wpm} ${profileOf(language).unitLabel}/分钟）`,
          fix: '用「3 句框架」练：立场句—理由句—例子句，先保证说满时长再提速。',
          reason: '语速过慢通常意味着在逐句翻译，而不是直接用目标语组织。',
        });
      }
    }
  }

  return issues.slice(0, 8);
}

function heuristicGrade(
  input: GradeInput,
  analysis: Analysis,
  confidence: number | null,
): GradeResult {
  const { format, language } = input;
  const { stats } = analysis;
  const targetMax = format.wordRange?.[1];

  const lengthArg = lengthScore(stats.length, format.wordRange?.[0] ?? null, targetMax);
  const stanceScore = clamp(55 + analysis.stance * 12, 55, 95);

  const organization = clamp(
    round(
      paragraphScore(stats.paragraphs, stats.length) * 0.45 +
        connectiveScore(analysis.connectives, stats.sentences) * 0.4 +
        clamp(60 + (analysis.stance > 0 ? 20 : 0), 55, 92) * 0.15,
    ),
    30,
    96,
  );

  const errorPenalty = Math.min(42, analysis.errors.length * 7);
  const longPenalty = language === 'en' && stats.avgSentence > 32 ? 8 : 0;
  const stylePenalty = analysis.styleMix ? 8 : 0;
  const repeatPenalty = analysis.endingRepeat > 0.6 ? 6 : 0;
  const languageScore = clamp(round(92 - errorPenalty - longPenalty - stylePenalty - repeatPenalty), 35, 96);

  const lexical = round(
    language === 'ja'
      ? clamp(48 + stats.uniqueRatio * 80 + Math.min(8, stats.length / 50), 40, 92)
      : clamp(44 + (stats.uniqueRatio - 0.4) * 85 + Math.min(8, analysis.advancedRatio * 40), 40, 92),
  );

  // 论证展开标记必须按语种取：用英文正则去数韩语作文，结果永远是 0，内容分被系统性压低
  const developmentPattern =
    language === 'ja'
      ? /(なぜなら|だから|そのため|たとえば|例えば|したがって|つまり|というのは)/g
      : language === 'ko'
        ? /(왜냐하면|때문에|그래서|따라서|예를 들면|예컨대|즉|그러므로|라는 뜻)/g
        : /\b(because|for example|for instance|such as|since|which means|as a result)\b/gi;
  const developmentMarkers = (input.text.match(developmentPattern) ?? []).length;
  const development = clamp(52 + developmentMarkers * 11, 52, 92);

  // 内容分不能脱离语言与结构：一篇错误密集或不分段的文章，不可能"内容优秀"
  let content = round(lengthArg * 0.6 + stanceScore * 0.25 + development * 0.15);
  content = Math.min(content, languageScore + 20);
  if (language === 'en' && stats.paragraphs <= 1 && stats.length > 100) content = Math.min(content, 86);
  content = clamp(content, 30, 90);

  const fluency = fluencyScore(stats, stats.sentences);
  const pronunciation = pronunciationScore(stats, confidence);

  const scoreById: Record<string, number> = {
    content,
    organization,
    language: languageScore,
    lexical,
    fluency,
    pronunciation,
  };

  const dimensions: GradeDimension[] = format.dimensions.map((dimension) => {
    const score = clamp(scoreById[dimension.id] ?? 65, 0, 100);
    return {
      id: dimension.id,
      name: dimension.name,
      weight: dimension.weight,
      score,
      comment: dimensionComment(dimension.id, score, stats, analysis, language),
    };
  });

  const overall = clamp(
    round(
      dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) -
        (language === 'en' && stats.paragraphs <= 1 && stats.length > 100 ? 4 : 0),
    ),
    0,
    100,
  );

  const issues = buildIssuesFromMetrics(analysis, format, language);
  const strengths = buildStrengths(dimensions, stats, language);
  const drills = buildDrills(dimensions, format, language);
  const upgrades = buildUpgrades(input.text, language);

  const feedback: GradeFeedback = {
    verdict: buildVerdict(overall, dimensions, language),
    strengths,
    issues,
    rewrite: buildRewrite(input.text, issues, analysis, language),
    upgrades,
    drills,
  };

  return {
    overall,
    band: toBand(overall, format.scale),
    dimensions,
    feedback,
    stats,
    source: 'heuristic',
    model: null,
    notice:
      '当前为启发式批改（未配置大模型或调用失败）：分数基于篇幅、结构、衔接、重复率与可检测的语法错误估算，不含语义判断。配置大模型后可获得逐句批改与改写。',
  };
}

function dimensionComment(
  id: string,
  score: number,
  stats: GradeStats,
  analysis: Analysis,
  language: Language,
): string {
  const unit = profileOf(language).unitLabel;
  switch (id) {
    case 'content':
      return score >= 80
        ? `篇幅与立场都到位（${stats.length} ${unit}，${analysis.stance} 处立场表达），论证可以被读者直接抓到。`
        : `内容展开不足：篇幅 ${stats.length} ${unit}，立场句 ${analysis.stance} 处。先把「因为…所以…例如…」写满再谈修辞。`;
    case 'organization':
      return stats.paragraphs >= 3
        ? `共 ${stats.paragraphs} 段，衔接词 ${analysis.connectives} 处，结构清楚。`
        : stats.paragraphs <= 1
          ? '全篇一段，读者难以定位每部分功能；先分段，再补衔接词。'
          : `共 ${stats.paragraphs} 段，衔接词 ${analysis.connectives} 处；段间过渡还可以更明确。`;
    case 'language':
      return analysis.errors.length === 0
        ? language === 'ja'
          ? '未检出常见语法问题（助词、活用、时态与文体一致性均通过）。'
          : language === 'ko'
            ? '未检出常见语法问题（助词、语尾、时制与文体一致性均通过）。'
            : '未检出常见语法错误（主谓一致、冠词、标点间距等常规规则均通过）。'
        : `检出 ${analysis.errors.length} 类常见错误，多为${[...new Set(analysis.errors.map((item) => item.problem))].slice(0, 2).join('、')}。`;
    case 'lexical':
      return `去重比 ${stats.uniqueRatio}（越低越重复）。${score >= 80 ? '词汇使用较多样。' : '高频词重复明显，建议做同义替换。'}`;
    case 'fluency':
      return stats.fillerCount === 0
        ? `未检出填充词，语速 ${stats.wpm ?? '—'} ${profileOf(language).unitLabel}/分钟。`
        : `填充词 ${stats.fillerCount} 处，语速 ${stats.wpm ?? '—'}。把填充词换成静默停顿即可明显改善。`;
    case 'pronunciation':
      return '该维度无法仅凭文本判断：分数按转写置信度与录音回听估算，请务必回放自己的录音核对长音、重音与语调。';
    default:
      return '';
  }
}

function buildStrengths(dimensions: GradeDimension[], stats: GradeStats, language: Language): string[] {
  const top = [...dimensions].sort((a, b) => b.score - a.score).slice(0, 2);
  const list = top.map((item) => `${item.name} ${item.score} 分：${item.comment}`);
  if (stats.length > 0) {
    list.push(`完成了 ${stats.length} ${profileOf(language).unitLabel}的实际输出——这一步比分数更重要。`);
  }
  return list.slice(0, 3);
}

function buildDrills(dimensions: GradeDimension[], format: PracticeFormat, language: Language): string[] {
  const weakest = [...dimensions].sort((a, b) => a.score - b.score).slice(0, 2);

  const JA_MAP: Record<string, string> = {
    content: '用「結論→理由→例」三句式口头回答同一题 3 遍，每遍换一个例子。',
    organization: '把本次答案改写成 3 段，每段第一句必须是该段主张句。',
    language: '挑出本次答案的 5 个句子，逐句检查助词与活用，再抄写一遍。',
    lexical: '为本题准备 8 个话题词，并各写一个搭配句。',
    fluency: '录 60 秒版本，标记所有停顿位置，重录到停顿不超过 3 次。',
    pronunciation: '跟读本次范文音频 3 遍，重点练长音、促音与句末语调。',
  };

  const EN_SPEAK_MAP: Record<string, string> = {
    content: '同一道题再说一遍：每个理由后面必须跟一个具体细节（谁、什么时候、结果如何）。',
    organization: '用 first / second / so 三个信号词重说一遍，让听者不用猜你的结构。',
    language: '把转写稿里的时态与主谓一致错误标出来，重说时只盯这一件事。',
    lexical: '为本题准备 6 个替换表达（动词 3 + 形容词 3），先说一遍再录。',
    fluency: '重录 45 秒：把 um / uh 换成 0.5 秒静默，目标是零填充词。',
    pronunciation: '跟读范文音频 3 遍，标出重音位置，再录一次对比。',
  };

  const EN_WRITE_MAP: Record<string, string> = {
    content: '用同一道题重写一次，只改论证：每个理由后必须跟一个具体例子（人/时间/结果）。',
    organization: '把本次答案重排成 3 段，每段写一句主题句，段首用不同连接词。',
    language: '把本次答案的语法问题逐条改对，然后只重写这些句子，不重写全文。',
    lexical: '为本题准备 8 个替换表达（动词 4 个、形容词 4 个），各造一句。',
    fluency: '大声读一遍自己的文章，把读起来拗口的地方改写。',
    pronunciation: '朗读本次作文并录音，重点听冠词与词尾是否吞音。',
  };

  const KO_MAP: Record<string, string> = {
    content: '同一道题再说一遍：立场句之后必须跟一个具体的经验或数据（언제·어디서·결과），不要只讲道理。',
    organization: '按「주장—근거—정리」三段重写或重说一遍，段首分别用 먼저 / 또한 / 따라서。',
    language: '挑出本次答案里 5 个句子，逐个核对助词（은/는·이/가·을/를）与语尾（-ㅂ니다/습니다 或 -어요）是否统一。',
    lexical: '为本题准备 8 个话题词（汉字词 4 + 固有词 4），每个各造一句。',
    fluency: '重说 60 秒：把 음 / 어 / 그니까 全部换成 0.5 秒停顿，目标是把填充词压到 0 次。',
    pronunciation: '跟读范文音频 3 遍，专练收音（받침）与连音（연음），再录一次对比。',
  };

  const map =
    language === 'ja'
      ? JA_MAP
      : language === 'ko'
        ? KO_MAP
        : format.kind === 'speak'
          ? EN_SPEAK_MAP
          : EN_WRITE_MAP;
  const list = weakest.map((item) => map[item.id] ?? `针对${item.name}再做一次专项练习。`);
  list.push(
    format.kind === 'speak'
      ? '隔 24 小时再做一次同题，比较两次转写稿的差别。'
      : '24 小时后不看批改重写一遍，再对照本次问题清单核对。',
  );
  return list.slice(0, 3);
}

/** 「更地道的说法」建议：按语种各一套，不能把日语的口语替换规则套到韩语作文上 */
const UPGRADES_BY_LANGUAGE: Record<Language, Array<{ from: RegExp; to: string; note: string }>> = {
  en: ADVANCED_UPGRADES,
  ja: [
    { from: /とても/g, to: '非常に / 極めて', note: '「とても」は口語的。文章では「非常に」或用具体程度表现。' },
    { from: /思う/g, to: '考える / 主張する', note: '意見文では「思う」より「考える」が適切。' },
    { from: /たくさんの/g, to: '多くの', note: '「たくさんの」は口語寄り。' },
    { from: /でも/g, to: 'しかし', note: '逆接は「しかし」に統一すると文体が引き締まる。' },
  ],
  ko: [
    { from: /너무/g, to: '매우 / 상당히', note: '「너무」偏口语；书面语用 매우 / 상당히 更稳。' },
    { from: /근데/g, to: '그러나 / 하지만', note: '「근데」是口语，书面语统一用 그러나 / 하지만。' },
    { from: /그래서/g, to: '따라서 / 그러므로', note: '书面论证里 그래서 显得随意，换成 따라서 / 그러므로。' },
    { from: /좋은 것 같아요|좋은 것 같다/g, to: '바람직하다 / 효과적이다', note: '「것 같다」把主张说软了；TOPIK 写作要给明确判断。' },
  ],
};

function buildUpgrades(text: string, language: Language): Array<{ from: string; to: string; note: string }> {
  const upgrades: Array<{ from: string; to: string; note: string }> = [];
  for (const item of UPGRADES_BY_LANGUAGE[language] ?? []) {
    item.from.lastIndex = 0;
    const match = text.match(item.from);
    if (match) upgrades.push({ from: match[0], to: item.to, note: item.note });
    if (upgrades.length >= 4) break;
  }
  return upgrades;
}

function buildRewrite(
  text: string,
  issues: GradeIssue[],
  analysis: Analysis,
  language: Language,
): { text: string; note: string } | null {
  const fixable = issues.filter((issue) => issue.quote && issue.fix && issue.quote.length > 2);
  if (fixable.length === 0) return null;

  let rewritten = text;
  let applied = 0;
  for (const issue of fixable) {
    if (rewritten.includes(issue.quote)) {
      rewritten = rewritten.replace(issue.quote, issue.fix);
      applied += 1;
    }
    if (applied >= 6) break;
  }
  if (applied === 0) return null;

  return {
    text: rewritten,
    note: `已按批改意见替换 ${applied} 处（语法与用词层面）。这只是「改错版」，不是范文——结构与论证仍需要你自己重写。`,
  };
}

function buildVerdict(overall: number, dimensions: GradeDimension[], language: Language): string {
  const weakest = [...dimensions].sort((a, b) => a.score - b.score)[0];
  const strongest = [...dimensions].sort((a, b) => b.score - a.score)[0];
  if (language === 'ja') {
    if (overall >= 85) return `全体としてよく書けています。強みは「${strongest?.name}」。次は「${weakest?.name}」を磨けば安定します。`;
    if (overall >= 70) return `伝わる内容ですが、「${weakest?.name}」が足を引っ張っています。まずそこを1点改善しましょう。`;
    return `現状では採点官に主張が届きにくい状態です。「${weakest?.name}」を最優先で直してください。`;
  }
  if (overall >= 85) return `整体已经能打：最强项是「${strongest?.name}」，只要把「${weakest?.name}」补上，就进入高分段。`;
  if (overall >= 70) return `内容读得懂，但「${weakest?.name}」在拖分。这一项提 10 分，总分就能上一个档。`;
  if (overall >= 55) return `结构勉强成立，问题集中在「${weakest?.name}」。先按批改清单逐条改，不要急着写新题。`;
  return `这篇还处在「写出来」的阶段，距离「能被评分」有差距。最该先解决的是「${weakest?.name}」，其次是篇幅。`;
}

/* ------------------------------------------------------------------ */
/* 大模型评分                                                          */
/* ------------------------------------------------------------------ */

export interface GradeInput {
  language: Language;
  format: PracticeFormat;
  prompt: PracticePrompt;
  text: string;
  durationSeconds: number | null;
  recognitionConfidence?: number | null;
}

const LlmGradeSchema = z.object({
  dimensions: z
    .array(
      z.object({
        id: z.string(),
        score: z.number().min(0).max(100),
        comment: z.string().default(''),
      }),
    )
    .min(1),
  verdict: z.string().default(''),
  strengths: z.array(z.string()).default([]),
  issues: z
    .array(
      z.object({
        quote: z.string().default(''),
        kind: z.string().default('语言'),
        problem: z.string(),
        fix: z.string().default(''),
        reason: z.string().default(''),
      }),
    )
    .default([]),
  rewrite: z
    .object({ text: z.string(), note: z.string().default('') })
    .nullable()
    .optional(),
  upgrades: z
    .array(z.object({ from: z.string(), to: z.string(), note: z.string().default('') }))
    .default([]),
  drills: z.array(z.string()).default([]),
});

/**
 * 评分官的「身份」必须跟着计划语种走。
 * 之前只有 ja / 英文两支，韩语作文会被「托福/雅思评分官」按英语标准评，
 * 连 quote / fix 都要求写成英文——打分维度与语言判断都是错的。
 */
const GRADE_SYSTEM: Record<Language, string> = {
  ja: `あなたは JLPT／EJU の記述・口述試験を採点してきた日本語教師です。学習者の解答を、提示された評価観点と配点に厳密に従って採点します。
原則：
- 甘い点は付けない。ただし改善可能な具体的根拠を示す。
- 指摘は必ず原文の該当箇所を引用し、どう直すかを提示する。
- 褒めるのは具体的に良かった点のみ。空虚な励ましは書かない。
- 出力は JSON のみ。説明文やコードブロックは付けない。`,
  ko: `你是一位有十年经验的 TOPIK 写作与口语评分官，熟悉韩国语能力考试（TOPIK Ⅱ 쓰기 / TOPIK 말하기）的评分标准与常见失分点。
评分原则：
- 严格按给定维度与权重打分，不虚高；同一篇答案在不同维度间要能自洽。
- 每条问题必须引用学员原文片段（韩文逐字，不要改写），并给出可直接替换的韩文改法。
- 重点看 TOPIK 的固定扣分点：助词（은/는·이/가·을/를）缺失或误用、语尾层级混用（해요体与습니다体混排）、连接语尾接续错误、汉字词与固有词搭配生硬。
- 表扬只写具体的、可复现的优点，不要写空泛鼓励。
- 你是批改者不是代笔：rewrite 只做语言层面的修正，不要替学生重写整篇论证。
- 只输出 JSON，不要解释文字、不要 markdown 代码块。`,
  en: `你是一位有十年经验的托福/雅思/四六级写作与口语评分官，熟悉官方 rubric 与常见失分点。
评分原则：
- 严格按给定维度与权重打分，不虚高；同一篇答案在不同维度间要能自洽。
- 每条问题必须引用原文片段（逐字，不要改写），并给出可直接替换的改后写法。
- 表扬只写具体的、可复现的优点，不要写空泛鼓励。
- 你是批改者不是代笔：rewrite 只做语言层面的修正，不要替学生重写整篇论证。
- 只输出 JSON，不要解释文字、不要 markdown 代码块。`,
};

export function buildGradePrompt(input: GradeInput, analysis: Analysis): Array<{ role: 'system' | 'user'; content: string }> {
  const { format, prompt, language } = input;
  const languageProfile = profileOf(language);
  const dims = format.dimensions
    .map(
      (dimension, index) =>
        `${index + 1}. id="${dimension.id}"｜${dimension.name}｜权重 ${Math.round(dimension.weight * 100)}%｜判定标准：${dimension.criteria}`,
    )
    .join('\n');

  const system = GRADE_SYSTEM[language];

  const statsLine = `篇幅 ${analysis.stats.length} ${languageProfile.unitLabel}｜句子 ${analysis.stats.sentences}｜段落 ${analysis.stats.paragraphs}｜平均句长 ${analysis.stats.avgSentence}｜去重比 ${analysis.stats.uniqueRatio}｜填充词 ${analysis.stats.fillerCount}｜时长 ${input.durationSeconds ?? '未记录'} 秒`;

  const user = `请批改下面这份${format.kind === 'write' ? '写作' : '口语转写'}答案。

【考试题型】${format.label}（${format.taskType}）
【题目】${prompt.title}
【题干】${prompt.scenario}
${prompt.stimulus ? `【同学观点 A】${prompt.stimulus.a}\n【同学观点 B】${prompt.stimulus.b}` : ''}
【任务要求】${prompt.question}
【评分维度】
${dims}

【学生答案】
"""
${input.text}
"""

【可量化指标】${statsLine}

请输出 JSON：
{
  "dimensions": [{"id": "上面给出的 id", "score": 0-100 的整数, "comment": "中文评语，1-2 句，必须引用原文细节"}],
  "verdict": "一句话总评（中文，直指最致命的问题）",
  "strengths": ["具体优点 2-3 条，引用原文"],
  "issues": [{"quote":"原文逐字片段","kind":"语法|用词|结构|论证|流利度|发音","problem":"问题是什么","fix":"改后的写法（考试语言）","reason":"为什么错/为什么更好（中文）"}],
  "rewrite": {"text":"只做语言修正后的版本（保留原结构与观点）","note":"说明改了什么"},
  "upgrades": [{"from":"原文表达","to":"更地道的表达","note":"为什么更好"}],
  "drills": ["下一步训练动作 2-4 条，必须可执行"]
}

硬性要求：
1. dimensions 必须覆盖上面列出的每一个 id，不能新增或遗漏。
2. issues 给 3–6 条，按严重程度排序；quote 必须是学生原文中真实存在的连续片段（若整篇性问题则 quote 留空字符串）。
3. 不要因为篇幅长就给高分，也不要因为个别拼写错误就整体压低。
4. 全部评语用中文；quote / fix / rewrite 用${languageProfile.textLabel}。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function llmGrade(input: GradeInput, analysis: Analysis): Promise<GradeResult | null> {
  const { config } = resolveLlmConfig();
  if (!config) return null;

  try {
    const raw = await chatJson(config, buildGradePrompt(input, analysis), LlmGradeSchema, {
      temperature: 0.2,
      maxTokens: 2600,
      retries: 1,
    });

    const byId = new Map(raw.dimensions.map((item) => [item.id, item]));
    const dimensions: GradeDimension[] = input.format.dimensions.map((dimension) => {
      const found = byId.get(dimension.id);
      const fallback = clamp(
        round(
          dimension.id === 'pronunciation'
            ? pronunciationScore(analysis.stats, input.recognitionConfidence ?? null)
            : 65,
        ),
        0,
        100,
      );
      return {
        id: dimension.id,
        name: dimension.name,
        weight: dimension.weight,
        score: found ? clamp(round(found.score), 0, 100) : fallback,
        comment: found?.comment?.trim() || '模型未给出该维度评语。',
      };
    });

    const overall = clamp(
      round(dimensions.reduce((sum, item) => sum + item.score * item.weight, 0)),
      0,
      100,
    );

    const issues: GradeIssue[] = raw.issues.slice(0, 8).map((issue) => ({
      quote: issue.quote?.trim() ?? '',
      kind: issue.kind?.trim() || '语言',
      problem: issue.problem.trim(),
      fix: issue.fix?.trim() ?? '',
      reason: issue.reason?.trim() ?? '',
    }));

    const feedback: GradeFeedback = {
      verdict: raw.verdict?.trim() || buildVerdict(overall, dimensions, input.language),
      strengths: raw.strengths.filter(Boolean).slice(0, 4),
      issues,
      rewrite: raw.rewrite?.text?.trim() ? { text: raw.rewrite.text.trim(), note: raw.rewrite.note?.trim() ?? '' } : null,
      upgrades: raw.upgrades.filter((item) => item.from && item.to).slice(0, 5),
      drills: raw.drills.filter(Boolean).slice(0, 4),
    };

    return {
      overall,
      band: toBand(overall, input.format.scale),
      dimensions,
      feedback,
      stats: analysis.stats,
      source: 'llm',
      model: config.usedModel ?? config.model,
      notice: null,
    };
  } catch (err) {
    logger.warn('llm grading failed, fallback to heuristic', { message: (err as Error).message });
    return null;
  }
}

/** 主入口：优先大模型批改，失败或未配置时走启发式评分 */
export async function gradeSubmission(input: GradeInput): Promise<GradeResult> {
  // 口语没有字数区间，用「作答秒数 × 每秒约 1.9 词」折算目标长度
  const targetMin =
    input.format.wordRange?.[0] ??
    (input.format.responseSeconds ? Math.round(input.format.responseSeconds * 1.9) : null);
  const analysis = analyze(
    input.text,
    input.language,
    input.durationSeconds,
    targetMin,
    input.format.kind === 'speak',
  );
  const confidence = input.recognitionConfidence ?? null;

  const llmResult = await llmGrade(input, analysis);
  if (llmResult) {
    if (input.format.kind === 'speak') {
      llmResult.notice = '发音维度基于转写文本与识别置信度估算，建议回听录音自行核对。';
    }
    return llmResult;
  }

  return heuristicGrade(input, analysis, confidence);
}
