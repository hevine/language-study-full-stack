/**
 * 主题 = Apple 系统配色（iOS 浅色模式）的几款常用色。
 * CSS 侧在 styles.css 里用 [data-theme="x"] 覆盖变量，这里只负责选择、持久化与写入 DOM。
 */

export type ThemeId =
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'teal'
  | 'green'
  | 'orange'
  | 'graphite';

export interface ThemeDef {
  id: ThemeId;
  name: string;
  en: string;
  /** 用于色点展示的主色 */
  swatch: string;
  hint: string;
}

export const THEMES: ThemeDef[] = [
  { id: 'blue', name: '海湾蓝', en: 'Blue', swatch: '#0a6cff', hint: '系统蓝，最中性耐看，英语模式默认' },
  { id: 'indigo', name: '午夜靛', en: 'Indigo', swatch: '#5856d6', hint: '偏冷静，长时间阅读不刺眼' },
  { id: 'purple', name: '紫罗兰', en: 'Purple', swatch: '#af52de', hint: '带一点文学气，适合写作日' },
  { id: 'pink', name: '樱花粉', en: 'Pink', swatch: '#ff2d55', hint: '日语模式默认，和风暖调' },
  { id: 'teal', name: '青瓷', en: 'Teal', swatch: '#30b0c7', hint: '最通透，玻璃层次感最强，韩语模式默认' },
  { id: 'green', name: '苔绿', en: 'Green', swatch: '#34c759', hint: '低刺激，适合长时间背诵' },
  { id: 'orange', name: '琥珀', en: 'Orange', swatch: '#ff9500', hint: '偏暖，冲刺期有推进感' },
  { id: 'graphite', name: '石墨', en: 'Graphite', swatch: '#8e8e93', hint: '最克制，接近纸张' },
];

export type Language = 'en' | 'ja' | 'ko';

/** 未手动指定时，按语种自动适配 */
export const DEFAULT_THEME: Record<Language, ThemeId> = { en: 'blue', ja: 'pink', ko: 'teal' };

const STORAGE_KEY = 'wb-theme';

type Overrides = Partial<Record<Language, ThemeId>>;

function readOverrides(): Overrides {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Overrides;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverrides(next: Overrides): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value);
}

/** 当前语种生效的主题：手动选择优先，否则按语种默认 */
export function resolveTheme(language: Language): ThemeId {
  const manual = readOverrides()[language];
  return isThemeId(manual) ? manual : DEFAULT_THEME[language];
}

/** 该语种是否仍在「跟随语种」状态 */
export function isAutoTheme(language: Language): boolean {
  return !isThemeId(readOverrides()[language]);
}

export function saveTheme(language: Language, id: ThemeId): void {
  writeOverrides({ ...readOverrides(), [language]: id });
}

/** 回到跟随语种 */
export function resetTheme(language: Language): void {
  const next = { ...readOverrides() };
  delete next[language];
  writeOverrides(next);
}

export function applyTheme(id: ThemeId): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = id;
  // 主题都是浅色系，锁定表单控件的配色避免系统深色模式把输入框变黑
  document.documentElement.style.colorScheme = 'light';
}

export function themeById(id: ThemeId): ThemeDef {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
