import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import { Shield, Pencil, Compass, Zap, ChevronDown, Check, Brain, Cpu } from 'lucide-react'
import type {
  PermissionMode, PermissionModeOption, ModelOption,
  ThinkingEffort, ThinkingEffortOption,
} from '../types'

/* ---------- 权限模式图标映射 ---------- */

function PermissionIcon({ type, size = 12 }: { type: PermissionModeOption['icon']; size?: number }) {
  switch (type) {
    case 'ask': return <Shield size={size} />
    case 'edit': return <Pencil size={size} />
    case 'plan': return <Compass size={size} />
    case 'skip': return <Zap size={size} />
  }
}

/* ---------- 颜色映射 ---------- */

const COLOR_MAP = {
  default: {
    bg: 'var(--tint-subtle)',
    bgActive: 'var(--bg-surface-3)',
    text: 'var(--fg-secondary)',
    textActive: 'var(--fg-primary)',
  },
  accent: {
    bg: 'var(--tint-subtle)',
    bgActive: 'rgba(124,91,245,0.15)',
    text: 'var(--fg-secondary)',
    textActive: 'var(--accent-bright)',
  },
  warn: {
    bg: 'var(--tint-subtle)',
    bgActive: 'rgba(255,214,10,0.10)',
    text: 'var(--fg-secondary)',
    textActive: 'var(--warn)',
  },
  danger: {
    bg: 'var(--tint-subtle)',
    bgActive: 'rgba(255,69,58,0.10)',
    text: 'var(--fg-secondary)',
    textActive: 'var(--danger)',
  },
} as const

/* ---------- 通用 Portal 弹出层 hook ---------- */

/** 计算触发元素的视口坐标，返回 { top, left } 供 fixed 定位使用。 */
function usePopupPosition(triggerRef: React.RefObject<HTMLElement | null>, open: boolean) {
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const recalc = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ top: rect.top, left: rect.left })
  }, [triggerRef])

  useEffect(() => {
    if (!open) return
    recalc()
    // 滚动 / resize 时重新计算
    window.addEventListener('scroll', recalc, true)
    window.addEventListener('resize', recalc)
    return () => {
      window.removeEventListener('scroll', recalc, true)
      window.removeEventListener('resize', recalc)
    }
  }, [open, recalc])

  return pos
}

/** 通过 Portal 渲染弹出层，固定定位到 body，避免被其他堆叠上下文遮挡。 */
function PortalPopup({
  triggerRef,
  open,
  onClose,
  minWidth = 220,
  children,
}: {
  triggerRef: React.RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  minWidth?: number
  children: React.ReactNode
}) {
  const pos = usePopupPosition(triggerRef, open)
  const popupRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popupRef.current?.contains(target)) return
      onClose()
    }
    // 延迟注册，避免当前点击立即触发关闭
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [open, onClose, triggerRef])

  if (!open) return null

  return createPortal(
    <div
      ref={popupRef}
      className="animate-scale-in"
      style={{
        position: 'fixed',
        bottom: `calc(100vh - ${pos.top}px + 8px)`,
        left: pos.left,
        minWidth,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-lg)',
        borderRadius: '16px',
        overflow: 'hidden',
        zIndex: 9999,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

/* ---------- Props ---------- */

interface ControlBarProps {
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  permissionModes: PermissionModeOption[]
  selectedModel: string
  models: ModelOption[]
  onModelSelect: (id: string) => void
  thinkingEffort: ThinkingEffort
  onThinkingEffortChange: (effort: ThinkingEffort) => void
  thinkingEfforts: ThinkingEffortOption[]
  disabled?: boolean
}

/* ---------- 权限模式分段选择器 ---------- */

const PermissionSegmented = memo(function PermissionSegmented({
  modes, selected, onChange, disabled,
}: {
  modes: PermissionModeOption[]
  selected: PermissionMode
  onChange: (m: PermissionMode) => void
  disabled?: boolean
}) {
  const [hoveredId, setHoveredId] = useState<PermissionMode | null>(null)
  const active = modes.find((m) => m.id === selected) || modes[0]

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="flex items-center rounded-lg overflow-hidden"
        style={{
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-subtle)',
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
      >
        {modes.map((mode, i) => {
          const isActive = mode.id === selected
          const isHovered = mode.id === hoveredId
          const modeColors = COLOR_MAP[mode.color]
          return (
            <button
              key={mode.id}
              onClick={() => onChange(mode.id)}
              onMouseEnter={() => setHoveredId(mode.id)}
              onMouseLeave={() => setHoveredId(null)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 transition-all relative"
              style={{
                background: isActive
                  ? modeColors.bgActive
                  : isHovered
                    ? 'var(--tint-hover)'
                    : 'transparent',
                color: isActive ? modeColors.textActive : 'var(--fg-tertiary)',
                borderRight: i < modes.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                fontSize: '11px',
                fontWeight: isActive ? 600 : 500,
                letterSpacing: '0.01em',
                minWidth: '52px',
                justifyContent: 'center',
              }}
              title={mode.desc}
            >
              <PermissionIcon type={mode.icon} size={11} />
              <span>{mode.shortLabel}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
})

/* ---------- 模型选择器（Portal 版） ---------- */

const ModelPickerInline = memo(function ModelPickerInline({
  models, selected, onSelect, disabled,
}: {
  models: ModelOption[]
  selected: string
  onSelect: (id: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const model = models.find((m) => m.id === selected) || models[0]

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all"
        style={{
          background: open ? 'var(--bg-surface-3)' : 'var(--bg-surface-2)',
          border: `1px solid ${open ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
          boxShadow: open ? '0 0 0 2px rgba(124,91,245,0.10)' : 'none',
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
          fontSize: '11px',
          fontWeight: 500,
          color: 'var(--fg-secondary)',
        }}
      >
        <Cpu size={11} className="text-[var(--accent-bright)]" />
        <span>{model.name}</span>
        <ChevronDown
          size={10}
          className="text-[var(--fg-quaternary)] transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      <PortalPopup
        triggerRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={220}
      >
        <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <Cpu size={11} className="text-[var(--accent-bright)]" />
          <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.08em' }}>
            Model
          </span>
        </div>
        <div className="py-1">
          {models.map((m) => {
            const isActive = m.id === selected
            return (
              <div
                key={m.id}
                onClick={() => { onSelect(m.id); setOpen(false) }}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors"
                style={{ background: isActive ? 'var(--accent-subtle)' : 'transparent' }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--tint-subtle)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium" style={{ color: isActive ? 'var(--accent-bright)' : 'var(--fg-primary)' }}>
                    {m.name}
                  </div>
                  <div className="text-[10.5px] truncate" style={{ color: 'var(--fg-quaternary)' }}>{m.desc}</div>
                </div>
                {isActive && (
                  <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent-primary)' }}>
                    <Check size={10} color="#fff" strokeWidth={3} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </PortalPopup>
    </>
  )
})

/* ---------- 思考等级选择器（Portal 版） ---------- */

const ThinkingEffortPicker = memo(function ThinkingEffortPicker({
  efforts, selected, onChange, disabled,
}: {
  efforts: ThinkingEffortOption[]
  selected: ThinkingEffort
  onChange: (e: ThinkingEffort) => void
  disabled?: boolean
}) {
  const [hoveredId, setHoveredId] = useState<ThinkingEffort | null>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const active = efforts.find((e) => e.id === selected) || efforts[0]

  const barColor = selected === 'none'
    ? 'var(--fg-quaternary)'
    : selected === 'low'
      ? 'var(--success)'
      : selected === 'medium'
        ? 'var(--accent-bright)'
        : 'var(--warn)'

  return (
    <div ref={triggerRef} className="flex items-center gap-1.5">
      <Brain size={11} className="text-[var(--fg-quaternary)]" />
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all"
        style={{
          background: open ? 'var(--bg-surface-3)' : 'transparent',
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
      >
        <div className="flex items-end gap-0.5" style={{ height: '12px' }}>
          {[1, 2, 3].map((bar) => (
            <div
              key={bar}
              className="rounded-sm transition-all"
              style={{
                width: '3px',
                height: `${bar * 3 + 2}px`,
                background: active.bars >= bar ? barColor : 'var(--fg-quaternary)',
                opacity: active.bars >= bar ? 1 : 0.25,
              }}
            />
          ))}
        </div>
        <span className="text-[11px] font-medium" style={{ color: active.id === 'none' ? 'var(--fg-quaternary)' : 'var(--fg-secondary)' }}>
          {active.label}
        </span>
        <ChevronDown
          size={10}
          className="text-[var(--fg-quaternary)] transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      <PortalPopup
        triggerRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={200}
      >
        <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <Brain size={11} className="text-[var(--accent-bright)]" />
          <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.08em' }}>
            Thinking Effort
          </span>
        </div>
        <div className="py-1">
          {efforts.map((effort) => {
            const isActive = effort.id === selected
            const isHovered = effort.id === hoveredId
            const effortBarColor = effort.id === 'none'
              ? 'var(--fg-quaternary)'
              : effort.id === 'low'
                ? 'var(--success)'
                : effort.id === 'medium'
                  ? 'var(--accent-bright)'
                  : 'var(--warn)'
            return (
              <div
                key={effort.id}
                onClick={() => { onChange(effort.id); setOpen(false) }}
                onMouseEnter={() => setHoveredId(effort.id)}
                onMouseLeave={() => setHoveredId(null)}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors"
                style={{
                  background: isActive
                    ? 'var(--accent-subtle)'
                    : isHovered
                      ? 'var(--tint-subtle)'
                      : 'transparent',
                }}
              >
                <div className="flex items-end gap-0.5" style={{ height: '14px' }}>
                  {[1, 2, 3].map((bar) => (
                    <div
                      key={bar}
                      className="rounded-sm"
                      style={{
                        width: '3.5px',
                        height: `${bar * 3 + 3}px`,
                        background: effort.bars >= bar ? effortBarColor : 'var(--fg-quaternary)',
                        opacity: effort.bars >= bar ? 1 : 0.2,
                      }}
                    />
                  ))}
                </div>
                <div className="flex-1">
                  <div className="text-[12px] font-medium" style={{ color: isActive ? 'var(--accent-bright)' : 'var(--fg-primary)' }}>
                    {effort.label}
                  </div>
                  <div className="text-[10.5px]" style={{ color: 'var(--fg-quaternary)' }}>{effort.desc}</div>
                </div>
                {isActive && (
                  <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent-primary)' }}>
                    <Check size={10} color="#fff" strokeWidth={3} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </PortalPopup>
    </div>
  )
})

/* ---------- ControlBar 主组件 ---------- */

export default function ControlBar({
  permissionMode, onPermissionModeChange, permissionModes,
  selectedModel, models, onModelSelect,
  thinkingEffort, onThinkingEffortChange, thinkingEfforts,
  disabled,
}: ControlBarProps) {
  return (
    <div
      className="flex items-center justify-between px-1 pt-1.5 pb-0.5"
      style={{
        borderTop: '1px solid var(--border-subtle)',
        marginTop: '2px',
      }}
    >
      {/* 左侧：权限模式 */}
      <PermissionSegmented
        modes={permissionModes}
        selected={permissionMode}
        onChange={onPermissionModeChange}
        disabled={disabled}
      />

      {/* 右侧：模型 + 思考等级 */}
      <div className="flex items-center gap-2.5">
        <ThinkingEffortPicker
          efforts={thinkingEfforts}
          selected={thinkingEffort}
          onChange={onThinkingEffortChange}
          disabled={disabled}
        />
        <div className="w-px h-3.5" style={{ background: 'var(--border-subtle)' }} />
        <ModelPickerInline
          models={models}
          selected={selectedModel}
          onSelect={onModelSelect}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
