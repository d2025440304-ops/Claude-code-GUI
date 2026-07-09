/**
 * 代码审查组件。
 *
 * 显示当前项目的 git diff，用于查看代码变更。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { GitCompare, RefreshCw, File, Loader2, Plus, Minus } from 'lucide-react'
import { ipc } from '../lib/ipc'

interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  diff: string
}

interface CodeReviewProps {
  projectPath: string | null
}

export default function CodeReview({ projectPath }: CodeReviewProps) {
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const loadDiff = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    setError(null)
    try {
      const result = await ipc.invoke<{ ok: boolean; files?: DiffFile[]; error?: string }>('git:diff', {
        dirPath: projectPath,
      })
      if (result?.ok && result.files) {
        setDiffFiles(result.files)
      } else {
        setError(result?.error || 'Failed to load diff')
      }
    } catch {
      setError('Failed to load git diff')
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    loadDiff()
  }, [loadDiff])

  // 自动刷新：监听 session-event，当检测到文件变更工具调用时刷新 git diff
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsub = ipc.on('session-event', (data: { id: string; event: Record<string, unknown> }) => {
      const event = data.event
      // 在 tool_result 且工具为文件修改类时刷新
      if (event.type !== 'tool_result') return
      if (event.isError) return
      // debounce
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => {
        loadDiff()
      }, 500)
    })
    return () => { unsub(); if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) }
  }, [loadDiff])

  const toggleFile = (path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (!projectPath) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <GitCompare size={24} className="text-[var(--fg-quaternary)]" />
          <span className="text-[12px] text-[var(--fg-tertiary)]">No project selected</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center gap-2">
          <GitCompare size={12} className="text-[var(--fg-tertiary)]" />
          <span className="text-[11px] font-medium" style={{ color: 'var(--fg-secondary)' }}>
            Changes
          </span>
          {diffFiles.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ color: 'var(--fg-quaternary)', background: 'var(--tint-subtle)' }}>
              {diffFiles.length} files
            </span>
          )}
        </div>
        <button
          onClick={loadDiff}
          disabled={loading}
          className="p-1 rounded-md transition-colors hover:bg-[var(--tint-hover)]"
          title="Refresh"
        >
          <RefreshCw size={12} className={`text-[var(--fg-tertiary)] ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-[var(--fg-quaternary)]" />
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-[12px]" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        ) : diffFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <GitCompare size={20} className="text-[var(--fg-quaternary)]" />
            <span className="text-[12px] text-[var(--fg-tertiary)]">No changes</span>
            <span className="text-[11px] text-[var(--fg-quaternary)]">Working tree is clean</span>
          </div>
        ) : (
          <div className="py-1">
            {diffFiles.map((file) => {
              const isExpanded = expandedFiles.has(file.path)
              return (
                <div key={file.path}>
                  {/* 文件头部 */}
                  <button
                    onClick={() => toggleFile(file.path)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--tint-hover)]"
                  >
                    <File size={12} className="text-[var(--fg-tertiary)] flex-shrink-0" />
                    <span className="text-[12px] font-mono truncate flex-1" style={{ color: 'var(--fg-secondary)' }}>
                      {file.path}
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {file.additions > 0 && (
                        <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--success)' }}>
                          <Plus size={8} />{file.additions}
                        </span>
                      )}
                      {file.deletions > 0 && (
                        <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--danger)' }}>
                          <Minus size={8} />{file.deletions}
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Diff 内容 */}
                  {isExpanded && file.diff && (
                    <div
                      className="mx-3 mb-2 rounded-lg overflow-hidden text-[11px] font-mono leading-relaxed"
                      style={{
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      {file.diff.split('\n').map((line, i) => {
                        let color = 'var(--fg-secondary)'
                        let bg = 'transparent'
                        if (line.startsWith('+') && !line.startsWith('+++')) {
                          color = 'var(--success)'
                          bg = 'rgba(34,197,94,0.06)'
                        } else if (line.startsWith('-') && !line.startsWith('---')) {
                          color = 'var(--danger)'
                          bg = 'rgba(248,113,113,0.06)'
                        } else if (line.startsWith('@@')) {
                          color = 'var(--accent-bright)'
                        }
                        return (
                          <div
                            key={i}
                            className="px-3 py-0.5 whitespace-pre"
                            style={{ color, background: bg }}
                          >
                            {line}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
