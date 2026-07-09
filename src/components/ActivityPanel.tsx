/**
 * ActivityPanel — 实时展示 Claude Code 的工具调用、文件变更、diff。
 *
 * 订阅 session-event IPC push 通道，按时间顺序展示结构化事件。
 * 这是"混合模式"的核心 GUI 面板：终端保留完整交互，此面板同步展示结构化数据。
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Terminal, FileEdit, FilePlus, FileText, FolderSearch, GitBranch,
  ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Brain,
  MessageSquare, Loader2, Wrench, Eye, EyeOff
} from 'lucide-react'
import { ipc } from '../lib/ipc'

// ---------------------------------------------------------------------------
// Types — 与主进程 session-watcher.ts 对齐
// ---------------------------------------------------------------------------

interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface SessionEvent {
  type: 'tool_use' | 'tool_result' | 'thinking' | 'text' | 'user_message' | 'meta'
  sessionId: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  stdout?: string
  stderr?: string
  diff?: DiffHunk[]
  filePath?: string
  isError?: boolean
  content?: string
  permissionMode?: string
  gitBranch?: string
  cwd?: string
  model?: string
}

// ---------------------------------------------------------------------------
// Tool icon mapping
// ---------------------------------------------------------------------------

function getToolIcon(toolName: string) {
  const lower = toolName.toLowerCase()
  if (lower === 'edit' || lower === 'multiedit') return FileEdit
  if (lower === 'write') return FilePlus
  if (lower === 'read') return FileText
  if (lower === 'glob' || lower === 'grep') return FolderSearch
  if (lower === 'bash') return Terminal
  if (lower === 'git') return GitBranch
  return Wrench
}

function getToolColor(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower === 'edit' || lower === 'multiedit' || lower === 'write') return 'var(--accent-bright)'
  if (lower === 'bash') return 'var(--warn)'
  if (lower === 'read' || lower === 'glob' || lower === 'grep') return 'var(--fg-tertiary)'
  return 'var(--fg-secondary)'
}

// ---------------------------------------------------------------------------
// Diff renderer
// ---------------------------------------------------------------------------

function DiffView({ diff }: { diff: DiffHunk[] }) {
  const [expanded, setExpanded] = useState(true)
  const totalAdd = diff.reduce((acc, h) => acc + h.lines.filter(l => l.startsWith('+')).length, 0)
  const totalDel = diff.reduce((acc, h) => acc + h.lines.filter(l => l.startsWith('-')).length, 0)

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1.5 text-[10px] font-medium transition-colors hover:text-[var(--fg-secondary)]"
        style={{ color: 'var(--fg-tertiary)' }}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span style={{ color: 'var(--success)' }}>+{totalAdd}</span>
        <span style={{ color: 'var(--danger)' }}>-{totalDel}</span>
        <span>{diff.length} hunk{diff.length > 1 ? 's' : ''}</span>
      </button>
      {expanded && (
        <div
          className="mt-1.5 rounded-lg overflow-auto"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border-subtle)',
            maxHeight: '300px',
          }}
        >
          <pre className="text-[10px] leading-[1.5] p-2.5 font-mono overflow-x-auto">
            {diff.map((hunk, hi) => (
              <div key={hi}>
                <div style={{ color: 'var(--fg-quaternary)' }} className="select-none">
                  {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                </div>
                {hunk.lines.map((line, li) => (
                  <div
                    key={li}
                    className="whitespace-pre"
                    style={{
                      color: line.startsWith('+') ? 'var(--success)' :
                             line.startsWith('-') ? 'var(--danger)' :
                             'var(--fg-secondary)',
                      background: line.startsWith('+') ? 'rgba(48,209,88,0.06)' :
                                  line.startsWith('-') ? 'rgba(255,69,58,0.06)' :
                                  'transparent',
                    }}
                  >
                    {line}
                  </div>
                ))}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Event item renderer
// ---------------------------------------------------------------------------

interface EventItemProps {
  event: SessionEvent
  // 关联的 tool_result（如果此 event 是 tool_use）
  result?: SessionEvent
}

function EventItem({ event, result }: EventItemProps) {
  const [expanded, setExpanded] = useState(false)

  const time = new Date(event.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })

  if (event.type === 'user_message') {
    return (
      <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded-lg" style={{ background: 'rgba(124,91,245,0.04)' }}>
        <div className="flex items-center gap-1.5">
          <MessageSquare size={10} style={{ color: 'var(--accent-bright)' }} />
          <span className="text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>{time}</span>
        </div>
        <div className="text-[11px] leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
          {(event.content || '').slice(0, 200)}
          {(event.content || '').length > 200 && '...'}
        </div>
      </div>
    )
  }

  if (event.type === 'text') {
    return (
      <div className="flex flex-col gap-0.5 py-1.5 px-2.5">
        <div className="flex items-center gap-1.5">
          <MessageSquare size={10} style={{ color: 'var(--fg-tertiary)' }} />
          <span className="text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>{time}</span>
        </div>
        <div className="text-[11px] leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
          {(event.content || '').slice(0, 300)}
          {(event.content || '').length > 300 && (
            <button onClick={() => setExpanded(v => !v)} className="ml-1 text-[10px] underline" style={{ color: 'var(--accent-bright)' }}>
              {expanded ? 'less' : 'more'}
            </button>
          )}
        </div>
        {expanded && (event.content || '').length > 300 && (
          <div className="text-[11px] leading-relaxed mt-0.5" style={{ color: 'var(--fg-secondary)' }}>
            {event.content}
          </div>
        )}
      </div>
    )
  }

  if (event.type === 'thinking') {
    return (
      <div className="flex flex-col gap-0.5 py-1 px-2.5">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 text-left"
        >
          {expanded ? <ChevronDown size={10} style={{ color: 'var(--fg-quaternary)' }} /> : <ChevronRight size={10} style={{ color: 'var(--fg-quaternary)' }} />}
          <Brain size={10} style={{ color: 'var(--fg-quaternary)' }} />
          <span className="text-[10px] italic" style={{ color: 'var(--fg-quaternary)' }}>thinking</span>
          <span className="text-[10px]" style={{ color: 'var(--fg-quaternary)' }}>{time}</span>
        </button>
        {expanded && (
          <div className="text-[10.5px] italic leading-relaxed pl-5 mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>
            {(event.content || '').slice(0, 500)}
            {(event.content || '').length > 500 && '...'}
          </div>
        )}
      </div>
    )
  }

  if (event.type === 'tool_use') {
    const Icon = getToolIcon(event.toolName || '')
    const color = getToolColor(event.toolName || '')
    const input = event.toolInput || {}
    const filePath = (input.file_path || input.path) as string | undefined
    const command = (input.command) as string | undefined
    const pattern = (input.pattern) as string | undefined

    return (
      <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.015)' }}>
        <div className="flex items-center gap-1.5">
          <Icon size={11} style={{ color }} />
          <span className="text-[10.5px] font-semibold" style={{ color: 'var(--fg-secondary)' }}>
            {event.toolName}
          </span>
          <span className="text-[10px]" style={{ color: 'var(--fg-quaternary)' }}>{time}</span>
          {result && (
            result.isError
              ? <AlertCircle size={10} style={{ color: 'var(--danger)' }} />
              : <CheckCircle2 size={10} style={{ color: 'var(--success)' }} />
          )}
          {result === undefined && (
            <Loader2 size={10} className="animate-spin" style={{ color: 'var(--fg-quaternary)' }} />
          )}
        </div>
        {/* 工具参数摘要 */}
        {filePath && (
          <div className="text-[10px] font-mono truncate pl-4" style={{ color: 'var(--fg-tertiary)' }}>
            {filePath}
          </div>
        )}
        {command && (
          <div className="text-[10px] font-mono truncate pl-4" style={{ color: 'var(--fg-tertiary)' }}>
            $ {command.slice(0, 120)}{command.length > 120 ? '...' : ''}
          </div>
        )}
        {pattern && (
          <div className="text-[10px] font-mono pl-4" style={{ color: 'var(--fg-tertiary)' }}>
            pattern: {pattern}
          </div>
        )}
        {/* Diff 预览 */}
        {result?.diff && result.diff.length > 0 && (
          <DiffView diff={result.diff} />
        )}
        {/* Bash 输出 */}
        {result?.stdout && event.toolName === 'Bash' && (
          <div className="mt-1">
            <button
              onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-1 text-[10px]"
              style={{ color: 'var(--fg-tertiary)' }}
            >
              {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <span>output ({result.stdout.length} chars)</span>
            </button>
            {expanded && (
              <div
                className="mt-1 rounded-lg overflow-auto"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', maxHeight: '200px' }}
              >
                <pre className="text-[10px] leading-[1.4] p-2 font-mono overflow-x-auto" style={{ color: 'var(--fg-secondary)' }}>
                  {result.stdout.slice(0, 2000)}
                  {result.stdout.length > 2000 ? '\n...' : ''}
                </pre>
              </div>
            )}
          </div>
        )}
        {/* 错误输出 */}
        {result?.isError && result?.stderr && (
          <div className="mt-1 rounded-lg p-2" style={{ background: 'rgba(255,69,58,0.06)', border: '1px solid rgba(255,69,58,0.12)' }}>
            <pre className="text-[10px] font-mono overflow-x-auto" style={{ color: 'var(--danger)' }}>
              {result.stderr.slice(0, 500)}
            </pre>
          </div>
        )}
      </div>
    )
  }

  // tool_result 单独出现（没有对应 tool_use）— 折叠显示
  if (event.type === 'tool_result') {
    return null
  }

  return null
}

// ---------------------------------------------------------------------------
// ActivityPanel main component
// ---------------------------------------------------------------------------

interface ActivityPanelProps {
  /** Conversation ID（用于 IPC 通道匹配） */
  convId: string | null
  /** Claude session ID */
  sessionId: string | null
  /** 项目工作目录 */
  cwd: string | null
}

export default function ActivityPanel({ convId, sessionId, cwd }: ActivityPanelProps) {
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [showThinking, setShowThinking] = useState(true)
  const [showText, setShowText] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // 加载已有事件 + 订阅新事件
  useEffect(() => {
    if (!convId) {
      setEvents([])
      return
    }

    // 加载已有事件（回放历史）
    if (sessionId && cwd) {
      ipc.invoke<{ events: SessionEvent[] }>('session-watcher:get-events', { id: convId })
        .then(res => {
          if (res?.events) setEvents(res.events)
        })
        .catch(() => {})
    }

    // 订阅新事件
    const unsub = ipc.on('session-event', (data: { id: string; event: SessionEvent }) => {
      if (data.id !== convId) return
      setEvents(prev => [...prev, data.event])
    })

    return () => {
      unsub()
      setEvents([])
    }
  }, [convId, sessionId, cwd])

  // 自动滚动到底部
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50
  }, [])

  // 将 tool_use 和 tool_result 配对
  const pairedEvents = useCallback(() => {
    const resultMap = new Map<string, SessionEvent>()
    for (const e of events) {
      if (e.type === 'tool_result' && e.toolUseId) {
        resultMap.set(e.toolUseId, e)
      }
    }
    const result: { event: SessionEvent; result?: SessionEvent }[] = []
    for (const e of events) {
      if (e.type === 'tool_result') continue // tool_result 已配对到 tool_use
      if (e.type === 'thinking' && !showThinking) continue
      if (e.type === 'text' && !showText) continue
      if (e.type === 'tool_use' && e.toolUseId) {
        result.push({ event: e, result: resultMap.get(e.toolUseId) })
      } else {
        result.push({ event: e })
      }
    }
    return result
  }, [events, showThinking, showText])

  const paired = pairedEvents()

  // 统计
  const toolCount = events.filter(e => e.type === 'tool_use').length
  const fileChanges = events.filter(
    e => e.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit'].includes(e.toolName || '')
  ).length
  const errors = events.filter(e => e.type === 'tool_result' && e.isError).length

  if (!convId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Wrench size={18} style={{ color: 'var(--fg-quaternary)' }} />
          <span className="text-[11px]" style={{ color: 'var(--fg-tertiary)' }}>No active session</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 统计栏 */}
      <div
        className="flex items-center gap-3 px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center gap-1.5">
          <Wrench size={11} style={{ color: 'var(--accent-bright)' }} />
          <span className="text-[10px] font-medium" style={{ color: 'var(--fg-secondary)' }}>{toolCount} tools</span>
        </div>
        {fileChanges > 0 && (
          <div className="flex items-center gap-1.5">
            <FileEdit size={11} style={{ color: 'var(--accent-bright)' }} />
            <span className="text-[10px] font-medium" style={{ color: 'var(--fg-secondary)' }}>{fileChanges} files</span>
          </div>
        )}
        {errors > 0 && (
          <div className="flex items-center gap-1.5">
            <AlertCircle size={11} style={{ color: 'var(--danger)' }} />
            <span className="text-[10px] font-medium" style={{ color: 'var(--danger)' }}>{errors} errors</span>
          </div>
        )}
        <div className="flex-1" />
        {/* 过滤按钮 */}
        <button
          onClick={() => setShowThinking(v => !v)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors"
          style={{
            background: showThinking ? 'var(--accent-subtle)' : 'transparent',
            color: showThinking ? 'var(--accent-bright)' : 'var(--fg-quaternary)',
          }}
          title="Toggle thinking blocks"
        >
          {showThinking ? <Eye size={10} /> : <EyeOff size={10} />}
          <span>Think</span>
        </button>
        <button
          onClick={() => setShowText(v => !v)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors"
          style={{
            background: showText ? 'var(--accent-subtle)' : 'transparent',
            color: showText ? 'var(--accent-bright)' : 'var(--fg-quaternary)',
          }}
          title="Toggle text blocks"
        >
          {showText ? <Eye size={10} /> : <EyeOff size={10} />}
          <span>Text</span>
        </button>
      </div>

      {/* 事件列表 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-1"
      >
        {paired.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--fg-quaternary)' }} />
            <span className="text-[11px]" style={{ color: 'var(--fg-quaternary)' }}>
              {sessionId ? 'Waiting for activity...' : 'No session ID yet'}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {paired.map((item, i) => (
              <EventItem key={i} event={item.event} result={item.result} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
