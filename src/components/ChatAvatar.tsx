/**
 * 共享聊天头像组件 — Claude Code 助手头像 + 用户头像。
 * Agent 与 Chat 两种模式统一使用，保证视觉一致。
 */
import { memo } from 'react'

/** Claude Code 助手头像：紫色渐变圆底 + 星芒 logo（SVG） */
export const ClaudeAvatar = memo(function ClaudeAvatar({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        background: 'linear-gradient(145deg, #7c5bf5 0%, #a78bfa 40%, #c084fc 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(124,91,245,0.3), 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      {/* 星芒（Claude logo 风格） */}
      <svg
        width={size * 0.52}
        height={size * 0.52}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z" fill="#fff" stroke="none" />
        <circle cx="19" cy="17" r="2" fill="#fff" stroke="none" opacity="0.85" />
        <circle cx="5" cy="18" r="1.4" fill="#fff" stroke="none" opacity="0.7" />
      </svg>
    </div>
  )
})

/** 用户头像：深色圆底 + 人形图标 */
export const UserAvatar = memo(function UserAvatar({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        background: 'var(--bg-surface-3)',
        border: '1px solid var(--border-default)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <svg
        width={size * 0.5}
        height={size * 0.5}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--fg-tertiary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  )
})
