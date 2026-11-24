import { EN_EXAMS, EN_LEVELS } from './en';
import { JA_EXAMS, JA_LEVELS } from './ja';
import { KO_EXAMS, KO_LEVELS } from './ko';
import type { ExamDef, Language, LevelDef } from './types';

export * from './types';

export interface LanguageDef {
  id: Language;
  name: string;
  nativeName: string;
  levels: LevelDef[];
  exams: ExamDef[];
  /** 语音合成使用的 BCP-47 语言标签 */
  speechLang: string;
}

export const CATALOG: Record<Language, LanguageDef> = {
  en: {
    id: 'en',
    name: '英语',
    nativeName: 'English',
    levels: EN_LEVELS,
    exams: EN_EXAMS,
    speechLang: 'en-US',
  },
  ja: {
    id: 'ja',
    name: '日语',
    nativeName: '日本語',
    levels: JA_LEVELS,
    exams: JA_EXAMS,
    speechLang: 'ja-JP',
  },
  ko: {
    id: 'ko',
    name: '韩语',
    nativeName: '한국어',
    levels: KO_LEVELS,
    exams: KO_EXAMS,
    speechLang: 'ko-KR',
  },
};

export function getLanguage(id: string): LanguageDef {
  const lang = CATALOG[id as Language];
  if (!lang) throw new Error(`未知语言：${id}`);
  return lang;
}

export function findExam(examId: string): ExamDef {
  for (const lang of Object.values(CATALOG)) {
    const exam = lang.exams.find((item) => item.id === examId);
    if (exam) return exam;
  }
  throw new Error(`未知考试：${examId}`);
}

/**
 * 某个考试属于哪门语言；未知考试返回 null。
 * 命题 / 评分要按「当前计划语种」走，不能只看 examId——
 * 否则历史上存下来的跨语种 examId 会把托福的模板套到韩语计划上。
 */
export function findExamLanguage(examId: string): Language | null {
  for (const lang of Object.values(CATALOG)) {
    if (lang.exams.some((item) => item.id === examId)) return lang.id;
  }
  return null;
}

export function findLevel(language: Language, levelId: string): LevelDef {
  const level = CATALOG[language].levels.find((item) => item.id === levelId);
  if (!level) throw new Error(`未知等级：${levelId}`);
  return level;
}

/** 对外暴露的目录摘要（前端下拉框使用） */
export function catalogSummary() {
  return {
    languages: Object.values(CATALOG).map((lang) => ({
      id: lang.id,
      name: lang.name,
      nativeName: lang.nativeName,
      speechLang: lang.speechLang,
      levels: lang.levels.map((level) => ({
        id: level.id,
        name: level.name,
        cefr: level.cefr,
        vocab: level.vocab,
        note: level.note,
      })),
      exams: lang.exams.map((exam) => ({
        id: exam.id,
        name: exam.name,
        provider: exam.provider,
        scaleLabel: exam.scaleLabel,
        scaleNote: exam.scaleNote,
        sections: exam.sections,
        targets: exam.targets.map((t) => ({
          score: t.score,
          label: t.label,
          sections: t.sections,
          vocabNeed: t.vocabNeed,
          note: t.note,
        })),
        syllabus: exam.syllabus,
      })),
    })),
  };
}
