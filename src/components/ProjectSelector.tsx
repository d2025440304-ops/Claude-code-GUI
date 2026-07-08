import { memo } from 'react'
import { FolderOpen } from 'lucide-react'

interface ProjectSelectorProps {
  project: { name: string; path: string } | null
  onSelect: () => void
}

/**
 * 项目文件夹选择按钮：显示当前项目路径，点击打开原生文件夹选择对话框。
 */
function ProjectSelector({ project, onSelect }: ProjectSelectorProps) {
  return (
    <button
      onClick={onSelect}
      className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border transition-all hover:border-[var(--border-strong)]"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: 'var(--bg-surface-2)' }}>
        <FolderOpen size={12} className="text-[var(--fg-tertiary)]" />
      </div>
      {project ? (
        <span className="text-[11.5px] font-mono text-[var(--fg-secondary)] flex-1 text-left truncate">{project.name}</span>
      ) : (
        <span className="text-[11.5px] text-[var(--fg-quaternary)] flex-1 text-left">Select project folder…</span>
      )}
    </button>
  )
}

export default memo(ProjectSelector)
