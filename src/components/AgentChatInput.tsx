import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Send, Square, ArrowUp, HelpCircle, FileCode, Zap,
} from 'lucide-react';
import ControlBar from './ControlBar';
import type { ModelOption, PermissionMode, PermissionModeOption, ThinkingEffort, ThinkingEffortOption } from '../types';
import { buildSlashCommands } from '../lib/commands';
import type { SlashCommand } from '../lib/commands';

/* ---------- slash commands ---------- */

const SLASH_COMMANDS = buildSlashCommands();

/* ---------- props ---------- */

interface AgentChatInputProps {
  status: string;
  onSend: (text: string) => void;
  onAbort: () => void;
  disabled?: boolean;
  model?: string;
  permissionMode?: string;
  thinkingEffort?: string;
  models?: ModelOption[];
  permissionModes?: PermissionModeOption[];
  thinkingEfforts?: ThinkingEffortOption[];
  onModelChange?: (modelId: string) => void;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onThinkingEffortChange?: (effort: ThinkingEffort) => void;
  onSlashCommand?: (cmd: string) => void;
}

/* ---------- component ---------- */

export default function AgentChatInput({
  status, onSend, onAbort, disabled,
  model, permissionMode, thinkingEffort,
  models, permissionModes, thinkingEfforts,
  onModelChange, onPermissionModeChange, onThinkingEffortChange,
  onSlashCommand,
}: AgentChatInputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  /* ---- @file reference state ---- */
  const [atSearchOpen, setAtSearchOpen] = useState(false);
  const [atSearchQuery, setAtSearchQuery] = useState('');
  const [atSearchResults, setAtSearchResults] = useState<Array<{path: string, name: string, isDirectory: boolean}>>([]);
  const [atSearchIndex, setAtSearchIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const isActive = status !== 'idle' && status !== 'completed' && status !== 'error' && status !== 'aborted';
  const canSend = text.trim().length > 0 && !isActive && !disabled;

  /* ---- slash panel ---- */
  const isCmdMode = text.startsWith('/') && !text.includes(' ');
  const cmdQuery = text.slice(1).toLowerCase();
  const filteredCmds = useMemo(() => {
    if (!isCmdMode) return [];
    return SLASH_COMMANDS.filter(
      c => c.id.startsWith(cmdQuery) || c.label.toLowerCase().includes(cmdQuery),
    );
  }, [isCmdMode, cmdQuery]);

  useEffect(() => { setCmdIndex(0); }, [cmdQuery]);

  /* ---- @file search ---- */
  useEffect(() => {
    if (!atSearchOpen) return;
    const timer = setTimeout(async () => {
      try {
        const ipc = (window as any).ipc;
        if (!ipc?.invoke) return;
        const result: any = await ipc.invoke('file:search', { query: atSearchQuery });
        if (result?.ok) setAtSearchResults(result.files || []);
      } catch {
        setAtSearchResults([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [atSearchOpen, atSearchQuery]);

  /* ---- auto-resize ---- */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || dragRef.current) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  /* ---- drag to resize ---- */
  const onDragMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const ta = textareaRef.current;
    if (!ta) return;
    dragRef.current = { startY: e.clientY, startH: ta.offsetHeight };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      const newH = Math.min(300, Math.max(40, dragRef.current.startH + delta));
      ta.style.height = `${newH}px`;
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  /* ---- send ---- */
  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isActive || disabled) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, isActive, disabled, onSend]);

  /* ---- insert file reference ---- */
  const insertFileReference = useCallback((file: {path: string, name: string}) => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const afterCursor = text.slice(cursorPos);
    const atStart = beforeCursor.lastIndexOf('@');
    const newText = beforeCursor.slice(0, atStart) + '@' + file.path + ' ' + afterCursor;
    setText(newText);
    setAtSearchOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [text]);

  /* ---- handle input change with @ detection ---- */
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);

    // Detect @ trigger
    const cursorPos = e.target.selectionStart;
    const beforeCursor = value.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@([^\s]*)$/);
    if (atMatch) {
      setAtSearchOpen(true);
      setAtSearchQuery(atMatch[1]);
      setAtSearchIndex(0);
    } else {
      setAtSearchOpen(false);
    }
  }, []);

  /* ---- key handler ---- */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @file search navigation
    if (atSearchOpen && atSearchResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtSearchIndex(i => Math.min(i + 1, atSearchResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtSearchIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        insertFileReference(atSearchResults[atSearchIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtSearchOpen(false);
        return;
      }
    }

    // Slash panel navigation
    if (isCmdMode && filteredCmds.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex(i => Math.min(i + 1, filteredCmds.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const selectedCmd = filteredCmds[cmdIndex];
        if (!selectedCmd) return;

        // /model: toggle through available models
        if (selectedCmd.id === 'model' && onModelChange && models) {
          const currentIndex = models.findIndex(m => m.id === (model || 'default'));
          const nextIndex = (currentIndex + 1) % models.length;
          onModelChange(models[nextIndex].id);
          setText('');
          return;
        }

        // /new
        if (selectedCmd.id === 'new') {
          onSlashCommand?.('new');
          setText('');
          return;
        }

        // /clear
        if (selectedCmd.id === 'clear') {
          onSlashCommand?.('clear');
          setText('');
          return;
        }

        // /compact
        if (selectedCmd.id === 'compact') {
          onSlashCommand?.('compact');
          setText('');
          return;
        }

        // /cost
        if (selectedCmd.id === 'cost') {
          onSlashCommand?.('cost');
          setText('');
          return;
        }

        // /help: toggle help overlay
        if (selectedCmd.id === 'help') {
          setHelpOpen(prev => !prev);
          setText('');
          return;
        }

        // Fallback for other commands
        if (onSlashCommand) onSlashCommand(selectedCmd.id);
        setText(`/${selectedCmd.id} `);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
    }

    // Close help overlay on Escape
    if (e.key === 'Escape' && helpOpen) {
      e.preventDefault();
      setHelpOpen(false);
      return;
    }

    // Send
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); }
  };

  const executeCommand = (cmd: SlashCommand) => {
    // /model: toggle through available models
    if (cmd.id === 'model' && onModelChange && models) {
      const currentIndex = models.findIndex(m => m.id === (model || 'default'));
      const nextIndex = (currentIndex + 1) % models.length;
      onModelChange(models[nextIndex].id);
      setText('');
      textareaRef.current?.focus();
      return;
    }
    if (cmd.id === 'new') { onSlashCommand?.('new'); setText(''); textareaRef.current?.focus(); return; }
    if (cmd.id === 'clear') { onSlashCommand?.('clear'); setText(''); textareaRef.current?.focus(); return; }
    if (cmd.id === 'compact') { onSlashCommand?.('compact'); setText(''); textareaRef.current?.focus(); return; }
    if (cmd.id === 'cost') { onSlashCommand?.('cost'); setText(''); textareaRef.current?.focus(); return; }
    if (cmd.id === 'help') { setHelpOpen(prev => !prev); setText(''); textareaRef.current?.focus(); return; }
    if (onSlashCommand) onSlashCommand(cmd.id);
    setText(`/${cmd.id} `);
    textareaRef.current?.focus();
  };

  const placeholder = disabled
    ? 'Initializing agent session…'
    : isActive
      ? 'Agent is working…'
      : isCmdMode
        ? 'Type a command…'
        : atSearchOpen
          ? 'Search files with @…'
          : 'Message Claude…';

  return (
    <div style={{ flexShrink: 0, padding: '8px 24px 20px' }}>
      <div className="max-w-3xl mx-auto relative">

        {/* Help overlay */}
        {helpOpen && (
          <div
            className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl overflow-hidden"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-lg)',
              zIndex: 40,
            }}
          >
            <div className="px-3.5 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center gap-2">
                <HelpCircle size={11} className="text-[var(--accent-bright)]" />
                <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--fg-quaternary)', letterSpacing: '0.08em' }}>Available Commands</span>
              </div>
              <button onClick={() => setHelpOpen(false)} style={{ color: 'var(--fg-quaternary)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
            <div className="py-1 max-h-[300px] overflow-y-auto">
              {SLASH_COMMANDS.map((cmd) => {
                const Icon = cmd.icon;
                return (
                  <div key={cmd.id} className="flex items-center gap-3 px-3.5 py-2">
                    <div className="flex-shrink-0 w-6 h-6 rounded flex items-center justify-center" style={{ background: 'var(--bg-surface-2)' }}>
                      <Icon size={12} style={{ color: 'var(--fg-tertiary)' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[12px] font-medium" style={{ color: 'var(--fg-primary)' }}>/{cmd.id}</span>
                      <span className="text-[11px] ml-2" style={{ color: 'var(--fg-quaternary)' }}>{cmd.description}</span>
                    </div>
                    {cmd.shortcut && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: 'var(--fg-quaternary)', background: 'var(--tint-subtle)' }}>
                        {cmd.shortcut}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* @file search dropdown */}
        {atSearchOpen && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 0,
            maxHeight: 200,
            overflow: 'auto',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm, 8px)',
            boxShadow: 'var(--shadow-md)',
            zIndex: 50,
            marginBottom: 4,
          }}>
            {atSearchResults.length === 0 ? (
              <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--fg-tertiary)' }}>
                {atSearchQuery ? 'No files found' : 'Type to search files...'}
              </div>
            ) : (
              atSearchResults.map((file, i) => (
                <button
                  key={file.path}
                  onClick={() => insertFileReference(file)}
                  onMouseEnter={() => setAtSearchIndex(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '6px 12px',
                    background: i === atSearchIndex ? 'var(--accent-subtle)' : 'transparent',
                    border: 'none', cursor: 'pointer', textAlign: 'left',
                    fontSize: 12, color: 'var(--fg-primary)',
                  }}
                >
                  <FileCode size={12} style={{ color: 'var(--fg-tertiary)', flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{file.name}</span>
                  <span style={{ color: 'var(--fg-quaternary)', fontSize: 10, marginLeft: 'auto' }}>
                    {file.path}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* Slash command palette — identical to ChatView */}
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
                const Icon = cmd.icon;
                const active = i === cmdIndex;
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
                );
              })}
            </div>
          </div>
        )}

        {/* Main input card — matches ChatView exactly */}
        <div
          className="rounded-2xl overflow-hidden transition-all"
          style={{
            background: 'var(--bg-surface)',
            border: `1px solid ${focused ? 'var(--accent-primary)' : 'var(--border-default)'}`,
            boxShadow: focused
              ? '0 0 0 3px rgba(124,91,245,0.10), var(--shadow-md)'
              : 'var(--shadow-sm)',
            transition: 'border-color 200ms ease, box-shadow 200ms ease',
          }}
        >
          {/* Drag handle */}
          <div
            onMouseDown={onDragMouseDown}
            style={{
              height: 6,
              cursor: 'row-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: focused ? 0.5 : 0,
              transition: 'opacity 150ms ease',
            }}
          >
            <div style={{ width: 32, height: 3, borderRadius: 2, background: 'var(--fg-quaternary)' }} />
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            rows={3}
            className="w-full bg-transparent resize-none outline-none px-4 pt-2 pb-2 text-[14px]"
            style={{
              color: 'var(--fg-primary)',
              fontFamily: 'var(--font-sans)',
              maxHeight: '180px',
              lineHeight: '1.6',
              opacity: isActive ? 0.5 : 1,
            }}
            disabled={isActive || disabled}
          />

          {/* Bottom toolbar — matches ChatView layout */}
          <div className="flex items-center justify-between px-3.5 pb-3">
            <div className="flex items-center gap-2">
              {/* Agent badge */}
              <div
                className="flex items-center gap-1.5 px-2 py-1 rounded-md"
                style={{ background: 'var(--accent-subtle)', border: '1px solid rgba(124,91,245,0.12)' }}
              >
                <div
                  style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: isActive ? 'var(--success)' : 'var(--accent-primary)',
                    boxShadow: isActive ? '0 0 6px rgba(48,209,88,0.4)' : 'none',
                  }}
                />
                <span className="text-[10px] font-semibold" style={{ color: 'var(--accent-bright)', letterSpacing: '0.04em' }}>
                  Agent
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {text.length > 0 && (
                <span className="text-[11px] tabular-nums font-medium" style={{ color: 'var(--fg-quaternary)' }}>
                  {text.length}
                </span>
              )}
              {isActive ? (
                <button
                  onClick={onAbort}
                  className="h-8 w-8 rounded-xl flex items-center justify-center transition-all"
                  style={{ background: 'var(--danger)', color: '#fff', boxShadow: '0 2px 8px rgba(255,69,58,0.35)' }}
                  title="Stop agent"
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

        {/* ControlBar — permission / thinking / model */}
        {models && permissionModes && thinkingEfforts && onModelChange && onPermissionModeChange && onThinkingEffortChange && (
          <ControlBar
            permissionMode={(permissionMode || 'ask') as PermissionMode}
            onPermissionModeChange={onPermissionModeChange}
            permissionModes={permissionModes}
            selectedModel={model || 'default'}
            models={models}
            onModelSelect={onModelChange}
            thinkingEffort={(thinkingEffort || 'medium') as ThinkingEffort}
            onThinkingEffortChange={onThinkingEffortChange}
            thinkingEfforts={thinkingEfforts}
            disabled={disabled || isActive}
          />
        )}
      </div>
    </div>
  );
}
