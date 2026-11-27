import type {
  ActivePlanResponse,
  AttemptSummary,
  Catalog,
  Day,
  DayResponse,
  EdgeTtsStatus,
  GradeResponse,
  LearningPath,
  Plan,
  PracticeAttempt,
  PracticeBriefResponse,
  PracticeOverview,
  PracticeStats,
  MaterialSummary,
  MaterialsResponse,
  MaterialUploadResponse,
  ListeningMaterial,
  ListeningMaterialUploadResponse,
  ListeningMaterialsResponse,
  SettingsResponse,
  Stats,
  ExamCalendar,
  ExamSessionsResponse,
  LexiconResponse,
  LlmPoolKey,
  AiGenerateResponse,
  AiStats,
  TaskDetailResponse,
  VocabWord,
  VoiceAssignmentMap,
  VoiceCandidate,
  VoiceDiscoverResponse,
  VoiceDraft,
  VoicePrefs,
  VoicesResponse,
  AuthConfig,
  AuthSession,
  AuthUser,
  AsrSettingsView,
  AsrPoolKey,
  AsrPingResult,
  LocalAsrStatus,
  TranscribeResult,
  ClaimTableCount,
  QrPollResponse,
  QrStartResponse,
  RegisterInput,
  RegisterResponse,
  TokenResponse,
  AuthProviderId,
  AuthRole,
  JlptLevel,
  ExplainVideoLike,
  ExplainDepth,
  ExplainDepthEstimate,
  ExplainEstimateResponse,
  ExplainCoachMode,
  ExplainExportTrack,
  ExplainVideoSummary,
} from './types';
import type {
  AgentAdoptInput,
  AgentAdoptResult,
  AgentEvent,
  AgentRun,
  AgentRunInput,
  AgentRunSummary,
  AgentScenesResponse,
  ExplainJobState,
} from './agentTypes';

const BASE = '/api';

/** 登录态丢失（刷新令牌也失效）时广播，由 AuthProvider 统一跳转到登录页 */
export const AUTH_LOST_EVENT = 'wb:auth-lost';

/** access token 只存在内存里：刷新页面靠 HttpOnly Cookie 静默换回，绝不写入 localStorage */
let accessToken: string | null = null;
export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 服务端判定「请求语种 ≠ 当前激活计划语种」时的错误码，前端据此整体纠偏 */
export const LANGUAGE_MISMATCH_CODE = 'LANGUAGE_MISMATCH';
export const LANGUAGE_MISMATCH_EVENT = 'app:language-mismatch';

/** 给 GET 请求带上当前语种：服务端据此挡住切换前发出的旧请求 */
function withLang(path: string, language?: string): string {
  if (!language) return path;
  return `${path}${path.includes('?') ? '&' : '?'}language=${encodeURIComponent(language)}`;
}

/** 并发刷新合并为一次请求，避免 401 风暴把限流打满 */
let refreshInFlight: Promise<TokenResponse | null> | null = null;

export function refreshSilently(): Promise<TokenResponse | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) return null;
      const data = (await response.json()) as TokenResponse;
      accessToken = data.accessToken;
      return data;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function rawRequest<T>(path: string, init: RequestInit = {}, retries = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        ...init,
        credentials: 'include',
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { code?: string; message?: string; details?: unknown } }
          | null;
        const message = payload?.error?.message ?? `请求失败（${response.status}）`;
        const code = payload?.error?.code ?? 'UNKNOWN';
        const error = new ApiError(message, response.status, code, payload?.error?.details);
        // 语种冲突：说明界面还停在旧语种，通知全局按当前计划重新取数（不重试，避免死循环）
        if (code === LANGUAGE_MISMATCH_CODE) {
          window.dispatchEvent(new CustomEvent(LANGUAGE_MISMATCH_EVENT, { detail: payload?.error?.details }));
        }
        // 4xx 不重试，5xx 最多再试 retries 次
        if (response.status >= 500 && attempt < retries) {
          lastError = error;
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw error;
      }

      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      lastError = err;
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new ApiError('无法连接本地服务，请确认后端已启动', 0, 'NETWORK_ERROR');
    }
  }

  throw lastError instanceof ApiError
    ? lastError
    : new ApiError('请求失败', 0, 'UNKNOWN');
}

/** 文件上传 / 音频合成等不走 request() 的请求，也要带令牌并在 401 时刷新一次 */
async function fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
  const build = (): RequestInit => ({
    ...init,
    credentials: 'include',
    headers: {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  let response = await fetch(url, build());
  if (response.status === 401) {
    const refreshed = await refreshSilently();
    if (refreshed) response = await fetch(url, build());
    else {
      setAccessToken(null);
      window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    }
  }
  return response;
}

/** 401 自动刷新一次并重试；刷新也失败才广播登录态丢失 */
async function request<T>(path: string, init: RequestInit = {}, retries = 2): Promise<T> {
  try {
    return await rawRequest<T>(path, init, retries);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !path.startsWith('/auth/')) {
      const refreshed = await refreshSilently();
      if (refreshed) return rawRequest<T>(path, init, retries);
      setAccessToken(null);
      window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    }
    throw err;
  }
}

export const api = {
  // ---- 用户与鉴权 ----
  authConfig: () => request<AuthConfig>('/auth/config', {}, 0),

  authLogin: (username: string, password: string) =>
    request<TokenResponse>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      0,
    ),

  authRegister: (input: RegisterInput) =>
    request<RegisterResponse>(
      '/auth/register',
      { method: 'POST', body: JSON.stringify(input) },
      0,
    ),

  authUpdateMe: (patch: { displayName?: string; avatarUrl?: string | null }) =>
    request<{ user: AuthUser }>(
      '/auth/me',
      { method: 'PATCH', body: JSON.stringify(patch) },
      0,
    ),

  authChangePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>(
      '/auth/password',
      { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) },
      0,
    ),

  authGuestData: () =>
    request<{ tables: ClaimTableCount[] }>('/auth/guest-data', {}, 0),

  authClaimGuest: () =>
    request<{ result: Array<{ table: string; moved: number }>; total: number }>(
      '/auth/claim-guest',
      { method: 'POST', body: '{}' },
      0,
    ),

  authLogout: () =>
    request<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' }, 0),

  authMe: () => request<{ user: AuthUser }>('/auth/me', {}, 0),

  authQrStart: (provider: AuthProviderId, bind = false) =>
    request<QrStartResponse>(
      '/auth/qr/start',
      { method: 'POST', body: JSON.stringify({ provider, bind }) },
      0,
    ),

  authQrPoll: (ticketId: string, secret: string) =>
    request<QrPollResponse>(
      `/auth/qr/${encodeURIComponent(ticketId)}`,
      { headers: { 'x-ticket-secret': secret } },
      0,
    ),

  authQrExchange: (ticketId: string, ticketSecret: string) =>
    request<TokenResponse>(
      '/auth/qr/exchange',
      { method: 'POST', body: JSON.stringify({ ticketId, ticketSecret }) },
      0,
    ),

  authSessions: () => request<{ sessions: AuthSession[] }>('/auth/sessions', {}, 0),

  authRevokeSession: (id: string) =>
    request<{ ok: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, 0),

  authAdminUsers: () =>
    request<{ users: Array<AuthUser & { sessionCount: number }>; total: number }>(
      '/auth/admin/users',
      {},
      0,
    ),

  authAdminCreateUser: (input: {
    username: string;
    password: string;
    displayName?: string;
    role?: AuthRole;
    jlptLevel?: JlptLevel;
  }) =>
    request<{ user: AuthUser }>(
      '/auth/admin/users',
      { method: 'POST', body: JSON.stringify(input) },
      0,
    ),

  authAdminPatchUser: (
    id: string,
    patch: { role?: AuthRole; status?: 'active' | 'pending' | 'disabled'; displayName?: string },
  ) =>
    request<{ user: AuthUser }>(
      `/auth/admin/users/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      0,
    ),

  authAdminResetPassword: (id: string, password: string) =>
    request<{ user: AuthUser }>(
      `/auth/admin/users/${encodeURIComponent(id)}/password`,
      { method: 'POST', body: JSON.stringify({ password }) },
      0,
    ),

  catalog: () => request<Catalog>('/catalog'),

  activePlan: () => request<ActivePlanResponse>('/plans/active'),

  createPlan: (input: {
    language: string;
    examId: string;
    currentLevelId: string;
    targetScore: number;
    startDate: string;
    examDate: string;
    hoursPerWeek: number;
    dailyMinutes: number;
  }) => request<{ plan: Plan }>('/plans', { method: 'POST', body: JSON.stringify(input) }, 0),

  archivePlan: (id: string) => request<{ ok: boolean }>(`/plans/${id}/archive`, { method: 'POST' }),

  plans: () => request<{ plans: Plan[] }>('/plans'),

  activatePlan: (id: string) =>
    request<{ plan: Plan }>(`/plans/${id}/activate`, { method: 'POST' }, 0),

  learningPath: (language: string) =>
    request<LearningPath>(`/paths/${language}`, {}, 1),

  day: (date: string, language?: string) => request<DayResponse>(withLang(`/days/${date}`, language), {}, 1),

  dayBrief: (date: string, language?: string) =>
    request<DayResponse>(withLang(`/days/${date}?brief=1`, language), {}, 1),

  toggleTask: (date: string, taskId: string, done: boolean, minutes?: number) =>
    request<{ day: Day }>(`/days/${date}/tasks/${taskId}`, {
      method: 'POST',
      body: JSON.stringify(minutes ? { done, minutes } : { done }),
    }),

  taskDetail: (date: string, taskId: string, language?: string) =>
    request<TaskDetailResponse>(withLang(`/tasks/${date}/${taskId}`, language), {}, 1),

  resetDay: (date: string) => request<{ day: Day }>(`/days/${date}/reset`, { method: 'POST' }),

  /** 统计按语种隔离：不传则跟随服务端当前激活计划 */
  stats: (language?: string) =>
    request<Stats>(`/stats${language ? `?language=${language}` : ''}`),

  vocabDue: (language?: string, limit = 30) =>
    request<{ words: VocabWord[] }>(
      `/vocab/due?limit=${limit}${language ? `&language=${language}` : ''}`,
    ),

  vocab: (language?: string, q?: string, level?: string) =>
    request<{ words: VocabWord[]; stats: { total: number; due: number; mastered: number } }>(
      `/vocab?limit=300${language ? `&language=${language}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}${level ? `&level=${encodeURIComponent(level)}` : ''}`,
    ),

  review: (id: string, grade: number, language?: string) =>
    request<{ next: { intervalDays: number; dueDate: string } }>(`/vocab/${id}/review`, {
      method: 'POST',
      body: JSON.stringify(language ? { grade, language } : { grade }),
    }),

  /** 报考日历：报名 / 选考场 / 准考证 / 费用 */
  examCalendar: (examId: string, examDate: string) =>
    request<ExamCalendar>(`/exam-calendar?examId=${examId}&examDate=${examDate}`),

  planCalendar: (planId: string) =>
    request<ExamCalendar>(`/exam-calendar/plan/${planId}`),

  /** 真实考试场次：选「哪一年哪一月的那一场」 */
  examSessions: (examId: string, years = 3) =>
    request<ExamSessionsResponse>(`/exam-sessions?examId=${examId}&years=${years}`),

  /** 分级词库：每个级别的收录量、已进词汇本数量、词条列表 */
  lexicon: (language: string, level?: string, q?: string) =>
    request<LexiconResponse>(
      `/lexicon?language=${language}${level ? `&level=${encodeURIComponent(level)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    ),

  importLevel: (language: string, level: string) =>
    request<{ added: number; skipped: number; stats: { total: number; due: number; mastered: number } }>(
      '/lexicon/import',
      { method: 'POST', body: JSON.stringify({ language, level }) },
    ),

  /** 「换一篇」：清掉当日缓存材料，强制让大模型按当日考纲重新生成 */
  regenerateDay: (date: string, language?: string) =>
    request<{ source: string; notice: string | null; titles: Array<{ kind: string; title: string }> }>(
      withLang(`/tasks/${date}/regenerate`, language),
      { method: 'POST' },
      0,
    ),

  materials: (language: string) => request<MaterialsResponse>(`/materials?language=${language}`),

  materialDetail: (id: string) =>
    request<{
      material: MaterialSummary;
      units: Array<{ idx: number; title: string; charCount: number; pageFrom: number | null; pageTo: number | null }>;
    }>(`/materials/${id}`),

  /** 上传本地电子书：直接以文件字节作为请求体，文件名走 query，避免引入 multipart */
  uploadMaterial: async (
    file: File,
    language: string,
    options: { title?: string; level?: string; kind?: string } = {},
  ): Promise<MaterialUploadResponse> => {
    const query = new URLSearchParams({
      language,
      name: file.name,
      ...(options.title ? { title: options.title } : {}),
      ...(options.level ? { level: options.level } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    });
    const response = await fetchWithAuth(`${BASE}/materials?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw new ApiError(
        payload?.error?.message ?? `导入失败（${response.status}）`,
        response.status,
        payload?.error?.code ?? 'UPLOAD_FAILED',
      );
    }
    return (await response.json()) as MaterialUploadResponse;
  },

  // ---- 听力库：服务端按账号隔离的整段音频 ----
  listeningMaterials: (language: string) =>
    request<ListeningMaterialsResponse>(`/listening/materials?language=${language}`),

  uploadListeningMaterial: async (
    file: File,
    language: string,
    options: { title?: string; durationSec?: number } = {},
  ): Promise<ListeningMaterialUploadResponse> => {
    const query = new URLSearchParams({
      language,
      name: file.name,
      ...(options.title ? { title: options.title } : {}),
      ...(options.durationSec ? { durationSec: String(options.durationSec) } : {}),
    });
    const response = await fetchWithAuth(`${BASE}/listening/materials?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw new ApiError(
        payload?.error?.message ?? `上传失败（${response.status}）`,
        response.status,
        payload?.error?.code ?? 'UPLOAD_FAILED',
      );
    }
    return (await response.json()) as ListeningMaterialUploadResponse;
  },

  /** 播放器不能自带 Authorization 头，先带鉴权取回文件字节再生成临时对象 URL */
  downloadListeningMaterial: async (id: string): Promise<Blob> => {
    const response = await fetchWithAuth(`${BASE}/listening/materials/${encodeURIComponent(id)}/file`, {});
    if (!response.ok) throw new ApiError(`读取音频失败（${response.status}）`, response.status, 'FETCH_FAILED');
    return response.blob();
  },

  renameListeningMaterial: (id: string, title: string) =>
    request<{ material: ListeningMaterial }>(
      `/listening/materials/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
      0,
    ),

  deleteListeningMaterial: (id: string) =>
    request<{ ok: boolean }>(
      `/listening/materials/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      0,
    ),

  activateMaterial: (id: string, active: boolean) =>
    request<{ ok: boolean; active: boolean }>(
      `/materials/${id}/activate`,
      { method: 'POST', body: JSON.stringify({ active }) },
      0,
    ),

  deleteMaterial: (id: string) => request<{ ok: boolean }>(`/materials/${id}`, { method: 'DELETE' }, 0),

  enrichMaterial: (id: string) =>
    request<{ ok: boolean; updated: number; message: string }>(
      `/materials/${id}/enrich`,
      { method: 'POST', body: JSON.stringify({ limit: 40 }) },
      0,
    ),

  settings: () => request<SettingsResponse>('/settings'),

  /** 兼容旧版单线路设置入口（新界面走 /settings/asr/keys） */
  saveAsrSettings: (input: { baseUrl: string; model: string; apiKey?: string }) =>
    request<{ asr: AsrSettingsView }>('/settings/asr', { method: 'PUT', body: JSON.stringify(input) }, 0),

  /* ---- 语音识别号池 ---- */
  /** 本地兜底服务的实时状态（不拉起进程） */
  localAsrStatus: () => request<LocalAsrStatus>('/settings/asr/local', {}, 0),
  /** 手动启动本地兜底服务 */
  startLocalAsr: () => request<LocalAsrStatus>('/settings/asr/local/start', { method: 'POST' }, 0),
  addAsrKey: (input: {
    label?: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    persist?: boolean;
    enabled?: boolean;
  }) => request<{ key: AsrPoolKey; asr: AsrSettingsView }>(
    '/settings/asr/keys',
    { method: 'POST', body: JSON.stringify(input) },
    0,
  ),

  updateAsrKey: (id: string, patch: {
    label?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    persist?: boolean;
    enabled?: boolean;
  }) => request<{ key: AsrPoolKey; asr: AsrSettingsView }>(
    `/settings/asr/keys/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(patch) },
    0,
  ),

  deleteAsrKey: (id: string) =>
    request<{ ok: boolean; asr: AsrSettingsView }>(
      `/settings/asr/keys/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      0,
    ),

  resetAsrKey: (id: string) =>
    request<{ ok: boolean; asr: AsrSettingsView }>(
      `/settings/asr/keys/${encodeURIComponent(id)}/reset`,
      { method: 'POST' },
      0,
    ),

  reorderAsrKeys: (ids: string[]) =>
    request<{ ok: boolean; asr: AsrSettingsView }>(
      '/settings/asr/keys/order',
      { method: 'PUT', body: JSON.stringify({ ids }) },
      0,
    ),

  /** 测试已保存的线路（不传 Key 时沿用其已保存的 Key） */
  testAsrKey: (id: string) =>
    request<AsrPingResult>(`/settings/asr/keys/${encodeURIComponent(id)}/test`, { method: 'POST' }, 0),

  /** 测试表单里正在填、尚未保存的值 */
  testAsrDraft: (input: { keyId?: string; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<AsrPingResult>('/settings/asr/test', { method: 'POST', body: JSON.stringify(input) }, 0),

  /**
   * 录音转写：把录到的音频字节发给服务端 ASR，按目标语言识别成文本。
   * 走 fetchWithAuth（带令牌 + 401 刷新），因为 request() 会强制 json content-type。
   */
  transcribeAudio: async (audio: Blob, language: string, name = 'recording.webm'): Promise<TranscribeResult> => {
    const query = new URLSearchParams({ language, name });
    const response = await fetchWithAuth(`${BASE}/asr?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: audio,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw new ApiError(
        payload?.error?.message ?? `转写失败（${response.status}）`,
        response.status,
        payload?.error?.code ?? 'ASR_FAILED',
      );
    }
    return (await response.json()) as TranscribeResult;
  },

  saveSettings: (input: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    providerId?: string;
    displayName?: string;
    goalNote?: string;
  }) => request<SettingsResponse>('/settings', { method: 'PUT', body: JSON.stringify(input) }, 0),

  testLlm: (input: { keyId?: string; baseUrl?: string; model?: string; apiKey?: string; providerId?: string }) =>
    request<{ ok: boolean; latencyMs: number; message: string; status?: number; snippet?: string }>(
      '/settings/test',
      { method: 'POST', body: JSON.stringify(input) },
      0,
    ),

  /** 号池：一条线路 = 一个平台 + 一把 Key + 一个模型 */
  addKey: (input: {
    providerId?: string;
    label?: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    persist?: boolean;
    enabled?: boolean;
  }) => request<{ key: LlmPoolKey; llm: SettingsResponse['llm'] }>(
    '/settings/keys',
    { method: 'POST', body: JSON.stringify(input) },
    0,
  ),

  updateKey: (
    id: string,
    patch: {
      providerId?: string;
      label?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      persist?: boolean;
      enabled?: boolean;
    },
  ) => request<{ key: LlmPoolKey; llm: SettingsResponse['llm'] }>(
    `/settings/keys/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(patch) },
    0,
  ),

  deleteKey: (id: string) =>
    request<{ ok: boolean; llm: SettingsResponse['llm'] }>(
      `/settings/keys/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      0,
    ),

  resetKey: (id: string) =>
    request<{ ok: boolean; llm: SettingsResponse['llm'] }>(
      `/settings/keys/${encodeURIComponent(id)}/reset`,
      { method: 'POST' },
      0,
    ),

  reorderKeys: (ids: string[]) =>
    request<{ ok: boolean; llm: SettingsResponse['llm'] }>(
      '/settings/keys/order',
      { method: 'PUT', body: JSON.stringify({ ids }) },
      0,
    ),

  testKey: (id: string) =>
    request<{ ok: boolean; latencyMs: number; message: string; status?: number; snippet?: string }>(
      `/settings/keys/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
      0,
    ),

  /** 拉取该平台真实可用的模型 ID（魔搭的模型名是 Qwen/Qwen3-8B 这种，手填容易错） */
  llmModels: (input: { keyId?: string; baseUrl?: string; apiKey?: string; providerId?: string }) =>
    request<{ models: string[]; count: number }>(
      '/settings/models',
      { method: 'POST', body: JSON.stringify(input) },
      0,
    ),

  practiceOverview: () => request<PracticeOverview>('/practice/overview', {}, 1),

  practice: (date: string, taskId: string, language?: string) =>
    request<PracticeBriefResponse>(withLang(`/practice/${date}/${taskId}`, language), {}, 1),

  gradePractice: (
    date: string,
    taskId: string,
    body: {
      text: string;
      durationSeconds?: number | null;
      submissionSource?: 'typed' | 'speech';
      recognitionConfidence?: number | null;
    },
    language?: string,
  ) =>
    request<GradeResponse>(withLang(`/practice/${date}/${taskId}/grade`, language), {
      method: 'POST',
      body: JSON.stringify(body),
    }, 0),

  practiceAttempts: (limit = 30, language?: string) =>
    request<{ attempts: AttemptSummary[]; summary: PracticeStats }>(
      `/practice/attempts?limit=${limit}${language ? `&language=${language}` : ''}`,
    ),

  attempt: (id: string) => request<{ attempt: PracticeAttempt }>(`/practice/attempts/${id}`),

  /**
   * AI 加练：由用户手动触发，按语种 + 任务类型 + 级别 + 今日主题生成一批练习。
   * fresh=true 表示忽略 5 分钟缓存、强制再来一批（会真的消耗 token）。
   */
  aiGenerate: (date: string, taskId: string, fresh = false) =>
    request<AiGenerateResponse>(
      '/ai/generate',
      { method: 'POST', body: JSON.stringify({ date, taskId, fresh }) },
      0,
    ),

  aiStats: () => request<AiStats>('/ai/stats'),

  aiBank: (params: { language?: string; kind?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.language) query.set('language', params.language);
    if (params.kind) query.set('kind', params.kind);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return request<{ items: import('./types').AiBankItem[]; stats: AiStats }>(
      `/ai/bank${suffix ? `?${suffix}` : ''}`,
    );
  },

  /* ---------- 升级自测 ---------- */

  /** 历年真题精选卷列表（按年份倒序，带最好成绩） */
  examPapers: (language: string) =>
    request<{
      papers: import('./types').ExamPaperSummary[];
      range: { from: number; to: number };
    }>(`/exams?language=${language}`),

  examPaper: (id: string) =>
    request<{ paper: import('./types').ExamPaper; items: import('./types').ExamItem[] }>(
      `/exams/${id}`,
    ),

  /** 删掉自己导入的卷子：题目与作答记录一起清（内置题库删不掉） */
  examDelete: (id: string) =>
    request<{ ok: boolean; id: string }>(`/exams/${id}`, { method: 'DELETE' }, 0),

  examStart: (id: string) =>
    request<{ attempt: import('./types').ExamAttempt; paper: import('./types').ExamPaper }>(
      `/exams/${id}/attempts`,
      { method: 'POST' },
      0,
    ),

  examSubmit: (
    attemptId: string,
    answers: Array<number | null>,
    seconds: number,
    writing: Record<string, string> = {},
  ) =>
    request<import('./types').ExamResultResponse>(
      `/exams/attempts/${attemptId}/submit`,
      { method: 'POST', body: JSON.stringify({ answers, seconds, writing }) },
      0,
    ),

  examAttempt: (attemptId: string) =>
    request<import('./types').ExamResultResponse>(`/exams/attempts/${attemptId}`),

  examHistory: (language: string) =>
    request<{ attempts: import('./types').ExamAttemptSummary[] }>(
      `/exams/attempts?language=${language}`,
    ),

  /** 上传真题原卷：先建任务再轮询进度（OCR / 分段抽取都可能跑几分钟） */
  startExamImport: async (
    file: File,
    language: string,
    options: { year: number; paperType: string; ocr: string; title?: string; examName?: string; levelLabel?: string },
  ): Promise<{ job: import('./types').ExamImportJob }> => {
    const query = new URLSearchParams({
      language,
      name: file.name,
      year: String(options.year),
      paperType: options.paperType,
      ocr: options.ocr,
      ...(options.title ? { title: options.title } : {}),
      ...(options.examName ? { examName: options.examName } : {}),
      ...(options.levelLabel ? { levelLabel: options.levelLabel } : {}),
    });
    const response = await fetchWithAuth(`${BASE}/exam-imports?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw new ApiError(
        payload?.error?.message ?? `导入失败（${response.status}）`,
        response.status,
        payload?.error?.code ?? 'IMPORT_FAILED',
      );
    }
    return (await response.json()) as { job: import('./types').ExamImportJob };
  },

  examImportJob: (id: string) =>
    request<{ job: import('./types').ExamImportJob }>(`/exam-imports/jobs/${id}`, {}, 0),

  importedExams: (language: string) =>
    request<{ papers: import('./types').ExamPaperSummary[] }>(`/exam-imports?language=${language}`, {}, 0),

  deleteImportedExam: (id: string) =>
    request<{ ok: boolean }>(`/exam-imports/${id}`, { method: 'DELETE' }, 0),

  /* ── 音色库：所有接口都带 language，服务端按语种隔离 ── */
  voices: (language: string) => request<VoicesResponse>(`/voices?language=${language}`, {}, 1),

  createVoice: (draft: VoiceDraft) =>
    request<VoicesResponse>('/voices', { method: 'POST', body: JSON.stringify(draft) }, 0),

  updateVoice: (id: string, patch: Partial<VoiceDraft> & { clearKey?: boolean }) =>
    request<VoicesResponse>(`/voices/${id}`, { method: 'PUT', body: JSON.stringify(patch) }, 0),

  deleteVoice: (id: string, language: string) =>
    request<VoicesResponse>(`/voices/${id}?language=${language}`, { method: 'DELETE' }, 0),

  setDefaultVoice: (id: string, language: string) =>
    request<VoicesResponse>(`/voices/${id}/default`, {
      method: 'POST',
      body: JSON.stringify({ language }),
    }, 0),

  setVoiceAssignments: (language: string, assignments: Partial<VoiceAssignmentMap>) =>
    request<VoicesResponse>('/voices/assignments', {
      method: 'PUT',
      body: JSON.stringify({ language, assignments }),
    }, 0),

  setVoicePrefs: (language: string, prefs: Partial<VoicePrefs>) =>
    request<VoicesResponse>('/voices/prefs', {
      method: 'PUT',
      body: JSON.stringify({ language, ...prefs }),
    }, 0),

  discoverVoices: (language: string) =>
    request<VoiceDiscoverResponse>('/voices/discover', {
      method: 'POST',
      body: JSON.stringify({ language }),
    }, 0),

  importVoices: (language: string, items: VoiceCandidate[]) =>
    request<VoicesResponse>('/voices/import', {
      method: 'POST',
      body: JSON.stringify({ language, items }),
    }, 0),

  /** 本地 Edge Neural 引擎自检 */
  edgeTtsStatus: (refresh = false) =>
    request<EdgeTtsStatus>(`/voices/edge/status${refresh ? '?refresh=1' : ''}`, {}, 0),

  /** 一键为某个语种启用本地 Neural 音色并绑定全部场景 */
  enableEdgeVoices: (language: string) =>
    request<VoicesResponse>('/voices/edge/enable', {
      method: 'POST',
      body: JSON.stringify({ language }),
    }, 0),

  // ---- 解题答疑视频（精读右栏）----

  /** 进入页签先预检：命中缓存直接秒开，不创建 job、不消耗 token */
  explainResolve: (articleId: string, depth: ExplainDepth = 'medium', coach?: ExplainCoachMode) =>
    request<{
      resolve: {
        state: 'cached' | 'running' | 'none';
        videoId?: string;
        tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
        job?: { id: string; stage: string; progress: number; detail: string; videoId?: string };
        /** 缓存来自共享层（别人生成过）还是自己的副本 */
        source?: 'shared' | 'personal';
        hasNative?: boolean;
        needsNative?: boolean;
      };
    }>(
      `/explain-videos/resolve?articleId=${encodeURIComponent(articleId)}&depth=${depth}${coach === 'bilingual' ? '&coach=bilingual' : ''}`,
      {},
      0,
    ),

  /** 三档预估：服务端算好时长 / token / 是否已生成，前端只负责展示 */
  explainEstimate: (articleId: string) =>
    request<ExplainEstimateResponse>(
      `/explain-videos/estimate?articleId=${encodeURIComponent(articleId)}`,
      {},
      0,
    ),

  explainCreate: (
    articleId: string,
    force = false,
    depth: ExplainDepth = 'medium',
    coach: ExplainCoachMode = 'target',
  ) =>
    request<{ job: { id: string; stage: string } }>(
      '/explain-videos',
      { method: 'POST', body: JSON.stringify({ articleId, force, depth, coach }) },
      0,
    ),

  /** 只补中文讲师轨：不重跑脚本，成本约为整片重生成的 1/5 */
  explainCoach: (videoId: string) =>
    request<{ job: { id: string; stage: string } }>(
      `/explain-videos/${encodeURIComponent(videoId)}/coach`,
      { method: 'POST' },
      0,
    ),

  /**
   * 换音色重配：只跑 TTS，不调大模型，token 恒为 0。
   * 不传 voice 就用当前用户在该语种「文章讲解」场景配的音色。
   */
  explainRevoice: (videoId: string, voice?: string) =>
    request<{ job: { id: string; stage: string } }>(
      `/explain-videos/${encodeURIComponent(videoId)}/revoice`,
      { method: 'POST', body: JSON.stringify(voice ? { voice } : {}) },
      0,
    ),

  explainJob: (jobId: string) =>
    request<{
      job: {
        id: string;
        stage: string;
        progress: number;
        detail: string;
        videoId?: string;
        error?: string;
        tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
        cacheHit?: boolean;
        cacheSource?: 'shared' | 'personal';
        coach?: ExplainCoachMode;
        coachOnly?: boolean;
        /** 换音色重配任务（0 token，只跑 TTS） */
        revoiceOnly?: boolean;
        voice?: string;
      };
    }>(`/explain-videos/jobs/${encodeURIComponent(jobId)}`, {}, 0),

  explainCancelJob: (jobId: string) =>
    request<{ ok: boolean }>(`/explain-videos/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }, 0),

  explainList: (articleId: string) =>
    request<{ videos: ExplainVideoSummary[] }>(
      `/explain-videos?articleId=${encodeURIComponent(articleId)}`,
      {},
      0,
    ),

  explainGet: (videoId: string) =>
    request<{ video: ExplainVideoLike }>(`/explain-videos/${encodeURIComponent(videoId)}`, {}, 0),

  explainSaveTranscript: (videoId: string, video: ExplainVideoLike) =>
    request<{ video: ExplainVideoLike }>(`/explain-videos/${encodeURIComponent(videoId)}/transcript`, {
      method: 'PUT',
      body: JSON.stringify({ video }),
    }, 0),

  /** 导出 MP4：按音轨分文件（原文 / 中文讲师 / 双语双音轨） */
  explainExport: (videoId: string, track: ExplainExportTrack = 'target') =>
    request<{ url: string; track: ExplainExportTrack }>(
      `/explain-videos/${encodeURIComponent(videoId)}/export`,
      { method: 'POST', body: JSON.stringify({ track }) },
      0,
    ),

  /** 导出文件的直链（<a download> 用，鉴权走 cookie/头由浏览器带） */
  explainExportUrl: (videoId: string, track: ExplainExportTrack = 'target') =>
    `/api/explain-videos/${encodeURIComponent(videoId)}/export/file?track=${track}`,

  /** 分段音频带鉴权 fetch 成 blob URL（<audio> 不能自带 Authorization 头） */
  explainSegmentBlob: async (videoId: string, index: number, track: 'target' | 'native' = 'target'): Promise<string> => {
    const query = track === 'native' ? '?track=zh' : '';
    const response = await fetchWithAuth(
      `/api/explain-videos/${encodeURIComponent(videoId)}/seg/${index}${query}`,
      {},
    );
    if (!response.ok) throw new ApiError(`分段音频加载失败（${response.status}）`, response.status, 'SEGMENT_FAILED');
    return URL.createObjectURL(await response.blob());
  },

  /** 云端音色合成：返回可直接塞给 <audio> 的 blob URL，用完请 URL.revokeObjectURL */
  synthesizeVoice: async (id: string, text: string, language: string, rate?: number): Promise<string> => {
    const response = await fetchWithAuth(`${BASE}/voices/${id}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language, ...(rate !== undefined ? { rate } : {}) }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw new ApiError(
        payload?.error?.message ?? `语音合成失败（${response.status}）`,
        response.status,
        payload?.error?.code ?? 'TTS_FAILED',
      );
    }
    return URL.createObjectURL(await response.blob());
  },

  // -------------------------------------------------------------------------
  // Lingua Agent Studio
  // -------------------------------------------------------------------------

  agentScenes: () => request<AgentScenesResponse>('/agent/scenes', {}, 0),

  agentRuns: (limit = 20) =>
    request<{ runs: AgentRunSummary[] }>(`/agent/runs?limit=${encodeURIComponent(String(limit))}`, {}, 0),

  agentRun: (runId: string) =>
    request<{ run: AgentRun }>(`/agent/runs/${encodeURIComponent(runId)}`, {}, 0),

  /**
   * 流式跑一次 Agent。
   *
   * 为什么不用 EventSource：它只支持 GET，而 run 的入参（正文、文章 id）放不进 URL，
   * 硬塞会导致长作文被 URL 长度截断。所以这里用 fetch + 手写 SSE 帧解析。
   */
  agentRunStream: async (
    input: AgentRunInput,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const response = await fetchWithAuth(`${BASE}/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });

    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw new ApiError(
        payload?.error?.message ?? `Agent 启动失败（${response.status}）`,
        response.status,
        payload?.error?.code ?? 'AGENT_RUN_FAILED',
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const flush = (frame: string): boolean => {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) return false;
      if (data === '[DONE]') return true;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        // 半截帧（服务端 write 被切断）不该让整次 run 失败，丢掉即可
      }
      return false;
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (flush(frame)) return;
        index = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) flush(buffer);
  },

  /**
   * 采纳产物。
   *
   * 不重试：这是有副作用的写操作，重试会让错因被记两次、任务重复挂载。
   */
  agentAdopt: (input: AgentAdoptInput) =>
    request<AgentAdoptResult>(
      '/agent/adopt',
      { method: 'POST', body: JSON.stringify(input) },
      0,
    ),

  /** 讲解视频作业进度。running 时前端继续轮询，done 后去取 videoId */
  agentExplainPoll: (jobId: string) =>
    request<ExplainJobState>(`/agent/media/explain/${encodeURIComponent(jobId)}`, {}, 0),

  /** 取消一个还在跑的讲解作业，避免用户改主意后仍继续烧 token */
  agentExplainCancel: (jobId: string) =>
    request<{ ok: boolean }>(`/explain-videos/jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    }, 0),
};
