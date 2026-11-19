/** 音色系统共用的小工具：系统音色匹配、语言标签、文案 */
import type { Language, VoiceItem, VoiceScene } from '../types';

/** 系统自带的玩具音色，机器味极重，兜底时要避开 */
export const NOVELTY =
  /bells|bad news|good news|jester|organ|superstar|trinoids|wobble|zarvox|albert|fred|junior|kathy|ralph|princess|eddie|boo\b|bruce|agnes|deranged|hysterical|cellos|bubbles|bahh|drift|sandwich|grandma|grandpa|rocko|shelley|eddy|flo|nels|reed|bunk|evil|dummy/i;

/** 本地 Edge Neural 通道：不联网代理、不需要 Key，由服务端起 Python 合成 */
export const LOCAL_EDGE_BASE = 'local://edge';

export function isLocalEdge(baseUrl: string | undefined | null): boolean {
  return (baseUrl ?? '').trim().toLowerCase() === LOCAL_EDGE_BASE;
}

export const BCP47: Record<Language, string> = {
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

export const SCENE_LABEL: Record<VoiceScene, string> = {
  word: '单词朗读',
  sentence: '长难句朗读',
  article: '精读材料朗读',
  listening: '听力 / 精听',
};

export const SCENES: VoiceScene[] = ['word', 'sentence', 'article', 'listening'];

export const SAMPLE_TEXT: Record<Language, string> = {
  en: 'Campus life has changed dramatically over the past two decades, and universities must adapt.',
  ja: 'キャンパスの生活はこの二十年で大きく変化しました。',
  ko: '캠퍼스 생활은 이십 년 동안 크게 변화했습니다.',
};

/** 下拉框里显示的系统音色名字，去掉冗长前后缀 */
export function prettyName(voice: SpeechSynthesisVoice): string {
  return voice.name
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s*-\s*English \((United States|United Kingdom|Australia)\)/i, '')
    .replace(/\s*\(Natural\)/i, ' Natural')
    .replace(/\s*Online$/i, '')
    .trim();
}

/**
 * 把应用音色库里的「浏览器音色」解析成当前机器上真实存在的声音。
 * 顺序：voiceURI 精确 → matchHint 关键词 → 名字 → 同语种第一个正常音色。
 * 换电脑 / 系统升级后 voiceURI 会变，后两级兜底保证不会「突然没声音」。
 */
export function matchSystemVoice(
  item: VoiceItem | null,
  all: SpeechSynthesisVoice[],
  bcp47: string,
): SpeechSynthesisVoice | null {
  if (!item || item.provider !== 'browser') return null;
  const base = bcp47.slice(0, 2).toLowerCase();
  const pool = all.filter((voice) => voice.lang.toLowerCase().startsWith(base));
  if (pool.length === 0) return null;

  if (item.engineVoice) {
    const exact = pool.find((voice) => voice.voiceURI === item.engineVoice);
    if (exact) return exact;
  }
  for (const hint of item.matchHint.split('|').map((part) => part.trim()).filter(Boolean)) {
    const hit = pool.find(
      (voice) =>
        voice.name.toLowerCase().includes(hint.toLowerCase()) ||
        voice.voiceURI.toLowerCase().includes(hint.toLowerCase()),
    );
    if (hit) return hit;
  }
  const byName = pool.find((voice) => voice.name.toLowerCase() === item.name.toLowerCase());
  if (byName) return byName;
  return pool.find((voice) => !NOVELTY.test(voice.name)) ?? pool[0] ?? null;
}
