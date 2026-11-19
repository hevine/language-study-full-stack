/**
 * 音色库仓储。
 *
 * 两个硬约定：
 * 1) 所有读写都必须带 user_id + language，任何跨语种的查询都拿不到别人的音色；
 * 2) 系统音色只是「引用」浏览器/操作系统里的声音，删记录不会动系统设置。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import type { Language } from '../domain/language';

export type VoiceProvider = 'browser' | 'cloud';
export type VoiceSource = 'system' | 'preset' | 'ai' | 'custom';
export type VoiceScene = 'word' | 'sentence' | 'article' | 'listening';

export const VOICE_SCENES: VoiceScene[] = ['word', 'sentence', 'article', 'listening'];

export const SCENE_LABEL: Record<VoiceScene, string> = {
  word: '单词朗读',
  sentence: '长难句朗读',
  article: '精读材料朗读',
  listening: '听力 / 精听',
};

export const BCP47: Record<Language, string> = {
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

export const SAMPLE_TEXT: Record<Language, string> = {
  en: 'Campus life has changed dramatically over the past two decades, and universities must adapt.',
  ja: 'キャンパスの生活はこの二十年で大きく変化しました。',
  ko: '캠퍼스 생활은 이십 년 동안 크게 변화했습니다.',
};

export interface VoiceRecord {
  id: string;
  userId: string;
  language: Language;
  name: string;
  provider: VoiceProvider;
  /** browser: 系统音色的 voiceURI；cloud: 兼容字段，一般留空 */
  engineVoice: string;
  /** 换机器后 voiceURI 会变，用名字关键词兜底重新匹配 */
  matchHint: string;
  /** cloud: TTS 模型名 */
  model: string;
  /** cloud: OpenAI 兼容服务地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  /** cloud: 加密后的 Key，绝不回传前端明文 */
  apiKey: string;
  /** cloud: 平台音色 id，例如 nova / alloy */
  voiceId: string;
  /** cloud: 风格指令（gpt-4o-mini-tts 的 instructions） */
  style: string;
  /** 人设 / 听感描述，纯展示用 */
  persona: string;
  tags: string[];
  rate: number;
  pitch: number;
  volume: number;
  source: VoiceSource;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type VoiceInput = Omit<
  VoiceRecord,
  'id' | 'userId' | 'language' | 'createdAt' | 'updatedAt' | 'isDefault'
>;

export type VoicePatch = Partial<VoiceInput>;

interface VoiceRow {
  id: string;
  user_id: string;
  language: Language;
  name: string;
  provider: VoiceProvider;
  engine_voice: string;
  match_hint: string;
  model: string;
  base_url: string;
  api_key: string;
  voice_id: string;
  style: string;
  persona: string;
  tags: string;
  rate: number;
  pitch: number;
  volume: number;
  source: VoiceSource;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function parseTags(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toRecord(row: VoiceRow): VoiceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    language: row.language,
    name: row.name,
    provider: row.provider,
    engineVoice: row.engine_voice,
    matchHint: row.match_hint,
    model: row.model,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    voiceId: row.voice_id,
    style: row.style,
    persona: row.persona,
    tags: parseTags(row.tags),
    rate: row.rate,
    pitch: row.pitch,
    volume: row.volume,
    source: row.source,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_INPUT: VoiceInput = {
  name: '新音色',
  provider: 'browser',
  engineVoice: '',
  matchHint: '',
  model: '',
  baseUrl: '',
  apiKey: '',
  voiceId: '',
  style: '',
  persona: '',
  tags: [],
  rate: 0.9,
  pitch: 1,
  volume: 1,
  source: 'custom',
};

function toParams(input: VoiceInput) {
  return {
    name: input.name,
    provider: input.provider,
    engineVoice: input.engineVoice,
    matchHint: input.matchHint,
    model: input.model,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    voiceId: input.voiceId,
    style: input.style,
    persona: input.persona,
    tags: JSON.stringify(input.tags),
    rate: input.rate,
    pitch: input.pitch,
    volume: input.volume,
    source: input.source,
  };
}

export function listVoices(userId: string, language: Language): VoiceRecord[] {
  const rows = db
    .prepare('SELECT * FROM voices WHERE user_id = ? AND language = ? ORDER BY is_default DESC, created_at ASC')
    .all(userId, language) as VoiceRow[];
  return rows.map(toRecord);
}

export function countVoices(userId: string, language: Language): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM voices WHERE user_id = ? AND language = ?')
    .get(userId, language) as { n: number };
  return row.n;
}

export function getVoice(userId: string, language: Language, id: string): VoiceRecord | null {
  const row = db
    .prepare('SELECT * FROM voices WHERE id = ? AND user_id = ? AND language = ?')
    .get(id, userId, language) as VoiceRow | undefined;
  return row ? toRecord(row) : null;
}

export function insertVoice(
  userId: string,
  language: Language,
  input: VoiceInput,
  options: { id?: string; isDefault?: boolean } = {},
): VoiceRecord {
  const id = options.id ?? randomUUID();
  const now = new Date().toISOString();
  const merged: VoiceInput = { ...DEFAULT_INPUT, ...input };
  const p = toParams(merged);
  db.prepare(
    `INSERT INTO voices
      (id, user_id, language, name, provider, engine_voice, match_hint, model, base_url, api_key,
       voice_id, style, persona, tags, rate, pitch, volume, source, is_default, created_at, updated_at)
     VALUES (@id, @userId, @language, @name, @provider, @engineVoice, @matchHint, @model, @baseUrl, @apiKey,
       @voiceId, @style, @persona, @tags, @rate, @pitch, @volume, @source, @isDefault, @now, @now)`,
  ).run({
    id,
    userId,
    language,
    ...p,
    isDefault: options.isDefault ? 1 : 0,
    now,
  });
  return getVoice(userId, language, id) as VoiceRecord;
}

export function updateVoice(
  userId: string,
  language: Language,
  id: string,
  patch: VoicePatch,
): VoiceRecord | null {
  const current = getVoice(userId, language, id);
  if (!current) return null;
  const merged: VoiceInput = {
    name: patch.name ?? current.name,
    provider: patch.provider ?? current.provider,
    engineVoice: patch.engineVoice ?? current.engineVoice,
    matchHint: patch.matchHint ?? current.matchHint,
    model: patch.model ?? current.model,
    baseUrl: patch.baseUrl ?? current.baseUrl,
    apiKey: patch.apiKey ?? current.apiKey,
    voiceId: patch.voiceId ?? current.voiceId,
    style: patch.style ?? current.style,
    persona: patch.persona ?? current.persona,
    tags: patch.tags ?? current.tags,
    rate: patch.rate ?? current.rate,
    pitch: patch.pitch ?? current.pitch,
    volume: patch.volume ?? current.volume,
    source: patch.source ?? current.source,
  };
  const p = toParams(merged);
  db.prepare(
    `UPDATE voices SET name=@name, provider=@provider, engine_voice=@engineVoice, match_hint=@matchHint,
       model=@model, base_url=@baseUrl, api_key=@apiKey, voice_id=@voiceId, style=@style,
       persona=@persona, tags=@tags, rate=@rate, pitch=@pitch, volume=@volume, source=@source,
       updated_at=@now
     WHERE id=@id AND user_id=@userId AND language=@language`,
  ).run({ ...p, id, userId, language, now: new Date().toISOString() });
  return getVoice(userId, language, id);
}

/** 只删应用内的这条记录；系统里安装的声音不受影响 */
export function deleteVoice(userId: string, language: Language, id: string): boolean {
  const removed = db
    .prepare('DELETE FROM voices WHERE id = ? AND user_id = ? AND language = ?')
    .run(id, userId, language);
  if (removed.changes === 0) return false;
  db.prepare(
    "UPDATE voice_assignments SET voice_id = NULL, updated_at = ? WHERE user_id = ? AND language = ? AND voice_id = ?",
  ).run(new Date().toISOString(), userId, language, id);
  return true;
}

/** 设默认：同语种内只允许一个，并把没有显式分配的场景也指向它 */
export function setDefaultVoice(userId: string, language: Language, id: string): VoiceRecord | null {
  const target = getVoice(userId, language, id);
  if (!target) return null;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE voices SET is_default = 0, updated_at = ? WHERE user_id = ? AND language = ?').run(
      now,
      userId,
      language,
    );
    db.prepare('UPDATE voices SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ? AND language = ?').run(
      now,
      id,
      userId,
      language,
    );
  })();
  return getVoice(userId, language, id);
}

export type VoiceAssignments = Record<VoiceScene, string | null>;

export function getAssignments(userId: string, language: Language): VoiceAssignments {
  const result: VoiceAssignments = { word: null, sentence: null, article: null, listening: null };
  const rows = db
    .prepare('SELECT scene, voice_id FROM voice_assignments WHERE user_id = ? AND language = ?')
    .all(userId, language) as Array<{ scene: VoiceScene; voice_id: string | null }>;
  for (const row of rows) {
    if (VOICE_SCENES.includes(row.scene)) result[row.scene] = row.voice_id;
  }
  return result;
}

export function setAssignments(
  userId: string,
  language: Language,
  patch: Partial<VoiceAssignments>,
): VoiceAssignments {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO voice_assignments (user_id, language, scene, voice_id, updated_at)
     VALUES (@userId, @language, @scene, @voiceId, @now)
     ON CONFLICT(user_id, language, scene) DO UPDATE SET voice_id = excluded.voice_id, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const scene of VOICE_SCENES) {
      if (!(scene in patch)) continue;
      const voiceId = patch[scene] ?? null;
      // 只允许指向本语种的音色，杜绝跨语种串音
      if (voiceId && !getVoice(userId, language, voiceId)) continue;
      stmt.run({ userId, language, scene, voiceId, now });
    }
  })();
  return getAssignments(userId, language);
}

export interface VoicePrefs {
  sampleText: string;
  globalRate: number;
}

export function getPrefs(userId: string, language: Language): VoicePrefs {
  const row = db
    .prepare('SELECT sample_text, global_rate FROM voice_prefs WHERE user_id = ? AND language = ?')
    .get(userId, language) as { sample_text: string; global_rate: number } | undefined;
  return {
    sampleText: row?.sample_text || SAMPLE_TEXT[language],
    globalRate: row?.global_rate ?? 0.9,
  };
}

export function setPrefs(userId: string, language: Language, patch: Partial<VoicePrefs>): VoicePrefs {
  const current = getPrefs(userId, language);
  db.prepare(
    `INSERT INTO voice_prefs (user_id, language, sample_text, global_rate, updated_at)
     VALUES (@userId, @language, @sampleText, @globalRate, @now)
     ON CONFLICT(user_id, language) DO UPDATE SET sample_text = excluded.sample_text,
       global_rate = excluded.global_rate, updated_at = excluded.updated_at`,
  ).run({
    userId,
    language,
    sampleText: (patch.sampleText ?? current.sampleText).slice(0, 600),
    globalRate: patch.globalRate ?? current.globalRate,
    now: new Date().toISOString(),
  });
  return getPrefs(userId, language);
}

