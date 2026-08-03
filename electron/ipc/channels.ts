/**
 * IPC channel constants shared between main process and renderer.
 *
 * Naming convention: `<domain>:<action>` for invoke/handle channels,
 * `stream:<event>` / `typing` for push (main → renderer) channels.
 */
export const Channels = {
  // Conversation CRUD — invoke/handle
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_PIN: 'conversation:pin',
  CONVERSATION_RENAME: 'conversation:rename',
  CONVERSATION_CLEAR: 'conversation:clear',
  CONVERSATION_BRANCH: 'conversation:branch',
  CONVERSATION_SET_MODEL: 'conversation:set-model',
  CONVERSATION_SET_SESSION_ID: 'conversation:set-session-id',

  // Messages — invoke/handle
  MESSAGE_LIST: 'message:list',
  MESSAGE_SEND: 'message:send',

  // Streaming push channels (main → renderer)
  STREAM_CHUNK: 'stream:chunk',
  STREAM_END: 'stream:end',
  STREAM_ERROR: 'stream:error',
  TYPING: 'typing',

  // Stop generation — invoke/handle
  STOP_GENERATION: 'stop:generation',

  // CLI installation check — invoke/handle
  CLI_CHECK: 'cli:check',

  // Project folder selection (native dialog) — invoke/handle
  PROJECT_SELECT: 'project:select',

  // Attachment helpers - invoke/handle
  ATTACHMENT_OPEN_FILES: 'attachment:open-files',
  ATTACHMENT_READ_DATA_URL: 'attachment:read-data-url',
  ATTACHMENT_CLIPBOARD_FILES: 'attachment:clipboard-files',

  // Multi-window management - invoke/handle
  WINDOW_BIND: 'window:bind',
  WINDOW_OPEN_CONVERSATION: 'window:open-conversation',
  WINDOW_NEW_CHAT: 'window:new-chat',

  // Conversations changed notification (push, main -> renderer)
  CONVERSATIONS_CHANGED: 'conversations:changed',

  // History import (Claude Code 历史对话) — invoke/handle
  HISTORY_SCAN: 'history:scan',
  HISTORY_MESSAGES: 'history:messages',

  // Terminal (PTY) — invoke/handle
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',

  // Terminal output — push (main → renderer)
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',

  // Claude PTY (交互式 Claude Code 终端) — invoke/handle
  CLAUDE_PTY_CREATE: 'claude-pty:create',
  CLAUDE_PTY_WRITE: 'claude-pty:write',
  CLAUDE_PTY_RESIZE: 'claude-pty:resize',
  CLAUDE_PTY_KILL: 'claude-pty:kill',
  CLAUDE_PTY_SEND_TEXT: 'claude-pty:send-text',
  CLAUDE_PTY_SEND_KEY: 'claude-pty:send-key',
  CLAUDE_PTY_GET_SESSION_ID: 'claude-pty:get-session-id',
  CLAUDE_PTY_IS_ACTIVE: 'claude-pty:is-active',

  // Claude PTY output — push (main → renderer)
  CLAUDE_PTY_DATA: 'claude-pty:data',
  CLAUDE_PTY_EXIT: 'claude-pty:exit',
  CLAUDE_PTY_PERMISSION: 'claude-pty:permission',

  // Agent SDK (纯 GUI 模式) — invoke/handle
  AGENT_CREATE: 'agent:create',
  AGENT_SEND: 'agent:send',
  AGENT_ABORT: 'agent:abort',
  AGENT_PERMISSION_RESPOND: 'agent:permission-respond',
  AGENT_GET_STATUS: 'agent:get-status',
  AGENT_GET_CHANGED_FILES: 'agent:get-changed-files',
  AGENT_GET_PENDING_PERMISSION: 'agent:get-pending-permission',
  AGENT_DESTROY: 'agent:destroy',

  // Agent SDK — push (main → renderer)
  AGENT_EVENT: 'agent:event',

  // Settings — invoke/handle
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // File explorer — invoke/handle
  FILE_LIST: 'file:list',
  FILE_READ: 'file:read',
  FILE_SEARCH: 'file:search',

  // Skills 扫描（设置面板）— invoke/handle
  SKILLS_LIST: 'skills:list',

  // Git diff — invoke/handle
  GIT_DIFF: 'git:diff',

  // 配置读取（~/.claude/settings.json） - invoke/handle
  CONFIG_READ: 'config:read',

  // Session Watcher (结构化事件提取) — invoke/handle
  SESSION_WATCHER_START: 'session-watcher:start',
  SESSION_WATCHER_STOP: 'session-watcher:stop',
  SESSION_WATCHER_GET_EVENTS: 'session-watcher:get-events',

  // Session Watcher — push (main → renderer)
  SESSION_EVENT: 'session-event',
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

/**
 * Push channels are one-directional (main → renderer).
 * Used by the preload to validate `on()` registrations.
 */
export const PUSH_CHANNELS: ReadonlySet<string> = new Set([
  Channels.STREAM_CHUNK,
  Channels.STREAM_END,
  Channels.STREAM_ERROR,
  Channels.TYPING,
  Channels.CONVERSATIONS_CHANGED,
  Channels.TERMINAL_DATA,
  Channels.TERMINAL_EXIT,
  Channels.CLAUDE_PTY_DATA,
  Channels.CLAUDE_PTY_EXIT,
  Channels.CLAUDE_PTY_PERMISSION,
  Channels.SESSION_EVENT,
  Channels.AGENT_EVENT,
]);
