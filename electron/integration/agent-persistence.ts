/**
 * Agent 持久化 — 从 electron/main.ts 抽出的独立模块（可用内存 SQLite 做集成测试）。
 *
 * 职责：
 * - P0：以 SDK messageId 为粒度累计流式文本（delta 只更新临时文本，最终 text 覆盖），
 *   flush 时按到达顺序拼接落库，杜绝重复。
 * - A5：登记"已发送但尚未产出回复"的 user message；error 事件且无回复产出时
 *   精确回滚（仅当该消息仍是会话最后一条），不留幽灵消息。
 */
import { AgentTextAccumulator } from './agent-text-accumulator';
import type { MessageRepo } from '../db/repositories/message-repo';
import type { ConversationRepo } from '../db/repositories/conversation-repo';

export class AgentPersistence {
  private textAccumulators = new Map<string, AgentTextAccumulator>();
  private assistantMsgIds = new Map<string, string>();
  private contentBlocks = new Map<string, unknown[]>();
  /** A5：convId -> 已持久化但尚未产出任何回复的 user message id */
  private pendingUserMessages = new Map<string, string>();

  constructor(
    private readonly messageRepo: MessageRepo,
    private readonly conversationRepo: ConversationRepo,
  ) {}

  // -------------------------------------------------------------------------
  // 事件写入（P0）
  // -------------------------------------------------------------------------

  /** 最终 text：覆盖该 messageId 的临时文本（绝不追加）。 */
  onText(convId: string, messageId: string | undefined, text: string): void {
    this.getAccumulator(convId).onFinalText(messageId, text);
  }

  /** text_delta：只更新该 messageId 的临时文本。 */
  onTextDelta(convId: string, messageId: string | undefined, delta: string): void {
    this.getAccumulator(convId).onDelta(messageId, delta);
  }

  onThinking(convId: string, text: string): void {
    const blocks = this.contentBlocks.get(convId) || [];
    blocks.push({ type: 'thinking', text });
    this.contentBlocks.set(convId, blocks);
  }

  onToolUse(convId: string, toolName: string, toolUseId: string, input: Record<string, unknown>): void {
    const blocks = this.contentBlocks.get(convId) || [];
    blocks.push({ type: 'tool_use', toolName, toolUseId, input });
    this.contentBlocks.set(convId, blocks);
  }

  onToolResult(convId: string, toolUseId: string, content: unknown, isError: boolean): void {
    const blocks = this.contentBlocks.get(convId) || [];
    blocks.push({ type: 'tool_result', toolUseId, content, isError });
    this.contentBlocks.set(convId, blocks);
  }

  // -------------------------------------------------------------------------
  // A5：幽灵用户消息回滚
  // -------------------------------------------------------------------------

  /** 回复产出事件 → 回复已开始，不再回滚该 user message。 */
  markOutputStarted(convId: string): void {
    this.pendingUserMessages.delete(convId);
  }

  /** 持久化 user message 后登记，等待"确认已启动"。 */
  registerPendingUserMessage(convId: string, messageId: string): void {
    this.pendingUserMessages.set(convId, messageId);
  }

  clearPendingUserMessage(convId: string): void {
    this.pendingUserMessages.delete(convId);
  }

  /**
   * 发送被拒/启动失败时精确回滚：仅当该消息仍是会话最后一条时删除，
   * 并还原会话预览，绝不触碰已有历史。
   */
  rollbackPendingUserMessage(convId: string): void {
    const messageId = this.pendingUserMessages.get(convId);
    this.pendingUserMessages.delete(convId);
    if (!messageId) return;
    try {
      const msgs = this.messageRepo.getByConversation(convId);
      const last = msgs[msgs.length - 1];
      if (!last || last.id !== messageId) return; // 已有后续内容，不能回滚
      this.messageRepo.delete(messageId);
      const prev = msgs[msgs.length - 2];
      this.conversationRepo.updateLastMessage(convId, prev ? prev.content.slice(0, 200) : '');
    } catch (err) {
      console.error('[AgentPersistence] Failed to roll back user message:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Flush（P0 落库）
  // -------------------------------------------------------------------------

  /**
   * 把本轮回合的累积文本/块落库，并清空 per-message 临时状态。
   * 同一回合多条 assistant message 按到达顺序拼接。
   */
  flush(convId: string): void {
    const acc = this.textAccumulators.get(convId);
    const text = acc ? acc.flush() : undefined;
    const blocks = this.contentBlocks.get(convId);
    const msgId = this.assistantMsgIds.get(convId);

    try {
      const contentParts: unknown[] = [];
      if (text && text.trim()) {
        contentParts.push({ type: 'text', text: text.trim() });
      }
      if (blocks && blocks.length > 0) {
        contentParts.push(...blocks);
      }
      const serialized = contentParts.length > 0 ? JSON.stringify(contentParts) : (text || '');

      if (msgId) {
        this.messageRepo.updateContent(msgId, serialized);
      } else if (serialized) {
        const msg = this.messageRepo.create(convId, 'assistant', serialized);
        this.assistantMsgIds.set(convId, msg.id);
      }

      const preview = text ? (text.length > 200 ? text.slice(0, 200) + '…' : text) : '';
      if (preview) {
        this.conversationRepo.updateLastMessage(convId, preview);
      }
    } catch (err) {
      console.error('[AgentPersistence] Failed to persist agent messages:', err);
    }

    // flush 后清理本轮全部临时状态（含新增的 per-message 累计）
    this.textAccumulators.delete(convId);
    this.assistantMsgIds.delete(convId);
    this.contentBlocks.delete(convId);
  }

  /** before-quit：flush 所有未完成的 agent 持久化。 */
  flushAll(): void {
    const convs = new Set<string>([
      ...this.textAccumulators.keys(),
      ...this.contentBlocks.keys(),
      ...this.assistantMsgIds.keys(),
    ]);
    for (const convId of convs) {
      this.flush(convId);
    }
  }

  hasPending(convId: string): boolean {
    return this.textAccumulators.has(convId) || this.contentBlocks.has(convId);
  }

  private getAccumulator(convId: string): AgentTextAccumulator {
    let acc = this.textAccumulators.get(convId);
    if (!acc) {
      acc = new AgentTextAccumulator();
      this.textAccumulators.set(convId, acc);
    }
    return acc;
  }
}
