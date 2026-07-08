import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import type { ReactNode, KeyboardEvent, ClipboardEvent, DragEvent } from 'react'
import { ipc } from '../lib/ipc'
import { ArrowUp, FileCode, Sparkles, FolderOpen, Zap, Trash2, Plus, HelpCircle, Cpu, Square, Copy, Check, Paperclip, Image as ImageIcon, X as XIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, ModelOption, Attachment } from '../types'

/* ---------- slash commands ---------- */

export interface SlashCommand {
  id: string
  label: string
  description: string
  icon: typeof Zap
  shortcut?: string
}

function buildSlashCommands(models: ModelOption[], currentModel: string): SlashCommand[] {
  return [
    {
      id: 'model',
      label: 'Switch Model',
      description: `Current: ${models.find(m => m.id === currentModel)?.name || 'Default'}`,
      icon: Cpu,
      shortcut: '⌘M',
    },
    {
      id: 'new',
      label: 'New Chat',
      description: 'Start a new conversation',
      icon: Plus,
      shortcut: '⌘N',
    },
    {
      id: 'clear',
      label: 'Clear History',
      description: 'Remove all messages in this chat',
      icon: Trash2,
    },
    {
      id: 'help',
      label: 'Help & Shortcuts',
      description: 'Show available commands and shortcuts',
      icon: HelpCircle,
    },
  ]
}

/* ---------- attachment helpers ---------- */

/** Read a clipboard/dropped File into a base64 data URL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Approximate byte size of a base64 data URL payload. */
function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(b64.length * 0.75) - pad)
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function nextAttachId(): string {
  return `att-${crypto.randomUUID()}`
}

/* ---------- attachment chips (input preview) ---------- */

const AttachmentPreview = memo(function AttachmentPreview({
  att,
  onRemove,
}: {
  att: Attachment
  onRemove: (id: string) => void
}) {
  if (att.kind === 'image' && att.dataUrl) {
    return (
      <div className="relative group" style={{ animation: 'fadeIn 150ms ease' }}>
        <img
          src={att.dataUrl}
          alt={att.name}
          className="rounded-lg object-cover"
          style={{ width: 56, height: 56, border: '1px solid var(--border-default)' }}
        />
        <button
          onClick={() => onRemove(att.id)}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center"
          style={{ background: 'var(--bg-surface-3)', color: 'var(--fg-secondary)' }}
          title="Remove"
        >
          <XIcon size={9} strokeWidth={2.5} />
        </button>
      </div>
    )
  }
  // file chip
  return (
    <div
      className="flex items-center gap-1.5 rounded-lg pl-2 pr-1 py-1 animate-fade-in"
      style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)', maxWidth: '220px' }}
    >
      <FileCode size={12} className="flex-shrink-0 text-[var(--accent-bright)]" />
      <span className="text-[11px] truncate" style={{ color: 'var(--fg-secondary)' }}>{att.name}</span>
      <button
        onClick={() => onRemove(att.id)}
        className="flex-shrink-0 p-0.5 rounded hover:bg-[var(--tint-hover)]"
        title="Remove"
      >
        <XIcon size={10} className="text-[var(--fg-tertiary)]" />
      </button>
    </div>
  )
})

/* ---------- types ---------- */

interface Token {
  type: 'str' | 'com' | 'num' | 'key' | 'type' | 'fn' | 'ident' | 'ws' | 'punct'
  value: string
}

/* ---------- syntax highlighting ---------- */

const KEYWORDS = new Set([
  'import', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else',
  'try', 'catch', 'finally', 'async', 'await', 'new', 'class', 'extends',
  'interface', 'type', 'enum', 'public', 'private', 'readonly', 'static',
  'void', 'null', 'undefined', 'true', 'false', 'as', 'from', 'default',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'throw',
  'typeof', 'this', 'super', 'yield', 'delete',
])

function tokenizeLine(line: string): Token[] {
  if (!line) return [{ type: 'ws', value: '\u00A0' }]
  const tokens: Token[] = []
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/\/[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|([\s\S])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m[1]) tokens.push({ type: 'str', value: m[1] })
    else if (m[2]) tokens.push({ type: 'com', value: m[2] })
    else if (m[3]) tokens.push({ type: 'num', value: m[3] })
    else if (m[4]) {
      const v = m[4]
      if (KEYWORDS.has(v)) tokens.push({ type: 'key', value: v })
      else if (/^[A-Z]/.test(v)) tokens.push({ type: 'type', value: v })
      else tokens.push({ type: 'ident', value: v })
    } else if (m[5]) tokens.push({ type: 'ws', value: m[5] })
    else tokens.push({ type: 'punct', value: m[6] })
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'ident') {
      let j = i + 1
      while (j < tokens.length && tokens[j].type === 'ws') j++
      if (j < tokens.length && tokens[j].value === '(') tokens[i].type = 'fn'
    }
  }
  return tokens
}

function renderCodeTokens(tokens: Token[]): ReactNode[] {
  const cls: Record<string, string> = {
    str: 'tk-str', com: 'tk-com', num: 'tk-num', key: 'tk-key', type: 'tk-type', fn: 'tk-fn',
  }
  return tokens.map((t, i) => (
    <span key={i} className={cls[t.type] || 'tk-var'}>{t.value}</span>
  ))
}




const CodeBlockView = memo(function CodeBlockView({ language, code }: { language: string; code: string }) {
  const lines = code.split('\n')
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  return (
    <div className="code-block" style={{ margin: '12px 0' }}>
      <div className="code-header">
        <div className="flex items-center gap-2">
          <FileCode size={12} style={{ color: 'var(--accent-bright)' }} />
          <span style={{ color: 'var(--fg-secondary)', fontWeight: 500 }}>{language || 'text'}</span>
        </div>
        <button onClick={copy} className="code-copy" title="Copy code">
          {copied ? <Check size={12} style={{ color: 'var(--success)' }} /> : <Copy size={12} style={{ color: 'var(--fg-tertiary)' }} />}
        </button>
      </div>
      <div className="code-body" style={{ fontFamily: 'var(--font-mono)' }}>
        {lines.map((line, i) => (
          <div key={i} style={{ minHeight: '1.7em', whiteSpace: 'pre' }}>
            {renderCodeTokens(tokenizeLine(line))}
          </div>
        ))}
      </div>
    </div>
  )
})


/* ---------- message bubbles ---------- */

const UserAttachments = memo(function UserAttachments({ atts }: { atts: Attachment[] }) {
  if (!atts.length) return null
  const images = atts.filter((a) => a.kind === 'image' && a.dataUrl)
  const files = atts.filter((a) => a.kind !== 'image' || !a.dataUrl)
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 justify-end" style={{ maxWidth: '72%' }}>
          {images.map((a) => (
            <img key={a.id} src={a.dataUrl} alt={a.name} className="rounded-xl object-cover"
              style={{ width: 120, height: 120, border: '1px solid var(--border-default)' }} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col items-end gap-1" style={{ maxWidth: '72%' }}>
          {files.map((a) => (
            <div key={a.id} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
              style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)' }}>
              <FileCode size={12} className="text-[var(--accent-bright)]" />
              <span className="text-[11px] font-mono truncate" style={{ color: 'var(--fg-secondary)', maxWidth: '180px' }}>{a.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

const UserMessage = memo(function UserMessage({ msg, idx }: { msg: Message; idx: number }) {
  const atts = msg.attachments ?? []
  return (
    <div className="flex flex-col items-end gap-1.5 animate-fade-in" style={{ animationDelay: `${idx * 30}ms` }}>
      {msg.content && (
        <div
          className="px-4 py-3 text-[14px] leading-relaxed"
          style={{
            background: 'linear-gradient(135deg, var(--accent-primary) 0%, #7c3aed 100%)',
            borderRadius: '18px 18px 4px 18px',
            maxWidth: '72%',
            color: '#fff',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            boxShadow: '0 2px 8px rgba(99,102,241,0.25)',
          }}
        >
          {msg.content}
        </div>
      )}
      <UserAttachments atts={atts} />
      <span className="text-[10px] px-1.5" style={{ color: 'var(--fg-quaternary)' }}>{fmtTime(msg.timestamp)}</span>
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({ msg, idx }: { msg: Message; idx: number }) {
  const content = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }) => {
          const match = /language-(\w+)/.exec(className || '')
          if (match) {
            return <CodeBlockView language={match[1]} code={String(children).replace(/\n$/, '')} />
          }
          return <code>{children}</code>
        },
      }}
    >
      {msg.content}
    </ReactMarkdown>
  ), [msg.content])
  const [copied, setCopied] = useState(false)
  const [hovered, setHovered] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(msg.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  return (
    <div
      className="group flex flex-col gap-3.5 animate-fade-in"
      style={{ animationDelay: `${idx * 30}ms` }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex gap-3">
        <div
          className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, #a855f7 100%)' }}
        >
          <Sparkles size={13} color="#fff" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--fg-primary)' }}>Claude</span>
            <span className="text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>{fmtTime(msg.timestamp)}</span>
            <button
              onClick={copy}
              className="ml-auto p-1 rounded-md transition-opacity hover:bg-[var(--tint-hover)]"
              style={{ opacity: hovered ? 1 : 0 }}
              title="Copy message"
            >
              {copied ? <Check size={12} style={{ color: 'var(--success)' }} /> : <Copy size={12} style={{ color: 'var(--fg-tertiary)' }} />}
            </button>
          </div>
          {msg.content && <div className="prose">{content}</div>}
        </div>
      </div>
    </div>
  )
})

/* ---------- time formatter ---------- */

function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/* ---------- ChatView ---------- */

export interface ChatViewProps {
  messages: Message[]
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  isStreaming: boolean
  loading?: boolean
  project: { name: string; path: string } | null
  models: ModelOption[]
  selectedModel: string
  onModelSelect: (modelId: string) => void
  onClearChat: () => void
  onNewChat: () => void
}

export default function ChatView({ messages, onSend, onStop, isStreaming, loading, project, models, selectedModel, onModelSelect, onClearChat, onNewChat }: ChatViewProps) {
  const [inputText, setInputText] = useState('')
  const [focused, setFocused] = useState(false)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [showModelPicker, setShowModelPicker] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)

  const addAttachment = useCallback((att: Attachment) => {
    setAttachments((prev) => [...prev, att])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const addImageFromDataUrl = useCallback((dataUrl: string, name: string, mimeType: string, size: number) => {
    addAttachment({
      id: nextAttachId(), kind: 'image', name, size: size || dataUrlByteSize(dataUrl),
      mimeType, dataUrl,
    })
  }, [addAttachment])

  const addFilePath = useCallback((filePath: string) => {
    addAttachment({
      id: nextAttachId(), kind: 'file', name: basename(filePath), size: 0, path: filePath,
    })
  }, [addAttachment])

  // Upload files via native dialog (returns absolute paths).
  const handleAddFiles = useCallback(async () => {
    try {
      const res = await ipc.invoke<{ canceled: boolean; filePaths: string[] }>('attachment:open-files', { imagesOnly: false })
      if (!res.canceled) res.filePaths.forEach(addFilePath)
    } catch (e) { console.error('Failed to open files:', e) }
  }, [addFilePath])

  // Upload images via native dialog -> read as base64 data URL.
  const handleAddImages = useCallback(async () => {
    try {
      const res = await ipc.invoke<{ canceled: boolean; filePaths: string[] }>('attachment:open-files', { imagesOnly: true })
      if (res.canceled) return
      for (const fp of res.filePaths) {
        const r = await ipc.invoke<{ dataUrl: string; mimeType: string } | null>('attachment:read-data-url', { filePath: fp })
        if (r) addImageFromDataUrl(r.dataUrl, basename(fp), r.mimeType, 0)
      }
    } catch (e) { console.error('Failed to open images:', e) }
  }, [addImageFromDataUrl])

  // Paste: images (clipboard screenshot) -> data URL; files (Finder copy) -> paths.
  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const arr = Array.from(items)
    const imageItems = arr.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (imageItems.length > 0) {
      e.preventDefault()
      for (const it of imageItems) {
        const file = it.getAsFile()
        if (!file) continue
        try {
          const dataUrl = await readFileAsDataUrl(file)
          addImageFromDataUrl(dataUrl, file.name || 'pasted-image.png', file.type, file.size)
        } catch (err) { console.error('Failed to read pasted image:', err) }
      }
      return
    }
    // Non-image file paste (e.g. file copied in Finder): resolve paths via main.
    const hasFile = arr.some((it) => it.kind === 'file')
    if (hasFile) {
      e.preventDefault()
      try {
        const paths = await ipc.invoke<string[]>('attachment:clipboard-files')
        paths.forEach(addFilePath)
      } catch (err) { console.error('Failed to read clipboard files:', err) }
    }
  }, [addImageFromDataUrl, addFilePath])

  // Drag-and-drop: images read as data URL; other files resolved to paths.
  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        try {
          const dataUrl = await readFileAsDataUrl(file)
          addImageFromDataUrl(dataUrl, file.name || 'dropped-image.png', file.type, file.size)
        } catch (err) { console.error('Failed to read dropped image:', err) }
      } else {
        // Electron exposes the absolute path on dropped File objects.
        const fp = (file as File & { path?: string }).path
        if (fp) addFilePath(fp)
      }
    }
  }, [addImageFromDataUrl, addFilePath])

  const slashCommands = useMemo(() => buildSlashCommands(models, selectedModel), [models, selectedModel])

  // Detect slash command mode
  const isCmdMode = inputText.startsWith('/') && !inputText.includes(' ')
  const cmdQuery = inputText.slice(1).toLowerCase()
  const filteredCmds = useMemo(() => {
    if (!isCmdMode) return []
    return slashCommands.filter(c => c.id.startsWith(cmdQuery) || c.label.toLowerCase().includes(cmdQuery))
  }, [isCmdMode, cmdQuery, slashCommands])

  // Reset cmdIndex when filtered list changes
  useEffect(() => {
    setCmdIndex(0)
  }, [cmdQuery])

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const firstMsgIdRef = useRef<string | undefined>(undefined)

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    const firstId = messages[0]?.id
    const switched = firstId !== firstMsgIdRef.current
    firstMsgIdRef.current = firstId
    if (switched) atBottomRef.current = true
    if (atBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: switched || isStreaming ? 'auto' : 'smooth' })
    }
  }, [messages, isStreaming])

  // Auto-grow the textarea up to its max height.
  useEffect(() => {
    const el = inputRef.current
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px' }
  }, [inputText])

  const hasAttachments = attachments.length > 0
  const canSend = (inputText.trim().length > 0 || hasAttachments) && !isStreaming && !isCmdMode

  const executeCommand = (cmd: SlashCommand) => {
    setInputText('')
    switch (cmd.id) {
      case 'model':
        setShowModelPicker(true)
        break
      case 'new':
        onNewChat()
        break
      case 'clear':
        onClearChat()
        break
      case 'help':
        setInputText('Available commands: /model, /new, /clear, /help. Shortcuts: ⌘↵ send, ⌘N new chat')
        break
    }
  }

  const handleSend = () => {
    if (!canSend) return
    const text = inputText.trim()
    const atts = attachments
    setInputText('')
    setAttachments([])
    onSend(text, atts)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command navigation
    if (isCmdMode && filteredCmds.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIndex(i => (i + 1) % filteredCmds.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIndex(i => (i - 1 + filteredCmds.length) % filteredCmds.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        executeCommand(filteredCmds[cmdIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setInputText('')
        return
      }
    }
    // Model picker navigation
    if (showModelPicker) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowModelPicker(false)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {loading && <div className="loading-bar" />}

      {/* Message stream */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-6">

          {/* Empty state */}
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center py-28 gap-5 animate-fade-in">
              {/* Logo with subtle glow */}
              <div className="relative mb-1">
                <div
                  className="absolute inset-0 rounded-2xl blur-2xl opacity-40"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), #a78bfa)', transform: 'scale(2)' }}
                />
                <div
                  className="relative w-16 h-16 rounded-2xl flex items-center justify-center"
                  style={{ background: 'linear-gradient(145deg, var(--accent-primary) 0%, #a78bfa 50%, #c084fc 100%)', boxShadow: '0 4px 24px rgba(124,91,245,0.3)' }}
                >
                  <Sparkles size={28} color="#fff" strokeWidth={1.8} />
                </div>
              </div>
              <div className="flex flex-col items-center gap-2">
                <span className="text-[17px] font-semibold" style={{ color: 'var(--fg-primary)', letterSpacing: '-0.025em' }}>
                  How can I help you today?
                </span>
                <span className="text-[13px]" style={{ color: 'var(--fg-tertiary)' }}>
                  Start coding with Claude
                </span>
              </div>
              {/* Quick action chips — minimal */}
              <div className="flex flex-wrap justify-center gap-2 mt-1">
                {['Explain code', 'Fix bugs', 'Write tests', 'Refactor'].map((s) => (
                  <button
                    key={s}
                    onClick={() => onSend(s, [])}
                    className="quick-action-chip px-3.5 py-1.5 rounded-full text-[12px] font-medium"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--fg-tertiary)',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, idx) =>
            msg.role === 'user'
              ? <UserMessage key={msg.id} msg={msg} idx={idx} />
              : <AssistantMessage key={msg.id} msg={msg} idx={idx} />
          )}

          {/* Typing indicator (only before the first token arrives) */}
          {isStreaming && (!messages.length || messages[messages.length - 1].role !== 'assistant' || !messages[messages.length - 1].content) && (
            <div className="flex gap-3 animate-fade-in">
              <div
                className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, #a855f7 100%)' }}
              >
                <Sparkles size={13} color="#fff" />
              </div>
              <div className="flex items-center gap-1.5 h-7 px-1">
                <span className="typing-dot w-2 h-2 rounded-full inline-block" style={{ background: 'var(--accent-bright)' }} />
                <span className="typing-dot w-2 h-2 rounded-full inline-block" style={{ background: 'var(--accent-bright)' }} />
                <span className="typing-dot w-2 h-2 rounded-full inline-block" style={{ background: 'var(--accent-bright)' }} />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-6 pb-5 pt-2">
        <div className="max-w-3xl mx-auto relative">
          {/* Slash command palette */}
          {isCmdMode && filteredCmds.length > 0 && (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl overflow-hidden animate-scale-in"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 30,
              }}
            >
              <div className="px-3.5 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <Zap size={11} className="text-[var(--accent-bright)]" />
                <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.08em' }}>Commands</span>
              </div>
              <div className="py-1 max-h-[240px] overflow-y-auto">
                {filteredCmds.map((cmd, i) => {
                  const Icon = cmd.icon
                  const active = i === cmdIndex
                  return (
                    <div
                      key={cmd.id}
                      onClick={() => executeCommand(cmd)}
                      onMouseEnter={() => setCmdIndex(i)}
                      className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors"
                      style={{ background: active ? 'var(--accent-subtle)' : 'transparent' }}
                    >
                      <div
                        className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                        style={{
                          background: active ? 'rgba(99,102,241,0.15)' : 'var(--bg-surface-2)',
                          color: active ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                        }}
                      >
                        <Icon size={13} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium" style={{ color: active ? 'var(--fg-primary)' : 'var(--fg-secondary)' }}>
                          /{cmd.id}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: 'var(--fg-quaternary)' }}>
                          {cmd.description}
                        </div>
                      </div>
                      {cmd.shortcut && (
                        <span
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                          style={{ color: 'var(--fg-quaternary)', background: 'var(--tint-subtle)' }}
                        >
                          {cmd.shortcut}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Model picker popover */}
          {showModelPicker && (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl overflow-hidden animate-scale-in"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 30,
              }}
            >
              <div className="px-3.5 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <Cpu size={11} className="text-[var(--accent-bright)]" />
                <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.08em' }}>Select Model</span>
              </div>
              <div className="py-1">
                {models.map((m) => {
                  const active = m.id === selectedModel
                  return (
                    <div
                      key={m.id}
                      onClick={() => { onModelSelect(m.id); setShowModelPicker(false) }}
                      className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors"
                      style={{ background: active ? 'var(--accent-subtle)' : 'transparent' }}
                    >
                      <div className="flex-1">
                        <div className="text-[12.5px] font-medium" style={{ color: active ? 'var(--accent-bright)' : 'var(--fg-secondary)' }}>
                          {m.name}
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--fg-quaternary)' }}>
                          {m.desc}
                        </div>
                      </div>
                      {active && (
                        <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-primary)' }}>
                          <span style={{ color: '#fff', fontSize: '9px', fontWeight: 700 }}>✓</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div
            className="rounded-2xl overflow-hidden transition-all"
            style={{
              background: 'var(--bg-surface)',
              border: `1px solid ${dragOver ? 'var(--accent-bright)' : focused ? 'var(--accent-primary)' : 'var(--border-default)'}`,
              boxShadow: (focused || dragOver)
                ? '0 0 0 3px rgba(124,91,245,0.10), var(--shadow-md)'
                : 'var(--shadow-sm)',
              transition: 'border-color 200ms ease, box-shadow 200ms ease',
            }}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3.5 pt-3">
                {attachments.map((att) => (
                  <AttachmentPreview key={att.id} att={att} onRemove={removeAttachment} />
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={isCmdMode ? 'Type a command…' : dragOver ? 'Drop here…' : 'Message Claude…'}
              rows={3}
              className="w-full bg-transparent resize-none outline-none px-4 pt-3.5 pb-2 text-[14px]"
              style={{ color: 'var(--fg-primary)', fontFamily: 'var(--font-sans)', maxHeight: '180px', lineHeight: '1.6' }}
            />
            <div className="flex items-center justify-between px-3.5 pb-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddFiles}
                  className="p-1.5 rounded-lg transition-colors hover:bg-[var(--tint-hover)]"
                  style={{ color: 'var(--fg-tertiary)' }}
                  title="Attach files"
                >
                  <Paperclip size={14} />
                </button>
                <button
                  onClick={handleAddImages}
                  className="p-1.5 rounded-lg transition-colors hover:bg-[var(--tint-hover)]"
                  style={{ color: 'var(--fg-tertiary)' }}
                  title="Attach images"
                >
                  <ImageIcon size={14} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                {inputText.length > 0 && (
                  <span className="text-[11px] tabular-nums font-medium" style={{ color: 'var(--fg-quaternary)' }}>
                    {inputText.length}
                  </span>
                )}
                {isStreaming ? (
                  <button
                    onClick={onStop}
                    className="h-8 w-8 rounded-xl flex items-center justify-center transition-all"
                    style={{ background: 'var(--danger)', color: '#fff', boxShadow: '0 2px 8px rgba(255,69,58,0.35)' }}
                    title="Stop generating"
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="h-8 w-8 rounded-xl flex items-center justify-center transition-all"
                    style={canSend
                      ? {
                          background: 'linear-gradient(135deg, var(--accent-primary) 0%, #6b4de6 100%)',
                          color: '#fff',
                          boxShadow: '0 2px 10px rgba(124,91,245,0.35)',
                        }
                      : {
                          background: 'var(--bg-surface-2)',
                          color: 'var(--fg-quaternary)',
                          cursor: 'not-allowed',
                        }
                    }
                    title="Send message"
                  >
                    <ArrowUp size={15} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
