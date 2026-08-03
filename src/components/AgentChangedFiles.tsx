/**
 * AgentChangedFiles - inline panel showing files modified by the agent.
 *
 * Surfaces file-change activity directly in the conversation view so the
 * agent's impact is always visible (not hidden behind the right panel).
 * Clicking "Details" opens the RightPanel Activity tab for full diffs.
 */
import { useState, useMemo } from 'react';
import { FileEdit, FilePlus, FileStack, ChevronDown, ChevronRight, PanelRight } from 'lucide-react';

export interface ChangedFileEntry {
  filePath: string;
  tool: 'Edit' | 'Write' | 'MultiEdit';
  count: number;
}

interface AgentChangedFilesProps {
  files: ChangedFileEntry[];
  onOpenDetails?: () => void;
}

function getToolIcon(tool: ChangedFileEntry['tool']) {
  if (tool === 'Write') return FilePlus;
  if (tool === 'MultiEdit') return FileStack;
  return FileEdit;
}

export default function AgentChangedFiles({ files, onOpenDetails }: AgentChangedFilesProps) {
  const [expanded, setExpanded] = useState(false);

  const totalEdits = useMemo(() => files.reduce((s, f) => s + f.count, 0), [files]);

  if (files.length === 0) return null;

  return (
    <div
      style={{
        margin: '0 16px 8px',
        borderRadius: 14,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
        animation: 'agent-fade-in 200ms ease forwards',
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--fg-secondary)',
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        <FileEdit size={13} style={{ color: 'var(--accent-bright)', flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: 'left' }}>
          {files.length} file{files.length !== 1 ? 's' : ''} changed
          <span style={{ color: 'var(--fg-quaternary)', marginLeft: 6 }}>
            · {totalEdits} edit{totalEdits !== 1 ? 's' : ''}
          </span>
        </span>
        {expanded ? <ChevronDown size={13} style={{ color: 'var(--fg-quaternary)' }} /> : <ChevronRight size={13} style={{ color: 'var(--fg-quaternary)' }} />}
      </button>

      {/* Expanded file list */}
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            padding: '4px 8px 8px',
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {files.map((f) => {
            const Icon = getToolIcon(f.tool);
            const fileName = f.filePath.split('/').pop() || f.filePath;
            const dirPath = f.filePath.slice(0, f.filePath.length - fileName.length);
            return (
              <div
                key={f.filePath}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 6px',
                  borderRadius: 8,
                }}
              >
                <Icon size={12} style={{ color: 'var(--accent-bright)', flexShrink: 0 }} />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--fg-secondary)',
                    flexShrink: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fileName}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--fg-quaternary)',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {dirPath}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--fg-tertiary)',
                    padding: '1px 6px',
                    borderRadius: 5,
                    background: 'var(--tint-subtle)',
                    flexShrink: 0,
                  }}
                >
                  {f.count > 1 ? `${f.count}×` : f.tool}
                </span>
              </div>
            );
          })}

          {onOpenDetails && (
            <button
              onClick={onOpenDetails}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                margin: '4px 6px 0',
                padding: '5px 8px',
                background: 'none',
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 10,
                color: 'var(--accent-bright)',
                fontWeight: 500,
                width: 'calc(100% - 12px)',
              }}
            >
              <PanelRight size={11} />
              View diffs in Activity
            </button>
          )}
        </div>
      )}
    </div>
  );
}
