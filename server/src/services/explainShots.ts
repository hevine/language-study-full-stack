/**
 * 分镜组装（纯函数，不碰数据库 / 不改状态）。
 *
 * 从 explainScript.ts 里拆出来的理由：这里是「正确性」所在 —— 题干、选项、答案
 * 一律以题库为准，模型给的只当参考。它必须能在没有数据库、没有大模型的环境里被自检，
 * 所以不能跟着 llm.ts 一起把 better-sqlite3 拖进来（`scripts/checkExplainParse.ts` 依赖这一点）。
 */
import type { Language } from '../domain/language';
import type { Question } from '../domain/types';
import type { Shot, ShotKind } from '../domain/explainVideo';
import type { ShotDraft } from './explainScriptSalvage';
import type { ExplainDepth } from './explainPedagogy';

export interface ExplainInput {
  articleId: string;
  language: Language;
  title: string;
  body: string;
  translation: string;
  questions: Question[];
  vocab?: Array<{ term: string; meaning?: string }>;
  /** 讲解深度：short 3 镜/题、medium 5 镜/题、long 6–7 镜/题（默认 medium） */
  depth?: ExplainDepth;
  /** 计划里的目标级别标签（如「N1 合格」「托福 100」），决定用哪套教学法 */
  examLabel?: string | null;
  examId?: string | null;
}

/** 把模型草稿 + 权威答案组装成合法 Shot 列表，并做代码侧校验 / 降级 */
export function assembleShots(drafts: ShotDraft[], input: ExplainInput): Shot[] {
  const paragraphs = input.body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const shots: Shot[] = [];

  drafts.forEach((draft, index) => {
    const questionNo = draft.questionNo;
    const question = questionNo !== undefined ? input.questions[questionNo] : undefined;
    const shot: Shot = {
      id: `s${index}`,
      kind: draft.kind as ShotKind,
      narration: draft.narration.trim(),
      caption: draft.caption.trim(),
      questionNo,
      audio: { url: '', durationMs: 0 },
    };

    // 题干 / 选项：以库内数据为准，模型给的不信
    if (question && (draft.kind === 'question' || draft.kind === 'eliminate' || draft.kind === 'answer')) {
      shot.prompt = question.prompt;
      shot.options = [...question.options];
    } else if (draft.kind === 'question' && draft.prompt) {
      // 没给题号时至少把模型抄来的题干用上，避免空白画面（补镜阶段会再对齐题库）
      shot.prompt = draft.prompt;
      shot.options = draft.options ? [...draft.options] : undefined;
    }

    if (draft.kind === 'passage' || draft.kind === 'eliminate') {
      const matched = draft.evidence && input.body.includes(draft.evidence);
      shot.highlight = {
        paragraph: draft.paragraph,
        // 证据原句必须能在正文精确匹配，否则不填 sentence（前端降级为段号）
        sentence: matched ? draft.evidence : undefined,
        picked: draft.kind === 'eliminate' && question ? question.answer : undefined,
      };
    }

    if (draft.kind === 'answer' && question) {
      shot.highlight = {
        picked: question.answer,
        paragraph: draft.paragraph,
        sentence: draft.evidence && input.body.includes(draft.evidence) ? draft.evidence : undefined,
      };
    }

    if (draft.kind === 'grammar') {
      const sentence = draft.sentence && input.body.includes(draft.sentence) ? draft.sentence : '';
      shot.grammar = {
        sentence,
        structure: draft.structure ?? '',
        explanation: draft.explanation ?? '',
        translation: draft.translation ?? '',
      };
      if (!sentence) {
        // 语法镜拿不到精确原句就降级为考点镜，避免编造原文
        shot.kind = 'point';
        shot.point = { label: draft.pointLabel ?? '语法要点', text: draft.explanation ?? draft.caption };
      }
    }

    if (draft.kind === 'point') {
      shot.point = { label: draft.pointLabel ?? '考点提示', text: draft.pointText ?? draft.caption };
    }

    // 兜底：段落号越界回落到 0
    if (shot.highlight?.paragraph !== undefined && paragraphs.length > 0) {
      shot.highlight.paragraph = Math.min(Math.max(0, shot.highlight.paragraph), paragraphs.length - 1);
    }
    shots.push(shot);
  });

  return shots;
}

/**
 * 补镜用的旁白模板：目标语（跟 TTS 音色一致），字幕用中文。
 * takeaway 只在模型截断丢失结尾镜时用——一句可复述的方法，不是「今天我们就讲到这里」。
 */
const SYNTH: Record<Language, {
  question: (no: number) => string;
  answer: (text: string) => string;
  takeaway: string;
  takeawayCaption: string;
}> = {
  en: {
    question: (no) => `Let's look at question ${no}.`,
    answer: (text) => `The correct answer is ${text}.`,
    takeaway: 'Before you choose, point at the sentence that proves it.',
    takeawayCaption: '收尾：先指出证据句，再选答案。',
  },
  ja: {
    question: (no) => `第${no}問を見てみましょう。`,
    answer: (text) => `正解は${text}です。`,
    takeaway: '答える前に、根拠の一文を指で押さえる。',
    takeawayCaption: '收尾：先用手指按住证据句，再选答案。',
  },
  ko: {
    question: (no) => `${no}번 문제를 살펴봅시다.`,
    answer: (text) => `정답은 ${text}입니다.`,
    takeaway: '고르기 전에, 근거 문장을 먼저 짚으세요.',
    takeawayCaption: '收尾：先指住证据句，再选答案。',
  },
};

/**
 * 脚本可能不完整（模型被截断、部分镜被判定为坏数据丢弃），但视频必须完整：
 * 按题号重组分镜，缺 question 镜就用题库补、缺 answer 镜就按权威答案补，
 * 并把 answer 镜的 picked / prompt / options 强制对齐题库 —— 绝不出现「讲错的答案」。
 */
export function ensureCoverage(shots: Shot[], input: ExplainInput): { shots: Shot[]; autoFilled: number } {
  let autoFilled = 0;
  let cover: Shot | undefined;
  const groups = new Map<number, Shot[]>();
  const loose: Shot[] = [];
  const tail: Shot[] = [];
  const synth = SYNTH[input.language] ?? SYNTH.en;

  for (const shot of shots) {
    if (!cover && shot.kind === 'cover') {
      cover = shot;
      continue;
    }
    if (shot.kind === 'takeaway') {
      tail.push(shot);
      continue;
    }
    const no = shot.questionNo;
    if (no !== undefined && no >= 0 && no < input.questions.length) {
      const list = groups.get(no) ?? [];
      list.push(shot);
      groups.set(no, list);
    } else {
      loose.push(shot);
    }
  }

  const out: Shot[] = [];
  if (cover) out.push(cover);

  input.questions.forEach((question, no) => {
    const group = groups.get(no) ?? [];
    const correct = question.options[question.answer] ?? '';

    if (!group.some((shot) => shot.kind === 'question')) {
      out.push({
        id: `auto-question-${no}`,
        kind: 'question',
        questionNo: no,
        narration: synth.question(no + 1),
        caption: `第 ${no + 1} 题`,
        prompt: question.prompt,
        options: [...question.options],
        audio: { url: '', durationMs: 0 },
      });
      autoFilled += 1;
    }

    for (const shot of group) {
      if (shot.kind === 'answer') {
        shot.highlight = { ...(shot.highlight ?? {}), picked: question.answer };
        shot.prompt = question.prompt;
        shot.options = [...question.options];
      }
      out.push(shot);
    }

    if (!group.some((shot) => shot.kind === 'answer')) {
      out.push({
        id: `auto-answer-${no}`,
        kind: 'answer',
        questionNo: no,
        narration: synth.answer(correct),
        caption: `正确答案是 ${correct}${question.explain ? `：${question.explain}` : ''}`.slice(0, 300),
        prompt: question.prompt,
        options: [...question.options],
        highlight: { picked: question.answer },
        audio: { url: '', durationMs: 0 },
      });
      autoFilled += 1;
    }
  });

  // 结尾镜：模型常在最后一镜被截断，缺了它视频会停在「排除」上，没有可记住的一句话
  if (!tail.length) {
    out.push({
      id: 'auto-takeaway',
      kind: 'takeaway',
      narration: synth.takeaway,
      caption: synth.takeawayCaption,
      audio: { url: '', durationMs: 0 },
    });
    autoFilled += 1;
  }

  out.push(...loose, ...tail);
  // 用稳定 id 重排，避免自动补镜导致 id 重复
  return { shots: out.map((shot, index) => ({ ...shot, id: `s${index}` })), autoFilled };
}
