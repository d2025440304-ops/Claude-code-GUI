/**
 * 多终端 Tab 组件。
 *
 * 每个终端有独立的 DOM 容器，用 CSS display 控制显隐。
 * 避免 xterm.js 反复 open/dispose 导致的不稳定。
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { Plus, X } from 'lucide-react'
import { ipc } from '../lib/ipc'

interface TerminalViewProps {
  projectPath: string | null
}

interface TerminalTab {
  id: string
  label: string
  terminal: Terminal
  fitAddon: FitAddon
  unsubData: () => void
  unsubExit: () => void
  containerEl: HTMLDivElement
}

export default function TerminalView({ projectPath }: TerminalViewProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const initRef = useRef(false)

  /** 从现有终端中找最小可用编号（填补空位） */
  const nextTerminalNumber = useCallback(() => {
    const used = new Set(
      tabsRef.current
        .map(t => parseInt(t.id.replace('term-', ''), 10))
        .filter(n => !isNaN(n)),
    )
    let n = 1
    while (used.has(n)) n++
    return n
  }, [])

  // 创建新终端
  const createTerminal = useCallback(async () => {
    const num = nextTerminalNumber()
    const id = `term-${num}`
    const label = `Terminal ${num}`

    // 创建容器
    const containerEl = document.createElement('div')
    containerEl.style.width = '100%'
    containerEl.style.height = '100%'
    containerEl.style.display = 'none'
    wrapperRef.current?.appendChild(containerEl)

    // 创建 xterm 实例
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
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())

    // 打开终端到容器
    terminal.open(containerEl)
    fitAddon.fit()

    // 监听 PTY 输出
    const unsubData = ipc.on('terminal:data', (payload: { id: string; data: string }) => {
      if (payload.id === id) {
        terminal.write(payload.data)
      }
    })

    // 监听 PTY 退出
    const unsubExit = ipc.on('terminal:exit', (payload: { id: string; exitCode: number }) => {
      if (payload.id === id) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${payload.exitCode}]\x1b[0m\r\n`)
      }
    })

    // 用户输入 → PTY
    terminal.onData((data: string) => {
      ipc.invoke('terminal:write', { id, data }).catch(() => {})
    })

    // 点击聚焦
    containerEl.addEventListener('click', () => terminal.focus())

    // ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      ipc.invoke('terminal:resize', {
        id,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => {})
    })
    resizeObserver.observe(containerEl)

    const tab: TerminalTab = {
      id,
      label,
      terminal,
      fitAddon,
      unsubData,
      unsubExit,
      containerEl,
    }

    setTabs(prev => [...prev, tab])
    setActiveTabId(id)

    // 创建 PTY 后端
    try {
      const result = await ipc.invoke<{ ok: boolean; error?: string }>('terminal:create', {
        id,
        cwd: projectPath || undefined,
      })
      if (!result?.ok) {
        terminal.write(`\x1b[31mFailed: ${result?.error}\x1b[0m\r\n`)
      }
    } catch (err) {
      terminal.write(`\x1b[31mError: ${(err as Error).message}\x1b[0m\r\n`)
    }

    // 同步初始尺寸
    ipc.invoke('terminal:resize', {
      id,
      cols: terminal.cols,
      rows: terminal.rows,
    }).catch(() => {})

    // 聚焦
    setTimeout(() => terminal.focus(), 100)
  }, [projectPath, nextTerminalNumber])

  // 关闭终端
  const closeTerminal = useCallback((tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const tab = tabsRef.current.find(t => t.id === tabId)
    if (!tab) return

    tab.unsubData()
    tab.unsubExit()
    tab.terminal.dispose()
    tab.containerEl.remove()
    ipc.invoke('terminal:kill', { id: tabId }).catch(() => {})

    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId)
      if (activeTabId === tabId) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null)
      }
      return next
    })
  }, [activeTabId])

  // 切换 Tab 时控制容器显隐
  useEffect(() => {
    for (const tab of tabsRef.current) {
      if (tab.containerEl) {
        tab.containerEl.style.display = tab.id === activeTabId ? 'block' : 'none'
      }
    }
    // 聚焦当前终端并刷新尺寸
    const active = tabsRef.current.find(t => t.id === activeTabId)
    if (active) {
      setTimeout(() => {
        active.fitAddon.fit()
        active.terminal.focus()
        ipc.invoke('terminal:resize', {
          id: active.id,
          cols: active.terminal.cols,
          rows: active.terminal.rows,
        }).catch(() => {})
      }, 50)
    }
  }, [activeTabId])

  // 自动创建第一个终端（严格模式安全）
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true
      createTerminal()
    }
    return () => {
      // 清理所有终端
      for (const tab of tabsRef.current) {
        tab.unsubData()
        tab.unsubExit()
        tab.terminal.dispose()
        ipc.invoke('terminal:kill', { id: tab.id }).catch(() => {})
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full">
      {/* Tab 栏 */}
      <div
        className="flex items-center gap-1 px-2 py-1.5 flex-shrink-0 overflow-x-auto"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}
      >
        {tabs.map(tab => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg cursor-pointer transition-colors text-[11px] font-medium flex-shrink-0"
            style={{
              background: tab.id === activeTabId ? 'var(--accent-subtle)' : 'transparent',
              color: tab.id === activeTabId ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
            }}
          >
            <span>{tab.label}</span>
            <button
              onClick={(e) => closeTerminal(tab.id, e)}
              className="p-0.5 rounded hover:bg-[var(--tint-hover)] transition-colors"
              title="Close terminal"
            >
              <X size={10} />
            </button>
          </div>
        ))}
        <button
          onClick={createTerminal}
          className="p-1 rounded-lg hover:bg-[var(--tint-hover)] transition-colors flex-shrink-0"
          title="New terminal"
        >
          <Plus size={12} className="text-[var(--fg-tertiary)]" />
        </button>
      </div>

      {/* 终端容器包装器 */}
      <div ref={wrapperRef} className="flex-1 min-h-0 overflow-hidden" />

      {/* 空状态 */}
      {tabs.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <span className="text-[12px] text-[var(--fg-tertiary)]">No terminals</span>
            <button
              onClick={createTerminal}
              className="btn btn-secondary text-[11px] px-3 py-1.5"
            >
              <Plus size={12} />
              <span>New Terminal</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
