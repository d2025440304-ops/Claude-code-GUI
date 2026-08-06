/**
 * finalizeStreamingBlocks / applyChunkToBlocks — C10 永久 spinner 与流式块应用回归测试。
 */
import { describe, it, expect } from 'vitest';
import { finalizeStreamingBlocks, applyChunkToBlocks, safeParseJSON } from './streamBlocks';
import type { ContentBlock } from '../types';
import type { StreamChunk } from './ipc';

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

describe('applyChunkToBlocks (Chat 流式块应用)', () => {
  const chunk = (c: Partial<StreamChunk> & { type: StreamChunk['type'] }): StreamChunk => c as StreamChunk;

  it('text 增量追加到最后一个 streaming text 块', () => {
    const blocks: ContentBlock[] = [{ id: 't1', type: 'text', content: 'Hel', status: 'streaming' }];
    const result = applyChunkToBlocks(blocks, chunk({ type: 'text', content: 'lo' }));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Hello');
  });

  it('blockStart 时新建 text 块', () => {
    const result = applyChunkToBlocks([], chunk({ type: 'text', content: 'Hi', blockStart: true }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'text', content: 'Hi', status: 'streaming' });
  });

  it('tool_use blockStart 新建 streaming 块，input 到达后终结为 completed', () => {
    const start = applyChunkToBlocks([], chunk({ type: 'tool_use', tool: 'Bash', toolUseId: 'toolu_1' }));
    expect(start[0]).toMatchObject({ type: 'tool_use', status: 'streaming' });

    const done = applyChunkToBlocks(start, chunk({ type: 'tool_use', tool: 'Bash', toolUseId: 'toolu_1', input: '{"command":"ls"}' }));
    expect(done[0].status).toBe('completed');
    expect(done[0].toolInput).toEqual({ command: 'ls' });
  });

  it('tool_result 关联到对应 tool_use 块并标记完成', () => {
    const blocks: ContentBlock[] = [{ id: 'tu', type: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_1', status: 'streaming' }];
    const result = applyChunkToBlocks(blocks, chunk({ type: 'tool_result', toolUseId: 'toolu_1', content: 'done', stdout: 'ok' }));
    expect(result[0].status).toBe('completed');
    expect(result[0].stdout).toBe('ok');
  });

  it('permission_denial 直接新建 error 块', () => {
    const result = applyChunkToBlocks([], chunk({ type: 'permission_denial', tool: 'Bash', content: 'denied' }));
    expect(result[0]).toMatchObject({ type: 'permission_denial', status: 'error' });
  });

  it('safeParseJSON 失败返回 undefined', () => {
    expect(safeParseJSON('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseJSON('not json')).toBeUndefined();
    expect(safeParseJSON('')).toBeUndefined();
  });
});
