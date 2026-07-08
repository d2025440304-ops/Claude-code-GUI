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
  CONVERSATION_SET_MODEL: 'conversation:set-model',

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
]);
