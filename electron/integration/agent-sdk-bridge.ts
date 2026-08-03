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
import type { SDKMessage, PermissionResult, Query as SDKQuery } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { resolveCwd } from './resolve-cwd';
import type {
  AgentStatus,
  AgentEvent,
  PermissionDecision,
  FileChangeRecord,
  AgentBridgeSession,
} from '../types/agent';

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
  if (sdkLoadError) throw sdkLoadError;
  try {
    const mod = await dynamicImport('@anthropic-ai/claude-agent-sdk');
    sdkQuery = (mod as any).query;
    return sdkQuery!;
  } catch (err) {
    sdkLoadError = err instanceof Error ? err : new Error(String(err));
    throw sdkLoadError;
  }
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

  async sendMessage(convId: string, text: string): Promise<void> {
    const state = this.getSession(convId);
    if (state.status !== 'idle' && state.status !== 'completed') {
      throw new Error(`Cannot send message: agent is ${state.status}`);
    }

    const abortController = new AbortController();
    state.abortController = abortController;

    // Build query options
    const isFirstMessage = !state.sessionId;
    const sessionId = state.sessionId || randomUUID();
    state.sessionId = sessionId;

    this.setStatus(convId, 'requesting');

    try {
      // Lazy-load the ESM SDK on first use
      const query = await ensureSdk();

      const queryResult = query({
        prompt: text,
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
          ...(state.options.additionalDirectories ? { additionalDirectories: state.options.additionalDirectories } : {}),
          canUseTool: (toolName, input, options) => this.handleCanUseTool(convId, toolName, input, options),
          ...(state.options.apiKey ? {
            env: { ...process.env, ANTHROPIC_API_KEY: state.options.apiKey },
          } : {}),
        },
      });

      state.query = queryResult;

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
      state.pendingPermissions.set(options.requestId, { resolve, reject, request });

      // Listen for abort
      options.signal.addEventListener('abort', () => {
        state.pendingPermissions.delete(options.requestId);
        reject(new Error('Aborted'));
      });
    });
  }

  /** Called by the renderer when the user makes a permission decision. */
  respondPermission(convId: string, decision: PermissionDecision): void {
    const state = this.sessions.get(convId);
    if (!state) return;

    const pending = state.pendingPermissions.get(decision.requestId);
    if (!pending) return;

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
      pending.reject(new Error('Aborted by user'));
    }
    state.pendingPermissions.clear();

    this.setStatus(convId, 'idle');
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
   * Return the pending permission request for a session (if any), so the
   * renderer can restore the permission UI after a remount / tab switch.
   */
  getPendingPermission(convId: string): PendingPermission['request'] | null {
    const state = this.sessions.get(convId);
    if (!state || state.pendingPermissions.size === 0) return null;
    const first = state.pendingPermissions.values().next();
    return first.done ? null : first.value.request;
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
