import { X } from 'lucide-react'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 通用确认对话框：用于删除、清空等破坏性操作前的二次确认。
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <>
      <div
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={onCancel}
      />
      <div
        className="fixed z-50 rounded-2xl animate-scale-in"
        style={{
          top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '360px', maxWidth: '90vw',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <span className="text-[14px] font-semibold text-[var(--fg-primary)]">{title}</span>
          <button
            onClick={onCancel}
            className="p-1 rounded-md hover:bg-[var(--tint-hover)] transition-colors"
          >
            <X size={14} className="text-[var(--fg-tertiary)]" />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>{message}</p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button
            onClick={onCancel}
            className="btn btn-secondary text-[12px]"
            style={{ padding: '7px 16px' }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="btn text-[12px]"
            style={{
              padding: '7px 16px',
              background: danger ? 'var(--danger)' : 'linear-gradient(135deg, var(--accent-primary) 0%, #7c3aed 100%)',
              color: '#fff',
              border: 'none',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}
