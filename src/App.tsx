import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Plus, Search, Pin, FolderOpen, Settings, ChevronDown, Sparkles, Edit3, Loader2, Trash2, X, MessageSquare, Hash, Sun, Moon, PanelLeft, ExternalLink } from 'lucide-react'
import ChatView from './components/ChatView'
import ConversationItem from './components/ConversationItem'
import ModelSelector from './components/ModelSelector'
import ProjectSelector from './components/ProjectSelector'
import ConfirmDialog from './components/ConfirmDialog'
import { ipc } from './lib/ipc'
import type { Conversation, Message, Attachment } from './types'
import { MODELS } from './types'

/* ---------- helpers ---------- */

function getProjectName(path: string | null): string | null {
  if (!path) return null
  const parts = path.split('/')
  return parts[parts.length - 1] || path
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
  const [searchQuery, setSearchQuery] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
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
  // CLI 安装状态：null = 还在检测，{installed, version} = 检测结果
  const [cliInfo, setCliInfo] = useState<{ installed: boolean; version: string | null; error?: string } | null>(null)
  // 设置面板开关
  const [showSettings, setShowSettings] = useState(false)
  // 确认对话框状态
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; message: string; confirmLabel?: string; danger?: boolean;
    onConfirm: () => void
  } | null>(null)

  const activeConvIdRef = useRef<string | null>(null)
  useEffect(() => { activeConvIdRef.current = activeConvId }, [activeConvId])
  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming

  // Apply + persist theme on <html>.
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
    try { localStorage.setItem('ccd:theme', theme) } catch {}
  }, [theme])

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

  /* ---- 检测 Claude CLI 安装状态 ---- */
  useEffect(() => {
    ipc.invoke<{ installed: boolean; version: string | null; error?: string }>('cli:check')
      .then(setCliInfo)
      .catch((e) => setCliInfo({ installed: false, version: null, error: String(e) }))
  }, [])

  // Persist session state across reloads.
  useEffect(() => { try { localStorage.setItem('ccd:conv', activeConvId || '') } catch {} }, [activeConvId])
  useEffect(() => { try { localStorage.setItem('ccd:project', newChatProjectPath || '') } catch {} }, [newChatProjectPath])
  useEffect(() => { try { localStorage.setItem('ccd:expanded', JSON.stringify(Array.from(expandedProjects))) } catch {} }, [expandedProjects])
  useEffect(() => { try { localStorage.setItem('ccd:sidebar', sidebarCollapsed ? '1' : '0') } catch {} }, [sidebarCollapsed])

  // Bind this window's active conversation to the main process so stream
  // chunks are routed here. Re-binds whenever the active conversation changes.
  useEffect(() => {
    ipc.invoke('window:bind', { convId: activeConvId }).catch(() => {})
  }, [activeConvId])

  /* ---- select conversation and load messages ---- */
  const selectConversation = useCallback(async (id: string) => {
    if (isStreaming) return
    setActiveConvId(id)
    setLoadingMsgs(true)
    setError(null)
    try {
      const res = await ipc.invoke<{ ok: boolean; messages?: Message[]; error?: string }>('message:list', { conversationId: id })
      if (res?.ok && res.messages) {
        setMessages(res.messages)
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
  }, [isStreaming])

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

  /* ---- subscribe to stream events ---- */
  useEffect(() => {
    const unsubChunk = ipc.on('stream:chunk', (data: { conversationId: string; chunk: { type: string; content?: string; tool?: string; error?: string } }) => {
      if (data.conversationId !== activeConvIdRef.current) return
      const chunk = data.chunk
      if (chunk.type === 'text' && chunk.content) {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: last.content + chunk.content }]
          }
          return prev
        })
      } else if (chunk.type === 'text-replace' && chunk.content !== undefined) {
        // Replay of accumulated text when binding a window to a mid-stream
        // conversation (opened in a new window). Replace, don't append.
        setIsStreaming(true)
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: chunk.content! }]
          }
          return [...prev, { id: crypto.randomUUID(), conversationId: data.conversationId, role: 'assistant' as const, content: chunk.content!, timestamp: new Date().toISOString() }]
        })
      } else if (chunk.type === 'error' && chunk.error) {
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

    const unsubEnd = ipc.on('stream:end', (data: { conversationId: string }) => {
      if (data.conversationId !== activeConvIdRef.current) return
      setIsStreaming(false)
      loadConversationsRef.current()
    })

    const unsubError = ipc.on('stream:error', (data: { conversationId: string; error: string }) => {
      if (data.conversationId !== activeConvIdRef.current) return
      setIsStreaming(false)
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && !last.content) {
          return [...prev.slice(0, -1), { ...last, content: `Error: ${data.error}` }]
        }
        return [...prev, { id: crypto.randomUUID(), conversationId: data.conversationId, role: 'assistant' as const, content: `Error: ${data.error}`, timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) }]
      })
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
      }).catch(() => {})
    })
    return unsub
  }, [])

  /* ---- new chat ---- */
  const handleNewChat = async () => {
    if (isStreaming) return
    try {
      const conv = await ipc.invoke<Conversation>('conversation:create', {
        title: 'New Chat',
        projectPath: newChatProjectPath || null,
        model: selectedModel,
      })
      setConversations((prev) => [conv, ...prev])
      setActiveConvId(conv.id)
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
    if (isStreaming) return
    try {
      const conv = await ipc.invoke<Conversation>('conversation:create', {
        title: 'New Chat',
        projectPath: null,
        model: selectedModel,
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
    if (activeConvId) ipc.invoke('stop:generation', { conversationId: activeConvId })
  }
  stopRef.current = handleStop

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
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    try {
      const res = await ipc.invoke<{ ok: boolean; error?: string }>('message:send', { conversationId: activeConvId, message: text, attachments })
      if (!res?.ok) {
        setIsStreaming(false)
        setError(res?.error || 'Failed to send message')
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && !last.content) return prev.slice(0, -1)
          return prev
        })
      }
    } catch (e) {
      console.error('Failed to send message:', e)
      setIsStreaming(false)
      setError('Failed to send message. Please try again.')
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && !last.content) return prev.slice(0, -1)
        return prev
      })
    }
  }

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
        className="glass sidebar-accent flex flex-col flex-shrink-0"
        style={{ width: sidebarCollapsed ? 0 : '288px', borderRight: sidebarCollapsed ? 'none' : '1px solid var(--border-default)', transition: 'width 200ms ease', overflow: 'hidden' }}
      >
        {/* macOS traffic light drag region */}
        <div className="drag-region flex-shrink-0" style={{ height: '36px' }} />
        {/* Logo / brand header */}
        <div className="px-4 pb-3">
          <div className="flex items-center gap-3 mb-5">
            <div className="logo-mark" style={{ width: 30, height: 30, borderRadius: '10px' }}>
              <Sparkles size={15} color="#fff" strokeWidth={2} />
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
          <ModelSelector selected={selectedModel} models={MODELS} onSelect={handleModelSelect} />
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
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <Loader2 size={18} className="animate-spin text-[var(--fg-quaternary)]" />
              <span className="text-[11px] text-[var(--fg-quaternary)]">Loading…</span>
            </div>
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
                <div className="flex flex-col items-center justify-center py-10 gap-2">
                  <span className="text-[12px] text-[var(--fg-tertiary)]">No matches</span>
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
                <div className="flex flex-col items-center justify-center py-10 gap-2">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center mb-1"
                    style={{ background: 'var(--bg-surface-2)' }}
                  >
                    <MessageSquare size={16} className="text-[var(--fg-quaternary)]" />
                  </div>
                  <span className="text-[12px] font-medium text-[var(--fg-tertiary)]">No conversations yet</span>
                  <span className="text-[11px] text-[var(--fg-quaternary)]">Start a new chat to begin</span>
                </div>
              )}
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
      <main className="flex-1 flex flex-col overflow-hidden">
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
            <span className="text-[13px] font-semibold text-[var(--fg-primary)] truncate">{activeConv?.title || 'Claude Code Desktop'}</span>
          </div>
          <div className="flex items-center gap-2 no-drag flex-shrink-0">
            {project && (
              <div
                className="flex items-center gap-2 text-[11px] px-2.5 py-1 rounded-lg min-w-0"
                style={{ color: 'var(--fg-tertiary)', background: 'var(--tint-subtle)', maxWidth: '45vw' }}
              >
                <FolderOpen size={11} className="flex-shrink-0" />
                <span className="font-mono truncate">{project.path}</span>
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

        <ChatView
          messages={messages}
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          loading={loadingMsgs}
          project={project}
          models={MODELS}
          selectedModel={selectedModel}
          onModelSelect={handleModelSelect}
          onClearChat={confirmClearChat}
          onNewChat={handleNewChat}
        />
      </main>

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
      {showSettings && (
        <>
          <div
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.45)' }}
            onClick={() => setShowSettings(false)}
          />
          <div
            className="fixed z-50 rounded-2xl animate-scale-in"
            style={{
              top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              width: '400px', maxWidth: '90vw',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <span className="text-[14px] font-semibold text-[var(--fg-primary)]">Settings</span>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1 rounded-md hover:bg-[var(--tint-hover)] transition-colors"
              >
                <X size={14} className="text-[var(--fg-tertiary)]" />
              </button>
            </div>
            <div className="px-5 py-4 flex flex-col gap-5">
              <div>
                <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>Claude CLI</div>
                <div className="flex items-center gap-2 text-[12px]">
                  <div className={`dot ${cliInfo?.installed ? 'dot-connected' : cliInfo ? 'dot-error' : 'dot-disconnected'}`} />
                  <span style={{ color: 'var(--fg-secondary)' }}>
                    {cliInfo === null ? 'Checking…' : cliInfo.installed ? `Installed v${cliInfo.version}` : 'Not installed'}
                  </span>
                </div>
                {cliInfo?.error && (
                  <div className="text-[11px] mt-1.5" style={{ color: 'var(--danger)' }}>{cliInfo.error}</div>
                )}
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>Theme</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setTheme('dark')}
                    className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors flex items-center justify-center gap-1.5"
                    style={{
                      background: theme === 'dark' ? 'var(--accent-subtle)' : 'var(--bg-surface-2)',
                      color: theme === 'dark' ? 'var(--accent-bright)' : 'var(--fg-secondary)',
                      border: theme === 'dark' ? '1px solid var(--accent-primary)' : '1px solid var(--border-default)',
                    }}
                  >
                    <Moon size={13} />Dark
                  </button>
                  <button
                    onClick={() => setTheme('light')}
                    className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors flex items-center justify-center gap-1.5"
                    style={{
                      background: theme === 'light' ? 'var(--accent-subtle)' : 'var(--bg-surface-2)',
                      color: theme === 'light' ? 'var(--accent-bright)' : 'var(--fg-secondary)',
                      border: theme === 'light' ? '1px solid var(--accent-primary)' : '1px solid var(--border-default)',
                    }}
                  >
                    <Sun size={13} />Light
                  </button>
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase text-[var(--fg-quaternary)] mb-2.5" style={{ letterSpacing: '0.06em' }}>About</div>
                <div className="text-[12px]" style={{ color: 'var(--fg-secondary)' }}>
                  Claude Code Desktop v0.1.0
                </div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--fg-quaternary)' }}>
                  A lightweight GUI for Claude Code CLI
                </div>
              </div>
            </div>
          </div>
        </>
      )}

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
    </div>
  )
}
