import { ValidationError } from '../lib/errors';

/** 目前支持英语、日语与韩语；各语言的词汇、内容、计划全部按这个维度隔离 */
export type Language = 'en' | 'ja' | 'ko';

export const LANGUAGES: Language[] = ['en', 'ja', 'ko'];

export const LANGUAGE_NAME: Record<Language, string> = {
  en: '英语',
  ja: '日语',
  ko: '韩语',
};

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ja' || value === 'ko';
}

export function parseLanguage(value: unknown): Language | null {
  return isLanguage(value) ? value : null;
}

/** 路由里凡是要写 vocab_items 的地方都必须过这一关，杜绝跨语种落库 */
export function requireLanguage(value: unknown): Language {
  if (isLanguage(value)) return value;
  throw new ValidationError('language 只能是 en、ja 或 ko');
}

/**
 * 语种档案：命题、批改、朗读稿、统计这些「处处都要按语种分叉」的地方，
 * 统一从这里取，而不是各自的 if 里写死一句英文。
 * 新增一门语言时，只补这里 + 对应的 rubric / 词库 / 内容库，不再各处补 else。
 */
export interface LanguageProfile {
  id: Language;
  /** 中文名，用于系统内提示文案 */
  name: string;
  /** 母语写法，用于切换与朗读 */
  nativeName: string;
  /** 提示词里指代「目标语言文本」的写法（批改要求 quote / fix 用哪种语言） */
  textLabel: string;
  /** 长度统计单位 */
  unit: 'words' | 'chars';
  /** 长度单位的中文说法 */
  unitLabel: string;
}

export const LANGUAGE_PROFILE: Record<Language, LanguageProfile> = {
  en: { id: 'en', name: '英语', nativeName: 'English', textLabel: '英文', unit: 'words', unitLabel: '词' },
  ja: { id: 'ja', name: '日语', nativeName: '日本語', textLabel: '日文', unit: 'chars', unitLabel: '字' },
  ko: { id: 'ko', name: '韩语', nativeName: '한국어', textLabel: '韩文', unit: 'words', unitLabel: '语节' },
};

export function profileOf(language: Language): LanguageProfile {
  return LANGUAGE_PROFILE[language];
}
