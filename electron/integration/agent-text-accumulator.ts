/**
 * Agent SDK 流式文本累计器 — 以 SDK messageId 为粒度。
 *
 * 问题背景（P0 重复持久化）：
 * Agent bridge 对同一条 assistant message 会先后发出多个 text_delta 增量事件，
 * 以及一个携带完整文本的 text 事件。旧的实现把两者都追加进同一个累计串，
 * 导致落库后的回复文本重复（切会话/重启后可见）。
 *
 * 语义：
 * - onDelta(messageId, delta)     ：把增量追加到该 messageId 的临时文本；
 * - onFinalText(messageId, text)  ：用完整文本覆盖该 messageId 的临时文本（绝不追加）；
 * - 同一回合的多条 assistant message 按到达顺序拼接，保持正确顺序；
 * - flush()                       ：返回拼接后的完整文本并清空全部临时状态。
 */
export class AgentTextAccumulator {
  private perMessage = new Map<string, string>();
  private order: string[] = [];

  private touch(key: string): void {
    if (!this.perMessage.has(key)) {
      this.order.push(key);
    }
  }

  /** text_delta：只更新该 messageId 的临时文本。 */
  onDelta(messageId: string | undefined, delta: string): void {
    const key = messageId || '';
    this.touch(key);
    this.perMessage.set(key, (this.perMessage.get(key) || '') + delta);
  }

  /** 最终 text：用完整文本覆盖该 messageId 的临时文本，绝不再追加。 */
  onFinalText(messageId: string | undefined, text: string): void {
    const key = messageId || '';
    this.touch(key);
    this.perMessage.set(key, text);
  }

  /** 返回按 messageId 到达顺序拼接的完整文本，并清空全部临时状态。 */
  flush(): string {
    const text = this.order.map((k) => this.perMessage.get(k) || '').join('');
    this.clear();
    return text;
  }

  clear(): void {
    this.perMessage.clear();
    this.order = [];
  }

  get hasPending(): boolean {
    return this.order.length > 0;
  }
}
