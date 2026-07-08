export interface Conversation {
  id: string; title: string; projectPath: string | null; model: string;
  pinned: boolean; claudeSessionId: string | null;
  createdAt: string; updatedAt: string; lastMessage: string | null;
}

export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  size: number;
  mimeType?: string;
  /** image: base64 data URL (data:image/png;base64,...) */
  dataUrl?: string;
  /** file: absolute path on disk, referenced via @path in the prompt */
  path?: string;
}

export interface Message {
  id: string; conversationId: string; role: 'user' | 'assistant';
  content: string; timestamp: string;
  attachments?: Attachment[];
}

export interface ModelOption { id: string; name: string; desc: string }

export const MODELS: ModelOption[] = [
  { id: 'default', name: 'Default', desc: 'Use cc-switch configured model' },
  { id: 'opus', name: 'Opus 4', desc: 'Most capable - complex reasoning' },
  { id: 'sonnet', name: 'Sonnet 4', desc: 'Balanced performance and speed' },
  { id: 'haiku', name: 'Haiku 3.5', desc: 'Fastest - quick edits' },
]
