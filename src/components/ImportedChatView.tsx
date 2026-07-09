/**
 * 导入历史对话的只读视图。
 *
 * 用于渲染从 Claude Code（终端/VS Code）导入的历史对话记录，
 * 不支持发送消息或流式输出，仅用于查看。
 */
import { useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { User, Sparkles, Clock, Cpu } from 'lucide-react'

interface HistoryMessage {
  uuid: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  model?: string
  usage?: { inputTokens: number; outputTokens: number }
}

interface ImportedChatViewProps {
  messages: HistoryMessage[]
  title: string
  projectPath: string
  entrypoint: string
}

/** 格式化时间戳为可读时间 */
function formatTime(ts: string): string {
  if (!ts) return ''
  try {
    const date = new Date(ts)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts.slice(0, 16)
  }
}

/** 格式化 token 数量 */
function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export default function ImportedChatView({ messages, title, projectPath, entrypoint }: ImportedChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Clock size={32} className="text-[var(--fg-quaternary)]" />
          <span className="text-[13px] text-[var(--fg-tertiary)]">No messages in this conversation</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 对话信息头 */}
      <div
        className="flex-shrink-0 px-5 py-2.5 flex items-center gap-3 text-[11px]"
        style={{
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="flex items-center gap-1.5" style={{ color: 'var(--fg-quaternary)' }}>
          <Clock size={11} />
          <span>{formatTime(messages[0]?.timestamp)} — {formatTime(messages[messages.length - 1]?.timestamp)}</span>
        </div>
        <div className="w-px h-3" style={{ background: 'var(--border-subtle)' }} />
        <span style={{ color: 'var(--fg-quaternary)' }}>{messages.length} messages</span>
        <div className="w-px h-3" style={{ background: 'var(--border-subtle)' }} />
        <span style={{ color: 'var(--fg-quaternary)' }}>{entrypoint === 'vscode' ? 'VS Code' : 'Terminal'}</span>
      </div>

      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-6">
          {messages.map((msg) => (
            <div key={msg.uuid} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'user' ? (
                // 用户消息
                <div
                  className="max-w-[72%] px-4 py-2.5"
                  style={{
                    background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-bright))',
                    color: '#fff',
                    borderRadius: '18px 18px 4px 18px',
                    fontSize: '13.5px',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {msg.content}
                </div>
              ) : (
                // 助手消息
                <div className="flex gap-3 max-w-[85%]">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ background: 'var(--accent-subtle)' }}
                  >
                    <Sparkles size={14} className="text-[var(--accent-bright)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* 模型和 token 信息 */}
                    {(msg.model || msg.usage) && (
                      <div className="flex items-center gap-2 mb-1.5 text-[10px]" style={{ color: 'var(--fg-quaternary)' }}>
                        {msg.model && (
                          <div className="flex items-center gap-1">
                            <Cpu size={9} />
                            <span>{msg.model}</span>
                          </div>
                        )}
                        {msg.usage && (
                          <span>↑{formatTokens(msg.usage.inputTokens)} ↓{formatTokens(msg.usage.outputTokens)}</span>
                        )}
                      </div>
                    )}
                    {/* Markdown 内容 */}
                    <div className="prose">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
