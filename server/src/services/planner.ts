import { randomUUID } from 'node:crypto';
import { findExam, findLevel, getLanguage } from '../catalog';
import type { ExamDef, Language, LevelDef, PhaseDef, ScoreTarget, TaskKind } from '../catalog/types';
import { addDays, diffDays } from '../lib/date';
import { ValidationError } from '../lib/errors';
import type {
  Feasibility,
  FeasibilityLevel,
  GeneratedDay,
  Milestone,
  Roadmap,
  Task,
} from '../domain/types';

export interface PlanRequest {
  language: Language;
  examId: string;
  currentLevelId: string;
  targetScore: number;
  startDate: string;
  examDate: string;
  hoursPerWeek: number;
  dailyMinutes: number;
}

export interface PlanDraft {
  language: Language;
  examId: string;
  examName: string;
  currentLevelId: string;
  currentLevelName: string;
  targetScore: number;
  targetLabel: string;
  startDate: string;
  examDate: string;
  weeks: number;
  hoursPerWeek: number;
  dailyMinutes: number;
  feasibility: Feasibility;
  roadmap: Roadmap;
  days: GeneratedDay[];
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validatePlanRequest(input: Partial<PlanRequest>): PlanRequest {
  const language = input.language;
  if (language !== 'en' && language !== 'ja' && language !== 'ko') {
    throw new ValidationError('请选择要提升的语言');
  }

  const lang = getLanguage(language);
  const exam = lang.exams.find((item) => item.id === input.examId);
  if (!exam) throw new ValidationError('请选择有效的考试');

  const level = lang.levels.find((item) => item.id === input.currentLevelId);
  if (!level) throw new ValidationError('请选择当前水平');

  const target = resolveTarget(exam, Number(input.targetScore));
  if (!target) throw new ValidationError('请选择该考试支持的目标分数');

  const startDate = String(input.startDate ?? '');
  const examDate = String(input.examDate ?? '');
  if (!ISO_RE.test(startDate) || !ISO_RE.test(examDate)) throw new ValidationError('日期格式应为 YYYY-MM-DD');

  const totalDays = diffDays(startDate, examDate);
  if (totalDays < 20) throw new ValidationError('备考周期至少需要 3 周，请调整考试日期');
  if (totalDays > 720) throw new ValidationError('备考周期不要超过 2 年，建议分段规划');

  const hoursPerWeek = Number(input.hoursPerWeek);
  if (!Number.isFinite(hoursPerWeek) || hoursPerWeek < 3 || hoursPerWeek > 70) {
    throw new ValidationError('每周学习时长应在 3–70 小时之间');
  }

  const dailyMinutes = Number(input.dailyMinutes);
  if (!Number.isFinite(dailyMinutes) || dailyMinutes < 20 || dailyMinutes > 480) {
    throw new ValidationError('每日学习时长应在 20–480 分钟之间');
  }

  return {
    language,
    examId: exam.id,
    currentLevelId: level.id,
    targetScore: target.score,
    startDate,
    examDate,
    hoursPerWeek: Math.round(hoursPerWeek * 2) / 2,
    dailyMinutes: Math.round(dailyMinutes / 5) * 5,
  };
}

function resolveTarget(exam: ExamDef, score: number): ScoreTarget | undefined {
  if (!Number.isFinite(score)) return exam.targets[0];
  const sorted = [...exam.targets].sort(
    (a, b) => Math.abs(a.score - score) - Math.abs(b.score - score),
  );
  return sorted[0];
}

/** 目标分差换算所需投入小时 */
function requiredHours(exam: ExamDef, level: LevelDef, target: ScoreTarget, language: Language): number {
  const current = level.equiv[exam.id] ?? 0;

  if (exam.hoursModel.mode === 'levelHours') {
    const map: Record<number, string> = { 1: 'n1', 2: 'n2', 3: 'n3', 4: 'n4', 5: 'n5' };
    const targetLevel = getLanguage(language).levels.find((item) => item.id === map[target.score]);
    if (!targetLevel) return 0;
    return Math.max(0, targetLevel.hoursFromZero - level.hoursFromZero);
  }

  const gap = Math.max(0, target.score - current);
  return Math.round(gap * exam.hoursModel.perPoint);
}

function intensityFactor(hoursPerWeek: number): number {
  if (hoursPerWeek >= 18) return 1.18;
  if (hoursPerWeek >= 12) return 1.08;
  if (hoursPerWeek >= 8) return 1.0;
  return 0.92;
}

function feasibilityLevel(ratio: number): FeasibilityLevel {
  if (ratio >= 1.15) return 'comfortable';
  if (ratio >= 0.85) return 'tight';
  if (ratio >= 0.5) return 'aggressive';
  return 'unrealistic';
}

const LEVEL_TEXT: Record<FeasibilityLevel, string> = {
  comfortable: '节奏舒适',
  tight: '时间偏紧',
  aggressive: '高强度冲刺',
  unrealistic: '周期不足',
};

function buildFeasibility(
  exam: ExamDef,
  level: LevelDef,
  target: ScoreTarget,
  req: PlanRequest,
  weeks: number,
  newWordsPerDay: number,
): Feasibility {
  const required = requiredHours(exam, level, target, req.language);
  const available = Math.round(weeks * req.hoursPerWeek);
  const factor = intensityFactor(req.hoursPerWeek);
  const effective = Math.round(available * factor);
  const ratio = required <= 0 ? 1.6 : Math.min(2.2, effective / required);
  // 覆盖率 → 达标概率：以 0.8 为分水岭，做平滑映射，避免给出“非 0 即 100”的错觉
  const probability = Math.min(0.95, Math.max(0.05, 1 / (1 + Math.exp(-3.5 * (ratio - 0.8)))));
  const recommendedWeeks = Math.max(3, Math.ceil(required / Math.max(1, req.hoursPerWeek * factor)));

  const messages: string[] = [
    `本期可用学习时间约 ${available} 小时（${weeks} 周 × ${req.hoursPerWeek} 小时/周），按考纲与历年提分数据估算，从「${level.name}」冲击「${target.label}」通常需要 ${required} 小时左右。`,
    `折算后的有效学习时间约 ${effective} 小时，时间覆盖率为 ${Math.round((effective / Math.max(1, required)) * 100)}%，判定为「${LEVEL_TEXT[feasibilityLevel(ratio)]}」。`,
    `每日需新学 ${newWordsPerDay} 个词（按每周 6 个学习日计算），这是整份计划里最容易崩掉的一环。`,
  ];

  const suggestions: string[] = [];
  if (recommendedWeeks > weeks) {
    suggestions.push(
      `建议把考试日期推后到 ${addDays(req.startDate, recommendedWeeks * 7)} 之后（约 ${recommendedWeeks} 周），或把每日学习时长提升到 ${Math.min(300, Math.round((required / (weeks * 6)) * 60 / 5) * 5)} 分钟以上。`,
    );
  } else {
    suggestions.push('时间预算足够覆盖目标分差，重点应放在「输出项」（口语/写作）而不是继续刷阅读。');
  }
  if (newWordsPerDay > 45) {
    suggestions.push(
      `${newWordsPerDay} 个新词/天已超过长期记忆上限（30–40 个），建议改为「核心高频 3000 词必须四会，其余只求认读」，并把周期延长 2–3 周。`,
    );
  }
  suggestions.push('前 1/3 周期不要急着刷套题：词汇与精听的地基决定后期上限，过早模考只会打击信心。');
  suggestions.push('每周固定 1 天做「错题复盘 + 朗读录音回听」，比多刷 1 套题更能提分。');

  const milestones: Milestone[] = [];
  const currentScore = level.equiv[exam.id] ?? 0;
  if (feasibilityLevel(ratio) !== 'comfortable') {
    const midScore =
      exam.hoursModel.mode === 'perPoint'
        ? Math.round((currentScore + (target.score - currentScore) * 0.6) * 10) / 10
        : target.score;
    const midHours = Math.round(required * 0.6);
    milestones.push({
      label: exam.hoursModel.mode === 'perPoint' ? `先到 ${midScore}（阶段保底）` : '完成 60% 计划量',
      weeks: Math.max(3, Math.ceil(midHours / Math.max(1, req.hoursPerWeek * factor))),
      detail:
        exam.hoursModel.mode === 'perPoint'
          ? `把目标拆成两段：先稳定在 ${midScore} 左右，再冲 ${target.score}。两次考试分开报名往往比一次硬拼更稳。`
          : '按 60% 进度检验：语言知识与阅读正确率应稳定在 60% 以上。',
    });
  }
  milestones.push({
    label: `达成「${target.label}」`,
    weeks: Math.max(weeks, recommendedWeeks),
    detail: `按每周 ${req.hoursPerWeek} 小时、每日 ${newWordsPerDay} 个新词推进，预计 ${Math.max(weeks, recommendedWeeks)} 周完成。`,
  });

  return {
    availableHours: available,
    effectiveHours: effective,
    requiredHours: required,
    ratio: Math.round(ratio * 100) / 100,
    level: feasibilityLevel(ratio),
    probability: Math.round(probability * 100) / 100,
    recommendedWeeks,
    messages,
    suggestions,
    milestones,
  };
}

interface Copy {
  title: string;
  detail: string;
}

function taskCopy(
  language: Language,
  kind: TaskKind,
  ctx: { theme: string; newWords: number; examName: string; isReviewDay: boolean; minutes: number },
): Copy {
  const { theme, newWords, examName, minutes } = ctx;
  if (language === 'ko') {
    switch (kind) {
      case 'vocab':
        return {
          title: `새 단어 ${newWords}개＋복습`,
          detail: '先认读韩文字形（3 秒内反应出中文），再做罗马字读音自测；错词进明天队列。',
        };
      case 'grammar':
        return { title: '문법·어미 5 항목', detail: '按「助词/语尾接续 → 例句 → 近义语尾差别」三步过一遍，并各造一句。' };
      case 'read':
        return {
          title: `정독·암송: ${theme}`,
          detail: '先通读抓主旨，再逐段拆长句（先找谓语），最后出声背诵第 1–2 段。',
        };
      case 'listen':
        return { title: `듣기 정청: ${theme}`, detail: '先盲听抓大意，再逐句听写，最后对照原文标出连音与收尾音变化。' };
      case 'speak':
        return {
          title: '읽기 연습＋말하기',
          detail: '精读文跟读 2 遍（连音、语调），再就给定话题做 60 秒陈述并提交批改。',
        };
      case 'write':
        return {
          title: `쓰기 연습: ${theme}`,
          detail: '写 200–300 字议论文（主张—理由—结论三段），提交后按评价维度逐条批改。',
        };
      case 'mock':
        return { title: `${examName} 기출문제`, detail: '严格计时完成一套真题，做完立刻对答案并把错题归类。' };
      case 'review':
        return { title: '이번 주 복습', detail: '把本周错词、错题、错音各过一遍，只看错的部分。' };
      default:
        return { title: '종합 연습', detail: '按计划完成当日训练。' };
    }
  }
  if (language === 'ja') {
    switch (kind) {
      case 'vocab':
        return {
          title: `単語 ${newWords} 個＋復習`,
          detail: '先看汉字读音，再遮住中文回想释义；错词放进明天的复习队列。',
        };
      case 'grammar':
        return { title: '文法・文型 5 項目', detail: '按「接续 → 例句 → 与近义句型的差别」三步过一遍，并各造一句。' };
      case 'read':
        return {
          title: `精読・暗唱：${theme}`,
          detail: '先通读抓主旨，再逐段拆长句，最后背诵第 1–2 段（出声）。',
        };
      case 'listen':
        return { title: `聴解精聴：${theme}`, detail: '先盲听抓大意，再逐句听写，最后对照原文标出听错的音。' };
      case 'speak':
        return {
          title: '音読＋スピーチ',
          detail: '精読文を 2 回音読した後、与えられた話題で 60 秒スピーチを行い、そのまま添削に提出する。',
        };
      case 'write':
        return {
          title: `記述練習：${theme}`,
          detail: '200 字以上の意見文を書き、提出して評価観点ごとの添削を受ける（助詞・活用・語尾の統一）。',
        };
      case 'mock':
        return { title: `${examName} 過去問演習`, detail: '严格计时，做完立刻对答案并把错题归类。' };
      case 'review':
        return { title: '今週の復習', detail: '把本周错词、错题、错音各过一遍，只看错的部分。' };
      default:
        return { title: '作文練習', detail: '按题目写 200 字，写完检查助词与时态。' };
    }
  }

  switch (kind) {
    case 'vocab':
      return {
        title: `新词 ${newWords} 个 + 复习到期词`,
        detail: '先认读（3 秒内反应出中文），再做拼写自测；不熟的词进明天队列。',
      };
    case 'read':
      return {
        title: `精读背诵：${theme}`,
        detail: '逐段精读 → 查生词 → 用一句话复述段落主旨 → 背诵第 1–2 段。',
      };
    case 'listen':
      return { title: `听力精听：${theme}`, detail: '盲听抓主旨 → 逐句听写 → 对照原文标出听错的连读与弱读。' };
    case 'speak':
      return {
        title: '朗读跟读 + 口语输出',
        detail: '先跟读精读文章 3 遍（停顿、重音、语调），再就系统给出的独立口语题做 45 秒陈述并提交批改。',
      };
    case 'write':
      return {
        title: minutes >= 25 ? `写作输出：${theme}` : `段落写作：${theme}`,
        detail:
          minutes >= 25
            ? '按考试题型限时写 1 篇，提交后按内容、结构、语言、词汇四个维度逐条批改。'
            : '写 1 个主体段（80–120 词），只练「观点 + 例证」两件事，写完直接提交批改。',
      };
    case 'grammar':
      return {
        title: minutes >= 12 ? '长难句拆解 5 句' : '长难句拆解 3 句',
        detail: '标主干 → 划从句 → 翻译 → 回译比对，重点看自己译错的部分。',
      };
    case 'mock':
      return { title: `${examName} 限时模考`, detail: '严格按考试时长完成，中途不查词、不暂停。' };
    case 'review':
      return { title: '本周错题复盘', detail: '按「错因归类 → 重做 → 口头讲一遍」三步处理本周错题。' };
    default:
      return { title: '综合练习', detail: '按计划完成当日训练。' };
  }
}

const ORDER: TaskKind[] = ['vocab', 'grammar', 'read', 'listen', 'speak', 'write', 'mock', 'review'];

/** 同一周共用话题，但每天换一个论证角度，避免连续三天读同一主题的文章 */
const EN_ANGLES = ['现象与成因', '证据与论证', '对比与评价', '应用与影响', '争议与反驳', '历史与演变'];
const JA_ANGLES = ['現象と原因', 'データと根拠', '比較と評価', '応用と影響', '問題と対策', '歴史と変化'];
const KO_ANGLES = ['현상과 원인', '근거와 논증', '비교와 평가', '활용과 영향', '쟁점과 반박', '역사와 변화'];

const MIN_SLOT = 8;

/**
 * 按权重切分当日分钟数；fixed 中的任务先占固定时长，其余任务按权重分剩余时间。
 * 词汇任务的时长必须跟着「新词个数」走，否则会出现「60 个词只给 5 分钟」的荒谬安排。
 */
function allocate(
  mix: Partial<Record<TaskKind, number>>,
  total: number,
  fixed: Partial<Record<TaskKind, number>> = {},
): Array<[TaskKind, number]> {
  const entries = (Object.entries(mix) as Array<[TaskKind, number]>).filter(([, weight]) => weight > 0);
  if (entries.length === 0) return [];

  const result = new Map<TaskKind, number>();
  let remaining = total;

  for (const [kind] of entries) {
    const value = fixed[kind];
    if (value !== undefined) {
      const minutes = Math.max(MIN_SLOT, Math.min(value, remaining - MIN_SLOT * (entries.length - 1)));
      result.set(kind, minutes);
      remaining -= minutes;
    }
  }

  const flexible = entries.filter(([kind]) => !result.has(kind));
  const weightSum = flexible.reduce((acc, [, weight]) => acc + weight, 0);

  for (const [kind, weight] of flexible) {
    const raw = weightSum === 0 ? remaining / flexible.length : (weight / weightSum) * remaining;
    const minutes = Math.max(MIN_SLOT, Math.round(raw / 5) * 5);
    result.set(kind, minutes);
  }

  let diff = total - [...result.values()].reduce((acc, value) => acc + value, 0);
  let guard = 0;
  const keys = [...result.keys()];

  while (diff !== 0 && guard < 400) {
    const step = diff > 0 ? Math.min(5, diff) : Math.max(-5, diff);
    const candidates = keys.filter((key) => result.get(key)! + step >= MIN_SLOT);
    if (candidates.length === 0) break;
    const pool = diff > 0
      ? candidates
      : [...candidates].sort((a, b) => result.get(b)! - result.get(a)!);
    const target = pool[0];
    result.set(target, result.get(target)! + step);
    diff -= step;
    guard += 1;
  }

  return keys
    .map((key) => [key, result.get(key)!] as [TaskKind, number])
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
}

function reviewDayMix(phase: PhaseDef): Partial<Record<TaskKind, number>> {
  return phase.key === 'sprint'
    ? { review: 0.5, vocab: 0.25, mock: 0.25 }
    : { review: 0.6, vocab: 0.25, read: 0.15 };
}

function phaseFor(phases: PhaseDef[], ratio: number): PhaseDef {
  let current = phases[0];
  for (const phase of phases) {
    if (ratio >= phase.startRatio) current = phase;
  }
  return current;
}

export function buildPlan(req: PlanRequest): PlanDraft {
  const exam = findExam(req.examId);
  const level = findLevel(req.language, req.currentLevelId);
  const target = resolveTarget(exam, req.targetScore)!;

  const totalDays = diffDays(req.startDate, req.examDate) + 1;
  const weeks = Math.max(1, Math.ceil(totalDays / 7));
  const studyDaysPerWeek = 6;

  const vocabGap = Math.max(0, target.vocabNeed - level.vocab);
  const newWordsPerDay = Math.min(60, Math.max(8, Math.round(vocabGap / (weeks * studyDaysPerWeek))));

  const feasibility = buildFeasibility(exam, level, target, req, weeks, newWordsPerDay);

  const currentScore = level.equiv[exam.id] ?? 0;
  const fromRatio =
    exam.hoursModel.mode === 'perPoint'
      ? Math.min(0.95, currentScore / Math.max(1, target.score))
      : 0.55;

  const roadmap: Roadmap = {
    totalWeeks: weeks,
    totalHours: Math.round(weeks * req.hoursPerWeek),
    weeklyHours: req.hoursPerWeek,
    dailyMinutes: req.dailyMinutes,
    vocabGap,
    newWordsPerDay,
    sectionTargets: exam.sections.map((section) => {
      const targetScore = target.sections[section.id] ?? 0;
      return {
        id: section.id,
        name: section.name,
        from: Math.round(targetScore * fromRatio),
        target: targetScore,
      };
    }),
    phases: exam.phases.map((phase, index) => {
      const next = exam.phases[index + 1];
      const startWeek = Math.min(weeks, Math.floor(phase.startRatio * weeks) + 1);
      const endWeek = next ? Math.max(startWeek, Math.floor(next.startRatio * weeks)) : weeks;
      return {
        key: phase.key,
        name: phase.name,
        startWeek,
        endWeek,
        goal: phase.goal,
        focus: phase.focus,
      };
    }),
    syllabus: exam.syllabus,
  };

  const days: GeneratedDay[] = [];
  for (let index = 0; index < totalDays; index += 1) {
    const date = addDays(req.startDate, index);
    const weekIndex = Math.floor(index / 7);
    const dayIndex = index % 7;
    const progress = totalDays <= 1 ? 1 : index / (totalDays - 1);
    const phase = phaseFor(exam.phases, progress);
    const isReviewDay = dayIndex === 6;

    const topic = exam.topicPool[weekIndex % exam.topicPool.length];
    const angles =
      req.language === 'ja' ? JA_ANGLES : req.language === 'ko' ? KO_ANGLES : EN_ANGLES;
    const theme = isReviewDay
      ? req.language === 'ja'
        ? `今週の復習：${topic}`
        : req.language === 'ko'
          ? `이번 주 복습: ${topic}`
          : `本周复盘：${topic}`
      : `${topic} · ${angles[dayIndex % angles.length]}`;
    const mix = isReviewDay ? reviewDayMix(phase) : phase.mix;
    // 复盘日只排 60% 的时长，给大脑留出整理时间
    const dayMinutes = isReviewDay
      ? Math.max(30, Math.round((req.dailyMinutes * 0.6) / 5) * 5)
      : req.dailyMinutes;
    const vocabMinutes = Math.max(
      10,
      Math.min(
        Math.round((req.dailyMinutes * 0.45) / 5) * 5,
        Math.round((newWordsPerDay * 0.7 + 5) / 5) * 5,
      ),
    );
    const plan = allocate(mix, dayMinutes, isReviewDay ? {} : { vocab: vocabMinutes });

    const tasks: Task[] = plan.map(([kind, minutes], taskIndex) => {
      const copy = taskCopy(req.language, kind, {
        theme,
        newWords: newWordsPerDay,
        examName: exam.name,
        isReviewDay,
        minutes,
      });
      const ref =
        kind === 'read'
          ? ({ type: 'article', articleKind: 'intensive' } as const)
          : kind === 'listen'
            ? ({ type: 'article', articleKind: 'extensive' } as const)
            : kind === 'speak'
              ? ({ type: 'article', articleKind: 'intensive' } as const)
              : kind === 'vocab'
                ? ({ type: 'vocab' } as const)
                : undefined;

      return {
        id: `t${taskIndex + 1}`,
        kind,
        title: isReviewDay && kind === 'read' ? `回顾本周文章：${theme}` : copy.title,
        detail: copy.detail,
        minutes,
        done: false,
        ...(ref ? { ref } : {}),
      };
    });

    days.push({
      id: randomUUID(),
      date,
      weekIndex,
      dayIndex,
      phase: phase.key,
      phaseName: phase.name,
      theme,
      focus: phase.focus,
      tasks,
      status: 'pending',
    });
  }

  return {
    language: req.language,
    examId: exam.id,
    examName: exam.name,
    currentLevelId: level.id,
    currentLevelName: level.name,
    targetScore: target.score,
    targetLabel: target.label,
    startDate: req.startDate,
    examDate: req.examDate,
    weeks,
    hoursPerWeek: req.hoursPerWeek,
    dailyMinutes: req.dailyMinutes,
    feasibility,
    roadmap,
    days,
  };
}
