import { useState } from 'react';
import type { Attachment } from '../types';
import {
  ChevronRight, ChevronDown, Loader2, Check, AlertCircle, Wrench,
  FileText, Search, Terminal, Eye, FileCode,
  Globe, Brain, Sparkles, ListTodo,
} from 'lucide-react';
import { MarkdownContent } from '../lib/codeRenderer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMessageBlock {
  id: string;
  type: 'user_text' | 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content?: string;
  /** 用户消息附带的图片/文件（发送后即时显示） */
  attachments?: Attachment[];
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolError?: boolean;
  filePath?: string;
  diff?: string[];
  isStreaming?: boolean;
  status?: 'running' | 'completed' | 'error';
}

// ---------------------------------------------------------------------------
// Tool icons
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, typeof Wrench> = {
  Bash: Terminal,
  Edit: FileCode,
  Write: FileText,
  MultiEdit: FileCode,
  Read: Eye,
  Grep: Search,
  Glob: Search,
  Agent: Brain,
  WebSearch: Globe,
  WebFetch: Globe,
  NotebookEdit: FileCode,
  Skill: Sparkles,
  TodoWrite: ListTodo,
};

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export function AgentMessageBlockRenderer({ block }: { block: AgentMessageBlock }) {
  switch (block.type) {
    case 'user_text':
      return <UserTextBlock text={block.content || ''} attachments={block.attachments} />;
    case 'text':
      return <TextBlock text={block.content || ''} isStreaming={block.isStreaming} />;
    case 'thinking':
      return <ThinkingBlock text={block.content || ''} />;
    case 'tool_use':
      return <ToolUseBlock block={block} />;
    case 'tool_result':
      return <ToolResultBlock block={block} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// User message bubble
// ---------------------------------------------------------------------------

function UserTextBlock({ text, attachments }: { text: string; attachments?: Attachment[] }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        marginBottom: 24,
      }}
      className="message-enter"
    >
      <div
        style={{
          maxWidth: '70%',
          background: 'var(--accent-subtle, rgba(124,91,245,0.08))',
          border: '1px solid rgba(124,91,245,0.12)',
          borderRadius: '16px 16px 4px 16px',
          padding: '12px 16px',
          fontSize: 13.5,
          lineHeight: 1.65,
          color: 'var(--fg-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {attachments && attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: text ? 10 : 0, justifyContent: 'flex-end' }}>
            {attachments.map((att) => {
              if (att.kind === 'image' && att.dataUrl) {
                return (
                  <img
                    key={att.id}
                    src={att.dataUrl}
                    alt={att.name}
                    style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(124,91,245,0.2)' }}
                  />
                );
              }
              return (
                <span
                  key={att.id}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]"
                  style={{ background: 'rgba(124,91,245,0.12)', border: '1px solid rgba(124,91,245,0.2)', color: 'var(--fg-secondary)' }}
                >
                  <FileCode size={11} />
                  {att.name}
                </span>
              );
            })}
          </div>
        )}
        {text}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant text block
// ---------------------------------------------------------------------------

function TextBlock({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  return (
    <div
      style={{
        fontSize: 13.5,
        lineHeight: 1.65,
        color: 'var(--fg-primary)',
        marginBottom: 12,
      }}
      className={`prose message-enter ${isStreaming ? 'streaming-cursor' : ''}`}
    >
      <MarkdownContent text={text} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thinking block (collapsible)
// ---------------------------------------------------------------------------

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 0',
          fontSize: 10,
          color: 'var(--fg-quaternary)',
          fontStyle: 'italic',
        }}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Thinking
      </button>
      <div
        style={{
          maxHeight: expanded ? 500 : 0,
          opacity: expanded ? 1 : 0,
          overflow: 'hidden',
          transition: 'max-height 300ms ease, opacity 200ms ease',
          paddingLeft: 12,
          borderLeft: '2px solid var(--border-subtle)',
          color: 'var(--fg-tertiary)',
          fontSize: 12,
          fontStyle: 'italic',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool use card
// ---------------------------------------------------------------------------

function ToolUseBlock({ block }: { block: AgentMessageBlock }) {
  const [showParams, setShowParams] = useState(false);
  const Icon = TOOL_ICONS[block.toolName || ''] || Wrench;
  const isRunning = block.status === 'running';
  const isError = block.status === 'error' || block.toolError;
  const summary = getToolSummary(block.toolName || '', block.toolInput || {});

  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${isError ? 'rgba(255,69,58,0.2)' : 'var(--border-subtle)'}`,
        marginBottom: 8,
        overflow: 'hidden',
        background: 'var(--bg-elevated)',
      }}
    >
      {/* Header row */}
      <div
        onClick={() => block.toolInput && setShowParams(!showParams)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: block.toolInput ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        <Icon
          size={13}
          style={{
            color: isRunning
              ? 'var(--accent-primary)'
              : isError
                ? 'var(--danger)'
                : 'var(--success)',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--fg-secondary)',
            flexShrink: 0,
          }}
        >
          {block.toolName}
        </span>

        {/* Inline detail for specific tools */}
        <ToolInlineDetail block={block} />

        <span
          style={{
            fontSize: 11,
            color: 'var(--fg-quaternary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {summary}
        </span>

        <ContentStats input={block.toolInput} />

        <span style={{ flexShrink: 0 }}>
          {isRunning ? (
            <Loader2
              size={12}
              style={{ color: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }}
            />
          ) : isError ? (
            <AlertCircle size={12} style={{ color: 'var(--danger)' }} />
          ) : (
            <Check size={12} style={{ color: 'var(--success)' }} />
          )}
        </span>
      </div>

      {/* Expandable params */}
      {showParams && block.toolInput && (
        <pre
          style={{
            margin: 0,
            padding: '8px 12px',
            background: 'var(--bg-base)',
            borderTop: '1px solid var(--border-subtle)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--fg-tertiary)',
            maxHeight: 200,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {JSON.stringify(block.toolInput, null, 2)}
        </pre>
      )}

      {/* Inline diff for Edit tool */}
      {block.diff && block.diff.length > 0 && (
        <DiffRenderer lines={block.diff} />
      )}

      {/* Tool result (if embedded) */}
      {block.toolResult && !block.diff && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: '1px solid var(--border-subtle)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: block.toolError ? 'var(--danger)' : 'var(--fg-tertiary)',
            maxHeight: 150,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {block.toolResult}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline detail shown in the tool header (Bash command, Edit diff, etc.)
// ---------------------------------------------------------------------------

function ToolInlineDetail({ block }: { block: AgentMessageBlock }) {
  const name = block.toolName || '';
  const input = block.toolInput || {};

  if (name === 'Bash' && typeof input.command === 'string') {
    return (
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--fg-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 2,
        }}
      >
        {input.command}
      </span>
    );
  }

  if (name === 'Edit') {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
    const newStr = typeof input.new_string === 'string' ? input.new_string : '';
    const added = newStr.split('\n').length;
    const removed = oldStr.split('\n').length;
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>
          +{added}
        </span>
        <span style={{ fontSize: 10, color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
          -{removed}
        </span>
      </span>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Content stats (line count / char count)
// ---------------------------------------------------------------------------

function ContentStats({ input }: { input?: Record<string, unknown> }) {
  if (!input) return null;

  const content =
    typeof input.content === 'string'
      ? input.content
      : typeof input.command === 'string'
        ? input.command
        : typeof input.old_string === 'string'
          ? input.old_string
          : '';

  if (!content) return null;

  const lines = content.split('\n').length;
  const chars = content.length;

  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 6,
        fontSize: 10,
        color: 'var(--fg-quaternary)',
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
      }}
    >
      <span>{lines}L</span>
      <span>{chars > 1024 ? `${(chars / 1024).toFixed(1)}KB` : `${chars}c`}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tool result (standalone)
// ---------------------------------------------------------------------------

function ToolResultBlock({ block }: { block: AgentMessageBlock }) {
  const text = extractTextContent(block.content || block.toolResult);
  if (!block.toolError && !text) return null;

  const name = block.toolName || '';

  // Specialized rendering per tool type
  if (name === 'Bash' && !block.toolError) {
    return <BashResult text={text} />;
  }
  if (name === 'Edit') {
    return <EditResult text={text} isError={!!block.toolError} />;
  }
  if (name === 'Read') {
    return <ReadResult text={text} filePath={String(block.filePath || block.toolInput?.file_path || '')} />;
  }
  if (name === 'Grep') {
    return <GrepResult text={text} isError={!!block.toolError} />;
  }
  if (name === 'Glob') {
    return <GlobResult text={text} isError={!!block.toolError} />;
  }

  // Generic fallback
  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${block.toolError ? 'rgba(255,69,58,0.2)' : 'var(--border-subtle)'}`,
        padding: '8px 12px',
        marginBottom: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: block.toolError ? 'var(--danger)' : 'var(--fg-tertiary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 300,
        overflowY: 'auto',
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bash result — terminal-style block
// ---------------------------------------------------------------------------

function BashResult({ text }: { text: string }) {
  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        marginBottom: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          background: 'var(--bg-base)',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 10,
          color: 'var(--fg-quaternary)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <Terminal size={10} />
        output
      </div>
      <pre
        style={{
          margin: 0,
          padding: '8px 12px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: 1.55,
          color: 'var(--fg-secondary)',
          background: 'var(--bg-elevated)',
          maxHeight: 250,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit result — diff hunk viewer
// ---------------------------------------------------------------------------

function EditResult({ text, isError }: { text: string; isError: boolean }) {
  const lines = text.split('\n');
  const hasDiffLines = lines.some((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@'));

  if (isError || !hasDiffLines) {
    return (
      <div
        style={{
          borderRadius: 12,
          border: `1px solid ${isError ? 'rgba(255,69,58,0.2)' : 'var(--border-subtle)'}`,
          padding: '8px 12px',
          marginBottom: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: isError ? 'var(--danger)' : 'var(--fg-tertiary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxHeight: 200,
          overflowY: 'auto',
        }}
      >
        {text}
      </div>
    );
  }

  return <DiffRenderer lines={lines} />;
}

// ---------------------------------------------------------------------------
// Read result — code viewer with file path header
// ---------------------------------------------------------------------------

function ReadResult({ text, filePath }: { text: string; filePath: string }) {
  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        marginBottom: 8,
        overflow: 'hidden',
      }}
    >
      {filePath && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            background: 'var(--bg-base)',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 10,
            color: 'var(--fg-quaternary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <Eye size={10} />
          {filePath}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: '8px 12px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: 1.55,
          color: 'var(--fg-secondary)',
          background: 'var(--bg-elevated)',
          maxHeight: 300,
          overflowY: 'auto',
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      >
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grep result — search results with file:line formatting
// ---------------------------------------------------------------------------

function GrepResult({ text, isError }: { text: string; isError: boolean }) {
  if (isError) {
    return (
      <div
        style={{
          borderRadius: 12,
          border: '1px solid rgba(255,69,58,0.2)',
          padding: '8px 12px',
          marginBottom: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--danger)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {text}
      </div>
    );
  }

  const lines = text.split('\n').filter(Boolean);

  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        marginBottom: 8,
        overflow: 'hidden',
        maxHeight: 300,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          background: 'var(--bg-base)',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 10,
          color: 'var(--fg-quaternary)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <Search size={10} />
        {lines.length} results
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55 }}>
        {lines.map((line, i) => {
          // Try to parse file:line:match format
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (match) {
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '2px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <span style={{ color: 'var(--accent-primary)', minWidth: 120, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {match[1]}:{match[2]}
                </span>
                <span style={{ color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {match[3]}
                </span>
              </div>
            );
          }
          return (
            <div
              key={i}
              style={{
                padding: '2px 12px',
                color: 'var(--fg-tertiary)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glob result — file list
// ---------------------------------------------------------------------------

function GlobResult({ text, isError }: { text: string; isError: boolean }) {
  if (isError) {
    return (
      <div
        style={{
          borderRadius: 12,
          border: '1px solid rgba(255,69,58,0.2)',
          padding: '8px 12px',
          marginBottom: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--danger)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {text}
      </div>
    );
  }

  const files = text.split('\n').filter(Boolean);

  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        marginBottom: 8,
        overflow: 'hidden',
        maxHeight: 250,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          background: 'var(--bg-base)',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 10,
          color: 'var(--fg-quaternary)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <Search size={10} />
        {files.length} files
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55 }}>
        {files.map((file, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 12px',
              borderBottom: '1px solid var(--border-subtle)',
              color: 'var(--fg-secondary)',
            }}
          >
            <FileText size={10} style={{ color: 'var(--fg-quaternary)', flexShrink: 0 }} />
            {file}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff renderer
// ---------------------------------------------------------------------------

function DiffRenderer({ lines }: { lines: string[] }) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: '6px 0',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        lineHeight: 1.6,
        overflowX: 'auto',
        maxHeight: 200,
        overflowY: 'auto',
      }}
    >
      {lines.map((line, i) => {
        const isAdd = line.startsWith('+');
        const isDel = line.startsWith('-');
        const isHunk = line.startsWith('@@');
        return (
          <div
            key={i}
            style={{
              paddingLeft: 12,
              paddingRight: 12,
              borderLeft: isAdd
                ? '3px solid var(--success)'
                : isDel
                  ? '3px solid var(--danger)'
                  : isHunk
                    ? '3px solid var(--accent-primary)'
                    : '3px solid transparent',
              background: isAdd
                ? 'rgba(48,209,88,0.06)'
                : isDel
                  ? 'rgba(255,69,58,0.05)'
                  : isHunk
                    ? 'rgba(124,91,245,0.05)'
                    : 'transparent',
              color: isHunk
                ? 'var(--accent-primary)'
                : isAdd || isDel
                  ? 'var(--fg-secondary)'
                  : 'var(--fg-quaternary)',
            }}
          >
            {line.slice(1) || '\u00A0'}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string' ? input.command : '';
    case 'Edit': {
      const old = typeof input.old_string === 'string' ? input.old_string : '';
      const nw = typeof input.new_string === 'string' ? input.new_string : '';
      const changed = Math.abs(nw.split('\n').length - old.split('\n').length);
      return `${changed} lines changed`;
    }
    case 'Write': {
      const content = typeof input.content === 'string' ? input.content : '';
      return `${content.split('\n').length} lines`;
    }
    case 'Read':
      return typeof input.file_path === 'string' ? input.file_path : '';
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : '';
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : '';
    case 'Agent':
      return typeof input.description === 'string' ? input.description : '';
    case 'WebSearch':
      return typeof input.query === 'string' ? input.query : '';
    case 'WebFetch':
      return typeof input.url === 'string' ? input.url : '';
    default:
      return '';
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content, null, 2);
  return '';
}
