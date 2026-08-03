/**
 * Shared IPC contracts - the single source of truth for wire types crossing the
 * Electron main <-> renderer boundary.
 *
 * This file is declaration-only (no runtime values, no Node/Electron imports),
 * so the main process imports it directly and the renderer imports it via
 * `import type` (erased at build time -> no Electron code leaks into the bundle).
 *
 * Discriminated unions: `StreamChunk` is discriminated by `type`, and the
 * streaming invoke/push channels are mapped through `InvokeMap` / `PushChannelMap`.
 */

// ---------------------------------------------------------------------------
// Streaming push events (main -> renderer), CliSpawner path
// ---------------------------------------------------------------------------

/** Discriminator for a streamed content chunk on the wire. */
export type StreamChunkType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'permission_denial'
  | 'error'
  | 'meta'
  | 'text-replace'; // synthetic replay chunk sent on window:bind

export interface StreamDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * A single parsed chunk pushed via the `stream:chunk` channel.
 * Structurally compatible with the backend's richer `ParsedChunk` (a superset):
 * main emits `ParsedChunk` values and the renderer reads them as `StreamChunk`.
 */
export interface StreamChunk {
  type: StreamChunkType;
  content?: string;
  tool?: string;
  input?: string;
  toolUseId?: string;
  stdout?: string;
  stderr?: string;
  isError?: boolean;
  diff?: StreamDiffHunk[];
  filePath?: string;
  error?: string;
  blockStart?: boolean;
  meta?: { sessionId?: string; model?: string; cost?: number; usage?: Record<string, number> };
}

export interface StreamChunkPayload {
  conversationId: string;
  chunk: StreamChunk;
}

export interface StreamEndPayload {
  conversationId: string;
  exitCode: number | null;
}

export type StreamErrorKind =
  | 'not_found'
  | 'spawn'
  | 'nonzero_exit'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export interface StreamErrorPayload {
  conversationId: string;
  /** Human-readable message (kept a string so existing renderer call sites work). */
  error: string;
  kind?: StreamErrorKind;
  exitCode?: number | null;
}

export interface TypingPayload {
  conversationId: string;
  isTyping: boolean;
}

// ---------------------------------------------------------------------------
// Streaming invoke contracts (renderer -> main)
// ---------------------------------------------------------------------------

export interface MessageSendRequest {
  conversationId: string;
  message: string;
  attachments?: unknown[];
  permissionMode?: string;
  thinkingEffort?: string;
}

export interface MessageSendResponse {
  ok: boolean;
  error?: string;
  userMessage?: unknown;
}

export interface StopGenerationRequest {
  conversationId: string;
}

export interface StopGenerationResponse {
  ok: boolean;
}

export interface WindowBindRequest {
  convId: string | null;
}

/**
 * Maps a strictly-typed invoke channel name to its request/response pair.
 * Channels not listed here fall back to permissive (`unknown`) typing in the
 * `ipc.invoke` wrapper, so existing call sites keep compiling unchanged.
 */
export interface InvokeMap {
  'message:send': { req: MessageSendRequest; res: MessageSendResponse };
  'stop:generation': { req: StopGenerationRequest; res: StopGenerationResponse };
  'window:bind': { req: WindowBindRequest; res: void };
}

/**
 * Maps a strictly-typed push channel name to its payload type.
 * Channels not listed here fall back to permissive typing in `ipc.on`.
 */
export interface PushChannelMap {
  'stream:chunk': StreamChunkPayload;
  'stream:end': StreamEndPayload;
  'stream:error': StreamErrorPayload;
  'typing': TypingPayload;
}
