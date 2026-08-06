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
import * as os from 'os';
import { execSync, exec } from 'child_process';

import { Channels } from './ipc/channels';
import { detectClaudeCli, CliInfo } from './integration/cli-detector';
import {
  CliSpawner,
  ChunkEvent,
  CloseEvent,
  CLIErrorEvent,
  StderrEvent,
} from './integration/cli-spawner';
import type { StreamChunkPayload, StreamEndPayload, StreamErrorPayload } from './ipc/contracts';
import { AppDatabase } from './db/database';
import { ConversationRepo, Conversation } from './db/repositories/conversation-repo';
import { MessageRepo, Message, Attachment } from './db/repositories/message-repo';
import type { ParsedChunk, DiffHunk } from './integration/stream-parser';
import { scanHistorySummaries, loadConversationDetail, HistoryConversation, HistoryConversationDetail } from './integration/history-scanner';
import { PtyManager } from './integration/pty-manager';
import { ClaudePtyManager, ClaudePtyPermission } from './integration/claude-pty-manager';
import { SessionWatcherManager, SessionEvent } from './integration/session-watcher';
import { AgentSdkBridge } from './integration/agent-sdk-bridge';
import { AgentTextAccumulator } from './integration/agent-text-accumulator';
import { selectBranchMessages } from './db/branch-utils';
import { scanSkills, SkillInfo } from './integration/skills-scanner';
import type { PermissionDecision } from './types/agent';
import { mapPermissionModeForPty } from './ipc/permission-modes';

// ---------------------------------------------------------------------------
// IPC timeout helper — prevents handlers from hanging forever
// ---------------------------------------------------------------------------

/** Default timeout for IPC handlers (30s). */
const IPC_TIMEOUT_MS = 30_000;

/**
 * Wrap an ipcMain.handle registration with a timeout guard.
 * If the handler doesn't respond within IPC_TIMEOUT_MS, the promise rejects
 * with a descriptive error instead of hanging the renderer forever.
 */
function registerIpcHandler<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: T) => unknown,
  timeoutMs = IPC_TIMEOUT_MS,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: T) => {
    const result = await Promise.race([
      Promise.resolve(handler(event, payload)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`IPC handler "${channel}" timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return result;
  });
}

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
const ptyManager = new PtyManager();
const claudePtyManager = new ClaudePtyManager();
const sessionWatcherManager = new SessionWatcherManager();
const agentBridge = new AgentSdkBridge();

/** Simple settings store (JSON file in userData). */
const SETTINGS_FILE = path.join(app.getPath('userData'), 'agent-settings.json');
function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
function saveSettings(s: Record<string, unknown>): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

/** Cached CLI detection result (refreshed on each `cli:check` call). */
let cliInfo: CliInfo | null = null;

/**
 * Accumulated assistant text per conversation id, persisted incrementally so a
 * crash mid-stream does not lose the partial response.
 */
const textAccumulators = new Map<string, string>();

/** DB id of the in-flight assistant message per conversation id. */
const assistantMessageIds = new Map<string, string>();

/** Chat 模式结构化块累积（thinking/tool_use/tool_result），与 Agent 持久化格式统一 */
const chatContentBlocks = new Map<string, ChatContentBlock[]>();

/**
 * 把流式 chunk 累积成结构化块（Chat 模式）。
 * text 继续走 textAccumulators（作为 JSON 的第一个 text part），
 * 这里只累积 thinking / tool_use / tool_result / permission_denial。
 */
function accumulateChatBlock(convId: string, chunk: ParsedChunk): void {
  const blocks = chatContentBlocks.get(convId) || [];
  const last = blocks[blocks.length - 1];

  switch (chunk.type) {
    case 'thinking': {
      // thinking 是增量流：累积到最后一个 thinking 块（字段用 text，与 Agent 一致）
      if (last && last.type === 'thinking' && last.status === 'streaming') {
        last.text = (last.text || '') + (chunk.content || '');
      } else {
        blocks.push({ type: 'thinking', text: chunk.content || '', status: 'streaming' });
      }
      break;
    }
    case 'tool_use': {
      if (chunk.input !== undefined) {
        // content_block_stop：完整 input
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(chunk.input) as Record<string, unknown>; } catch { /* 保持空 */ }
        const existing = blocks.find((b) => b.type === 'tool_use' && b.toolUseId === chunk.toolUseId);
        if (existing) {
          existing.input = input;
          existing.status = 'completed';
        } else {
          blocks.push({ type: 'tool_use', toolName: chunk.tool, toolUseId: chunk.toolUseId, input, status: 'completed' });
        }
      } else if (!blocks.some((b) => b.type === 'tool_use' && b.toolUseId === chunk.toolUseId)) {
        // blockStart：占位（等 stop 补 input），同 id 不重复
        blocks.push({ type: 'tool_use', toolName: chunk.tool, toolUseId: chunk.toolUseId, status: 'streaming' });
      }
      break;
    }
    case 'tool_result': {
      blocks.push({
        type: 'tool_result',
        toolUseId: chunk.toolUseId,
        content: chunk.content,
        stdout: chunk.stdout,
        stderr: chunk.stderr,
        isError: chunk.isError,
        diff: chunk.diff,
        filePath: chunk.filePath,
        status: chunk.isError ? 'error' : 'completed',
      });
      const tu = blocks.find((b) => b.type === 'tool_use' && b.toolUseId === chunk.toolUseId);
      if (tu) tu.status = chunk.isError ? 'error' : 'completed';
      break;
    }
    case 'permission_denial': {
      blocks.push({ type: 'permission_denial', content: chunk.content, toolName: chunk.tool, status: 'error' });
      break;
    }
    default:
      return; // text/meta/error 不累积
  }
  chatContentBlocks.set(convId, blocks);
}

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

/** 解析 git diff --name-status 输出并获取每个文件的 diff */
function parseDiffFiles(
  statusOutput: string,
  cwd: string,
  staged: boolean,
): { ok: boolean; files: any[] } {
  const files: any[] = [];
  const lines = statusOutput.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const statusCode = parts[0];
    const filePath = parts[parts.length - 1];

    let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified';
    if (statusCode === 'A') status = 'added';
    else if (statusCode === 'D') status = 'deleted';
    else if (statusCode.startsWith('R')) status = 'renamed';

    try {
      const diffCmd = staged
        ? `git diff --cached -- "${filePath}"`
        : `git diff HEAD -- "${filePath}"`;
      const diff = execSync(diffCmd, {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 512 * 1024,
      });

      // 统计增删行数
      const diffLines = diff.split('\n');
      let additions = 0;
      let deletions = 0;
      for (const dl of diffLines) {
        if (dl.startsWith('+') && !dl.startsWith('+++')) additions++;
        else if (dl.startsWith('-') && !dl.startsWith('---')) deletions++;
      }

      files.push({
        path: filePath,
        status,
        additions,
        deletions,
        diff: diff.slice(0, 10000), // 限制 diff 大小
      });
    } catch {
      // 获取 diff 失败，仍然列出文件
      files.push({ path: filePath, status, additions: 0, deletions: 0, diff: '' });
    }
  }

  return { ok: true, files };
}

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

/** 与渲染进程 ContentBlock 对齐的结构化块（Chat 模式持久化用，格式与 Agent 一致） */
interface ChatContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'permission_denial'
  /** thinking 的完整文本（字段名 text 与 Agent 持久化格式一致） */
  text?: string
  content?: string
  toolName?: string
  /** tool_use 的完整输入（字段名 input 与 Agent 持久化格式一致） */
  input?: Record<string, unknown>
  toolUseId?: string
  stdout?: string
  stderr?: string
  isError?: boolean
  diff?: DiffHunk[]
  filePath?: string
  status?: 'streaming' | 'completed' | 'error'
}

/**
 * Write the accumulated assistant text for a conversation to its database
 * message row (creating the row lazily on the first chunk). Called both on a
 * throttle and on stream close so partial responses survive a crash.
 *
 * 统一持久化格式：content = JSON 数组（[{type:'text'}, ...blocks]），
 * 与 Agent 模式完全一致 —— 两种模式共用同一个数据库，消息互通。
 */
function flushAssistantText(conversationId: string): void {
  const text = textAccumulators.get(conversationId);
  const blocks = chatContentBlocks.get(conversationId);
  const msgId = assistantMessageIds.get(conversationId);
  try {
    // 流式中的 thinking/tool_use 块在持久化时终结为 completed
    if (blocks) {
      for (const b of blocks) {
        if (b.status === 'streaming') b.status = 'completed';
      }
    }
    const contentParts: unknown[] = [];
    if (text && text.trim()) contentParts.push({ type: 'text', text: text.trim() });
    if (blocks && blocks.length > 0) contentParts.push(...blocks);
    const serialized = contentParts.length > 0 ? JSON.stringify(contentParts) : (text || '');
    if (!serialized) return;
    if (!msgId) {
      const msg = messageRepo.create(conversationId, 'assistant', serialized);
      assistantMessageIds.set(conversationId, msg.id);
    } else {
      messageRepo.updateContent(msgId, serialized);
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
  chatContentBlocks.delete(conversationId);
  typingStarted.delete(conversationId);
}

/**
 * C7 修复：message:send 已持久化但 CLI 进程尚未确认启动的 user message。
 * convId -> 本次新建的 message id。CLI 启动失败（同步抛错或异步 error 事件）
 * 时据此精确回滚；进程正常结束（close）后清除。'aborted'（用户主动停止，
 * 消息已真正发出）不回滚。
 */
const pendingSendRollback = new Map<string, string>();

/**
 * C7 修复：删除某个 conversation 的待回滚 user message。
 * 仅当该消息仍是会话最后一条时删除，绝不触碰已有历史。
 */
function rollbackPendingUserMessage(convId: string): void {
  const messageId = pendingSendRollback.get(convId);
  pendingSendRollback.delete(convId);
  if (!messageId) return;
  try {
    const msgs = messageRepo.getByConversation(convId);
    const last = msgs[msgs.length - 1];
    if (!last || last.id !== messageId) return; // 已有后续内容（如并发回复），不回滚
    messageRepo.delete(messageId);
    const prev = msgs[msgs.length - 2];
    conversationRepo.updateLastMessage(convId, prev ? prev.content.slice(0, 200) : '');
  } catch (err) {
    console.error('[Main] Failed to roll back pending user message:', err);
  }
}

/** Flush every pending accumulator (used on quit). */
function flushAllPending(): void {
  for (const id of Array.from(textAccumulators.keys())) {
    const timer = flushTimers.get(id);
    if (timer) clearTimeout(timer);
    flushTimers.delete(id);
    flushAssistantText(id);
  }
  // Flush any pending agent SDK messages
  const agentConvs = new Set<string>([
    ...agentTextAccumulators.keys(),
    ...agentContentBlocks.keys(),
    ...agentAssistantMsgIds.keys(),
  ]);
  for (const convId of agentConvs) {
    flushAgentMessages(convId);
  }
}

// --- Agent SDK message persistence (module-level for before-quit access) ---
/**
 * P0 修复：以 SDK messageId 为粒度累计流式文本。
 * text_delta 只更新该 messageId 的临时文本；最终 text 覆盖之（绝不追加），
 * 从根本上消除"多个 delta + 最终 text"导致的落库重复。
 */
const agentTextAccumulators = new Map<string, AgentTextAccumulator>();
const agentAssistantMsgIds = new Map<string, string>();
const agentContentBlocks = new Map<string, unknown[]>();
/**
 * A5 修复：agent 发送后尚未产出任何回复的 user message（convId -> message id）。
 * sendMessage 的大部分启动失败（如 SDK 加载失败）不会 reject，而是发出 error
 * 事件；此时若该 user message 还没有任何回复产出，据此精确回滚。
 */
const pendingAgentUserMessages = new Map<string, string>();
/** 持久化队列锁 — 防止并发事件导致数据丢失 */
const agentPersistenceQueue = new Map<string, Promise<void>>();

/**
 * 串行化 agent 持久化操作，避免并发事件导致数据丢失。
 * 每个 conversation 的持久化操作排队执行。
 */
function enqueueAgentPersistence(convId: string, fn: () => Promise<void>): void {
  const prev = agentPersistenceQueue.get(convId) || Promise.resolve();
  const next = prev.then(fn, fn); // 即使前一个失败也继续执行
  agentPersistenceQueue.set(convId, next);
  // 清理已完成的 promise
  next.finally(() => {
    if (agentPersistenceQueue.get(convId) === next) {
      agentPersistenceQueue.delete(convId);
    }
  });
}

function flushAgentMessages(convId: string): void {
  // P0：flush 按 messageId 顺序拼接完整文本，并清空 per-message 临时状态
  const acc = agentTextAccumulators.get(convId);
  const text = acc ? acc.flush() : undefined;
  const blocks = agentContentBlocks.get(convId);
  const msgId = agentAssistantMsgIds.get(convId);

  try {
    const contentParts: unknown[] = [];
    if (text && text.trim()) {
      contentParts.push({ type: 'text', text: text.trim() });
    }
    if (blocks && blocks.length > 0) {
      contentParts.push(...blocks);
    }
    const serialized = contentParts.length > 0 ? JSON.stringify(contentParts) : (text || '');

    if (msgId) {
      messageRepo.updateContent(msgId, serialized);
    } else if (serialized) {
      const msg = messageRepo.create(convId, 'assistant', serialized);
      agentAssistantMsgIds.set(convId, msg.id);
    }

    const preview = text ? (text.length > 200 ? text.slice(0, 200) + '…' : text) : '';
    if (preview) {
      conversationRepo.updateLastMessage(convId, preview);
    }
  } catch (err) {
    console.error('[Main] Failed to persist agent messages:', err);
  }

  // flush 后清理本轮全部临时状态（含新增的 per-message 累计）
  agentTextAccumulators.delete(convId);
  agentAssistantMsgIds.delete(convId);
  agentContentBlocks.delete(convId);
}

/**
 * A5 修复：agent 发送被拒（启动失败）时精确回滚刚创建的 user message。
 * 仅当该消息仍是会话最后一条时删除，不影响已有历史。
 */
function rollbackAgentUserMessage(convId: string, messageId: string): void {
  try {
    const msgs = messageRepo.getByConversation(convId);
    const last = msgs[msgs.length - 1];
    if (!last || last.id !== messageId) return; // 已有后续内容，不能回滚
    messageRepo.delete(messageId);
    const prev = msgs[msgs.length - 2];
    conversationRepo.updateLastMessage(convId, prev ? prev.content.slice(0, 200) : '');
  } catch (err) {
    console.error('[Main] Failed to roll back agent user message:', err);
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

    // 结构化块累积（thinking/tool_use/tool_result）→ 与 Agent 持久化格式统一
    if (chunk.type === 'thinking' || chunk.type === 'tool_use' || chunk.type === 'tool_result' || chunk.type === 'permission_denial') {
      accumulateChatBlock(conversationId, chunk);
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
    sendToConv(conversationId, Channels.STREAM_CHUNK, { conversationId, chunk } satisfies StreamChunkPayload);
  });

  cliSpawner.on('stderr', ({ sessionId, data }: StderrEvent) => {
    // Log CLI stderr for debugging; not forwarded to the renderer.
    console.error(`[CLI stderr:${sessionId}]`, data);
  });

  cliSpawner.on('close', ({ sessionId, exitCode }: CloseEvent) => {
    const conversationId = sessionId;

    // C7 修复：进程正常结束（无论是否产出回复），不再需要回滚
    pendingSendRollback.delete(conversationId);

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
    sendToConv(conversationId, Channels.STREAM_END, { conversationId, exitCode } satisfies StreamEndPayload);

    // Refresh sidebars in all windows (preview/title may have changed).
    broadcast(Channels.CONVERSATIONS_CHANGED);
  });

  cliSpawner.on('error', ({ sessionId, error }: CLIErrorEvent) => {
    const conversationId = sessionId;

    // C7 修复：CLI 启动失败（未产出任何回复）→ 回滚本次 user message，不留下
    // 孤儿消息。'aborted' 是用户主动停止/强杀，消息已真正发出，不回滚。
    if (error.kind === 'aborted') {
      pendingSendRollback.delete(conversationId);
    } else {
      rollbackPendingUserMessage(conversationId);
    }

    // Persist whatever assistant text arrived before the error.
    flushAssistantText(conversationId);
    clearSessionState(conversationId);

    sendToConv(conversationId, Channels.TYPING, { conversationId, isTyping: false });
    // `error` stays a human-readable string for the renderer; structured
    // diagnostics let the UI tailor messaging (network vs not-found, etc.).
    sendToConv(conversationId, Channels.STREAM_ERROR, {
      conversationId,
      error: error.message,
      kind: error.kind,
      exitCode: error.exitCode,
    } satisfies StreamErrorPayload);
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
  kind?: 'agent' | 'chat';
  /** 从外部会话（终端 CLI 等）续接时传入历史 session id */
  claudeSessionId?: string | null;
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
  /** 权限模式：ask | auto-edit | plan | skip */
  permissionMode?: string;
  /** 思考等级：none | low | medium | high */
  thinkingEffort?: string;
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

  registerIpcHandler<ConversationCreatePayload>(
    Channels.CONVERSATION_CREATE,
    (_e: IpcMainInvokeEvent, payload: ConversationCreatePayload): Conversation => {
     const title = payload.title?.trim() || 'New Conversation';
      const projectPath = payload.projectPath ?? null;
      const model = payload.model || DEFAULT_MODEL;
      const conv = conversationRepo.create(title, projectPath, model, payload.kind || 'chat', payload.claudeSessionId ?? null);
      broadcast(Channels.CONVERSATIONS_CHANGED);
      return conv;
    },
  );

  // 批量导入历史消息（从终端 CLI 会话续接时，把历史消息持久化到 GUI 会话）
  ipcMain.handle(
    'conversation:import-messages',
    (_e: IpcMainInvokeEvent, payload: {
      conversationId: string;
      messages: Array<{ role: string; content: string; timestamp?: string }>;
    }): { ok: boolean; count: number } => {
      try {
        let count = 0;
        for (const m of payload.messages) {
          messageRepo.create(payload.conversationId, m.role, m.content, []);
          count++;
        }
        conversationRepo.updateLastMessage(
          payload.conversationId,
          payload.messages[payload.messages.length - 1]?.content?.slice(0, 120) || '',
        );
        return { ok: true, count };
      } catch (err) {
        console.error('[Main] Failed to import messages:', err);
        return { ok: false, count: 0 };
      }
    },
  );

  ipcMain.handle(
    Channels.CONVERSATION_DELETE,
    (_e: IpcMainInvokeEvent, payload: ConversationIdPayload): { ok: boolean } => {
      // 清理全局状态，避免内存泄漏
      clearSessionState(payload.id);
      pendingSendRollback.delete(payload.id);
      pendingAgentUserMessages.delete(payload.id);
      // 同时清理 Claude PTY 会话
      claudePtyManager.kill(payload.id);
      // 停止 session watcher
      sessionWatcherManager.stop(payload.id);
      // 销毁 agent session（如果有）
      agentBridge.destroySession(payload.id);
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
    (_e: IpcMainInvokeEvent, payload: ConversationIdPayload)

: { ok: boolean } => {
      messageRepo.deleteByConversation(payload.id);
      conversationRepo.updateLastMessage(payload.id, '');
      broadcast(Channels.CONVERSATIONS_CHANGED);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.CONVERSATION_BRANCH,
    (
      _e: IpcMainInvokeEvent,
      payload: { sourceConvId: string; messageId: string; title?: string },
    ): { ok: boolean; conversation?: Conversation; error?: string } => {
      try {
        const source = conversationRepo.getById(payload.sourceConvId);
        if (!source) return { ok: false, error: 'Source conversation not found' };

        // A13 修复：messageId 必须是真实 SQLite message id（AGENT_SEND 返回的
        // userMessage.id）。前端乐观 block id（user-xxx）找不到 → 返回 ok:false，
        // 绝不创建空分支会话。
        const allMessages = messageRepo.getByConversation(payload.sourceConvId);
        const messagesToCopy = selectBranchMessages(allMessages, payload.messageId);
        if (!messagesToCopy || messagesToCopy.length === 0) {
          return { ok: false, error: 'Source message not found in this conversation.' };
        }

        const title = payload.title || `${source.title} (branch)`;
        const newConv = conversationRepo.create(title, source.projectPath, source.model, source.kind);
        for (const msg of messagesToCopy) {
          messageRepo.create(newConv.id, msg.role, msg.content, msg.attachments);
        }
        conversationRepo.updateLastMessage(
          newConv.id,
          messagesToCopy[messagesToCopy.length - 1]?.content?.slice(0, 200) || '',
        );

        broadcast(Channels.CONVERSATIONS_CHANGED);
        return { ok: true, conversation: newConv };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
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

  ipcMain.handle(
    Channels.CONVERSATION_SET_SESSION_ID,
    (_e: IpcMainInvokeEvent, payload: { id: string; sessionId: string }): { ok: boolean } => {
      try {
        const conv = conversationRepo.getById(payload.id);
        if (conv) {
          conversationRepo.updateLastMessage(payload.id, conv.lastMessage ?? '', payload.sessionId);
          broadcast(Channels.CONVERSATIONS_CHANGED);
        }
        return { ok: true };
      } catch (err) {
        console.error('[Main] Failed to set session id:', err);
        return { ok: false };
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

  registerIpcHandler<MessageSendPayload>(
    Channels.MESSAGE_SEND,
    async (
      _e: IpcMainInvokeEvent,
      payload: MessageSendPayload,
    ): Promise<{ ok: boolean; error?: string; userMessage?: Message }> => {
      const { conversationId, message, attachments, permissionMode, thinkingEffort } = payload;
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
      // C7 修复：记录本次新建的 message id，CLI 启动失败时据此精确回滚，
      // 绝不影响已有历史。
      let userMessage: Message;
      try {
        userMessage = messageRepo.create(conversationId, 'user', message, atts);
      } catch (err) {
        return { ok: false, error: `Failed to save message: ${(err as Error).message}` };
      }
      try {
        conversationRepo.updateLastMessage(conversationId, message || atts[0]?.name || '');
      } catch (err) {
        // 预览更新失败不阻塞发送；消息已入库
        console.error('[Main] Failed to update conversation preview:', err);
      }
      pendingSendRollback.set(conversationId, userMessage.id);

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
          permissionMode: permissionMode || undefined,
          thinkingEffort: thinkingEffort || undefined,
        });
      } catch (err) {
        // C7 修复：spawn 同步失败 → 精确回滚本次新建的 user message
        rollbackPendingUserMessage(conversationId);
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
              } satisfies StreamChunkPayload);
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

  // -- History import (Claude Code 历史对话) ---------------------------------

  ipcMain.handle(Channels.HISTORY_SCAN, (): HistoryConversation[] => {
    try {
      return scanHistorySummaries();
    } catch (err) {
      console.error('[Main] Failed to scan history:', err);
      return [];
    }
  });

  ipcMain.handle(
    Channels.HISTORY_MESSAGES,
    (_e: IpcMainInvokeEvent, payload: { projectPath: string; sessionId: string }): HistoryConversationDetail | null => {
      try {
        return loadConversationDetail(payload.projectPath, payload.sessionId);
      } catch (err) {
        console.error('[Main] Failed to load history messages:', err);
        return null;
      }
    },
  );

  // -- Terminal (PTY) ---------------------------------------------------------

  ipcMain.handle(
    Channels.TERMINAL_CREATE,
    (e: IpcMainInvokeEvent, payload: { id: string; cwd?: string }): { ok: boolean; error?: string } => {
      console.log(`[Main] Creating terminal ${payload.id} in ${payload.cwd || 'default'}`);
      const result = ptyManager.create(payload.id, payload.cwd);
      console.log(`[Main] Terminal create result:`, result);
      if (result.ok) {
        // 注册输出回调，推送到渲染进程
        ptyManager.onData(payload.id, (data: string) => {
          const win = BrowserWindow.fromWebContents(e.sender);
          if (win && !win.isDestroyed()) {
            win.webContents.send(Channels.TERMINAL_DATA, { id: payload.id, data });
          }
        });
        // 注册退出回调
        ptyManager.onExit(payload.id, (exitCode: number) => {
          const win = BrowserWindow.fromWebContents(e.sender);
          if (win && !win.isDestroyed()) {
            win.webContents.send(Channels.TERMINAL_EXIT, { id: payload.id, exitCode });
          }
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    Channels.TERMINAL_WRITE,
    (_e: IpcMainInvokeEvent, payload: { id: string; data: string }): void => {
      console.log(`[Main] Terminal write to ${payload.id}: ${JSON.stringify(payload.data)}`);
      ptyManager.write(payload.id, payload.data);
    },
  );

  ipcMain.handle(
    Channels.TERMINAL_RESIZE,
    (_e: IpcMainInvokeEvent, payload: { id: string; cols: number; rows: number }): void => {
      ptyManager.resize(payload.id, payload.cols, payload.rows);
    },
  );

  ipcMain.handle(
    Channels.TERMINAL_KILL,
    (_e: IpcMainInvokeEvent, payload: { id: string }): void => {
      ptyManager.kill(payload.id);
    },
  );

  // -- Claude PTY (交互式 Claude Code 终端) -----------------------------------

  ipcMain.handle(
    Channels.CLAUDE_PTY_CREATE,
    (e: IpcMainInvokeEvent, payload: {
      id: string;
      cwd: string;
      model?: string;
      resumeSessionId?: string;
      permissionMode?: string;
      addDirs?: string[];
    }): { ok: boolean; error?: string } => {
      const { id, cwd, model, resumeSessionId, permissionMode, addDirs } = payload;

      // 权限模式映射（使用共享映射）
      const cliPermissionMode = mapPermissionModeForPty(permissionMode);

      const result = claudePtyManager.create(id, {
        cwd,
        model: model && model !== 'default' ? model : undefined,
        resumeSessionId,
        permissionMode: cliPermissionMode,
        addDirs,
      });

      if (result.ok) {
        // 注册输出回调，推送到渲染进程
        claudePtyManager.onData(id, (data: string) => {
          // 发送到所有绑定此会话的窗口
          for (const [winId, convId] of windowBindings) {
            if (convId !== id) continue;
            const win = BrowserWindow.fromId(winId);
            if (!win || win.isDestroyed()) continue;
            const contents = win.webContents;
            if (!contents || contents.isDestroyed()) continue;
            contents.send(Channels.CLAUDE_PTY_DATA, { id, data });
          }
          // 也发送到触发创建的窗口（可能还未绑定）
          const senderWin = BrowserWindow.fromWebContents(e.sender);
          if (senderWin && !senderWin.isDestroyed()) {
            const contents = senderWin.webContents;
            if (contents && !contents.isDestroyed()) {
              // 避免重复发送（如果已绑定则上面已发送）
              let alreadySent = false;
              for (const [winId, convId] of windowBindings) {
                if (convId === id && winId === senderWin.id) { alreadySent = true; break; }
              }
              if (!alreadySent) {
                contents.send(Channels.CLAUDE_PTY_DATA, { id, data });
              }
            }
          }
        });

        // 注册权限提示回调，推送到渲染进程
        claudePtyManager.onPermission(id, (permission: ClaudePtyPermission) => {
          for (const [winId, convId] of windowBindings) {
            if (convId !== id) continue;
            const win = BrowserWindow.fromId(winId);
            if (!win || win.isDestroyed()) continue;
            const contents = win.webContents;
            if (!contents || contents.isDestroyed()) continue;
            contents.send(Channels.CLAUDE_PTY_PERMISSION, permission);
          }
          const senderWin = BrowserWindow.fromWebContents(e.sender);
          if (senderWin && !senderWin.isDestroyed()) {
            const contents = senderWin.webContents;
            if (contents && !contents.isDestroyed()) {
              let alreadySent = false;
              for (const [winId, convId] of windowBindings) {
                if (convId === id && winId === senderWin.id) { alreadySent = true; break; }
              }
              if (!alreadySent) {
                contents.send(Channels.CLAUDE_PTY_PERMISSION, permission);
              }
            }
          }
        });

        // 注册退出回调
        claudePtyManager.onExit(id, (exitCode: number) => {
          // 停止 session watcher（spec: CLAUDE_PTY_EXIT handler 中自动停止对应 watcher）
          sessionWatcherManager.stop(id);

          for (const [winId, convId] of windowBindings) {
            if (convId !== id) continue;
            const win = BrowserWindow.fromId(winId);
            if (!win || win.isDestroyed()) continue;
            const contents = win.webContents;
            if (!contents || contents.isDestroyed()) continue;
            contents.send(Channels.CLAUDE_PTY_EXIT, { id, exitCode });
          }
          const senderWin = BrowserWindow.fromWebContents(e.sender);
          if (senderWin && !senderWin.isDestroyed()) {
            const contents = senderWin.webContents;
            if (contents && !contents.isDestroyed()) {
              let alreadySent = false;
              for (const [winId, convId] of windowBindings) {
                if (convId === id && winId === senderWin.id) { alreadySent = true; break; }
              }
              if (!alreadySent) {
                contents.send(Channels.CLAUDE_PTY_EXIT, { id, exitCode });
              }
            }
          }
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    Channels.CLAUDE_PTY_WRITE,
    (_e: IpcMainInvokeEvent, payload: { id: string; data: string }): void => {
      claudePtyManager.write(payload.id, payload.data);
    },
  );

  ipcMain.handle(
    Channels.CLAUDE_PTY_RESIZE,
    (_e: IpcMainInvokeEvent, payload: { id: string; cols: number; rows: number }): void => {
      claudePtyManager.resize(payload.id, payload.cols, payload.rows);
    },
  );

  ipcMain.handle(
    Channels.CLAUDE_PTY_KILL,
    (_e: IpcMainInvokeEvent, payload: { id: string }): void => {
      claudePtyManager.kill(payload.id);
    },
  );

  /** 发送文本到 Claude PTY（自动追加换行符，模拟用户回车） */
  ipcMain.handle(
    Channels.CLAUDE_PTY_SEND_TEXT,
    (_e: IpcMainInvokeEvent, payload: { id: string; text: string }): void => {
      const text = payload.text;
      // 如果文本以 / 开头（斜杠命令），直接发送 + 回车
      // 否则也直接发送 + 回车
      claudePtyManager.write(payload.id, text + '\r');
    },
  );

  /** 发送特殊按键到 Claude PTY（如 Ctrl+C, Ctrl+D, Escape 等） */
  ipcMain.handle(
    Channels.CLAUDE_PTY_SEND_KEY,
    (_e: IpcMainInvokeEvent, payload: { id: string; key: string }): void => {
      const keyMap: Record<string, string> = {
        'ctrl-c': '\x03',
        'ctrl-d': '\x04',
        'ctrl-z': '\x1a',
        'ctrl-l': '\x0c',
        'ctrl-a': '\x01',
        'ctrl-e': '\x05',
        'ctrl-k': '\x0b',
        'ctrl-u': '\x15',
        'ctrl-w': '\x17',
        'escape': '\x1b',
        'enter': '\r',
        'tab': '\t',
        'up': '\x1b[A',
        'down': '\x1b[B',
        'right': '\x1b[C',
        'left': '\x1b[D',
      };
      const seq = keyMap[payload.key];
      if (seq) {
        claudePtyManager.write(payload.id, seq);
      }
    },
  );

  /**
   * 扫描 ~/.claude/projects/<encoded-cwd>/ 目录下最新的 session 文件，
   * 返回 session ID（文件名，不含扩展名）。
   * 用于在 Terminal 模式下捕获 claude 交互式会话的 ID，以便 --resume。
   */
  ipcMain.handle(
    Channels.CLAUDE_PTY_GET_SESSION_ID,
    (_e: IpcMainInvokeEvent, payload: { cwd: string }): { sessionId: string | null } => {
      try {
        const claudeDir = path.join(os.homedir(), '.claude', 'projects');
        if (!fs.existsSync(claudeDir)) return { sessionId: null };

        // Claude Code 编码项目路径：将 / 替换为 -，移除开头的 -
        const encodedCwd = payload.cwd.replace(/\//g, '-').replace(/^-+/, '');
        const projectDir = path.join(claudeDir, encodedCwd);

        if (!fs.existsSync(projectDir)) return { sessionId: null };

        // 查找最新的 .jsonl 文件
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fullPath = path.join(projectDir, f);
            const stat = fs.statSync(fullPath);
            return { name: f, mtime: stat.mtime.getTime() };
          })
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) return { sessionId: null };

        // 返回最新的 session ID（去掉 .jsonl 扩展名）
        const sessionId = files[0].name.replace(/\.jsonl$/, '');
        return { sessionId };
      } catch (err) {
        console.error('[Main] Failed to get session ID:', err);
        return { sessionId: null };
      }
    },
  );

  // -- File explorer ----------------------------------------------------------

  /** 检查 Claude PTY 是否活跃 */
  ipcMain.handle(
    Channels.CLAUDE_PTY_IS_ACTIVE,
    (_e: IpcMainInvokeEvent, payload: { id: string }): { active: boolean } => {
      return { active: claudePtyManager.isActive(payload.id) };
    },
  );

  // -- Session Watcher (结构化事件提取) ---------------------------------------

  /** 启动 session 文件监听 */
  ipcMain.handle(
    Channels.SESSION_WATCHER_START,
    (e: IpcMainInvokeEvent, payload: {
      id: string;
      sessionId: string;
      cwd: string;
    }): { ok: boolean } => {
      const { id, sessionId, cwd } = payload;
      sessionWatcherManager.start(id, sessionId, cwd, (event: SessionEvent) => {
        // 发送到所有绑定此会话的窗口
        for (const [winId, convId] of windowBindings) {
          if (convId !== id) continue;
          const win = BrowserWindow.fromId(winId);
          if (!win || win.isDestroyed()) continue;
          const contents = win.webContents;
          if (!contents || contents.isDestroyed()) continue;
          contents.send(Channels.SESSION_EVENT, { id, event });
        }
        // 也发送到触发创建的窗口
        const senderWin = BrowserWindow.fromWebContents(e.sender);
        if (senderWin && !senderWin.isDestroyed()) {
          const contents = senderWin.webContents;
          if (contents && !contents.isDestroyed()) {
            let alreadySent = false;
            for (const [winId, convId] of windowBindings) {
              if (convId === id && winId === senderWin.id) { alreadySent = true; break; }
            }
            if (!alreadySent) {
              contents.send(Channels.SESSION_EVENT, { id, event });
            }
          }
        }
      });
      return { ok: true };
    },
  );

  /** 停止 session 文件监听 */
  ipcMain.handle(
    Channels.SESSION_WATCHER_STOP,
    (_e: IpcMainInvokeEvent, payload: { id: string }): void => {
      sessionWatcherManager.stop(payload.id);
    },
  );

  /** 获取已解析的全部事件（用于面板初始化时回放） */
  ipcMain.handle(
    Channels.SESSION_WATCHER_GET_EVENTS,
    (_e: IpcMainInvokeEvent, payload: { id: string }): { events: SessionEvent[] } => {
      return { events: sessionWatcherManager.getEvents(payload.id) };
    },
  );

  // ---------------------------------------------------------------------------
  // Agent SDK IPC handlers
  // ---------------------------------------------------------------------------

  // Wire up the bridge event callback to push events to the renderer + persist
  agentBridge.onEvent((convId, event) => {
    // --- Persistence logic (serialized via queue to prevent race conditions) ---
    enqueueAgentPersistence(convId, async () => {
      // A5：任何回复产出事件都说明回复已开始 → 不再回滚 user message
      if (
        event.type === 'text' || event.type === 'text_delta' ||
        event.type === 'thinking' || event.type === 'thinking_delta' ||
        event.type === 'tool_use' || event.type === 'tool_result'
      ) {
        pendingAgentUserMessages.delete(convId);
      }

      switch (event.type) {
        case 'text': {
          // Full text block from assistant message — 用完整文本覆盖该 messageId
          // 的临时文本（绝不追加），消除 delta + 最终 text 的落库重复。
          const acc = agentTextAccumulators.get(convId) || new AgentTextAccumulator();
          agentTextAccumulators.set(convId, acc);
          acc.onFinalText((event as any).messageId, (event as any).text ?? '');
          break;
        }
        case 'text_delta': {
          // Streaming delta — 只更新该 messageId 的临时文本
          const acc = agentTextAccumulators.get(convId) || new AgentTextAccumulator();
          agentTextAccumulators.set(convId, acc);
          acc.onDelta((event as any).messageId, (event as any).delta ?? '');
          break;
        }
        case 'tool_use': {
          // Persist tool_use as structured content block
          const blocks = agentContentBlocks.get(convId) || [];
          blocks.push({
            type: 'tool_use',
            toolName: (event as any).toolName,
            toolUseId: (event as any).toolUseId,
            input: (event as any).input,
          });
          agentContentBlocks.set(convId, blocks);
          break;
        }
        case 'tool_result': {
          // Persist tool_result
          const blocks = agentContentBlocks.get(convId) || [];
          blocks.push({
            type: 'tool_result',
            toolUseId: (event as any).toolUseId,
            content: (event as any).content,
            isError: (event as any).isError,
          });
          agentContentBlocks.set(convId, blocks);
          break;
        }
        case 'thinking': {
          const blocks = agentContentBlocks.get(convId) || [];
          blocks.push({ type: 'thinking', text: (event as any).text });
          agentContentBlocks.set(convId, blocks);
          break;
        }
        case 'result': {
          // Turn complete — flush all accumulated messages
          pendingAgentUserMessages.delete(convId);
          flushAgentMessages(convId);
          broadcast(Channels.CONVERSATIONS_CHANGED);
          break;
        }
        case 'error': {
          // A5 修复：发送后未产出任何回复就报错（启动失败）→ 精确回滚
          // user message，不留幽灵消息。已有回复产出时 pending 已被清除。
          const pendingId = pendingAgentUserMessages.get(convId);
          if (pendingId) {
            pendingAgentUserMessages.delete(convId);
            rollbackAgentUserMessage(convId, pendingId);
          }
          break;
        }
      }
    });

    // --- Push to renderer ---
    for (const [winId, boundConvId] of windowBindings) {
      if (boundConvId !== convId) continue;
      const win = BrowserWindow.fromId(winId);
      if (!win || win.isDestroyed()) continue;
      const contents = win.webContents;
      if (!contents || contents.isDestroyed()) continue;
      contents.send(Channels.AGENT_EVENT, { convId, event });
    }
  });

  ipcMain.handle(
    Channels.AGENT_CREATE,
    (_e: IpcMainInvokeEvent, payload: {
      convId: string;
      cwd: string;
      model?: string;
      permissionMode?: string;
      thinkingEffort?: string;
      /** 从外部会话（终端 CLI 等）续接：首次发送时 resume 这个 session */
      resumeSessionId?: string;
    }): { ok: boolean; sessionStatus: string } => {
      const settings = loadSettings();
      agentBridge.createSession(payload.convId, {
        cwd: payload.cwd,
        model: payload.model,
        permissionMode: payload.permissionMode as any,
        thinkingEffort: payload.thinkingEffort as any,
        apiKey: settings.apiKey as string | undefined,
        resumeSessionId: payload.resumeSessionId,
        // skills 总开关：false → 传 []（禁用全部）；默认不传（全部加载）
        ...(settings.skillsEnabled === false ? { skills: [] } : {}),
      });
      return { ok: true, sessionStatus: agentBridge.getStatus(payload.convId) };
    },
  );

  ipcMain.handle(
    Channels.AGENT_SEND,
    async (_e: IpcMainInvokeEvent, payload: {
      convId: string;
      text: string;
      attachments?: Attachment[];
      model?: string;
      permissionMode?: string;
      thinkingEffort?: string;
    }): Promise<{ ok: boolean; error?: string; userMessage?: Message }> => {
     try {
        // A5 修复：先原子确认 session 可接收消息，再持久化 user message。
        // 快速连发时第二次发送在这里被拒绝，返回 { ok:false, error }，不写库。
        const canSend = agentBridge.checkCanSend(payload.convId);
        if (!canSend.ok) {
          return { ok: false, error: canSend.error };
        }

        // Flush any previous turn's partial data before starting a new turn,
        // so the accumulated assistant blocks are committed to DB cleanly.
        flushAgentMessages(payload.convId);

        // Persist the user message to the database (text + attachments)。
        // A13 修复：返回真实 SQLite message id，前端据此替换 optimistic block。
        let userMessage: Message;
        try {
          userMessage = messageRepo.create(payload.convId, 'user', payload.text, payload.attachments || []);
          conversationRepo.updateLastMessage(payload.convId, payload.text || payload.attachments?.[0]?.name || '');
        } catch (err) {
          console.error('[Main] Failed to persist agent user message:', err);
          return { ok: false, error: `Failed to save message: ${(err as Error).message}` };
        }
        // A5：登记待确认启动的 user message（error 事件且无回复产出时回滚）
        pendingAgentUserMessages.set(payload.convId, userMessage.id);

        // Update session options if provided (for mid-conversation changes)
        agentBridge.updateOptions(payload.convId, {
          model: payload.model,
          permissionMode: payload.permissionMode as any,
          thinkingEffort: payload.thinkingEffort as any,
        });

        // Fire-and-forget: sendMessage runs the whole turn asynchronously.
        // 若发送在产出任何回复前被拒绝（如 SDK 加载失败），精确回滚刚创建的
        // user message，保证被拒的发送不落库。
        agentBridge.sendMessage(payload.convId, payload.text, payload.attachments || []).catch((err) => {
          console.error('[Main] Agent sendMessage failed:', err);
          pendingAgentUserMessages.delete(payload.convId);
          rollbackAgentUserMessage(payload.convId, userMessage.id);
        });
        return { ok: true, userMessage };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    Channels.AGENT_ABORT,
    async (_e: IpcMainInvokeEvent, payload: { convId: string }): Promise<{ ok: boolean }> => {
      // A5：用户主动停止 → 消息已真正发出，不回滚
      pendingAgentUserMessages.delete(payload.convId);
      await agentBridge.abort(payload.convId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.AGENT_PERMISSION_RESPOND,
    (_e: IpcMainInvokeEvent, payload: { convId: string; decision: PermissionDecision }): { ok: boolean } => {
      agentBridge.respondPermission(payload.convId, payload.decision);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.AGENT_GET_STATUS,
    (_e: IpcMainInvokeEvent, payload: { convId: string }): { status: string } => {
      return { status: agentBridge.getStatus(payload.convId) };
    },
  );

  ipcMain.handle(
    Channels.AGENT_GET_CHANGED_FILES,
    (_e: IpcMainInvokeEvent, payload: { convId: string }): { files: { tool: string; timestamp: number; filePath: string }[] } => {
      return { files: agentBridge.getChangedFiles(payload.convId) };
    },
  );

  ipcMain.handle(
    Channels.AGENT_DESTROY,
    (_e: IpcMainInvokeEvent, payload: { convId: string }): { ok: boolean } => {
      pendingAgentUserMessages.delete(payload.convId);
      agentBridge.destroySession(payload.convId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.AGENT_GET_PENDING_PERMISSION,
    (_e: IpcMainInvokeEvent, payload: { convId: string }): unknown => {
      return agentBridge.getPendingPermissions(payload.convId);
    },
  );

  // Settings
  ipcMain.handle(
    Channels.SETTINGS_GET,
    (_e: IpcMainInvokeEvent, payload: { key: string }): { value: unknown } => {
      const settings = loadSettings();
      return { value: settings[payload.key] };
    },
  );

  ipcMain.handle(
    Channels.SETTINGS_SET,
    (_e: IpcMainInvokeEvent, payload: { key: string; value: unknown }): { ok: boolean } => {
      const settings = loadSettings();
      settings[payload.key] = payload.value;
      saveSettings(settings);
      return { ok: true };
    },
  );

  // -- Skills 扫描（设置面板）

  ipcMain.handle(
    Channels.SKILLS_LIST,
    (_e: IpcMainInvokeEvent, payload: { projectPaths?: string[] }): { skills: SkillInfo[] } => {
      return { skills: scanSkills(payload.projectPaths || []) };
    },
  );

  // -- File explorer

  ipcMain.handle(
    Channels.FILE_LIST,
    (_e: IpcMainInvokeEvent, payload: { dirPath: string }): { name: string; path: string; isDirectory: boolean; extension?: string }[] => {
      try {
        const entries = fs.readdirSync(payload.dirPath, { withFileTypes: true });
        // 过滤隐藏文件和 node_modules，排序：目录在前，文件在后
        const filtered = entries
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__')
          .map(e => ({
            name: e.name,
            path: path.join(payload.dirPath, e.name),
            isDirectory: e.isDirectory(),
            extension: e.isDirectory() ? undefined : path.extname(e.name).slice(1),
          }));
        filtered.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return filtered;
      } catch (err) {
        console.error('[Main] Failed to list directory:', err);
        return [];
      }
    },
  );

  ipcMain.handle(
    Channels.FILE_READ,
    (_e: IpcMainInvokeEvent, payload: { filePath: string }): { ok: boolean; content?: string; error?: string } => {
      try {
        const stat = fs.statSync(payload.filePath);
        // 限制文件大小（最大 500KB）
        if (stat.size > 500 * 1024) {
          return { ok: false, error: 'File too large (>500KB)' };
        }
        const content = fs.readFileSync(payload.filePath, 'utf-8');
        return { ok: true, content };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // -- Git diff ---------------------------------------------------------------


  ipcMain.handle(
    Channels.FILE_SEARCH,
    (e: IpcMainInvokeEvent, payload: { query: string; cwd?: string }): { name: string; path: string; isDirectory: boolean }[] => {
      try {
        const { query, cwd } = payload;
        if (!query || query.length < 1) return [];
        // Use the active conversation's project path as the search root
        const searchRoot = cwd || e.sender.getTitle() || os.homedir();
        const lowerQuery = query.toLowerCase();
        // Simple recursive search limited to 3 levels deep
        const results: { name: string; path: string; isDirectory: boolean }[] = [];
        const maxResults = 20;
        const maxDepth = 3;
        const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);

        function walk(dir: string, depth: number) {
          if (depth > maxDepth || results.length >= maxResults) return;
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (results.length >= maxResults) return;
            if (ignored.has(entry.name)) continue;
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            const isDir = entry.isDirectory();
            if (entry.name.toLowerCase().includes(lowerQuery)) {
              results.push({ name: entry.name, path: fullPath, isDirectory: isDir });
            }
            if (isDir) walk(fullPath, depth + 1);
          }
        }
        walk(searchRoot, 0);
        // Sort: exact prefix matches first, then alphabetical
        results.sort((a, b) => {
          const aPrefix = a.name.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
          const bPrefix = b.name.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
          if (aPrefix !== bPrefix) return aPrefix - bPrefix;
          return a.name.localeCompare(b.name);
        });
        return results;
      } catch (err) {
        console.error('[Main] File search error:', err);
        return [];
      }
    },
  );

  ipcMain.handle(
    Channels.GIT_DIFF,
    (_e: IpcMainInvokeEvent, payload: { dirPath: string }): { ok: boolean; files?: any[]; error?: string } => {
      try {
        // 检查是否是 git 仓库
        try {
          execSync('git rev-parse --is-inside-work-tree', { cwd: payload.dirPath, stdio: 'pipe' });
        } catch {
          return { ok: false, error: 'Not a git repository' };
        }

        // 获取变更文件列表
        const statusOutput = execSync('git diff --name-status HEAD', {
          cwd: payload.dirPath,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        }).trim();

        if (!statusOutput) {
          // 也检查暂存区
          const stagedOutput = execSync('git diff --cached --name-status', {
            cwd: payload.dirPath,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
          }).trim();
          if (!stagedOutput) return { ok: true, files: [] };

          return parseDiffFiles(stagedOutput, payload.dirPath, true);
        }

        return parseDiffFiles(statusOutput, payload.dirPath, false);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // -- 配置读取（cc-switch 集成） --------------------------------------------

  ipcMain.handle(Channels.CONFIG_READ, (): ConfigReadResult => {
    return readClaudeSettings();
  });
}

// ---------------------------------------------------------------------------
// cc-switch 配置解析
// ---------------------------------------------------------------------------

interface ModelConfig {
  id: string;
  name: string;
  desc: string;
}

interface ConfigReadResult {
  models: ModelConfig[];
  defaultModel: string;
  effortLevel: string;
  /** cc-switch 配置的当前默认别名（opus/sonnet/haiku），用于 Default 选项的描述 */
  currentAlias: string;
}

/**
 * 读取 ~/.claude/settings.json，解析 cc-switch 配置的模型映射。
 *
 * cc-switch 通过环境变量把 opus/sonnet/haiku 别名映射到真实模型：
 *   env.ANTHROPIC_DEFAULT_OPUS_MODEL   = "kimi-k2.7-code"
 *   env.ANTHROPIC_DEFAULT_SONNET_MODEL = "doubao-seed-2.0-pro"
 *   env.ANTHROPIC_DEFAULT_HAIKU_MODEL  = "glm-5.2"
 *   model = "haiku"  (当前默认别名)
 *   effortLevel = "medium"
 *
 * 前端据此动态生成模型列表，显示真实模型名而非硬编码的 "Opus 4" 等。
 */
function readClaudeSettings(): ConfigReadResult {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 文件不存在或解析失败：返回仅含 Default 的兜底列表
  }

  const env = (settings.env as Record<string, string>) || {};

  // 别名 -> 真实模型名（优先 _MODEL，回退 _MODEL_NAME）
  const aliasMap: Record<string, string> = {
    opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME || '',
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME || '',
    haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME || '',
  };

  const currentAlias = (settings.model as string) || 'sonnet';
  const defaultReal = aliasMap[currentAlias] || '';

  const models: ModelConfig[] = [];

  // Default 选项 - 不传 --model，走 cc-switch 配置
  models.push({
    id: 'default',
    name: 'Default',
    desc: defaultReal
      ? `cc-switch · ${currentAlias} → ${defaultReal}`
      : 'cc-switch configured model',
  });

  // 各别名选项 - 显示真实模型名
  const aliasLabels: Record<string, string> = {
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
  };
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    const real = aliasMap[alias];
    if (real) {
      models.push({
        id: alias,
        name: aliasLabels[alias],
        desc: real,
      });
    }
  }

  // 如果一个别名都没配置，至少保证有 default + 一个兜底选项
  if (models.length === 1) {
    models.push({ id: 'sonnet', name: 'Sonnet', desc: 'Claude Sonnet (default)' });
  }

  return {
    models,
    defaultModel: 'default',
    effortLevel: (settings.effortLevel as string) || 'medium',
    currentAlias,
  };
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
  cliSpawner.destroyAll();
  ptyManager.killAll();
  claudePtyManager.killAll();
  sessionWatcherManager.stopAll();
  agentBridge.destroyAll();
  database.close();
});
