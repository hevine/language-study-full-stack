import { z } from 'zod';
import { findExam, getLanguage } from '../catalog';
import type { Task } from '../domain/types';
import type { GeneratedDay, PlanRecord } from '../domain/types';
import type { PracticeAttempt, PracticePrompt, PracticeTaskBrief, SubmissionSource } from '../domain/practice';
import { rubricFor, type PracticeFormat, type PracticeKind } from '../domain/rubrics';
import { profileOf, type Language } from '../domain/language';
import { pickPrompt } from '../content/prompts';
import { ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { saveDayTasks } from '../repositories/plans';
import { logStudy, removeTaskLogs } from '../repositories/misc';
import {
  getPrompt,
  insertAttempt,
  listTaskAttempts,
  savePrompt,
  taskAttemptStats,
} from '../repositories/practice';
import { chatJson, resolveLlmConfig } from './llm';
import { gradeSubmission } from './grading';

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const PromptSchema = z.object({
  title: z.string().min(4),
  scenario: z.string().min(10),
  stimulus: z
    .object({ a: z.string().min(4), b: z.string().min(4) })
    .nullable()
    .optional(),
  question: z.string().min(10),
  hints: z.array(z.string()).min(1),
  checklist: z.array(z.string()).min(1),
});

/**
 * 命题提示词按「计划语种」分叉，不是按 examId 分叉。
 * 曾经这里只有 ja 与「默认英文」两条分支，韩语计划因此拿到了
 * 「熟悉托福/雅思的英语命题人」+ 英文题干的题目——语种切换看起来生效了，
 * 生成的却还是托福任务。新增语种时必须在这里补一支，不能落到英文兜底。
 */
export function buildPromptMessages(
  plan: PlanRecord,
  day: GeneratedDay,
  format: PracticeFormat,
): Array<{ role: 'system' | 'user'; content: string }> {
  const exam = findExam(plan.examId);
  const language = getLanguage(plan.language);
  const level = language.levels.find((item) => item.id === plan.currentLevelId);
  const target = exam.targets.find((item) => item.score === plan.targetScore) ?? exam.targets[0];
  const lengthLine = format.wordRange
    ? `${format.wordRange[0]}–${format.wordRange[1]} ${profileOf(plan.language).unitLabel}`
    : '不限';

  if (plan.language === 'ja') {
    return [
      {
        role: 'system',
        content: `あなたは日本語能力試験と日本留学試験（記述・口述）の作問者です。学習者がそのまま練習できる課題を 1 題作成します。
- 課題はオリジナルとし、過去問をそのまま使わない。
- 難易度は指定されたレベルに合わせる。
- 出力は JSON のみ。説明文やコードブロックは付けない。`,
      },
      {
        role: 'user',
        content: `以下の条件で「${format.label}」の練習課題を 1 題作成し、JSON で出力してください。

【試験】${exam.name}／目標：${target.label}
【学習段階】${day.phaseName}（第 ${day.weekIndex + 1} 週）
【今日のテーマ】${day.theme}
【学習者のレベル】${level?.name ?? plan.currentLevelName}（${level?.cefr ?? ''}）
【課題形式】${format.taskType}
【字数・時間】${format.wordRange ? `${format.wordRange[0]}〜${format.wordRange[1]} 字` : '指定なし'}／${format.minutes} 分

出力する JSON：
{
  "title": "課題タイトル（日本語、20 字以内）",
  "scenario": "課題の背景・状況説明（日本語、2〜3 文）",
  "stimulus": null,
  "question": "学習者への具体的な指示（日本語、1〜2 文。字数と立場の明示を含む）",
  "hints": ["構成のヒント（中国語、2〜3 項目）"],
  "checklist": ["提出前のセルフチェック（中国語、3〜4 項目）"]
}

条件：
1. テーマ「${day.theme}」に直結する内容にすること。
2. scenario と question は日本語、hints と checklist は中国語で書くこと。
3. hints は抽象論ではなく「何をどの順番で書くか」が分かる具体性にすること。`,
      },
    ];
  }

  if (plan.language === 'ko') {
    return [
      {
        role: 'system',
        content: `당신은 한국어능력시험(TOPIK) 출제위원입니다. 학습자가 그대로 연습할 수 있는 과제를 1개 만듭니다.
- 과제는 반드시 오리지널이어야 하며, 기출문제를 그대로 쓰지 않습니다.
- 난이도는 지정된 급수에 맞춥니다.
- 출력은 JSON만. 설명문이나 코드블록은 붙이지 않습니다.`,
      },
      {
        role: 'user',
        content: `다음 조건으로 「${format.label}」 연습 과제를 1개 만들어 JSON으로 출력하시오.

【시험】${exam.name} / 목표: ${target.label}
【학습 단계】${day.phaseName} (${day.weekIndex + 1}주차)
【오늘의 주제】${day.theme}
【학습자 수준】${level?.name ?? plan.currentLevelName} (${level?.cefr ?? ''})
【과제 유형】${format.taskType}
【분량·시간】${lengthLine} / ${format.minutes}분

출력할 JSON:
{
  "title": "과제 제목 (한국어, 20자 이내)",
  "scenario": "과제 배경·상황 설명 (한국어, 2~3문장)",
  "stimulus": null,
  "question": "학습자에게 주는 구체적 지시 (한국어, 1~2문장. 분량과 입장 제시 포함)",
  "hints": ["구성 힌트 (중국어, 2~3개)"],
  "checklist": ["제출 전 자기 점검 (중국어, 3~4개)"]
}

조건:
1. 주제 「${day.theme}」와 직접 연결될 것.
2. scenario와 question은 한국어, hints와 checklist는 중국어로 쓸 것.
3. hints는 추상론이 아니라 "무엇을 어떤 순서로 쓸지"가 보이게 구체적으로 쓸 것.
4. TOPIK 실제 출제 형식을 따를 것: 쓰기는 서론—본론—결론 구조의 설명문, 말하기는 의견 제시형으로 낼 것.
5. 초급 수준이면 해요체, 중급 이상은 습니다체·한다체 중 하나로 어미를 통일하도록 지시할 것.`,
      },
    ];
  }

  return [
    {
      role: 'system',
      content: `你是一位资深英语考试命题人，熟悉托福 iBT、雅思 Academic、大学英语六级与考研英语的写作/口语题型与评分标准。
你的任务是为当天的训练出一道原创题目：题型必须与目标考试一致，难度匹配考生的目标分数，并且能在给定时间内完成。
题目不得复制真题原文，但必须体现真题的提问方式与话语风格。
你只输出 JSON，不输出解释文字、不使用 markdown 代码块。`,
    },
    {
      role: 'user',
      content: `请为 ${day.date} 出一道「${format.label}」练习题，输出 JSON。

【考试】${exam.name}／目标：${target.label}
【备考阶段】${day.phaseName}（第 ${day.weekIndex + 1} 周 / 共 ${plan.weeks} 周）
【今日主题】${day.theme}
【本阶段重点】${day.focus.join('、')}
【考生水平】${level?.name ?? plan.currentLevelName}（${level?.cefr ?? ''}）
【题型要求】${format.taskType}
【时间与篇幅】${format.minutes} 分钟${format.wordRange ? `，${format.wordRange[0]}–${format.wordRange[1]} 词` : ''}${format.prepSeconds ? `，准备 ${format.prepSeconds} 秒 / 作答 ${format.responseSeconds} 秒` : ''}

JSON 结构：
{
  "title": "题目简称（中文，20 字以内，用于列表展示）",
  "scenario": "英文题干情境（2–4 句，符合该考试真实提问方式）",
  "stimulus": ${plan.examId === 'toefl' && format.kind === 'write' ? '{"a":"同学 A 的英文观点（25–40 词）","b":"同学 B 的英文观点（25–40 词）"}' : 'null'},
  "question": "英文作答指令（明确立场要求、字数或时长）",
  "hints": ["中文构思提示 2–3 条：怎么开头、用什么例子、如何回应反方"],
  "checklist": ["中文自检清单 3–4 条：提交前必须逐条核对的东西"]
}

硬性要求：
1. 题目必须围绕今日主题「${day.theme}」展开，且是考生在 ${format.minutes} 分钟内能真正写完/说完的规模。
2. scenario 与 question 必须是英文；hints 与 checklist 必须是中文。
3. 不要出现 "write about the importance of..." 这类小学题目；要像真题。
4. hints 要具体到「第一句写什么」，不要写「注意结构」这种废话。`,
    },
  ];
}

function buildPromptFromFormat(
  format: PracticeFormat,
  template: ReturnType<typeof pickPrompt>,
  source: 'llm' | 'library',
  model: string | null,
  language: Language,
): PracticePrompt {
  return {
    language,
    kind: format.kind,
    formatLabel: format.label,
    taskType: format.taskType,
    title: flatten(template.title),
    scenario: template.scenario.trim(),
    stimulus: template.stimulus ? { a: template.stimulus.a, b: template.stimulus.b } : undefined,
    question: template.question.trim(),
    hints: template.hints.slice(0, 4),
    checklist: template.checklist.slice(0, 5),
    minutes: format.minutes,
    wordRange: format.wordRange,
    prepSeconds: format.prepSeconds,
    responseSeconds: format.responseSeconds,
    dimensions: format.dimensions.map((dimension) => ({
      id: dimension.id,
      name: dimension.name,
      weight: dimension.weight,
      criteria: dimension.criteria,
    })),
    scale: format.scale,
    remarks: format.remarks,
    source,
    model,
  };
}

async function ensurePrompt(
  plan: PlanRecord,
  day: GeneratedDay,
  task: Task,
  format: PracticeFormat,
  options: { allowLlm?: boolean } = {},
): Promise<{ prompt: PracticePrompt; generated: boolean }> {
  const cached = getPrompt(day.id, task.id);
  // 语种或评分标准变了，旧题目立即作废：不能让韩语计划继续展示
  // 之前按托福/雅思生成并缓存的那道题（这正是「切了语种却还是托福任务」的另一半原因）
  if (cached && cached.language === plan.language && cached.formatLabel === format.label) {
    return { prompt: cached, generated: false };
  }

  const seed = day.weekIndex * 7 + day.dayIndex + (format.kind === 'speak' ? 3 : 0);
  const template = pickPrompt(plan.examId, plan.language, format.kind, seed);
  const { config } = resolveLlmConfig();

  if (config && options.allowLlm !== false) {
    try {
      const raw = await chatJson(config, buildPromptMessages(plan, day, format), PromptSchema, {
        temperature: 0.85,
        maxTokens: 1400,
        retries: 1,
      });
      const prompt = buildPromptFromFormat(
        format,
        {
          title: raw.title,
          scenario: raw.scenario,
          stimulus: raw.stimulus ?? undefined,
          question: raw.question,
          hints: raw.hints,
          checklist: raw.checklist,
        },
        'llm',
        config.usedModel ?? config.model,
        plan.language,
      );
      savePrompt({ planId: plan.id, dayId: day.id, taskId: task.id, kind: format.kind, payload: prompt });
      return { prompt, generated: true };
    } catch (err) {
      logger.warn('llm prompt generation failed, fallback to bank', {
        message: (err as Error).message,
        day: day.date,
      });
    }
  }

  const prompt = buildPromptFromFormat(format, template, 'library', null, plan.language);
  savePrompt({ planId: plan.id, dayId: day.id, taskId: task.id, kind: format.kind, payload: prompt });
  return { prompt, generated: true };
}

function practiceKindOf(task: Task): PracticeKind | null {
  if (task.kind === 'write') return 'write';
  if (task.kind === 'speak') return 'speak';
  return null;
}

export function isPracticeTask(task: Task): boolean {
  return practiceKindOf(task) !== null;
}

export interface PracticeBrief {
  task: {
    id: string;
    kind: PracticeKind;
    title: string;
    detail: string;
    minutes: number;
    done: boolean;
    score: number | null;
  };
  prompt: PracticePrompt;
  attempts: PracticeAttempt[];
  notice: string | null;
}

export async function buildPracticeBrief(
  plan: PlanRecord,
  day: GeneratedDay,
  taskId: string,
  options: { allowLlm?: boolean; historical?: boolean } = {},
): Promise<PracticeBrief> {
  const task = day.tasks.find((item) => item.id === taskId);
  if (!task) throw new ValidationError('该任务不存在');

  const kind = practiceKindOf(task);
  if (!kind) throw new ValidationError('只有写作与口语任务需要批改');

  const format = rubricFor(plan.examId, plan.language, kind);
  const { prompt } = await ensurePrompt(plan, day, task, format, { allowLlm: options.allowLlm });
  const attempts = listTaskAttempts(day.id, task.id, 6);

  const notice = options.historical
    ? '这条记录不在当前计划范围内（来自旧日期或历史计划）：可以回看批改，也可以继续练，题目沿用原题不会重新生成。'
    : prompt.source === 'library'
      ? '当前题目来自内置题库；在「设置」中配置大模型后，会按当日主题与考纲实时命题。'
      : null;

  return {
    task: {
      id: task.id,
      kind,
      title: task.title,
      detail: task.detail,
      minutes: task.minutes,
      done: task.done,
      score: task.score ?? null,
    },
    prompt,
    attempts,
    notice,
  };
}

export interface GradeResponse {
  attempt: PracticeAttempt;
  taskScore: number;
  day: GeneratedDay | null;
}

export async function gradePractice(params: {
  plan: PlanRecord;
  day: GeneratedDay;
  taskId: string;
  text: string;
  durationSeconds: number | null;
  submissionSource: SubmissionSource;
  recognitionConfidence: number | null;
}): Promise<GradeResponse> {
  const { plan, day, taskId } = params;
  const task = day.tasks.find((item) => item.id === taskId);
  if (!task) throw new ValidationError('该任务不存在');

  const kind = practiceKindOf(task);
  if (!kind) throw new ValidationError('只有写作与口语任务需要批改');

  const text = params.text.trim();
  if (text.length < 20) {
    throw new ValidationError(
      kind === 'speak'
        ? '口语内容太短（少于 20 字符），请先录音转写或手动补充你的回答。'
        : '内容太短（少于 20 字符），先写完一段再提交批改。',
    );
  }
  if (text.length > 12000) {
    throw new ValidationError('内容过长（超过 12000 字符），请只提交本次作答。');
  }

  const format = rubricFor(plan.examId, plan.language, kind);
  const { prompt } = await ensurePrompt(plan, day, task, format);

  const result = await gradeSubmission({
    language: plan.language,
    format,
    prompt,
    text,
    durationSeconds: params.durationSeconds,
    recognitionConfidence: params.recognitionConfidence,
  });

  const attempt = insertAttempt({
    planId: plan.id,
    dayId: day.id,
    taskId: task.id,
    kind,
    promptTitle: prompt.title,
    submission: text,
    submissionSource: params.submissionSource,
    durationSeconds: params.durationSeconds,
    overall: result.overall,
    band: result.band,
    dimensions: result.dimensions,
    feedback: result.feedback,
    stats: result.stats,
    source: result.source,
    model: result.model,
  });
  attempt.notice = result.notice;

  // 批改完成即视为该任务已完成，并把得分写回任务卡
  const tasks = day.tasks.map((item) =>
    item.id === task.id ? { ...item, done: true, score: result.overall } : item,
  );
  const updatedDay = saveDayTasks(day.id, tasks);

  removeTaskLogs(day.id, task.id);
  logStudy({
    planId: plan.id,
    dayId: day.id,
    taskId: task.id,
    kind: task.kind,
    minutes: Math.max(5, params.durationSeconds ? Math.round(params.durationSeconds / 60) : task.minutes),
    score: result.overall,
  });

  return { attempt, taskScore: result.overall, day: updatedDay };
}

export function practiceTasksForDay(plan: PlanRecord, day: GeneratedDay): PracticeTaskBrief[] {
  return day.tasks
    .filter((task) => isPracticeTask(task))
    .map((task) => {
      const kind = practiceKindOf(task)!;
      const stats = taskAttemptStats(day.id, task.id);
      return {
        taskId: task.id,
        kind,
        title: task.title,
        minutes: task.minutes,
        done: task.done,
        score: task.score ?? null,
        attemptCount: stats.count,
        best: stats.best,
        last: stats.last
          ? {
              overall: Math.round(stats.last.overall),
              bandLabel: stats.last.band.label,
              createdAt: stats.last.createdAt,
            }
          : null,
      };
    });
}
