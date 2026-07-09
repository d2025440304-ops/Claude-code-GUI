/**
 * 文件浏览组件 — 左右分栏布局。
 *
 * 左侧：文件树
 * 右侧：代码预览
 * 中间：可拖拽分隔条
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Folder, FolderOpen, File, FileCode, FileText, FileJson, Image, Loader2, ChevronRight, RefreshCw } from 'lucide-react'
import { ipc } from '../lib/ipc'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  extension?: string
}

interface FileExplorerProps {
  projectPath: string | null
}

/** 根据文件扩展名返回合适的图标 */
function getFileIcon(name: string, isDir: boolean) {
  if (isDir) return <Folder size={13} className="text-[var(--accent-bright)]" />
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(ext))
    return <FileCode size={13} className="text-[var(--fg-tertiary)]" />
  if (['json', 'yaml', 'yml', 'toml'].includes(ext))
    return <FileJson size={13} className="text-[var(--fg-tertiary)]" />
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext))
    return <Image size={13} className="text-[var(--fg-tertiary)]" />
  return <FileText size={13} className="text-[var(--fg-tertiary)]" />
}

export default function FileExplorer({ projectPath }: FileExplorerProps) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(new Map())
  const [loading, setLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)

  // 分隔条位置（百分比）
  const [splitPos, setSplitPos] = useState(35)
  const isDraggingRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 加载根目录
  const loadRoot = useCallback(() => {
    if (!projectPath) return
    setLoading(true)
    ipc.invoke<FileEntry[]>('file:list', { dirPath: projectPath })
      .then((result) => {
        setEntries(result || [])
        setExpandedDirs(new Set([projectPath]))
        if (result) setDirContents(new Map([[projectPath, result]]))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [projectPath])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  // 自动刷新：监听 session-event，当检测到文件变更工具调用时刷新文件树
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsub = ipc.on('session-event', (data: { id: string; event: Record<string, unknown> }) => {
      const event = data.event
      // 只在 tool_result 且工具名为 Edit/Write/MultiEdit 时刷新
      if (event.type !== 'tool_result') return
      if (event.isError) return
      // 使用 debounce 避免频繁刷新
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => {
        loadRoot()
        // 也刷新已展开的目录
        setDirContents(prev => {
          const next = new Map(prev)
          for (const [dirPath] of next) {
            ipc.invoke<FileEntry[]>('file:list', { dirPath })
              .then(result => {
                if (result) setDirContents(prev2 => new Map(prev2).set(dirPath, result))
              })
              .catch(() => {})
          }
          return next
        })
      }, 300)
    })
    return () => { unsub(); if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) }
  }, [loadRoot])

  // 展开/折叠目录
  const toggleDir = useCallback(async (dirPath: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })

    if (!dirContents.has(dirPath)) {
      try {
        const result = await ipc.invoke<FileEntry[]>('file:list', { dirPath })
        if (result) {
          setDirContents(prev => new Map(prev).set(dirPath, result))
        }
      } catch {}
    }
  }, [dirContents])

  // 查看文件内容
  const viewFile = useCallback(async (filePath: string) => {
    setSelectedFile(filePath)
    setFileName(filePath.split('/').pop() || '')
    setLoadingFile(true)
    try {
      const result = await ipc.invoke<{ ok: boolean; content?: string; error?: string }>('file:read', { filePath })
      setFileContent(result?.ok ? (result.content || '') : `Error: ${result?.error}`)
    } catch {
      setFileContent('Failed to read file')
    } finally {
      setLoadingFile(false)
    }
  }, [])

  // 拖拽分隔条
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const pct = Math.min(80, Math.max(15, (x / rect.width) * 100))
      setSplitPos(pct)
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

  // 渲染文件树节点
  const renderEntry = (entry: FileEntry, depth: number = 0) => {
    const isExpanded = expandedDirs.has(entry.path)
    const children = dirContents.get(entry.path)

    return (
      <div key={entry.path}>
        <button
          onClick={() => {
            if (entry.isDirectory) toggleDir(entry.path)
            else viewFile(entry.path)
          }}
          className="w-full flex items-center gap-1.5 py-1 px-2 rounded-md text-left transition-colors hover:bg-[var(--tint-hover)]"
          style={{
            paddingLeft: `${depth * 14 + 8}px`,
            background: selectedFile === entry.path ? 'var(--accent-subtle)' : undefined,
          }}
        >
          {entry.isDirectory ? (
            <ChevronRight
              size={10}
              className="text-[var(--fg-quaternary)] transition-transform flex-shrink-0"
              style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            />
          ) : (
            <span className="w-[10px] flex-shrink-0" />
          )}
          {getFileIcon(entry.name, entry.isDirectory)}
          <span className="text-[12px] truncate" style={{ color: 'var(--fg-secondary)' }}>
            {entry.name}
          </span>
        </button>

        {entry.isDirectory && isExpanded && children && (
          <div>
            {children.map(child => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  if (!projectPath) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Folder size={24} className="text-[var(--fg-quaternary)]" />
          <span className="text-[12px] text-[var(--fg-tertiary)]">No project selected</span>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden">
      {/* 左侧：文件树 */}
      <div
        className="overflow-y-auto py-2 px-1 flex-shrink-0"
        style={{ width: `${splitPos}%`, borderRight: '1px solid var(--border-subtle)' }}
      >
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-[var(--fg-quaternary)]" />
          </div>
        ) : (
          entries.map(entry => renderEntry(entry))
        )}
      </div>

      {/* 分隔条 */}
      <div
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent-primary)] transition-colors"
        style={{ background: 'var(--border-subtle)' }}
        onMouseDown={startDrag}
      />

      {/* 右侧：代码预览 */}
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {selectedFile ? (
          <>
            {/* 文件名头 */}
            <div
              className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}
            >
              <File size={11} className="text-[var(--fg-quaternary)]" />
              <span className="text-[11px] font-mono truncate" style={{ color: 'var(--fg-secondary)' }}>
                {fileName}
              </span>
            </div>
            {/* 文件内容 */}
            <div className="flex-1 overflow-auto">
              {loadingFile ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={14} className="animate-spin text-[var(--fg-quaternary)]" />
                </div>
              ) : (
                <pre
                  className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-all"
                  style={{ color: 'var(--fg-secondary)' }}
                >
                  {fileContent}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-[12px] text-[var(--fg-quaternary)]">Select a file to preview</span>
          </div>
        )}
      </div>
    </div>
  )
}
