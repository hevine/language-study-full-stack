/**
 * Electron 主进程入口。
 *
 * 持有 SessionOrchestrator + LoopStore 实例，
 * 通过 IPC 与 renderer 通信，不依赖 HTTP。
 *
 * 启动方式：
 *   npx electron electron/main.ts
 *
 * 需要：
 *   - LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 环境变量
 *   - web/dist/ 目录（Vite 构建产物）
 */
import { app, BrowserWindow, ipcMain, IpcMainEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createStandaloneRuntime } from '../server/src/agent/standalone';
import { SessionOrchestrator } from '../server/src/agent/session/orchestrator';
import { createStandaloneLoopDeps } from '../server/src/agent/standalone/loop-db';
import { IPC_CHANNELS } from './ipc';

let mainWindow: BrowserWindow | null = null;
let orchestrator: SessionOrchestrator | null = null;
let loopDeps: ReturnType<typeof createStandaloneLoopDeps> | null = null;

function getOrchestrator(): SessionOrchestrator {
  if (!orchestrator) {
    const runtime = createStandaloneRuntime();
    orchestrator = new SessionOrchestrator(runtime);
  }
  return orchestrator;
}

function getLoopDeps() {
  if (!loopDeps) {
    const dataDir = app.getPath('userData');
    loopDeps = createStandaloneLoopDeps(dataDir);
  }
  return loopDeps;
}

function registerIpc(): void {
  // Session
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, (_e, lang: string) => {
    return getOrchestrator().createSession('local', lang);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_ENQUEUE, (_e, sessionId: string, input: Record<string, unknown>) => {
    return getOrchestrator().enqueue(sessionId, input);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, (_e, sessionId: string) => {
    return getOrchestrator().getSession(sessionId);
  });

  // Session run：main 发起 AsyncGenerator，逐事件推给 renderer
  ipcMain.on(IPC_CHANNELS.SESSION_RUN, async (event: IpcMainEvent, sessionId: string) => {
    const channel = `agent:session:run:${sessionId}`;
    try {
      for await (const evt of getOrchestrator().run(sessionId)) {
        event.reply(channel, evt);
      }
    } catch (err) {
      event.reply(channel, { type: 'error', message: (err as Error).message });
    }
    event.reply(channel, '[DONE]');
  });

  // Loop
  ipcMain.handle(IPC_CHANNELS.LOOP_TODAY, () => {
    return getLoopDeps().store.loopToday('local');
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_STATS, () => {
    return getLoopDeps().store.loopStats('local');
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_GRADE, (_e, input: { cardId: string; grade: number; ms: number }) => {
    return getLoopDeps().store.gradeCard('local', input.cardId, input.grade as 0 | 1 | 2 | 3, input.ms);
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_DOCUMENTS, () => {
    return { documents: getLoopDeps().store.listDocuments('local') };
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_ARTIFACTS, () => {
    return { artifacts: getLoopDeps().store.listArtifacts('local') };
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_CARDS, (_e, documentId?: string) => {
    return { cards: getLoopDeps().store.listCards('local', documentId) };
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_EXPORT, () => {
    return getLoopDeps().store.exportLoop('local');
  });

  // Audio save：renderer 传 base64，main 存本地文件
  ipcMain.handle(IPC_CHANNELS.AUDIO_SAVE, (_e, base64: string, ext: string) => {
    const dataDir = app.getPath('userData');
    const audioDir = path.join(dataDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const filename = `audio_${Date.now()}.${ext}`;
    const filepath = path.join(audioDir, filename);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    return filepath;
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Lingua Agent',
  });

  // 开发时加载 Vite dev server，生产时加载打包后的 index.html
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5199');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../web/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
