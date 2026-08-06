/**
 * finalizeStreamingBlocks — C10 永久 spinner 回归测试。
 *
 * 至少覆盖：tool_use 在无 tool_result 时收到 stream:end 与 stream:error。
 */
import { describe, it, expect } from 'vitest';
import { finalizeStreamingBlocks } from './streamBlocks';
import type { ContentBlock } from '../types';

const toolUseBlock = (): ContentBlock => ({
  id: 'tu1',
  type: 'tool_use',
  toolName: 'Bash',
  toolUseId: 'toolu_1',
  toolInput: { command: 'ls' },
  status: 'streaming',
});

describe('finalizeStreamingBlocks (C10 永久 spinner)', () => {
  it('tool_use 无 tool_result 时收到 stream:end → 终结为 completed', () => {
    const result = finalizeStreamingBlocks([toolUseBlock()], 'completed');
    expect(result[0].status).toBe('completed');
  });

  it('tool_use 无 tool_result 时收到 stream:error → 终结为 error', () => {
    const result = finalizeStreamingBlocks([toolUseBlock()], 'error');
    expect(result[0].status).toBe('error');
  });

  it('streaming text / thinking 块同样被终结', () => {
    const blocks: ContentBlock[] = [
      { id: 't1', type: 'text', content: 'hi', status: 'streaming' },
      { id: 'th1', type: 'thinking', content: 'thinking…', status: 'streaming' },
      toolUseBlock(),
    ];
    const result = finalizeStreamingBlocks(blocks, 'completed');
    expect(result.every((b) => b.status === 'completed')).toBe(true);
  });

  it('已完成 tool_result / thinking / text 内容不被覆盖', () => {
    const blocks: ContentBlock[] = [
      { id: 'tr1', type: 'tool_result', toolUseId: 'toolu_1', content: 'done', stdout: 'ok', status: 'completed' },
      { id: 'th1', type: 'thinking', content: 'already thought', status: 'completed' },
      { id: 'tx1', type: 'text', content: 'final answer', status: 'completed' },
      { id: 'tu2', type: 'tool_use', toolName: 'Read', toolUseId: 'toolu_2', status: 'error' },
    ];
    const result = finalizeStreamingBlocks(blocks, 'error');
    // 已完成/错误块及其内容原样保留
    expect(result[0]).toEqual(blocks[0]);
    expect(result[1]).toEqual(blocks[1]);
    expect(result[2]).toEqual(blocks[2]);
    expect(result[3]).toEqual(blocks[3]);
  });

  it('空数组与无 streaming 块的数组安全返回', () => {
    expect(finalizeStreamingBlocks([], 'completed')).toEqual([]);
    const done: ContentBlock[] = [{ id: 'tx', type: 'text', content: 'x', status: 'completed' }];
    expect(finalizeStreamingBlocks(done, 'error')).toEqual(done);
  });
});
