/**
 * Agent SDK Bridge — core service layer that wraps the Claude Agent SDK.
 *
 * Responsibilities:
 *   - Manage sessions (one per conversation)
 *   - Drive multi-turn conversations via query() + resume
 *   - Translate SDKMessage events into our AgentEvent IPC format
 *   - Handle canUseTool permission flow (bridge → renderer → bridge)
 *   - Track file changes for RightPanel integration
 *   - Implement abort / retry / status state machine
 *
 * NOTE: The @anthropic-ai/claude-agent-sdk is an ESM-only package. Since the
 * Electron main process runs as CommonJS, we lazy-load it via dynamic import().
 */
import type { SDKMessage, PermissionResult, Query as SDKQuery, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import path from 'path';
import { resolveCwd } from './resolve-cwd';
import type {
  AgentStatus,
  AgentEvent,
  PermissionDecision,
  FileChangeRecord,
  AgentBridgeSession,
} from '../types/agent';

/** Attachment shape received from the renderer via main. */
export interface BridgeAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  size: number;
  mimeType?: string;
  dataUrl?: string;
  path?: string;
}

// Lazy-loaded SDK query function (loaded on first sendMessage call).
type SdkQueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query;
let sdkQuery: SdkQueryFn | null = null;
let sdkLoadError: Error | null = null;

/**
 * Dynamic import that survives TypeScript CommonJS compilation.
 * TypeScript's CJS target rewrites `import()` → `require()`, which cannot
 * load ESM packages. `new Function` returns a real dynamic import() at runtime.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = any>(specifier: string) => Promise<T>;

async function ensureSdk(): Promise<SdkQueryFn> {
  if (sdkQuery) return sdkQuery;
  // A3 修复：不再永久缓存加载错误 — 每次调用都重试动态 import，
  // 只有明确成功才缓存 query。SDK 临时不可用（如首次 npm install 后）
  // 不再需要重启应用才能恢复。
  try {
    const mod = await dynamicImport('@anthropic-ai/claude-agent-sdk');
    sdkQuery = (mod as any).query;
    sdkLoadError = null;
    return sdkQuery!;
  } catch (err) {
    sdkLoadError = err instanceof Error ? err : new Error(String(err));
    throw sdkLoadError;
  }
}

/**
 * 构建 query 的 prompt。
 *
 * 关键：Agent SDK 的 `query()` 支持 `prompt: string | AsyncIterable<SDKUserMessage>`。
 * 字符串 prompt 不会经过 CLI 的 @引用预处理器 —— 之前用 `@/tmp/xxx.png` 传图片
 * 模型根本看不到（就是用户遇到的"不能直接看到"）。
 *
 * 正确做法：有附件时用 AsyncIterable<SDKUserMessage>，直接把图片作为
 * `image` content block（base64）传给模型，与原生 Claude Code CLI 行为一致。
 * 文件附件则作为 text 块给出路径（agent 会用 Read 工具自行读取，并受
 * additionalDirectories 权限约束）。
 */
function buildPrompt(
  text: string,
  attachments: BridgeAttachment[],
): string | AsyncIterable<SDKUserMessage> {
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
  const files = attachments.filter((a) => a.kind === 'file' && a.path);

  // 无附件 → 保持简单字符串 prompt（与之前行为一致）
  if (images.length === 0 && files.length === 0) {
    return text;
  }

  const content: SDKUserMessage['message']['content'] = [];
  // 文本内容（可能为空 → 给个占位避免空 content）
  content.push({ type: 'text', text: text || '（附带了图片/文件，请查看）' });
  // 图片 → image content block（base64）
  for (const img of images) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(img.dataUrl!);
    if (!m) continue;
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: m[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: m[2],
      },
    });
  }
  // 文件 → text 块给出路径（agent 用 Read 读取）
  for (const f of files) {
    content.push({ type: 'text', text: `[附件文件] ${f.path}` });
  }

  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } satisfies SDKUserMessage;
  })();
}


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeSessionOptions {
  cwd: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  thinkingEffort?: 'none' | 'low' | 'medium' | 'high';
  apiKey?: string;
  additionalDirectories?: string[];
  /**
   * Skills 过滤。undefined = 不传（CLI 默认全部加载）；
   * [] = 禁用全部 skills；string[] = 只加载列出的。
   */
  skills?: string[];
  /** 从外部会话（终端 CLI 等）续接：首次发送时 resume 这个 session id。 */
  resumeSessionId?: string;
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (err: Error) => void;
  request: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    reason?: string;
    title?: string;
    displayName?: string;
    suggestions?: unknown[];
  };
  /** A7 修复：保存 abort 监听器与 signal，权限响应后移除，避免长会话累积泄漏。 */
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface SessionState {
  sessionId: string | null;
  status: AgentStatus;
  query: SDKQuery | null;
  abortController: AbortController | null;
  changedFiles: FileChangeRecord[];
  pendingPermissions: Map<string, PendingPermission>;
  /** toolUseId -> {toolName, filePath} for correlating tool_result events. */
  toolUseMeta: Map<string, { toolName: string; filePath?: string }>;
  options: BridgeSessionOptions;
  /** The conversation ID this session belongs to. */
  convId: string;
}

type EventCallback = (convId: string, event: AgentEvent) => void;

// ---------------------------------------------------------------------------
// Bridge class
// ---------------------------------------------------------------------------

export class AgentSdkBridge {
  private sessions = new Map<string, SessionState>();
  private eventCallback: EventCallback | null = null;

  /** Register the callback that pushes events to the renderer. */
  onEvent(cb: EventCallback): void {
    this.eventCallback = cb;
  }

  /**
   * Create or reuse a session for a conversation. If a session already exists
   * (e.g. the view remounted after a tab switch), keep it alive — including any
   * running query and session ID — and just refresh the options. This prevents
   * an active agent conversation from being killed when the user switches tabs.
   */
  createSession(convId: string, options: BridgeSessionOptions): void {
    const existing = this.sessions.get(convId);
    if (existing) {
      existing.options = { ...options, cwd: resolveCwd(options.cwd) };
      return;
    }
    this.sessions.set(convId, {
      sessionId: null,
      status: 'idle',
      query: null,
      abortController: null,
      changedFiles: [],
      pendingPermissions: new Map(),
      toolUseMeta: new Map(),
      options: { ...options, cwd: resolveCwd(options.cwd) },
      convId,
    });
  }

  /** Get session or throw. */
  private getSession(convId: string): SessionState {
    const s = this.sessions.get(convId);
    if (!s) throw new Error(`No agent session for conversation ${convId}`);
    return s;
  }

  /** Emit an event to the renderer. */
  private emit(convId: string, event: AgentEvent): void {
    if (this.eventCallback) {
      this.eventCallback(convId, event);
    }
  }

  /** Update session status and emit status event. */
  private setStatus(convId: string, status: AgentStatus, extra?: Record<string, unknown>): void {
    const s = this.sessions.get(convId);
    if (s) s.status = status;
    this.emit(convId, {
      type: 'status',
      sessionId: s?.sessionId || '',
      timestamp: Date.now(),
      status,
      ...extra,
    });
  }

  // -------------------------------------------------------------------------
  // Send message (core multi-turn logic)
  // -------------------------------------------------------------------------

  async sendMessage(convId: string, text: string, attachments: BridgeAttachment[] = []): Promise<void> {
    const state = this.getSession(convId);
    if (state.status !== 'idle' && state.status !== 'completed') {
      throw new Error(`Cannot send message: agent is ${state.status}`);
    }

    const abortController = new AbortController();
    state.abortController = abortController;

    // A2 修复：sessionId 不再提前写入 state。
    // SDK 在 system(init) 消息中返回真实 session_id（handleSystemMessage 里赋值）。
    // 若本轮 query 失败（从未创建 session），state.sessionId 保持 null，
    // 下一轮会重新生成新 UUID 走首次创建路径，而不是 resume 一个不存在的 session。
    // resumeSessionId：从外部会话（终端 CLI 等）续接时，首次发送走 resume 路径
    const resumeSession = state.options.resumeSessionId;
    const isFirstMessage = !state.sessionId && !resumeSession;
    const sessionId = state.sessionId || resumeSession || randomUUID();

    // Attachments → 用 AsyncIterable<SDKUserMessage> 直接传 image content block
    // （字符串 prompt 不经过 @ 引用预处理，图片必须走 content block）
    const prompt = buildPrompt(text, attachments);

    // 文件附件可能位于 cwd 之外 — 授予这些目录的读取权限（agent 用 Read 时免询问）
    let additionalDirectories = state.options.additionalDirectories || [];
    const fileDirs = attachments
      .filter((a) => a.kind === 'file' && a.path)
      .map((a) => path.dirname(a.path!))
      .filter((d) => path.resolve(d) !== path.resolve(state.options.cwd));
    for (const dir of fileDirs) {
      if (!additionalDirectories.includes(dir)) additionalDirectories = [...additionalDirectories, dir];
    }

    this.setStatus(convId, 'requesting');

    try {
      // Lazy-load the ESM SDK on first use
      const query = await ensureSdk();

      const queryResult = query({
        prompt,
        options: {
          cwd: state.options.cwd,
          model: state.options.model && state.options.model !== 'default' ? state.options.model : undefined,
          permissionMode: this.mapPermissionMode(state.options.permissionMode),
          ...(state.options.thinkingEffort && state.options.thinkingEffort !== 'none' ? { effort: this.mapThinkingEffort(state.options.thinkingEffort) } : {}),
          abortController,
          includePartialMessages: true,
          settingSources: ['user', 'project', 'local'],
          ...(isFirstMessage
            ? { sessionId }
            : { resume: sessionId }),
          ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
          // skills 过滤：undefined = 全部加载；[] = 全部禁用；string[] = 白名单
          ...(state.options.skills !== undefined ? { skills: state.options.skills } : {}),
          canUseTool: (toolName, input, options) => this.handleCanUseTool(convId, toolName, input, options),
          ...(state.options.apiKey ? {
            env: { ...process.env, ANTHROPIC_API_KEY: state.options.apiKey },
          } : {}),
        },
      });

      state.query = queryResult;

      // 拉取会话真实可用 skills（supportedCommands），推给 renderer 命令面板
      this.refreshSkills(convId, queryResult);

      // Iterate through the async generator
      for await (const msg of queryResult) {
        if (abortController.signal.aborted) break;
        this.processSdkMessage(convId, msg);
      }

      // If we get here normally, the turn completed
      if (!abortController.signal.aborted) {
        this.setStatus(convId, 'idle');
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        this.setStatus(convId, 'idle');
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.setStatus(convId, 'error');
        this.emit(convId, {
          type: 'error',
          sessionId: state.sessionId || '',
          timestamp: Date.now(),
          message: errorMessage,
          recoverable: true,
        });
      }
    } finally {
      state.query = null;
      state.abortController = null;
    }
  }

  // -------------------------------------------------------------------------
  // Process SDK messages
  // -------------------------------------------------------------------------

  private processSdkMessage(convId: string, msg: SDKMessage): void {
    const state = this.sessions.get(convId);
    if (!state) return;

    switch (msg.type) {
      case 'assistant':
        this.handleAssistantMessage(convId, msg);
        break;

      case 'stream_event':
        this.handleStreamEvent(convId, msg);
        break;

      case 'system':
        this.handleSystemMessage(convId, msg);
        break;

      case 'result':
        this.handleResultMessage(convId, msg);
        break;

      case 'tool_progress':
        // Tool is executing — update status
        if (state.status !== 'waiting_permission') {
          this.setStatus(convId, 'tool_executing', {
            toolName: msg.tool_name,
            label: `Running ${msg.tool_name}...`,
          });
        }
        break;

      case 'tool_use_summary':
        // Optional: show tool summary
        break;

      case 'user':
        // User messages carry tool_result blocks - extract and emit them.
        this.handleUserMessage(convId, msg);
        break;

      default:
        // Ignore other message types
        break;
    }
  }

  private handleAssistantMessage(convId: string, msg: SDKMessage & { type: 'assistant' }): void {
    const state = this.sessions.get(convId);
    if (!state) return;
    const messageId = msg.uuid;

    // Process content blocks from the BetaMessage
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      switch (block.type) {
        case 'text':
          this.emit(convId, {
            type: 'text',
            sessionId: state.sessionId || '',
            timestamp: Date.now(),
            text: block.text,
            messageId,
          });
          break;

        case 'thinking':
          this.emit(convId, {
            type: 'thinking',
            sessionId: state.sessionId || '',
            timestamp: Date.now(),
            text: block.thinking,
            messageId,
          });
          break;

        case 'tool_use': {
          const toolName = block.name;
          const toolUseId = block.id;
          const input = (block.input || {}) as Record<string, unknown>;

          this.emit(convId, {
            type: 'tool_use',
            sessionId: state.sessionId || '',
            timestamp: Date.now(),
            toolName,
            toolUseId,
            input,
            messageId,
          });

          // Track metadata for correlating the eventual tool_result event.
          const toolFilePath = (input.file_path || input.filePath || '') as string;
          state.toolUseMeta.set(toolUseId, {
            toolName,
            ...(toolFilePath ? { filePath: toolFilePath } : {}),
          });
          break;
        }
     }
   }
 }

  /**
   * Handle SDK 'user' messages. These carry tool_result content blocks that
   * report the outcome of a tool execution. The bridge must emit a
   * 'tool_result' event so the renderer can mark the matching tool_use block
   * as completed (instead of leaving it stuck in 'running') and display the
   * result/error.
   */
  private handleUserMessage(convId: string, msg: SDKMessage & { type: 'user' }): void {
    const state = this.sessions.get(convId);
    if (!state) return;

    const content = (msg as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;

      const meta = state.toolUseMeta.get(b.tool_use_id);
      // Normalize content to a string for the renderer.
      let resultContent: string;
      if (typeof b.content === 'string') {
        resultContent = b.content;
      } else if (Array.isArray(b.content)) {
        resultContent = b.content
          .map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text || ''))
          .join('\n');
      } else {
        resultContent = JSON.stringify(b.content ?? '');
      }

      this.emit(convId, {
        type: 'tool_result',
        sessionId: state.sessionId || '',
        timestamp: Date.now(),
        toolUseId: b.tool_use_id,
        toolName: meta?.toolName || 'tool',
        content: resultContent,
        isError: !!b.is_error,
        ...(meta?.filePath ? { filePath: meta.filePath } : {}),
      });

      // Record an actual file change only on a successful Edit/Write/MultiEdit
      // result (not when requested, so denied/failed edits are excluded).
      if (!b.is_error && meta?.filePath && meta.toolName && ['Edit', 'Write', 'MultiEdit'].includes(meta.toolName)) {
        state.changedFiles.push({
          tool: meta.toolName as 'Edit' | 'Write' | 'MultiEdit',
          timestamp: Date.now(),
          filePath: meta.filePath,
        });
        this.emit(convId, {
          type: 'file_changed',
          sessionId: state.sessionId || '',
          timestamp: Date.now(),
          filePath: meta.filePath,
          tool: meta.toolName as 'Edit' | 'Write' | 'MultiEdit',
        });
      }
    }
  }

  private handleStreamEvent(convId: string, msg: SDKMessage & { type: 'stream_event' }): void {
    const state = this.sessions.get(convId);
    if (!state) return;
    const messageId = msg.uuid;
    const event = msg.event;

    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'text') {
          this.setStatus(convId, 'streaming_text');
        } else if (block.type === 'thinking') {
          this.setStatus(convId, 'thinking');
        } else if (block.type === 'tool_use') {
          // tool_use start
          this.setStatus(convId, 'tool_executing', {
            toolName: block.name,
            label: `Running ${block.name}...`,
          });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          this.setStatus(convId, 'streaming_text');
          this.emit(convId, {
            type: 'text_delta',
            sessionId: state.sessionId || '',
            timestamp: Date.now(),
            delta: delta.text,
            messageId,
          });
        } else if (delta.type === 'thinking_delta') {
          this.setStatus(convId, 'thinking');
          this.emit(convId, {
            type: 'thinking_delta',
            sessionId: state.sessionId || '',
            timestamp: Date.now(),
            delta: delta.thinking,
            messageId,
          });
        } else if (delta.type === 'input_json_delta') {
          // Tool input streaming — we'll get the full input in the assistant message
        }
        break;
      }

      case 'content_block_stop':
        // The complete block will come in the assistant message
        break;

      case 'message_start':
        this.setStatus(convId, 'requesting');
        break;

      case 'message_delta':
        // Contains stop_reason, usage — handled in result
        break;

      case 'message_stop':
        break;
    }
  }

  private handleSystemMessage(convId: string, msg: SDKMessage & { type: 'system' }): void {
    const state = this.sessions.get(convId);
    if (!state) return;

    if (msg.subtype === 'init') {
      // Session initialized
      state.sessionId = msg.session_id;
      this.emit(convId, {
        type: 'init',
        sessionId: msg.session_id,
        timestamp: Date.now(),
        model: msg.model,
        tools: msg.tools,
        mcpServers: msg.mcp_servers,
        permissionMode: msg.permissionMode,
      });
    } else if (msg.subtype === 'status') {
      // Status update from SDK
      // Map SDK status to our status
      // The SDK's status field doesn't map 1:1 to ours, so we use it as supplementary info
    } else if (msg.subtype === 'permission_denied') {
      this.emit(convId, {
        type: 'error',
        sessionId: state.sessionId || '',
        timestamp: Date.now(),
        message: `Permission denied: ${msg.tool_name} — ${msg.message}`,
        recoverable: false,
      });
    }
  }

  private handleResultMessage(convId: string, msg: SDKMessage & { type: 'result' }): void {
    const state = this.sessions.get(convId);
    if (!state) return;

    if (msg.subtype === 'success') {
      this.emit(convId, {
        type: 'result',
        sessionId: state.sessionId || '',
        timestamp: Date.now(),
        success: !msg.is_error,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        numTurns: msg.num_turns,
        result: msg.result,
      });
      this.setStatus(convId, 'idle');
    } else {
      // Error result
      const errorMsg = 'error' in msg ? String((msg as { error?: unknown }).error) : 'Unknown error';
      this.emit(convId, {
        type: 'result',
        sessionId: state.sessionId || '',
        timestamp: Date.now(),
        success: false,
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        result: '',
        errorMessage: errorMsg,
      });
      this.setStatus(convId, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Permission handling (canUseTool callback)
  // -------------------------------------------------------------------------

  private async handleCanUseTool(
    convId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: unknown[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      requestId: string;
    },
  ): Promise<PermissionResult | null> {
    const state = this.sessions.get(convId);
    if (!state) return { behavior: 'deny', message: 'Session destroyed' };

    this.setStatus(convId, 'waiting_permission');

    // Emit permission request to renderer
    this.emit(convId, {
      type: 'permission_request',
      sessionId: state.sessionId || '',
      timestamp: Date.now(),
      requestId: options.requestId,
      toolName,
      toolInput: input,
      reason: options.decisionReason,
      title: options.title,
      displayName: options.displayName,
      suggestions: options.suggestions as unknown[],
    });

    // Wait for the renderer's decision
    return new Promise<PermissionResult>((resolve, reject) => {
      const request = {
        requestId: options.requestId,
        toolName,
        toolInput: input,
        reason: options.decisionReason,
        title: options.title,
        displayName: options.displayName,
        suggestions: options.suggestions as unknown[],
      };
      // A7 修复：保存 abort 监听器引用，respondPermission 时移除
      const abortListener = () => {
        state.pendingPermissions.delete(options.requestId);
        reject(new Error('Aborted'));
      };
      options.signal.addEventListener('abort', abortListener);
      state.pendingPermissions.set(options.requestId, { resolve, reject, request, signal: options.signal, abortListener });
    });
  }

  /** Called by the renderer when the user makes a permission decision. */
  respondPermission(convId: string, decision: PermissionDecision): void {
    const state = this.sessions.get(convId);
    if (!state) return;

    const pending = state.pendingPermissions.get(decision.requestId);
    if (!pending) return;

    // A7 修复：从 AbortSignal 上移除 abort 监听器，避免长会话累积泄漏
    if (pending.abortListener) {
      try { pending.signal?.removeEventListener('abort', pending.abortListener); } catch { /* ignore */ }
    }
    state.pendingPermissions.delete(decision.requestId);

    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedPermissions: decision.updatedPermissions as any,
      });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: decision.message,
      });
    }

    // Restore status to requesting (the SDK will continue processing)
    this.setStatus(convId, 'requesting');
  }

  // -------------------------------------------------------------------------
  // Skills discovery (SDK supportedCommands)
  // -------------------------------------------------------------------------

  /**
   * 通过当前 query 拉取会话真实可用的 skills / slash 命令并 emit。
   * 用 query 引用来防止旧 query 的结果覆盖新会话的状态。
   */
  private async refreshSkills(convId: string, query: SDKQuery): Promise<void> {
    const state = this.sessions.get(convId);
    if (!state) return;
    try {
      const cmds = await query.supportedCommands();
      // 确保这个 query 仍然是当前 query（防止竞态：旧 query 的响应覆盖新会话）
      if (this.sessions.get(convId)?.query !== query) return;
      this.emit(convId, {
        type: 'skills',
        sessionId: state.sessionId || '',
        timestamp: Date.now(),
        skills: cmds.map((c) => ({ name: c.name, description: c.description })),
      });
    } catch {
      // supportedCommands 可能失败（会话已结束等）— 静默忽略
    }
  }

  // -------------------------------------------------------------------------
  // Abort
  // -------------------------------------------------------------------------

  async abort(convId: string): Promise<void> {
    const state = this.sessions.get(convId);
    if (!state) return;

    if (state.query) {
      try {
        await state.query.interrupt();
      } catch {
        // fallback: abort controller
        state.abortController?.abort();
      }
    } else {
      state.abortController?.abort();
    }

    // Reject all pending permissions
    for (const [, pending] of state.pendingPermissions) {
      if (pending.abortListener) {
        try { pending.signal?.removeEventListener('abort', pending.abortListener); } catch { /* ignore */ }
      }
      pending.reject(new Error('Aborted by user'));
    }
    state.pendingPermissions.clear();

    // A14 修复：abort 后设为 'aborted' 而非 'idle'，UI 能区分自然完成与用户中止
    this.setStatus(convId, 'aborted');
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  getStatus(convId: string): AgentStatus {
    return this.sessions.get(convId)?.status || 'idle';
  }

  getSessionId(convId: string): string | null {
    return this.sessions.get(convId)?.sessionId || null;
  }

  getChangedFiles(convId: string): FileChangeRecord[] {
    return this.sessions.get(convId)?.changedFiles || [];
  }

  /**
   * A4 修复：返回该会话所有 pending 的权限请求（数组），
   * 而不是只返回第一个。渲染端用队列逐个展示，避免多权限并发时
   * 后续请求无 UI 处理导致 agent 永久挂起。
   */
  getPendingPermissions(convId: string): PendingPermission['request'][] {
    const state = this.sessions.get(convId);
    if (!state || state.pendingPermissions.size === 0) return [];
    return Array.from(state.pendingPermissions.values()).map((p) => p.request);
  }

  /** Backward-compatible single lookup (returns first pending or null). */
  getPendingPermission(convId: string): PendingPermission['request'] | null {
    const all = this.getPendingPermissions(convId);
    return all.length > 0 ? all[0] : null;
  }

  /** Update session options mid-conversation (e.g. model/permission/thinking changes). */
  updateOptions(convId: string, opts: Partial<BridgeSessionOptions>): void {
    const state = this.sessions.get(convId);
    if (!state) return;
    Object.assign(state.options, opts);
  }

  destroySession(convId: string): void {
    const state = this.sessions.get(convId);
    if (!state) return;

    // Abort any running query
    state.abortController?.abort();
    for (const [, pending] of state.pendingPermissions) {
      pending.reject(new Error('Session destroyed'));
    }
    state.pendingPermissions.clear();

    this.sessions.delete(convId);
  }

  destroyAll(): void {
    for (const convId of this.sessions.keys()) {
      this.destroySession(convId);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private mapPermissionMode(mode?: string): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' {
    switch (mode) {
      case 'auto-edit': return 'acceptEdits';
      case 'plan': return 'plan';
      case 'skip': return 'bypassPermissions';
      case 'auto': return 'auto';
      case 'default':
      case 'ask':
      default:
        return 'default';
    }
  }

  /** Map our ThinkingEffort to SDK EffortLevel. */
  private mapThinkingEffort(effort: string): 'low' | 'medium' | 'high' {
    switch (effort) {
      case 'low': return 'low';
      case 'high': return 'high';
      case 'medium':
      default:
        return 'medium';
    }
  }
}
