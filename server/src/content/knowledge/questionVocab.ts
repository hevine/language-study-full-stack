/**
 * 日语题目 → 词汇知识点挂接。
 *
 * 日语没有手写骨架树（matchers 为空），题池 124 题原先全部 untagged，
 * 诊断链路拿不到任何作答证据。这里用词形把题目连到 JLPT 词汇节点上。
 *
 * 两条铁律：
 *   1. 主考点只认解析里人工标注的词（「...」引号 或 X＝中文 的左侧），
 *      且必须先命中词库（含显式映射）；启发式扫全文会把「ます/です/かな」
 *      这类假名碎片当成考点，污染掌握度；主考点宁缺毋滥。
 *   2. 全文扫出来的词只做次要关联（is_primary = 0），用于图谱连通与题-词检索，
 *      不参与掌握度聚合，误挂也不影响诊断结论。
 *
 * 过滤规则：
 *   · term 至少 2 字、kana 至少 3 拍（「あぶら/くべつ/つつむ」有效，「あさ/かな」排除）；
 *   · kana 只用于解析人工标注词，全文扫词一律只用 term —— 假名会跨词边界误命中，
 *     例如「最もよいものを」里的「いもの」会被认成「鋳物」；
 *   · 题目用活用形/异体字（勝った/まぶしい）走 SURFACE_MAP 显式映射，不做自动词干猜测；
 *   · 最长优先，命中串被更长命中串包含时跳过，避免「いさん」寄生在「けいさん」上；
 *   · 一词一节点，按 code 去重，同一次调用结果稳定。
 */
import type { Language } from '../../domain/language';
import { JLPT_WORDS } from '../jlptGraded';

export interface VocabTag {
  /** 词汇节点编码，形如 ja.vocab.jp-v-n4-0594 */
  code: string;
  /** 命中的表面词形，便于抽检与解释 */
  surface: string;
  /** 是否主考点（仅解析首引号命中者为 true） */
  primary: boolean;
}

interface VocabIndex {
  byTerm: Map<string, string>;
  byKana: Map<string, string>;
  /** 按长度降序，供最长优先匹配 */
  forms: string[];
}

const MAX_SECONDARY = 5;

/**
 * 题目用活用形/异体字/派生词，词库只收录原形时的显式映射。
 * 只作用于词汇题解析里人工标注的词，逐条列出 —— 不做自动词干猜测，
 * 避免之前自动扫 kana 踩过的「最もよいものを」→「いもの」→「鋳物」误挂坑。
 */
const SURFACE_MAP: Record<string, string> = {
  勝った: '勝つ',
  涙を流す: '流す',
  簡単な: '簡単',
  交換して: '交換',
  話して: '話す',
  人工的: '人工',
  まぶしい: '眩しい',
};

let cached: VocabIndex | null = null;

function index(): VocabIndex {
  if (cached) return cached;
  const byTerm = new Map<string, string>();
  const byKana = new Map<string, string>();
  for (const word of JLPT_WORDS()) {
    const code = `ja.vocab.${word.code.toLowerCase()}`;
    if (word.term.length >= 2 && !byTerm.has(word.term)) byTerm.set(word.term, code);
    if (word.kana.length >= 3 && !byKana.has(word.kana)) byKana.set(word.kana, code);
  }
  // 全文扫词只用 term：kana 会跨词边界误命中（「最もよいものを」→「いもの」→「鋳物」）。
  // kana 只在解析首引号里使用，那里是人工标注的考点词，边界可靠。
  const forms = [...byTerm.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  cached = { byTerm, byKana, forms };
  return cached;
}

/**
 * 解析里人工标注的词。两种写法：
 *   · 「...」日文引号 —— 原提取方式；
 *   · X＝中文 —— 问题3「文脈規定」的解析格式（如「うがい＝漱口」），
 *     X 是考点词，取等号左侧且必须命中词库才认，避免把中文释义当词。
 * 题干与选项里的虚词不进这里。
 */
function quotedForms(text: string): string[] {
  const out: string[] = [];
  const re = /「([^」]+)」/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const form = match[1].trim();
    if (form && !out.includes(form)) out.push(form);
  }
  // X＝中文：等号左侧可能是「うがい」「調子」这类词；先收进来，命中词库才作数
  const eqRe = /([^\s，。、；：（）()]+)\s*[＝=]\s*/g;
  while ((match = eqRe.exec(text))) {
    const form = match[1].trim();
    if (form && /[\u3040-\u30ff\u4e00-\u9faf]/.test(form) && !out.includes(form)) out.push(form);
  }
  return out;
}

/** 题目表面词先过显式映射（勝った→勝つ），再查词库 */
function mappedCode(form: string, idx: VocabIndex): string | undefined {
  return codeOf(SURFACE_MAP[form] ?? form, idx);
}

function codeOf(form: string, idx: VocabIndex): string | undefined {
  return idx.byTerm.get(form) ?? (form.length >= 3 ? idx.byKana.get(form) : undefined);
}

/** 在一段文本里最长优先抽出命中的词条，按节点编码去重 */
function matchText(text: string, idx: VocabIndex): Array<{ code: string; surface: string }> {
  const out: Array<{ code: string; surface: string }> = [];
  const codes = new Set<string>();
  for (const form of idx.forms) {
    if (!text.includes(form)) continue;
    // 已被更长的命中串覆盖，跳过（如「いさん」被「けいさん」覆盖）
    if (out.some((hit) => hit.surface.includes(form))) continue;
    const code = codeOf(form, idx);
    if (!code || codes.has(code)) continue;
    codes.add(code);
    out.push({ code, surface: form });
  }
  return out;
}

/**
 * 给一道题找词汇考点。返回顺序稳定：主考点在前，次要关联在后。
 * 非日语语种返回空数组 —— 英语已有手写骨架树和 matcher，不走这条路径。
 */
export function resolveVocabTags(
  language: string,
  item: { sectionKey: string; stem: string; explanation: string },
): VocabTag[] {
  if (language !== 'ja') return [];

  const idx = index();
  const explanation = item.explanation ?? '';
  const text = `${explanation} ${item.stem ?? ''}`;

  // 只有词汇题的词才是主考点。语法/阅读/听力题考的是句型与理解能力，
  // 把解析里顺带出现的词升成主考点会误诊（如「お目にかかる」题被判成「会う」弱）。
  let primary: { code: string; surface: string } | undefined;
  if (item.sectionKey === 'vocab') {
    for (const form of quotedForms(explanation)) {
      const code = mappedCode(form, idx);
      if (code) {
        primary = { code, surface: form };
        break;
      }
    }
  }

  const tags: VocabTag[] = [];
  if (primary) tags.push({ ...primary, primary: true });

  for (const hit of matchText(text, idx)) {
    if (primary && hit.code === primary.code) continue;
    if (tags.length >= 1 + MAX_SECONDARY) break;
    tags.push({ ...hit, primary: false });
  }
  return tags;
}
