/**
 * AgentTextAccumulator — P0 流式文本持久化去重回归测试。
 *
 * 覆盖场景：多个 text_delta + 最终 text 落库不重复、
 * 同一回合多条 assistant message 顺序、flush 后临时状态清理。
 */
import { describe, it, expect } from 'vitest';
import { AgentTextAccumulator } from './agent-text-accumulator';

describe('AgentTextAccumulator', () => {
  it('多个 delta + 最终 text：落库文本不重复（最终 text 覆盖临时文本）', () => {
    const acc = new AgentTextAccumulator();
    // 流式增量
    acc.onDelta('msg-1', 'Hello ');
    acc.onDelta('msg-1', 'world');
    // 同一条 assistant message 的完整 text 事件
    acc.onFinalText('msg-1', 'Hello world');
    expect(acc.flush()).toBe('Hello world');
  });

  it('没有最终 text（流被中断）时只保留已流式文本', () => {
    const acc = new AgentTextAccumulator();
    acc.onDelta('msg-1', 'partial ');
    acc.onDelta('msg-1', 'text');
    expect(acc.flush()).toBe('partial text');
  });

  it('同一回合多条 assistant message 保持到达顺序', () => {
    const acc = new AgentTextAccumulator();
    acc.onDelta('msg-1', 'First…');
    acc.onFinalText('msg-1', 'First answer');
    acc.onDelta('msg-2', 'Second…');
    acc.onFinalText('msg-2', 'Second answer');
    expect(acc.flush()).toBe('First answerSecond answer');
  });

  it('不同 messageId 的 delta 互不干扰', () => {
    const acc = new AgentTextAccumulator();
    acc.onDelta('a', 'A');
    acc.onDelta('b', 'B');
    acc.onDelta('a', 'A2');
    expect(acc.flush()).toBe('AA2B');
  });

  it('flush 后清空临时状态，新回合重新累计', () => {
    const acc = new AgentTextAccumulator();
    acc.onFinalText('msg-1', 'turn 1');
    expect(acc.flush()).toBe('turn 1');
    expect(acc.hasPending).toBe(false);
    acc.onDelta('msg-2', 'turn 2');
    expect(acc.flush()).toBe('turn 2');
    expect(acc.hasPending).toBe(false);
  });

  it('messageId 缺失时回退到单一槽位（不丢失文本）', () => {
    const acc = new AgentTextAccumulator();
    acc.onDelta(undefined, 'hello');
    acc.onFinalText(undefined, 'hello');
    expect(acc.flush()).toBe('hello');
  });
});
