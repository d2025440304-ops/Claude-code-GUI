/**
 * Skeleton loading components — shimmer-based placeholders.
 * Use these instead of spinner + text for a smoother perceived performance.
 */

import { memo } from 'react'

/* ── Raw skeleton bar ── */

export function SkeletonBar({ width = '100%', height = 14, style }: {
  width?: string | number
  height?: number
  style?: React.CSSProperties
}) {
  return (
    <div
      className="skeleton"
      style={{ width, height, ...style }}
    />
  )
}

/* ── Message skeleton (for chat loading) ── */

export const SkeletonMessage = memo(function SkeletonMessage({ align = 'left' }: { align?: 'left' | 'right' }) {
  const isRight = align === 'right'
  return (
    <div
      className="flex flex-col gap-2 animate-fade-in"
      style={{ alignItems: isRight ? 'flex-end' : 'flex-start' }}
    >
      <div style={{ width: '60%', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SkeletonBar width="100%" height={14} />
        <SkeletonBar width="75%" height={14} />
        <SkeletonBar width="40%" height={14} />
      </div>
    </div>
  )
})

/* ── Conversation list skeleton (for sidebar) ── */

export function SkeletonConversationList({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-1.5 px-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-2.5 px-3 py-2"
          style={{ animationDelay: `${i * 40}ms` }}
        >
          <SkeletonBar width={16} height={16} style={{ borderRadius: 6, flexShrink: 0 }} />
          <div className="flex-1 flex flex-col gap-1.5">
            <SkeletonBar width={`${50 + Math.random() * 40}%`} height={12} />
            <SkeletonBar width={`${30 + Math.random() * 30}%`} height={9} />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Right panel tab skeleton ── */

export function SkeletonPanel() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <SkeletonBar width="45%" height={16} />
      <SkeletonBar width="100%" height={12} />
      <SkeletonBar width="85%" height={12} />
      <SkeletonBar width="100%" height={12} />
      <SkeletonBar width="60%" height={12} />
      <div style={{ height: 12 }} />
      <SkeletonBar width="40%" height={16} />
      <SkeletonBar width="100%" height={12} />
      <SkeletonBar width="90%" height={12} />
    </div>
  )
}

/* ── Empty state ── */

export function EmptyState({ icon: Icon, title, description, action }: {
  icon: React.ElementType
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center"
        style={{ background: 'var(--bg-surface-2)' }}
      >
        <Icon size={22} style={{ color: 'var(--fg-tertiary)' }} />
      </div>
      <div className="text-[13px] font-medium" style={{ color: 'var(--fg-secondary)' }}>
        {title}
      </div>
      {description && (
        <div className="text-[11px] leading-relaxed max-w-[240px]" style={{ color: 'var(--fg-tertiary)' }}>
          {description}
        </div>
      )}
      {action}
    </div>
  )
}