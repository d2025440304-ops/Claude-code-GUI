/**
 * message-utils — Chat 历史消息恢复工具回归测试。
 */
import { describe, it, expect } from 'vitest';
import { getProjectName, plainifyJSONContent, deserializeMessageBlocks } from './message-utils';
import type { Message } from '../types';

describe('getProjectName', () => {
  it('提取路径最后一段', () => {
    expect(getProjectName('/Users/dai/projects/my-app')).toBe('my-app');
    expect(getProjectName('my-app')).toBe('my-app');
    expect(getProjectName(null)).toBeNull();
  });
});

describe('plainifyJSONContent', () => {
  it('从结构化 parts 中提取 text 拼接为纯文本', () => {
    const msg = {
      role: 'assistant' as const,
      content: JSON.stringify([
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: {} },
        { type: 'text', text: 'world' },
      ]),
    };
    expect(plainifyJSONContent(msg).content).toBe('Hello world');
  });

  it('纯文本内容原样返回', () => {
    expect(plainifyJSONContent({ role: 'user', content: 'hi' }).content).toBe('hi');
  });
});

describe('deserializeMessageBlocks', () => {
  it('结构化 JSON 恢复为 contentBlocks（text/thinking/tool_use/tool_result 关联）', () => {
    const msg: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: JSON.stringify([
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'ls' } },
        { type: 'tool_result', toolUseId: 'toolu_1', content: 'src', stdout: 'src', isError: false },
      ]),
    };
    const out = deserializeMessageBlocks(msg);
    expect(out.contentBlocks).toHaveLength(2);
    expect(out.contentBlocks![0]).toMatchObject({ type: 'text', status: 'completed' });
    // tool_result 合并进 tool_use 块
    expect(out.contentBlocks![1]).toMatchObject({
      type: 'tool_use',
      toolUseId: 'toolu_1',
      status: 'completed',
      stdout: 'src',
    });
    // content 派生出纯文本
    expect(out.content).toBe('Let me check');
  });

  it('tool_result 带 isError 时标记 error 状态', () => {
    const msg: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: JSON.stringify([
        { type: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'ls' } },
        { type: 'tool_result', toolUseId: 'toolu_1', content: 'fail', isError: true },
      ]),
    };
    const out = deserializeMessageBlocks(msg);
    expect(out.contentBlocks![0].status).toBe('error');
  });

  it('非 JSON / 已带 contentBlocks 的消息原样返回', () => {
    const plain: Message = { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', timestamp: 'x' };
    expect(deserializeMessageBlocks(plain)).toBe(plain);
    const hasBlocks: Message = { ...plain, contentBlocks: [{ id: 'x', type: 'text', content: 'y' }] };
    expect(deserializeMessageBlocks(hasBlocks)).toBe(hasBlocks);
  });
});
