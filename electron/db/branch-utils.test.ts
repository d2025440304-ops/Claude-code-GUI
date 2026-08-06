/**
 * selectBranchMessages — A13 分支会话回归测试。
 *
 * 验证：分支后新会话包含目标用户消息及之前全部历史；
 * 目标消息必须是真实 SQLite message id，找不到时不返回空结果。
 */
import { describe, it, expect } from 'vitest';
import { selectBranchMessages } from './branch-utils';

describe('selectBranchMessages (A13 分支)', () => {
  const msgs = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];

  it('返回目标消息及之前全部历史（分支后包含目标用户消息）', () => {
    const result = selectBranchMessages(msgs, 'm2');
    expect(result).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('目标为第一条时只复制目标本身', () => {
    const result = selectBranchMessages(msgs, 'm1');
    expect(result).toEqual([{ id: 'm1' }]);
  });

  it('目标为最后一条时复制全部历史', () => {
    const result = selectBranchMessages(msgs, 'm3');
    expect(result).toEqual(msgs);
  });

  it('找不到目标消息（如前端 optimistic block id）时返回 null，不创建空分支', () => {
    expect(selectBranchMessages(msgs, 'user-1735000000000')).toBeNull();
    expect(selectBranchMessages([], 'anything')).toBeNull();
  });
});
