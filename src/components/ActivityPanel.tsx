/**
 * ActivityPanel — Apple-style timeline showing tool calls, file changes, and thinking.
 *
 * Subscribes to both session-event (legacy) and agent:event (Agent SDK) IPC channels.
 * Displays events as a vertical timeline with Apple HIG design principles.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Terminal, FileEdit, FilePlus, FileText, FolderSearch, GitBranch,
  ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Brain,
  MessageSquare, Loader2, Wrench, Eye, EyeOff
} from 'lucide-react'
import { ipc, Channels } from '../lib/ipc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface SessionEvent {
  type: 'tool_use' | 'tool_result' | 'thinking' | 'text' | 'user_message' | 'meta' | 'file_changed'
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
// Tool helpers
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

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

// ---------------------------------------------------------------------------
// Timeline node
// ---------------------------------------------------------------------------

interface TimelineNodeProps {
  event: SessionEvent
  result?: SessionEvent
  isLast: boolean
}

function TimelineNode({ event, result, isLast }: TimelineNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const time = formatTime(event.timestamp)

  if (event.type === 'user_message') {
    return (
      <div className="flex gap-3" style={{ paddingBottom: isLast ? 0 : 4 }}>
        {/* Timeline rail */}
        <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--accent-primary)',
            boxShadow: '0 0 6px rgba(124,91,245,0.3)',
          }} />
          {!isLast && <div className="flex-1" style={{ width: 1, background: 'var(--border-subtle)' }} />}
        </div>
        {/* Content */}
        <div className="flex-1 pb-3 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <MessageSquare size={10} style={{ color: 'var(--accent-bright)' }} />
            <span className="text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>{time}</span>
          </div>
          <div className="text-[11px] leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
            {(event.content || '').slice(0, 200)}
            {(event.content || '').length > 200 && '...'}
          </div>
        </div>
      </div>
    )
  }

  if (event.type === 'thinking') {
    return (
      <div className="flex gap-3" style={{ paddingBottom: isLast ? 0 : 4 }}>
        <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'var(--fg-quaternary)',
            opacity: 0.5,
          }} />
          {!isLast && <div className="flex-1" style={{ width: 1, background: 'var(--border-subtle)' }} />}
        </div>
        <div className="flex-1 pb-2 min-w-0">
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-2 text-left w-full"
          >
            {expanded ? <ChevronDown size={9} style={{ color: 'var(--fg-quaternary)' }} /> : <ChevronRight size={9} style={{ color: 'var(--fg-quaternary)' }} />}
            <Brain size={10} style={{ color: 'var(--fg-quaternary)' }} />
            <span className="text-[10px] italic" style={{ color: 'var(--fg-quaternary)' }}>thinking</span>
            <span className="text-[10px]" style={{ color: 'var(--fg-quaternary)' }}>{time}</span>
          </button>
          {expanded && (
            <div
              className="text-[10.5px] italic leading-relaxed mt-1"
              style={{
                paddingLeft: 12,
                borderLeft: '2px solid var(--border-subtle)',
                color: 'var(--fg-tertiary)',
              }}
            >
              {(event.content || '').slice(0, 500)}
              {(event.content || '').length > 500 && '...'}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (event.type === 'text') {
    return (
      <div className="flex gap-3" style={{ paddingBottom: isLast ? 0 : 4 }}>
        <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'var(--fg-tertiary)',
            opacity: 0.4,
          }} />
          {!isLast && <div className="flex-1" style={{ width: 1, background: 'var(--border-subtle)' }} />}
        </div>
        <div className="flex-1 pb-2 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
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
    const isRunning = !result
    const hasError = result?.isError

    return (
      <div className="flex gap-3" style={{ paddingBottom: isLast ? 0 : 4 }}>
        {/* Timeline rail */}
        <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: hasError ? 'rgba(255,69,58,0.15)' : isRunning ? 'var(--accent-subtle)' : 'rgba(48,209,88,0.1)',
            border: `1.5px solid ${hasError ? 'var(--danger)' : isRunning ? 'var(--accent-primary)' : 'var(--success)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {isRunning ? (
              <Loader2 size={6} className="animate-spin" style={{ color: 'var(--accent-primary)' }} />
            ) : hasError ? (
              <AlertCircle size={6} style={{ color: 'var(--danger)' }} />
            ) : (
              <CheckCircle2 size={6} style={{ color: 'var(--success)' }} />
            )}
          </div>
          {!isLast && <div className="flex-1" style={{ width: 1, background: 'var(--border-subtle)' }} />}
        </div>
        {/* Content card */}
        <div
          className="flex-1 pb-3 min-w-0 rounded-lg cursor-pointer transition-colors"
          style={{
            background: 'rgba(255,255,255,0.015)',
            padding: '6px 8px',
          }}
          onClick={() => setExpanded(v => !v)}
        >
          <div className="flex items-center gap-2">
            <Icon size={11} style={{ color, flexShrink: 0 }} />
            <span className="text-[11px] font-semibold font-mono" style={{ color: 'var(--fg-secondary)' }}>
              {event.toolName}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--fg-quaternary)' }}>{time}</span>
          </div>
          {/* Compact summary */}
          {filePath && (
            <div className="text-[10px] font-mono truncate mt-0.5" style={{ color: 'var(--fg-tertiary)', paddingLeft: 4 }}>
              {filePath}
            </div>
          )}
          {command && (
            <div className="text-[10px] font-mono truncate mt-0.5" style={{ color: 'var(--fg-tertiary)', paddingLeft: 4 }}>
              $ {command.slice(0, 80)}{command.length > 80 ? '...' : ''}
            </div>
          )}
          {pattern && (
            <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--fg-tertiary)', paddingLeft: 4 }}>
              pattern: {pattern}
            </div>
          )}
          {/* Expanded details */}
          {expanded && (
            <div className="mt-2">
              {/* Diff */}
              {result?.diff && result.diff.length > 0 && (
                <DiffTimelineView diff={result.diff} />
              )}
              {/* Bash output */}
              {result?.stdout && event.toolName === 'Bash' && (
                <div
                  className="rounded-lg overflow-auto"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', maxHeight: '160px' }}
                >
                  <pre className="text-[10px] leading-[1.4] p-2 font-mono overflow-x-auto" style={{ color: 'var(--fg-secondary)' }}>
                    {result.stdout.slice(0, 2000)}
                    {result.stdout.length > 2000 ? '\n...' : ''}
                  </pre>
                </div>
              )}
              {/* Error */}
              {hasError && result?.stderr && (
                <div className="rounded-lg p-2" style={{ background: 'rgba(255,69,58,0.06)', border: '1px solid rgba(255,69,58,0.12)' }}>
                  <pre className="text-[10px] font-mono overflow-x-auto" style={{ color: 'var(--danger)' }}>
                    {result.stderr.slice(0, 500)}
                  </pre>
                </div>
              )}
              {/* Full input JSON */}
              <div className="mt-1.5">
                <div className="text-[9px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.06em' }}>Input</div>
                <div
                  className="rounded-lg overflow-auto mt-0.5"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', maxHeight: '100px' }}
                >
                  <pre className="text-[9px] leading-[1.3] p-2 font-mono overflow-x-auto" style={{ color: 'var(--fg-tertiary)' }}>
                    {JSON.stringify(input, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Compact diff view for timeline
// ---------------------------------------------------------------------------

function DiffTimelineView({ diff }: { diff: DiffHunk[] }) {
  const totalAdd = diff.reduce((acc, h) => acc + h.lines.filter(l => l.startsWith('+')).length, 0)
  const totalDel = diff.reduce((acc, h) => acc + h.lines.filter(l => l.startsWith('-')).length, 0)

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-medium" style={{ color: 'var(--success)' }}>+{totalAdd}</span>
        <span className="text-[10px] font-medium" style={{ color: 'var(--danger)' }}>-{totalDel}</span>
      </div>
      <div
        className="rounded-lg overflow-auto"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', maxHeight: '200px' }}
      >
        <pre className="text-[10px] leading-[1.5] p-2 font-mono overflow-x-auto">
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
                    borderLeft: line.startsWith('+') ? '3px solid var(--success)' :
                                line.startsWith('-') ? '3px solid var(--danger)' :
                                '3px solid transparent',
                    paddingLeft: 4,
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ActivityPanel main component
// ---------------------------------------------------------------------------

interface ActivityPanelProps {
  convId: string | null
  sessionId: string | null
  cwd: string | null
}

export default function ActivityPanel({ convId, sessionId, cwd }: ActivityPanelProps) {
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [showThinking, setShowThinking] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // Load existing events + subscribe to new ones
  useEffect(() => {
    if (!convId) {
      setEvents([])
      return
    }

    // Load existing events (replay history)
    if (sessionId && cwd) {
      ipc.invoke<{ events: SessionEvent[] }>('session-watcher:get-events', { id: convId })
        .then(res => {
          if (res?.events) setEvents(res.events)
        })
        .catch((err) => console.error('[ActivityPanel]', err))
    }

    // Subscribe to legacy session events
    const unsub = ipc.on('session-event', (data: { id: string; event: SessionEvent }) => {
      if (data.id !== convId) return
      setEvents(prev => [...prev, data.event])
    })

    // Subscribe to Agent SDK events
    const unsubAgent = ipc.on(Channels.AGENT_EVENT, (data: { convId: string; event: Record<string, unknown> }) => {
      if (data.convId !== convId) return
      const e = data.event
      if (e.type === 'tool_use') {
        setEvents(prev => [...prev, {
          type: 'tool_use',
          sessionId: (e.sessionId as string) || '',
          timestamp: new Date(e.timestamp as number).toISOString(),
          toolName: e.toolName as string,
          toolInput: e.input as Record<string, unknown>,
          toolUseId: e.toolUseId as string,
        }])
      } else if (e.type === 'tool_result') {
        setEvents(prev => [...prev, {
          type: 'tool_result',
          sessionId: (e.sessionId as string) || '',
          timestamp: new Date(e.timestamp as number).toISOString(),
          toolName: e.toolName as string,
          toolUseId: e.toolUseId as string,
          stdout: e.content as string,
          isError: e.isError as boolean,
          diff: e.diff as DiffHunk[],
          filePath: e.filePath as string,
        }])
      } else if (e.type === 'thinking') {
        setEvents(prev => [...prev, {
          type: 'thinking',
          sessionId: (e.sessionId as string) || '',
          timestamp: new Date(e.timestamp as number).toISOString(),
          content: e.text as string,
        }])
      } else if (e.type === 'text') {
        setEvents(prev => [...prev, {
          type: 'text',
          sessionId: (e.sessionId as string) || '',
          timestamp: new Date(e.timestamp as number).toISOString(),
          content: e.text as string,
        }])
      } else if (e.type === 'file_changed') {
        setEvents(prev => [...prev, {
          type: 'file_changed',
          sessionId: (e.sessionId as string) || '',
          timestamp: new Date(e.timestamp as number).toISOString(),
          filePath: e.filePath as string,
          toolName: e.tool as string,
        }])
      }
    })

    return () => {
      unsub()
      unsubAgent()
      setEvents([])
    }
  }, [convId, sessionId, cwd])

  // Auto-scroll
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

  // Pair tool_use with tool_result
  const paired = useMemo(() => {
    const resultMap = new Map<string, SessionEvent>()
    for (const e of events) {
      if (e.type === 'tool_result' && e.toolUseId) {
        resultMap.set(e.toolUseId, e)
      }
    }
    const result: { event: SessionEvent; result?: SessionEvent }[] = []
    for (const e of events) {
      if (e.type === 'tool_result') continue
      if (e.type === 'thinking' && !showThinking) continue
      if (e.type === 'file_changed') continue // shown in file changes section
      if (e.type === 'tool_use' && e.toolUseId) {
        result.push({ event: e, result: resultMap.get(e.toolUseId) })
      } else {
        result.push({ event: e })
      }
    }
    return result
  }, [events, showThinking])

  // Stats
  const toolCount = events.filter(e => e.type === 'tool_use').length
  const changedFiles = useMemo(() => {
    const files = new Map<string, string>() // path -> tool
    for (const e of events) {
      if (e.type === 'file_changed' && e.filePath) {
        files.set(e.filePath, e.toolName || 'Edit')
      }
      if (e.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit'].includes(e.toolName || '')) {
        const fp = (e.toolInput?.file_path || e.toolInput?.filePath) as string
        if (fp) files.set(fp, e.toolName || 'Edit')
      }
    }
    return Array.from(files.entries())
  }, [events])
  const errors = events.filter(e => e.type === 'tool_result' && e.isError).length

  // Empty state
  if (!convId) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-2">
          <Wrench size={18} style={{ color: 'var(--fg-quaternary)' }} />
          <span className="text-[12px]" style={{ color: 'var(--fg-quaternary)' }}>No active session</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      {/* Stats bar — Apple style */}
      <div
        className="flex items-center gap-3 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span className="text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>
          Tools: {toolCount}
        </span>
        {changedFiles.length > 0 && (
          <span className="text-[10px]" style={{ color: 'var(--fg-quaternary)' }}>
            · Files: {changedFiles.length}
          </span>
        )}
        {errors > 0 && (
          <span className="text-[10px]" style={{ color: 'var(--danger)' }}>
            · Errors: {errors}
          </span>
        )}
        <div className="flex-1" />
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
      </div>

      {/* Timeline */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-3"
      >
        {paired.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <div className="text-[12px]" style={{ color: 'var(--fg-quaternary)' }}>No activity yet</div>
          </div>
        ) : (
          <div className="flex flex-col">
            {paired.map((item, i) => (
              <TimelineNode
                key={i}
                event={item.event}
                result={item.result}
                isLast={i === paired.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* File changes — fixed at bottom */}
      {changedFiles.length > 0 && (
        <div
          className="flex-shrink-0 px-4 py-2"
          style={{
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
            maxHeight: '120px',
            overflowY: 'auto',
          }}
        >
          <div className="text-[9px] font-semibold uppercase mb-1.5" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.06em' }}>
            Changed Files
          </div>
          <div className="flex flex-col gap-0.5">
            {changedFiles.map(([filePath, tool]) => {
              const fileName = filePath.split('/').pop() || filePath
              const dirPath = filePath.substring(0, filePath.length - fileName.length)
              return (
                <div key={filePath} className="flex items-center gap-1.5 py-0.5">
                  <FileText size={10} style={{ color: 'var(--accent-bright)', flexShrink: 0 }} />
                  <span className="text-[10px] font-mono truncate" style={{ color: 'var(--fg-secondary)' }}>
                    {fileName}
                  </span>
                  <span className="text-[9px] font-mono truncate flex-1" style={{ color: 'var(--fg-quaternary)' }}>
                    {dirPath}
                  </span>
                  <span className="text-[9px] font-mono flex-shrink-0" style={{ color: 'var(--fg-quaternary)' }}>
                    {tool}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
