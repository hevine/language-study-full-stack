/**
 * 日语语言能力实现（M2）。
 *
 * 和英语那份（adapters/en.ts）最大的不同：**结构是算出来的，不是问出来的**。
 *
 * 日语的分词不能靠空格，句法也不能靠「让模型拆一棵树」—— 模型对文节边界的直觉
 * 时对时错，而错的地方恰好是助词归属，也就是学生最需要看准的地方。
 * 所以这里的分工是：
 * - 分词 → kuromoji（IPADIC），形态素、读音、活用形、词性全都是词典给的；
 * - 文节 → 规则切（自立語 + 付属語），切错了能指到具体规则，改一行就好；
 * - 成分角色 → 用法表（は/が/を/に/で/と…），不是模型猜；
 * - 错因 → 确定性模式，宁可漏也不误报（与英语一致的高精度取向）；
 * - 模型 → 只用来补「母语迁移」里规则说不出的那几条，失败就当没有。
 *
 * 代价是覆盖面窄（只认规则写过的），好处是**同一个句子每次拆得一模一样**，
 * 而且每条结论都能追到「哪条规则、哪个助词」。教育产品里后者的价值更高：
 * 学生问「为什么这里是 が 不是 は」，答案必须能复述，不能是「模型说的」。
 *
 * 音韵这一路只做モーラ：日语是モーラ拍语言，语速的单位是モーラ/分而不是词/分；
 * 高低音调（アクセント）需要 F0 曲线，当前识别线路给不了，所以不评、也不编。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import kuromoji from 'kuromoji';
import type { IpadicFeatures, Tokenizer as KuromojiTokenizer } from 'kuromoji';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import type {
  ErrorTaxonomyPort,
  LevelScalePort,
  LlmPort,
  PhonologyPort,
  SyntaxPort,
  TokenizerPort,
} from '../ports';
import type { LangToken, SyntaxNode } from '../types';

// ---------------------------------------------------------------------------
// 词法层：带活用信息的 token
// ---------------------------------------------------------------------------

/**
 * 对外仍返回 LangToken（Port 契约），但日语下游要用的东西比 LangToken 多：
 * 活用形决定时态、词性细类决定助词归属、读音决定モーラ数与振假名。
 * 所以内部用这个扩展结构，只在 Port 边界上收窄。
 */
export interface JaToken extends LangToken {
  /** 词性大类：名詞 / 動詞 / 形容詞 / 助詞 / 助動詞 / 記号 … */
  pos: string;
  /** 词性细类 1：格助詞 / 係助詞 / 接続助詞 / 固有名詞 / 数 / 接尾 … */
  detail1: string;
  detail2: string;
  /** 活用形：基本形 / 連用形 / 連用タ接続 / 未然形 …（非活用词为 '*'） */
  conjForm: string;
  /** 辞書形 */
  basic: string;
  /** 振假名（平假名）；未知词为空串 */
  readingKana: string;
}

// ---------------------------------------------------------------------------
// kuromoji 装载
// ---------------------------------------------------------------------------

/**
 * 词典路径按「kuromoji 包装在哪」解析，而不是按 process.cwd()。
 * standalone 与主项目的 cwd 不一样，按 cwd 拼路径在独立运行时必然找不到词典。
 */
function dicPath(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('kuromoji/package.json');
    return path.join(path.dirname(pkg), 'dict');
  } catch {
    return path.join(process.cwd(), 'node_modules/kuromoji/dict');
  }
}

let tokenizerPromise: Promise<KuromojiTokenizer<IpadicFeatures> | null> | null = null;

/** 词典加载失败不能让整个服务起不来：降级到字符类切分，并把「不准」写进日志 */
function getTokenizer(): Promise<KuromojiTokenizer<IpadicFeatures> | null> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve) => {
      try {
        kuromoji.builder({ dicPath: dicPath() }).build((err, tokenizer) => {
          if (err) {
            logger.warn('日语词典装载失败，降级为字符类切分（分词精度下降）', { err: err.message });
            resolve(null);
            return;
          }
          resolve(tokenizer);
        });
      } catch (err) {
        logger.warn('日语词典装载异常，降级为字符类切分', { err: (err as Error).message });
        resolve(null);
      }
    });
  }
  return tokenizerPromise;
}

const KATAKANA = /[\u30a1-\u30f6\u30fc]/;

/** 片假名读音转平假名：界面上的振假名一律用平假名，混着两种假名读起来别扭 */
function toHiragana(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.charCodeAt(0);
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : char;
  }
  return out;
}

function isKanji(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || char === '々';
}

/** 词典不可用时的兜底：按文字种类切（汉字串 / 片假名串 / 平假名串 / 数字） */
function fallbackAnalyze(text: string): JaToken[] {
  const re = /[\u4e00-\u9fff々]+|[\u30a1-\u30f6\u30fc]+|[\u3041-\u3096]+|[A-Za-z]+|\d+(?:\.\d+)?|[^\s]/g;
  const out: JaToken[] = [];
  let match: RegExpExecArray | null = re.exec(text);
  while (match) {
    const surface = match[0];
    const start = match.index;
    const kana = /^[\u3041-\u3096]+$/.test(surface);
    out.push({
      surface,
      base: surface,
      reading: kana ? surface : '',
      pos: '名詞',
      detail1: kana ? '格助詞' : '一般',
      detail2: '*',
      conjForm: '基本形',
      basic: surface,
      readingKana: kana ? surface : '',
      start,
      end: start + surface.length,
    });
    match = re.exec(text);
  }
  return out;
}

/** 形态素分析：整段一次切完，偏移量按字符累计（日文正文基本都在 BMP 内） */
export async function analyzeJa(text: string): Promise<JaToken[]> {
  const tokenizer = await getTokenizer();
  if (!tokenizer) return fallbackAnalyze(text);

  const raw = tokenizer.tokenize(text);
  const out: JaToken[] = [];
  let cursor = 0;
  for (const item of raw) {
    const surface = item.surface_form;
    const reading = item.reading && item.reading !== '*' ? toHiragana(item.reading) : '';
    const basic = item.basic_form && item.basic_form !== '*' ? item.basic_form : surface;
    out.push({
      surface,
      base: basic,
      reading,
      pos: item.pos,
      detail1: item.pos_detail_1,
      detail2: item.pos_detail_2,
      conjForm: item.conjugated_form,
      basic,
      readingKana: reading,
      start: cursor,
      end: cursor + surface.length,
    });
    cursor += surface.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// モーラ计数
// ---------------------------------------------------------------------------

const SMALL_KANA = new Set([...'ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮ']);

/**
 * モーラ数：日语的语速单位。
 *
 * 规则就是教科书那几条：小写假名不独立成拍，长音符、促音「っ」、拨音「ん」各占一拍。
 * 读音优先用词典给的（汉字词读音差一拍，语速就差 5%），没有读音时退回字面近似。
 */
export function moraeOfKana(kana: string): number {
  let count = 0;
  for (const char of kana) {
    if (SMALL_KANA.has(char)) continue;
    if (KATAKANA.test(char) || /[\u3041-\u3096ー]/.test(char)) count += 1;
    else if (isKanji(char)) count += 1; // 无读音时的近似：一字一拍
    else if (/[A-Za-z0-9]/.test(char)) count += 0.5;
  }
  return count;
}

/** 一段日语文本的モーラ数。词典可用时按读音算，否则按字面近似 */
export async function jaMoraCount(text: string): Promise<number> {
  const tokens = await analyzeJa(text);
  let total = 0;
  for (const token of tokens) {
    if (token.pos === '記号' || token.pos === '空白') continue;
    total += moraeOfKana(token.readingKana || token.surface);
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// TokenizerPort
// ---------------------------------------------------------------------------

export const jaTokenizer: TokenizerPort = {
  lang: 'ja',
  async tokenize(text) {
    return analyzeJa(text);
  },
  async lemmatize(token) {
    // 日语要的是辞書形，不是小写化：食べました → 食べる
    const [first] = await analyzeJa(token.surface);
    return first?.basic ?? token.surface;
  },
};

// ---------------------------------------------------------------------------
// 助词功能表：日语教学的骨架
//
// 学生看不懂长句，九成是「这个助词管到哪、管什么」没解决。
// 所以每个助词一句话，写在数据里而不是散在提示词里。
// ---------------------------------------------------------------------------
const PARTICLE_NOTE: Record<string, string> = {
  は: '係助詞「は」：提示主题（已知信息），后面整句都在说它。与「が」的分工是日语第一道坎：は 说「我们在谈什么」，が 说「谁做的、新信息在哪」。',
  も: '係助詞「も」：表示「也」，顶替「は」或「が」的位置，后面的谓语同样可以是否定（〜も〜ない）。',
  が: '格助詞「が」：标记主语。新信息、焦点，以及「好き・わかる・できる」这类词的対象都用 が。',
  を: '格助詞「を」：标记他动词的直接宾语。它只接他动词 —— 自动词用 が，这是自他动词最容易错的地方。',
  に: '格助詞「に」：时间点（3時に）、存在场所（教室にいる）、指向的对象（先生に聞く）、变化结果（医者になる）。',
  で: '格助詞「で」：动作发生的场所（教室で勉強する）、手段·材料（ペンで書く）、范围（日本で一番）。与「に」的分工：に 是「存在·到达的点」，で 是「动作展开的场」。',
  と: '格助詞「と」：共同参与者（友達と行く），或引用内容（〜と言う／思う／書く）。引用时「と」前面可以是一整段从句。',
  から: '格助詞「から」：起点 —— 时间（3時から）、地点（駅から）、来源（友達から聞いた）、原因（風邪から）。',
  まで: '格助詞「まで」：终点／上限 —— 时间或地点（駅まで）、程度（〜まで読んだ）。',
  より: '格助詞「より」：比较基准（AはBより高い）。',
  へ: '格助詞「へ」：方向（学校へ行く）。移动动词上基本能和「に」互换，语感更强调「朝那边」。',
  の: '格助詞「の」：连接两个名词 —— 所属（私の本）、属性（日本の文化）、同位（友達の田中さん）；连体修饰节也用它收尾（読んだのは…）。',
  や: '並立助詞「や」：部分列举（AやBなど），与「と」的「全部列举」相对。',
  か: '副助詞「か」：疑问或不确定（誰か、行くかどうか）。',
};

const AUX_NOTE: Record<string, string> = {
  ます: '助動詞「ます」：敬体（です・ます体），对听话人客气。',
  です: '助動詞「です」：敬体断定，接名词或形容动词后。',
  た: '助動詞「た」：过去／完了。',
  だ: '助動詞「だ」：常体断定（だ・である体）。',
  ない: '助動詞「ない」：否定。',
  られる: '助動詞「られる」：受身／可能／尊敬，三种意思靠上下文分。',
  せる: '助動詞「せる」：使役（让某人做）。',
  させる: '助動詞「させる」：使役（让某人做）。',
  たい: '助動詞「たい」：愿望（想做）。',
  う: '助動詞「う」：意志／推量。',
  よう: '助動詞「よう」：意志／推量／比喻。',
  そう: '助動詞「そう」：样态／传闻。',
  らしい: '助動詞「らしい」：推定／传闻。',
};

const CONJ_FORM_LABEL: Record<string, string> = {
  基本形: '辞书形',
  連用形: '连用形',
  未然形: '未然形',
  連用タ接続: 'た形',
  連用テ接続: 'て形',
  仮定形: '假定形',
  命令形: '命令形',
  意志推量形: '意志形',
};

// ---------------------------------------------------------------------------
// 文节切分
// ---------------------------------------------------------------------------

interface Bunsetsu {
  tokens: JaToken[];
  text: string;
  /** 文节的自立語（第一个非附属词） */
  head: JaToken;
  reading: string;
  particles: JaToken[];
  aux: JaToken[];
}

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '．']);

function isSentenceEnd(token: JaToken): boolean {
  return token.pos === '記号' && SENTENCE_END.has(token.surface);
}

/** 句点切句：成分角色只在句内成立，「は」的作用域不会跨句 */
function splitSentences(tokens: JaToken[]): JaToken[][] {
  const out: JaToken[][] = [];
  let current: JaToken[] = [];
  for (const token of tokens) {
    if (isSentenceEnd(token)) {
      if (current.length > 0) out.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) out.push(current);
  return out;
}

const SELF_STANDING = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '接続詞', '感動詞', '接頭詞']);

/**
 * 切成文节：自立語 + 后面的助詞／助動詞。
 *
 * 合并规则只有三条，都是为了不被复合词切碎：
 * - 接尾词（者・さん・中）跟着前面的名词走；
 * - 连续两个非数词名词并成一个（日本語学習 / 文化祭）；
 * - 接头词（お・ご・第）跟着后面的词走。
 * 数字前面切开（学生｜3人），这符合「数词短语文节」的直觉。
 */
function toBunsetsu(tokens: JaToken[]): Bunsetsu[] {
  const groups: JaToken[][] = [];
  let current: JaToken[] = [];

  const close = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const token of tokens) {
    if (token.pos === '記号') {
      // 读点只是停顿标记，不进文节
      if (token.surface === '、' || token.surface === ',') continue;
      close();
      continue;
    }

    if (token.pos === '助詞' || token.pos === '助動詞' || token.pos === 'フィラー') {
      current.push(token);
      continue;
    }

    if (current.length === 0) {
      current.push(token);
      continue;
    }

    const prev = current[current.length - 1];
    const merge =
      prev.pos === '接頭詞' ||
      token.detail1 === '接尾' ||
      // サ変动词：勉強 + する 是一个词，切开会让「勉強」看起来像个孤零零的名词
      (prev.detail1 === 'サ変接続' && token.basic === 'する') ||
      (token.pos === '名詞' && prev.pos === '名詞' && prev.detail1 !== '数' && token.detail1 !== '数');

    if (merge) current.push(token);
    else {
      close();
      current.push(token);
    }
  }
  close();

  return groups.map((group) => {
    /**
     * 文节的头取「用言优先」：サ変動詞「勉強する」如果按第一个自立語取，头会是「勉強」这个名词，
     * 后面所有关于活用、连体修饰的判断都会落到名词上 —— 「勉強することが」也就串不成修饰关系了。
     */
    const head =
      group.find((token) => token.pos === '動詞' || token.pos === '形容詞') ??
      group.find((token) => SELF_STANDING.has(token.pos)) ??
      group[0];
    return {
      tokens: group,
      text: group.map((token) => token.surface).join(''),
      head,
      reading: group.map((token) => token.readingKana || token.surface).join(''),
      particles: group.filter((token) => token.pos === '助詞'),
      aux: group.filter((token) => token.pos === '助動詞'),
    };
  });
}

function hasKanji(text: string): boolean {
  return [...text].some(isKanji);
}

/**
 * 助词一句话。按「细类」分流，而不是只看字面：
 * 「で」既可能是格助詞（場所），也可能是接続助詞（読んで）——
 * 只按字面查表，会把「読んで」解释成「动作发生的场所」，这是硬错。
 */
function particleNote(particle: JaToken | undefined): string {
  if (!particle) return '';
  const surface = particle.surface;
  if (particle.detail1 === '接続助詞') {
    return `接続助詞「${surface}」：连接前后两个动作或状态（て形／で形可以表中顿、原因、并列）。日语靠它把短句接长，中文则多用逗号。`;
  }
  if (particle.detail1 === '終助詞') {
    return `終助詞「${surface}」：句末语气（疑问、确认、感叹），不改变命题内容。`;
  }
  if (particle.detail1 === '並立助詞' && surface === 'と') {
    return '並立助詞「と」：全部列举（AとB），与「や」的部分列举相对。';
  }
  if (particle.detail1 === '副助詞') {
    return `副助詞「${surface}」：给前面的成分加限定、程度或强调。`;
  }
  return PARTICLE_NOTE[surface] ?? `助詞「${surface}」（${particle.detail1}）。`;
}

function auxNote(aux: JaToken[]): string {
  const notes = aux.map((token) => AUX_NOTE[token.basic]).filter(Boolean);
  return [...new Set(notes)].join('');
}

/** 谓语解读：时态、敬体、语态 —— 这三件事学生最常混 */
function predicateNote(bunsetsu: Bunsetsu): string {
  const { head, tokens, aux } = bunsetsu;
  const form = CONJ_FORM_LABEL[head.conjForm] ?? head.conjForm;
  const hasTa = tokens.some((token) => token.surface === 'た' || token.conjForm === '連用タ接続');
  const polite =
    aux.some((token) => ['ます', 'です'].includes(token.basic)) ||
    tokens.some((token) => ['です', 'ます', 'ました', 'ません', 'でした'].includes(token.surface));
  const voiced = tokens.some((token) => ['られる', 'せる', 'させる'].includes(token.basic) || /られ|させ/.test(token.surface));

  const parts = [`谓语在句末：「${bunsetsu.text}」`];
  if (head.pos === '動詞') {
    // サ変動詞的头是「する」，只报「する」等于没说是什么动作，把汉语词一起带上
    const sahen = tokens.find((token) => token.detail1 === 'サ変接続');
    const base = head.basic === 'する' && sahen ? `${sahen.surface}する` : head.basic;
    parts.push(`辞書形「${base}」，${form}`);
  } else if (head.pos === '形容詞') parts.push(`い形容词，${form}`);
  else if (head.pos === '名詞') parts.push('名词谓语（断定）');
  parts.push(hasTa ? '过去／完了' : '非过去（现在·将来）');
  parts.push(polite ? '敬体（です・ます）' : '常体（だ・である）');
  if (voiced) parts.push('含受身／使役，注意「谁对谁做」');
  return `${parts.join(' · ')}。`;
}

/**
 * 成分角色。判据只有助词与词性，不猜语义：
 * は/も→主题（按主语呈现）、が→主语、を→宾语、の 与格助词→修饰、副詞·連体詞→修饰。
 */
function roleOf(
  bunsetsu: Bunsetsu,
  index: number,
  predicateIndex: number,
  next: Bunsetsu | undefined,
): SyntaxNode['role'] {
  if (index === predicateIndex) return 'predicate';

  const particle = bunsetsu.particles[0];
  if (particle) {
    if (particle.detail1 === '係助詞') return 'subject';
    if (particle.detail1 === '格助詞') {
      if (particle.surface === 'が') return 'subject';
      if (particle.surface === 'を') return 'object';
      return 'modifier';
    }
    if (particle.detail1 === '並立助詞' || particle.detail1 === '副助詞') return 'modifier';
    if (particle.detail1 === '接続助詞') return 'clause';
  }

  if (bunsetsu.head.pos === '副詞' || bunsetsu.head.pos === '連体詞' || bunsetsu.head.pos === '接続詞') {
    return 'modifier';
  }
  // 「昨日」「来週」这类名词性副词：位置自由，作用等同状语
  if (bunsetsu.head.detail1 === '副詞可能') return 'modifier';
  if (bunsetsu.head.pos === '動詞' || bunsetsu.head.pos === '形容詞') {
    // 基本形／た形收尾 + 后面紧跟名词 = 连体修饰节（「私が買った本」）
    if (next && next.head.pos === '名詞' && (bunsetsu.head.conjForm === '基本形' || bunsetsu.head.conjForm === '連用タ接続')) {
      return 'clause';
    }
    return 'clause';
  }
  if (bunsetsu.head.pos === '名詞') return 'other';
  return 'other';
}

/** 找谓语：从后往前第一个「有活用」或带断定助动词的文节 */
function findPredicate(bunsetsu: Bunsetsu[]): number {
  for (let i = bunsetsu.length - 1; i >= 0; i -= 1) {
    const head = bunsetsu[i].head;
    if (head.pos === '動詞' || head.pos === '形容詞') return i;
    if (head.pos === '名詞' && bunsetsu[i].tokens.some((token) => token.pos === '助動詞')) return i;
  }
  return bunsetsu.length - 1;
}

/**
 * 振假名：整段文节标读音（含助词／助动词）。
 *
 * 词典给的是**词**的读音，多词文节要按词拼。以前一律不标，因为「一晩」会被
 * 拼成「いちばん」。现在改成「按词拼 + 一张熟字訓例外表」：
 *
 * - 拼接本身是可靠的：日本語学習者 → にほんご + がくしゅう + しゃ；
 * - 只有少数词在 IPADIC 里没登录成整词，会被拆开按音读拼（一晩 → いちばん、
 *   一人 → いちにん），这些进表覆盖，表是跑词典实测出来的，不是凭感觉写的。
 *
 * 纯假名的部分直接用字面（助词「は」读 wa，但振假名标的是「は」而不是「わ」——
 * ルビ标的是表记对应的读音，不是发音）。拼完必须全是假名，含数字、符号就不标。
 */
const READING_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ['一晩', 'ひとばん'],
  ['一人', 'ひとり'],
  ['二人', 'ふたり'],
];

const KANA_ONLY = /^[\u3041-\u3096\u30fc]+$/;

function readingOfBunsetsu(bunsetsu: Bunsetsu): string | undefined {
  const tokens = bunsetsu.tokens;
  let out = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const rest = tokens
      .slice(i)
      .map((token) => token.surface)
      .join('');
    const override = READING_OVERRIDES.find(([surface]) => rest.startsWith(surface));
    if (override) {
      out += override[1];
      // 跳过被这个词覆盖掉的 token：一晩 是两个 token，读音只有一个
      let consumed = '';
      let next = i;
      while (next < tokens.length && consumed.length < override[0].length) {
        consumed += tokens[next].surface;
        next += 1;
      }
      i = next - 1;
      continue;
    }
    const token = tokens[i];
    out += KANA_ONLY.test(token.surface) ? token.surface : token.readingKana || token.surface;
  }
  return out;
}

function furiganaOf(bunsetsu: Bunsetsu): string | undefined {
  if (!hasKanji(bunsetsu.text)) return undefined;
  const reading = readingOfBunsetsu(bunsetsu);
  if (!reading || reading === bunsetsu.text) return undefined;
  // 含数字 / 符号的拼接结果不是假名，标上去等于教错
  return KANA_ONLY.test(reading) ? reading : undefined;
}

function bunsetsuNode(
  bunsetsu: Bunsetsu,
  role: SyntaxNode['role'],
  id: string,
  extraNote: string,
  children: SyntaxNode[] = [],
): SyntaxNode {
  const notes: string[] = [];
  if (role === 'predicate') notes.push(predicateNote(bunsetsu));
  else {
    const particle = bunsetsu.particles[0];
    if (particle) notes.push(particleNote(particle));
    const aux = auxNote(bunsetsu.aux);
    if (aux) notes.push(aux);
  }
  if (extraNote) notes.push(extraNote);

  return {
    id,
    role,
    text: bunsetsu.text,
    surface: furiganaOf(bunsetsu),
    note: notes.length > 0 ? notes.join('') : undefined,
    children,
  };
}

// ---------------------------------------------------------------------------
// 句法：确定性文节 + 可选模型补充
// ---------------------------------------------------------------------------

function chunkSummary(bunsetsu: Bunsetsu[], roles: SyntaxNode['role'][]): string {
  const pick = (role: SyntaxNode['role']) => bunsetsu.filter((_, index) => roles[index] === role).map((item) => `「${item.text}」`);
  const parts: string[] = [];
  const subjects = pick('subject');
  const objects = pick('object');
  const predicates = pick('predicate');

  if (predicates.length > 0) parts.push(`谓语${predicates.join('、')}在句末`);
  if (subjects.length > 0) parts.push(`${subjects.join('、')}是主语／主题`);
  if (objects.length > 0) parts.push(`${objects.join('、')}是宾语`);
  if (parts.length === 0) parts.push(`共 ${bunsetsu.length} 个文节`);
  else parts.unshift(`共 ${bunsetsu.length} 个文节`);

  const quoted = bunsetsu.some((item) =>
    item.particles.some((particle) => particle.surface === 'と' && particle.detail1 === '格助詞'),
  );
  const tail = `先找句末谓语，再往前用 は／が 定主题，剩下的 に／で／を 都是它的补语。${
    quoted ? '「と」前面整段是被引用或思考的内容，可以先括起来当一件事看。' : ''
  }`;
  return `${parts.join('；')}。${tail}`;
}

function chunkDifficulty(bunsetsu: Bunsetsu[], nested: number, tokens: JaToken[]): number {
  const size = bunsetsu.length;
  let score = size <= 4 ? 0 : size <= 6 ? 1.5 : size <= 9 ? 3 : 4.5;
  if (nested > 0) score += Math.min(2, nested);
  if (tokens.some((token) => ['られる', 'せる', 'させる'].includes(token.basic))) score += 1.5;
  if (tokens.some((token) => ['おっしゃる', 'いらっしゃる', '申す', '伺う', 'いたす'].includes(token.basic))) score += 1;
  const kanjiTokens = tokens.filter((token) => [...token.surface].some(isKanji)).length;
  if (tokens.length > 0 && kanjiTokens / tokens.length > 0.5) score += 1;
  return Math.min(10, score);
}

export function createJaSyntax(llm: LlmPort | null = null): SyntaxPort {
  return {
    lang: 'ja',
    async parse(text) {
      const tokens = await analyzeJa(text);
      const sentences = splitSentences(tokens);
      const nodes: SyntaxNode[] = [];
      let seq = 0;
      let difficulty = 0;
      let summary = '';

      for (const [sentenceIndex, sentence] of sentences.entries()) {
        const bunsetsu = toBunsetsu(sentence);
        if (bunsetsu.length === 0) continue;

        const predicateIndex = findPredicate(bunsetsu);
        const roles = bunsetsu.map((item, index) => roleOf(item, index, predicateIndex, bunsetsu[index + 1]));
        let nestedCount = 0;

        for (let i = 0; i < bunsetsu.length; i += 1) {
          seq += 1;
          const item = bunsetsu[i];
          const role = roles[i];
          const next = bunsetsu[i + 1];

          // 连体修饰：修饰节并进后面的名词文节，树上才看得出「谁修饰谁」
          if (
            role === 'clause' &&
            next &&
            next.head.pos === '名詞' &&
            (item.head.pos === '動詞' || item.head.pos === '形容詞') &&
            (item.head.conjForm === '基本形' || item.head.conjForm === '連用タ接続')
          ) {
            const child = bunsetsuNode(item, 'clause', `n${seq}.1`, '连体修饰节：它修饰后面的名词，语序不能挪到名词后面。');
            nodes.push(
              bunsetsuNode(next, roles[i + 1], `n${seq + 1}`, '这个名词被前面的连体修饰节限定。', [child]),
            );
            nestedCount += 1;
            i += 1;
            seq += 1;
            continue;
          }

          // 谓语之后还剩补语：日语不这么说，多半是语序问题
          const trailing = i > predicateIndex && role !== 'predicate';
          const extra = trailing ? '它排在谓语之后 —— 日语谓语固定在句末，补语应移到谓语前面。' : '';
          nodes.push(bunsetsuNode(item, role, `n${seq}`, extra));
        }

        // 摘要与难度按最长的那一句给：多句输入时，第一句往往不是难点
        const sentenceDifficulty = chunkDifficulty(bunsetsu, nestedCount, sentence);
        if (sentenceIndex === 0) summary = chunkSummary(bunsetsu, roles);
        difficulty = Math.max(difficulty, sentenceDifficulty);
      }

      return {
        nodes,
        // 多句时把范围说清，免得学生以为整段只拆了一句
        summary: sentences.length > 1 ? `${summary}（这段共 ${sentences.length} 句，上面按第一句讲结构，难度按最难的一句算）` : summary,
        difficulty: Number(difficulty.toFixed(1)),
      };
    },

    async contrast(text) {
      // 规则侧：只要句子里出现了就成立的点，不依赖模型
      const tokens = await analyzeJa(text);
      const bunsetsu = toBunsetsu(tokens);
      const points: Array<{ point: string; note: string }> = [];

      const particles = new Set(tokens.filter((token) => token.pos === '助詞').map((token) => token.surface));
      if (bunsetsu.length >= 2) {
        points.push({
          point: '语序：中文 SVO，日语 SOV',
          note: '中文「我 吃 饭」，日语「私は ご飯を 食べる」—— 谓语在最后，宾语靠「を」标，不靠位置。',
        });
      }
      if (particles.has('は') || particles.has('が')) {
        points.push({
          point: 'は 与 が 都不是「主语」的同义词',
          note: 'は 提示话题（已知信息），が 标记主语（新信息／焦点）。中文没有这个区分，所以容易一律用 は。',
        });
      }
      if (particles.has('を')) {
        points.push({
          point: 'を 只接他动词',
          note: '中文「关门」对应「ドアを閉める」（他动）和「ドアが閉まる」（自动）两种，换动词时助词也得跟着换。',
        });
      }
      if (tokens.some((token) => token.basic === 'なる' || token.basic === 'する')) {
        points.push({
          point: '「〜になる／〜にする」是变化的两种视角',
          note: 'になる 是自然变化（寒くなった），にする 是人为决定（静かにしてください）。中文都用「变／让」，容易混。',
        });
      }
      for (const [word, note] of Object.entries(HOMOGRAPH_NOTE)) {
        if (text.includes(word)) points.push({ point: `「${word}」不是中文那个意思`, note });
      }
      if (tokens.some((token) => token.pos === '助動詞' && ['ます', 'です'].includes(token.basic))) {
        points.push({
          point: '敬体与常体是两套语法',
          note: 'です・ます 体对外人，だ・である 体对文章与熟人；中文没有形态上的敬语，容易一篇里两套混着用。',
        });
      }

      // 模型侧：补规则说不出的迁移点（失败就当没有，不影响上面这些）
      if (llm) {
        try {
          const { data } = await llm.json({
            system: [
              '你是对比语言学老师，服务对象是中文母语者，教日语。只输出 JSON。',
              '任务：指出这句话里中文母语者最容易受母语干扰的地方（语序、助词、自他动词、时体、敬语、汉字同形异义）。',
              '每条 point 一句话要点，note 说明「中文怎样 → 日语为什么不同」，不超过 40 字。',
              '没有明显迁移点就返回空数组，不要凑数。',
            ].join('\n'),
            user: `句子：\n${text}`,
            schema: z.object({ points: z.array(z.object({ point: z.string(), note: z.string() })).default([]) }),
            maxTokens: 600,
            temperature: 0.3,
            tag: 'gra.contrast.ja',
          });
          for (const item of data.points) {
            if (!points.some((exist) => exist.point === item.point)) points.push(item);
          }
        } catch (err) {
          logger.warn('日语迁移对照的模型补充失败，只返回规则侧结论', { err: (err as Error).message });
        }
      }

      return points.slice(0, 6);
    },
  };
}

// ---------------------------------------------------------------------------
// 错误体系：确定性扫描
// ---------------------------------------------------------------------------

const EMOTION_OR_POTENTIAL = new Set([
  '好き', '嫌い', '大好き', 'ほしい', '欲しい', 'わかる', '分かる', 'できる', '出来る',
  '上手', '下手', '苦手', '必要', '要る', '見える', '聞こえる', '怖い', '嬉しい', '悲しい', '残念',
]);

const PLACE_NOUNS = new Set([
  '学校', '会社', '駅', '家', '日本', '東京', '大阪', '店', '病院', '図書館', '公園', '空港',
  '大学', '部屋', '教室', '駅前', '国', '中国', '実家', 'ホテル', '銀行', '郵便局', 'スーパー',
]);

const MOVEMENT_VERBS = new Set(['行く', '来る', '帰る', '向かう', '戻る', '着く', '通う', '出かける']);

const TIME_POINT_VERBS = new Set(['行く', '来る', '起きる', '寝る', '会う', '帰る', '始める', '出発する']);

/** 自动词 → 他动词。选错词时助词也得跟着换，这条对照比单说「错」有用 */
const INTRANSITIVE_PAIRS: Record<string, string> = {
  閉まる: '閉める', 落ちる: '落とす', 始まる: '始める', 終わる: '終える', 決まる: '決める',
  見つかる: '見つける', 届く: '届ける', 入る: '入れる', 乗る: '乗せる', 止まる: '止める',
  壊れる: '壊す', 切れる: '切る', 消える: '消す', 増える: '増やす', 減る: '減らす',
  変わる: '変える', 上がる: '上げる', 下がる: '下げる', 集まる: '集める', 残る: '残す',
  進む: '進める', 動く: '動かす', 続く: '続ける', 生まれる: '生む',
};

const OBJECT_NOUNS = new Set([
  '犬', '猫', '鳥', '魚', '車', '机', '椅子', 'りんご', '花', '木', '家', 'ビル',
  'パソコン', '電話', '傘', '靴', '皿', 'コップ', 'ペン', '鞄', '時計', 'テレビ', 'カメラ', '自転車', '電車', 'バス',
]);

const PERSON_NOUNS = new Set([
  '私', '僕', '俺', '彼', '彼女', '学生', '先生', '友達', '子供', '人', '父', '母', '兄', '姉', '弟', '妹',
  '社員', '医者', '警官', '客', 'お客さん', '先輩', '後輩', '上司', '部長', '社長', '課長', '家族', '恋人',
]);

const PERSON_COUNTERS = new Set(['匹', '台', '冊', '本', '枚', '個', '杯', '軒']);

const PAST_ADVERBS = new Set(['昨日', '一昨日', '先週', '先月', '去年', '昨年', '先日', 'この前', '以前', '前日']);
const FUTURE_ADVERBS = new Set(['明日', 'あした', '来週', '来月', '来年', '今度']);

const KANGO_WITH_GO = new Set([
  '連絡', '確認', '説明', '報告', '相談', '案内', '紹介', '質問', '返事', '検討', '用意', '参加',
  '協力', '理解', '了承', '挨拶', '招待', '注意', '心配', '安心', '議論', '検収',
]);

/** 中日同形异义：写进「对照」，不做「错误」判定（用对用错要看语境） */
const HOMOGRAPH_NOTE: Record<string, string> = {
  勉強: '日语「勉強」是「学习」；中文的「勉强」日语说「無理に」。',
  大丈夫: '日语「大丈夫」是「没关系／不要紧」；「大丈夫ですか」是关心，不是问「你是不是大丈夫」。',
  手紙: '日语「手紙」是「信」；厕纸是「トイレットペーパー」。',
  娘: '日语「娘」是「女儿」；母亲是「母」。',
  丈夫: '日语「丈夫」是「结实、牢固」；丈夫是「夫（おっと）」。',
  汽車: '日语「汽車」指蒸汽机车（现在多说 列車）；汽车是「車／自動車」。',
  愛人: '日语「愛人」是「情人」；配偶是「妻／夫」。',
  迷惑: '日语「迷惑」是「添麻烦」，语气比中文的「迷惑」重得多。',
  我慢: '日语「我慢」是「忍耐」；傲慢是「傲慢（ごうまん）」。',
  遠慮: '日语「遠慮」是「客气、回避」；深谋远虑是「思慮」。',
  結構: '日语「結構」常作副词「相当、挺」，也可表示「不用了」；中文的「结构」是「構造」。',
};

/**
 * 简体字混入：中文母语者写日语最典型的字形错误。
 *
 * 表里只放「日语不使用该字形」的字 —— 像 国・来・学・体・数 这类中日同形的一律不收，
 * 否则正常日语句子会被成片误报。这条规则错了比不做更糟：学生会开始不信红色波浪线。
 */
const SIMPLIFIED_TO_JP: Record<string, string> = {
  汉: '漢', 语: '語', 习: '習', 书: '書', 读: '読', 说: '説', 听: '聴', 见: '見', 们: '們',
  这: '這', 个: '個', 对: '対', 时: '時', 东: '東', 车: '車', 马: '馬', 鸟: '鳥', 鱼: '魚',
  电: '電', 门: '門', 问: '問', 间: '間', 题: '題', 场: '場', 长: '長', 张: '張', 关: '関',
  应: '応', 样: '様', 业: '業', 务: '務', 边: '辺', 线: '線', 练: '練', 记: '記', 认: '認',
  让: '譲', 试: '試', 现: '現', 实: '実', 简: '簡', 单: '単', 无: '無', 两: '両', 从: '従',
  风: '風', 买: '買', 卖: '売', 钱: '銭', 开: '開', 话: '話', 词: '詞', 经: '経', 济: '済',
  压: '圧', 义: '義', 议: '議', 讨: '討', 论: '論', 阶: '階', 级: '級', 结: '結', 给: '給',
  头: '頭', 远: '遠', 运: '運', 动: '動', 员: '員', 环: '環', 该: '該', 请: '請', 谢: '謝',
  觉: '覚', 难: '難', 错: '錯', 误: '誤', 识: '識', 复: '復', 杂: '雑', 处: '処', 备: '備',
  类: '類', 馆: '館', 军: '軍', 强: '強', 恶: '悪', 众: '衆', 儿: '児', 岁: '歳',
};

/** 送假名：常用漢字表 的写法是唯一标准，这几组是学生最常写错的高频词 */
const OKURIGANA_FIX: Array<[string, string]> = [
  ['気ずく', '気づく'],
  ['落し物', '落とし物'],
  ['終わらす', '終わらせる'],
  ['現われる', '現れる'],
  ['表わす', '表す'],
  ['行なう', '行う'],
  ['打合せ', '打ち合わせ'],
  ['引越', '引っ越し'],
];

export interface JaRuleError {
  ruleId: string;
  quote: string;
  problem: string;
  suggestion: string;
  severity: 'must-fix' | 'should-fix' | 'style';
}

function push(list: JaRuleError[], item: JaRuleError): void {
  if (item.quote.trim().length === 0) return;
  if (list.some((exist) => exist.ruleId === item.ruleId && exist.quote === item.quote)) return;
  list.push(item);
}

/** 往前找最近的一个实词（跳过助词／助动词／标点）—— 「犬が3人」里 犬 隔着 が */
function prevContent(tokens: JaToken[], from: number): { token: JaToken; index: number } | null {
  for (let i = from; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token.pos === '助詞' || token.pos === '助動詞' || token.pos === '記号') continue;
    return { token, index: i };
  }
  return null;
}

/** 句级扫描：一句一句过，避免跨句误判（「昨日」管不到下一句的动词） */
export function scanJapanese(tokens: JaToken[], text: string): JaRuleError[] {
  const out: JaRuleError[] = [];

  for (const sentence of splitSentences(tokens)) {
    const sentenceText = sentence.map((token) => token.surface).join('');
    const hasPastAdverb = sentence.some((token) => PAST_ADVERBS.has(token.surface));
    const hasFutureAdverb = sentence.some((token) => FUTURE_ADVERBS.has(token.surface));

    for (let i = 0; i < sentence.length; i += 1) {
      const token = sentence[i];
      const next = sentence[i + 1];
      const after = sentence[i + 2];

      // ---- 助词：を + 感情／可能／必要（应作 が） ----
      if (token.pos === '助詞' && token.surface === 'を' && next && EMOTION_OR_POTENTIAL.has(next.basic)) {
        // 「上手に話す」「好きになる」是合法搭配，别误判
        const legal = after && (after.surface === 'に' || after.basic === 'なる' || after.surface === 'なっ');
        if (!legal) {
          const object = sentence[i - 1]?.surface ?? '';
          push(out, {
            ruleId: 'particle',
            quote: `${object}を${next.surface}`,
            problem: `「${next.basic}」是形容词性／可能表达，对象要用「が」，不能用「を」`,
            suggestion: `${object}が${next.surface}`,
            severity: 'must-fix',
          });
        }
      }

      // ---- 助词：を + 移动动词（地点应作 に／へ） ----
      if (token.pos === '助詞' && token.surface === 'を' && next && MOVEMENT_VERBS.has(next.basic)) {
        const place = sentence[i - 1];
        if (place && (PLACE_NOUNS.has(place.surface) || place.detail1 === '固有名詞')) {
          push(out, {
            ruleId: 'particle',
            quote: `${place.surface}を${next.surface}`,
            problem: '移动动词的目的地用「に／へ」；「を」表示穿过或离开的场所（家を出る）',
            suggestion: `${place.surface}に${next.surface}`,
            severity: 'must-fix',
          });
        }
      }

      // ---- 助词：时间点 + で（应作 に） ----
      if (token.pos === '助詞' && token.surface === 'で' && next && TIME_POINT_VERBS.has(next.basic)) {
        const before = prevContent(sentence, i - 1);
        if (before && /[時日]$/.test(before.token.surface)) {
          // 「3時」会被切成 3 + 時，只引「時で行き」看不出错在哪，把数词带上
          const number = before.token.detail1 === '接尾' ? prevContent(sentence, before.index - 1) : null;
          const head = number?.token.detail1 === '数' ? `${number.token.surface}${before.token.surface}` : before.token.surface;
          push(out, {
            ruleId: 'particle',
            quote: `${head}で${next.surface}`,
            problem: '时间点用「に」；「で」表示在此期间内完成（3日で終わる）',
            suggestion: `${head}に${next.surface}`,
            severity: 'should-fix',
          });
        }
      }

      // ---- 助词：场所 + で + いる（存在应作 に） ----
      if (token.pos === '助詞' && token.surface === 'で' && next && next.basic === 'いる' && sentence[i - 1]) {
        const place = sentence[i - 1];
        if (PLACE_NOUNS.has(place.surface)) {
          push(out, {
            ruleId: 'particle',
            quote: `${place.surface}で${next.surface}`,
            problem: '存在场所用「に」；「で」是动作发生的场所',
            suggestion: `${place.surface}に${next.surface}`,
            severity: 'must-fix',
          });
        }
      }

      // ---- 活用：い形容词 + だ／でした ----
      if (token.pos === '形容詞' && token.conjForm === '基本形' && next) {
        if (next.pos === '助動詞' && next.surface === 'だ') {
          push(out, {
            ruleId: 'conjugation',
            quote: `${token.surface}だ`,
            problem: 'い形容词不能接「だ」：肯定用原形，敬体用「〜いです」',
            suggestion: `${token.surface}です`,
            severity: 'must-fix',
          });
        } else if (next.pos === '助動詞' && (next.surface === 'でし' || next.surface === 'でした')) {
          push(out, {
            ruleId: 'conjugation',
            quote: `${token.surface}${next.surface}`,
            problem: 'い形容词的过去是「〜かったです」，不是「〜いでした」',
            suggestion: `${token.basic.slice(0, -1)}かったです`,
            severity: 'must-fix',
          });
        }
      }

      // ---- 活用：动词辞书形 + です ----
      if (token.pos === '動詞' && token.conjForm === '基本形' && next && next.pos === '助動詞' && next.surface === 'です') {
        push(out, {
          ruleId: 'conjugation',
          quote: `${token.surface}です`,
          problem: '动词不能直接接「です」：敬体要用「ます形」（或「〜んです」）',
          suggestion: `${token.surface}んです／ます形`,
          severity: 'must-fix',
        });
      }

      // ---- 自他动词：を + 自动词 ----
      if (token.pos === '助詞' && token.surface === 'を' && next && INTRANSITIVE_PAIRS[next.basic]) {
        const object = sentence[i - 1]?.surface ?? '';
        const transitive = INTRANSITIVE_PAIRS[next.basic];
        push(out, {
          ruleId: 'transitivity',
          quote: `${object}を${next.surface}`,
          problem: `「${next.basic}」是自动词，不能带「を」宾语：要么换成他动词「${transitive}」，要么把「を」改成「が」`,
          suggestion: `${object}が${next.surface}／${object}を${transitive}`,
          severity: 'must-fix',
        });
      }

      // ---- 量词：物品 + 数 + 人 ----
      if (token.detail1 === '接尾' && token.surface === '人') {
        const number = prevContent(sentence, i - 1);
        const noun = number ? prevContent(sentence, number.index - 1) : null;
        if (number?.token.detail1 === '数' && noun && OBJECT_NOUNS.has(noun.token.surface)) {
          push(out, {
            ruleId: 'counter',
            quote: `${noun.token.surface}${number.token.surface}人`,
            problem: '「人」只数人；动物用「匹」，机器车辆用「台」，书用「冊」',
            suggestion: `${noun.token.surface}${number.token.surface}匹／台／冊`,
            severity: 'should-fix',
          });
        }
      }

      // ---- 量词：人 + 数 + 物量词 ----
      if (token.detail1 === '接尾' && PERSON_COUNTERS.has(token.surface)) {
        const number = prevContent(sentence, i - 1);
        const noun = number ? prevContent(sentence, number.index - 1) : null;
        if (number?.token.detail1 === '数' && noun && (PERSON_NOUNS.has(noun.token.surface) || noun.token.detail2 === '人名')) {
          push(out, {
            ruleId: 'counter',
            quote: `${noun.token.surface}${number.token.surface}${token.surface}`,
            problem: '数人要用「人」',
            suggestion: `${noun.token.surface}${number.token.surface}人`,
            severity: 'should-fix',
          });
        }
      }

      // ---- 敬语：二重敬语 ----
      if (token.pos === '動詞' && /^(おっしゃ|ご覧|お見え|お越し|ご存じ|お読み|ご確認|お伝え)/.test(token.surface)) {
        const chunk = sentence.slice(i, Math.min(sentence.length, i + 4)).map((item) => item.surface).join('');
        if (/られ/.test(chunk)) {
          // 「おっしゃる」是不规则尊敬语，不能简单删「られ」了事
          const fixed = chunk.includes('おっしゃ')
            ? chunk.includes('ました')
              ? 'おっしゃいました'
              : 'おっしゃいます'
            : chunk.replace(/られ(る|ます|ました|ません)?/, '');
          push(out, {
            ruleId: 'keigo',
            quote: chunk,
            problem: '二重敬语：这些词本身已是尊敬语，再加「られる」就重复了',
            suggestion: fixed,
            severity: 'must-fix',
          });
        }
      }

      // ---- 敬语：对他人用谦让语 ----
      if (token.pos === '助詞' && (token.surface === 'が' || token.surface === 'は') && next) {
        const subject = sentence[i - 1];
        const humble = ['申す', '伺う', '拝見する', 'いたす', 'おる', '存じる'];
        if (subject && (PERSON_NOUNS.has(subject.surface) || /様$/.test(subject.surface)) && humble.includes(next.basic)) {
          push(out, {
            ruleId: 'keigo',
            quote: `${subject.surface}${token.surface}${next.surface}`,
            problem: '谦让语只能说自己这一方；对方的动作要用尊敬语',
            suggestion: `${subject.surface}${token.surface}おっしゃる／いらっしゃる`,
            severity: 'must-fix',
          });
        }
      }

      // ---- 敬语：お + 汉语词 + します（应作 ご） ----
      if (token.pos === '接頭詞' && token.surface === 'お' && next && KANGO_WITH_GO.has(next.surface)) {
        const verb = sentence[i + 2];
        if (verb && (verb.basic === 'する' || verb.basic === 'いたす')) {
          push(out, {
            ruleId: 'keigo',
            quote: `お${next.surface}${verb.surface}`,
            problem: '汉语词（漢語）前用「ご」，和语前才用「お」',
            suggestion: `ご${next.surface}${verb.surface}`,
            severity: 'must-fix',
          });
        }
      }
    }

    const bunsetsu = toBunsetsu(sentence);
    const predicateIndex = findPredicate(bunsetsu);

    // ---- 时体：过去／未来副词与谓语时态不一致 ----
    // 判定落在「整句谓语」上，而不是逐个动词：一句里可以有「昨日買った本を読む」，
    // 内层的 た 属于连体修饰，外层谓语才是时态所在。按动词逐个判会把正确句子判错。
    if (hasPastAdverb || hasFutureAdverb) {
      const predicate = bunsetsu[predicateIndex];
      const past =
        Boolean(predicate) &&
        predicate.tokens.some(
          (item) => item.surface === 'た' || item.surface === 'でした' || item.conjForm === '連用タ接続',
        );
      if (hasPastAdverb && !past) {
        push(out, {
          ruleId: 'tense-aspect',
          quote: sentenceText,
          problem: '句中有过去时间词（昨日／先週…），谓语却是非过去形',
          suggestion: '把谓语改成过去形（〜た／〜ました）',
          severity: 'should-fix',
        });
      }
      if (hasFutureAdverb && past) {
        push(out, {
          ruleId: 'tense-aspect',
          quote: sentenceText,
          problem: '句中有未来时间词（明日／来週…），谓语却是过去形',
          suggestion: '改成非过去形（辞书形或「ます形」）',
          severity: 'should-fix',
        });
      }
    }

    // ---- 语序：谓语后面还有带格助词的补语 ----
    if (predicateIndex >= 0 && predicateIndex < bunsetsu.length - 1) {
      const trailing = bunsetsu.slice(predicateIndex + 1);
      if (trailing.some((item) => item.particles.some((particle) => particle.detail1 === '格助詞'))) {
        push(out, {
          ruleId: 'word-order',
          quote: sentenceText,
          problem: '谓语后面又出现了带格助词的补语：日语谓语固定在句末',
          suggestion: `把「${bunsetsu[predicateIndex].text}」移到句末`,
          severity: 'style',
        });
      }
    }
  }

  // ---- 字形：简体字混入（按全篇扫，字形问题不分句） ----
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const jp = SIMPLIFIED_TO_JP[chars[i]];
    if (!jp) continue;
    const context = chars.slice(Math.max(0, i - 2), Math.min(chars.length, i + 3)).join('');
    push(out, {
      ruleId: 'simplified-kanji',
      quote: context,
      problem: `「${chars[i]}」是简体字形，日语用「${jp}」`,
      suggestion: context.replace(chars[i], jp),
      severity: 'must-fix',
    });
  }

  // ---- 送假名 ----
  for (const [wrong, right] of OKURIGANA_FIX) {
    if (!text.includes(wrong)) continue;
    push(out, {
      ruleId: 'reading-kana',
      quote: wrong,
      problem: '送假名写法不符合常用汉字表的习惯',
      suggestion: right,
      severity: 'should-fix',
    });
  }

  // ---- 文体：です・ます 与 だ 混用 ----
  // 只认「句末」的断定：句中的「〜だが」「〜だし」是连接用法，不算文体混用
  const isFinal = (index: number) => {
    const after = tokens[index + 1];
    return !after || after.pos === '記号';
  };
  let finalPolite = false;
  let finalPlain = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.pos !== '助動詞' || !isFinal(i)) continue;
    if (['ます', 'です'].includes(token.basic)) finalPolite = true;
    if (token.surface === 'だ') finalPlain = true;
  }
  if (finalPolite && finalPlain) {
    const firstSentence = splitSentences(tokens)[0]?.map((token) => token.surface).join('') ?? text.slice(0, 20);
    push(out, {
      ruleId: 'register',
      quote: firstSentence,
      problem: '同一篇里敬体（です・ます）与常体（だ）混用，读起来像两个人写的',
      suggestion: '统一成敬体（口语、邮件）或常体（报告、论文）',
      severity: 'style',
    });
  }

  return out.slice(0, 12);
}

export const jaTaxonomy: ErrorTaxonomyPort = {
  lang: 'ja',
  async scan(text) {
    const tokens = await analyzeJa(text);
    return scanJapanese(tokens, text);
  },
  ruleIds() {
    return [
      'particle',
      'conjugation',
      'keigo',
      'transitivity',
      'counter',
      'tense-aspect',
      'word-order',
      'reading-kana',
      'register',
      'simplified-kanji',
    ];
  },
};

// ---------------------------------------------------------------------------
// 等级：JLPT 五档
// ---------------------------------------------------------------------------

const JLPT_BANDS = ['N5', 'N4', 'N3', 'N2', 'N1'];

/** 跨刻度换算：N1 视为接近母语书面语，N5 是入门 */
const JLPT_COMMON: Record<string, number> = { N5: 15, N4: 35, N3: 55, N2: 75, N1: 92 };

export const jaLevel: LevelScalePort = {
  lang: 'ja',
  scale: 'jlpt',
  bands: JLPT_BANDS,
  async estimateTextLevel(text) {
    const tokens = await analyzeJa(text);
    const sentences = splitSentences(tokens);
    const perSentence = sentences.map((sentence) => toBunsetsu(sentence).length);
    const avgSentence = perSentence.length > 0 ? perSentence.reduce((sum, item) => sum + item, 0) / perSentence.length : 0;

    const chars = [...text].filter((char) => !/\s/.test(char));
    const kanjiRatio = chars.length > 0 ? chars.filter(isKanji).length / chars.length : 0;

    const advanced = tokens.filter((token) => ['られる', 'せる', 'させる'].includes(token.basic)).length;
    const honorific = tokens.filter((token) => ['おっしゃる', 'いらっしゃる', '申す', '伺う', 'いたす'].includes(token.basic)).length;

    let score = 0;
    if (avgSentence >= 13) score += 4;
    else if (avgSentence >= 9) score += 3;
    else if (avgSentence >= 7) score += 2;
    else if (avgSentence >= 5) score += 1;

    if (kanjiRatio >= 0.38) score += 3;
    else if (kanjiRatio >= 0.28) score += 2;
    else if (kanjiRatio >= 0.18) score += 1;

    if (advanced >= 2) score += 2;
    else if (advanced >= 1) score += 1;
    if (honorific >= 1) score += 1;

    const band = score >= 8 ? 'N1' : score >= 6 ? 'N2' : score >= 4 ? 'N3' : score >= 2 ? 'N4' : 'N5';

    // 覆盖率这里用「假名占比」代理：假名越多，越可能停在基础词上。
    // 真正的 JLPT 词表覆盖要等词库接进来，接口不动。
    return { band, vocabCoverage: Number((1 - kanjiRatio).toFixed(3)), avgSentence: Number(avgSentence.toFixed(1)) };
  },
  toCommonScore(band) {
    return JLPT_COMMON[band] ?? 0;
  },
};

// ---------------------------------------------------------------------------
// 音韵：モーラ节奏
// ---------------------------------------------------------------------------

/**
 * 日语的「语速」不是词/分，是モーラ/分。
 *
 * 参照值：NHK ニュース 播报约 420–480 モーラ/分（7–8 拍/秒），教材朗读约 300–380，
 * 学习者自然对话常在 250–350。低于 280 是明显偏慢（边想语法边说），高于 480 基本在赶。
 *
 * 停顿不看「每多少个词」，看**读点**：日语朗读的换气点就在「、」和句末，
 * 读点数量是这个长度「本该有几次停顿」的最好估计 —— 比按字数外推诚实得多。
 */
const MORA_PER_MIN_IDEAL_MIN = 280;
const MORA_PER_MIN_IDEAL_MAX = 480;

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const pausePoints = (text: string) => Math.max(1, (text.match(/[、。，．！？!?]/g) ?? []).length);

export const jaPhonology: PhonologyPort = {
  lang: 'ja',
  async score(input) {
    const measurement = input.measurement;
    if (!measurement) return null;

    const mora = await jaMoraCount(input.transcript);
    // 太短的样本算不出可信语速：20 拍说 2 秒，什么结论都不成立
    if (mora < 20 || measurement.durationMs < 2000) return null;

    const rate = mora / (measurement.durationMs / 60_000);
    const speechMs = Math.max(1, measurement.durationMs * measurement.speechRatio);
    const articulation = mora / (speechMs / 60_000);

    // --- 语速 ---
    let pace: number;
    if (rate < MORA_PER_MIN_IDEAL_MIN) pace = 100 - (MORA_PER_MIN_IDEAL_MIN - rate) * 0.16;
    else if (rate > MORA_PER_MIN_IDEAL_MAX) pace = 100 - (rate - MORA_PER_MIN_IDEAL_MAX) * 0.1;
    else pace = 100;
    pace = clampNumber(Math.round(pace), 30, 100);

    const paceNote =
      rate < MORA_PER_MIN_IDEAL_MIN
        ? `实测 ${Math.round(rate)} モーラ/分，偏慢。日语是拍语言，慢通常是「一边想语法一边说」——把常用句型练成整块（〜と思います／〜てください），拍子才起得来。`
        : rate > MORA_PER_MIN_IDEAL_MAX
          ? `实测 ${Math.round(rate)} モーラ/分，偏快。去掉停顿后 ${Math.round(articulation)}，说明是抢着说完：长音和促音最容易被吞，这两处一丢，听感就不像日语了。`
          : `实测 ${Math.round(rate)} モーラ/分（去掉停顿 ${Math.round(articulation)}），在自然区间（${MORA_PER_MIN_IDEAL_MIN}–${MORA_PER_MIN_IDEAL_MAX}）。`;

    // --- 停顿：跟「读点数量」比，短样本才不会被冤枉 ---
    const expected = pausePoints(input.transcript);
    const ratio = measurement.pauseCount / expected;
    let pausing = ratio <= 1 ? 100 : ratio <= 2.5 ? 100 - (ratio - 1) * 24 : 64 - (ratio - 2.5) * 12;
    if (measurement.longestPauseMs > 1500) pausing -= Math.min(15, (measurement.longestPauseMs - 1500) / 300);
    pausing = clampNumber(Math.round(pausing), 25, 100);

    const pausingNote =
      measurement.pauseCount === 0
        ? '没有出现 ≥350ms 的停顿 —— 一口气读完，或者录音里没测到明显换气。'
        : `停了 ${measurement.pauseCount} 次，读点 ${expected} 处，最长 ${(measurement.longestPauseMs / 1000).toFixed(1)} 秒。${
            ratio >= 2
              ? '多出来的停顿多半在「找词」或「想助词」：把「〜ので」「〜けど」这类连接说法练熟，能把这些空隙填掉。'
              : ratio > 1
                ? '比读点略多，还在正常换气范围内。'
                : '停顿安排正常。'
          }`;

    // --- 抑扬：只看整段音高跨度，不指词 ---
    // 日语的高低アクセント要落在モーラ上才判得了（需要强制对齐）。
    // 但「整段是不是一条直线」波形给得出，而平板单调正是中文母语者最典型的问题：
    // 中文的声调在音节内部起伏，日语的アクセント在音节之间跳，说着说着就压平了。
    const pitch = measurement.pitch;
    let pronunciation: number | null = null;
    let pronunciationNote = '';
    if (pitch && pitch.voicedRatio >= 0.25) {
      const range = pitch.rangeSemitones;
      if (range < 3) {
        pronunciation = clampNumber(Math.round(55 + range * 10), 40, 85);
        pronunciationNote = `音高跨度只有 ${range} 个半音（${pitch.p10Hz}–${pitch.p90Hz}Hz），基本是一条直线。日语靠音节之间的高低差区分词义与句意，平板会让听者一直「等你说完」。练法：先给每个词的第一个モーラ定个高起点，句尾降下来。`;
      } else if (range <= 14) {
        pronunciation = 100;
        pronunciationNote = `音高跨度 ${range} 个半音（${pitch.p10Hz}–${pitch.p90Hz}Hz），在自然区间，高低起伏听得出来。`;
      } else {
        pronunciation = clampNumber(Math.round(100 - (range - 14) * 3), 70, 100);
        pronunciationNote = `音高跨度 ${range} 个半音，偏大 —— 起伏本身不是错，但跨度这么大常常是句尾上扬（疑问语调）用得太频繁，陈述句听起来像在反问。`;
      }
    }

    // --- 促音：不评分，只报「有没有测到闭塞」 ---
    // 60–220ms 的短闭塞在正常日语里到处都有（か/た/ぱ 行前的闭锁），
    // 所以这个数不是促音计数；但一个都没有时，「促音被吞」几乎是确定的。
    const geminate = (input.transcript.match(/[っッ]/g) ?? []).length;
    const closures = measurement.closures?.length ?? 0;
    if (geminate > 0) {
      const closureNote =
        closures === 0
          ? `稿子里有 ${geminate} 个促音，但录音里一个短闭塞都没测到 —— 促音很可能被吞掉了（「きって」说成「きて」）。促音不是拖长，是先停住再放出来。`
          : `稿子里有 ${geminate} 个促音，录音里测到 ${closures} 处短闭塞（含か/た/ぱ 行前的正常闭锁，不等于促音数）。`;
      pronunciationNote = pronunciationNote ? `${pronunciationNote}${closureNote}` : closureNote;
    }

    // --- 连贯 ---
    const avgPause =
      measurement.pauses.length > 0
        ? measurement.pauses.reduce((sum, item) => sum + (item.endMs - item.startMs), 0) / measurement.pauses.length
        : 0;
    let continuity = 100 - Math.max(0, avgPause - 800) / 25;
    if (measurement.leadInMs > 2000) continuity -= 10;
    continuity = clampNumber(Math.round(continuity), 30, 100);

    const continuityNote =
      measurement.pauses.length === 0
        ? '句与句之间没有长停顿，听感连贯。'
        : `平均每次停 ${Math.round(avgPause)}ms${avgPause > 800 ? '，超过 800ms 听者会以为你说完了' : '，不打断听感'}。`;

    // 抑扬能测时才把它算进总分：测不到就退回三项，不拿默认分凑数
    const overall = pronunciation === null
      ? Math.round(pace * 0.4 + pausing * 0.35 + continuity * 0.25)
      : Math.round(pace * 0.32 + pausing * 0.28 + continuity * 0.2 + pronunciation * 0.2);

    return {
      overall: clampNumber(overall, 0, 100),
      dimensions: [
        { id: 'pace', score: pace, note: paceNote },
        { id: 'pausing', score: pausing, note: pausingNote },
        { id: 'continuity', score: continuity, note: continuityNote },
        ...(pronunciation === null
          ? []
          : [{ id: 'pronunciation', score: pronunciation, note: pronunciationNote }]),
      ],
      // 长音与拗音的具体对错仍不评：要落在モーラ上，需要强制对齐。
      // 这一版给的是「整段音高起伏」与「短闭塞计数」，两者都不指到具体词。
      wordLevel: [],
      rate: { value: Math.round(rate), articulation: Math.round(articulation), unit: 'モーラ/分', label: 'モーラ/分' },
      // 这一版的抑扬分来自 pitch，促音提示来自 closures：既然用了，就如实交出去
      prosody: {
        ...(measurement.pitch ? { pitch: measurement.pitch } : {}),
        ...(measurement.closures ? { closures: measurement.closures } : {}),
      },
    };
  },
};
