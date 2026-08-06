import { useState, useEffect, useRef, memo } from 'react'
import type { MouseEvent, KeyboardEvent } from 'react'
import { Pin, MoreHorizontal } from 'lucide-react'
import type { Conversation } from '../types'

/* ---------- helpers ---------- */

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function getDisplayName(conv: Conversation): string {
  // 优先用标题，如果还是默认标题则用项目文件夹名
  if (conv.title && conv.title !== 'New Conversation' && conv.title !== 'New Chat') {
    return conv.title
  }
  if (conv.projectPath) {
    const parts = conv.projectPath.split('/')
    return parts[parts.length - 1] || conv.projectPath
  }
  return conv.title || 'Untitled'
}

/* ---------- ConversationItem ---------- */

interface ConversationItemProps {
  conv: Conversation
  active: boolean
  editing: boolean
  onClick: () => void
  onPinToggle: () => void
  onContextMenu: (e: MouseEvent) => void
  onRenameCommit: (title: string) => void
  onRenameCancel: () => void
}

/**
 * 侧边栏会话列表项：极简设计，只显示名称和时间。
 */
function ConversationItem({ conv, active, editing, onClick, onPinToggle, onContextMenu, onRenameCommit, onRenameCancel }: ConversationItemProps) {
  const [editValue, setEditValue] = useState(conv.title)
  const [hovered, setHovered] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setEditValue(conv.title)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editing, conv.title])

  const handleRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onRenameCommit(editValue.trim() || conv.title)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onRenameCancel()
    }
  }

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer animate-fade-in"
      style={{
        background: active
          ? 'var(--accent-subtle)'
          : hovered ? 'var(--tint-subtle)' : 'transparent',
        transition: 'all 180ms var(--ease-smooth)',
        border: active ? '1px solid var(--border-accent)' : '1px solid transparent',
      }}
    >
      {/* Pin indicator */}
      <button
        onClick={(e) => { e.stopPropagation(); onPinToggle() }}
        className="flex-shrink-0 p-0.5 rounded bg-transparent border-none cursor-pointer"
        style={{
          opacity: conv.pinned || hovered ? 1 : 0,
          transition: 'opacity 150ms ease',
        }}
        title={conv.pinned ? 'Unpin' : 'Pin'}
      >
        <Pin
          size={10}
          fill={conv.pinned ? 'currentColor' : 'none'}
          className={conv.pinned ? 'text-[#fbbf24]' : 'text-[var(--fg-quaternary)]'}
        />
      </button>

      {/* Content */}
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleRenameKey}
          onBlur={() => onRenameCommit(editValue.trim() || conv.title)}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-[13px] font-medium bg-[var(--bg-input)] border border-[var(--accent-primary)] rounded-lg px-2 py-0.5 outline-none"
          style={{ color: 'var(--fg-primary)', boxShadow: '0 0 0 3px var(--accent-ring)' }}
        />
      ) : (
        <>
          <span
            className="text-[13px] font-medium truncate flex-1"
            style={{ color: active ? 'var(--fg-primary)' : 'var(--fg-secondary)', letterSpacing: '-0.01em' }}
          >
            {getDisplayName(conv)}
          </span>
          <span
            className="text-[11px] font-medium flex-shrink-0 tabular-nums"
            style={{ color: 'var(--fg-quaternary)' }}
          >
            {formatTime(conv.updatedAt)}
          </span>
          {/* More options */}
          <button
            onClick={(e) => { e.stopPropagation(); onContextMenu(e) }}
            className="flex-shrink-0 p-0.5 rounded-md bg-transparent border-none cursor-pointer"
            style={{
              opacity: hovered ? 1 : 0,
              transition: 'opacity 150ms ease',
            }}
            title="More options"
          >
            <MoreHorizontal size={12} className="text-[var(--fg-tertiary)]" />
          </button>
        </>
      )}
    </div>
  )
}

export default memo(ConversationItem)
