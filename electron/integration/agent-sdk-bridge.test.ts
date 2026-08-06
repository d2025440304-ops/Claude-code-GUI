/**
 * AgentSdkBridge — A5 幽灵用户消息回归测试。
 *
 * 覆盖：快速连发时第二次发送在持久化 user message 之前就被拒绝。
 * 判定函数 canAcceptMessage 与 sendMessage 内部守卫、checkCanSend 共用同一逻辑。
 * （不调用 sendMessage 本身，避免在测试中拉起真实 Claude CLI 进程。）
 */
import { describe, it, expect } from 'vitest';
import { AgentSdkBridge, canAcceptMessage, translateAssistantBlocks, normalizeToolResultContent } from './agent-sdk-bridge';

describe('canAcceptMessage (A5 快速连发)', () => {
  it('只有 idle / completed 允许发送', () => {
    expect(canAcceptMessage('idle').ok).toBe(true);
    expect(canAcceptMessage('completed').ok).toBe(true);
  });

  it('进行中/等待/错误状态全部拒绝（第二次快速发送的判定）', () => {
    for (const busy of ['requesting', 'thinking', 'streaming_text', 'tool_executing', 'waiting_permission', 'error', 'aborted'] as const) {
      const res = canAcceptMessage(busy);
      expect(res.ok).toBe(false);
      expect(res.error).toContain(busy);
    }
  });

  it('session 不存在时拒绝', () => {
    const res = canAcceptMessage(undefined);
    expect(res.ok).toBe(false);
  });
});

describe('AgentSdkBridge.checkCanSend', () => {
  it('无 session 时拒绝发送', () => {
    const bridge = new AgentSdkBridge();
    const res = bridge.checkCanSend('missing-conv');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('新建 session 后（idle）允许发送', () => {
    const bridge = new AgentSdkBridge();
    bridge.createSession('c1', { cwd: process.cwd() });
    expect(bridge.checkCanSend('c1').ok).toBe(true);
  });
});

describe('translateAssistantBlocks (事件翻译层)', () => {
  it('text / thinking / tool_use 翻译为事件并携带 messageId；未知块忽略', () => {
    const out = translateAssistantBlocks('msg-1', 'sess-1', 123, [
      { type: 'text', text: 'Hello' },
      { type: 'thinking', thinking: 'hmm…' },
      { type: 'tool_use', name: 'Bash', id: 'toolu_1', input: { command: 'ls' } },
      { type: 'unexpected_block' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].event).toMatchObject({ type: 'text', text: 'Hello', messageId: 'msg-1', sessionId: 'sess-1', timestamp: 123 });
    expect(out[1].event).toMatchObject({ type: 'thinking', text: 'hmm…', messageId: 'msg-1' });
    expect(out[2].event).toMatchObject({ type: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'ls' }, messageId: 'msg-1' });
  });

  it('tool_use 附带 toolMeta（供 tool_result 关联）；file_path 缺失时省略', () => {
    const [withPath] = translateAssistantBlocks('m', 's', 0, [
      { type: 'tool_use', name: 'Edit', id: 'toolu_2', input: { file_path: '/a/b.ts' } },
    ]);
    expect(withPath.toolMeta).toEqual({ toolUseId: 'toolu_2', toolName: 'Edit', filePath: '/a/b.ts' });

    const [noPath] = translateAssistantBlocks('m', 's', 0, [
      { type: 'tool_use', name: 'Bash', id: 'toolu_3', input: { command: 'ls' } },
    ]);
    expect(noPath.toolMeta?.filePath).toBeUndefined();
  });

  it('tool_use 无 input 时回退为空对象', () => {
    const [out] = translateAssistantBlocks('m', 's', 0, [{ type: 'tool_use', name: 'Read', id: 'toolu_4' }]);
    expect((out.event as { input?: unknown }).input).toEqual({});
  });
});

describe('normalizeToolResultContent (tool_result 归一化)', () => {
  it('字符串原样返回', () => {
    expect(normalizeToolResultContent('done')).toBe('done');
  });

  it('数组拼接（字符串 + {text} 混合）', () => {
    expect(normalizeToolResultContent(['a', { text: 'b' }, { text: '' }])).toBe('a\nb\n');
  });

  it('对象/其他类型序列化', () => {
    expect(normalizeToolResultContent({ x: 1 })).toBe('{"x":1}');
    expect(normalizeToolResultContent(null)).toBe('""');
  });
});
