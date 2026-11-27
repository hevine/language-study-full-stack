/**
 * IPC 通道定义：main ↔ renderer 的事件契约。
 *
 * 所有通道名以 `agent:` 或 `loop:` 前缀分组，
 * renderer 通过 preload.ts 的 contextBridge 暴露的 API 调用。
 */

export const IPC_CHANNELS = {
  // Session / Agent
  SESSION_CREATE: 'agent:session:create',
  SESSION_ENQUEUE: 'agent:session:enqueue',
  SESSION_RUN: 'agent:session:run',
  SESSION_GET: 'agent:session:get',

  // Loop
  LOOP_TODAY: 'loop:today',
  LOOP_STATS: 'loop:stats',
  LOOP_GRADE: 'loop:grade',
  LOOP_DOCUMENTS: 'loop:documents',
  LOOP_ARTIFACTS: 'loop:artifacts',
  LOOP_CARDS: 'loop:cards',
  LOOP_EXPORT: 'loop:export',

  // Audio
  AUDIO_SAVE: 'audio:save',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
