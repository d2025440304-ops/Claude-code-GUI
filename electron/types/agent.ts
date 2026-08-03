/**
 * Type definitions for the Agent SDK bridge layer.
 *
 * These types form the IPC contract between the Electron main process
 * (agent-sdk-bridge.ts) and the renderer (AgentConversationView.tsx).
 */

// ---------------------------------------------------------------------------
// Agent status state machine
// ---------------------------------------------------------------------------

export type AgentStatus =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'streaming_text'
  | 'tool_executing'
  | 'waiting_permission'
  | 'error'
  | 'completed'
  | 'aborted';

// ---------------------------------------------------------------------------
// Agent events (main → renderer push)
// ---------------------------------------------------------------------------

export interface AgentEventBase {
  sessionId: string;
  timestamp: number;
}

export interface AgentTextEvent extends AgentEventBase {
  type: 'text';
  /** Complete text block (from full assistant message). */
  text: string;
  messageId: string;
}

export interface AgentTextDeltaEvent extends AgentEventBase {
  type: 'text_delta';
  /** Incremental text to append. */
  delta: string;
  messageId: string;
}

export interface AgentThinkingEvent extends AgentEventBase {
  type: 'thinking';
  /** Complete thinking block. */
  text: string;
  messageId: string;
}

export interface AgentThinkingDeltaEvent extends AgentEventBase {
  type: 'thinking_delta';
  delta: string;
  messageId: string;
}

export interface AgentToolUseEvent extends AgentEventBase {
  type: 'tool_use';
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  messageId: string;
}

export interface AgentToolResultEvent extends AgentEventBase {
  type: 'tool_result';
  toolUseId: string;
  toolName: string;
  content: string;
  isError: boolean;
  /** For Edit tool: the file path that was modified. */
  filePath?: string;
  /** For Edit tool: inline diff lines. */
  diff?: string[];
}

export interface AgentStatusEvent extends AgentEventBase {
  type: 'status';
  status: AgentStatus;
  /** When status = tool_executing, the tool name. */
  toolName?: string;
  /** Human-readable status text. */
  label?: string;
}

export interface AgentPermissionRequestEvent extends AgentEventBase {
  type: 'permission_request';
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason?: string;
  title?: string;
  displayName?: string;
  suggestions?: unknown[];
}

export interface AgentResultEvent extends AgentEventBase {
  type: 'result';
  success: boolean;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  result: string;
  errorMessage?: string;
}

export interface AgentErrorEvent extends AgentEventBase {
  type: 'error';
  message: string;
  recoverable: boolean;
}

export interface AgentFileChangedEvent extends AgentEventBase {
  type: 'file_changed';
  filePath: string;
  tool: 'Edit' | 'Write' | 'MultiEdit';
}

export interface AgentInitEvent extends AgentEventBase {
  type: 'init';
  model: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode: string;
  sessionId: string;
}

/** 会话可用的真实 skills / slash 命令（来自 SDK supportedCommands()）。 */
export interface AgentSkillsEvent extends AgentEventBase {
  type: 'skills';
  skills: { name: string; description: string }[];
}

export type AgentEvent =
  | AgentTextEvent
  | AgentTextDeltaEvent
  | AgentThinkingEvent
  | AgentThinkingDeltaEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentStatusEvent
  | AgentPermissionRequestEvent
  | AgentResultEvent
  | AgentErrorEvent
  | AgentFileChangedEvent
  | AgentInitEvent
  | AgentSkillsEvent;

// ---------------------------------------------------------------------------
// Permission decision (renderer → main invoke)
// ---------------------------------------------------------------------------

export type PermissionDecision =
  | { behavior: 'allow'; requestId: string; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; requestId: string; message: string };

// ---------------------------------------------------------------------------
// File change tracker (internal to bridge)
// ---------------------------------------------------------------------------

export interface FileChangeRecord {
  tool: 'Edit' | 'Write' | 'MultiEdit';
  timestamp: number;
  filePath: string;
}

// ---------------------------------------------------------------------------
// Bridge API surface (used by main.ts IPC handlers)
// ---------------------------------------------------------------------------

export interface AgentBridgeSession {
  sessionId: string;
  status: AgentStatus;
  abort(): Promise<void>;
  sendMessage(text: string): Promise<void>;
  respondPermission(decision: PermissionDecision): void;
  getStatus(): AgentStatus;
  getChangedFiles(): FileChangeRecord[];
}
