export interface Conversation {
  id: string; title: string; projectPath: string | null; model: string;
  pinned: boolean; kind: 'agent' | 'chat'; claudeSessionId: string | null;
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
  /** 结构化内容块：思考过程、工具调用、执行结果、权限拒绝等 */
  contentBlocks?: ContentBlock[];
}

/** 统一 diff 块，对应 CLI Edit 工具返回的 structuredPatch */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]  // " context" | "-removed" | "+added"
}

export type ContentBlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'permission_denial'

export interface ContentBlock {
  id: string
  type: ContentBlockType
  /** text / thinking / 拒绝原因 */
  content?: string
  /** tool_use / tool_result / permission_denial 的工具名 */
  toolName?: string
  /** tool_use 的完整输入（命令、文件路径等） */
  toolInput?: Record<string, unknown>
  /** tool_result 关联的 tool_use id */
  toolUseId?: string
  /** bash 输出 */
  stdout?: string
  stderr?: string
  isError?: boolean
  /** Edit 工具的 diff */
  diff?: DiffHunk[]
  filePath?: string
  /** 流式状态 */
  status?: 'streaming' | 'completed' | 'error'
}

export interface ModelOption { id: string; name: string; desc: string }

export const MODELS: ModelOption[] = [
  { id: 'default', name: 'Default', desc: 'Use cc-switch configured model' },
  { id: 'opus', name: 'Opus 4', desc: 'Most capable - complex reasoning' },
  { id: 'sonnet', name: 'Sonnet 4', desc: 'Balanced performance and speed' },
  { id: 'haiku', name: 'Haiku 3.5', desc: 'Fastest - quick edits' },
]

/** 权限模式 — 与 Claude Code CLI 的 auto mode 对齐 */
export type PermissionMode = 'ask' | 'auto-edit' | 'plan' | 'skip'

export interface PermissionModeOption {
  id: PermissionMode
  label: string
  shortLabel: string
  desc: string
  /** 图标类型，用于在 UI 中区分 */
  icon: 'ask' | 'edit' | 'plan' | 'skip'
  /** 颜色标记 */
  color: 'default' | 'accent' | 'warn' | 'danger'
}

export const PERMISSION_MODES: PermissionModeOption[] = [
  {
    id: 'ask',
    label: '询问权限',
    shortLabel: 'Ask',
    desc: '未授权操作将被拒绝（-p 模式不支持交互确认）',
    icon: 'ask',
    color: 'default',
  },
  {
    id: 'auto-edit',
    label: '自动接受编辑',
    shortLabel: 'Auto',
    desc: 'Claude 无需询问即可写入磁盘',
    icon: 'edit',
    color: 'accent',
  },
  {
    id: 'plan',
    label: '计划模式',
    shortLabel: 'Plan',
    desc: '仅架构和推理，不操作文件',
    icon: 'plan',
    color: 'warn',
  },
  {
    id: 'skip',
    label: '跳过权限',
    shortLabel: 'Skip',
    desc: '对 Shell 和文件系统的完整工具访问',
    icon: 'skip',
    color: 'danger',
  },
]

/** 思考等级 — 控制 Claude 的 thinking effort */
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high'

export interface ThinkingEffortOption {
  id: ThinkingEffort
  label: string
  desc: string
  /** 条形图的数量，用于视觉指示 */
  bars: number
}

export const THINKING_EFFORTS: ThinkingEffortOption[] = [
  { id: 'none', label: 'Off', desc: '不使用扩展思考', bars: 0 },
  { id: 'low', label: 'Low', desc: '轻量思考，快速响应', bars: 1 },
  { id: 'medium', label: 'Medium', desc: '适中思考，平衡质量与速度', bars: 2 },
  { id: 'high', label: 'High', desc: '深度思考，最佳推理质量', bars: 3 },
]

/** Claude Code 历史对话摘要（从 ~/.claude/projects/ 导入） */
export interface HistoryConversation {
  sessionId: string;
  title: string;
  projectPath: string;
  entrypoint: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: string;
  messageCount: number;
}

/** 历史消息 */
export interface HistoryMessage {
  uuid: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** 完整历史对话详情 */
export interface HistoryConversationDetail extends HistoryConversation {
  messages: HistoryMessage[];
}
