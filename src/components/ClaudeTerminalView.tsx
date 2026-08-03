/**
 * ClaudeTerminalView — 嵌入式 Claude Code 交互式终端。
 *
 * 使用 xterm.js 渲染真正的伪终端，后端为交互式 `claude` 进程
 * （不带 -p 标志），完整保留 Claude Code 的 TUI 体验：
 *   - 斜杠命令（/model, /clear, /help 等）
 *   - 权限提示交互
 *   - 工具调用（Bash, Edit, Read, Write, git push 等）
 *   - 流式输出、思考过程
 *   - 所有 Claude Code CLI 能力
 *
 * 这是与终端体验"毫无差异"的 GUI 交互——因为它就是终端中的 Claude Code，
 * 只是被嵌入到了 GUI 窗口中。
 *
 * 改进：
 * - 仅在 mount 时创建 PTY（props 变化不重建）
 * - 自动捕获 claudeSessionId（用于 --resume）
 * - 终端内搜索（Cmd+F）
 * - 清屏按钮
 * - 新会话快捷操作提示
 * - 粘贴支持
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { ipc } from '../lib/ipc'
import {
  Square, RotateCcw, Terminal as TerminalIcon, Loader2, AlertCircle,
  Search, X, Trash2, ChevronUp, ChevronDown, Zap, ShieldCheck, ShieldOff,
} from 'lucide-react'

export interface ClaudeTerminalViewProps {
  /** 会话 ID（通常是 conversation ID） */
  sessionId: string
  /** 工作目录（项目路径） */
  cwd: string
  /** 模型 */
  model?: string
  /** Claude 会话 ID（用于 --resume） */
  resumeSessionId?: string | null
  /** 权限模式 */
  permissionMode?: string
  /** 额外目录 */
  addDirs?: string[]
  /** 会话 ID 捕获回调 */
  onSessionIdCaptured?: (sessionId: string) => void
}

interface ClaudeTerminalState {
  status: 'idle' | 'creating' | 'active' | 'exited' | 'error'
  exitCode?: number
  error?: string
}

export default function ClaudeTerminalView(props: ClaudeTerminalViewProps) {
  const { sessionId, cwd, model, resumeSessionId, permissionMode, addDirs, onSessionIdCaptured } = props

  const [state, setState] = useState<ClaudeTerminalState>({ status: 'idle' })
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [permission, setPermission] = useState<{ text: string; options: string[] } | null>(null)
  const [isFocused, setIsFocused] = useState(false)

  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const unsubDataRef = useRef<(() => void) | null>(null)
  const unsubExitRef = useRef<(() => void) | null>(null)
  const unsubPermissionRef = useRef<(() => void) | null>(null)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // Store initial props in refs — these are only used at creation time
  // and should NOT trigger session recreation when they change
  const initialPropsRef = useRef({
    cwd, model, resumeSessionId, permissionMode, addDirs,
  })
  // Update ref but don't use it for re-creation
  initialPropsRef.current = { cwd, model, resumeSessionId, permissionMode, addDirs }

  // Session ID capture timer
  const sessionCaptureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Delayed kill timer (StrictMode fix: cancel if remounted within delay)
  const killTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Capture claude session ID by scanning ~/.claude/projects/ */
  const captureSessionId = useCallback(async () => {
    try {
      const result = await ipc.invoke<{ sessionId: string | null }>(
        'claude-pty:get-session-id',
        { cwd: initialPropsRef.current.cwd },
      )
      if (result?.sessionId && onSessionIdCaptured) {
        onSessionIdCaptured(result.sessionId)
      }
    } catch {
      // ignore
    }
  }, [onSessionIdCaptured])

  /** Create Claude PTY session — only called once on mount */
  const createSession = useCallback(async () => {
    if (!containerRef.current) return

    // Cancel any pending kill (StrictMode remount)
    if (killTimerRef.current) {
      clearTimeout(killTimerRef.current)
      killTimerRef.current = null
    }

    // Clean up old terminal instance
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
    }
    if (unsubDataRef.current) { unsubDataRef.current(); unsubDataRef.current = null }
    if (unsubExitRef.current) { unsubExitRef.current(); unsubExitRef.current = null }

    const id = sessionIdRef.current

    // Check if PTY is already active (React StrictMode double-mount fix)
    let ptyAlreadyActive = false
    try {
      const result = await ipc.invoke<{ active: boolean }>('claude-pty:is-active', { id })
      ptyAlreadyActive = result?.active ?? false
    } catch {
      // ignore
    }

    if (ptyAlreadyActive) {
      // PTY already running from previous mount (StrictMode), just resubscribe
      setState({ status: 'active' })
    } else {
      setState({ status: 'creating' })
    }

    // Create xterm instance
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'SF Mono', 'JetBrains Mono', 'Menlo', 'Monaco', monospace",
      theme: {
        background: '#0c0c10',
        foreground: '#e0e0e0',
        cursor: '#7c5bf5',
        cursorAccent: '#0c0c10',
        selectionBackground: 'rgba(124, 91, 245, 0.3)',
        black: '#1e1e2e', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
        blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#cdd6f4',
        brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5', brightWhite: '#a6adc8',
      },
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(new WebLinksAddon())

    terminal.open(containerRef.current)
    // Delay fit to ensure container has been laid out
    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch {}
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // Listen for PTY output
    const unsubData = ipc.on('claude-pty:data', (payload: { id: string; data: string }) => {
      if (payload.id === id) {
        terminal.write(payload.data)
        // Hide help overlay once user starts interacting
        setShowHelp(false)
      }
    })
    unsubDataRef.current = unsubData

    // Listen for PTY exit
    const unsubExit = ipc.on('claude-pty:exit', (payload: { id: string; exitCode: number }) => {
      if (payload.id === id) {
        terminal.write(`\r\n\x1b[90m[Claude Code session exited with code ${payload.exitCode}]\x1b[0m\r\n`)
        setState({ status: 'exited', exitCode: payload.exitCode })
        // Final session ID capture on exit
        captureSessionId()
        // Stop periodic capture
        if (sessionCaptureTimerRef.current) {
          clearInterval(sessionCaptureTimerRef.current)
          sessionCaptureTimerRef.current = null
        }
      }
    })
    unsubExitRef.current = unsubExit

    // Listen for permission prompts
    const unsubPermission = ipc.on('claude-pty:permission', (payload: { id: string; text: string; options: string[] }) => {
      if (payload.id === id) {
        setPermission({ text: payload.text, options: payload.options })
      }
    })
    unsubPermissionRef.current = unsubPermission

    // User input → PTY
    terminal.onData((data: string) => {
      ipc.invoke('claude-pty:write', { id, data }).catch(() => {})
      setShowHelp(false)
    })

    // Focus management — track focus state and restore on click
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      // Cmd+F / Ctrl+F → toggle search
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        if (event.type === 'keydown') {
          setShowSearch(s => !s)
        }
        return false
      }
      // Cmd+K / Ctrl+K → clear terminal scrollback
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        if (event.type === 'keydown') {
          terminal.clear()
        }
        return false
      }
      return true
    })

    // Track focus/blur for visual indicator using DOM events
    // xterm.js creates a hidden textarea for keyboard capture
    const xtermTextarea = containerRef.current?.querySelector('textarea')
    if (xtermTextarea) {
      xtermTextarea.addEventListener('focus', () => setIsFocused(true))
      xtermTextarea.addEventListener('blur', () => setIsFocused(false))
    }

    // Create backend PTY — only if not already active (StrictMode fix)
    if (!ptyAlreadyActive) {
      const initProps = initialPropsRef.current
      try {
        const result = await ipc.invoke<{ ok: boolean; error?: string }>('claude-pty:create', {
          id,
          cwd: initProps.cwd,
          model: initProps.model || 'default',
          resumeSessionId: initProps.resumeSessionId || undefined,
          permissionMode: initProps.permissionMode || 'ask',
          addDirs: initProps.addDirs || undefined,
        })
        if (!result?.ok) {
          terminal.write(`\x1b[31mFailed to start Claude Code: ${result?.error}\x1b[0m\r\n`)
          setState({ status: 'error', error: result?.error })
          return
        }
        setState({ status: 'active' })

        // Start periodic session ID capture (every 5 seconds for first 30 seconds)
        if (!initProps.resumeSessionId) {
          let attempts = 0
          sessionCaptureTimerRef.current = setInterval(() => {
            attempts++
            captureSessionId()
            if (attempts >= 6) {
              if (sessionCaptureTimerRef.current) {
                clearInterval(sessionCaptureTimerRef.current)
                sessionCaptureTimerRef.current = null
              }
            }
          }, 5000)
        }
      } catch (err) {
        const msg = (err as Error).message
        terminal.write(`\x1b[31mError: ${msg}\x1b[0m\r\n`)
        setState({ status: 'error', error: msg })
        return
      }
    }

    // Sync initial size
    ipc.invoke('claude-pty:resize', {
      id,
      cols: terminal.cols,
      rows: terminal.rows,
    }).catch(() => {})

    // Focus — aggressive: immediate + delayed to ensure terminal captures keyboard
    setTimeout(() => terminal.focus(), 50)
    setTimeout(() => terminal.focus(), 300)
    setTimeout(() => terminal.focus(), 800)
  }, []) // Empty deps — only run once on mount

  /** Restart session */
  const restartSession = useCallback(() => {
    // Kill old session
    ipc.invoke('claude-pty:kill', { id: sessionIdRef.current }).catch(() => {})
    // Clear session capture timer
    if (sessionCaptureTimerRef.current) {
      clearInterval(sessionCaptureTimerRef.current)
      sessionCaptureTimerRef.current = null
    }
    // Recreate
    setTimeout(() => {
      setShowHelp(true)
      createSession()
    }, 200)
  }, [createSession])

  /** Send Ctrl+C (interrupt current operation) */
  const sendCtrlC = useCallback(() => {
    ipc.invoke('claude-pty:send-key', { id: sessionIdRef.current, key: 'ctrl-c' }).catch(() => {})
  }, [])

  /** Clear terminal scrollback */
  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear()
    terminalRef.current?.focus()
  }, [])

  /** Search in terminal */
  const doSearch = useCallback((direction: 'next' | 'prev') => {
    const search = searchAddonRef.current
    if (!search || !searchQuery) return
    if (direction === 'next') {
      search.findNext(searchQuery)
    } else {
      search.findPrevious(searchQuery)
    }
  }, [searchQuery])

  /** Respond to a permission prompt by sending the option number to PTY */
  const respondToPermission = useCallback((optionIndex: number) => {
    const id = sessionIdRef.current
    if (id) {
      ipc.invoke('claude-pty:write', { id, data: `${optionIndex}\n` }).catch(() => {})
    }
    setPermission(null)
  }, [])

  // Create session on mount only
  useEffect(() => {
    createSession()
    return () => {
      // Immediate cleanup: unsubscribe and dispose terminal
      if (unsubDataRef.current) { unsubDataRef.current(); unsubDataRef.current = null }
      if (unsubExitRef.current) { unsubExitRef.current(); unsubExitRef.current = null }
      if (unsubPermissionRef.current) { unsubPermissionRef.current(); unsubPermissionRef.current = null }
      if (terminalRef.current) {
        terminalRef.current.dispose()
        terminalRef.current = null
      }
      if (sessionCaptureTimerRef.current) {
        clearInterval(sessionCaptureTimerRef.current)
        sessionCaptureTimerRef.current = null
      }
      // Final session ID capture before unmount
      captureSessionId()
      // Delayed kill: if component remounts (StrictMode), the kill is cancelled
      // If component truly unmounts (conversation switch), the kill proceeds
      const sessionId = sessionIdRef.current
      killTimerRef.current = setTimeout(() => {
        ipc.invoke('claude-pty:kill', { id: sessionId }).catch(() => {})
        killTimerRef.current = null
      }, 300)
    }
  }, []) // Empty deps — mount only

  // ResizeObserver: auto-resize terminal
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const fit = fitAddonRef.current
      const term = terminalRef.current
      if (fit && term) {
        try {
          fit.fit()
          ipc.invoke('claude-pty:resize', {
            id: sessionIdRef.current,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {})
        } catch {
          // ignore fit errors
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // Theme adaptation
  useEffect(() => {
    const root = document.documentElement
    const updateTheme = () => {
      const isLight = root.getAttribute('data-theme') === 'light'
      const term = terminalRef.current
      if (term) {
        term.options.theme = isLight
          ? {
              background: '#fafafa',
              foreground: '#1e1e2e',
              cursor: '#7c5bf5',
              cursorAccent: '#fafafa',
              selectionBackground: 'rgba(124, 91, 245, 0.2)',
              black: '#1e1e2e', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
              blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#bcc0cc',
              brightBlack: '#5c5f77', brightRed: '#d20f39', brightGreen: '#40a02b',
              brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb',
              brightCyan: '#179299', brightWhite: '#6c6f85',
            }
          : {
              background: '#0c0c10',
              foreground: '#e0e0e0',
              cursor: '#7c5bf5',
              cursorAccent: '#0c0c10',
              selectionBackground: 'rgba(124, 91, 245, 0.3)',
              black: '#1e1e2e', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
              blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#cdd6f4',
              brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
              brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
              brightCyan: '#94e2d5', brightWhite: '#a6adc8',
            }
      }
    }
    updateTheme()
    const observer = new MutationObserver(updateTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // Handle search input
  useEffect(() => {
    if (showSearch && searchQuery) {
      searchAddonRef.current?.findNext(searchQuery)
    }
  }, [searchQuery, showSearch])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}
      >
        <div className="flex items-center gap-2">
          <TerminalIcon size={13} className="text-[var(--accent-bright)]" />
          <span className="text-[11.5px] font-semibold" style={{ color: 'var(--fg-secondary)' }}>
            Claude Code
          </span>
          {/* Status indicator */}
          {state.status === 'active' && (
            <span className="flex items-center gap-1.5 text-[10px] font-medium" style={{ color: 'var(--success)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success)', animation: 'pulse-success 2s infinite' }} />
              Active
            </span>
          )}
          {state.status === 'creating' && (
            <span className="flex items-center gap-1.5 text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>
              <Loader2 size={10} className="animate-spin" />
              Starting…
            </span>
          )}
          {state.status === 'exited' && (
            <span className="flex items-center gap-1.5 text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--fg-quaternary)' }} />
              Exited{state.exitCode !== undefined ? ` (${state.exitCode})` : ''}
            </span>
          )}
          {state.status === 'error' && (
            <span className="flex items-center gap-1.5 text-[10px] font-medium" style={{ color: 'var(--danger)' }}>
              <AlertCircle size={10} />
              Error
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          {/* Search toggle */}
          {state.status === 'active' && (
            <button
              onClick={() => setShowSearch(s => !s)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors hover:bg-[var(--tint-hover)]"
              style={{
                color: showSearch ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                background: showSearch ? 'var(--accent-subtle)' : undefined,
              }}
              title="Search in terminal (⌘F)"
            >
              <Search size={10} />
            </button>
          )}
          {/* Clear terminal */}
          {state.status === 'active' && (
            <button
              onClick={clearTerminal}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors hover:bg-[var(--tint-hover)]"
              style={{ color: 'var(--fg-tertiary)' }}
              title="Clear terminal (⌘K)"
            >
              <Trash2 size={10} />
            </button>
          )}
          {/* Ctrl+C interrupt */}
          {state.status === 'active' && (
            <button
              onClick={sendCtrlC}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors hover:bg-[var(--tint-hover)]"
              style={{ color: 'var(--fg-tertiary)' }}
              title="Send Ctrl+C (interrupt)"
            >
              <Square size={9} fill="currentColor" />
              <span>Stop</span>
            </button>
          )}
          {/* Restart */}
          {(state.status === 'exited' || state.status === 'error') && (
            <button
              onClick={restartSession}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors hover:bg-[var(--tint-hover)]"
              style={{ color: 'var(--accent-bright)' }}
              title="Restart Claude Code session"
            >
              <RotateCcw size={10} />
              <span>Restart</span>
            </button>
          )}
        </div>
      </div>

      {/* Search bar */}
      {showSearch && state.status === 'active' && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}
        >
          <Search size={12} className="text-[var(--fg-quaternary)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch(e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') }
            }}
            placeholder="Search in terminal…"
            className="flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: 'var(--fg-primary)' }}
            autoFocus
          />
          <button
            onClick={() => doSearch('prev')}
            className="p-0.5 rounded hover:bg-[var(--tint-hover)] transition-colors"
            title="Previous match"
          >
            <ChevronUp size={12} className="text-[var(--fg-tertiary)]" />
          </button>
          <button
            onClick={() => doSearch('next')}
            className="p-0.5 rounded hover:bg-[var(--tint-hover)] transition-colors"
            title="Next match"
          >
            <ChevronDown size={12} className="text-[var(--fg-tertiary)]" />
          </button>
          <button
            onClick={() => { setShowSearch(false); setSearchQuery('') }}
            className="p-0.5 rounded hover:bg-[var(--tint-hover)] transition-colors"
            title="Close search"
          >
            <X size={12} className="text-[var(--fg-tertiary)]" />
          </button>
        </div>
      )}

      {/* Quick command bar */}
      {state.status === 'active' && (
        <div
          className="flex items-center gap-1 px-3 py-1.5 flex-shrink-0 overflow-x-auto"
          style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}
        >
          <Zap size={10} className="text-[var(--fg-quaternary)] flex-shrink-0" />
          {['/help', '/model', '/clear', '/cost', '/compact'].map(cmd => (
            <button
              key={cmd}
              onClick={() => {
                const id = sessionIdRef.current
                if (id) ipc.invoke('claude-pty:send-text', { id, text: cmd })
              }}
              className="px-2 py-0.5 rounded-md text-[10px] font-mono transition-colors hover:bg-[var(--tint-hover)] flex-shrink-0"
              style={{ color: 'var(--fg-tertiary)', background: 'var(--bg-surface-2)' }}
              title={`Send ${cmd}`}
            >
              {cmd}
            </button>
          ))}
        </div>
      )}

      {/* Terminal container */}
      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        style={{
          background: '#0c0c10',
          cursor: 'text',
          boxShadow: isFocused ? 'inset 0 0 0 1px rgba(124, 91, 245, 0.15)' : undefined,
        }}
        onMouseDown={(e) => {
          // Re-focus terminal on any click in the container area
          // Use mouseDown instead of click for immediate focus before key events
          const term = terminalRef.current
          if (term && e.target === e.currentTarget) {
            // Click on container background (not on overlay elements) — focus terminal
            term.focus()
          }
        }}
      >
        <div
          ref={containerRef}
          className="absolute inset-0"
          onClick={() => {
            // Also handle click on the xterm container div for focus
            const term = terminalRef.current
            if (term) term.focus()
          }}
        />

        {/* Permission approval bar — floating above terminal when a permission prompt is detected */}
        {permission && state.status === 'active' && (
          <div
            className="absolute top-2 left-2 right-2 rounded-xl p-2.5 z-20"
            style={{
              background: 'rgba(12, 12, 16, 0.92)',
              border: '1px solid rgba(124, 91, 245, 0.35)',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
            }}
          >
            <div className="flex items-start gap-2">
              <ShieldCheck size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[10.5px] font-medium mb-0.5" style={{ color: 'var(--warn)' }}>
                  Permission Request
                </div>
                <div className="text-[10px] font-mono leading-relaxed mb-2" style={{ color: 'var(--fg-tertiary)' }}>
                  {permission.text.slice(0, 300)}
                  {permission.text.length > 300 ? '...' : ''}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {permission.options.map((opt, i) => {
                    const isLast = i === permission.options.length - 1
                    const isFirst = i === 0
                    return (
                      <button
                        key={i}
                        onClick={() => respondToPermission(i + 1)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10.5px] font-medium transition-colors"
                        style={{
                          background: isLast
                            ? 'rgba(255, 69, 58, 0.12)'
                            : isFirst
                              ? 'rgba(48, 209, 88, 0.12)'
                              : 'rgba(124, 91, 245, 0.12)',
                          color: isLast
                            ? 'var(--danger)'
                            : isFirst
                              ? 'var(--success)'
                              : 'var(--accent-bright)',
                          border: `1px solid ${
                            isLast
                              ? 'rgba(255, 69, 58, 0.25)'
                              : isFirst
                                ? 'rgba(48, 209, 88, 0.25)'
                                : 'rgba(124, 91, 245, 0.25)'
                          }`,
                        }}
                      >
                        {isLast ? <ShieldOff size={10} /> : <ShieldCheck size={10} />}
                        <span className="font-mono text-[9px] opacity-60">{i + 1}.</span>
                        <span>{opt.length > 40 ? opt.slice(0, 40) + '...' : opt}</span>
                      </button>
                    )
                  })}
                  <button
                    onClick={() => setPermission(null)}
                    className="ml-auto px-2 py-1 rounded-lg text-[10px] transition-colors hover:bg-[var(--tint-hover)]"
                    style={{ color: 'var(--fg-quaternary)' }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Help overlay — shown on new sessions, hidden when user starts typing */}
        {showHelp && state.status === 'active' && (
          <div
            className="absolute bottom-3 left-3 right-3 rounded-xl p-3 pointer-events-none z-10"
            style={{
              background: 'rgba(12, 12, 16, 0.85)',
              border: '1px solid rgba(124, 91, 245, 0.2)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold" style={{ color: 'var(--accent-bright)' }}>
                Quick Tips
              </span>
              <button
                onClick={() => setShowHelp(false)}
                className="pointer-events-auto p-0.5 rounded hover:bg-[var(--tint-hover)] transition-colors"
              >
                <X size={11} className="text-[var(--fg-quaternary)]" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10.5px]" style={{ color: 'var(--fg-tertiary)' }}>
              <div><span className="text-[var(--accent-bright)] font-mono">/help</span> — Show all commands</div>
              <div><span className="text-[var(--accent-bright)] font-mono">/model</span> — Switch model</div>
              <div><span className="text-[var(--accent-bright)] font-mono">/clear</span> — Clear conversation</div>
              <div><span className="text-[var(--accent-bright)] font-mono">/cost</span> — Show token usage</div>
              <div><span className="text-[var(--accent-bright)] font-mono">⌘F</span> — Search in terminal</div>
              <div><span className="text-[var(--accent-bright)] font-mono">⌘K</span> — Clear scrollback</div>
              <div className="col-span-2">
                <span className="text-[var(--accent-bright)] font-mono">@file</span> — Reference a file in your prompt
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
