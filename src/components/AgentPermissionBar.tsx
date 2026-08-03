import { useState, useMemo } from 'react';
import {
  Shield, Terminal, FileCode, FileText, Eye, Search,
  Brain, Globe, Sparkles, ChevronDown, ChevronRight, Check, X,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason?: string;
  title?: string;
  displayName?: string;
  suggestions?: unknown[];
}

interface AgentPermissionBarProps {
  request: PermissionRequest;
  onAllow: (requestId: string, allowAll?: boolean) => void;
  onDeny: (requestId: string) => void;
}

// ---------------------------------------------------------------------------
// Tool metadata — icon, color, human label
// ---------------------------------------------------------------------------

const IconComponent: typeof Shield = Shield; // just for typeof usage

const TOOL_META: Record<string, { icon: typeof IconComponent; color: string; label: string }> = {
  Bash:          { icon: Terminal,  color: 'var(--warn)',          label: 'Shell Command' },
  Edit:          { icon: FileCode,  color: 'var(--accent-primary)', label: 'Edit File' },
  Write:         { icon: FileText,  color: 'var(--success)',       label: 'Write File' },
  Read:          { icon: Eye,       color: 'var(--fg-secondary)',  label: 'Read File' },
  Glob:          { icon: Search,    color: 'var(--fg-secondary)',  label: 'Search Files' },
  Grep:          { icon: Search,    color: 'var(--fg-secondary)',  label: 'Search Content' },
  Agent:         { icon: Brain,     color: 'var(--fg-tertiary)',   label: 'Sub-Agent' },
  WebSearch:     { icon: Globe,     color: 'var(--fg-secondary)',  label: 'Web Search' },
  WebFetch:      { icon: Globe,     color: 'var(--fg-secondary)',  label: 'Web Fetch' },
  MultiEdit:     { icon: FileCode,  color: 'var(--accent-primary)', label: 'Multi Edit' },
  NotebookEdit:  { icon: FileCode,  color: 'var(--accent-primary)', label: 'Notebook Edit' },
  Skill:         { icon: Sparkles,  color: 'var(--fg-tertiary)',   label: 'Skill' },
};

const DEFAULT_META = { icon: Shield, color: 'var(--warn)', label: 'Tool' };

// ---------------------------------------------------------------------------
// Detail extraction helpers
// ---------------------------------------------------------------------------

function getFilePath(input: Record<string, unknown>): string {
  return String(input.file_path || input.filePath || input.path || '');
}

function getToolDetails(toolName: string, input: Record<string, unknown>): {
  primary: string;
  secondary: string;
} {
  switch (toolName) {
    case 'Bash': {
      const cmd = String(input.command || '');
      const desc = String(input.description || '');
      return { primary: cmd, secondary: desc };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const fp = getFilePath(input);
      return { primary: fp, secondary: 'Replacing content in file' };
    }
    case 'Write': {
      const fp = getFilePath(input);
      return { primary: fp, secondary: 'Writing file contents' };
    }
    case 'Read': {
      const fp = getFilePath(input);
      return { primary: fp, secondary: 'Reading file' };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = String(input.pattern || input.query || input.path || '');
      return { primary: pattern, secondary: toolName === 'Grep' ? 'Searching content' : 'Searching files' };
    }
    case 'Agent': {
      const desc = String(input.description || input.prompt || '');
      return { primary: desc.slice(0, 120), secondary: 'Spawning sub-agent' };
    }
    case 'WebSearch': {
      const query = String(input.query || input.search_query || '');
      return { primary: query, secondary: 'Searching the web' };
    }
    case 'WebFetch': {
      const url = String(input.url || '');
      return { primary: url, secondary: 'Fetching web content' };
    }
    default: {
      const keys = Object.keys(input).slice(0, 3).join(', ');
      return { primary: keys || 'Unknown parameters', secondary: '' };
    }
  }
}

// ---------------------------------------------------------------------------
// Diff / content preview helpers
// ---------------------------------------------------------------------------

function DiffPreview({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const oldStr = String(input.old_string || input.oldText || '');
    const newStr = String(input.new_string || input.newText || input.content || '');
    if (!oldStr && !newStr) return null;
    return (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55 }}>
        {oldStr && (
          <DiffLine prefix="-" text={oldStr} color="var(--danger)" bg="rgba(255,69,58,0.06)" />
        )}
        {newStr && (
          <DiffLine prefix="+" text={newStr} color="var(--success)" bg="rgba(48,209,88,0.06)" />
        )}
      </div>
    );
  }

  if (toolName === 'Write') {
    const content = String(input.content || input.file_content || '');
    if (!content) return null;
    const lines = content.split('\n');
    const preview = lines.slice(0, 20);
    const truncated = lines.length > 20;
    return (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55 }}>
        {preview.map((line, i) => (
          <DiffLine key={i} prefix="+" text={line} color="var(--success)" bg="rgba(48,209,88,0.06)" />
        ))}
        {truncated && (
          <div style={{ color: 'var(--fg-quaternary)', fontSize: 10, padding: '4px 0' }}>
            +{lines.length - 20} more lines...
          </div>
        )}
      </div>
    );
  }

  return null;
}

function DiffLine({ prefix, text, color, bg }: {
  prefix: string;
  text: string;
  color: string;
  bg: string;
}) {
  const display = text.length > 120 ? text.slice(0, 120) + '…' : text;
  return (
    <div
      style={{
        background: bg,
        borderRadius: 4,
        padding: '2px 6px',
        marginBottom: 2,
        color: 'var(--fg-secondary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      <span style={{ color, fontWeight: 600, marginRight: 6, userSelect: 'none' }}>{prefix}</span>
      {display}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AgentPermissionBar({ request, onAllow, onDeny }: AgentPermissionBarProps) {
  const [showDetails, setShowDetails] = useState(false);

  const meta = TOOL_META[request.toolName] || DEFAULT_META;
  const ToolIcon = meta.icon;
  const details = useMemo(() => getToolDetails(request.toolName, request.toolInput), [request.toolName, request.toolInput]);
  const hasDiffPreview = request.toolName === 'Edit' || request.toolName === 'MultiEdit' ||
    request.toolName === 'NotebookEdit' || request.toolName === 'Write';
  const toolLabel = request.displayName || meta.label;

  // Build title: "Allow [Tool] to [action]?"
  const actionMap: Record<string, string> = {
    Bash: 'run command',
    Edit: 'edit file',
    MultiEdit: 'edit file',
    NotebookEdit: 'edit notebook',
    Write: 'write file',
    Read: 'read file',
    Glob: 'search files',
    Grep: 'search content',
    Agent: 'spawn sub-agent',
    WebSearch: 'search the web',
    WebFetch: 'fetch URL',
    Skill: 'run skill',
  };
  const action = actionMap[request.toolName] || 'use tool';
  const titleText = `Allow ${toolLabel} to ${action}?`;

  return (
    <div
      style={{
        margin: '8px 16px',
        borderRadius: 16,
        background: 'var(--bg-elevated)',
        border: '1px solid rgba(255,215,10,0.12)',
        boxShadow: 'var(--shadow-md, 0 4px 16px rgba(0,0,0,0.15)), 0 0 24px rgba(255,215,10,0.04)',
        animation: 'agent-permission-enter 350ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
        overflow: 'hidden',
        zIndex: 10,
      }}
    >
      {/* ---- Header row: icon + title + subtitle ---- */}
      <div style={{ padding: '14px 16px 0 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {/* Tool icon in color-coded circle */}
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
              border: `1.5px solid color-mix(in srgb, ${meta.color} 25%, transparent)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <ToolIcon size={17} style={{ color: meta.color }} />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Title */}
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--fg-primary)',
                lineHeight: 1.3,
                letterSpacing: '-0.01em',
              }}
            >
              {titleText}
            </div>

            {/* Subtitle: file path or command */}
            {details.primary && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--fg-tertiary)',
                  marginTop: 3,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={details.primary}
              >
                {details.primary}
              </div>
            )}

            {details.secondary && details.secondary !== details.primary && (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--fg-quaternary)',
                  marginTop: 2,
                }}
              >
                {details.secondary}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- Expandable details section ---- */}
      {(hasDiffPreview || details.primary) && (
        <div style={{ padding: '10px 16px 0 16px' }}>
          <button
            onClick={() => setShowDetails(!showDetails)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: 0,
              fontSize: 10,
              fontWeight: 500,
              color: 'var(--fg-quaternary)',
              transition: 'color 150ms ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-quaternary)'; }}
          >
            {showDetails
              ? <ChevronDown size={11} />
              : <ChevronRight size={11} />
            }
            {hasDiffPreview ? 'Preview changes' : 'View details'}
          </button>

          {showDetails && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                background: 'var(--bg-surface-2, var(--bg-base))',
                borderRadius: 8,
                maxHeight: 200,
                overflowY: 'auto',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {hasDiffPreview ? (
                <DiffPreview toolName={request.toolName} input={request.toolInput} />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--fg-tertiary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {JSON.stringify(request.toolInput, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- Reason (if provided) ---- */}
      {request.reason && (
        <div
          style={{
            margin: '8px 16px 0 16px',
            padding: '6px 10px',
            background: 'var(--accent-subtle)',
            borderRadius: 8,
            fontSize: 11,
            color: 'var(--fg-secondary)',
            borderLeft: '2px solid var(--accent-primary)',
          }}
        >
          {request.reason}
        </div>
      )}

      {/* ---- Action buttons ---- */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '12px 16px',
          marginTop: 8,
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        {/* Deny */}
        <button
          onClick={() => onDeny(request.requestId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 14px',
            borderRadius: 10,
            border: '1px solid rgba(255,69,58,0.15)',
            background: 'rgba(255,69,58,0.06)',
            color: 'var(--danger)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 150ms ease',
            letterSpacing: '0.005em',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,69,58,0.14)';
            e.currentTarget.style.transform = 'translateY(-0.5px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,69,58,0.06)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <X size={13} />
          Deny
        </button>

        {/* Allow for session */}
        <button
          onClick={() => onAllow(request.requestId, true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 14px',
            borderRadius: 10,
            border: '1px solid rgba(48,209,88,0.15)',
            background: 'rgba(48,209,88,0.06)',
            color: 'var(--success)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 150ms ease',
            letterSpacing: '0.005em',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(48,209,88,0.12)';
            e.currentTarget.style.transform = 'translateY(-0.5px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(48,209,88,0.06)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <Shield size={13} />
          Always Allow
        </button>

        {/* Allow this time */}
        <button
          onClick={() => onAllow(request.requestId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 14px',
            borderRadius: 10,
            border: '1px solid rgba(48,209,88,0.25)',
            background: 'rgba(48,209,88,0.12)',
            color: 'var(--success)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 150ms ease',
            letterSpacing: '0.005em',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(48,209,88,0.2)';
            e.currentTarget.style.transform = 'translateY(-0.5px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(48,209,88,0.12)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <Check size={13} />
          Allow
        </button>
      </div>
    </div>
  );
}
