import { getLanguage, type Language } from '../catalog';
import { PATHS } from '../content/paths';
import { getActivePlan, listPlans, planProgress } from '../repositories/plans';

export type PathStepStatus = 'done' | 'current' | 'next' | 'future';

export interface PathStep {
  levelId: string;
  index: number;
  levelName: string;
  cefr: string;
  targetLabel: string;
  vocab: number;
  vocabGain: number;
  hours: number;
  weeks: number;
  weeklyVocab: number;
  passLine: string;
  examShape: string;
  focus: string[];
  method: string[];
  pitfalls: string[];
  checkpoint: string;
  motto: string;
  status: PathStepStatus;
}

export interface LearningPath {
  language: Language;
  languageName: string;
  nativeName: string;
  headline: string;
  intro: string;
  note: string;
  weeklyHours: number;
  currentIndex: number;
  steps: PathStep[];
  plan: null | {
    id: string;
    targetLabel: string;
    currentLevelName: string;
    weeks: number;
    dailyMinutes: number;
    examDate: string;
    daysLeft: number;
    completionRate: number;
    isActive: boolean;
  };
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round(
    (new Date(ty, tm - 1, td).getTime() - new Date(fy, fm - 1, fd).getTime()) / 86_400_000,
  );
}

function todayISO(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function buildLearningPath(language: Language): LearningPath {
  const langDef = getLanguage(language);
  const copy = PATHS[language];
  const active = getActivePlan();
  // 该语种的计划即使暂时被归档（首页切到另一种语言），路径上也要显示真实进度
  const plan =
    active && active.language === language
      ? active
      : listPlans().find((item) => item.language === language) ?? null;
  const currentLevelId = plan?.currentLevelId ?? null;

  const levels = new Map(langDef.levels.map((level) => [level.id, level]));
  const ladderIds = copy.ladder.map((step) => step.levelId);
  const currentIndex = currentLevelId ? ladderIds.indexOf(currentLevelId) : -1;

  const steps: PathStep[] = copy.ladder.map((step, index) => {
    const level = levels.get(step.levelId);
    // 上一级按考纲里的完整等级表取（N3 的前一级是 N4），这样词汇增量不会算成「从零开始」
    const catalogIndex = langDef.levels.findIndex((item) => item.id === step.levelId);
    const prev = catalogIndex > 0 ? langDef.levels[catalogIndex - 1] : undefined;
    const vocab = level?.vocab ?? 0;
    const vocabGain = Math.max(0, vocab - (prev?.vocab ?? 0));
    const weeks = Math.max(3, Math.round(step.hours / copy.weeklyHours));

    let status: PathStepStatus = 'future';
    if (currentIndex >= 0) {
      if (index < currentIndex) status = 'done';
      else if (index === currentIndex) status = 'current';
      else if (index === currentIndex + 1) status = 'next';
    } else if (index === 0) {
      status = 'next';
    }

    return {
      levelId: step.levelId,
      index: index + 1,
      levelName: level?.name ?? step.levelId.toUpperCase(),
      cefr: level?.cefr ?? '—',
      targetLabel: step.targetLabel,
      vocab,
      vocabGain,
      hours: step.hours,
      weeks,
      weeklyVocab: Math.max(5, Math.round(vocabGain / weeks)),
      passLine: step.passLine,
      examShape: step.examShape,
      focus: step.focus,
      method: step.method,
      pitfalls: step.pitfalls,
      checkpoint: step.checkpoint,
      motto: step.motto,
      status,
    };
  });

  const progress = plan ? planProgress(plan.id) : null;

  return {
    language,
    languageName: langDef.name,
    nativeName: langDef.nativeName,
    headline: copy.headline,
    intro: copy.intro,
    note: copy.note,
    weeklyHours: copy.weeklyHours,
    currentIndex,
    steps,
    plan: plan
      ? {
          id: plan.id,
          targetLabel: plan.targetLabel,
          currentLevelName: plan.currentLevelName,
          weeks: plan.weeks,
          dailyMinutes: plan.dailyMinutes,
          examDate: plan.examDate,
          daysLeft: Math.max(0, daysBetween(todayISO(), plan.examDate)),
          completionRate: progress ? progress.done / Math.max(1, progress.total) : 0,
          isActive: plan.status === 'active',
        }
      : null,
  };
}
