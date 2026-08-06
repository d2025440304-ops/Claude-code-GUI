/**
 * C10 修复：终结 assistant message 中所有 status === 'streaming' 的 content block。
 *
 * - stream:end（正常结束/用户停止）→ 'completed'：即使 tool_use 没有对应的
 *   tool_result，流已经结束，block 必须离开 streaming 状态，否则 UI 永久显示 spinner。
 * - stream:error（报错/中断）→ 'error'：状态与实际语义一致。
 *
 * 只修改 streaming 状态；已 completed/error 的 block 及其内容（tool_result、
 * thinking、text）原样保留，绝不覆盖。
 */
import type { ContentBlock } from '../types';

export type StreamBlockOutcome = 'completed' | 'error';

export function finalizeStreamingBlocks(
  blocks: ContentBlock[],
  outcome: StreamBlockOutcome,
): ContentBlock[] {
  return blocks.map((b) => (b.status === 'streaming' ? { ...b, status: outcome } : b));
}
