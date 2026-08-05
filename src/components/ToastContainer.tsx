/**
 * Toast 通知容器 — 渲染全局错误/通知队列。
 * 固定在右下角，自动消失，可手动关闭。
 */
import { useEffect } from 'react'
import { useToastStore, type Toast } from '../stores/toastStore'
import { X, AlertTriangle, CheckCircle, Info, AlertCircle } from 'lucide-react'

const ICON_MAP = {
  error: AlertCircle,
  warning: AlertTriangle,
  success: CheckCircle,
  info: Info,
} as const

const COLOR_MAP = {
  error: { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', icon: '#ef4444', text: '#fca5a5' },
  warning: { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', icon: '#f59e0b', text: '#fcd34d' },
  success: { bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)', icon: '#22c55e', text: '#86efac' },
  info: { bg: 'rgba(99,102,241,0.1)', border: 'rgba(99,102,241,0.3)', icon: '#6366f1', text: '#a5b4fc' },
} as const

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const Icon = ICON_MAP[toast.type]
  const colors = COLOR_MAP[toast.type]

  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl shadow-lg animate-slide-in"
      style={{
        background: 'var(--bg-surface-1)',
        border: `1px solid ${colors.border}`,
        minWidth: 280,
        maxWidth: 420,
        backdropFilter: 'blur(12px)',
      }}
    >
      <Icon size={16} style={{ color: colors.icon }} className="flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] leading-relaxed" style={{ color: colors.text }}>
          {toast.message}
        </div>
        {toast.detail && (
          <div className="text-[10px] mt-0.5 font-mono truncate" style={{ color: 'var(--fg-quaternary)' }}>
            {toast.detail}
          </div>
        )}
      </div>
      <button
        onClick={() => onRemove(toast.id)}
        className="p-0.5 rounded hover:bg-[var(--tint-hover)] flex-shrink-0"
      >
        <X size={12} style={{ color: 'var(--fg-quaternary)' }} />
      </button>
    </div>
  )
}

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
      style={{ maxHeight: '60vh', overflowY: 'auto' }}
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onRemove={removeToast} />
        </div>
      ))}
    </div>
  )
}