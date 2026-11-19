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
