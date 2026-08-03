import { useState, useRef, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check, Sparkles } from 'lucide-react'
import type { ModelOption } from '../types'

interface ModelSelectorProps {
  selected: string
  models: ModelOption[]
  onSelect: (id: string) => void
  collapsed?: boolean
}

/**
 * 模型选择下拉框：显示当前模型，点击展开可选列表。
 * 下拉通过 Portal 渲染到 body（fixed 定位），避免被 sidebar 的 overflow 裁剪；
 * 左边界做视口钳制，长列表纵向滚动。
 */
function ModelSelector({ selected, models, onSelect, collapsed }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const model = models.find((m) => m.id === selected) || models[0]

  useEffect(() => {
    if (!open) return
    const recalc = () => {
      const el = triggerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setPos({ top: r.bottom, left: r.left, width: r.width })
    }
    recalc()
    const onDown = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (popupRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    window.addEventListener('resize', recalc)
    window.addEventListener('scroll', recalc, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', recalc)
      window.removeEventListener('scroll', recalc, true)
    }
  }, [open])

  const popupMinWidth = collapsed ? 220 : Math.max(pos.width, 220)
  const left = collapsed
    ? Math.max(8, Math.min(pos.left + 48, window.innerWidth - popupMinWidth - 12))
    : Math.max(8, Math.min(pos.left, window.innerWidth - popupMinWidth - 12))

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={collapsed
          ? "flex items-center justify-center rounded-xl border transition-all"
          : "flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border transition-all"
        }
        style={{
          width: collapsed ? 40 : undefined,
          height: collapsed ? 36 : undefined,
          background: open ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
          borderColor: open ? 'var(--accent-primary)' : 'var(--border-default)',
          boxShadow: open ? '0 0 0 3px rgba(99,102,241,0.12)' : 'none',
        }}
      >
        {collapsed ? (
          <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: 'linear-gradient(135deg, var(--accent-primary), #a855f7)' }}>
            <Sparkles size={11} color="#fff" />
          </div>
        ) : (
          <>
            <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: 'linear-gradient(135deg, var(--accent-primary), #a855f7)' }}>
              <Sparkles size={11} color="#fff" />
            </div>
            <span className="text-[12px] font-medium text-[var(--fg-primary)] flex-1 text-left">{model.name}</span>
            <ChevronDown
              size={14}
              className="text-[var(--fg-tertiary)]"
              style={{ transition: 'transform 200ms ease', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
            />
          </>
        )}
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          className="animate-scale-in"
          style={{
            position: 'fixed',
            top: pos.top + 8,
            left,
            minWidth: popupMinWidth,
            maxHeight: Math.max(160, window.innerHeight - pos.top - 24),
            overflowX: 'hidden',
            overflowY: 'auto',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-lg)',
            borderRadius: '16px',
            zIndex: 9999,
          }}
        >
          {models.map((m) => (
            <div
              key={m.id}
              onClick={() => { onSelect(m.id); setOpen(false) }}
              className="flex items-start gap-2.5 px-3.5 py-3 cursor-pointer"
              style={{
                background: m.id === selected ? 'var(--accent-subtle)' : 'transparent',
                transition: 'background 120ms ease',
              }}
              onMouseEnter={(e) => { if (m.id !== selected) e.currentTarget.style.background = 'var(--tint-subtle)' }}
              onMouseLeave={(e) => { if (m.id !== selected) e.currentTarget.style.background = 'transparent' }}
            >
              <div className="flex-1">
                <div className="text-[12.5px] font-medium text-[var(--fg-primary)]">{m.name}</div>
                <div className="text-[11px] text-[var(--fg-tertiary)] mt-0.5">{m.desc}</div>
              </div>
              {m.id === selected && (
                <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-primary)' }}>
                  <Check size={10} color="#fff" strokeWidth={3} />
                </div>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

export default memo(ModelSelector)
