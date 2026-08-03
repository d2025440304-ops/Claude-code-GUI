import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Loader2, Brain, Wrench, Shield, AlertCircle, RotateCcw, GitBranch } from 'lucide-react';
import { ipc, Channels } from '../lib/ipc';
import type { Conversation, Attachment } from '../types';
import type { ModelOption, PermissionMode, PermissionModeOption, ThinkingEffort, ThinkingEffortOption } from '../types';
import AgentChatInput from './AgentChatInput';
import AgentPermissionBar from './AgentPermissionBar';
import AgentChangedFiles, { type ChangedFileEntry } from './AgentChangedFiles';
import { AgentMessageBlockRenderer, type AgentMessageBlock } from './AgentMessageRenderer';

// ---------------------------------------------------------------------------
// Types (matching electron/types/agent.ts)
// ---------------------------------------------------------------------------

type AgentStatus = 'idle' | 'requesting' | 'thinking' | 'streaming_text' | 'tool_executing' | 'waiting_permission' | 'error' | 'completed' | 'aborted';

interface AgentEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  [key: string]: unknown;
}

interface PermissionRequestData {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason?: string;
  title?: string;
  displayName?: string;
  suggestions?: unknown[];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AgentConversationViewProps {
  conversationId: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  thinkingEffort?: string;
  models?: ModelOption[];
  permissionModes?: PermissionModeOption[];
  thinkingEfforts?: ThinkingEffortOption[];
  onModelChange?: (modelId: string) => void;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onThinkingEffortChange?: (effort: ThinkingEffort) => void;
  onSessionIdChange?: (sessionId: string | null) => void;
  onOpenActivity?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert DB messages (persisted by the backend) back into AgentMessageBlock[]
 * so the conversation history survives tab switches / remounts.
 *
 * Assistant messages are stored as a JSON array of structured parts
 * (text / thinking / tool_use / tool_result). User messages are plain text.
 */
function restoreBlocksFromMessages(messages: Array<{ role: string; content: string }>): AgentMessageBlock[] {
  const blocks: AgentMessageBlock[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      blocks.push({ id: `r-u-${blocks.length}`, type: 'user_text', content: msg.content });
      continue;
    }
    // Assistant: try JSON array of parts, fall back to plain text.
    let parts: Array<Record<string, unknown>> | null = null;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) parts = parsed;
    } catch { /* not JSON */ }
    if (!parts) {
      if (msg.content) blocks.push({ id: `r-t-${blocks.length}`, type: 'text', content: msg.content });
      continue;
    }
    for (const p of parts) {
      const t = p.type as string;
      if (t === 'text' && p.text) {
        blocks.push({ id: `r-t-${blocks.length}`, type: 'text', content: p.text as string });
      } else if (t === 'thinking' && p.text) {
        blocks.push({ id: `r-th-${blocks.length}`, type: 'thinking', content: p.text as string });
      } else if (t === 'tool_use') {
        blocks.push({
          id: (p.toolUseId as string) || `r-tu-${blocks.length}`,
          type: 'tool_use',
          toolName: p.toolName as string,
          toolUseId: p.toolUseId as string,
          toolInput: p.input as Record<string, unknown>,
          status: 'completed',
        });
      } else if (t === 'tool_result') {
        const existing = blocks.find((b) => b.toolUseId === p.toolUseId && b.type === 'tool_use');
        if (existing) {
          existing.status = p.isError ? 'error' : 'completed';
          existing.toolResult = p.content as string;
          existing.toolError = !!p.isError;
        } else {
          blocks.push({
            id: `r-tr-${blocks.length}`,
            type: 'tool_result',
            toolUseId: p.toolUseId as string,
            content: p.content as string,
            toolError: !!p.isError,
          });
        }
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentConversationView({
  conversationId,
  cwd,
  model,
  permissionMode,
  thinkingEffort,
  models,
  permissionModes,
  thinkingEfforts,
  onModelChange,
  onPermissionModeChange,
  onThinkingEffortChange,
  onSessionIdChange,
  onOpenActivity,
}: AgentConversationViewProps) {
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [blocks, setBlocks] = useState<AgentMessageBlock[]>([]);
  // A4 修复：权限请求改为队列管理 — 并发多个权限请求时逐个展示，
  // 响应一个再显示下一个，避免后续请求无 UI 处理导致 agent 挂起。
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequestData[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequestData | null>(null);
  const permissionRequestRef = useRef<PermissionRequestData | null>(null);
  permissionRequestRef.current = permissionRequest;
  const [changedFiles, setChangedFiles] = useState<ChangedFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState<string>('');
  const [statusToolName, setStatusToolName] = useState<string>('');
  // /cost 与回合结束后的用量展示
  const [usageInfo, setUsageInfo] = useState<{ costUsd: number; durationMs: number; numTurns: number } | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  // 会话真实可用的 skills（SDK supportedCommands 推送）
  const [availableSkills, setAvailableSkills] = useState<{ name: string; description: string }[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<AgentMessageBlock[]>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(50);
  blocksRef.current = blocks;

  // Virtual scrolling: only render last N blocks
  const visibleBlocks = blocks.slice(-visibleCount);
  const hasMore = blocks.length > visibleCount;

  // IntersectionObserver sentinel: load more blocks when scrolled near top
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount(prev => Math.min(prev + 50, blocks.length));
        }
      },
      { root: scrollRef.current, threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, blocks.length]);

  // Preserve scroll position after loading more blocks
  useEffect(() => {
    if (visibleCount < blocks.length && scrollRef.current) {
      const el = scrollRef.current;
      const prevScrollHeight = el.scrollHeight;
      requestAnimationFrame(() => {
        const newScrollHeight = el.scrollHeight;
        el.scrollTop += newScrollHeight - prevScrollHeight;
      });
    }
  }, [visibleCount, blocks.length]);

  // Reset visibleCount when conversation changes
  useEffect(() => {
    setVisibleCount(50);
  }, [conversationId]);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Initialize the agent session — called on mount and when conversationId/cwd changes.
  // Model/permission/thinking changes do NOT recreate the session; they are passed per-message.
  const initSession = useCallback(async () => {
    setError(null);
    setIsInitialized(false);
    try {
      const createRes = await ipc.invoke<{ ok: boolean; sessionStatus: string }>(Channels.AGENT_CREATE, {
        convId: conversationId,
        cwd,
        model,
        permissionMode,
        thinkingEffort,
      });
      // If the session is actively running (switched away mid-turn),
      // only restore user_text + completed tool_use blocks to show context.
      // Assistant text is skipped — it will come via real-time streaming events
      // and restoring it would duplicate content already flushed to DB.
      // If the session is idle, restore everything from DB.
      const isActive = createRes.sessionStatus !== 'idle' && createRes.sessionStatus !== 'completed';
      try {
        const msgRes = await ipc.invoke<{ ok: boolean; messages?: Array<{ role: string; content: string }> }>('message:list', { conversationId });
        if (msgRes?.ok && msgRes.messages) {
          const restored = restoreBlocksFromMessages(msgRes.messages);
          if (isActive) {
            // Skip assistant text (streaming events will fill it), keep
            // user messages and completed tool_use blocks for context.
            const filtered = restored.filter(
              (b) => b.type === 'user_text' || (b.type === 'tool_use' && b.status === 'completed'),
            );
            setBlocks(filtered);
          } else {
            setBlocks(restored);
          }
          const files: ChangedFileEntry[] = [];
          for (const b of restored) {
            if (b.type === 'tool_use' && b.toolName && ['Edit', 'Write', 'MultiEdit'].includes(b.toolName)) {
              const fp = (b.toolInput?.file_path || b.toolInput?.filePath) as string;
              if (fp) {
                const ex = files.find((f) => f.filePath === fp);
                if (ex) ex.count++;
                else files.push({ filePath: fp, tool: b.toolName as ChangedFileEntry['tool'], count: 1 });
              }
            }
          }
          setChangedFiles(files);
        }
      } catch { /* ignore restore errors */ }
      if (!isActive) {
        // Only restore pending permission for idle sessions (active ones
        // will fire permission_request events in real-time).
        try {
          const pending = await ipc.invoke<PermissionRequestData[]>(Channels.AGENT_GET_PENDING_PERMISSION, { convId: conversationId });
          if (pending?.length) {
            setPermissionQueue(pending);
            setPermissionRequest(pending[0]);
          }
        } catch { /* ignore */ }
      }
      setIsInitialized(true);
    } catch (err) {
      setError(`Failed to create agent session: ${err}`);
    }
  }, [conversationId, cwd, model, permissionMode, thinkingEffort]);

  // Session lifecycle: init on mount. The agent session is kept alive in the
  // backend when the view unmounts (tab switch) so the agent keeps running.
  useEffect(() => {
    initSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [conversationId, cwd]); // Only re-init when conversation or working directory changes

  // Listen for agent events — always listen after initialization, event handler uses refs so it stays current
  useEffect(() => {
    if (!isInitialized) return;

    const unsubscribe = ipc.on(Channels.AGENT_EVENT, (data: { convId: string; event: AgentEvent }) => {
      if (data.convId !== conversationId) return;
      handleAgentEvent(data.event);
    });

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, isInitialized]);

  // Handle incoming agent events
  const handleAgentEvent = useCallback((event: AgentEvent) => {
    const currentBlocks = blocksRef.current;

    switch (event.type) {
      case 'init': {
        const sid = (event as any).sessionId;
        setSessionId(sid);
        onSessionIdChange?.(sid);
        break;
      }

      case 'skills': {
        const skills = (event as any).skills as { name: string; description: string }[];
        if (Array.isArray(skills)) setAvailableSkills(skills);
        break;
      }

      case 'status': {
        const s = (event as any).status as AgentStatus;
        setStatus(s);
        setStatusLabel((event as any).label || '');
        setStatusToolName((event as any).toolName || '');
        // 回合结束（idle/completed/aborted）时清空权限队列，防止残留
        if (s === 'idle' || s === 'completed' || s === 'aborted' || s === 'error') {
          setPermissionQueue([]);
          setPermissionRequest(null);
        }
        break;
      }

      case 'text': {
        const { text, messageId } = event as any;
        // Finalize the streaming delta block instead of adding a duplicate
        setBlocks(prev => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].type === 'text' && next[i].isStreaming) {
              next[i] = { ...next[i], content: text, isStreaming: false };
              return next;
            }
          }
          next.push({
            id: messageId + '-text-' + Date.now(),
            type: 'text',
            content: text,
          });
          return next;
        });
        scrollToBottom();
        break;
      }

      case 'text_delta': {
        const { delta, messageId } = event as any;
        setBlocks(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.type === 'text' && last.isStreaming) {
            next[next.length - 1] = { ...last, content: (last.content || '') + delta };
          } else {
            next.push({
              id: messageId + '-delta-' + Date.now(),
              type: 'text',
              content: delta,
              isStreaming: true,
            });
          }
          return next;
        });
        scrollToBottom();
        break;
      }

      case 'thinking': {
        const { text, messageId } = event as any;
        // Finalize the streaming thinking delta block
        setBlocks(prev => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].type === 'thinking') {
              next[i] = { ...next[i], content: text };
              return next;
            }
          }
          next.push({
            id: messageId + '-thinking-' + Date.now(),
            type: 'thinking',
            content: text,
          });
          return next;
        });
        scrollToBottom();
        break;
      }

      case 'thinking_delta': {
        const { delta, messageId } = event as any;
        setBlocks(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.type === 'thinking') {
            next[next.length - 1] = { ...last, content: (last.content || '') + delta };
          } else {
            next.push({
              id: messageId + '-tdelta-' + Date.now(),
              type: 'thinking',
              content: delta,
            });
          }
          return next;
        });
        scrollToBottom();
        break;
      }

      case 'tool_use': {
        const { toolName, toolUseId, input, messageId } = event as any;
        // Mark the current streaming text block as no longer streaming
        setBlocks(prev => {
          const next = prev.map(b => b.isStreaming ? { ...b, isStreaming: false } : b);
          next.push({
            id: toolUseId || messageId + '-tool-' + Date.now(),
            type: 'tool_use',
            toolName,
            toolUseId,
            toolInput: input,
            status: 'running',
          });
          return next;
        });
        scrollToBottom();
        break;
      }

      case 'tool_result': {
        const { toolUseId, toolName, content, isError, filePath, diff } = event as any;
        setBlocks(prev => {
          const next = [...prev];
          // Find the matching tool_use block and update it
          const idx = next.findIndex(b => b.toolUseId === toolUseId && b.type === 'tool_use');
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              status: isError ? 'error' : 'completed',
              toolResult: content,
              toolError: isError,
              filePath,
              diff,
            };
          } else {
            // Standalone result
            next.push({
              id: toolUseId + '-result-' + Date.now(),
              type: 'tool_result',
              toolUseId,
              toolName,
              content,
              toolError: isError,
              filePath,
            });
          }
          return next;
        });
        scrollToBottom();
        break;
      }

      case 'permission_request': {
        const req = event as any;
        const data: PermissionRequestData = {
          requestId: req.requestId,
          toolName: req.toolName,
          toolInput: req.toolInput,
          reason: req.reason,
          title: req.title,
          displayName: req.displayName,
          suggestions: req.suggestions,
        };
        // A4 修复：入队并展示队首（去重，避免重复事件叠加）
        setPermissionQueue(prev => {
          if (prev.some((r) => r.requestId === data.requestId)) return prev;
          const next = [...prev, data];
          setPermissionRequest(prev.length === 0 ? data : prev[0]);
          return next;
        });
        break;
      }

      case 'result': {
        // Turn completed
        setBlocks(prev => prev.map(b => b.isStreaming ? { ...b, isStreaming: false } : b));
        // 记录用量（/cost 与回合结束展示）
        const res = event as any;
        if (typeof res.costUsd === 'number') {
          setUsageInfo({
            costUsd: res.costUsd,
            durationMs: res.durationMs || 0,
            numTurns: res.numTurns || 1,
          });
          setShowUsage(true);
        }
        break;
      }

      case 'error': {
        setError((event as any).message);
        setStatus('error');
        break;
      }

      case 'file_changed':
      {
        const filePath = (event as any).filePath as string;
        const tool = (event as any).tool as ChangedFileEntry['tool'];
        if (!filePath) break;
        setChangedFiles((prev) => {
          const existing = prev.find((f) => f.filePath === filePath);
          if (existing) {
            return prev.map((f) =>
              f.filePath === filePath ? { ...f, count: f.count + 1, tool } : f,
            );
          }
          return [...prev, { filePath, tool, count: 1 }];
        });
        break;
      }
    }
  }, [onSessionIdChange, scrollToBottom]);

  // Send message
  const handleSend = useCallback(async (text: string, attachments?: Attachment[]) => {
    setError(null);

    // Add user message to blocks
    setBlocks(prev => [...prev, {
      id: 'user-' + Date.now(),
      type: 'user_text',
      content: text,
      attachments: attachments || [],
    }]);
    scrollToBottom();

    try {
      await ipc.invoke(Channels.AGENT_SEND, {
        convId: conversationId,
        text,
        attachments: attachments || [],
        model,
        permissionMode,
        thinkingEffort,
      });
    } catch (err) {
      setError(`Failed to send message: ${err}`);
    }
  }, [conversationId, model, permissionMode, thinkingEffort, scrollToBottom]);

  // Abort
  const handleAbort = useCallback(async () => {
    try {
      await ipc.invoke(Channels.AGENT_ABORT, { convId: conversationId });
    } catch (err) {
      console.error('Failed to abort:', err);
    }
  }, [conversationId]);

  // A4 修复：从队列移除已响应的权限请求，并显示下一个（若有）
  const popPermission = useCallback((requestId: string) => {
    setPermissionQueue(prev => {
      const next = prev.filter((r) => r.requestId !== requestId);
      setPermissionRequest(next.length > 0 ? next[0] : null);
      return next;
    });
  }, []);

  // Permission response
  const handleAllow = useCallback((requestId: string, allowAll?: boolean) => {
    // Use ref to get the latest permissionRequest — avoids stale closure when
    // the component re-renders between the click and the IPC call.
    const suggestions = permissionRequestRef.current?.suggestions;
    ipc.invoke(Channels.AGENT_PERMISSION_RESPOND, {
      convId: conversationId,
      decision: {
        behavior: 'allow',
        requestId,
        ...(allowAll && suggestions?.length ? { updatedPermissions: suggestions } : {}),
      },
    }).then((res: any) => {
      if (!res?.ok) console.error('[Agent] Permission allow failed:', res);
    }).catch((err: unknown) => {
      console.error('[Agent] Permission allow IPC error:', err);
    });
    popPermission(requestId);
  }, [conversationId, popPermission]);

  const handleDeny = useCallback((requestId: string) => {
    ipc.invoke(Channels.AGENT_PERMISSION_RESPOND, {
      convId: conversationId,
      decision: {
        behavior: 'deny',
        requestId,
        message: 'Denied by user',
      },
    }).then((res: any) => {
      if (!res?.ok) console.error('[Agent] Permission deny failed:', res);
    }).catch((err: unknown) => {
      console.error('[Agent] Permission deny IPC error:', err);
    });
    popPermission(requestId);
  }, [conversationId, popPermission]);

  // Branch conversation from a specific user message
  const handleBranch = useCallback(async (messageId: string) => {
    try {
      const res = await ipc.invoke<{ ok: boolean; conversation?: Conversation; error?: string }>(
        Channels.CONVERSATION_BRANCH,
        { sourceConvId: conversationId, messageId }
      );
      if (res?.ok && res.conversation) {
        window.dispatchEvent(new CustomEvent('ccd:switch-conv', { detail: { convId: res.conversation.id } }));
      }
    } catch (err) {
      console.error('Failed to branch:', err);
    }
  }, [conversationId]);

  // Retry — destroy old session and re-init
  const handleRetry = useCallback(async () => {
    setError(null);
    setStatus('idle');
    try {
      await ipc.invoke(Channels.AGENT_DESTROY, { convId: conversationId });
    } catch {
      // ignore destroy errors
    }
    await initSession();
  }, [conversationId, initSession]);



  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)' }}>
      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '8px 16px',
            background: 'rgba(255,69,58,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(255,69,58,0.12)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--danger)' }}>
            <AlertCircle size={14} />
            {error}
          </div>
          <button
            onClick={handleRetry}
            style={{
              background: 'none',
              border: '1px solid rgba(255,69,58,0.2)',
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--danger)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <RotateCcw size={11} />
            Retry
          </button>
        </div>
      )}

      {/* Messages area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px 24px 8px',
        }}
      >
        {blocks.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--fg-quaternary)', fontSize: 13, marginTop: 80 }}>
            Send a message to start
          </div>
        )}
        {hasMore && (
          <div ref={sentinelRef} style={{ padding: '12px', textAlign: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--fg-quaternary)' }}>
              {blocks.length - visibleCount} more messages above
            </span>
          </div>
        )}
        {visibleBlocks.map((block) => (
          <div key={block.id} style={{ position: 'relative' }} className="group">
            <AgentMessageBlockRenderer block={block} />
            {block.type === 'user_text' && (
              <button
                onClick={() => handleBranch(block.id)}
                title="Branch conversation from here"
                style={{
                  position: 'absolute', top: 4, right: -4,
                  width: 24, height: 24, borderRadius: 6,
                  background: 'var(--bg-surface-2, rgba(255,255,255,0.06))',
                  border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', opacity: 0, transition: 'opacity 150ms',
                  color: 'var(--fg-tertiary, rgba(255,255,255,0.45))', fontSize: 11,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0' }}
              >
                ⑂
              </button>
            )}
          </div>
        ))}

        {/* Status indicator */}
        <StatusBar status={status} label={statusLabel} toolName={statusToolName} />
      </div>

      {/* Permission bar */}
      {permissionRequest && (
        <AgentPermissionBar
          request={permissionRequest}
          onAllow={handleAllow}
          onDeny={handleDeny}
        />
      )}

      {/* Changed files panel - surfaces agent file edits inline */}
      <AgentChangedFiles files={changedFiles} onOpenDetails={onOpenActivity} />

      {/* Usage / cost line — /cost 或回合结束后展示 */}
      {showUsage && usageInfo && (
        <div
          className="flex items-center justify-center gap-3 px-4 py-1.5"
          style={{ background: 'var(--bg-surface)', borderTop: '1px solid var(--border-subtle)' }}
        >
          <span className="text-[11px] font-medium tabular-nums" style={{ color: 'var(--fg-tertiary)' }}>
            🪙 ${usageInfo.costUsd > 0 ? usageInfo.costUsd.toFixed(4) : '0.0000'}
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--fg-quaternary)' }}>
            {usageInfo.numTurns} turn{usageInfo.numTurns > 1 ? 's' : ''}
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--fg-quaternary)' }}>
            {(usageInfo.durationMs / 1000).toFixed(1)}s
          </span>
          <button
            onClick={() => setShowUsage(false)}
            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--tint-hover)]"
            style={{ color: 'var(--fg-quaternary)' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Input */}
      <AgentChatInput
        status={status}
        onSend={handleSend}
        onAbort={handleAbort}
        disabled={!isInitialized || !!error}
        model={model}
        permissionMode={permissionMode}
        thinkingEffort={thinkingEffort}
        models={models}
        permissionModes={permissionModes}
        thinkingEfforts={thinkingEfforts}
        onModelChange={onModelChange}
        onPermissionModeChange={onPermissionModeChange}
        onThinkingEffortChange={onThinkingEffortChange}
        onCostToggle={() => setShowUsage(prev => !prev)}
        availableSkills={availableSkills}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function StatusBar({ status, label, toolName }: { status: AgentStatus; label: string; toolName: string }) {
  if (status === 'idle' || status === 'completed' || status === 'streaming_text' || status === 'aborted') {
    return null;
  }

  const getIcon = () => {
    switch (status) {
      case 'requesting':
        return <Loader2 size={12} className="animate-spin" />;
      case 'thinking':
        return <Brain size={12} />;
      case 'tool_executing':
        return <Wrench size={12} />;
      case 'waiting_permission':
        return <Shield size={12} />;
      case 'error':
        return <AlertCircle size={12} />;
      default:
        return null;
    }
  };

  const getText = () => {
    switch (status) {
      case 'requesting': return 'Connecting...';
      case 'thinking': return 'Thinking...';
      case 'tool_executing':
        return toolName ? <>Running <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-bright, var(--accent-primary))' }}>{toolName}</code>...</> : 'Running...';
      case 'waiting_permission': return 'Waiting for approval...';
      default: return label || '';
    }
  };

  const color = status === 'waiting_permission' ? 'var(--warn)' : status === 'error' ? 'var(--danger)' : 'var(--fg-tertiary)';

  return (
    <div
      style={{
        height: 28,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
        fontWeight: 500,
        color,
        transition: 'opacity 150ms ease',
        padding: '0 2px',
      }}
    >
      {getIcon()}
      {getText()}
      {status === 'thinking' && (
        <span style={{ display: 'inline-flex', gap: 2, marginLeft: 2 }}>
          <span className="thinking-dot" style={{ width: 3, height: 3, borderRadius: '50%', background: color }} />
          <span className="thinking-dot" style={{ width: 3, height: 3, borderRadius: '50%', background: color }} />
          <span className="thinking-dot" style={{ width: 3, height: 3, borderRadius: '50%', background: color }} />
        </span>
      )}
    </div>
  );
}
