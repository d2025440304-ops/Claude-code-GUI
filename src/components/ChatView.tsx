import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import type { KeyboardEvent, ClipboardEvent, DragEvent } from 'react'
import { ipc } from '../lib/ipc'
import { ArrowUp, FileCode, Sparkles, FolderOpen, Zap, Trash2, Plus, HelpCircle, Cpu, Square, Copy, Check, Paperclip, Image as ImageIcon, X as XIcon, Brain, Terminal, ChevronDown, AlertTriangle, GitBranch, Loader2 } from 'lucide-react'
import { MarkdownContent, CodeBlockView } from '../lib/codeRenderer'
import type { Message, ModelOption, Attachment, PermissionMode, PermissionModeOption, ThinkingEffort, ThinkingEffortOption, ContentBlock, DiffHunk } from '../types'
import ControlBar from './ControlBar'

/* ---------- slash commands ---------- */

export interface SlashCommand {
  id: string
  label: string
  description: string
  icon: typeof Zap
  shortcut?: string
}

function buildSlashCommands(models: ModelOption[], currentModel: string): SlashCommand[] {
  return [
    // 核心操作
    {
      id: 'model',
      label: 'Switch Model',
      description: `Current: ${models.find(m => m.id === currentModel)?.name || 'Default'}`,
      icon: Cpu,
      shortcut: '⌘M',
    },
    {
      id: 'new',
      label: 'New Chat',
      description: 'Start a new conversation',
      icon: Plus,
      shortcut: '⌘N',
    },
    {
      id: 'clear',
      label: 'Clear History',
      description: 'Remove all messages in this chat',
      icon: Trash2,
    },
    {
      id: 'compact',
      label: 'Compact Context',
      description: 'Compress conversation history to save tokens',
      icon: Zap,
    },
    {
      id: 'cost',
      label: 'Token Usage',
      description: 'Show token usage and cost for this session',
      icon: Zap,
    },
    {
      id: 'fast',
      label: 'Fast Mode',
      description: 'Toggle fast mode (Opus accelerated output)',
      icon: Zap,
    },
    // 会话管理
    {
      id: 'continue',
      label: 'Continue Chat',
      description: 'Continue the most recent conversation',
      icon: ArrowUp,
    },
    {
      id: 'help',
      label: 'Help & Shortcuts',
      description: 'Show available commands and shortcuts',
      icon: HelpCircle,
    },
    // 配置与诊断
    {
      id: 'config',
      label: 'Configuration',
      description: 'View or modify Claude Code settings',
      icon: HelpCircle,
    },
    {
      id: 'login',
      label: 'Login',
      description: 'Sign in to your Anthropic account',
      icon: HelpCircle,
    },
    {
      id: 'logout',
      label: 'Logout',
      description: 'Sign out of your Anthropic account',
      icon: HelpCircle,
    },
    {
      id: 'doctor',
      label: 'Diagnostics',
      description: 'Diagnose Claude Code configuration issues',
      icon: HelpCircle,
    },
    {
      id: 'permissions',
      label: 'Permissions',
      description: 'View and manage tool permissions',
      icon: HelpCircle,
    },
    // 代码与项目
    {
      id: 'init',
      label: 'Init Project',
      description: 'Initialize CLAUDE.md for this project',
      icon: FileCode,
    },
    {
      id: 'review',
      label: 'Review PR',
      description: 'Review the current pull request',
      icon: FileCode,
    },
    {
      id: 'pr-comments',
      label: 'PR Comments',
      description: 'View comments on the current PR',
      icon: FileCode,
    },
    {
      id: 'memory',
      label: 'Edit Memory',
      description: 'Edit memory files (CLAUDE.md)',
      icon: FileCode,
    },
    // 终端与集成
    {
      id: 'terminal-setup',
      label: 'Terminal Setup',
      description: 'Configure terminal integration',
      icon: HelpCircle,
    },
    {
      id: 'vim',
      label: 'Vim Mode',
      description: 'Toggle vim keybindings',
      icon: HelpCircle,
    },
    {
      id: 'mcp',
      label: 'MCP Servers',
      description: 'Manage MCP server connections',
      icon: HelpCircle,
    },
    // 技能型命令
    {
      id: 'deep-research',
      label: 'Deep Research',
      description: 'Multi-source research with fact-checking',
      icon: Zap,
    },
    {
      id: 'code-review',
      label: 'Code Review',
      description: 'Review code changes (--comment, --fix)',
      icon: FileCode,
    },
    {
      id: 'simplify',
      label: 'Simplify & Fix',
      description: 'Review and auto-fix code (code-review --fix)',
      icon: Zap,
    },
    {
      id: 'verify',
      label: 'Verify Changes',
      description: 'Verify code changes work as expected',
      icon: Zap,
    },
    {
      id: 'security-review',
      label: 'Security Review',
      description: 'Security review of pending branch changes',
      icon: HelpCircle,
    },
    {
      id: 'update-config',
      label: 'Update Config',
      description: 'Configure settings.json (hooks, permissions, env)',
      icon: HelpCircle,
    },
    {
      id: 'loop',
      label: 'Loop Command',
      description: 'Run a command on interval (e.g. /loop 5m /foo)',
      icon: Zap,
    },
    {
      id: 'run',
      label: 'Run App',
      description: 'Launch and drive the project app',
      icon: Zap,
    },
  ]
}

/* ---------- attachment helpers ---------- */

/** Read a clipboard/dropped File into a base64 data URL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Approximate byte size of a base64 data URL payload. */
function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(b64.length * 0.75) - pad)
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function nextAttachId(): string {
  return `att-${crypto.randomUUID()}`
}

/* ---------- attachment chips (input preview) ---------- */

const AttachmentPreview = memo(function AttachmentPreview({
  att,
  onRemove,
}: {
  att: Attachment
  onRemove: (id: string) => void
}) {
  if (att.kind === 'image' && att.dataUrl) {
    return (
      <div className="relative group" style={{ animation: 'fadeIn 150ms ease' }}>
        <img
          src={att.dataUrl}
          alt={att.name}
          className="rounded-lg object-cover"
          style={{ width: 56, height: 56, border: '1px solid var(--border-default)' }}
        />
        <button
          onClick={() => onRemove(att.id)}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center"
          style={{ background: 'var(--bg-surface-3)', color: 'var(--fg-secondary)' }}
          title="Remove"
        >
          <XIcon size={9} strokeWidth={2.5} />
        </button>
      </div>
    )
  }
  // file chip
  return (
    <div
      className="flex items-center gap-1.5 rounded-lg pl-2 pr-1 py-1 animate-fade-in"
      style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)', maxWidth: '220px' }}
    >
      <FileCode size={12} className="flex-shrink-0 text-[var(--accent-bright)]" />
      <span className="text-[11px] truncate" style={{ color: 'var(--fg-secondary)' }}>{att.name}</span>
      <button
        onClick={() => onRemove(att.id)}
        className="flex-shrink-0 p-0.5 rounded hover:bg-[var(--tint-hover)]"
        title="Remove"
      >
        <XIcon size={10} className="text-[var(--fg-tertiary)]" />
      </button>
    </div>
  )
})

/* ---------- types ---------- */

const ThinkingBlockView = memo(function ThinkingBlockView({ block }: { block: ContentBlock }) {
  const [expanded, setExpanded] = useState(false)
  const text = block.content || ''
  if (!text && block.status === 'streaming') return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'rgba(124,91,245,0.04)', border: '1px solid var(--border-subtle)' }}>
      <Brain size={12} className="text-[var(--fg-quaternary)] animate-pulse" />
      <span className="text-[11px] text-[var(--fg-quaternary)]">Thinking…</span>
    </div>
  )
  if (!text) return null
  const preview = text.length > 120 && !expanded ? text.slice(0, 120) + '…' : text
  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'rgba(124,91,245,0.04)', border: '1px solid var(--border-subtle)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--tint-hover)]"
      >
        <Brain size={12} className="text-[var(--fg-quaternary)] flex-shrink-0" />
        <span className="text-[11px] font-medium text-[var(--fg-quaternary)] flex-1">Thinking</span>
        <ChevronDown
          size={11}
          className="text-[var(--fg-quaternary)] transition-transform"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>
      <div
        className="px-3 pb-2 text-[12px] leading-relaxed font-mono"
        style={{
          color: 'var(--fg-tertiary)',
          fontStyle: 'italic',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: expanded ? 'none' : '60px',
          overflow: 'hidden',
        }}
      >
        {expanded ? text : preview}
      </div>
    </div>
  )
})

/** Bash 命令 + 执行结果 */
const BashBlockView = memo(function BashBlockView({ block }: { block: ContentBlock }) {
  const input = block.toolInput
  const cmd = typeof input?.command === 'string' ? input.command : ''
  const desc = typeof input?.description === 'string' ? input.description : ''
  const isRunning = block.status === 'streaming'
  const hasResult = block.status === 'completed' || block.status === 'error'

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'var(--code-bg)', border: '1px solid var(--border-default)' }}>
      {/* 标题栏 */}
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ background: 'var(--code-header-bg)', borderBottom: '1px solid var(--border-subtle)' }}>
        <Terminal size={11} style={{ color: 'var(--success)' }} />
        <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--fg-secondary)' }}>
          {desc || 'Bash'}
        </span>
        {isRunning && <Loader2 size={11} className="animate-spin text-[var(--fg-quaternary)] ml-auto" />}
        {hasResult && !block.isError && <Check size={11} className="text-[var(--success)] ml-auto" />}
        {block.isError && <XIcon size={11} className="text-[var(--danger)] ml-auto" />}
      </div>
      {/* 命令 */}
      {cmd && (
        <div className="px-3 py-2 font-mono text-[12px] leading-relaxed" style={{ color: '#e0e0e0' }}>
          <span style={{ color: 'var(--success)' }}>$ </span>{cmd}
        </div>
      )}
      {/* stdout */}
      {block.stdout && (
        <div className="px-3 py-2 font-mono text-[11px] leading-relaxed" style={{ color: '#94a3b8', borderTop: '1px solid var(--border-subtle)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflow: 'auto' }}>
          {block.stdout}
        </div>
      )}
      {/* stderr */}
      {block.stderr && (
        <div className="px-3 py-2 font-mono text-[11px] leading-relaxed" style={{ color: 'var(--danger)', borderTop: '1px solid var(--border-subtle)', whiteSpace: 'pre-wrap' }}>
          {block.stderr}
        </div>
      )}
    </div>
  )
})

/** Diff 渲染：Edit / Write 工具的 structuredPatch */
const DiffBlockView = memo(function DiffBlockView({ block }: { block: ContentBlock }) {
  const filePath = block.filePath || ''
  const patch = block.diff || []
  if (patch.length === 0 && !block.content) return null

  // content 可能是 Write 工具的完整内容（无 diff）
  if (patch.length === 0 && block.content) {
    return (
      <div className="rounded-lg overflow-hidden" style={{ background: 'var(--code-bg)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-center gap-2 px-3 py-1.5" style={{ background: 'var(--code-header-bg)', borderBottom: '1px solid var(--border-subtle)' }}>
          <FileCode size={11} style={{ color: 'var(--accent-bright)' }} />
          <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--fg-secondary)' }}>{filePath}</span>
          <Check size={11} className="text-[var(--success)] ml-auto" />
        </div>
        <div className="px-3 py-2 font-mono text-[11px] leading-relaxed" style={{ color: '#94a3b8', whiteSpace: 'pre-wrap', maxHeight: '300px', overflow: 'auto' }}>
          {block.content}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'var(--code-bg)', border: '1px solid var(--border-default)' }}>
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ background: 'var(--code-header-bg)', borderBottom: '1px solid var(--border-subtle)' }}>
        <GitBranch size={11} style={{ color: 'var(--accent-bright)' }} />
        <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--fg-secondary)' }}>{filePath}</span>
        {!block.isError && <Check size={11} className="text-[var(--success)] ml-auto" />}
      </div>
      <div className="font-mono text-[11px] leading-relaxed" style={{ maxHeight: '400px', overflow: 'auto' }}>
        {patch.map((hunk, hi) => (
          <div key={hi}>
            <div className="px-3 py-1" style={{ color: 'var(--fg-quaternary)', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid var(--border-subtle)' }}>
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, li) => {
              const prefix = line[0] || ' '
              const text = line.slice(1)
              const style = prefix === '+' ? { color: 'var(--success)', background: 'rgba(48,209,88,0.08)' }
                : prefix === '-' ? { color: 'var(--danger)', background: 'rgba(255,69,58,0.08)' }
                : { color: '#94a3b8' }
              return (
                <div key={li} className="px-3" style={{ ...style, whiteSpace: 'pre' }}>
                  {prefix}{text}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
})

/** Read / 其他工具结果 */
const ToolResultPlain = memo(function ToolResultPlain({ block }: { block: ContentBlock }) {
  const text = block.content || block.stdout || ''
  if (!text) return null
  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'var(--code-bg)', border: '1px solid var(--border-default)' }}>
      {block.filePath && (
        <div className="flex items-center gap-2 px-3 py-1.5" style={{ background: 'var(--code-header-bg)', borderBottom: '1px solid var(--border-subtle)' }}>
          <FileCode size={11} style={{ color: 'var(--accent-bright)' }} />
          <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--fg-secondary)' }}>{block.filePath}</span>
        </div>
      )}
      <div className="px-3 py-2 font-mono text-[11px] leading-relaxed" style={{ color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflow: 'auto' }}>
        {text}
      </div>
    </div>
  )
})

/** 权限拒绝气泡：一键批准重发 */
const PermissionBubble = memo(function PermissionBubble({
  block,
  onResendWithPermission,
}: {
  block: ContentBlock
  onResendWithPermission?: () => void
}) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'rgba(255,214,10,0.06)', border: '1px solid rgba(255,214,10,0.2)' }}>
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <AlertTriangle size={14} style={{ color: 'var(--warn)' }} className="flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium" style={{ color: 'var(--warn)' }}>
            权限不足
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>
            {block.content || `Claude 请求执行 ${block.toolName || '操作'} 但未被授权`}
          </div>
          {block.toolName && (
            <div className="text-[10px] mt-1 font-mono px-2 py-0.5 rounded" style={{ color: 'var(--fg-quaternary)', background: 'var(--tint-subtle)' }}>
              {block.toolName}
              {block.toolInput && typeof block.toolInput.command === 'string' && `: ${block.toolInput.command.slice(0, 80)}`}
            </div>
          )}
          {onResendWithPermission && (
            <button
              onClick={onResendWithPermission}
              className="mt-2 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors flex items-center gap-1.5"
              style={{ background: 'rgba(124,91,245,0.12)', color: 'var(--accent-bright)', border: '1px solid rgba(124,91,245,0.25)' }}
            >
              <Check size={11} />
              批准并重试
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

/** 根据 block 类型渲染对应组件 */
function renderContentBlock(block: ContentBlock, onResendWithPermission?: () => void): React.ReactNode {
  switch (block.type) {
    case 'text':
      return null // text 通过 prose 渲染，不走 block 组件
    case 'thinking':
      return <ThinkingBlockView key={block.id} block={block} />
    case 'tool_use':
      // 根据 toolName 分发到不同渲染器
      if (block.toolName === 'Bash') return <BashBlockView key={block.id} block={block} />
      if (block.diff && block.diff.length > 0) return <DiffBlockView key={block.id} block={block} />
      if (block.stdout || block.content) return <ToolResultPlain key={block.id} block={block} />
      // streaming 中的其他工具：只显示名称
      return (
        <div key={block.id} className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
          {block.status === 'streaming' ? <Loader2 size={11} className="animate-spin text-[var(--fg-quaternary)]" /> : <FileCode size={11} className="text-[var(--fg-quaternary)]" />}
          <span className="text-[11px] font-medium" style={{ color: 'var(--fg-tertiary)' }}>{block.toolName || 'Tool'}</span>
        </div>
      )
    case 'tool_result':
      if (block.isError && block.content) return <PermissionBubble key={block.id} block={block} onResendWithPermission={onResendWithPermission} />
      if (block.diff && block.diff.length > 0) return <DiffBlockView key={block.id} block={block} />
      if (block.stdout) return <BashBlockView key={block.id} block={block} />
      return <ToolResultPlain key={block.id} block={block} />
    case 'permission_denial':
      return <PermissionBubble key={block.id} block={block} onResendWithPermission={onResendWithPermission} />
    default:
      return null
  }
}

/* ---------- message bubbles ---------- */

const UserAttachments = memo(function UserAttachments({ atts }: { atts: Attachment[] }) {
  if (!atts.length) return null
  const images = atts.filter((a) => a.kind === 'image' && a.dataUrl)
  const files = atts.filter((a) => a.kind !== 'image' || !a.dataUrl)
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 justify-end" style={{ maxWidth: '72%' }}>
          {images.map((a) => (
            <img key={a.id} src={a.dataUrl} alt={a.name} className="rounded-xl object-cover"
              style={{ width: 120, height: 120, border: '1px solid var(--border-default)' }} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col items-end gap-1" style={{ maxWidth: '72%' }}>
          {files.map((a) => (
            <div key={a.id} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
              style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)' }}>
              <FileCode size={12} className="text-[var(--accent-bright)]" />
              <span className="text-[11px] font-mono truncate" style={{ color: 'var(--fg-secondary)', maxWidth: '180px' }}>{a.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

const UserMessage = memo(function UserMessage({ msg, idx }: { msg: Message; idx: number }) {
  const atts = msg.attachments ?? []
  return (
    <div className="flex flex-col items-end gap-1.5 animate-fade-in" style={{ animationDelay: `${idx * 30}ms` }}>
      {msg.content && (
        <div
          className="px-4 py-3 text-[14px] leading-relaxed"
          style={{
            background: 'linear-gradient(135deg, var(--accent-primary) 0%, #7c3aed 100%)',
            borderRadius: '18px 18px 4px 18px',
            maxWidth: '72%',
            color: '#fff',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            boxShadow: '0 2px 8px rgba(99,102,241,0.25)',
          }}
        >
          {msg.content}
        </div>
      )}
      <UserAttachments atts={atts} />
      <span className="text-[10px] px-1.5" style={{ color: 'var(--fg-quaternary)' }}>{fmtTime(msg.timestamp)}</span>
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({
  msg, idx, onResendWithPermission,
}: {
  msg: Message; idx: number; onResendWithPermission?: () => void
}) {
  const blocks = msg.contentBlocks
  const hasBlocks = blocks && blocks.length > 0

  // 纯文本版 content（向后兼容 / 无 blocks 时）
  const textContent = useMemo(() => <MarkdownContent text={msg.content} />,[msg.content])

  const [copied, setCopied] = useState(false)
  const [hovered, setHovered] = useState(false)
  const copy = () => {
    const text = hasBlocks
      ? blocks!.filter(b => b.type === 'text').map(b => b.content || '').join('')
      : msg.content
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }

  return (
    <div
      className="group flex flex-col gap-3 animate-fade-in"
      style={{ animationDelay: `${idx * 30}ms` }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex gap-3">
        <div
          className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, #a855f7 100%)' }}
        >
          <Sparkles size={13} color="#fff" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--fg-primary)' }}>Claude</span>
            <span className="text-[10px] font-medium" style={{ color: 'var(--fg-quaternary)' }}>{fmtTime(msg.timestamp)}</span>
            <button
              onClick={copy}
              className="ml-auto p-1 rounded-md transition-opacity hover:bg-[var(--tint-hover)]"
              style={{ opacity: hovered ? 1 : 0 }}
              title="Copy message"
            >
              {copied ? <Check size={12} style={{ color: 'var(--success)' }} /> : <Copy size={12} style={{ color: 'var(--fg-tertiary)' }} />}
            </button>
          </div>

          {hasBlocks ? (
            <div className="flex flex-col gap-2.5">
              {blocks!.map((block) => {
                // text block 通过 prose 渲染
                if (block.type === 'text' && block.content) {
                  return <div key={block.id} className="prose"><MarkdownContent text={block.content} /></div>
                }
                // 其他 block 通过专用组件渲染
                return renderContentBlock(block, onResendWithPermission)
              })}
            </div>
          ) : (
            msg.content && <div className="prose">{textContent}</div>
          )}
        </div>
      </div>
    </div>
  )
})

/* ---------- time formatter ---------- */

function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
 return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/* ---------- stream activity indicator (above the input) ---------- */

function toolActivityLabel(tool?: string): string {
  switch (tool) {
    case 'Read': return 'Reading files…'
    case 'Write': return 'Writing code…'
    case 'Edit':
    case 'MultiEdit': return 'Editing code…'
    case 'Bash': return 'Running command…'
    case 'Glob':
    case 'Grep': return 'Searching…'
    case 'WebFetch':
    case 'WebSearch': return 'Searching the web…'
    case 'TodoWrite': return 'Planning…'
    default: return tool ? `${tool}…` : 'Working…'
  }
}

/** Derive the current backend activity from the streaming message's last block. */
function deriveStreamActivity(msg: Message | undefined): string | null {
  if (!msg || msg.role !== 'assistant') return null
  const blocks = msg.contentBlocks
  if (!blocks || blocks.length === 0) return 'Thinking…'
  const last = blocks[blocks.length - 1]
  switch (last.type) {
    case 'thinking': return 'Thinking…'
    case 'text': return 'Responding…'
    case 'tool_use': return toolActivityLabel(last.toolName)
    case 'tool_result': return 'Thinking…'
    case 'permission_denial': return 'Awaiting permission…'
    default: return 'Working…'
  }
}

const StreamActivityBar = memo(function StreamActivityBar({ label }: { label: string | null }) {
  if (!label) return null
  return (
    <div
      className="flex items-center gap-2 mb-2 px-1 animate-fade-in"
      style={{ height: 20, color: 'var(--fg-tertiary)', fontFamily: 'var(--font-sans)' }}
    >
      <span
        style={{
          width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-primary)',
          animation: 'stream-pulse 1.2s ease-in-out infinite',
        }}
      />
      <span className="text-[12px] font-medium" style={{ letterSpacing: 0.1 }}>{label}</span>
    </div>
  )
})

/* ---------- ChatView ---------- */

export interface ChatViewProps {
  messages: Message[]
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  isStreaming: boolean
  loading?: boolean
  project: { name: string; path: string } | null
  models: ModelOption[]
  selectedModel: string
  onModelSelect: (modelId: string) => void
  onClearChat: () => void
  onNewChat: () => void
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  permissionModes: PermissionModeOption[]
  /** 权限拒绝后一键批准重发（自动切到 auto-edit 模式） */
  onResendWithPermission?: () => void
  thinkingEffort: ThinkingEffort
  onThinkingEffortChange: (effort: ThinkingEffort) => void
  thinkingEfforts: ThinkingEffortOption[]
}

export default function ChatView({
  messages, onSend, onStop, isStreaming, loading, project,
  models, selectedModel, onModelSelect, onClearChat, onNewChat,
  permissionMode, onPermissionModeChange, permissionModes,
  onResendWithPermission,
  thinkingEffort, onThinkingEffortChange, thinkingEfforts,
}: ChatViewProps) {
  const [inputText, setInputText] = useState('')
  const [focused, setFocused] = useState(false)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [showModelPicker, setShowModelPicker] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)

  const addAttachment = useCallback((att: Attachment) => {
    setAttachments((prev) => [...prev, att])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const addImageFromDataUrl = useCallback((dataUrl: string, name: string, mimeType: string, size: number) => {
    addAttachment({
      id: nextAttachId(), kind: 'image', name, size: size || dataUrlByteSize(dataUrl),
      mimeType, dataUrl,
    })
  }, [addAttachment])

  const addFilePath = useCallback((filePath: string) => {
    addAttachment({
      id: nextAttachId(), kind: 'file', name: basename(filePath), size: 0, path: filePath,
    })
  }, [addAttachment])

  // Upload files via native dialog (returns absolute paths).
  const handleAddFiles = useCallback(async () => {
    try {
      const res = await ipc.invoke<{ canceled: boolean; filePaths: string[] }>('attachment:open-files', { imagesOnly: false })
      if (!res.canceled) res.filePaths.forEach(addFilePath)
    } catch (e) { console.error('Failed to open files:', e) }
  }, [addFilePath])

  // Upload images via native dialog -> read as base64 data URL.
  const handleAddImages = useCallback(async () => {
    try {
      const res = await ipc.invoke<{ canceled: boolean; filePaths: string[] }>('attachment:open-files', { imagesOnly: true })
      if (res.canceled) return
      for (const fp of res.filePaths) {
        const r = await ipc.invoke<{ dataUrl: string; mimeType: string } | null>('attachment:read-data-url', { filePath: fp })
        if (r) addImageFromDataUrl(r.dataUrl, basename(fp), r.mimeType, 0)
      }
    } catch (e) { console.error('Failed to open images:', e) }
  }, [addImageFromDataUrl])

  // Paste: images (clipboard screenshot) -> data URL; files (Finder copy) -> paths.
  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const arr = Array.from(items)
    const imageItems = arr.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (imageItems.length > 0) {
      e.preventDefault()
      for (const it of imageItems) {
        const file = it.getAsFile()
        if (!file) continue
        try {
          const dataUrl = await readFileAsDataUrl(file)
          addImageFromDataUrl(dataUrl, file.name || 'pasted-image.png', file.type, file.size)
        } catch (err) { console.error('Failed to read pasted image:', err) }
      }
      return
    }
    // Non-image file paste (e.g. file copied in Finder): resolve paths via main.
    const hasFile = arr.some((it) => it.kind === 'file')
    if (hasFile) {
      e.preventDefault()
      try {
        const paths = await ipc.invoke<string[]>('attachment:clipboard-files')
        paths.forEach(addFilePath)
      } catch (err) { console.error('Failed to read clipboard files:', err) }
    }
  }, [addImageFromDataUrl, addFilePath])

  // Drag-and-drop: images read as data URL; other files resolved to paths.
  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        try {
          const dataUrl = await readFileAsDataUrl(file)
          addImageFromDataUrl(dataUrl, file.name || 'dropped-image.png', file.type, file.size)
        } catch (err) { console.error('Failed to read dropped image:', err) }
      } else {
        // Electron exposes the absolute path on dropped File objects.
        const fp = (file as File & { path?: string }).path
        if (fp) addFilePath(fp)
      }
    }
  }, [addImageFromDataUrl, addFilePath])

  const slashCommands = useMemo(() => buildSlashCommands(models, selectedModel), [models, selectedModel])

  // Detect slash command mode
  const isCmdMode = inputText.startsWith('/') && !inputText.includes(' ')
  const cmdQuery = inputText.slice(1).toLowerCase()
  const filteredCmds = useMemo(() => {
    if (!isCmdMode) return []
    return slashCommands.filter(c => c.id.startsWith(cmdQuery) || c.label.toLowerCase().includes(cmdQuery))
  }, [isCmdMode, cmdQuery, slashCommands])

  // Reset cmdIndex when filtered list changes
  useEffect(() => {
    setCmdIndex(0)
  }, [cmdQuery])

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const firstMsgIdRef = useRef<string | undefined>(undefined)

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    const firstId = messages[0]?.id
    const switched = firstId !== firstMsgIdRef.current
    firstMsgIdRef.current = firstId
    if (switched) atBottomRef.current = true
    if (atBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: switched || isStreaming ? 'auto' : 'smooth' })
    }
  }, [messages, isStreaming])

  // Auto-grow the textarea up to its max height.
  useEffect(() => {
    const el = inputRef.current
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px' }
  }, [inputText])

  // Current backend activity, derived from the streaming message (bar above the input).
  const streamActivity = useMemo(
    () => (isStreaming ? deriveStreamActivity(messages[messages.length - 1]) : null),
    [isStreaming, messages],
  )

  const hasAttachments = attachments.length > 0
  const canSend = (inputText.trim().length > 0 || hasAttachments) && !isStreaming && !isCmdMode

  const executeCommand = (cmd: SlashCommand) => {
    setInputText('')
    switch (cmd.id) {
      case 'model':
        setShowModelPicker(true)
        break
      case 'new':
        onNewChat()
        break
      case 'clear':
        onClearChat()
        break
      case 'help':
        onSend('/help', [])
        break
      case 'compact':
        onSend('/compact', [])
        break
      case 'cost':
        onSend('/cost', [])
        break
      case 'fast':
        onSend('/fast', [])
        break
      case 'continue':
        onSend('/continue', [])
        break
      case 'config':
        onSend('/config', [])
        break
      case 'login':
        onSend('/login', [])
        break
      case 'logout':
        onSend('/logout', [])
        break
      case 'doctor':
        onSend('/doctor', [])
        break
      case 'permissions':
        onSend('/permissions', [])
        break
      case 'init':
        onSend('/init', [])
        break
      case 'review':
        onSend('/review', [])
        break
      case 'pr-comments':
        onSend('/pr-comments', [])
        break
      case 'memory':
        onSend('/memory', [])
        break
      case 'terminal-setup':
        onSend('/terminal-setup', [])
        break
      case 'vim':
        onSend('/vim', [])
        break
      case 'mcp':
        onSend('/mcp', [])
        break
      case 'deep-research':
        onSend('/deep-research', [])
        break
      case 'code-review':
        onSend('/code-review', [])
        break
      case 'simplify':
        onSend('/simplify', [])
        break
      case 'verify':
        onSend('/verify', [])
        break
      case 'security-review':
        onSend('/security-review', [])
        break
      case 'update-config':
        onSend('/update-config', [])
        break
      case 'loop':
        onSend('/loop', [])
        break
      case 'run':
        onSend('/run', [])
        break
      default:
        // 未知命令直接发送
        onSend(`/${cmd.id}`, [])
        break
    }
  }

  const handleSend = () => {
    if (!canSend) return
    const text = inputText.trim()
    const atts = attachments
    setInputText('')
    setAttachments([])
    onSend(text, atts)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command navigation
    if (isCmdMode && filteredCmds.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIndex(i => (i + 1) % filteredCmds.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIndex(i => (i - 1 + filteredCmds.length) % filteredCmds.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        executeCommand(filteredCmds[cmdIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setInputText('')
        return
      }
    }
    // Model picker navigation
    if (showModelPicker) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowModelPicker(false)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {loading && <div className="loading-bar" />}

      {/* Message stream */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-6">

          {/* Empty state */}
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center py-28 gap-5 animate-fade-in">
              {/* Logo with subtle glow */}
              <div className="relative mb-1">
                <div
                  className="absolute inset-0 rounded-2xl blur-2xl opacity-40"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), #a78bfa)', transform: 'scale(2)' }}
                />
                <div
                  className="relative w-16 h-16 rounded-2xl flex items-center justify-center"
                  style={{ background: 'linear-gradient(145deg, var(--accent-primary) 0%, #a78bfa 50%, #c084fc 100%)', boxShadow: '0 4px 24px rgba(124,91,245,0.3)' }}
                >
                  <Sparkles size={28} color="#fff" strokeWidth={1.8} />
                </div>
              </div>
              <div className="flex flex-col items-center gap-2">
                <span className="text-[17px] font-semibold" style={{ color: 'var(--fg-primary)', letterSpacing: '-0.025em' }}>
                  How can I help you today?
                </span>
                <span className="text-[13px]" style={{ color: 'var(--fg-tertiary)' }}>
                  Start coding with Claude
                </span>
              </div>
              {/* Quick action chips — minimal */}
              <div className="flex flex-wrap justify-center gap-2 mt-1">
                {['Explain code', 'Fix bugs', 'Write tests', 'Refactor'].map((s) => (
                  <button
                    key={s}
                    onClick={() => onSend(s, [])}
                    className="quick-action-chip px-3.5 py-1.5 rounded-full text-[12px] font-medium"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--fg-tertiary)',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, idx) =>
            msg.role === 'user'
              ? <UserMessage key={msg.id} msg={msg} idx={idx} />
              : <AssistantMessage
                  key={msg.id}
                  msg={msg}
                  idx={idx}
                  onResendWithPermission={onResendWithPermission}
                />
          )}

          {/* Typing indicator (only before the first token arrives) */}
          {isStreaming && (!messages.length || messages[messages.length - 1].role !== 'assistant' || !messages[messages.length - 1].content) && (
            <div className="flex gap-3 animate-fade-in">
              <div
                className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, #a855f7 100%)' }}
              >
                <Sparkles size={13} color="#fff" />
              </div>
              <div className="flex items-center gap-1.5 h-7 px-1">
                <span className="typing-dot w-2 h-2 rounded-full inline-block" style={{ background: 'var(--accent-bright)' }} />
                <span className="typing-dot w-2 h-2 rounded-full inline-block" style={{ background: 'var(--accent-bright)' }} />
                <span className="typing-dot w-2 h-2 rounded-full inline-block" style={{ background: 'var(--accent-bright)' }} />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-6 pb-5 pt-2">
        <div className="max-w-3xl mx-auto relative">
          {/* Slash command palette */}
          {isCmdMode && filteredCmds.length > 0 && (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl overflow-hidden animate-scale-in"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 30,
              }}
            >
              <div className="px-3.5 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <Zap size={11} className="text-[var(--accent-bright)]" />
                <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.08em' }}>Commands</span>
              </div>
              <div className="py-1 max-h-[240px] overflow-y-auto">
                {filteredCmds.map((cmd, i) => {
                  const Icon = cmd.icon
                  const active = i === cmdIndex
                  return (
                    <div
                      key={cmd.id}
                      onClick={() => executeCommand(cmd)}
                      onMouseEnter={() => setCmdIndex(i)}
                      className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors"
                      style={{ background: active ? 'var(--accent-subtle)' : 'transparent' }}
                    >
                      <div
                        className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                        style={{
                          background: active ? 'rgba(99,102,241,0.15)' : 'var(--bg-surface-2)',
                          color: active ? 'var(--accent-bright)' : 'var(--fg-tertiary)',
                        }}
                      >
                        <Icon size={13} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium" style={{ color: active ? 'var(--fg-primary)' : 'var(--fg-secondary)' }}>
                          /{cmd.id}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: 'var(--fg-quaternary)' }}>
                          {cmd.description}
                        </div>
                      </div>
                      {cmd.shortcut && (
                        <span
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                          style={{ color: 'var(--fg-quaternary)', background: 'var(--tint-subtle)' }}
                        >
                          {cmd.shortcut}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Model picker popover */}
          {showModelPicker && (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl overflow-hidden animate-scale-in"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 30,
              }}
            >
              <div className="px-3.5 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <Cpu size={11} className="text-[var(--accent-bright)]" />
                <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.08em' }}>Select Model</span>
              </div>
              <div className="py-1">
                {models.map((m) => {
                  const active = m.id === selectedModel
                  return (
                    <div
                      key={m.id}
                      onClick={() => { onModelSelect(m.id); setShowModelPicker(false) }}
                      className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors"
                      style={{ background: active ? 'var(--accent-subtle)' : 'transparent' }}
                    >
                      <div className="flex-1">
                        <div className="text-[12.5px] font-medium" style={{ color: active ? 'var(--accent-bright)' : 'var(--fg-secondary)' }}>
                          {m.name}
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--fg-quaternary)' }}>
                          {m.desc}
                        </div>
                      </div>
                      {active && (
                        <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-primary)' }}>
                          <span style={{ color: '#fff', fontSize: '9px', fontWeight: 700 }}>✓</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <StreamActivityBar label={streamActivity} />

          <div
            className="rounded-2xl overflow-hidden transition-all"
            style={{
              background: 'var(--bg-surface)',
              border: `1px solid ${dragOver ? 'var(--accent-bright)' : focused ? 'var(--accent-primary)' : 'var(--border-default)'}`,
              boxShadow: (focused || dragOver)
                ? '0 0 0 3px rgba(124,91,245,0.10), var(--shadow-md)'
                : 'var(--shadow-sm)',
              transition: 'border-color 200ms ease, box-shadow 200ms ease',
            }}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3.5 pt-3">
                {attachments.map((att) => (
                  <AttachmentPreview key={att.id} att={att} onRemove={removeAttachment} />
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={isCmdMode ? 'Type a command…' : dragOver ? 'Drop here…' : 'Message Claude…'}
              rows={3}
              className="w-full bg-transparent resize-none outline-none px-4 pt-3.5 pb-2 text-[14px]"
              style={{ color: 'var(--fg-primary)', fontFamily: 'var(--font-sans)', maxHeight: '180px', lineHeight: '1.6' }}
            />
            <div className="flex items-center justify-between px-3.5 pb-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddFiles}
                  className="p-1.5 rounded-lg transition-colors hover:bg-[var(--tint-hover)]"
                  style={{ color: 'var(--fg-tertiary)' }}
                  title="Attach files"
                >
                  <Paperclip size={14} />
                </button>
                <button
                  onClick={handleAddImages}
                  className="p-1.5 rounded-lg transition-colors hover:bg-[var(--tint-hover)]"
                  style={{ color: 'var(--fg-tertiary)' }}
                  title="Attach images"
                >
                  <ImageIcon size={14} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                {inputText.length > 0 && (
                  <span className="text-[11px] tabular-nums font-medium" style={{ color: 'var(--fg-quaternary)' }}>
                    {inputText.length}
                  </span>
                )}
                {isStreaming ? (
                  <button
                    onClick={onStop}
                    className="h-8 w-8 rounded-xl flex items-center justify-center transition-all"
                    style={{ background: 'var(--danger)', color: '#fff', boxShadow: '0 2px 8px rgba(255,69,58,0.35)' }}
                    title="Stop generating"
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="h-8 w-8 rounded-xl flex items-center justify-center transition-all"
                    style={canSend
                      ? {
                          background: 'linear-gradient(135deg, var(--accent-primary) 0%, #6b4de6 100%)',
                          color: '#fff',
                          boxShadow: '0 2px 10px rgba(124,91,245,0.35)',
                        }
                      : {
                          background: 'var(--bg-surface-2)',
                          color: 'var(--fg-quaternary)',
                          cursor: 'not-allowed',
                        }
                    }
                    title="Send message"
                  >
                    <ArrowUp size={15} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 控制栏：权限模式 / 模型 / 思考等级 */}
          <ControlBar
            permissionMode={permissionMode}
            onPermissionModeChange={onPermissionModeChange}
            permissionModes={permissionModes}
            selectedModel={selectedModel}
            models={models}
            onModelSelect={onModelSelect}
            thinkingEffort={thinkingEffort}
            onThinkingEffortChange={onThinkingEffortChange}
            thinkingEfforts={thinkingEfforts}
            disabled={isStreaming}
          />
        </div>
      </div>
    </div>
  )
}
