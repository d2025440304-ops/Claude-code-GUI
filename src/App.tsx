import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Plus, Search, Pin, FolderOpen, Settings, ChevronDown, Sparkles, Edit3, Loader2, Trash2, X, MessageSquare, Hash, Sun, Moon, PanelLeft, ExternalLink, History, Terminal, Globe, PanelRight, MessageCircle, Key, Eye, EyeOff, Check, Shield, FileCode } from 'lucide-react'
import ChatView from './components/ChatView'
import AgentConversationView from './components/AgentConversationView'
import ImportedChatView from './components/ImportedChatView'
import RightPanel from './components/RightPanel'
import ConversationItem from './components/ConversationItem'
import ModelSelector from './components/ModelSelector'
import ProjectSelector from './components/ProjectSelector'
import ConfirmDialog from './components/ConfirmDialog'
import ErrorBoundary from './components/ErrorBoundary'
import ToastContainer from './components/ToastContainer'
import { useToastStore } from './stores/toastStore'
import { ipc, Channels } from './lib/ipc'
import type { StreamChunk, StreamChunkPayload, StreamEndPayload, StreamErrorPayload } from './lib/ipc'
import type { StreamState, StreamMachineEvent } from './lib/streamMachine'
import { reduce as reduceStreamState, isStreamActive } from './lib/streamMachine'
import { finalizeStreamingBlocks } from './lib/streamBlocks'
import type { Conversation, Message, Attachment, HistoryConversation, HistoryConversationDetail, PermissionMode, ThinkingEffort, ModelOption, ContentBlock, DiffHunk } from './types'
import { MODELS, PERMISSION_MODES, THINKING_EFFORTS } from './types'
import { SkeletonConversationList } from './components/Skeleton'

/* ---------- helpers ---------- */

function getProjectName(path: string | null): string | null {
  if (!path) return null
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/** 安全解析 JSON，失败返回 undefined */
function safeParseJSON(s?: string): Record<string, unknown> | undefined {
  if (!s) return undefined
  try { return JSON.parse(s) as Record<string, unknown> } catch { return undefined }
}

/**
 * 将流式 chunk 应用到 assistant message 的 contentBlocks 数组。
 *
 * 规则：
 * - text/thinking：blockStart=true 时新建 block；否则追加到最后一个同类型 streaming block
 * - tool_use：blockStart=true 新建（只有 toolName+toolUseId）；后续带 input 的更新同 toolUseId 的 block
 * - tool_result：按 toolUseId 关联到对应 tool_use block，填入 stdout/diff/isError
 * - permission_denial：直接新建
 */
function applyChunkToBlocks(blocks: ContentBlock[], chunk: StreamChunk): ContentBlock[] {
  const next = [...blocks]

  switch (chunk.type) {
    case 'text': {
      if (chunk.blockStart || next.length === 0 || next[next.length - 1].type !== 'text' || next[next.length - 1].status !== 'streaming') {
        next.push({ id: crypto.randomUUID(), type: 'text', content: chunk.content || '', status: 'streaming' })
      } else {
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, content: (last.content || '') + (chunk.content || '') }
      }
      break
    }
    case 'thinking': {
      if (chunk.blockStart || next.length === 0 || next[next.length - 1].type !== 'thinking' || next[next.length - 1].status !== 'streaming') {
        next.push({ id: crypto.randomUUID(), type: 'thinking', content: chunk.content || '', status: 'streaming' })
      } else {
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, content: (last.content || '') + (chunk.content || '') }
      }
      break
    }
    case 'tool_use': {
      // 带 input：更新已存在的 block（content_block_stop 触发）
      if (chunk.input && chunk.toolUseId) {
        const idx = next.findIndex(b => b.toolUseId === chunk.toolUseId)
        if (idx >= 0) {
          next[idx] = { ...next[idx], toolName: chunk.tool || next[idx].toolName, toolInput: safeParseJSON(chunk.input), status: 'completed' }
        } else {
          next.push({ id: crypto.randomUUID(), type: 'tool_use', toolName: chunk.tool, toolUseId: chunk.toolUseId, toolInput: safeParseJSON(chunk.input), status: 'completed' })
        }
      } else if (chunk.toolUseId) {
        // content_block_start：新建 streaming tool_use block
        next.push({ id: crypto.randomUUID(), type: 'tool_use', toolName: chunk.tool, toolUseId: chunk.toolUseId, status: 'streaming' })
      }
      break
    }
    case 'tool_result': {
      if (chunk.toolUseId) {
        const idx = next.findIndex(b => b.toolUseId === chunk.toolUseId)
        const resultPatch: Partial<ContentBlock> = {
          stdout: chunk.stdout,
          stderr: chunk.stderr,
          diff: chunk.diff,
          filePath: chunk.filePath,
          isError: chunk.isError,
          content: chunk.content,
          status: chunk.isError ? 'error' : 'completed',
        }
        if (idx >= 0) {
          next[idx] = { ...next[idx], ...resultPatch }
        } else {
          next.push({ id: crypto.randomUUID(), type: 'tool_result', toolUseId: chunk.toolUseId, ...resultPatch } as ContentBlock)
        }
      }
      break
    }
    case 'permission_denial': {
      next.push({
        id: crypto.randomUUID(),
        type: 'permission_denial',
        toolName: chunk.tool,
        toolInput: safeParseJSON(chunk.input),
        content: chunk.content,
        status: 'error',
      })
      break
    }
  }

  return next
}

/**
 * 如果 content 是 JSON 数组（结构化 parts），提取其中 text 部分拼接为纯文本。
 * 用于 HistoryMessage 等不需要 contentBlocks 的场景。
 */
function plainifyJSONContent<T extends { role: string; content: string }>(msg: T): T {
  if (msg.role !== 'assistant' || !msg.content) return msg
  try {
    const v = JSON.parse(msg.content)
    if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && 'type' in v[0]) {
      const text = v.filter((p: Record<string, unknown>) => p.type === 'text' && p.text).map((p: Record<string, unknown>) => p.text as string).join('')
      if (text) return { ...msg, content: text }
    }
  } catch {}
  return msg
}

/**
 * Parse assistant messages whose `content` field contains a JSON-serialized
 * array of structured parts (text / thinking / tool_use / tool_result) back
 * into `contentBlocks` so that ChatView can render them with proper formatting
 * (markdown, code highlighting, tool cards) instead of raw JSON.
 */
function deserializeMessageBlocks(msg: Message): Message {
  if (msg.role !== 'assistant' || !msg.content || msg.contentBlocks?.length) return msg
  let parsed: Array<Record<string, unknown>> | null = null
  try {
    const v = JSON.parse(msg.content)
    if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && 'type' in v[0]) parsed = v
  } catch { return msg }
  if (!parsed) return msg
  const blocks: ContentBlock[] = []
  let i = 0
  for (const p of parsed) {
    const t = p.type as string
    if (t === 'text' && p.text) {
      blocks.push({ id: `db-${i}`, type: 'text', content: p.text as string, status: 'completed' })
    } else if (t === 'thinking' && p.text) {
      blocks.push({ id: `db-${i}`, type: 'thinking', content: p.text as string, status: 'completed' })
    } else if (t === 'tool_use') {
      blocks.push({
        id: `db-${i}`, type: 'tool_use', toolName: p.toolName as string,
        toolUseId: p.toolUseId as string, toolInput: p.input as Record<string, unknown> | undefined,
        status: 'completed',
      })
    } else if (t === 'tool_result') {
      const idx = blocks.findIndex(b => b.toolUseId === p.toolUseId && b.type === 'tool_use')
      const result = {
        content: p.content as string | undefined,
        stdout: p.stdout as string | undefined,
        stderr: p.stderr as string | undefined,
        isError: !!p.isError,
        diff: p.diff as DiffHunk[] | undefined,
        filePath: p.filePath as string | undefined,
      }
      if (idx >= 0) {
        blocks[idx] = { ...blocks[idx], ...result, status: (p.isError ? 'error' : 'completed') }
      } else {
        blocks.push({ id: `db-${i}`, type: 'tool_result', toolUseId: p.toolUseId as string, ...result, status: 'completed' })
      }
    }
    i++
  }
  // Derive a plain-text content from blocks for fallback / preview.
  const textContent = blocks.filter(b => b.type === 'text').map(b => b.content || '').join('')
  return { ...msg, contentBlocks: blocks, content: textContent || msg.content }
}

/* ---------- App ---------- */

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(() => {
    try {
      const urlConv = new URLSearchParams(window.location.search).get('conv')
      if (urlConv) return urlConv
      return localStorage.getItem('ccd:conv') || null
    } catch { return null }
  })
  const [selectedModel, setSelectedModel] = useState('default')
  // 模型列表：从 ~/.claude/settings.json (cc-switch) 动态加载，MODELS 仅作 fallback
  const [models, setModels] = useState<ModelOption[]>(MODELS)
  const [searchQuery, setSearchQuery] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [streamState, setStreamState] = useState<StreamState>('IDLE')
  const dispatchStream = useCallback((ev: StreamMachineEvent) => {
    setStreamState((s) => reduceStreamState(s, ev))
  }, [])
  const isStreaming = isStreamActive(streamState)
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ convId: string; x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const stored = localStorage.getItem('ccd:theme')
      if (stored === 'light' || stored === 'dark') return stored
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch { return 'dark' }
  })
  const [themeColor, setThemeColor] = useState<'purple' | 'blue' | 'yellow' | 'red'>(() => {
    try {
      const stored = localStorage.getItem('ccd:themeColor')
      if (stored === 'blue' || stored === 'yellow' || stored === 'red') return stored
      return 'purple'
    } catch { return 'purple' }
  })
  // Active project context for new chats; follows the selected conversation.
  const [newChatProjectPath, setNewChatProjectPath] = useState<string | null>(() => {
    try { return localStorage.getItem('ccd:project') || null } catch { return null }
  })
  // Which project groups are expanded in the sidebar tree.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    try { const v = localStorage.getItem('ccd:expanded'); return new Set<string>(v ? JSON.parse(v) : []) } catch { return new Set<string>() }
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('ccd:sidebar') === '1' } catch { return false }
  })
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try { return Number(localStorage.getItem('ccd:sidebarWidth')) || 288 } catch { return 288 }
  })
  const [rightPanelOpen, setRightPanelOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('ccd:rightPanel') === '1' } catch { return false }
  })
  // 视图模式：agent = SDK 纯 GUI；chat = 结构化 GUI 聊天
  const [viewMode, setViewMode] = useState<'agent' | 'chat'>(() => {
    try { return (localStorage.getItem('ccd:viewMode') as 'agent' | 'chat') || 'agent' } catch { return 'agent' }
  })
  // 拖拽状态
  const isDraggingSidebarRef = useRef(false)
  // CLI 安装状态：null = 还在检测，{installed, version} = 检测结果
  const [cliInfo, setCliInfo] = useState<{ installed: boolean; version: string | null; error?: string } | null>(null)
  // 设置面板开关
  const [showSettings, setShowSettings] = useState(false)
  // API Key 状态
  const [apiKey, setApiKey] = useState('')
  const [apiKeySaved, setApiKeySaved] = useState(false)
  const [apiKeyVisible, setApiKeyVisible] = useState(false)

  // Load API key on mount
  useEffect(() => {
    ipc.invoke<{ value: unknown }>('settings:get', { key: 'apiKey' })
      .then(res => {
        if (res?.value && typeof res.value === 'string') {
          setApiKey(res.value)
        }
      })
      .catch((err) => console.error('[App]', err))
  }, [])
  // 权限模式
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    try { return (localStorage.getItem('ccd:perm') as PermissionMode) || 'ask' } catch { return 'ask' }
  })
  // 思考等级
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>(() => {
    try { return (localStorage.getItem('ccd:effort') as ThinkingEffort) || 'medium' } catch { return 'medium' }
  })
  // 确认对话框状态
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; message: string; confirmLabel?: string; danger?: boolean;
    onConfirm: () => void
  } | null>(null)
  // 设置面板 Tab
  const [settingsTab, setSettingsTab] = useState<'General' | 'API' | 'Shortcuts' | 'About' | 'Skills'>('General')
  // Skills 设置：总开关 + 扫描到的 skills
  const [skillsEnabled, setSkillsEnabled] = useState(true)
  const [scannedSkills, setScannedSkills] = useState<{ name: string; description: string; source: 'user' | 'project'; path: string }[]>([])
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await ipc.invoke<{ value: unknown }>('settings:get', { key: 'skillsEnabled' })
        if (!cancelled && res?.value !== undefined) setSkillsEnabled(res.value === true)
      } catch { /* ignore */ }
      // 扫描 user + project 级 skills（project 路径取当前所有会话的项目目录）
      try {
        const paths = Array.from(new Set(conversations.map((c) => c.projectPath).filter(Boolean))) as string[]
        const res = await ipc.invoke<{ skills: { name: string; description: string; source: 'user' | 'project'; path: string }[] }>('skills:list', { projectPaths: paths })
        if (!cancelled && res?.skills) setScannedSkills(res.skills)
      } catch { /* ignore */ }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings])

  // Claude Code 历史对话
  const [historyConvs, setHistoryConvs] = useState<HistoryConversation[]>([])
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  const [historyDetail, setHistoryDetail] = useState<HistoryConversationDetail | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState<Set<string>>(() => {
    try { const v = localStorage.getItem('ccd:historyExpanded'); return new Set<string>(v ? JSON.parse(v) : []) } catch { return new Set<string>() }
  })

  const activeConvIdRef = useRef<string | null>(null)
  useEffect(() => { activeConvIdRef.current = activeConvId }, [activeConvId])

  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming
  const streamStateRef = useRef(streamState)
  streamStateRef.current = streamState
  const streamAbortRef = useRef<AbortController | null>(null)
  /** C4: STOP_REQUESTED 超时守卫 ref，防止 INTERRUPTING 永久锁死输入框 */
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * C7 修复：记录本轮 message:send 的 optimistic user message。
   * CLI 启动失败（stream:error，kind != aborted）时主进程已回滚 DB，
   * 这里同步移除对应 UI 消息，不留幽灵消息。
   */
  const pendingUserMsgRef = useRef<{ convId: string; msgId: string } | null>(null)
  // Gracefully halt the active stream (New Chat / Stop / context switch).
  const abortActiveStream = useCallback(() => {
    if (!isStreamActive(streamStateRef.current)) return
    const prevId = activeConvIdRef.current
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null }
    if (prevId) ipc.invoke('stop:generation', { conversationId: prevId }).catch((err) => console.error('[App]', err))
    dispatchStream({ type: 'STOPPED' })
  }, [dispatchStream])

 // Apply + persist theme on <html>.
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
    try { localStorage.setItem('ccd:theme', theme) } catch {}
  }, [theme])

  // Apply + persist theme color on <html>.
  useEffect(() => {
    const root = document.documentElement
    if (themeColor === 'purple') root.removeAttribute('data-theme-color')
    else root.setAttribute('data-theme-color', themeColor)
    try { localStorage.setItem('ccd:themeColor', themeColor) } catch {}
  }, [themeColor])

  // 监听系统主题变化：当用户没有手动设置过主题时，自动跟随系统主题
  useEffect(() => {
    const stored = localStorage.getItem('ccd:theme')
    if (stored === 'light' || stored === 'dark') return // 用户手动设置过，不跟随系统
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      setTheme(e.matches ? 'dark' : 'light')
    }
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  /* ---- load conversations on mount ---- */
  useEffect(() => {
    loadConversations()
  }, [])

  /* ---- 加载 Claude Code 历史对话 ---- */
  useEffect(() => {
    ipc.invoke<HistoryConversation[]>('history:scan').then(setHistoryConvs).catch((err) => console.error('[App]', err))
  }, [])

  useEffect(() => { try { localStorage.setItem('ccd:historyExpanded', JSON.stringify(Array.from(historyExpanded))) } catch {} }, [historyExpanded])

  /* ---- 检测 Claude CLI 安装状态 ---- */
  useEffect(() => {
    ipc.invoke<{ installed: boolean; version: string | null; error?: string }>('cli:check')
      .then(setCliInfo)
      .catch((e) => setCliInfo({ installed: false, version: null, error: String(e) }))
  }, [])

  /* ---- 加载 cc-switch 配置（模型列表 + 默认努力等级） ----
   * 从 ~/.claude/settings.json 读取别名 -> 真实模型的映射，
   * 动态生成模型列表，替换硬编码的 MODELS。
   * 首次加载（localStorage 无记录）时用 cc-switch 的 effortLevel 初始化。 */
  useEffect(() => {
    interface ConfigReadResult {
      models: ModelOption[]
      defaultModel: string
      effortLevel: string
      currentAlias: string
    }
    ipc.invoke<ConfigReadResult>('config:read')
      .then((cfg) => {
        if (cfg?.models?.length) setModels(cfg.models)
        // 首次运行（无 localStorage 记录）时同步 cc-switch 的 effortLevel
        try {
          const stored = localStorage.getItem('ccd:effort')
          if (!stored && cfg.effortLevel) {
            const valid = ['none', 'low', 'medium', 'high']
            if (valid.includes(cfg.effortLevel)) setThinkingEffort(cfg.effortLevel as ThinkingEffort)
          }
        } catch {}
      })
      .catch((e) => console.error('Failed to load cc-switch config:', e))
  }, [])

  // Persist session state across reloads.
  useEffect(() => { try { localStorage.setItem('ccd:conv', activeConvId || '') } catch {} }, [activeConvId])
  useEffect(() => { try { localStorage.setItem('ccd:project', newChatProjectPath || '') } catch {} }, [newChatProjectPath])
  useEffect(() => { try { localStorage.setItem('ccd:expanded', JSON.stringify(Array.from(expandedProjects))) } catch {} }, [expandedProjects])
  useEffect(() => { try { localStorage.setItem('ccd:sidebar', sidebarCollapsed ? '1' : '0') } catch {} }, [sidebarCollapsed])
  useEffect(() => { try { localStorage.setItem('ccd:sidebarWidth', String(sidebarWidth)) } catch {} }, [sidebarWidth])
  useEffect(() => { try { localStorage.setItem('ccd:rightPanel', rightPanelOpen ? '1' : '0') } catch {} }, [rightPanelOpen])
 useEffect(() => { try { localStorage.setItem('ccd:viewMode', viewMode) } catch {} }, [viewMode])
  // Note: viewMode is intentionally NOT auto-switched when selecting conversations.
  // The user freely toggles between Agent and Chat mode via the toolbar buttons.
  // Both modes read/write the same conversation's messages from SQLite, so history
  // is always shared regardless of which mode was used to send a message.
 useEffect(() => { try { localStorage.setItem('ccd:perm', permissionMode) } catch {} }, [permissionMode])
  useEffect(() => { try { localStorage.setItem('ccd:effort', thinkingEffort) } catch {} }, [thinkingEffort])

  // 侧边栏拖拽调整大小
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSidebarRef.current) return
      const newWidth = Math.min(480, Math.max(220, e.clientX))
      setSidebarWidth(newWidth)
    }
    const handleMouseUp = () => {
      isDraggingSidebarRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Bind this window's active conversation to the main process so stream
  // chunks are routed here. Re-binds whenever the active conversation changes.
  useEffect(() => {
    ipc.invoke('window:bind', { convId: activeConvId }).catch((err) => console.error('[App]', err))
  }, [activeConvId])

  // Stop session watcher when switching conversations (the new one will be started on sessionId capture)
  const prevConvIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevConvIdRef.current && prevConvIdRef.current !== activeConvId) {
      ipc.invoke('session-watcher:stop', { id: prevConvIdRef.current }).catch((err) => console.error('[App]', err))
    }
    prevConvIdRef.current = activeConvId
  }, [activeConvId])

  /* ---- select conversation and load messages ---- */
  const selectConversation = useCallback(async (id: string) => {
    abortActiveStream()
    setActiveConvId(id)
    setActiveHistoryId(null) // 清除历史对话选中状态
    setHistoryDetail(null)
    setLoadingMsgs(true)
    setError(null)
    // C7：切换会话时清理 pending 登记，避免串会话
    pendingUserMsgRef.current = null
    try {
      const res = await ipc.invoke<{ ok: boolean; messages?: Message[]; error?: string }>('message:list', { conversationId: id })
      if (res?.ok && res.messages) {
        setMessages(res.messages.map(deserializeMessageBlocks))
      } else {
        setMessages([])
        if (res?.error) setError(res.error)
      }
    } catch (e) {
      console.error('Failed to load messages:', e)
      setMessages([])
      setError('Failed to load messages')
    } finally {
      setLoadingMsgs(false)
    }
  }, [abortActiveStream])

  const loadConversations = useCallback(async () => {
    try {
      const convs = await ipc.invoke<Conversation[]>('conversation:list')
      setConversations(convs)
      const current = activeConvIdRef.current
      const target = current && convs.some((c) => c.id === current) ? current : convs[0]?.id ?? null
      if (target) {
        const tc = convs.find((c) => c.id === target) || null
        if (tc) setNewChatProjectPath(tc.projectPath)
        await selectConversation(target)
      } else {
        setActiveConvId(null)
        setMessages([])
      }
    } catch (e) {
      console.error('Failed to load conversations:', e)
      setError('Failed to load conversations')
    } finally {
      setLoadingConvs(false)
    }
  }, [selectConversation])

  // Keep a ref so the stream subscription effect can stay mount-once and
  // avoid tearing down/re-registering IPC listeners on every conversation switch.
  const loadConversationsRef = useRef(loadConversations)
  loadConversationsRef.current = loadConversations

  /* ---- switch into a branched conversation ---- */
  useEffect(() => {
    const handler = (e: Event) => {
      const convId = (e as CustomEvent<{ convId?: string }>).detail?.convId;
      if (convId) selectConversation(convId);
    };
    window.addEventListener('ccd:switch-conv', handler);
    return () => window.removeEventListener('ccd:switch-conv', handler);
  }, [selectConversation]);

  /* ---- slash command events (Agent 模式 /new /clear) ---- */
  useEffect(() => {
    const newHandler = () => { handleNewChat() };
    const clearHandler = () => { confirmClearChat() };
    window.addEventListener('ccd:new-chat', newHandler);
    window.addEventListener('ccd:clear-conv', clearHandler);
    return () => {
      window.removeEventListener('ccd:new-chat', newHandler);
      window.removeEventListener('ccd:clear-conv', clearHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- subscribe to stream events ---- */
  useEffect(() => {
    const unsubChunk = ipc.on('stream:chunk', (data: StreamChunkPayload) => {
      if (data.conversationId !== activeConvIdRef.current) return
      if (streamStateRef.current === 'THINKING') dispatchStream({ type: 'FIRST_CHUNK' })
      const chunk = data.chunk

      // text / thinking / tool_use / tool_result / permission_denial：累积到 contentBlocks
      if (['text', 'thinking', 'tool_use', 'tool_result', 'permission_denial'].includes(chunk.type)) {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            const blocks = applyChunkToBlocks(last.contentBlocks || [], chunk)
            // text 同时累积到 content 字段（向后兼容 + 持久化摘要）
            const newContent = chunk.type === 'text' && chunk.content
              ? last.content + chunk.content
              : last.content
            return [...prev.slice(0, -1), { ...last, content: newContent, contentBlocks: blocks }]
          }
          // 没有 assistant message 时创建一个
          const blocks = applyChunkToBlocks([], chunk)
          const initContent = chunk.type === 'text' && chunk.content ? chunk.content : ''
          return [...prev, { id: crypto.randomUUID(), conversationId: data.conversationId, role: 'assistant' as const, content: initContent, contentBlocks: blocks, timestamp: new Date().toISOString() }]
        })
        return
      }

      // text-replace：窗口绑定时重放累积文本
      if (chunk.type === 'text-replace' && chunk.content !== undefined) {
        dispatchStream({ type: 'RESUME' })
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: chunk.content! }]
          }
          return [...prev, { id: crypto.randomUUID(), conversationId: data.conversationId, role: 'assistant' as const, content: chunk.content!, timestamp: new Date().toISOString() }]
        })
        return
      }

      // error
      if (chunk.type === 'error' && chunk.error) {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          const errMsg = 'Error: ' + chunk.error
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: (last.content ? last.content + '\n\n' : '') + errMsg }]
          }
          return [...prev, { id: crypto.randomUUID(), conversationId: data.conversationId, role: 'assistant' as const, content: errMsg, timestamp: new Date().toISOString() }]
        })
      }
    })

    const unsubEnd = ipc.on('stream:end', (data: StreamEndPayload) => {
      if (data.conversationId !== activeConvIdRef.current) return
      // C4: 清除 STOP_REQUESTED 超时守卫
      if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null }
      dispatchStream({ type: 'STOPPED' })
      // C10 修复：正常结束 → 终结当前 assistant message 中所有 streaming block
      // 为 completed（含无 tool_result 的 tool_use），杜绝永久 spinner。
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && last.contentBlocks?.length) {
          return [...prev.slice(0, -1), { ...last, contentBlocks: finalizeStreamingBlocks(last.contentBlocks, 'completed') }]
        }
        return prev
      })
      // C7：本轮发送已正常结束，清理乐观消息登记
      if (pendingUserMsgRef.current?.convId === data.conversationId) pendingUserMsgRef.current = null
      loadConversationsRef.current()
    })

    const unsubError = ipc.on('stream:error', (data: StreamErrorPayload) => {
      if (data.conversationId !== activeConvIdRef.current) return
      // C4: 清除 STOP_REQUESTED 超时守卫
      if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null }
      dispatchStream({ type: 'ERROR' })

      const pending = pendingUserMsgRef.current
      // C7 修复：CLI 启动失败（kind != aborted，未产出任何回复）→ 主进程已回滚
      // DB，这里同步移除 optimistic user message + 空 assistant 占位并展示错误。
      // 'aborted'（用户主动停止）消息已真正发出，不移除。
      const isStartupFailure = data.kind !== 'aborted' && !!pending && pending.convId === data.conversationId
      if (isStartupFailure) {
        pendingUserMsgRef.current = null
        setError(data.error)
        setMessages((prev) => {
          const next = prev.filter((m) => m.id !== pending!.msgId)
          const last = next[next.length - 1]
          if (last && last.role === 'assistant' && !last.content && !last.contentBlocks?.length) return next.slice(0, -1)
          return next
        })
      } else {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            // C10 修复：报错/中断 → 未完成 blocks 终结为 error（已完成内容不覆盖）
            const blocks = last.contentBlocks?.length ? finalizeStreamingBlocks(last.contentBlocks, 'error') : undefined
            return [...prev.slice(0, -1), { ...last, content: last.content ? last.content : `Error: ${data.error}`, contentBlocks: blocks }]
          }
          return [...prev, { id: crypto.randomUUID(), conversationId: data.conversationId, role: 'assistant' as const, content: `Error: ${data.error}`, timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) }]
        })
      }
      // C3 修复：ERROR 状态 2 秒后自动恢复为 IDLE，用户可直接发送下一条消息
      // 无需手动切会话或重启。
      setTimeout(() => {
        if (streamStateRef.current === 'ERROR') {
          dispatchStream({ type: 'RESET' })
        }
      }, 2_000)
    })

    return () => { unsubChunk(); unsubEnd(); unsubError() }
  }, [])

  // Cross-window sync: refresh sidebar when conversations change in another
  // window (create/delete/rename/pin/stream-end). Only reloads the list, not
  // the active conversation's messages, to avoid disrupting the current view.
  useEffect(() => {
    const unsub = ipc.on('conversations:changed', () => {
      ipc.invoke<Conversation[]>('conversation:list').then((convs) => {
        setConversations(convs)
        if (activeConvIdRef.current && !convs.some((c) => c.id === activeConvIdRef.current)) {
          setActiveConvId(null)
          setMessages([])
        }
      }).catch((err) => console.error('[App]', err))
    })
    return unsub
  }, [])

  /* ---- new chat ---- */
  const handleNewChat = async () => {
    abortActiveStream()
    try {
      const conv = await ipc.invoke<Conversation>('conversation:create', {
        title: 'New Chat',
        projectPath: newChatProjectPath || null,
        model: selectedModel,
        kind: viewMode,
      })
      setConversations((prev) => [conv, ...prev])
      setActiveConvId(conv.id)
      setActiveHistoryId(null)
      setHistoryDetail(null)
      setMessages([])
      setError(null)
      if (conv.projectPath) setExpandedProjects((prev) => new Set(prev).add(conv.projectPath!))
    } catch (e) {
      console.error('Failed to create conversation:', e)
      setError('Failed to create conversation')
    }
  }

  /* ---- quick chat (no project folder) ---- */
  const handleQuickChat = async () => {
    abortActiveStream()
    try {
      const conv = await ipc.invoke<Conversation>('conversation:create', {
        title: 'New Chat',
        projectPath: null,
        model: selectedModel,
        kind: viewMode,
      })
      setConversations((prev) => [conv, ...prev])
      setActiveConvId(conv.id)
      setNewChatProjectPath(null)
      setMessages([])
      setError(null)
    } catch (e) {
      console.error('Failed to create quick chat:', e)
      setError('Failed to create conversation')
    }
  }

  /* ---- global keyboard shortcuts ---- */
  const newChatRef = useRef(() => {})
  newChatRef.current = handleNewChat
  const stopRef = useRef(() => {})
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const handleGlobalKey = (e: globalThis.KeyboardEvent) => {
      // ⌘N / Ctrl+N — new chat
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'n') { e.preventDefault(); newChatRef.current() }
      else if (mod && e.key === 'b') { e.preventDefault(); setSidebarCollapsed((v) => !v) }
      else if (mod && e.key === 'j') { e.preventDefault(); setRightPanelOpen((v) => !v) }
      else if (mod && e.key === 'k') { e.preventDefault(); searchInputRef.current?.focus() }
      else if (e.key === 'Escape' && isStreamingRef.current) { e.preventDefault(); stopRef.current() }
    }
    window.addEventListener('keydown', handleGlobalKey)
    return () => window.removeEventListener('keydown', handleGlobalKey)
  }, [])

  /* ---- pin toggle ---- */
  const handlePinToggle = async (conv: Conversation) => {
    try {
      await ipc.invoke('conversation:pin', { id: conv.id, pinned: !conv.pinned })
      setConversations((prev) => prev.map((c) => c.id === conv.id ? { ...c, pinned: !c.pinned } : c))
    } catch (e) {
      console.error('Failed to toggle pin:', e)
      setError('Failed to update pin status')
    }
  }

  /* ---- rename conversation ---- */
  const handleRename = async (id: string, title: string) => {
    setEditingId(null)
    try {
      await ipc.invoke('conversation:rename', { id, title })
      setConversations((prev) => prev.map((c) => c.id === id ? { ...c, title } : c))
    } catch (e) {
      console.error('Failed to rename conversation:', e)
      setError('Failed to rename conversation')
    }
  }

  /* ---- delete conversation ---- */
  const confirmDelete = (id: string) => {
    if (isStreaming && activeConvId === id) return
    setConfirmDialog({
      title: '删除会话',
      message: '确定要删除这个会话吗？所有聊天记录将被永久删除，此操作不可撤销。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => { setConfirmDialog(null); handleDelete(id) },
    })
  }

  const handleDelete = async (id: string) => {
    try {
      await ipc.invoke('conversation:delete', { id })
      const remaining = conversations.filter((c) => c.id !== id)
      setConversations(remaining)
      if (editingId === id) setEditingId(null)
      if (activeConvId === id) {
        if (remaining.length > 0) {
          selectConversation(remaining[0].id)
        } else {
          setActiveConvId(null)
          setMessages([])
        }
      }
    } catch (e) {
      console.error('Failed to delete conversation:', e)
    }
  }

  /* ---- project select (folder dialog) ---- */
  const handleProjectSelect = async () => {
    try {
      const result = await ipc.invoke<{ canceled: boolean; filePaths: string[] }>('project:select')
      if (!result.canceled && result.filePaths.length > 0) {
        const p = result.filePaths[0]
        setNewChatProjectPath(p)
        setExpandedProjects((prev) => new Set(prev).add(p))
      }
    } catch (e) {
      console.error('Failed to select project:', e)
    }
  }

  /* ---- clear chat history ---- */
  const confirmClearChat = () => {
    if (!activeConvId) return
    setConfirmDialog({
      title: '清空聊天记录',
      message: '确定要清空当前会话的所有聊天记录吗？此操作不可撤销。',
      confirmLabel: '清空',
      danger: true,
      onConfirm: () => { setConfirmDialog(null); handleClearChat() },
    })
  }

  const handleClearChat = async () => {
    if (!activeConvId) return
    try {
      await ipc.invoke('conversation:clear', { id: activeConvId })
      setMessages([])
    } catch (e) {
      console.error('Failed to clear chat:', e)
      setError('Failed to clear chat history')
    }
  }

  /* ---- stop generation ---- */
  const handleStop = () => {
    if (activeConvId) {
      dispatchStream({ type: 'STOP_REQUESTED' })
      ipc.invoke('stop:generation', { conversationId: activeConvId })
      // C4 修复：10 秒超时守卫。如果 stream:end/error 10 秒内未到达，
      // 强制 STOPPED 防止 INTERRUPTING 状态永久锁死输入框。
      if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current)
      stopTimeoutRef.current = setTimeout(() => {
        stopTimeoutRef.current = null
        if (streamStateRef.current === 'INTERRUPTING') {
          console.warn('[App] Stop timeout — forcing STOPPED')
          dispatchStream({ type: 'STOPPED' })
        }
      }, 10_000)
    }
  }
  stopRef.current = handleStop

  /* ---- 选择历史对话 ---- */
  const selectHistoryConversation = useCallback(async (conv: HistoryConversation) => {
    abortActiveStream()
    setActiveHistoryId(conv.sessionId)
    setActiveConvId(null) // 取消普通对话的选中状态
    setLoadingHistory(true)
    try {
      const detail = await ipc.invoke<HistoryConversationDetail | null>('history:messages', {
        projectPath: conv.projectPath,
        sessionId: conv.sessionId,
      })
      if (detail) {
        setHistoryDetail({ ...detail, messages: detail.messages.map(plainifyJSONContent) })
      } else {
        setHistoryDetail(null)
      }
    } catch {
      setHistoryDetail(null)
    } finally {
      setLoadingHistory(false)
    }
  }, [abortActiveStream])

  /* ---- 从历史会话续接（终端/其他客户端 → 本应用继续 build） ---- */
  const resumeHistoryConversation = useCallback(async () => {
    if (!historyDetail) return
    abortActiveStream()
    try {
      // 用历史会话的 sessionId + 项目路径创建 GUI 会话：
      // - Chat 模式：发送时 cli-spawner 会 --resume 该 session（复用完整上下文）
      // - Agent 模式：AGENT_CREATE 传 resumeSessionId，SDK 首次发送走 resume
      const conv = await ipc.invoke<Conversation>('conversation:create', {
        title: historyDetail.title || 'Resumed from terminal',
        projectPath: historyDetail.projectPath,
        model: selectedModel,
        kind: viewMode,
        claudeSessionId: historyDetail.sessionId,
      })
      setConversations((prev) => [conv, ...prev])
      // 把历史消息持久化到该会话，这样 UI 立即有完整上下文（重启后也保留）
      try {
        await ipc.invoke('conversation:import-messages', {
          conversationId: conv.id,
          messages: historyDetail.messages
            .filter((m) => m.content && m.content.trim())
            .map((m) => ({ role: m.role, content: m.content })),
        })
      } catch { /* 导入失败不阻塞续接 */ }
      // 切换到新会话
      setActiveConvId(conv.id)
      setActiveHistoryId(null)
      setHistoryDetail(null)
      setError(null)
      if (conv.projectPath) setExpandedProjects((prev) => new Set(prev).add(conv.projectPath!))
    } catch (e) {
      console.error('Failed to resume history conversation:', e)
      setError('Failed to resume conversation')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyDetail, selectedModel, viewMode, abortActiveStream])

  /* ---- send message ---- */
  const handleSend = async (text: string, attachments: Attachment[] = []) => {
    if (!activeConvId || isStreaming) return

    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })

    const userMsg: Message = {
      id: crypto.randomUUID(),
      conversationId: activeConvId,
      role: 'user',
      content: text,
      timestamp: now,
      attachments,
    }
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      conversationId: activeConvId,
      role: 'assistant',
      content: '',
      timestamp: now,
    }
    // C7 修复：登记本轮 optimistic user message，启动失败时（同步 ok:false 或
    // 异步 stream:error）据此精确移除，不留 UI 幽灵消息。
    pendingUserMsgRef.current = { convId: activeConvId, msgId: userMsg.id }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    streamAbortRef.current?.abort()
    const ac = new AbortController()
    streamAbortRef.current = ac
    dispatchStream({ type: 'SEND' })

    try {
      const res = await ipc.invoke<{ ok: boolean; error?: string }>('message:send', {
        conversationId: activeConvId,
        message: text,
        attachments,
        permissionMode,
        thinkingEffort,
      })
      if (ac.signal.aborted) return
      if (!res?.ok) {
        dispatchStream({ type: 'STOPPED' })
        setError(res?.error || 'Failed to send message')
        // C7 修复：同步失败 → 移除本轮 optimistic user message + 空 assistant 占位
        // （主进程已回滚 DB，UI 必须同步）
        removePendingSendMessages(userMsg.id)
      }
    } catch (e) {
      if (ac.signal.aborted) return
      console.error('Failed to send message:', e)
      dispatchStream({ type: 'STOPPED' })
      setError('Failed to send message. Please try again.')
      removePendingSendMessages(userMsg.id)
    }
  }

  /**
   * C7 修复：发送失败时移除本轮 optimistic user message（按真实 id 精确匹配）
   * 以及紧随其后的空 assistant 占位，与主进程的 DB 回滚保持一致。
   */
  const removePendingSendMessages = (userMsgId: string) => {
    pendingUserMsgRef.current = null
    setMessages((prev) => {
      const next = prev.filter((m) => m.id !== userMsgId)
      const last = next[next.length - 1]
      if (last && last.role === 'assistant' && !last.content && !last.contentBlocks?.length) return next.slice(0, -1)
      return next
    })
  }

  /* ---- 权限拒绝后一键批准重发 ---- */
  const handleResendWithPermission = useCallback(async () => {
    if (!activeConvId || isStreaming) return
    // 找到最后一条用户消息
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUser) return
    // 切换到 auto-edit 模式
    setPermissionMode('auto-edit')
    // 清除之前的权限拒绝 blocks，保留 text 部分
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant') {
        const cleanedBlocks = (last.contentBlocks || []).filter(b => b.type !== 'permission_denial')
        return [...prev.slice(0, -1), { ...last, contentBlocks: cleanedBlocks }]
      }
      return prev
    })
    // 用 auto-edit 模式重新发送
    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      conversationId: activeConvId,
      role: 'assistant',
      content: '',
      timestamp: now,
    }
    setMessages((prev) => [...prev, assistantMsg])
    streamAbortRef.current?.abort()
    const ac = new AbortController()
    streamAbortRef.current = ac
    dispatchStream({ type: 'SEND' })
    try {
      const res = await ipc.invoke<{ ok: boolean; error?: string }>('message:send', {
        conversationId: activeConvId,
        message: lastUser.content,
        attachments: lastUser.attachments || [],
        permissionMode: 'auto-edit',
        thinkingEffort,
      })
      if (ac.signal.aborted) return
      if (!res?.ok) {
        dispatchStream({ type: 'STOPPED' })
        setError(res?.error || 'Failed to resend')
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && !last.content && !last.contentBlocks?.length) return prev.slice(0, -1)
          return prev
        })
      }
    } catch (e) {
      if (ac.signal.aborted) return
      dispatchStream({ type: 'STOPPED' })
      setError('Failed to resend message')
    }
  }, [activeConvId, isStreaming, messages, thinkingEffort])

  /* ---- 切换模型：同步到当前 conversation ---- */
  const handleModelSelect = useCallback(async (modelId: string) => {
    setSelectedModel(modelId)
    if (activeConvId) {
      try {
        await ipc.invoke('conversation:set-model', { id: activeConvId, model: modelId })
        setConversations((prev) => prev.map((c) => c.id === activeConvId ? { ...c, model: modelId } : c))
      } catch (e) {
        console.error('Failed to set model:', e)
        setError('Failed to update model')
      }
    }
  }, [activeConvId])

  /* ---- 切换会话时同步模型选择器到当前会话的模型 ---- */
  useEffect(() => {
    if (!activeConvId) return
    const conv = conversations.find((c) => c.id === activeConvId)
    if (conv?.model) setSelectedModel(conv.model)
  }, [activeConvId, conversations])

  /* ---- derived state ---- */
  const activeConv = conversations.find((c) => c.id === activeConvId)
  const projectPath = activeConv?.projectPath ?? newChatProjectPath
  const project = projectPath ? { name: getProjectName(projectPath) || projectPath, path: projectPath } : null
  const activeProjectKey = activeConv?.projectPath ?? newChatProjectPath ?? ''

  // Keep the new-chat project context in sync with the active conversation.
  useEffect(() => {
    if (activeConv) setNewChatProjectPath(activeConv.projectPath)
  }, [activeConv])

  // Auto-expand the active project group.
  useEffect(() => {
    if (activeProjectKey) setExpandedProjects((prev) => prev.has(activeProjectKey) ? prev : new Set(prev).add(activeProjectKey))
  }, [activeProjectKey])

  // Conversations grouped by project for the sidebar tree.
  const projects = useMemo(() => {
    const map = new Map<string, Conversation[]>()
    for (const c of conversations) {
      const key = c.projectPath || ''
      const arr = map.get(key)
      if (arr) arr.push(c)
      else map.set(key, [c])
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt.localeCompare(a.updatedAt)))
    }
    return Array.from(map.keys())
      .sort((a, b) => (map.get(b)![0]?.updatedAt || '').localeCompare(map.get(a)![0]?.updatedAt || ''))
      .map((k) => ({ key: k, name: k ? getProjectName(k) : 'Quick Chats', convs: map.get(k)! }))
  }, [conversations])

  // Flat search results (only when searching).
  const q = searchQuery.trim().toLowerCase()
  const searchResults = q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : null
  const pinned = searchResults ? searchResults.filter((c) => c.pinned) : []
  const recent = searchResults ? searchResults.filter((c) => !c.pinned) : []
  const contextMenuConv = contextMenu ? conversations.find((c) => c.id === contextMenu.convId) : null

  const renderConv = (conv: Conversation) => (
    <ConversationItem
      key={conv.id}
      conv={conv}
      active={conv.id === activeConvId}
      editing={editingId === conv.id}
      onClick={() => selectConversation(conv.id)}
      onPinToggle={() => handlePinToggle(conv)}
      onContextMenu={(e) => { e.preventDefault(); setContextMenu({ convId: conv.id, x: Math.min(e.clientX, window.innerWidth - 185), y: Math.min(e.clientY, window.innerHeight - 230) }) }}
      onRenameCommit={(title) => handleRename(conv.id, title)}
      onRenameCancel={() => setEditingId(null)}
    />
  )

  /* ---- render ---- */
  return (
    <div className="flex h-screen bg-[var(--bg-base)] text-[var(--fg-primary)]">

      {/* Left sidebar */}
      <aside
        className="glass sidebar-accent flex flex-col flex-shrink-0 relative"
        style={{
          width: sidebarCollapsed ? 0 : `${sidebarWidth}px`,
          minWidth: sidebarCollapsed ? 0 : '220px',
          maxWidth: '480px',
          borderRight: sidebarCollapsed ? 'none' : '1px solid var(--border-default)',
          transition: isDraggingSidebarRef.current ? 'none' : 'width 200ms ease',
          overflow: 'hidden',
          isolation: 'isolate',
        }}
      >
        {/* 右边缘拖拽条 */}
        {!sidebarCollapsed && (
          <div
            className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent-primary)] transition-colors z-10"
            onMouseDown={(e) => {
              e.preventDefault()
              isDraggingSidebarRef.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
          />
        )}
        {/* macOS traffic light drag region */}
        <div className="drag-region flex-shrink-0" style={{ height: '36px' }} />
        {/* Logo / brand header */}
        <div className="px-4 pb-3">
          <div className="flex items-center gap-3 mb-5">
            <div
              style={{
                width: 32, height: 32, borderRadius: 10,
                background: 'linear-gradient(145deg, var(--accent-primary) 0%, var(--accent-bright) 40%, color-mix(in srgb, var(--accent-bright) 80%, white) 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 12px var(--accent-glow), 0 0 0 1px rgba(255,255,255,0.06)',
                position: 'relative',
              }}
            >
              {/* C + terminal mark */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" strokeWidth="1.5" />
                <path d="M8 9l3 3-3 3" />
                <path d="M14 15h3" />
              </svg>
            </div>
            <div className="flex flex-col">
              <span className="text-[15px] font-semibold" style={{ color: 'var(--fg-primary)', letterSpacing: '-0.025em', lineHeight: 1.2 }}>
                Claude Code
              </span>
              <span className="text-[10.5px] font-medium" style={{ color: 'var(--fg-tertiary)', letterSpacing: '0.02em' }}>
                Desktop
              </span>
            </div>
          </div>

          {/* New chat button */}
          <button
            className="btn btn-primary w-full justify-center"
            style={{
              padding: '11px 16px',
              borderRadius: 'var(--radius-md)',
              opacity: isStreaming ? 0.5 : 1,
              cursor: isStreaming ? 'not-allowed' : 'pointer',
            }}
            onClick={handleNewChat}
            disabled={isStreaming}
          >
            <Plus size={15} strokeWidth={2.5} />
            <span>New Chat</span>
          </button>
        </div>

        {/* Model selector */}
        <div className="px-4 pb-2.5">
          <ModelSelector selected={selectedModel} models={models} onSelect={handleModelSelect} collapsed={sidebarCollapsed} />
        </div>


        {/* Search */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-quaternary)]" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search conversations…"
              className="input pl-8"
              style={{ fontSize: '12px', borderRadius: 'var(--radius-sm)' }}
            />
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-2.5">
          {loadingConvs ? (
                      <SkeletonConversationList count={6} />
                    ) : searchResults ? (
            <>
              {pinned.length > 0 && (
                <div className="mb-2">
                  <div className="flex items-center gap-1.5 px-2.5 py-2">
                    <Pin size={9} className="text-[var(--fg-quaternary)]" />
                    <span className="text-[10px] font-semibold text-[var(--fg-quaternary)] uppercase" style={{ letterSpacing: '0.08em' }}>Pinned</span>
                  </div>
                  {pinned.map((conv) => renderConv(conv))}
                </div>
              )}
              {recent.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-2.5 py-2">
                    <Hash size={9} className="text-[var(--fg-quaternary)]" />
                    <span className="text-[10px] font-semibold text-[var(--fg-quaternary)] uppercase" style={{ letterSpacing: '0.08em' }}>Recent</span>
                  </div>
                  {recent.map((conv) => renderConv(conv))}
                </div>
              )}
              {searchResults.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--bg-surface-2)' }}>
                    <Search size={16} className="text-[var(--fg-quaternary)]" />
                  </div>
                  <span className="text-[12px] font-medium" style={{ color: 'var(--fg-tertiary)' }}>No matches</span>
                  <span className="text-[11px]" style={{ color: 'var(--fg-quaternary)' }}>Try a different search term</span>
                </div>
              )}
            </>
          ) : (
            <>
              {projects.map((proj) => {
                const expanded = expandedProjects.has(proj.key)
                return (
                  <div key={proj.key || '__unsorted'} className="mb-1">
                    <button
                      onClick={() => {
                        setNewChatProjectPath(proj.key || null)
                        setExpandedProjects((prev) => {
                          const next = new Set(prev)
                          if (next.has(proj.key)) next.delete(proj.key)
                          else next.add(proj.key)
                          return next
                        })
                      }}
                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg transition-colors text-left"
                      style={{ background: proj.key === activeProjectKey ? 'var(--accent-subtle)' : 'transparent' }}
                    >
                      <ChevronDown
                        size={12}
                        className="text-[var(--fg-quaternary)] transition-transform"
                        style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                      />
                      {proj.key
                        ? <FolderOpen size={13} className={proj.key === activeProjectKey ? 'text-[var(--accent-bright)]' : 'text-[var(--fg-tertiary)]'} />
                        : <MessageSquare size={13} className={proj.key === activeProjectKey ? 'text-[var(--accent-bright)]' : 'text-[var(--fg-tertiary)]'} />
                      }
                      <span className="text-[11.5px] font-semibold truncate flex-1" style={{ color: proj.key === activeProjectKey ? 'var(--fg-primary)' : 'var(--fg-secondary)' }}>
                        {proj.name}
                      </span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md" style={{ color: 'var(--fg-quaternary)', background: 'var(--tint-subtle)' }}>
                        {proj.convs.length}
                      </span>
                    </button>
                    {expanded && proj.convs.map((conv) => renderConv(conv))}
                  </div>
                )
              })}
              {conversations.length === 0 && (
                <div className="flex flex-col items-center justify-center py-14 gap-3">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, var(--accent-subtle) 0%, var(--bg-surface-2) 100%)' }}>
                    <MessageSquare size={18} className="text-[var(--fg-quaternary)]" />
                  </div>
                  <span className="text-[13px] font-medium" style={{ color: 'var(--fg-tertiary)' }}>No conversations yet</span>
                  <span className="text-[11px]" style={{ color: 'var(--fg-quaternary)' }}>Press <kbd>⌘N</kbd> to start a new chat</span>
                </div>
              )}

              {/* 历史记录分组 */}
              {historyConvs.length > 0 && (() => {
                // 按项目分组
                const histMap = new Map<string, HistoryConversation[]>()
                for (const h of historyConvs) {
                  const key = h.projectPath || ''
                  const arr = histMap.get(key)
                  if (arr) arr.push(h)
                  else histMap.set(key, [h])
                }
                const histProjects = Array.from(histMap.keys())
                  .sort((a, b) => {
                    const aTime = histMap.get(a)![0]?.updatedAt || ''
                    const bTime = histMap.get(b)![0]?.updatedAt || ''
                    return bTime.localeCompare(aTime)
                  })
                  .map(k => ({
                    key: k,
                    name: k ? getProjectName(k) || k : 'Other',
                    convs: histMap.get(k)!,
                  }))

                return (
                  <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <div className="flex items-center gap-1.5 px-2.5 py-2">
                      <History size={9} className="text-[var(--fg-quaternary)]" />
                      <span className="text-[10px] font-semibold text-[var(--fg-quaternary)] uppercase" style={{ letterSpacing: '0.08em' }}>
                        History ({historyConvs.length})
                      </span>
                    </div>
                    {histProjects.map((proj) => {
                      const expanded = historyExpanded.has(proj.key)
                      return (
                        <div key={proj.key || '__other'} className="mb-1">
                          <button
                            onClick={() => {
                              setHistoryExpanded((prev) => {
                                const next = new Set(prev)
                                if (next.has(proj.key)) next.delete(proj.key)
                                else next.add(proj.key)
                                return next
                              })
                            }}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors text-left"
                          >
                            <ChevronDown
                              size={12}
                              className="text-[var(--fg-quaternary)] transition-transform"
                              style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                            />
                            {proj.key
                              ? <FolderOpen size={12} className="text-[var(--fg-tertiary)]" />
                              : <Globe size={12} className="text-[var(--fg-tertiary)]" />
                            }
                            <span className="text-[11px] font-medium truncate flex-1" style={{ color: 'var(--fg-secondary)' }}>
                              {proj.name}
                            </span>
                            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-md" style={{ color: 'var(--fg-quaternary)', background: 'var(--tint-subtle)' }}>
                              {proj.convs.length}
                            </span>
                          </button>
                          {expanded && proj.convs.map((h) => (
                            <button
                              key={h.sessionId}
                              onClick={() => selectHistoryConversation(h)}
                              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors text-left"
                              style={{
                                background: activeHistoryId === h.sessionId ? 'var(--accent-subtle)' : 'transparent',
                                marginLeft: '12px',
                              }}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-[12px] font-medium truncate" style={{ color: 'var(--fg-primary)' }}>
                                  {h.title}
                                </div>
                                <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--fg-quaternary)' }}>
                                  {h.lastMessage || `${h.messageCount} messages`}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {h.entrypoint === 'vscode'
                                  ? <Terminal size={9} className="text-[var(--fg-quaternary)]" />
                                  : <Terminal size={9} className="text-[var(--fg-quaternary)]" />
                                }
                              </div>
                            </button>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <ProjectSelector project={project} onSelect={handleProjectSelect} />
          <div className="flex items-center justify-between mt-2.5">
            <div className="flex items-center gap-2">
              <div className={`dot ${cliInfo?.installed ? 'dot-connected' : cliInfo ? 'dot-error' : 'dot-disconnected'}`} />
              <span className="text-[11px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>
                {cliInfo === null ? 'Checking…' : cliInfo.installed ? `v${cliInfo.version}` : 'Not installed'}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                className="p-1.5 rounded-lg transition-colors hover:bg-[var(--tint-hover)]"
                title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
                onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              >
                {theme === 'dark' ? <Sun size={14} className="text-[var(--fg-tertiary)]" /> : <Moon size={14} className="text-[var(--fg-tertiary)]" />}
              </button>
              {/* Quick color accent switcher */}
              <div className="flex items-center gap-0.5 ml-0.5 pl-1.5" style={{ borderLeft: '1px solid var(--border-subtle)' }}>
                {(['purple', 'blue', 'yellow', 'red'] as const).map((color) => {
                  const colorMap: Record<string, string> = {
                    purple: '#7c5bf5',
                    blue: '#3b82f6',
                    yellow: '#eab308',
                    red: '#ef4444',
                  }
                  return (
                    <button
                      key={color}
                      onClick={() => setThemeColor(color)}
                      className="w-3.5 h-3.5 rounded-full transition-all"
                      style={{
                        background: colorMap[color],
                        opacity: themeColor === color ? 1 : 0.35,
                        transform: themeColor === color ? 'scale(1.25)' : 'scale(1)',
                        boxShadow: themeColor === color ? `0 0 6px ${colorMap[color]}` : 'none',
                      }}
                      title={`Accent: ${color.charAt(0).toUpperCase() + color.slice(1)}`}
                    />
                  )
                })}
              </div>
              <button
                onClick={() => setShowSettings(true)}
                className="p-1.5 rounded-lg transition-colors hover:bg-[var(--tint-hover)]"
                title="Settings"
              >
                <Settings size={14} className="text-[var(--fg-tertiary)]" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Right: Chat area */}
      <ErrorBoundary>
      <main className="flex-1 flex flex-col overflow-hidden" style={{ minWidth: '320px', isolation: 'isolate' }}>
        {/* Header */}
        <header
          className="drag-region glass flex items-center justify-between px-5 flex-shrink-0"
          style={{ height: '50px', borderBottom: '1px solid var(--border-default)' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={() => setSidebarCollapsed((v) => !v)}
              className="no-drag w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--tint-hover)]"
              title="Toggle sidebar (⌘B)"
            >
              <PanelLeft size={15} className="text-[var(--fg-tertiary)]" />
            </button>
            <span className="text-[13px] font-semibold text-[var(--fg-primary)] truncate">
              {activeHistoryId ? (historyDetail?.title || 'History') : (activeConv?.title || 'Claude Code Desktop')}
            </span>
          </div>
          <div className="flex items-center gap-2 no-drag flex-shrink-0">
            {/* 视图模式切换：Agent / Terminal / Chat */}
            {!activeHistoryId && activeConvId && (
              <div className="flex items-center gap-0.5 p-0.5 rounded-lg" style={{ background: 'var(--bg-surface-2)' }}>
                <button
                  onClick={() => setViewMode('agent')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all"
                  style={{
                    background: viewMode === 'agent' ? 'var(--accent-subtle)' : 'transparent',
                    color: viewMode === 'agent' ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                  }}
                  title="Pure GUI Agent mode (SDK-powered)"
                >
                  <Sparkles size={12} />
                  <span>Agent</span>
                </button>
                <button
                  onClick={() => setViewMode('chat')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all"
                  style={{
                    background: viewMode === 'chat' ? 'var(--accent-subtle)' : 'transparent',
                    color: viewMode === 'chat' ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                  }}
                  title="Structured GUI chat view (stream-json)"
                >
                  <MessageCircle size={12} />
                  <span>Chat</span>
                </button>
              </div>
            )}
            {(project || (activeHistoryId && historyDetail)) && (
              <div
                className="flex items-center gap-2 text-[11px] px-2.5 py-1 rounded-lg min-w-0"
                style={{ color: 'var(--fg-tertiary)', background: 'var(--tint-subtle)', maxWidth: '45vw' }}
              >
                <FolderOpen size={11} className="flex-shrink-0" />
                <span className="font-mono truncate">{activeHistoryId && historyDetail ? historyDetail.projectPath : project?.path}</span>
              </div>
            )}
            {activeConvId && (
              <button
                onClick={() => ipc.invoke('window:open-conversation', { convId: activeConvId })}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--tint-hover)]"
                title="Open in new window"
              >
                <ExternalLink size={14} className="text-[var(--fg-tertiary)]" />
              </button>
            )}
            <button
              onClick={() => setRightPanelOpen((v) => !v)}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--tint-hover)]"
              title="Toggle right panel"
              style={{ background: rightPanelOpen ? 'var(--accent-subtle)' : undefined }}
            >
              <PanelRight size={14} className={rightPanelOpen ? 'text-[var(--accent-bright)]' : 'text-[var(--fg-tertiary)]'} />
            </button>
          </div>
        </header>

        {/* Error banner */}
        {error && (
          <div
            className="px-5 py-2.5 text-[12px] font-medium flex items-center gap-2"
            style={{
              color: 'var(--danger)',
              background: 'rgba(248,113,113,0.07)',
              borderBottom: '1px solid rgba(248,113,113,0.12)',
            }}
          >
            <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: 'rgba(248,113,113,0.15)' }}>
              <X size={10} />
            </div>
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="p-0.5 rounded hover:bg-[rgba(248,113,113,0.15)] transition-colors"
              title="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {activeHistoryId && historyDetail ? (
          <ImportedChatView
            messages={historyDetail.messages}
            title={historyDetail.title}
            projectPath={historyDetail.projectPath}
            entrypoint={historyDetail.entrypoint}
            onContinue={resumeHistoryConversation}
          />
        ) : activeHistoryId && loadingHistory ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-[var(--fg-quaternary)]" />
              <span className="text-[12px] text-[var(--fg-tertiary)]">Loading history…</span>
            </div>
          </div>
        ) : viewMode === 'agent' && activeConvId ? (
          <AgentConversationView
            key={activeConvId}
            conversationId={activeConvId}
            cwd={project?.path || newChatProjectPath || ''}
            model={selectedModel}
            permissionMode={permissionMode}
            thinkingEffort={thinkingEffort}
            models={models}
            permissionModes={PERMISSION_MODES}
            thinkingEfforts={THINKING_EFFORTS}
            onModelChange={handleModelSelect}
            onPermissionModeChange={setPermissionMode}
            onThinkingEffortChange={setThinkingEffort}
            onSessionIdChange={(sid) => {
              if (activeConvId && activeConv?.claudeSessionId !== sid) {
                ipc.invoke('conversation:set-session-id', { id: activeConvId, sessionId: sid }).catch((err) => console.error('[App]', err))
              }
            }}
            onOpenActivity={() => setRightPanelOpen(true)}
            resumeSessionId={activeConv?.claudeSessionId}
          />
        ) : viewMode === 'agent' ? (
          /* Agent mode with no conversation selected — show placeholder */
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Sparkles size={28} style={{ color: 'var(--fg-quaternary)' }} />
              <span className="text-[13px]" style={{ color: 'var(--fg-quaternary)' }}>Select or create a conversation to start</span>
            </div>
          </div>
        ) : (
          <ChatView
            messages={messages}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            loading={loadingMsgs}
            project={project}
            models={models}
            selectedModel={selectedModel}
            onModelSelect={handleModelSelect}
            onClearChat={confirmClearChat}
            onNewChat={handleNewChat}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            permissionModes={PERMISSION_MODES}
            onResendWithPermission={handleResendWithPermission}
            thinkingEffort={thinkingEffort}
            onThinkingEffortChange={setThinkingEffort}
            thinkingEfforts={THINKING_EFFORTS}
          />
        )}
      </main>
      </ErrorBoundary>

      {/* Right panel */}
      {rightPanelOpen && (
        <RightPanel
          projectPath={activeHistoryId && historyDetail ? historyDetail.projectPath : (project?.path || null)}
          onClose={() => setRightPanelOpen(false)}
          convId={activeConvId}
          sessionId={activeConv?.claudeSessionId}
        />
      )}

      {/* Context menu */}
      {contextMenu && contextMenuConv && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }}
          />
          <div
            className="fixed z-50 rounded-xl py-1.5 animate-scale-in"
            style={{
              left: contextMenu.x, top: contextMenu.y, minWidth: '172px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div className="flex items-center justify-between px-3.5 pb-1.5 mb-0.5">
              <span className="text-[10px] font-semibold text-[var(--fg-quaternary)] uppercase" style={{ letterSpacing: '0.08em' }}>Actions</span>
              <button
                onClick={() => setContextMenu(null)}
                className="p-0.5 rounded-md hover:bg-[var(--tint-hover)] transition-colors"
                title="Close"
              >
                <X size={11} className="text-[var(--fg-quaternary)]" />
              </button>
            </div>
            <div className="h-px mx-2.5 mb-1" style={{ background: 'var(--border-subtle)' }} />
            <button
              onClick={() => { ipc.invoke('window:open-conversation', { convId: contextMenu.convId }); setContextMenu(null) }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-[var(--fg-primary)] hover:bg-[var(--tint-hover)] transition-colors text-left"
            >
              <ExternalLink size={13} className="text-[var(--fg-tertiary)]" />
              <span>Open in New Window</span>
            </button>
            <button
              onClick={() => { setEditingId(contextMenu.convId); setContextMenu(null) }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-[var(--fg-primary)] hover:bg-[var(--tint-hover)] transition-colors text-left"
            >
              <Edit3 size={13} className="text-[var(--fg-tertiary)]" />
              <span>Rename</span>
            </button>
            <button
              onClick={() => { handlePinToggle(contextMenuConv); setContextMenu(null) }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[12.5px] text-[var(--fg-primary)] hover:bg-[var(--tint-hover)] transition-colors text-left"
            >
              <Pin size={13} className="text-[var(--fg-tertiary)]" />
              <span>{contextMenuConv.pinned ? 'Unpin' : 'Pin'}</span>
            </button>
            <div className="h-px mx-2.5 my-1" style={{ background: 'var(--border-subtle)' }} />
            <button
              onClick={() => { confirmDelete(contextMenu.convId); setContextMenu(null) }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[12.5px] hover:bg-[rgba(248,113,113,0.08)] transition-colors text-left"
              style={{ color: 'var(--danger)' }}
            >
              <Trash2 size={13} />
              <span>Delete</span>
            </button>
          </div>
        </>
      )}

      {/* Settings modal */}
      {showSettings && (() => {
              const settingsTabs = ['General', 'Skills', 'API', 'Shortcuts', 'About'] as const
              return (
              <>
                <div
                  className="fixed inset-0 z-50"
                  style={{ background: 'rgba(0,0,0,0.5)' }}
                  onClick={() => setShowSettings(false)}
                />
                <div
                  className="fixed z-50 rounded-2xl overflow-hidden animate-scale-in flex flex-col"
                  style={{
                    top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    width: '480px', maxWidth: '90vw', maxHeight: '80vh',
                    background: 'var(--bg-glass)',
                    backdropFilter: 'blur(24px) saturate(1.4)',
                    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
                    border: '1px solid var(--border-default)',
                    boxShadow: 'var(--shadow-xl)',
                  }}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between px-5 py-3.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <span className="text-[14px] font-semibold" style={{ color: 'var(--fg-primary)' }}>Settings</span>
                    <button onClick={() => setShowSettings(false)} className="p-1 rounded-md hover:bg-[var(--tint-hover)] transition-colors">
                      <X size={14} className="text-[var(--fg-tertiary)]" />
                    </button>
                  </div>

                  {/* Tabs */}
                  <div className="flex gap-1 px-5 pt-3 flex-shrink-0">
                    {settingsTabs.map(tab => (
                      <button
                        key={tab}
                        onClick={() => setSettingsTab(tab)}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
                        style={{
                          background: settingsTab === tab ? 'var(--accent-subtle)' : 'transparent',
                          color: settingsTab === tab ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                        }}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  {/* Content */}
                  <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5 min-h-0">
                    {/* ── General ── */}
                    {settingsTab === 'General' && (
                      <>
                        <div>
                          <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>Theme</div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setTheme('dark')}
                              className="flex-1 px-3 py-2.5 rounded-lg text-[12px] font-medium transition-all flex items-center justify-center gap-1.5"
                              style={{
                                background: theme === 'dark' ? 'var(--accent-subtle)' : 'var(--bg-surface-2)',
                                color: theme === 'dark' ? 'var(--accent-bright)' : 'var(--fg-secondary)',
                                border: theme === 'dark' ? '1px solid var(--border-accent)' : '1px solid var(--border-default)',
                              }}
                            >
                              <Moon size={13} />Dark
                            </button>
                            <button
                              onClick={() => setTheme('light')}
                              className="flex-1 px-3 py-2.5 rounded-lg text-[12px] font-medium transition-all flex items-center justify-center gap-1.5"
                              style={{
                                background: theme === 'light' ? 'var(--accent-subtle)' : 'var(--bg-surface-2)',
                                color: theme === 'light' ? 'var(--accent-bright)' : 'var(--fg-secondary)',
                                border: theme === 'light' ? '1px solid var(--border-accent)' : '1px solid var(--border-default)',
                              }}
                            >
                              <Sun size={13} />Light
                            </button>
                          </div>
                        </div>
                        {/* Accent color */}
                        <div>
                          <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>Accent Color</div>
                          <div className="flex items-center gap-2.5">
                            {(['purple', 'blue', 'yellow', 'red'] as const).map((color) => {
                              const colorMap: Record<string, string> = {
                                purple: '#7c5bf5',
                                blue: '#3b82f6',
                                yellow: '#eab308',
                                red: '#ef4444',
                              }
                              return (
                                <button
                                  key={color}
                                  onClick={() => setThemeColor(color)}
                                  className="w-8 h-8 rounded-xl transition-all flex items-center justify-center"
                                  style={{
                                    background: colorMap[color],
                                    boxShadow: themeColor === color
                                      ? `0 0 0 2px var(--bg-surface), 0 0 0 4px ${colorMap[color]}`
                                      : 'none',
                                    transform: themeColor === color ? 'scale(1.1)' : 'scale(1)',
                                    opacity: themeColor === color ? 1 : 0.6,
                                  }}
                                  title={color.charAt(0).toUpperCase() + color.slice(1)}
                                >
                                  {themeColor === color && (
                                    <Check size={12} strokeWidth={3} color="white" />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>Claude CLI</div>
                          <div className="flex items-center gap-2.5 text-[12px]">
                            <div className={`dot ${cliInfo?.installed ? 'dot-connected' : cliInfo ? 'dot-error' : 'dot-disconnected'}`} />
                            <span style={{ color: 'var(--fg-secondary)' }}>
                              {cliInfo === null ? 'Checking…' : cliInfo.installed ? `Installed v${cliInfo.version}` : 'Not installed'}
                            </span>
                          </div>
                          {cliInfo?.error && (
                            <div className="text-[11px] mt-1.5" style={{ color: 'var(--danger)' }}>{cliInfo.error}</div>
                          )}
                        </div>
                      </>
                    )}

                    {/* ── Skills ── */}
                    {settingsTab === 'Skills' && (
                      <>
                        {/* 总开关 */}
                        <div>
                          <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>Skills</div>
                          <div
                            className="flex items-center justify-between px-3.5 py-3 rounded-xl transition-all cursor-pointer"
                            style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)' }}
                            onClick={() => {
                              const next = !skillsEnabled
                              setSkillsEnabled(next)
                              ipc.invoke('settings:set', { key: 'skillsEnabled', value: next }).catch((err) => console.error('[App]', err))
                            }}
                          >
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[12.5px] font-medium" style={{ color: 'var(--fg-primary)' }}>Enable skills</span>
                              <span className="text-[11px]" style={{ color: 'var(--fg-tertiary)' }}>
                                加载 ~/.claude/skills 与项目 .claude/skills 的自定义 skills
                              </span>
                            </div>
                            <div
                              style={{
                                width: 34, height: 20, borderRadius: 10, flexShrink: 0,
                                background: skillsEnabled ? 'var(--accent-primary)' : 'var(--bg-surface-3)',
                                position: 'relative', transition: 'background 200ms ease',
                              }}
                            >
                              <div
                                style={{
                                  position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                                  background: '#fff', transition: 'left 200ms ease',
                                  left: skillsEnabled ? 16 : 2,
                                }}
                              />
                            </div>
                          </div>
                          <div className="text-[11px] mt-2 leading-relaxed" style={{ color: 'var(--fg-quaternary)' }}>
                            内置 skills（code-review、verify、deep-research 等）随 Claude CLI 提供；关闭后全部不加载。改动对新会话生效。
                          </div>
                        </div>

                        {/* 已发现的 skills */}
                        <div>
                          <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>
                            Discovered ({scannedSkills.length})
                          </div>
                          {scannedSkills.length === 0 ? (
                            <div
                              className="flex flex-col items-center gap-2 py-8 rounded-xl"
                              style={{ background: 'var(--bg-surface-2)', border: '1px dashed var(--border-default)' }}
                            >
                              <Sparkles size={18} className="text-[var(--fg-quaternary)]" />
                              <span className="text-[11.5px]" style={{ color: 'var(--fg-tertiary)' }}>
                                没有发现自定义 skills
                              </span>
                              <span className="text-[10.5px] px-4 text-center" style={{ color: 'var(--fg-quaternary)' }}>
                                在 ~/.claude/skills/&lt;name&gt;/SKILL.md 或项目 .claude/skills/&lt;name&gt;/SKILL.md
                                创建后会自动出现在这里
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {scannedSkills.map((skill) => (
                                <div
                                  key={skill.name}
                                  className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl"
                                  style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)' }}
                                >
                                  <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent-subtle)' }}>
                                    <Sparkles size={13} style={{ color: 'var(--accent-bright)' }} />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[12.5px] font-medium font-mono" style={{ color: 'var(--fg-primary)' }}>
                                        {skill.name}
                                      </span>
                                      <span
                                        className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded"
                                        style={{
                                          color: skill.source === 'user' ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                                          background: skill.source === 'user' ? 'var(--accent-subtle)' : 'var(--tint-subtle)',
                                          letterSpacing: '0.04em',
                                        }}
                                      >
                                        {skill.source}
                                      </span>
                                    </div>
                                    {skill.description && (
                                      <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>
                                        {skill.description}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {/* ── API ── */}
                    {settingsTab === 'API' && (
                      <div>
                        <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>API Key</div>
                        <div className="text-[11px] mb-3 leading-relaxed" style={{ color: 'var(--fg-tertiary)' }}>
                          Required for Agent SDK mode. Your key is stored locally and never sent to third parties.
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 relative">
                            <input
                              type={apiKeyVisible ? 'text' : 'password'}
                              value={apiKey}
                              onChange={(e) => { setApiKey(e.target.value); setApiKeySaved(false) }}
                              placeholder="sk-…"
                              className="w-full px-3 py-2 rounded-lg text-[12px] font-mono outline-none transition-all input"
                              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-subtle)' }}
                              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.boxShadow = 'none' }}
                            />
                            <button
                              onClick={() => setApiKeyVisible(v => !v)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors hover:bg-[var(--tint-hover)]"
                              title={apiKeyVisible ? 'Hide' : 'Show'}
                            >
                              {apiKeyVisible ? <EyeOff size={12} style={{ color: 'var(--fg-quaternary)' }} /> : <Eye size={12} style={{ color: 'var(--fg-quaternary)' }} />}
                            </button>
                          </div>
                          <button
                            onClick={() => {
                              ipc.invoke('settings:set', { key: 'apiKey', value: apiKey })
                                .then(() => { setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000) })
                                .catch((err) => console.error('[App]', err))
                            }}
                            className="px-3 py-2 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1.5"
                            style={{
                              background: apiKeySaved ? 'var(--success-subtle)' : 'var(--accent-subtle)',
                              color: apiKeySaved ? 'var(--success)' : 'var(--accent-bright)',
                              border: `1px solid ${apiKeySaved ? 'rgba(48,209,88,0.2)' : 'var(--border-accent)'}`,
                            }}
                          >
                            {apiKeySaved ? <><Check size={12} /> Saved</> : 'Save'}
                          </button>
                        </div>
                        <a
                          href="https://console.anthropic.com/settings/keys"
                          target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 mt-2.5 text-[11px] transition-colors"
                          style={{ color: 'var(--accent-bright)' }}
                        >
                          <Key size={10} />
                          Get an API key from Anthropic Console
                          <ExternalLink size={10} />
                        </a>
                      </div>
                    )}

                    {/* ── Shortcuts ── */}
                    {settingsTab === 'Shortcuts' && (
                      <div>
                        <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-3" style={{ letterSpacing: '0.06em' }}>Keyboard Shortcuts</div>
                        <div className="flex flex-col gap-1">
                          {[
                            { keys: '⌘N', label: 'New Chat' },
                            { keys: '⌘M', label: 'Switch Model' },
                            { keys: '⌘K', label: 'Search conversations' },
                            { keys: '⌘B', label: 'Toggle sidebar' },
                            { keys: '⌘J', label: 'Toggle right panel' },
                            { keys: '⌘⇧C', label: 'Clear current chat' },
                            { keys: 'Esc', label: 'Stop generation' },
                            { keys: '⌘/ or /', label: 'Open slash commands' },
                            { keys: '⌘Enter', label: 'Send message' },
                          ].map((shortcut, i) => (
                            <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--tint-subtle)' }}>
                              <span className="text-[12px]" style={{ color: 'var(--fg-secondary)' }}>{shortcut.label}</span>
                              <kbd>{shortcut.keys}</kbd>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── About ── */}
                    {settingsTab === 'About' && (
                      <div className="flex flex-col items-center text-center py-4 gap-3">
                        <div
                          style={{
                            width: 44, height: 44, borderRadius: 14,
                            background: 'linear-gradient(145deg, var(--accent-primary) 0%, var(--accent-bright) 40%, color-mix(in srgb, var(--accent-bright) 80%, white) 100%)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 4px 16px var(--accent-glow)',
                          }}
                        >
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" strokeWidth="1.5" />
                            <path d="M8 9l3 3-3 3" />
                            <path d="M14 15h3" />
                          </svg>
                        </div>
                        <div>
                          <div className="text-[14px] font-semibold" style={{ color: 'var(--fg-primary)' }}>Claude Code Desktop</div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>v0.1.0</div>
                        </div>
                        <div className="text-[11px] leading-relaxed" style={{ color: 'var(--fg-quaternary)', maxWidth: 280 }}>
                          A lightweight desktop GUI for Claude Code CLI. Built with Electron, React, and TypeScript.
                        </div>
                        <div className="flex gap-2 mt-1">
                          <div className="tag">
                            <FileCode size={10} />
                            Electron
                          </div>
                          <div className="tag">
                            <FileCode size={10} />
                            React
                          </div>
                          <div className="tag">
                            <FileCode size={10} />
                            TypeScript
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-end px-5 py-3 flex-shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <button
                      onClick={() => setShowSettings(false)}
                      className="btn btn-secondary text-[11px] px-4 py-1.5"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </>
              )
            })()}

      {/* Confirm dialog */}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          danger={confirmDialog.danger}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
      {/* Global toast notifications */}
      <ToastContainer />
    </div>
  )
}
