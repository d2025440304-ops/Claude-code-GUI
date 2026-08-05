/**
 * Shared code-rendering primitives used by both ChatView and
 * AgentMessageRenderer so they share the same syntax highlighting,
 * copy-button, and markdown formatting.
 */
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileCode, Copy, Check } from 'lucide-react'

// ---------------------------------------------------------------------------
// Syntax highlighting (lightweight keyword tokenizer — same as ChatView)
// ---------------------------------------------------------------------------

interface Token {
  type: 'str' | 'com' | 'num' | 'key' | 'type' | 'fn' | 'ident' | 'ws' | 'punct'
  value: string
}

const KEYWORDS = new Set([
  'import', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else',
  'try', 'catch', 'finally', 'async', 'await', 'new', 'class', 'extends',
  'interface', 'type', 'enum', 'public', 'private', 'readonly', 'static',
  'void', 'null', 'undefined', 'true', 'false', 'as', 'from', 'default',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'throw',
  'typeof', 'this', 'super', 'yield', 'delete',
])

export function tokenizeLine(line: string): Token[] {
  if (!line) return [{ type: 'ws', value: '\u00A0' }]
  const tokens: Token[] = []
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/\/[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|([\s\S])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m[1]) tokens.push({ type: 'str', value: m[1] })
    else if (m[2]) tokens.push({ type: 'com', value: m[2] })
    else if (m[3]) tokens.push({ type: 'num', value: m[3] })
    else if (m[4]) {
      const v = m[4]
      if (KEYWORDS.has(v)) tokens.push({ type: 'key', value: v })
      else if (/^[A-Z]/.test(v)) tokens.push({ type: 'type', value: v })
      else tokens.push({ type: 'ident', value: v })
    } else if (m[5]) tokens.push({ type: 'ws', value: m[5] })
    else tokens.push({ type: 'punct', value: m[6] })
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'ident') {
      let j = i + 1
      while (j < tokens.length && tokens[j].type === 'ws') j++
      if (j < tokens.length && tokens[j].value === '(') tokens[i].type = 'fn'
    }
  }
  return tokens
}

export function renderCodeTokens(tokens: Token[]): ReactNode[] {
  const cls: Record<string, string> = {
    str: 'tk-str', com: 'tk-com', num: 'tk-num', key: 'tk-key', type: 'tk-type', fn: 'tk-fn',
  }
  return tokens.map((t, i) => (
    <span key={i} className={cls[t.type] || 'tk-var'}>{t.value}</span>
  ))
}

// ---------------------------------------------------------------------------
// Code block with header (language badge + copy button)
// ---------------------------------------------------------------------------

export const CodeBlockView = memo(function CodeBlockView({ language, code }: { language: string; code: string }) {
  const lines = code.split('\n')
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch((err) => console.error('[CodeBlock] clipboard:', err))
  }
  return (
    <div className="code-block" style={{ margin: '12px 0' }}>
      <div className="code-header">
        <div className="flex items-center gap-2">
          <FileCode size={12} style={{ color: 'var(--accent-bright)' }} />
          <span style={{ color: 'var(--fg-secondary)', fontWeight: 500 }}>{language || 'text'}</span>
        </div>
        <button onClick={copy} className="code-copy" title="Copy code">
          {copied ? <Check size={12} style={{ color: 'var(--success)' }} /> : <Copy size={12} style={{ color: 'var(--fg-tertiary)' }} />}
        </button>
      </div>
      <div className="code-body" style={{ fontFamily: 'var(--font-mono)' }}>
        {lines.map((line, i) => (
          <div key={i} style={{ minHeight: '1.7em', whiteSpace: 'pre' }}>
            {renderCodeTokens(tokenizeLine(line))}
          </div>
        ))}
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// MarkdownContent — ReactMarkdown + remark-gfm + CodeBlockView
// ---------------------------------------------------------------------------

export function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }) => {
          const match = /language-(\w+)/.exec(className || '')
          if (match) {
            return <CodeBlockView language={match[1]} code={String(children).replace(/\n$/, '')} />
          }
          return <code>{children}</code>
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
