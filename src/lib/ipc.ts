import type {
  InvokeMap,
  PushChannelMap,
  StreamChunk,
  StreamChunkPayload,
  StreamEndPayload,
  StreamErrorPayload,
  StreamErrorKind,
  TypingPayload,
} from '../../electron/ipc/contracts';

// Re-export shared wire types so the renderer imports them from a single module.
export type {
  StreamChunk,
  StreamChunkPayload,
  StreamEndPayload,
  StreamErrorPayload,
  StreamErrorKind,
  TypingPayload,
};

/** IPC channel constants - mirror electron/ipc/channels.ts at runtime via preload. */
export const Channels = {
  // Conversation CRUD
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_PIN: 'conversation:pin',
  CONVERSATION_RENAME: 'conversation:rename',
  CONVERSATION_CLEAR: 'conversation:clear',
  CONVERSATION_BRANCH: 'conversation:branch',
  CONVERSATION_SET_MODEL: 'conversation:set-model',
  CONVERSATION_SET_SESSION_ID: 'conversation:set-session-id',

  // Messages
  MESSAGE_LIST: 'message:list',
  MESSAGE_SEND: 'message:send',

  // Streaming push channels (main -> renderer)
  STREAM_CHUNK: 'stream:chunk',
  STREAM_END: 'stream:end',
  STREAM_ERROR: 'stream:error',
  TYPING: 'typing',

  // Stop generation
  STOP_GENERATION: 'stop:generation',

  // CLI check
  CLI_CHECK: 'cli:check',

  // Project folder selection
  PROJECT_SELECT: 'project:select',

  // Attachment helpers
  ATTACHMENT_OPEN_FILES: 'attachment:open-files',
  ATTACHMENT_READ_DATA_URL: 'attachment:read-data-url',
  ATTACHMENT_CLIPBOARD_FILES: 'attachment:clipboard-files',

  // Multi-window
  WINDOW_BIND: 'window:bind',
  WINDOW_OPEN_CONVERSATION: 'window:open-conversation',
  WINDOW_NEW_CHAT: 'window:new-chat',

  // Push: conversations changed
  CONVERSATIONS_CHANGED: 'conversations:changed',

  // History import
  HISTORY_SCAN: 'history:scan',
  HISTORY_MESSAGES: 'history:messages',

  // Terminal (PTY)
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',

  // Terminal output (push)
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',

  // Claude PTY
  CLAUDE_PTY_CREATE: 'claude-pty:create',
  CLAUDE_PTY_WRITE: 'claude-pty:write',
  CLAUDE_PTY_RESIZE: 'claude-pty:resize',
  CLAUDE_PTY_KILL: 'claude-pty:kill',
  CLAUDE_PTY_SEND_TEXT: 'claude-pty:send-text',
  CLAUDE_PTY_SEND_KEY: 'claude-pty:send-key',
  CLAUDE_PTY_GET_SESSION_ID: 'claude-pty:get-session-id',
  CLAUDE_PTY_IS_ACTIVE: 'claude-pty:is-active',

  // Claude PTY output (push)
  CLAUDE_PTY_DATA: 'claude-pty:data',
  CLAUDE_PTY_EXIT: 'claude-pty:exit',
  CLAUDE_PTY_PERMISSION: 'claude-pty:permission',

  // Agent SDK
  AGENT_CREATE: 'agent:create',
  AGENT_SEND: 'agent:send',
  AGENT_ABORT: 'agent:abort',
  AGENT_PERMISSION_RESPOND: 'agent:permission-respond',
  AGENT_GET_STATUS: 'agent:get-status',
  AGENT_GET_CHANGED_FILES: 'agent:get-changed-files',
  AGENT_GET_PENDING_PERMISSION: 'agent:get-pending-permission',
  AGENT_DESTROY: 'agent:destroy',

  // Agent SDK (push)
  AGENT_EVENT: 'agent:event',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // File explorer
  FILE_LIST: 'file:list',
  FILE_READ: 'file:read',

  // Skills
  SKILLS_LIST: 'skills:list',

  // Git diff
  GIT_DIFF: 'git:diff',

  // Config read
  CONFIG_READ: 'config:read',

  // Session Watcher
  SESSION_WATCHER_START: 'session-watcher:start',
  SESSION_WATCHER_STOP: 'session-watcher:stop',
  SESSION_WATCHER_GET_EVENTS: 'session-watcher:get-events',

  // Session Watcher (push)
  SESSION_EVENT: 'session-event',
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

declare global {
  interface Window {
    claudeAPI: {
      invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>
      on: (channel: string, cb: (data: any) => void) => () => void
      channels: typeof Channels
    }
  }
}

export const ipc = {
  /**
   * Invoke an IPC handler. For channels declared in `InvokeMap`, the request
   * payload is strictly type-checked against the shared contract; for all other
   * channels the payload is permissive. The response defaults to `unknown`
   * unless an explicit type argument is supplied (preserving existing call sites).
   */
  invoke: <T = unknown, C extends string = string>(
    channel: C,
    payload?: C extends keyof InvokeMap ? InvokeMap[C]['req'] : unknown,
  ): Promise<T> => window.claudeAPI.invoke<T>(channel, payload),

  /**
   * Subscribe to a push channel. For channels in `PushChannelMap`, type the
   * callback parameter with the shared payload type at the call site; other
   * channels remain permissive (the preload exposes `any`).
   */
  on: <C extends string = string>(
    channel: C,
    cb: (data: C extends keyof PushChannelMap ? PushChannelMap[C] : any) => void,
  ): (() => void) => window.claudeAPI.on(channel, cb as (data: any) => void),
}
