/**
 * preload：通过 contextBridge 把 IPC 通道暴露给 renderer。
 *
 * renderer 调用方式：
 *   const sessionId = await window.agent.createSession('en')
 *   const taskIds = await window.agent.enqueue(sessionId, { text: '...' })
 *   const stream = window.agent.run(sessionId) // AsyncGenerator
 *
 *   const today = await window.loop.today()
 *   await window.loop.grade(cardId, grade)
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './ipc';

const streamChannel = (sessionId: string) => `agent:session:run:${sessionId}`;

contextBridge.exposeInMainWorld('agent', {
  createSession: (lang: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, lang),

  enqueue: (sessionId: string, input: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_ENQUEUE, sessionId, input),

  run: (sessionId: string) => {
    // 返回一个 AsyncIterable，逐事件 yield
    const channel = streamChannel(sessionId);
    const listeners: Array<(value: unknown) => void> = [];
    let done = false;

    ipcRenderer.send(IPC_CHANNELS.SESSION_RUN, sessionId);

    ipcRenderer.on(channel, (_event, data) => {
      if (data === '[DONE]') {
        done = true;
        for (const listener of listeners) listener({ done: true });
      } else {
        for (const listener of listeners) listener({ done: false, value: data });
      }
    });

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            if (done && listeners.length === 0) return { done: true, value: undefined };
            return new Promise((resolve) => {
              listeners.push((result) => {
                if (result.done) {
                  resolve({ done: true, value: undefined });
                } else {
                  resolve({ done: false, value: (result as { value: unknown }).value });
                }
              });
            });
          },
        };
      },
    };
  },

  getSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionId),
});

contextBridge.exposeInMainWorld('loop', {
  today: () => ipcRenderer.invoke(IPC_CHANNELS.LOOP_TODAY),
  stats: () => ipcRenderer.invoke(IPC_CHANNELS.LOOP_STATS),
  grade: (cardId: string, grade: number, ms?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOOP_GRADE, { cardId, grade, ms: ms ?? 0 }),
  documents: () => ipcRenderer.invoke(IPC_CHANNELS.LOOP_DOCUMENTS),
  artifacts: () => ipcRenderer.invoke(IPC_CHANNELS.LOOP_ARTIFACTS),
  cards: (documentId?: string) => ipcRenderer.invoke(IPC_CHANNELS.LOOP_CARDS, documentId),
  export: () => ipcRenderer.invoke(IPC_CHANNELS.LOOP_EXPORT),
});

contextBridge.exposeInMainWorld('audio', {
  save: (base64: string, ext?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SAVE, base64, ext ?? 'wav'),
});
