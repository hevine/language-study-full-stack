/**
 * 韩语语言能力实现（M3，与日语同一套取向）。
 *
 * 先说和日语的关键差别，因为它决定了整个实现的形状：
 *
 * | | 日语 | 韩语 |
 * |---|---|---|
 * | 词边界 | 没有空格，必须靠词典（kuromoji） | **空格就是词边界**（어절） |
 * | 难在 | 切分本身 | 切分之后的 어절 内部 |
 * | 어절/文节 内 | 自立語 + 助詞/助動詞 | 词干 + 조사 + 어미，三者都黏在一起 |
 *
 * 所以这里**不装形态素分析器**（mecab-ko 要绑 C++ 与 100MB 词典，在这个进程里不划算），
 * 而是做三件确定的事：
 *
 * 1. 어절 切分：空格 + 标点，不需要词典，结果稳定；
 * 2. 尾部 조사 剥离：조사 是封闭类，二十几个，穷举得起，而且**决定了成分角色**；
 * 3. 语尾分类：终结 / 连接 / 冠形，再叠时制与语体 —— 同样封闭，同样穷举得起。
 *
 * 明确不做的四件事，写在这里免得被当成已完成：
 *
 * - **词干内部的音变不还原**：갑니다 的词干记作「갑」（가 + ㅂ），不是「가」。
 *   还原需要真正的形态分析，半吊子的还原会让学生看到不存在的词形。
 * - **词性只分到「体言 / 用言 / 修饰语」这一层**，不再往下细分名词与动词的子类。
 *   再细就需要词典；而错的词性标注比没有更糟 —— 学生会以为系统看懂了。
 * - **不规则活用还原不了**（实测，不是推测）：ㅂ/ㄷ/ㅅ/ㄹ/르 不规则谓词的词干会退化成
 *   「看起来像名词」的东西 —— 도와요 / 추워요 / 매워요 / 몰라요 目前判 `체언`（confidence 仍是 high），
 *   지어요 → 词干「지」、들어요 → 「들」。初级课文里 ㅂ 不规则形容词（춥다/덥다/맵다/어렵다）密度很高，
 *   这是当前最值得补的一块。根治办法只有词典（mecab-ko），补一张半吊子活用表会制造新的错标注。
 * - **해요体的收缩形 `-요` 不成词**：가요 / 만나요 / 봐요 / 해요（ㅏ·ㅓ 开音节词干 + 요）判不出语尾，
 *   会落到「名词 + 补词 요」。`먹어요 / 좋아요`（-어요/-아요 完整形）正常。
 *   代价是「합니다 体里混一句 가요」这种最常见的语体混用抓不到。
 *
 * 一条贯穿的原则和日语一致：**结构算出来，讲解才交给模型**。
 * 同一个句子每次切得一模一样，每条结论都能追到「哪条规则、哪个助词」。
 */
import { z } from 'zod';
import type { ProsodyMeasurement } from '../../domain/speech';
import type { ErrorTaxonomyPort, LevelScalePort, LlmPort, PhonologyPort, SyntaxPort, TokenizerPort } from '../ports';
import type { LangToken, SyntaxNode } from '../types';

// ---------------------------------------------------------------------------
// 한글 处理：收音判断是整个韩语规则体系的地基
// ---------------------------------------------------------------------------

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
/** 中声 21 个 × 终声 28 个 */
const JONG_COUNT = 28;
/** 终声序号：8 = ㄹ，17 = ㅂ。这两个在助词与语尾里是特例，单独拎出来 */
const JONG_RIEUL = 8;
const JONG_BIEUP = 17;

function isHangulSyllable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= HANGUL_START && code <= HANGUL_END;
}

/** 终声序号，0 表示无收音；非한글返回 -1（调用方据此跳过判断，不要当 0 用） */
export function jongseongOf(char: string | undefined): number {
  if (!char) return -1;
  const code = char.codePointAt(0) ?? 0;
  if (code < HANGUL_START || code > HANGUL_END) return -1;
  return (code - HANGUL_START) % JONG_COUNT;
}

function hasBatchim(char: string | undefined): boolean {
  // -1（非한글）不能算「有收音」，否则英文词后面也会被建议换成 은/을
  const jong = jongseongOf(char);
  return jong > 0;
}

function lastChar(text: string): string | undefined {
  return text.length > 0 ? text[text.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// 어절 切分
// ---------------------------------------------------------------------------

export interface RawEojeol {
  text: string;
  start: number;
  /** 在该 어절之后、原文里的位置（用来判断它是不是句末） */
  end: number;
}

/**
 * 按空格切 어절，再去掉两端的标点。
 *
 * 标点必须去掉，否则「갑니다.」的语尾会被认成「니다.」，整句谓语识别就废了；
 * 但起点要跟着修正，不然 token 的 offset 会和原文对不上。
 */
export function splitEojeol(text: string): RawEojeol[] {
  const out: RawEojeol[] = [];
  const re = /[^\s]+/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match) {
    const raw = match[0];
    const trimmed = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (trimmed) {
      const start = match.index + raw.indexOf(trimmed);
      out.push({ text: trimmed, start, end: start + trimmed.length });
    }
    match = re.exec(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 조사：封闭类，逐个穷举
//
// 为什么值得穷举：조사 不是装饰，它直接决定成分角色（은/는 主题、이/가 主语、
// 을/를 宾语），也决定**助词选择的字形**（有没有收音）。
// 日语靠词典给「助詞」，韩语没有词典，就只能靠这张表。
// ---------------------------------------------------------------------------

export type KoParticleKind = 'case' | 'topic' | 'auxiliary';

export interface KoParticleDef {
  surface: string;
  kind: KoParticleKind;
  /** 格助词的细分：主语/宾语/场所/方向/属格/共同/比较 */
  caseType?: 'subj' | 'obj' | 'loc' | 'dir' | 'gen' | 'com' | 'comp' | 'inst';
  label: string;
}

export const KO_PARTICLES: KoParticleDef[] = [
  // ---- 主格 ----
  { surface: '께서', kind: 'case', caseType: 'subj', label: '주격 조사「께서」：높임 대상이 주어일 때（선생님께서）。은/는·이/가 的敬语版。' },
  { surface: '이', kind: 'case', caseType: 'subj', label: '주격 조사「이」：前面名词**有收音**时用（학생이）。与「가」是同一个助词的两种字形，不是两个词。' },
  { surface: '가', kind: 'case', caseType: 'subj', label: '주격 조사「가」：前面名词**无收音**时用（친구가）。新信息、焦点在这儿。' },
  // ---- 宾格 ----
  { surface: '을', kind: 'case', caseType: 'obj', label: '목적격 조사「을」：前面名词有收音时用（책을）—— 只接他动词的宾语。' },
  { surface: '를', kind: 'case', caseType: 'obj', label: '목적격 조사「를」：前面名词无收音时用（밥을→밥을? 不，밥 有收音→밥을；친구를 才是无收音）。' },
  // ---- 属格 ----
  { surface: '의', kind: 'case', caseType: 'gen', label: '관형격 조사「의」：所属（나의 책）。口语里常省略，写成 책이/내 책 更自然。' },
  // ---- 副词格 ----
  { surface: '에게서', kind: 'case', caseType: 'loc', label: '부사격：动作的起点（친구에게서 들었어요）。' },
  { surface: '한테서', kind: 'case', caseType: 'loc', label: '부사격：에게서 的口语形。' },
  { surface: '에서', kind: 'case', caseType: 'loc', label: '부사격「에서」：动作发生的场所（학교에서 공부해요）、起点（한국에서 왔어요）。与「에」的分工：에 是存在/到达的点，에서 是动作展开的场。' },
  { surface: '에게', kind: 'case', caseType: 'dir', label: '부사격「에게」：给予/指向的对象（친구에게 줬어요）。只用于人。' },
  { surface: '한테', kind: 'case', caseType: 'dir', label: '부사격：에게 的口语形。' },
  { surface: '께', kind: 'case', caseType: 'dir', label: '부사격「께」：에게 的敬语形（선생님께 드렸어요）。' },
  { surface: '으로서', kind: 'case', caseType: 'comp', label: '부사격：资格/身份（학생으로서）。前面有收音时用 으로서。' },
  { surface: '로서', kind: 'case', caseType: 'comp', label: '부사격：资格/身份。无收音或 ㄹ 收音时用（학생으로서 / 서울로서）。' },
  { surface: '으로써', kind: 'case', caseType: 'inst', label: '부사격：手段/工具（펜으로써）。注意与 으로서（资格）不是一回事。' },
  { surface: '로써', kind: 'case', caseType: 'inst', label: '부사격：手段/工具。' },
  { surface: '으로', kind: 'case', caseType: 'dir', label: '부사격「으로」：方向/手段/变化结果（학교로 가요 / 의사가 되었어요）。有收音（ㄹ 除外）时用 으로。' },
  { surface: '로', kind: 'case', caseType: 'dir', label: '부사격「로」：无收音或 ㄹ 收音时用（서울로 / 하늘로）。' },
  { surface: '이랑', kind: 'case', caseType: 'com', label: '부사격：共同参与者（친구이랑）。有收音时用。' },
  { surface: '랑', kind: 'case', caseType: 'com', label: '부사격：共同参与者，无收音时用（친구랑）。' },
  { surface: '과', kind: 'case', caseType: 'com', label: '접속 조사「과」：并列（책과 공책）。有收音时用。' },
  { surface: '와', kind: 'case', caseType: 'com', label: '접속 조사「와」：并列，无收音时用（친구와）。' },
  { surface: '보다', kind: 'case', caseType: 'comp', label: '부사격「보다」：比较基准（나보다）。' },
  { surface: '처럼', kind: 'case', caseType: 'comp', label: '부사격「처럼」：比喻（바보처럼）。' },
  { surface: '만큼', kind: 'case', caseType: 'comp', label: '부사격「만큼」：程度（너만큼）。' },
  { surface: '대로', kind: 'case', caseType: 'comp', label: '부사격「대로」：按照（말한 대로）。' },
  { surface: '에', kind: 'case', caseType: 'loc', label: '부사격「에」：时间点（3시에）、存在场所（집에 있어요）、到达点（학교에 가요）、指向对象（선생님께? 不，人要用 에게）。' },
  // ---- 补助词（은/는 也在这类，韩语语法里它不算格助词）----
  { surface: '은', kind: 'topic', label: '보조사「은」：提示主题（有收音：학생은）。与 이/가 的分工是韩语第一道坎：은 说「我们在谈什么」，이/가 说「谁做的、焦点在哪」。' },
  { surface: '는', kind: 'topic', label: '보조사「는」：提示主题（无收音：친구는）。对比例、已知信息用 은/는，新信息用 이/가。' },
  { surface: '도', kind: 'auxiliary', label: '보조사「도」：也（나도）。顶替 은/는·이/가 的位置。' },
  { surface: '만', kind: 'auxiliary', label: '보조사「만」：只（이것만）。' },
  { surface: '까지', kind: 'auxiliary', label: '보조사「까지」：到／连（3시까지）。' },
  { surface: '부터', kind: 'auxiliary', label: '보조사「부터」：从（아침부터）。' },
  { surface: '조차', kind: 'auxiliary', label: '보조사「조차」：连…都（그것조차）。多用于否定。' },
  { surface: '마저', kind: 'auxiliary', label: '보조사「마저」：连…也（너마저）。' },
  { surface: '밖에', kind: 'auxiliary', label: '보조사「밖에」：只（后面必须是否定：이것밖에 없어요）。' },
  { surface: '뿐', kind: 'auxiliary', label: '보조사「뿐」：只（학생뿐）。' },
  { surface: '이나', kind: 'auxiliary', label: '보조사「이나」：多达／或者（세 명이나）。有收音时用。' },
  { surface: '라도', kind: 'auxiliary', label: '보조사「라도」：哪怕（물이라도）。有收音时用。' },
  { surface: '나', kind: 'auxiliary', label: '보조사「나」：无收音时的 이나/라도（친구나）。' },
  { surface: '이야', kind: 'auxiliary', label: '보조사：强调（그건 이거야）。' },
  { surface: '요', kind: 'auxiliary', label: '보조사「요」：口语敬语尾，挂在句末成分后（밥이요）。' },
];

/** 长助词优先：에서 不能被 에 + 서 拆开 */
const PARTICLES_BY_LENGTH = [...KO_PARTICLES].sort((a, b) => b.surface.length - a.surface.length);

const PARTICLE_BY_SURFACE = new Map(KO_PARTICLES.map((item) => [item.surface, item]));

/**
 * 两字 어절 的助词多半是在猜：하나 / 사과 / 종이 这些词本身就以助词字形结尾。
 * 猜出来的切分只用于画树，**不用于判错** —— 判错必须建立在确定的切分上。
 */
const PRONOUN_STEMS = new Set(['나', '저', '너', '그', '이', '우리', '제', '누', '내', '네']);

/**
 * 单音节常见名词（封闭词表，约 60 个）。
 *
 * 只为解决一件事：两字 어절 「책를」「집에」到底是不是 名词+助词。
 * 사과 / 하나 / 종이 这类词本身就以助词字形结尾，剥了就成了「사」「하」「종」。
 * 所以只对**认得出是名词**的单音节词干动刀，其余一律不剥 ——
 * 少剥一层助词只是树画得粗一点，剥错了会给出一个不存在的词。
 */
const SHORT_NOUNS = new Set([
  '집', '밥', '물', '책', '산', '꽃', '차', '돈', '문', '길', '손', '발', '눈', '코', '귀', '입',
  '방', '배', '땅', '불', '비', '해', '달', '별', '말', '옷', '컵', '폰', '잠', '꿈', '힘', '맘',
  '일', '때', '곳', '줄', '수', '걸', '년', '월', '날', '밤', '낮', '봄', '여름', '가을', '겨울',
  '국', '글', '말', '글', '몸', '병', '약', '값', '돈', '상', '층', '번', '개', '명', '사',
]);

export interface KoParticle extends KoParticleDef {
  /** 切分可信度；guess 时只画结构、不判错 */
  confidence: 'high' | 'guess';
}

interface SplitResult {
  stem: string;
  particle?: KoParticle;
  auxiliary?: KoParticle;
  confidence: 'high' | 'guess';
}

function matchParticle(token: string): KoParticle | null {
  for (const def of PARTICLES_BY_LENGTH) {
    if (!token.endsWith(def.surface)) continue;
    const stem = token.slice(0, token.length - def.surface.length);
    if (!stem) continue;
    // 两字 어절 + 单字助词： 하나/사과/종이 这类词会被误切，标成 guess
    // 两字 어절 + 单字助词：只有词干是代词或常见单音节名词才动，其余一律不剥
    // （사과 / 하나 / 종이 这类词本身就以助词字形结尾，剥了会得到一个不存在的词）
    if (def.surface.length === 1 && token.length <= 2 && !PRONOUN_STEMS.has(stem) && !SHORT_NOUNS.has(stem)) {
      return null;
    }
    return { ...def, confidence: 'high' };
  }
  return null;
}

/**
 * 剥尾部 조사：先剥补助词（은/는/도/만/요），再剥格助词。
 *
 * 顺序不能反：학교에서는 = 학교 + 에서 + 는，先剥 은/는 才看得到 에서。
 * 只剥一层格助词就停 —— 韩语没有「两个格助词连用」这种结构。
 */
function splitParticle(text: string): SplitResult {
  let stem = text;
  let auxiliary: KoParticle | undefined;
  let particle: KoParticle | undefined;
  let confidence: 'high' | 'guess' = 'high';

  for (let pass = 0; pass < 2; pass += 1) {
    const found = matchParticle(stem);
    if (!found) break;
    if (found.confidence === 'guess') confidence = 'guess';
    if (found.kind === 'case') {
      particle = found;
      stem = stem.slice(0, stem.length - found.surface.length);
      break;
    }
    // 은/는 与补助词：继续再剥一层，但只能剥一次
    if (!auxiliary) {
      auxiliary = found;
      stem = stem.slice(0, stem.length - found.surface.length);
      continue;
    }
    break;
  }

  return { stem, particle, auxiliary, confidence };
}

// ---------------------------------------------------------------------------
// 어미：终结 / 连接 / 冠形，再叠时制与语体
//
// 语体（register）在韩语里是硬语法，不是修辞：
// 对长辈用 해요 体、对朋友用 해 体、写报告用 한다 体，混用就是错。
// 所以每个语尾都要带 register 与 tense 两个标签，后面的错因与评分全靠它们。
// ---------------------------------------------------------------------------

export type KoRegister = 'formal' | 'polite' | 'casual' | 'written';

export interface KoEnding {
  id: string;
  /** 语尾本身，如 습니다 / 어요 / 고 */
  suffix: string;
  label: string;
  register: KoRegister | 'none';
  tense: 'past' | 'present' | 'future';
  kind: 'final' | 'connective' | 'adnominal';
}

interface EndingDef extends KoEnding {
  /**
   * 额外条件：同样以 니까 结尾，갑니까（正式疑问）与 가니까（因为）必须分开。
   * 入参是**去掉语尾之后的词干**（갑 / 가），不是整词 —— 见 matchEnding 里的注释。
   */
  when?: (base: string) => boolean;
}

const ENDING_DEFS: EndingDef[] = [
  // ---- 正式体（합니다体）----
  { id: 'formal-past-honorific', suffix: '셨습니다', label: '-셨습니다（过去 + 敬语 + 正式体）', register: 'formal', tense: 'past', kind: 'final' },
  { id: 'formal-past', suffix: '었습니다', label: '-었습니다（过去 + 正式体）', register: 'formal', tense: 'past', kind: 'final' },
  { id: 'formal-past-2', suffix: '았습니다', label: '-았습니다（过去 + 正式体）', register: 'formal', tense: 'past', kind: 'final' },
  { id: 'formal-past-3', suffix: '였습니다', label: '-였습니다（过去 + 正式体，이다/하다 系）', register: 'formal', tense: 'past', kind: 'final' },
  { id: 'formal-future', suffix: '겠습니다', label: '-겠습니다（意志/推测 + 正式体）', register: 'formal', tense: 'future', kind: 'final' },
  { id: 'formal-honorific', suffix: '십니다', label: '-십니다（敬语 + 正式体）', register: 'formal', tense: 'present', kind: 'final' },
  { id: 'formal-question', suffix: '습니까', label: '-습니까（正式体疑问）', register: 'formal', tense: 'present', kind: 'final' },
  { id: 'formal', suffix: '습니다', label: '-습니다（正式体）', register: 'formal', tense: 'present', kind: 'final' },
  {
    id: 'formal-b',
    suffix: '니다',
    label: '-ㅂ니다（正式体：갑니다 / 합니다）',
    register: 'formal',
    tense: 'present',
    kind: 'final',
  },
  {
    id: 'formal-b-question',
    suffix: '니까',
    // 갑니까（正式疑问）的词干末音一定是 ㅂ；가니까（因为）不是
    when: (stem) => jongseongOf(lastChar(stem)) === JONG_BIEUP,
    label: '-ㅂ니까（正式体疑问）',
    register: 'formal',
    tense: 'present',
    kind: 'final',
  },
  { id: 'copula-formal', suffix: '입니다', label: '입니다（系词 + 正式体）', register: 'formal', tense: 'present', kind: 'final' },
  /**
   * 共动形（청유형）与命令形都属于**正式体**，不是 한다体。
   *
   * 这条漏掉的后果很具体：합시다 落到 -다 上被判成 한다体，
   * 于是一篇通篇 -ㅂ니다 的正式作文被报「两种语体混用」——
   * 用户明明一句口语都没写，却被指语体不一致。
   */
  {
    id: 'formal-propositive',
    suffix: '시다',
    // 합시다 / 갑시다：-ㅂ시다 的词干末音必是 ㅂ；좋으시다（敬语 + 다）不属于这一类
    when: (base) => jongseongOf(lastChar(base)) === JONG_BIEUP,
    label: '-ㅂ시다（正式体共动：합시다 / 갑시다）',
    register: 'formal',
    tense: 'present',
    kind: 'final',
  },
  { id: 'formal-propositive-2', suffix: '읍시다', label: '-읍시다（正式体共动，有收音：먹읍시다）', register: 'formal', tense: 'present', kind: 'final' },
  { id: 'formal-imperative', suffix: '십시오', label: '-십시오（正式体命令）', register: 'formal', tense: 'present', kind: 'final' },

  // ---- 准敬体（해요体）----
  { id: 'polite-past-honorific', suffix: '셨어요', label: '-셨어요（过去 + 敬语 + 해요体）', register: 'polite', tense: 'past', kind: 'final' },
  { id: 'polite-past', suffix: '었어요', label: '-었어요（过去 + 해요体）', register: 'polite', tense: 'past', kind: 'final' },
  { id: 'polite-past-2', suffix: '았어요', label: '-았어요（过去 + 해요体）', register: 'polite', tense: 'past', kind: 'final' },
  { id: 'polite-past-3', suffix: '였어요', label: '-였어요（过去 + 해요体）', register: 'polite', tense: 'past', kind: 'final' },
  { id: 'polite-future', suffix: '겠어요', label: '-겠어요（意志/推测 + 해요体）', register: 'polite', tense: 'future', kind: 'final' },
  { id: 'polite-honorific', suffix: '세요', label: '-세요（敬语命令/请求）', register: 'polite', tense: 'present', kind: 'final' },
  { id: 'copula-polite', suffix: '이에요', label: '이에요（系词 + 해요体，有收音）', register: 'polite', tense: 'present', kind: 'final' },
  { id: 'copula-polite-2', suffix: '예요', label: '예요（系词 + 해요体，无收音）', register: 'polite', tense: 'present', kind: 'final' },
  { id: 'polite', suffix: '어요', label: '-어요（해요体）', register: 'polite', tense: 'present', kind: 'final' },
  { id: 'polite-2', suffix: '아요', label: '-아요（해요体）', register: 'polite', tense: 'present', kind: 'final' },
  { id: 'polite-3', suffix: '여요', label: '-여요（해요体，하다 系）', register: 'polite', tense: 'present', kind: 'final' },
  { id: 'polite-copula', suffix: '에요', label: '에요（系词 + 해요体，口语常与 예요 混）', register: 'polite', tense: 'present', kind: 'final' },

  // ---- 非敬语（해体 / 한다体）----
  { id: 'casual-past', suffix: '었어', label: '-었어（过去 + 해体）', register: 'casual', tense: 'past', kind: 'final' },
  { id: 'casual-past-2', suffix: '았어', label: '-았어（过去 + 해体）', register: 'casual', tense: 'past', kind: 'final' },
  { id: 'casual-past-3', suffix: '였어', label: '-였어（过去 + 해体）', register: 'casual', tense: 'past', kind: 'final' },
  { id: 'written-past', suffix: '었다', label: '-었다（过去 + 한다体，书面）', register: 'written', tense: 'past', kind: 'final' },
  { id: 'written-past-2', suffix: '았다', label: '-았다（过去 + 한다体，书面）', register: 'written', tense: 'past', kind: 'final' },
  { id: 'written-past-3', suffix: '였다', label: '-였다（过去 + 한다体，书面）', register: 'written', tense: 'past', kind: 'final' },
  { id: 'written-future', suffix: '겠다', label: '-겠다（意志/推测 + 한다体）', register: 'written', tense: 'future', kind: 'final' },
  { id: 'written', suffix: '는다', label: '-는다（한다体，书面陈述）', register: 'written', tense: 'present', kind: 'final' },
  { id: 'casual', suffix: '어', label: '-어（해体）', register: 'casual', tense: 'present', kind: 'final' },
  { id: 'casual-2', suffix: '아', label: '-아（해体）', register: 'casual', tense: 'present', kind: 'final' },
  { id: 'written-plain', suffix: '다', label: '-다（한다体）', register: 'written', tense: 'present', kind: 'final' },

  // ---- 连接语尾（不能结句，结句就说明句子没说完）----
  { id: 'conn-but', suffix: '지만', label: '-지만（虽然…）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-because', suffix: '어서', label: '-어서（因为/然后）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-because-2', suffix: '아서', label: '-아서（因为/然后）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-while', suffix: '면서', label: '-면서（一边…一边…）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-if', suffix: '으면', label: '-으면（如果…，有收音）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-and-then', suffix: '고', label: '-고（…之后/并且）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-because-3', suffix: '니까', label: '-니까（因为…，无收音）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-intent', suffix: '려고', label: '-려고（打算…）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-while-2', suffix: '는데', label: '-는데（…但是/铺垫）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-if-2', suffix: '면', label: '-면（如果…，无收音）', register: 'none', tense: 'present', kind: 'connective' },
  { id: 'conn-and', suffix: '서', label: '-서（…然后/因为）', register: 'none', tense: 'present', kind: 'connective' },
];

const ENDINGS_BY_LENGTH = [...ENDING_DEFS].sort((a, b) => b.suffix.length - a.suffix.length);

function matchEnding(word: string): KoEnding | undefined {
  for (const def of ENDINGS_BY_LENGTH) {
    if (!word.endsWith(def.suffix)) continue;
    // 语尾不能吃掉整个词：남기지 않고 「다」单独成词的情况（어미 없는 체언）
    if (word.length <= def.suffix.length) continue;
    /**
     * when 判的是**去掉语尾之后的词干**，不是整词。
     *
     * 这条曾经写错过：传整词给 when，갑니까 的末音是 까（无收音），
     * 「词干末音是 ㅂ」永远不成立，于是 갑니까 / 합니까 双双落到连接语尾 니까，
     * 一个疑问句被判成「句子没说完」。
     */
    const base = word.slice(0, word.length - def.suffix.length);
    if (def.when && !def.when(base)) continue;
    return {
      id: def.id,
      suffix: def.suffix,
      label: def.label,
      register: def.register,
      tense: def.tense,
      kind: def.kind,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 어절 分析结果
// ---------------------------------------------------------------------------

export interface KoEojeol {
  text: string;
  start: number;
  /** 去掉 조사 之后的词干 */
  stem: string;
  particle?: KoParticle;
  auxiliary?: KoParticle;
  ending?: KoEnding;
  /** 冠形语尾（-는/-은/-을/-던），修饰后面的名词 */
  adnominal?: string;
  confidence: 'high' | 'guess';
  /** 粗粒度词性：体言 / 用言 / 修饰语 / 接续 / 独立 */
  pos: '체언' | '용언' | '수식언' | '접속언' | '독립언';
  /** 语体与语尾（仅谓语）*/
  register?: KoRegister;
}

const ADVERBS = new Set([
  '아주', '매우', '정말', '너무', '많이', '잘', '다시', '빨리', '함께', '먼저', '특히', '조금', '아직',
  '벌써', '이미', '항상', '자주', '가끔', '열심히', '천천히', '그냥', '꼭', '또', '더', '가장', '모두',
]);

const CONJUNCTIONS = new Set(['그리고', '하지만', '그러나', '그래서', '그러면', '그런데', '또는', '즉', '왜냐하면']);

const INTERJECTIONS = new Set(['네', '예', '아니요', '아니', '감사합니다', '안녕하세요', '음', '어']);

/**
 * 冠形节的词干表（常用用言，约 60 条）。
 *
 * 为什么需要这张表：는/은 既是主题助词，也是冠形语尾。
 * 「학교는 서울에 있어요」和「먹는 사람」的表面结构一模一样，
 * 只看局部信息分不开。默认按主题助词处理（更常见），只有词干在这张表里
 * 才认成冠形节。
 *
 * 表外的用言不猜 —— 宁可少标一层修饰，也不把一个主题助词讲成冠形节：
 * 讲错语法比少讲一层语法糟得多。
 */
const COMMON_PREDICATE_STEMS = new Set([
  '가', '오', '보', '먹', '마시', '자', '읽', '쓰', '듣', '말하', '하', '되', '있', '없',
  '좋', '싫', '많', '적', '크', '작', '높', '낮', '예쁘', '아름답', '어렵', '쉽', '바쁘', '아프',
  '살', '만들', '사', '팔', '배우', '가르치', '일하', '공부하', '시작하', '끝나', '끝내', '만나',
  '기다리', '걷', '뛰', '웃', '울', '알', '모르', '원하', '생각하', '느끼', '나', '들', '주', '받',
  '타', '내리', '좋아하', '싫어하', '찾', '잃', '열', '닫', '씻', '입', '벗', '앉', '일어나', '서',
]);

/** 冠形语尾：必须能认出「这个词干后面接的是名词」 */
const ADNOMINAL_RE = /(던|을|은|는)$/;

/** 终声 ㄴ 的序号；산 = 사 + ㄴ 是收缩形过去冠形节 */
const JONG_NIEUN = 4;

/** 单位名词：한 명 / 두 개 里的「한」是数词，不是「하 + ㄴ」的冠形节 */
const UNIT_NOUNS = new Set([
  '명', '분', '개', '마리', '권', '대', '장', '잔', '병', '그루', '시', '시간', '년', '월', '일', '번', '층', '살',
]);

/** 去掉收音，还原出「ㄴ 之前」的词干音节：산 → 사 */
function stripFinalConsonant(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const jong = jongseongOf(char);
  if (code < HANGUL_START || jong <= 0) return char;
  return String.fromCodePoint(code - jong);
}

/**
 * 分析一段韩语文本，返回 어절 序列。
 *
 * 冠形节与主题助词要靠**下一个 어절**才分得开（먹는 사람 vs 학교는 서울），
 * 所以这里必须先切完所有 어절、拿到下一个，再回头判定。
 */
export function analyzeKo(text: string): KoEojeol[] {
  const raws = splitEojeol(text);

  /** 这个 어절 是不是名词性成分：去掉助词后没有语尾 */
  const nounish = (value: string): boolean => {
    if (ADVERBS.has(value) || CONJUNCTIONS.has(value) || INTERJECTIONS.has(value)) return false;
    const split = splitParticle(value);
    return !matchEnding(split.stem);
  };

  return raws.map((raw, index) => {
    const next = raws[index + 1];
    /**
     * 整词先试语尾，再试助词。
     *
     * 顺序很重要：않았어요 结尾的「요」既是补助词也是语尾的一部分，
     * 先剥助词会把 어요 拆成 어 + 요，语体与时制就全错了。
     * 但整词匹配只认「够长的语尾」或「单音节词干 + 单字语尾」——
     * 否则 한국어（名词，尾音 어）会被当成动词的 해体。
     */
    const direct = matchEnding(raw.text);
    const directStrong = Boolean(direct && (direct.suffix.length >= 2 || raw.text.length === direct.suffix.length + 1));
    const split = directStrong ? { stem: raw.text.slice(0, raw.text.length - (direct as KoEnding).suffix.length), confidence: 'high' as const } : splitParticle(raw.text);

    const adnomMatch = raw.text.match(ADNOMINAL_RE);
    const stripped = adnomMatch ? raw.text.slice(0, raw.text.length - adnomMatch[1].length) : '';
    const adnominalOk = Boolean(
      adnomMatch &&
        stripped &&
        next &&
        nounish(next.text) &&
        // -을/-던 后面接名词基本只能是冠形节（名词 + 을 + 名词 不成句）；
        // -는/-은 要与主题助词区分，词干必须在常用用言表里
        (adnomMatch[1] === '을' || adnomMatch[1] === '던' || COMMON_PREDICATE_STEMS.has(stripped)),
    );

    /**
     * 收缩形冠形节：내가 어제 산 책 / 내가 한 일。
     * -ㄴ 是「-은」的收缩，字形上和名词（산 山、한 一）撞。
     * 只认「单音节 + ㄴ 收音 + 还原后是常用用言词干 + 后面不是单位名词」，
     * 表外与单位名词一律按名词处理 —— 산 정상 会被误看成冠形节，这是这条规则的已知代价。
     */
    const contractedOk = Boolean(
      raw.text.length === 1 &&
        jongseongOf(raw.text) === JONG_NIEUN &&
        next &&
        nounish(next.text) &&
        !UNIT_NOUNS.has(next.text) &&
        COMMON_PREDICATE_STEMS.has(stripFinalConsonant(raw.text)),
    );
    const contractedStem = contractedOk ? stripFinalConsonant(raw.text) : undefined;

    const stem = adnominalOk ? stripped : contractedOk ? (contractedStem as string) : split.stem;
    // 有助词就不可能是谓语：名词 + 은/는/이/가/을/를 后面不接语尾
    const hasParticle = Boolean('particle' in split && (split.particle || split.auxiliary));
    const rawEnding = adnominalOk ? undefined : directStrong ? (direct as KoEnding) : hasParticle ? undefined : matchEnding(stem);

    /**
     * 「-어 / -아」在句中几乎都是连接语尾（풀어 주다 / 먹어 보다），
     * 只有落在句末才是终结语尾。分不清这两者，整段会被误判成「합니다体与해体混用」——
     * 一个只写了正式体的作文被报语体混用，用户会认为系统根本没读。
     */
    const sentenceEnd = !text.slice(raw.end, raw.end + 1) || /[.!?。！？\n]/.test(text.slice(raw.end, raw.end + 1));
    const ending =
      rawEnding &&
      (rawEnding.id === 'casual' || rawEnding.id === 'casual-2') &&
      !sentenceEnd
        ? { ...rawEnding, kind: 'connective' as const, register: 'none' as const, label: `${rawEnding.label}（此处为连接语尾）` }
        : rawEnding;

    let pos: KoEojeol['pos'] = '체언';
    if (ending || adnominalOk || contractedOk) pos = '용언';
    else if (ADVERBS.has(stem)) pos = '수식언';
    else if (CONJUNCTIONS.has(stem)) pos = '접속언';
    else if (INTERJECTIONS.has(raw.text)) pos = '독립언';

    return {
      text: raw.text,
      start: raw.start,
      stem,
      particle: adnominalOk ? undefined : 'particle' in split ? split.particle : undefined,
      auxiliary: adnominalOk ? undefined : 'auxiliary' in split ? split.auxiliary : undefined,
      ending,
      adnominal: adnominalOk ? adnomMatch?.[1] : contractedOk ? 'ㄴ' : undefined,
      confidence: split.confidence,
      pos,
      register: ending && ending.register !== 'none' ? ending.register : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// 音节数：韩语的「说了多少」
//
// 日语的单位是モーラ，韩语的单位是**音节**：一个字一个音节，收音不独立成拍。
// 语速用音节/分发问，比用「어절/分」稳得多 —— 어절 长度差异太大，
// 「학교에」和「갔습니다」都算一个 어절，语速会被词长带偏。
// ---------------------------------------------------------------------------

export function koSyllableCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (isHangulSyllable(char)) count += 1;
    // 数字与拉丁词按半个音节估：韩语里它们读作 한글 音，具体几拍看读法
    else if (/[A-Za-z0-9]/.test(char)) count += 0.5;
  }
  return Math.round(count);
}

// ---------------------------------------------------------------------------
// TokenizerPort
// ---------------------------------------------------------------------------

export function koTokens(eojeol: KoEojeol[]): LangToken[] {
  const out: LangToken[] = [];
  for (const item of eojeol) {
    out.push({
      surface: item.stem,
      base: item.stem,
      pos: item.pos,
      start: item.start,
      end: item.start + item.stem.length,
    });
    const trailing = item.particle ?? item.auxiliary;
    if (trailing) {
      const offset = item.start + item.stem.length;
      out.push({
        surface: trailing.surface,
        base: trailing.surface,
        pos: '조사',
        start: offset,
        end: offset + trailing.surface.length,
      });
    }
  }
  return out;
}

export const koTokenizer: TokenizerPort = {
  lang: 'ko',
  async tokenize(text) {
    return koTokens(analyzeKo(text));
  },
  async lemmatize(token) {
    // 韩语的原形是「-다」形：먹었어요 → 먹다。还原需要形态分析，这里只做诚实的降级：
    // 能判出语尾就从词干加 다，判不出就返回原样（返回原样比编一个原形好）
    const [first] = analyzeKo(token.surface);
    if (!first) return token.surface;
    if (first.particle ? false : Boolean(first.ending)) return `${first.stem}다`;
    return token.surface;
  },
};

// ---------------------------------------------------------------------------
// 句法：어절 + 조사 → 成分角色
// ---------------------------------------------------------------------------

function particleLabel(item: KoEojeol): string | undefined {
  return (item.auxiliary ?? item.particle)?.label;
}

function roleOf(item: KoEojeol, index: number, predicateIndex: number): SyntaxNode['role'] {
  const aux = item.auxiliary;
  const particle = item.particle;

  if (aux && (aux.surface === '은' || aux.surface === '는')) return 'subject';
  if (particle?.caseType === 'subj') return 'subject';
  if (particle?.caseType === 'obj') return 'object';
  if (particle) return 'modifier';
  // 도 多半也是主语（학생도 갑니다）；만/까지/부터/뿐 只是限定，按修饰语呈现
  if (aux) return aux.surface === '도' ? 'subject' : 'modifier';
  if (item.pos === '수식언' || item.pos === '접속언' || item.pos === '독립언') return 'modifier';
  if (item.adnominal) return 'clause';
  if (item.ending?.kind === 'connective') return 'clause';
  if (index === predicateIndex) return 'predicate';
  if (item.ending?.kind === 'final') return 'predicate';
  if (item.ending?.kind === 'adnominal') return 'clause';
  return 'other';
}

function findPredicate(eojeol: KoEojeol[]): number {
  for (let i = eojeol.length - 1; i >= 0; i -= 1) {
    if (eojeol[i].ending?.kind === 'final') return i;
  }
  return eojeol.length - 1;
}

const REGISTER_LABEL: Record<KoRegister, string> = {
  formal: '합니다体（正式）',
  polite: '해요体（准敬）',
  casual: '해体（非敬语）',
  written: '한다体（书面）',
};

const TENSE_LABEL = { past: '过去', present: '现在/非过去', future: '将来·推测' } as const;

function predicateNote(item: KoEojeol): string {
  const parts: string[] = [`谓语在句末：「${item.text}」`];
  if (item.ending) {
    parts.push(`${item.ending.label}，${TENSE_LABEL[item.ending.tense]}`);
    if (item.ending.register !== 'none') parts.push(`语体是 ${REGISTER_LABEL[item.ending.register]}`);
  }
  return `${parts.join('；')}。`;
}

function eojeolNode(item: KoEojeol, role: SyntaxNode['role'], id: string, extra: string, children: SyntaxNode[] = []): SyntaxNode {
  const notes: string[] = [];
  if (role === 'predicate') notes.push(predicateNote(item));
  else {
    const label = particleLabel(item);
    if (label) notes.push(label);
    if (item.adnominal) {
      notes.push(`冠形语尾「-${item.adnominal}」：它修饰后面的名词，位置必须在名词前面，不能挪走。`);
    }
  }
  if (extra) notes.push(extra);

  return {
    id,
    role,
    text: item.text,
    note: notes.length > 0 ? notes.join('') : undefined,
    children,
  };
}

function eojeolDifficulty(eojeol: KoEojeol[], nested: number): number {
  const size = eojeol.length;
  let score = size <= 3 ? 0 : size <= 5 ? 1.5 : size <= 8 ? 3 : 4.5;
  if (nested > 0) score += Math.min(2, nested);
  if (eojeol.some((item) => item.ending?.id.startsWith('formal-past') || item.ending?.id.startsWith('written'))) score += 1;
  if (eojeol.some((item) => item.ending?.kind === 'connective')) score += 1;
  if (eojeol.some((item) => item.auxiliary?.surface === '께서' || item.auxiliary?.surface === '께')) score += 1;
  const longWords = eojeol.filter((item) => item.stem.length >= 4).length;
  if (eojeol.length > 0 && longWords / eojeol.length > 0.4) score += 1;
  return Math.min(10, score);
}

function eojeolSummary(eojeol: KoEojeol[], roles: SyntaxNode['role'][]): string {
  const pick = (role: SyntaxNode['role']) => eojeol.filter((_, i) => roles[i] === role).map((item) => `「${item.text}」`);
  const parts = [`共 ${eojeol.length} 个 어절`];
  const predicates = pick('predicate');
  const subjects = pick('subject');
  const objects = pick('object');
  if (predicates.length > 0) parts.push(`谓语${predicates.join('、')}在句末`);
  if (subjects.length > 0) parts.push(`${subjects.join('、')}是主语／主题`);
  if (objects.length > 0) parts.push(`${objects.join('、')}是宾语`);

  const tail =
    '先找句末谓语，再用 은/는·이/가 定主语，剩下的 을/를·에/에서 都是它的补语。' +
    '中文靠语序定成分，韩语靠助词定 —— 助词换了，句子成分就换了。';
  return `${parts.join('；')}。${tail}`;
}

export function createKoSyntax(llm: LlmPort | null = null): SyntaxPort {
  return {
    lang: 'ko',
    async parse(text) {
      const eojeol = analyzeKo(text);
      if (eojeol.length === 0) {
        return { nodes: [], summary: '没有可分析的韩语内容。', difficulty: 0 };
      }

      const predicateIndex = findPredicate(eojeol);
      const roles = eojeol.map((item, index) => roleOf(item, index, predicateIndex));
      const nodes: SyntaxNode[] = [];
      let seq = 0;
      let nested = 0;

      for (let i = 0; i < eojeol.length; i += 1) {
        seq += 1;
        const item = eojeol[i];
        const next = eojeol[i + 1];

        // 冠形节并进后面的名词：내가 어제 산 책 拆成 主语「내가」+「책」+ 子节点「산」
        if (item.adnominal && next) {
          const child = eojeolNode(item, 'clause', `n${seq}.1`, '');
          nodes.push(eojeolNode(next, roles[i + 1], `n${seq + 1}`, '这个名词被前面的冠形节限定。', [child]));
          nested += 1;
          i += 1;
          seq += 1;
          continue;
        }

        const trailing = i > predicateIndex && roles[i] !== 'predicate';
        const extra = trailing ? '它排在谓语之后 —— 韩语谓语通常固定在句末，补语应移到谓语前面。' : '';
        nodes.push(eojeolNode(item, roles[i], `n${seq}`, extra));
      }

      return {
        nodes,
        summary: eojeolSummary(eojeol, roles),
        difficulty: Number(eojeolDifficulty(eojeol, nested).toFixed(1)),
      };
    },

    async contrast(text) {
      const eojeol = analyzeKo(text);
      const particles = new Set(
        eojeol.flatMap((item) => [item.particle?.surface, item.auxiliary?.surface]).filter((value): value is string => Boolean(value)),
      );
      const points: Array<{ point: string; note: string }> = [];

      if (eojeol.length >= 2) {
        points.push({
          point: '语序：中文 SVO，韩语 SOV',
          note: '中文「我 吃 饭」，韩语「저는 밥을 먹어요」—— 谓语在最后，宾语靠「을/를」标，不靠位置。',
        });
      }
      if (particles.has('은') || particles.has('는') || particles.has('이') || particles.has('가')) {
        points.push({
          point: '은/는 与 이/가 不是「主语」的两种说法',
          note: '은/는 提示主题（已知信息、对比），이/가 标记主语（新信息、焦点）。中文没有这个区分，所以容易被一律用成 은/는。',
        });
      }
      if (particles.has('을') || particles.has('를')) {
        points.push({
          point: '을/를 只接他动词',
          note: '中文「门开了/我开门门」对应「문이 열렸어요」/「문을 열었어요」—— 换动词时助词也得跟着换。',
        });
      }
      if (eojeol.some((item) => item.ending?.register === 'formal') && eojeol.some((item) => item.ending?.register === 'polite')) {
        points.push({
          point: '합니다体与해요体是两套语法',
          note: '正式场合/书面用 -ㅂ니다，日常对话用 -아/어요；中文没有形态敬语，容易一篇里两套混用。',
        });
      }
      if (text.includes('받침') || /[가-힣]/.test(text)) {
        points.push({
          point: '收音（받침）是中文母语者的第一关',
          note: '中文音节没有韵尾辅音，한국어의 ㄱ/ㄴ/ㄹ/ㅁ/ㅂ 收音容易被吞掉；连音（연음）与紧音化（경음화）都是从这儿派生的。',
        });
      }

      // 模型侧：补规则说不出的迁移点（失败就当没有，不影响上面这些）
      if (llm) {
        try {
          const { data } = await llm.json({
            system: [
              '你是对比语言学老师，服务对象是中文母语者，教韩语。只输出 JSON。',
              '任务：指出这句话里中文母语者最容易受母语干扰的地方（语序、助词 은/는·이/가、敬语层级、时制、冠形节、汉字词）。',
              '每条 point 一句话要点，note 说明「中文怎样 → 韩语为什么不同」，不超过 40 字。',
              '没有明显迁移点就返回空数组，不要凑数。',
            ].join('\n'),
            user: `句子：\n${text}`,
            schema: z.object({
              points: z.array(z.object({ point: z.string(), note: z.string() })).default([]),
            }),
            maxTokens: 600,
            temperature: 0.3,
            tag: 'gra.contrast.ko',
          });
          for (const item of data.points) {
            if (!points.some((exist) => exist.point === item.point)) points.push(item);
          }
        } catch {
          // 模型侧是加分项，失败就只返回规则侧结论
        }
      }

      return points.slice(0, 6);
    },
  };
}

// ---------------------------------------------------------------------------
// 错误体系：确定性扫描，高精度低召回
// ---------------------------------------------------------------------------

export interface KoRuleError {
  ruleId: string;
  quote: string;
  problem: string;
  suggestion: string;
  severity: 'must-fix' | 'should-fix' | 'style';
}

function pushError(list: KoRuleError[], item: KoRuleError): void {
  if (!item.quote.trim()) return;
  if (list.some((exist) => exist.ruleId === item.ruleId && exist.quote === item.quote)) return;
  list.push(item);
}

/** 助词连用的字形配对：前面名词有没有收音决定用哪个 */
const PAIR_RULES: Array<{
  particle: string;
  /** 该助词出现在「前面无收音」时是错的，应换成 pair */
  wrongWhen: 'no-batchim' | 'batchim';
  pair: string;
}> = [
  { particle: '이', wrongWhen: 'no-batchim', pair: '가' },
  { particle: '가', wrongWhen: 'batchim', pair: '이' },
  { particle: '을', wrongWhen: 'no-batchim', pair: '를' },
  { particle: '를', wrongWhen: 'batchim', pair: '을' },
  { particle: '은', wrongWhen: 'no-batchim', pair: '는' },
  { particle: '는', wrongWhen: 'batchim', pair: '은' },
  { particle: '와', wrongWhen: 'batchim', pair: '과' },
  { particle: '과', wrongWhen: 'no-batchim', pair: '와' },
];

/** 저가/나가/너가 是常见错形，正确是 제가/내가/네가（不规则变化，不能按收音规则推） */
const PRONOUN_SUBJECT_FIX: Record<string, string> = {
  저: '제가',
  나: '내가',
  너: '네가',
};

const PAST_ADVERBS = new Set(['어제', '그제', '엊그제', '지난주', '지난달', '작년', '아까', '방금', '이미', '벌써']);

const TIME_UNIT_RE = /^(\d{1,2}시|\d{1,2}월|\d{1,2}일|아침|점심|저녁|밤|오늘|내일|어제)$/;

const MOVEMENT_VERBS = new Set(['가다', '오다', '도착하다', '돌아가다', '출발하다', '떠나다']);

const PERSON_NOUNS = new Set(['사람', '친구', '학생', '선생님', '동생', '언니', '오빠', '누나', '형', '아이', '부모님', '손님', '직원']);

const ANIMAL_NOUNS = new Set(['고양이', '강아지', '개', '새', '물고기', '말', '소', '토끼']);

const NUMBER_WORDS = new Set(['한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십']);

const WRONG_UNIT_FOR_PERSON = new Set(['개', '마리', '권', '대', '장', '잔', '병', '그루']);

/** 这些错形是固定的，直接查表 —— 韩语맞춤법 的经典错误就那么几个 */
const ORTHOGRAPHY_FIX: Array<{ pattern: RegExp; problem: string; fix: (matched: string) => string }> = [
  {
    pattern: /됬/g,
    problem: '「됬」是错字：「되다」的过去式是 됐（되었 的缩写），没有 됬 这个字',
    fix: () => '됐',
  },
  {
    // 않 是词干，必须接语尾（않다/않은/않는/않고）；单独成词再接动词，一定是把副词 안 写成了 않
    pattern: /(?<=^|\s)않(?=\s|$)/g,
    problem: '「않」是「아니하다」的词干，不能单独成词；这里是「不…」的副词「안」',
    fix: () => '안',
  },
  {
    pattern: /않(?=\s*(되|하|한|해|할|했))/g,
    problem: '「않」后面直接接动词是错的：副词「안」才是「不…」',
    fix: () => '안',
  },
  {
    pattern: /몇일/g,
    problem: '「몇일」是错写，正确是「며칠」（这是韩语里少数不按原形拼的词）',
    fix: () => '며칠',
  },
  {
    pattern: /웬지/g,
    problem: '「웬지」是错写，正确是「왠지」（왜인지 的缩写）',
    fix: () => '왠지',
  },
  {
    pattern: /오랫만/g,
    problem: '「오랫만」是错写，正确是「오랜만」（오래간만 的缩写）',
    fix: () => '오랜만',
  },
  {
    pattern: /금새/g,
    problem: '「금새」是错写，正确是「금세」（금시에 的缩写）',
    fix: () => '금세',
  },
  {
    pattern: /역활/g,
    problem: '「역활」是错写，正确是「역할」（汉字词 役割）',
    fix: () => '역할',
  },
  {
    pattern: /(할|갈|올|볼|줄|살|먹을|마실|드릴)께요/g,
    problem: '「-ㄹ께요」是错写：意志/约定用「-ㄹ게요」，ㄲ 只出现在「-(으)ㄹ까요」（疑问）里',
    fix: (matched) => matched.replace('께요', '게요'),
  },
  {
    pattern: /설겆이/g,
    problem: '「설겆이」是错写，正确是「설거지」',
    fix: () => '설거지',
  },
  {
    pattern: /희안/g,
    problem: '「희안」是错写，正确是「희한」（罕见）',
    fix: () => '희한',
  },
];

/** 띄어쓰기：只报几乎不会误判的几类。fix 要拿到捕获组，所以签名带可变参数 */
const SPACING_FIX: Array<{ pattern: RegExp; problem: string; fix: (matched: string, ...groups: string[]) => string }> = [
  {
    pattern: /([가-힣])수\s*(있|없)/g,
    problem: '「수 있다/없다」的「수」是依存名词，前后都要隔写',
    fix: (matched, before: string, verb: string) => `${before} 수 ${verb}`,
  },
  {
    pattern: /([가-힣])것\s*같/g,
    problem: '「것 같다」的「것」是依存名词，要与前面隔写',
    fix: (matched, before: string) => `${before} 것 같`,
  },
  {
    pattern: /([가-힣])때문에/g,
    problem: '「때문에」是依存名词 + 助词，要与前面隔写',
    fix: (matched, before: string) => `${before} 때문에`,
  },
];

export function scanKorean(text: string): KoRuleError[] {
  const out: KoRuleError[] = [];
  const eojeol = analyzeKo(text);

  // ---- 助词选择：前面名词有无收音决定的字形，是韩语最硬的一条规则 ----
  for (const item of eojeol) {
    // guess 的切分（两字 어절）不参与判错：하나/사과/종이 会被误切，宁可漏
    if (item.confidence !== 'high') continue;
    // 은/는 是补助词（topic），不在 particle 里 —— 字形规则必须把两者都算上
    const particle = item.particle ?? item.auxiliary;
    if (!particle || item.stem.length === 0) continue;

    const stemLast = lastChar(item.stem);

    // 저가/나가/너가：不规则，单独处理
    if (particle.surface === '가' && PRONOUN_SUBJECT_FIX[item.stem]) {
      pushError(out, {
        ruleId: 'particle',
        quote: item.text,
        problem: `「${item.stem}가」是错形：${item.stem} + 가 会发生不规则变化`,
        suggestion: PRONOUN_SUBJECT_FIX[item.stem],
        severity: 'must-fix',
      });
      continue;
    }

    for (const rule of PAIR_RULES) {
      if (particle.surface !== rule.particle) continue;
      const batchim = hasBatchim(stemLast);
      const wrong = rule.wrongWhen === 'batchim' ? batchim : !batchim;
      if (!wrong) continue;
      // ㄹ 收音可以接 로（서울로），这是规则内的例外，不是错
      if (rule.particle === '로' && jongseongOf(stemLast) === JONG_RIEUL) continue;
      pushError(out, {
        ruleId: 'particle',
        quote: item.text,
        problem: `「${item.stem}」${hasBatchim(stemLast) ? '有' : '没有'}收音，不能用「${rule.particle}」—— 助词的字形由前面名词的收音决定`,
        suggestion: item.stem + rule.pair,
        severity: 'must-fix',
      });
      break;
    }

    // 로/으로：有收音（ㄹ 除外）必须用 으로
    if (particle.surface === '로') {
      const jong = jongseongOf(stemLast);
      if (jong > 0 && jong !== JONG_RIEUL) {
        pushError(out, {
          ruleId: 'particle',
          quote: item.text,
          problem: '「로」只能接无收音或 ㄹ 收音的名词；有收音时要用「으로」',
          suggestion: `${item.stem}으로`,
          severity: 'must-fix',
        });
      }
    }
    if (particle.surface === '으로') {
      const jong = jongseongOf(stemLast);
      if (jong === 0) {
        pushError(out, {
          ruleId: 'particle',
          quote: item.text,
          problem: '「으로」用在有收音的名词后；无收音（或只剩 ㄹ）时要用「로」',
          suggestion: `${item.stem}로`,
          severity: 'must-fix',
        });
      }
    }

    // 时间点 + 에서 + 移动动词：에서 是「动作发生的场」，不是「到达点」
    if (particle.surface === '에서' && TIME_UNIT_RE.test(item.stem)) {
      pushError(out, {
        ruleId: 'particle',
        quote: item.text,
        problem: '时间点后面用「에」，不用「에서」（에서 表示动作发生的场所或起点）',
        suggestion: `${item.stem}에`,
        severity: 'must-fix',
      });
    }
  }

  // ---- 时制：过去时间词 + 现在时谓语 ----
  const pastAdverb = eojeol.find((item) => PAST_ADVERBS.has(item.stem));
  const predicate = [...eojeol].reverse().find((item) => item.ending?.kind === 'final');
  if (pastAdverb && predicate?.ending && predicate.ending.tense === 'present') {
    pushError(out, {
      // 引用**谓语本身**：原来截原文前 60 字，高亮的是段落开头，跟这处错误没关系
      quote: predicate.text,
      ruleId: 'tense',
      problem: `句中有过去时间词「${pastAdverb.text}」，句末谓语「${predicate.text}」却是现在时（${predicate.ending.label}）`,
      suggestion: '把谓语改成过去形：-았/었습니다（正式体）或 -았/었어요（해요体）',
      severity: 'should-fix',
    });
  }

  // ---- 语体：합니다体 / 해요体 / 해体 混用 ----
  const tagged = eojeol.filter((item) => Boolean(item.register)) as Array<KoEojeol & { register: KoRegister }>;
  if (tagged.length >= 2) {
    // 以出现最多的语体为基准，指出**第一个偏离基准的 어절** ——
    // 原来引用原文前 60 字并列出两种语体，用户看不出到底哪一句切了语体
    const counts = new Map<KoRegister, number>();
    for (const item of tagged) counts.set(item.register, (counts.get(item.register) ?? 0) + 1);
    const [baseline] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const deviant = tagged.find((item) => item.register !== baseline);
    if (deviant) {
      pushError(out, {
        ruleId: 'register',
        quote: deviant.text,
        problem:
          `全段以 ${REGISTER_LABEL[baseline]} 为主，「${deviant.text}」却切成了 ${REGISTER_LABEL[deviant.register]} —— ` +
          '韩语的语体是硬语法，混用会被听成「不知道在跟谁说话」',
        suggestion: '统一成一种：对外人用 -ㅂ니다 / -아요，对朋友用 -아/어，写报告用 -다',
        severity: 'style',
      });
    }
  }

  // ---- 敬语：께서 后面必须接 드시다/잡수시다 这类尊敬动词 ----
  const hasHonorificSubject = eojeol.some((item) => item.particle?.surface === '께서');
  if (hasHonorificSubject) {
    const hasHonorificVerb = eojeol.some((item) => /드시|잡수|주무시|계시|하시|가시|오시/.test(item.stem));
    const plainVerb = eojeol.find((item) => /^(먹|자|마시|있|없)/.test(item.stem) && item.ending);
    if (!hasHonorificVerb && plainVerb) {
      pushError(out, {
        ruleId: 'honorific',
        quote: plainVerb.text,
        problem: '主语用了「께서」（尊敬），谓语却是普通动词 —— 尊敬要同时落在主语助词和动词上',
        suggestion: '换成尊敬动词：먹다→드시다/잡수시다，자다→주무시다，있다→계시다',
        severity: 'must-fix',
      });
    }
  }

  // ---- 单位名词：人数不能用 개/마리 ----
  for (let i = 0; i < eojeol.length; i += 1) {
    const unit = eojeol[i];
    if (!WRONG_UNIT_FOR_PERSON.has(unit.stem)) continue;
    const number = eojeol[i - 1];
    if (!number || !NUMBER_WORDS.has(number.stem)) continue;
    // 名词本身可能带助词（친구가 두 개），stem 已经把助词剥掉了
    const noun = eojeol[i - 2];
    if (!noun) continue;
    if (PERSON_NOUNS.has(noun.stem)) {
      pushError(out, {
        ruleId: 'counter',
        quote: `${noun.stem} ${number.stem} ${unit.stem}`,
        problem: '数人要用「명」（口语尊敬用「분」），不能用 개/마리/권/대',
        suggestion: `${noun.stem} ${number.stem} 명`,
        severity: 'should-fix',
      });
    } else if (ANIMAL_NOUNS.has(noun.stem) && unit.stem !== '마리') {
      pushError(out, {
        ruleId: 'counter',
        quote: `${noun.stem} ${number.stem} ${unit.stem}`,
        problem: '数动物要用「마리」',
        suggestion: `${noun.stem} ${number.stem} 마리`,
        severity: 'should-fix',
      });
    }
  }

  // ---- 语序：谓语后面还剩带格助词的补语 ----
  // 从后往前找：多句文本里，第一句的谓语后面当然还有东西，那不是语序错误
  let predicateIndex = -1;
  for (let i = eojeol.length - 1; i >= 0; i -= 1) {
    if (eojeol[i].ending?.kind === 'final') {
      predicateIndex = i;
      break;
    }
  }
  if (predicateIndex >= 0 && predicateIndex < eojeol.length - 1) {
    const trailing = eojeol
      .slice(predicateIndex + 1)
      .find((item) => item.particle && (item.particle.caseType === 'obj' || item.particle.caseType === 'loc'));
    if (trailing) {
      pushError(out, {
        ruleId: 'word-order',
        quote: `${eojeol[predicateIndex].text} … ${trailing.text}`,
        problem: '谓语后面又出现了带格助词的补语 —— 韩语的谓语固定在句末',
        suggestion: '把补语移到谓语前面：저는 밥을 먹었어요（不是 저는 먹었어요 밥을）',
        severity: 'style',
      });
    }
  }

  // ---- 맞춤법 与 띄어쓰기：文本级正则，命中即确定 ----
  for (const rule of ORTHOGRAPHY_FIX) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null = re.exec(text);
    while (match) {
      pushError(out, {
        ruleId: 'orthography',
        quote: match[0],
        problem: rule.problem,
        suggestion: rule.fix(match[0]),
        severity: 'must-fix',
      });
      if (match.index === re.lastIndex) re.lastIndex += 1;
      match = re.exec(text);
    }
  }

  for (const rule of SPACING_FIX) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null = re.exec(text);
    while (match) {
      pushError(out, {
        ruleId: 'spacing',
        quote: match[0],
        problem: rule.problem,
        // 捕获组要一起传：수 있다 的修正同时要用到前面的词与后面的动词
        suggestion: rule.fix(match[0], ...match.slice(1)),
        severity: 'should-fix',
      });
      if (match.index === re.lastIndex) re.lastIndex += 1;
      match = re.exec(text);
    }
  }

  return out;
}

export const koTaxonomy: ErrorTaxonomyPort = {
  lang: 'ko',
  async scan(text) {
    return scanKorean(text);
  },
  ruleIds() {
    return [
      'particle',
      'ending',
      'register',
      'honorific',
      'spacing',
      'tense',
      'counter',
      'orthography',
      'word-order',
      'sino-korean',
      'translationese',
    ];
  },
};

// ---------------------------------------------------------------------------
// 等级：TOPIK 六档
// ---------------------------------------------------------------------------

const TOPIK_BANDS = ['1급', '2급', '3급', '4급', '5급', '6급'];

/** 跨刻度换算：6급 接近能读专业材料，1급 是入门 */
const TOPIK_COMMON: Record<string, number> = { '1급': 10, '2급': 26, '3급': 44, '4급': 62, '5급': 79, '6급': 93 };

export const koLevel: LevelScalePort = {
  lang: 'ko',
  scale: 'topik',
  bands: TOPIK_BANDS,
  async estimateTextLevel(text) {
    const eojeol = analyzeKo(text);
    const sentences = Math.max(1, (text.match(/[.!?。！？]/g) ?? []).length);
    const avgSentence = eojeol.length / sentences;

    // 어절 平均音节数：初级句子的 어절 短（저는 / 학생 / 입니다），
    // 中高级开始出现 4 音节以上的汉字词（경제성장 / 구조적인）
    const totalSyllables = eojeol.reduce((sum, item) => sum + koSyllableCount(item.stem), 0);
    const avgSyllables = eojeol.length > 0 ? totalSyllables / eojeol.length : 0;

    const connectives = new Set(
      eojeol.map((item) => item.ending?.id).filter((id): id is string => Boolean(id && id.startsWith('conn'))),
    );
    const formalEndings = eojeol.filter((item) => item.register === 'formal' || item.register === 'written').length;
    // 长 어절（≥4 音节）占比是「汉字词密度」的代理：경제성장 / 구조적인 / 직면하다
    // 初级句子几乎全是 1–2 音节 어절，中高级开始出现成片的长汉字词。
    const longRatio = eojeol.length > 0 ? eojeol.filter((item) => koSyllableCount(item.stem) >= 4).length / eojeol.length : 0;

    let score = 0;
    if (avgSentence >= 12) score += 4;
    else if (avgSentence >= 8) score += 3;
    else if (avgSentence >= 6) score += 2;
    else if (avgSentence >= 4) score += 1;

    if (avgSyllables >= 3.6) score += 2;
    else if (avgSyllables >= 3.0) score += 1;

    if (longRatio >= 0.28) score += 3;
    else if (longRatio >= 0.14) score += 1;

    if (connectives.size >= 3) score += 2;
    else if (connectives.size >= 1) score += 1;

    if (formalEndings >= 2) score += 1;
    // 한다体只在书面语出现：一到这一段，说明不是口语记录
    if (eojeol.some((item) => item.register === 'written')) score += 1;

    const band = score >= 8 ? '6급' : score >= 6 ? '5급' : score >= 4 ? '4급' : score >= 2 ? '3급' : '2급';

    // 覆盖率代理：短 어절（≤2 音节）占比越高，越可能停在基础词上。
    // 真正的 TOPIK 词表覆盖要等词库接进来，接口不动。
    const short = eojeol.filter((item) => koSyllableCount(item.stem) <= 2).length;
    const vocabCoverage = eojeol.length > 0 ? Number((short / eojeol.length).toFixed(3)) : 0;

    return { band: score >= 1 ? band : '1급', vocabCoverage, avgSentence: Number(avgSentence.toFixed(1)) };
  },
  toCommonScore(band) {
    return TOPIK_COMMON[band] ?? 0;
  },
};

// ---------------------------------------------------------------------------
// 音韵：音节节奏 + 语调
// ---------------------------------------------------------------------------

/**
 * 韩语的语速单位是**音节/分**。
 *
 * 参照值：新闻播报约 330–380 音节/分（초당 5.5–6.3 음절），
 * 한국어 교재 낭독 约 280–330，学习者自然对话常在 180–260。
 * 低于 240 是明显偏慢（边想语尾边说），高于 380 基本在赶。
 *
 * 停顿期望值用标点：韩语朗读的换气点就在 쉼표（,）和句末。
 */
const SYLLABLE_PER_MIN_MIN = 240;
const SYLLABLE_PER_MIN_MAX = 380;

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const pausePoints = (text: string) => Math.max(1, (text.match(/[,.!?。！？、]/g) ?? []).length);

export const koPhonology: PhonologyPort = {
  lang: 'ko',
  async score(input) {
    const measurement: ProsodyMeasurement | null = input.measurement ?? null;
    if (!measurement) return null;

    const syllables = koSyllableCount(input.transcript);
    // 太短算不出可信语速：15 音节说 2 秒，什么结论都不成立
    if (syllables < 20 || measurement.durationMs < 2000) return null;

    const rate = syllables / (measurement.durationMs / 60_000);
    const speechMs = Math.max(1, measurement.durationMs * measurement.speechRatio);
    const articulation = syllables / (speechMs / 60_000);

    // --- 语速 ---
    let pace: number;
    if (rate < SYLLABLE_PER_MIN_MIN) pace = 100 - (SYLLABLE_PER_MIN_MIN - rate) * 0.16;
    else if (rate > SYLLABLE_PER_MIN_MAX) pace = 100 - (rate - SYLLABLE_PER_MIN_MAX) * 0.1;
    else pace = 100;
    pace = clampNumber(Math.round(pace), 30, 100);

    const paceNote =
      rate < SYLLABLE_PER_MIN_MIN
        ? `实测 ${Math.round(rate)} 音节/分，偏慢。韩语慢通常是「一边想语尾一边说」——把常用语尾练成整块（-고 싶어요 / -(으)려고 해요），句子才会连起来。`
        : rate > SYLLABLE_PER_MIN_MAX
          ? `实测 ${Math.round(rate)} 音节/分，偏快。去掉停顿后 ${Math.round(articulation)}，说明是抢着说完：收音和连音最容易被吞，一丢就不像韩语了。`
          : `实测 ${Math.round(rate)} 音节/分（去掉停顿 ${Math.round(articulation)}），在自然区间（${SYLLABLE_PER_MIN_MIN}–${SYLLABLE_PER_MIN_MAX}）。`;

    // --- 停顿：跟标点数比，短样本才不会被冤枉 ---
    const expected = pausePoints(input.transcript);
    const ratio = measurement.pauseCount / expected;
    let pausing = ratio <= 1 ? 100 : ratio <= 2.5 ? 100 - (ratio - 1) * 24 : 64 - (ratio - 2.5) * 12;
    if (measurement.longestPauseMs > 1500) pausing -= Math.min(15, (measurement.longestPauseMs - 1500) / 300);
    pausing = clampNumber(Math.round(pausing), 25, 100);

    const pausingNote =
      measurement.pauseCount === 0
        ? '没有出现 ≥350ms 的停顿 —— 一口气说完，或者录音里没测到明显换气。'
        : `停了 ${measurement.pauseCount} 次，标点 ${expected} 处，最长 ${(measurement.longestPauseMs / 1000).toFixed(1)} 秒。${
            ratio >= 2
              ? '多出来的停顿多半在「找词」或「想助词」：把「그래서 / 그런데 / -는데」这类连接说法练熟，能把这些空隙填掉。'
              : ratio > 1
                ? '比标点略多，还在正常换气范围内。'
                : '停顿频率正常。'
          }`;

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

    // --- 语调：只看整段音高跨度，不指词 ---
    // 韩语不是声调语言，但句末语调承担疑问/陈述的区分；中文母语者常把整句压平。
    const pitch = measurement.pitch;
    let intonation: number | null = null;
    let intonationNote = '';
    if (pitch && pitch.voicedRatio >= 0.25) {
      const range = pitch.rangeSemitones;
      if (range < 3) {
        intonation = clampNumber(Math.round(55 + range * 10), 40, 85);
        intonationNote = `音高跨度只有 ${range} 个半音（${pitch.p10Hz}–${pitch.p90Hz}Hz），基本是一条直线。韩语的陈述句句尾要落下来、疑问句要抬起来，压平之后听不出你在问还是在说。`;
      } else if (range <= 12) {
        intonation = 100;
        intonationNote = `音高跨度 ${range} 个半音（${pitch.p10Hz}–${pitch.p90Hz}Hz），起伏在自然区间。`;
      } else {
        intonation = clampNumber(Math.round(100 - (range - 12) * 3), 70, 100);
        intonationNote = `音高跨度 ${range} 个半音，偏大 —— 多半是句尾一路上扬，陈述句听起来像在反问。`;
      }
    }

    const overall =
      intonation === null
        ? Math.round(pace * 0.4 + pausing * 0.35 + continuity * 0.25)
        : Math.round(pace * 0.32 + pausing * 0.28 + continuity * 0.2 + intonation * 0.2);

    return {
      overall: clampNumber(overall, 0, 100),
      dimensions: [
        { id: 'pace', score: pace, note: paceNote },
        { id: 'pausing', score: pausing, note: pausingNote },
        { id: 'continuity', score: continuity, note: continuityNote },
        ...(intonation === null ? [] : [{ id: 'intonation', score: intonation, note: intonationNote }]),
      ],
      // 收音（받침）与连音（연음）的对错要落在音节上，需要强制对齐；
      // 这一版评的是节奏与整段语调，不指到具体词。
      wordLevel: [],
      rate: { value: Math.round(rate), articulation: Math.round(articulation), unit: '音节/分', label: '音节/分钟' },
      // 返回「这次真的用到了哪些波形量」：工具层据此决定产物挂不挂 pitch，
      // 而不是在产物层写 if (lang === 'ja') —— 那是内核明令禁止的。
      ...(pitch ? { prosody: { pitch } } : {}),
    };
  },
};
