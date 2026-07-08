import { useState, memo } from 'react'
import { ChevronDown, Check, Sparkles } from 'lucide-react'
import type { ModelOption } from '../types'

interface ModelSelectorProps {
  selected: string
  models: ModelOption[]
  onSelect: (id: string) => void
}

/**
 * 模型选择下拉框：显示当前模型，点击展开可选列表。
 */
function ModelSelector({ selected, models, onSelect }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const model = models.find((m) => m.id === selected) || models[0]
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border transition-all"
        style={{
          background: open ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
          borderColor: open ? 'var(--accent-primary)' : 'var(--border-default)',
          boxShadow: open ? '0 0 0 3px rgba(99,102,241,0.12)' : 'none',
        }}
      >
        <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: 'linear-gradient(135deg, var(--accent-primary), #a855f7)' }}>
          <Sparkles size={11} color="#fff" />
        </div>
        <span className="text-[12px] font-medium text-[var(--fg-primary)] flex-1 text-left">{model.name}</span>
        <ChevronDown
          size={14}
          className="text-[var(--fg-tertiary)]"
          style={{ transition: 'transform 200ms ease', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute top-full left-0 right-0 mt-2 rounded-xl border bg-[var(--bg-surface)] shadow-lg z-20 overflow-hidden animate-scale-in"
            style={{ borderColor: 'var(--border-default)', boxShadow: 'var(--shadow-lg)' }}
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
          </div>
        </>
      )}
    </div>
  )
}

export default memo(ModelSelector)
