/**
 * 右侧面板容器组件。
 *
 * 四个 Tab (Activity / Files / Terminal / Review) 用 CSS display 控制显隐。
 * 支持拖拽左边缘调整面板宽度。
 */
import { useState, useRef, useEffect } from 'react'
import { FileText, GitCompare, X, Activity, Terminal } from 'lucide-react'
import FileExplorer from './FileExplorer'
import CodeReview from './CodeReview'
import ActivityPanel from './ActivityPanel'
import TerminalView from './TerminalView'

export type RightPanelTab = 'activity' | 'files' | 'terminal' | 'review'

interface RightPanelProps {
  projectPath: string | null
  onClose: () => void
  /** Conversation ID (for session watcher) */
  convId?: string | null
  /** Claude session ID */
  sessionId?: string | null
}

const TABS: { id: RightPanelTab; label: string; icon: typeof Activity }[] = [
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'files', label: 'Files', icon: FileText },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'review', label: 'Review', icon: GitCompare },
]

const MIN_WIDTH = 280
const MAX_WIDTH = 800

export default function RightPanel({ projectPath, onClose, convId, sessionId }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>('activity')
  const [width, setWidth] = useState(380)
  const isDraggingRef = useRef(false)

  // 拖拽调整宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
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

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <aside
      className="glass flex flex-col flex-shrink-0 relative"
      style={{
        width: `${width}px`,
        borderLeft: '1px solid var(--border-default)',
      }}
    >
      {/* 左边缘拖拽条 */}
      <div
        className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent-primary)] transition-colors z-10"
        onMouseDown={startDrag}
      />

      {/* 面板头部 */}
      <div
        className="flex items-center justify-between px-3 flex-shrink-0 drag-region"
        style={{
          height: '42px',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        <div className="flex items-center gap-0.5 no-drag">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
                style={{
                  background: isActive ? 'var(--accent-subtle)' : 'transparent',
                  color: isActive ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                }}
              >
                <Icon size={12} />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
        <button
          onClick={onClose}
          className="no-drag p-1 rounded-md transition-colors hover:bg-[var(--tint-hover)]"
          title="Close panel"
        >
          <X size={13} className="text-[var(--fg-tertiary)]" />
        </button>
      </div>

      {/* 面板内容 — 用 CSS display 控制显隐，避免卸载重建 */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div style={{ display: activeTab === 'activity' ? 'block' : 'none', height: '100%' }}>
          <ActivityPanel convId={convId ?? null} sessionId={sessionId ?? null} cwd={projectPath} />
        </div>
        <div style={{ display: activeTab === 'files' ? 'block' : 'none', height: '100%' }}>
          <FileExplorer projectPath={projectPath} />
        </div>
        <div style={{ display: activeTab === 'terminal' ? 'block' : 'none', height: '100%' }}>
          <TerminalView projectPath={projectPath} />
        </div>
        <div style={{ display: activeTab === 'review' ? 'block' : 'none', height: '100%' }}>
          <CodeReview projectPath={projectPath} />
        </div>
      </div>
    </aside>
  )
}
