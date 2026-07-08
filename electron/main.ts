/**
 * Electron main process entry point for Claude Code Desktop.
 *
 * Bootstrap sequence (in app.whenReady):
 *   1. Open SQLite database (WAL, migrations).
 *   2. Instantiate ConversationRepo + MessageRepo.
 *   3. Create CliSpawner (manages Claude CLI subprocesses).
 *   4. Detect Claude CLI installation on startup.
 *   5. Create BrowserWindow with secure defaults.
 *   6. Register IPC handlers + wire up stream listeners.
 *
 * Lifecycle:
 *   - window-all-closed → quit (non-macOS); stay alive (macOS).
 *   - activate          → recreate window if none.
 *   - before-quit       → stopAll CLI processes, close database.
 */
import { app, BrowserWindow, ipcMain, dialog, IpcMainInvokeEvent, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import { Channels } from './ipc/channels';
import { detectClaudeCli, CliInfo } from './integration/cli-detector';
import {
  CliSpawner,
  ChunkEvent,
  CloseEvent,
  ErrorEvent,
  StderrEvent,
} from './integration/cli-spawner';
import { AppDatabase } from './db/database';
import { ConversationRepo, Conversation } from './db/repositories/conversation-repo';
import { MessageRepo, Message, Attachment } from './db/repositories/message-repo';
import type { ParsedChunk } from './integration/stream-parser';

// ---------------------------------------------------------------------------
// Constants & module state
// ---------------------------------------------------------------------------

const isDev = !app.isPackaged && process.env.CCD_FORCE_PROD !== '1';

/** Default model alias passed to the Claude CLI `--model` flag. */
const DEFAULT_MODEL = 'default';

/** Vite dev-server URL (port 5174 to avoid clashing with other Vite apps). */
const DEV_SERVER_URL = 'http://127.0.0.1:5174';

/**
 * Maps BrowserWindow.id -> bound conversation id (null = unbound).
 * Routes stream chunks/events only to windows displaying that conversation.
 */
const windowBindings = new Map<number, string | null>();

/**
 * 强引用所有打开的 BrowserWindow，防止 V8 GC 回收窗口对象导致窗口闪退。
 * 窗口关闭时从集合中移除。
 */
const windows = new Set<BrowserWindow>();

const database = new AppDatabase();
let conversationRepo: ConversationRepo;
let messageRepo: MessageRepo;

const cliSpawner = new CliSpawner();

/** Cached CLI detection result (refreshed on each `cli:check` call). */
let cliInfo: CliInfo | null = null;

/**
 * Accumulated assistant text per conversation id, persisted incrementally so a
 * crash mid-stream does not lose the partial response.
 */
const textAccumulators = new Map<string, string>();

/** DB id of the in-flight assistant message per conversation id. */
const assistantMessageIds = new Map<string, string>();

/** Throttle timers that flush accumulated text to the database. */
const flushTimers = new Map<string, NodeJS.Timeout>();

/** Track which conversations have already sent a "typing started" signal. */
const typingStarted = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send an IPC message to every window bound to `conversationId`.
 * Windows opened later load persisted history from the database, so a missing
 * binding means "no one is watching live" - chunks are still persisted.
 */
function sendToConv(conversationId: string, channel: string, data: unknown): void {
  for (const [winId, convId] of windowBindings) {
    if (convId !== conversationId) continue;
    const win = BrowserWindow.fromId(winId);
    if (!win || win.isDestroyed()) continue;
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) continue;
    contents.send(channel, data);
  }
}

/**
 * Send an IPC message to every open window regardless of binding.
 * Used for sidebar-refresh notifications after conversation mutations.
 */
function broadcast(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) continue;
    contents.send(channel, data);
  }
}

/**
 * Parse a `data:<mime>;base64,<data>` URL into its mime type and raw base64.
 * Returns null if the string is not a valid data URL.
 */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/** Map a file extension to a mime type (best-effort). */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tiff: 'image/tiff',
};

/** Read an image file and return its base64 data URL. */
function readFileAsDataUrl(filePath: string): { dataUrl: string; mimeType: string } | null {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';
    return { dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`, mimeType };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow(convId?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    frame: true,
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1e1e2e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for local modules
      spellcheck: false,
    },
  });

  // Pre-bind so early stream chunks route correctly; the renderer re-binds
  // on mount once it knows its activeConvId.
  windowBindings.set(win.id, convId ?? null);
  // 保持强引用，避免 GC 回收窗口
  windows.add(win);

  if (isDev) {
    const url = convId ? `${DEV_SERVER_URL}?conv=${encodeURIComponent(convId)}` : DEV_SERVER_URL;
    win.loadURL(url);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), convId ? { query: { conv: convId } } : undefined);
  }

  // Show window once it's ready to avoid visual flash.
  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    windowBindings.delete(win.id);
    windows.delete(win);
  });

  return win;
}

// ---------------------------------------------------------------------------
// Stream listener wiring
// ---------------------------------------------------------------------------

/**
 * Write the accumulated assistant text for a conversation to its database
 * message row (creating the row lazily on the first chunk). Called both on a
 * throttle and on stream close so partial responses survive a crash.
 */
function flushAssistantText(conversationId: string): void {
  const text = textAccumulators.get(conversationId);
  if (!text) return;
  const msgId = assistantMessageIds.get(conversationId);
  try {
    if (!msgId) {
      const msg = messageRepo.create(conversationId, 'assistant', text);
      assistantMessageIds.set(conversationId, msg.id);
    } else {
      messageRepo.updateContent(msgId, text);
    }
  } catch (err) {
    console.error('[Main] Failed to persist assistant text:', err);
  }
}

/** Throttle DB writes: flush at most once per 400ms per conversation. */
function scheduleFlush(conversationId: string): void {
  if (flushTimers.has(conversationId)) return;
  const timer = setTimeout(() => {
    flushTimers.delete(conversationId);
    flushAssistantText(conversationId);
  }, 400);
  flushTimers.set(conversationId, timer);
}

/** Clear all in-memory state for a finished session. */
function clearSessionState(conversationId: string): void {
  const timer = flushTimers.get(conversationId);
  if (timer) { clearTimeout(timer); flushTimers.delete(conversationId); }
  textAccumulators.delete(conversationId);
  assistantMessageIds.delete(conversationId);
  typingStarted.delete(conversationId);
}

/** Flush every pending accumulator (used on quit). */
function flushAllPending(): void {
  for (const id of Array.from(textAccumulators.keys())) {
    const timer = flushTimers.get(id);
    if (timer) clearTimeout(timer);
    flushTimers.delete(id);
    flushAssistantText(id);
  }
}

/**
 * Attach event listeners to the CliSpawner. Called once during bootstrap.
 *
 * The CliSpawner emits events keyed by `sessionId`, which we always set equal
 * to the conversation id. These listeners:
 *   - Forward parsed chunks to the renderer (stream:chunk).
 *   - Emit typing indicators (typing).
 *   - Capture the Claude CLI session id from meta chunks for resume support.
 *   - Persist assistant text incrementally (crash-safe).
 *   - Forward close / error events to the renderer.
 */
function setupStreamListeners(): void {
  cliSpawner.on('chunk', ({ sessionId, chunk }: ChunkEvent) => {
    const conversationId = sessionId;

    // Typing-started signal (sent once per session).
    if (!typingStarted.has(conversationId)) {
      typingStarted.add(conversationId);
      sendToConv(conversationId, Channels.TYPING, { conversationId, isTyping: true });
    }

    // Accumulate assistant text and persist incrementally (crash-safe).
    if (chunk.type === 'text' && chunk.content) {
      const prev = textAccumulators.get(conversationId) ?? '';
      textAccumulators.set(conversationId, prev + chunk.content);
      scheduleFlush(conversationId);
    }

    // Capture Claude CLI session id for resume support.
    if (chunk.type === 'meta' && chunk.meta?.sessionId) {
      const conv = conversationRepo.getById(conversationId);
      if (conv && !conv.claudeSessionId) {
        conversationRepo.updateLastMessage(
          conversationId,
          conv.lastMessage ?? '',
          chunk.meta.sessionId,
        );
      }
    }

    // Push every chunk to the renderer for live display.
    sendToConv(conversationId, Channels.STREAM_CHUNK, { conversationId, chunk });
  });

  cliSpawner.on('stderr', ({ sessionId, data }: StderrEvent) => {
    // Log CLI stderr for debugging; not forwarded to the renderer.
    console.error(`[CLI stderr:${sessionId}]`, data);
  });

  cliSpawner.on('close', ({ sessionId, exitCode }: CloseEvent) => {
    const conversationId = sessionId;

    // Final flush of accumulated assistant text to the database.
    flushAssistantText(conversationId);

    // Update the conversation preview from the persisted assistant text.
    const text = textAccumulators.get(conversationId);
    if (text) {
      const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
      try {
        conversationRepo.updateLastMessage(conversationId, preview);
      } catch (err) {
        console.error('[Main] Failed to update conversation preview:', err);
      }
    }

    clearSessionState(conversationId);
    sendToConv(conversationId, Channels.TYPING, { conversationId, isTyping: false });

    // Notify renderer that the stream has ended.
    sendToConv(conversationId, Channels.STREAM_END, { conversationId, exitCode });

    // Refresh sidebars in all windows (preview/title may have changed).
    broadcast(Channels.CONVERSATIONS_CHANGED);
  });

  cliSpawner.on('error', ({ sessionId, error }: ErrorEvent) => {
    const conversationId = sessionId;

    // Persist whatever assistant text arrived before the error.
    flushAssistantText(conversationId);
    clearSessionState(conversationId);

    sendToConv(conversationId, Channels.TYPING, { conversationId, isTyping: false });
    sendToConv(conversationId, Channels.STREAM_ERROR, { conversationId, error });
  });
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

// ---- Payload type definitions --------------------------------------------

interface ConversationCreatePayload {
  title?: string;
  projectPath?: string | null;
  model?: string;
}

interface ConversationIdPayload {
  id: string;
}

interface ConversationPinPayload {
  id: string;
  pinned: boolean;
}

interface MessageListPayload {
  conversationId: string;
}

interface MessageSendPayload {
  conversationId: string;
  message: string;
  attachments?: Attachment[];
}

interface StopGenerationPayload {
  conversationId: string;
}

// ---- Registration ---------------------------------------------------------

function registerIpcHandlers(): void {
  // -- Conversations --------------------------------------------------------

  ipcMain.handle(Channels.CONVERSATION_LIST, (): Conversation[] => {
    return conversationRepo.getAll();
  });

  ipcMain.handle(
    Channels.CONVERSATION_CREATE,
    (_e: IpcMainInvokeEvent, payload: ConversationCreatePayload): Conversation => {
      const title = payload.title?.trim() || 'New Conversation';
      const projectPath = payload.projectPath ?? null;
      const model = payload.model || DEFAULT_MODEL;
      const conv = conversationRepo.create(title, projectPath, model);
      broadcast(Channels.CONVERSATIONS_CHANGED);
      return conv;
    },
  );

  ipcMain.handle(
    Channels.CONVERSATION_DELETE,
    (_e: IpcMainInvokeEvent, payload: ConversationIdPayload): { ok: boolean } => {
      // 清理全局状态，避免内存泄漏
      clearSessionState(payload.id);
      conversationRepo.delete(payload.id);
      broadcast(Channels.CONVERSATIONS_CHANGED);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.CONVERSATION_PIN,
    (
      _e: IpcMainInvokeEvent,
      payload: ConversationPinPayload,
    ): { ok: boolean } => {
      conversationRepo.togglePin(payload.id, payload.pinned);
      broadcast(Channels.CONVERSATIONS_CHANGED);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.CONVERSATION_RENAME,
    (_e: IpcMainInvokeEvent, payload: { id: string; title: string }): { ok: boolean } => {
      conversationRepo.updateTitle(payload.id, payload.title);
      broadcast(Channels.CONVERSATIONS_CHANGED);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.CONVERSATION_CLEAR,
    (_e: IpcMainInvokeEvent, payload: ConversationIdPayload): { ok: boolean } => {
      messageRepo.deleteByConversation(payload.id);
      conversationRepo.updateLastMessage(payload.id, '');
      broadcast(Channels.CONVERSATIONS_CHANGED);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.CONVERSATION_SET_MODEL,
    (_e: IpcMainInvokeEvent, payload: { id: string; model: string }): { ok: boolean; error?: string } => {
      try {
        conversationRepo.updateModel(payload.id, payload.model);
        broadcast(Channels.CONVERSATIONS_CHANGED);
        return { ok: true };
      } catch (err) {
        console.error('[Main] Failed to update model:', err);
        return { ok: false, error: `Failed to update model: ${(err as Error).message}` };
      }
    },
  );

  // -- Messages -------------------------------------------------------------

  ipcMain.handle(
    Channels.MESSAGE_LIST,
    (_e: IpcMainInvokeEvent, payload: MessageListPayload): { ok: boolean; messages?: Message[]; error?: string } => {
      try {
        const messages = messageRepo.getByConversation(payload.conversationId);
        return { ok: true, messages };
      } catch (err) {
        console.error('[Main] Failed to get messages:', err);
        return { ok: false, error: `Failed to get messages: ${(err as Error).message}` };
      }
    },
  );

  ipcMain.handle(
    Channels.MESSAGE_SEND,
    async (
      _e: IpcMainInvokeEvent,
      payload: MessageSendPayload,
    ): Promise<{ ok: boolean; error?: string; userMessage?: Message }> => {
      const { conversationId, message, attachments } = payload;
      const atts = attachments ?? [];

      if ((!message || !message.trim()) && atts.length === 0) {
        return { ok: false, error: 'Message cannot be empty.' };
      }

      // Look up the conversation to obtain model + project path.
      const conversation = conversationRepo.getById(conversationId);
      if (!conversation) {
        return { ok: false, error: 'Conversation not found.' };
      }

      // Persist the user message immediately (text + attachments).
      let userMessage: Message;
      try {
        userMessage = messageRepo.create(conversationId, 'user', message, atts);
        conversationRepo.updateLastMessage(conversationId, message || atts[0]?.name || '');
      } catch (err) {
        return { ok: false, error: `Failed to save message: ${(err as Error).message}` };
      }

      // Build the prompt: text + @path references for file attachments.
      // Image attachments are passed as base64 content blocks (stream-json).
      const fileAtts = atts.filter((a) => a.kind === 'file' && a.path);
      let prompt = message;
      if (fileAtts.length > 0) {
        const refs = fileAtts.map((a) => `@${a.path}`).join('\n');
        prompt = (prompt ? prompt + '\n\n' : '') + `Attached files:\n${refs}`;
      }

      const images = atts
        .filter((a) => a.kind === 'image' && a.dataUrl)
        .map((a) => parseDataUrl(a.dataUrl!))
        .filter((v): v is { mimeType: string; data: string } => v !== null);

      // Grant read access to directories holding file attachments outside cwd.
      const cwd = conversation.projectPath || process.cwd();
      const addDirs = Array.from(
        new Set(fileAtts.map((a) => path.dirname(a.path!)).filter((d) => path.resolve(d) !== path.resolve(cwd))),
      );

      const model = conversation.model || DEFAULT_MODEL;
      const resumeId = conversation.claudeSessionId || undefined;

      // Reset per-session accumulator state for this conversation.
      clearSessionState(conversationId);
      textAccumulators.set(conversationId, '');

      try {
        cliSpawner.sendAndStream(conversationId, {
          cwd,
          model,
          resumeId,
          message: prompt,
          images: images.length > 0 ? images : undefined,
          addDirs: addDirs.length > 0 ? addDirs : undefined,
        });
      } catch (err) {
        clearSessionState(conversationId);
        return {
          ok: false,
          error: `Failed to start CLI session: ${(err as Error).message}`,
        };
      }

      return { ok: true, userMessage };
    },
  );

  // -- Stop generation ------------------------------------------------------

  ipcMain.handle(
    Channels.STOP_GENERATION,
    (_e: IpcMainInvokeEvent, payload: StopGenerationPayload): { ok: boolean } => {
      cliSpawner.stopSession(payload.conversationId);
      return { ok: true };
    },
  );

  // -- CLI check ------------------------------------------------------------

  ipcMain.handle(Channels.CLI_CHECK, async (): Promise<CliInfo> => {
    cliInfo = await detectClaudeCli();
    return cliInfo;
  });

  // -- Project folder selection (native dialog) -----------------------------

  ipcMain.handle(
    Channels.PROJECT_SELECT,
    async (): Promise<{ canceled: boolean; filePaths: string[] }> => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Project Folder',
      });
      return result;
    },
  );

  // -- Attachment helpers ---------------------------------------------------

  ipcMain.handle(
    Channels.ATTACHMENT_OPEN_FILES,
    async (
      _e: IpcMainInvokeEvent,
      payload: { imagesOnly?: boolean },
    ): Promise<{ canceled: boolean; filePaths: string[] }> => {
      const filters = payload.imagesOnly
        ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff'] }]
        : [{ name: 'All Files', extensions: ['*'] }];
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: payload.imagesOnly ? 'Select Images' : 'Select Files',
        filters,
      });
      return result;
    },
  );

  ipcMain.handle(
    Channels.ATTACHMENT_READ_DATA_URL,
    (_e: IpcMainInvokeEvent, payload: { filePath: string }): { dataUrl: string; mimeType: string } | null => {
      return readFileAsDataUrl(payload.filePath);
    },
  );

  // macOS: file paths copied from Finder live in the `public.file-url` clipboard format.
  ipcMain.handle(
    Channels.ATTACHMENT_CLIPBOARD_FILES,
    (): string[] => {
      const out: string[] = [];
      try {
        const formats = clipboard.availableFormats();
        // `public.file-url` (single) or `public.tiff` (image in clipboard)
        if (formats.includes('public.file-url')) {
          const buf = clipboard.readBuffer('public.file-url');
          const url = buf.toString('utf8').trim().replace(/^file:\/\//, '');
          if (url) out.push(decodeURIComponent(url));
        }
      } catch {
        // ignore
      }
      return out;
    },
  );

  // -- Multi-window management ----------------------------------------------

  ipcMain.handle(
    Channels.WINDOW_BIND,
    (e: IpcMainInvokeEvent, payload: { convId: string | null }): { ok: boolean; error?: string } => {
      try {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win && !win.isDestroyed()) {
          const convId = payload.convId ?? null;
          windowBindings.set(win.id, convId);
          if (convId && textAccumulators.has(convId)) {
            const contents = win.webContents;
            if (contents && !contents.isDestroyed()) {
              contents.send(Channels.STREAM_CHUNK, {
                conversationId: convId,
                chunk: { type: 'text-replace', content: textAccumulators.get(convId) ?? '' },
              });
            }
          }
        }
        return { ok: true };
      } catch (err) {
        console.error('[Main] Failed to bind window:', err);
        return { ok: false, error: `Failed to bind window: ${(err as Error).message}` };
      }
    },
  );

  ipcMain.handle(
    Channels.WINDOW_OPEN_CONVERSATION,
    (_e: IpcMainInvokeEvent, payload: { convId: string }): { ok: boolean; error?: string } => {
      try {
        createWindow(payload.convId);
        return { ok: true };
      } catch (err) {
        console.error('[Main] Failed to open conversation window:', err);
        return { ok: false, error: `Failed to open window: ${(err as Error).message}` };
      }
    },
  );

  ipcMain.handle(
    Channels.WINDOW_NEW_CHAT,
    async (
      _e: IpcMainInvokeEvent,
      payload: { projectPath?: string | null; model?: string },
    ): Promise<{ ok: boolean; conversationId?: string; error?: string }> => {
      try {
        const projectPath = payload.projectPath ?? null;
        const model = payload.model || DEFAULT_MODEL;
        const conv = conversationRepo.create('New Conversation', projectPath, model);
        broadcast(Channels.CONVERSATIONS_CHANGED);
        createWindow(conv.id);
        return { ok: true, conversationId: conv.id };
      } catch (err) {
        console.error('[Main] Failed to create new chat:', err);
        return { ok: false, error: `Failed to create new chat: ${(err as Error).message}` };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // 1. Database
  database.initialize(app.getPath('userData'));
  conversationRepo = new ConversationRepo(database.instance);
  messageRepo = new MessageRepo(database.instance);

  // 2. Detect Claude CLI (non-blocking; result cached for renderer queries).
  cliInfo = await detectClaudeCli();
  if (!cliInfo.installed) {
    console.warn('[Main] Claude CLI not detected:', cliInfo.error);
  } else {
    console.log(`[Main] Claude CLI detected: v${cliInfo.version}`);
  }

  // 3. Create the main window.
  createWindow();

  // 4. Wire up streaming + IPC (once).
  setupStreamListeners();
  registerIpcHandlers();
});

app.on('window-all-closed', () => {
  // macOS: app stays active when all windows are closed.
  // Other platforms: quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS: recreate the window when the dock icon is clicked.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  // Persist any in-flight assistant responses before shutting down.
  flushAllPending();
  cliSpawner.stopAll();
  database.close();
});
