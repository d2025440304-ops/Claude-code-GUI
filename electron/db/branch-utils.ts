/**
 * A13 修复：分支会话的源消息选取（纯函数，便于回归测试）。
 *
 * 从会话全部消息中选出「目标消息及之前的历史」（slice(0, targetIdx + 1)），
 * 新分支会话只复制这些消息。目标消息必须是真实的 SQLite message id；
 * 找不到时返回 null，由调用方返回 ok:false —— 绝不创建空分支会话。
 */
export function selectBranchMessages<T extends { id: string }>(
  allMessages: T[],
  targetMessageId: string,
): T[] | null {
  const targetIdx = allMessages.findIndex((m) => m.id === targetMessageId);
  if (targetIdx < 0) return null;
  return allMessages.slice(0, targetIdx + 1);
}
