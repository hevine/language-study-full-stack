/**
 * 试卷结构识别：把一整份原卷的纯文本切成「大题」块，并单独切出答案解析区。
 *
 * 为什么需要它：
 *   老版本把整卷按 1.1 万字打包，一次让模型「把里面所有题都抽出来」。
 *   真实原卷动辄 80+ 题、十几个大题，一次输出的 token 根本不够，模型只会交出
 *   第一段（往往就是文字・語彙）的几道题 —— 于是「升级自测」永远只测词汇。
 *   正确做法是先按原卷自己的大题（問題1 / 問題2 / Part A …）切块，一块一次调用，
 *   每块的题量在模型一次输出能力之内，题型分布才能跟着原卷走。
 *
 * 同时把「答案以及解析」区单独切出来：答题区的题面与答案区的解析分处文档两端，
 * 模型必须同时看到两边才能判出正确选项。
 */

export type StructureSectionKey = 'listening' | 'vocab' | 'grammar' | 'reading' | 'writing';

/** 考试科目：笔答（言语知识・阅读・写作）与听力，真实考试是分开计时、分开收卷的 */
export type ExamStage = 'written' | 'oral';

export interface ExamBlock {
  /** 原卷的大题号（問題N / Part N） */
  no: number;
  /** 界面上显示的题型名，如「問題1 文字・語彙」 */
  label: string;
  sectionKey: StructureSectionKey;
  /** 大题前的科目横幅，如「言語知識（文字・語彙）」「聴解」 */
  banner: string;
  /** 本大题的指导语（第一行），供模型判断题型 */
  instruction: string;
  /** 本大题全文 */
  text: string;
}

export interface SplitResult {
  blocks: ExamBlock[];
  /** 「答案以及解析」之前的内容（题面全文），切不出大题时整段交给模型 */
  questionText: string;
  /** 「答案以及解析」之后的内容；没有答案区时为空串 */
  answerRegion: string;
  /** 识别过程中的提示，进导入进度里给用户看 */
  notes: string[];
  /** 是否找到独立的答案区 */
  hasAnswerSection: boolean;
}

/** 全角数字 → 半角；顺带清掉零宽字符与 OCR 常带的软连字符 */
function normalize(input: string): string {
  return input
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[\u00ad]/g, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

const PAGE_MARK = /^=====\s*PAGE\s*\d+\s*=====$/i;
const PAGE_MARK_ANY = /=====\s*PAGE\s*\d+\s*=====/gi;

/** 大题起始行：問題1 / 問題 2 / 問題4. / Part 3 / 第1部分 */
const QUESTION_HEAD =
  /^\s*(?:問題|问题)\s*([0-9]{1,2})\s*[.．、:：]?\s*(.*)$|^\s*(?:Part|PART|Section|SECTION)\s*([0-9]{1,2})\s*[.．、:：]?\s*(.*)$|^\s*第\s*([0-9]{1,2})\s*部分\s*(.*)$/;

/** 科目横幅 */
const BANNER_PATTERNS: Array<{ re: RegExp; kind: 'vocab' | 'grammar' | 'reading' | 'listening' | 'writing' | 'mixed' }> = [
  { re: /聴\s*解|听\s*解|listening/i, kind: 'listening' },
  { re: /言\s*語\s*知\s*識.*読\s*解|言\s*語\s*知\s*識.*文\s*法/, kind: 'mixed' },
  { re: /言\s*語\s*知\s*識|语\s*言\s*知\s*识/, kind: 'vocab' },
  { re: /読\s*解|阅\s*读|reading/i, kind: 'reading' },
  { re: /文\s*法|语\s*法|grammar/i, kind: 'grammar' },
  { re: /文\s*字.*語\s*彙|文\s*字.*词\s*汇/, kind: 'vocab' },
  { re: /作\s*文|写\s*作|writing/i, kind: 'writing' },
];

/** 答案区起始行 */
const ANSWER_HEAD = /答\s*案\s*(?:以\s*及|与|和)?\s*(?:解\s*析|详\s*解)|参\s*考\s*答\s*案|Answer\s*Key/i;

/** 单独成行的题号（如「10、」「12.」），这类行不含题面，只是版式残渣 */
const LONE_NUMBER = /^\s*[0-9]{1,3}\s*[、.．)）]\s*$/;

/** 听力原文标记 */
const SCRIPT_MARK = /^\s*【\s*听\s*力\s*原\s*文\s*】/;

interface Pending {
  no: number;
  banner: string;
  /** 建块时的科目先验，必须在建块时快照，扫描结束时再取会拿到最后一段的值 */
  bannerKind: string;
  instruction: string;
  lines: string[];
}

function classifyByInstruction(instruction: string, bannerKind: string, no: number): StructureSectionKey {
  const text = instruction.replace(/\s/g, '');
  if (bannerKind === 'listening') return 'listening';
  if (/読み方|读法|漢字で書く|汉字|意味が最も近い|最も近いもの|使い方として|用法/.test(text)) return 'vocab';
  if (/文章全体|★|組み立て|语序|並べ替え|文の文法/.test(text)) return 'grammar';
  // 言語知識（文法）·読解 是同一个横幅：文法占 問題1–3，読解从 問題4 起
  if (bannerKind === 'mixed' && no >= 4) return 'reading';
  if (/文章を読んで|読んで、質問|阅读|読解/.test(text)) return 'reading';
  if (/作文|写作|writing|書いてください/.test(text)) return 'writing';
  if (/文の（\s*）|文の\(\s*\)|文の（）|文法|语法/.test(text)) return 'grammar';
  if (/（\s*）に入れる|\(\s*\)に入れる|空欄/.test(text)) {
    // 語彙問題3 与 文法問題1 的指导语几乎一样，只能靠「文の」与题号先后区分：
    // 語彙在前（問題1–5），文法重新从 問題1 开始，所以靠 banner 判不出来时按顺序压
    return no <= 5 ? 'vocab' : 'grammar';
  }
  if (bannerKind === 'grammar') return 'grammar';
  if (bannerKind === 'reading') return 'reading';
  if (bannerKind === 'vocab') return 'vocab';
  return no <= 5 ? 'vocab' : 'grammar';
}

const SECTION_NAME: Record<StructureSectionKey, string> = {
  listening: '聴解',
  vocab: '文字・語彙',
  grammar: '文法',
  reading: '読解',
  writing: '写作',
};

export function sectionDisplayName(key: StructureSectionKey): string {
  return SECTION_NAME[key];
}

const SECTION_NAME_EN: Record<StructureSectionKey, string> = {
  listening: 'Listening',
  vocab: 'Vocabulary',
  grammar: 'Grammar',
  reading: 'Reading',
  writing: 'Writing',
};

export function stageOf(sectionKey: StructureSectionKey): ExamStage {
  return sectionKey === 'listening' ? 'oral' : 'written';
}

/**
 * 把整卷切成大题块。
 * 规则：
 *   1. 「答案以及解析」之后的内容不再当题面，单独作为答案区。
 *   2. 遇到 問題N / Part N 开新块；同一题号且指导语相同（読解大题给多篇文章重复贴同一行指导语）视为续块。
 *   3. 科目横幅（聴解 / 言語知識 / 読解）记到后续块上，作为题型判断的先验。
 */
export function splitExamDocument(rawText: string, pages: string[] = []): SplitResult {
  const text = normalize(rawText);
  const notes: string[] = [];
  const lines = text.split(/\r?\n/);

  let answerStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (ANSWER_HEAD.test(lines[i])) {
      answerStart = i;
      break;
    }
  }

  const questionLines = answerStart >= 0 ? lines.slice(0, answerStart) : lines;
  const questionText = questionLines.join('\n').replace(PAGE_MARK_ANY, '').trim();
  const answerRegion =
    answerStart >= 0 ? lines.slice(answerStart + 1).join('\n').replace(PAGE_MARK_ANY, '').trim() : '';

  const blocks: Pending[] = [];
  let banner = '';
  let bannerKind = '';

  for (const line of questionLines) {
    if (PAGE_MARK.test(line.trim())) continue;

    const compact = line.replace(/\s/g, '');
    // 横幅只在短行里认，避免把题目正文里的「読解」当成新科目
    if (compact.length > 0 && compact.length <= 40) {
      const hit = BANNER_PATTERNS.find((entry) => entry.re.test(compact));
      if (hit && !QUESTION_HEAD.test(line)) {
        banner = compact;
        bannerKind = hit.kind === 'mixed' ? 'mixed' : hit.kind;
        continue;
      }
    }

    const head = line.match(QUESTION_HEAD);
    if (head) {
      const no = Number(head[1] ?? head[5] ?? head[7]);
      const instruction = (head[2] ?? head[6] ?? head[8] ?? '').trim();
      const last = blocks[blocks.length - 1];
      // 読解：四篇短文各自重复一次同一条指导语，合并成一块
      if (last && last.no === no && instruction.length > 0 && instruction === last.instruction) {
        last.lines.push(line);
        continue;
      }
      blocks.push({
        no: Number.isFinite(no) ? no : blocks.length + 1,
        banner,
        bannerKind,
        instruction,
        lines: [line],
      });
      continue;
    }

    if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
  }

  const out: ExamBlock[] = [];
  for (const block of blocks) {
    const body = block.lines.join('\n').replace(PAGE_MARK_ANY, '').trim();
    if (body.replace(/\s/g, '').length < 30) continue;
    const sectionKey = classifyByInstruction(
      `${block.instruction}\n${body.slice(0, 400)}`,
      block.bannerKind,
      block.no,
    );
    const isJa = /[\u3040-\u30ff]/.test(body);
    const name = isJa ? SECTION_NAME[sectionKey] : SECTION_NAME_EN[sectionKey];
    out.push({
      no: block.no,
      label: `問題${block.no} · ${name}`,
      sectionKey,
      banner: block.banner,
      instruction: block.instruction.slice(0, 120),
      text: body,
    });
  }

  if (out.length === 0) notes.push('没有按大题切开，整卷当一块交给模型处理。');
  if (answerRegion.length === 0) notes.push('文档里没有找到独立的「答案以及解析」区，答案只能靠模型作答。');

  return { blocks: out, questionText, answerRegion, notes, hasAnswerSection: answerRegion.length > 0 };
}

/** 各等级的建议时长（分钟）：原卷没标时按时长参考，仅作为计时上限，不做分数换算 */
export function defaultStageMinutes(levelLabel: string, examName: string): { written: number; oral: number } {
  const level = (levelLabel.match(/N[1-5]/i)?.[0] ?? '').toUpperCase();
  const isJa = /日本语|日本語|JLPT/i.test(`${examName}${levelLabel}`) || Boolean(level);
  if (isJa && level) {
    const table: Record<string, { written: number; oral: number }> = {
      N1: { written: 110, oral: 55 },
      N2: { written: 105, oral: 50 },
      N3: { written: 100, oral: 40 },
      N4: { written: 90, oral: 35 },
      N5: { written: 80, oral: 30 },
    };
    return table[level] ?? { written: 100, oral: 40 };
  }
  return { written: 0, oral: 0 };
}

/** 清洗题面里明显属于版式残渣的行 */
export function cleanStemLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (LONE_NUMBER.test(trimmed)) return false;
      if (SCRIPT_MARK.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * 数出这一块原文里有多少个「小题标记」，用来校验模型有没有漏题。
 *
 * 原卷的小题有两种写法：
 *   19.______ / 20、______   填空题（文法・文章の文法）
 *   1番 / 2番                听力
 * 只认行首带序号的，避免把选项里的「1、」也算进来。
 */
export function countQuestionMarks(text: string): Array<{ no: number; at: number }> {
  const marks: Array<{ no: number; at: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const blank = line.match(/^(\d{1,3})\s*[.．、,:：]?\s*[_＿]{2,}/);
    if (blank) {
      marks.push({ no: Number(blank[1]), at: i });
      continue;
    }
    const numbered = line.match(/^(\d{1,3})\s*[.．、]\s*$/);
    if (numbered && i + 1 < lines.length && /^[_＿]{2,}/.test(lines[i + 1].trim())) {
      marks.push({ no: Number(numbered[1]), at: i });
      continue;
    }
    const listening = line.match(/^(\d{1,3})\s*番\s*$/);
    if (listening) marks.push({ no: Number(listening[1]), at: i });
  }
  return marks;
}
