/**
 * AgentSdkBridge — A5 幽灵用户消息回归测试。
 *
 * 覆盖：快速连发时第二次发送在持久化 user message 之前就被拒绝。
 * 判定函数 canAcceptMessage 与 sendMessage 内部守卫、checkCanSend 共用同一逻辑。
 * （不调用 sendMessage 本身，避免在测试中拉起真实 Claude CLI 进程。）
 */
import { describe, it, expect } from 'vitest';
import { AgentSdkBridge, canAcceptMessage } from './agent-sdk-bridge';

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
