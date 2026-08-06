/**
 * CliSpawner — C7 启动失败回归测试。
 *
 * 覆盖：CLI 不存在（ENOENT → not_found）、spawn 错误（→ spawn）、
 * 同一会话已有运行进程时第二次 sendAndStream 同步抛错（主进程据此回滚 user message）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { CliSpawner } from './cli-spawner';
import type { CLIErrorEvent } from './cli-spawner';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

/** 可控的假子进程：足够支持 CliSpawner 的 stdout/stderr/stdin 监听与 teardown。 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stdin = new EventEmitter() as unknown as NodeJS.WritableStream;
  kill(_signal?: NodeJS.Signals): boolean {
    return true;
  }
}

function waitForError(cli: CliSpawner, sessionId: string): Promise<{ kind: string; message: string }> {
  return new Promise((resolve) => {
    cli.on('error', (e: CLIErrorEvent) => {
      if (e.sessionId === sessionId) resolve({ kind: e.error.kind, message: e.error.message });
    });
  });
}

describe('CliSpawner 启动失败 (C7 孤儿用户消息)', () => {
  let cli: CliSpawner;

  beforeEach(() => {
    cli = new CliSpawner();
    spawnMock.mockReset();
  });

  it('CLI 不存在（ENOENT）→ 发出 not_found 错误事件（主进程据此回滚 user message）', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const errorP = waitForError(cli, 'c1');
    cli.sendAndStream('c1', { cwd: '/tmp', model: 'default', message: 'hi' });
    expect(spawnMock).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object));

    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    const err = await errorP;
    expect(err.kind).toBe('not_found');
  });

  it('spawn 错误（EACCES）→ 发出 spawn 错误事件', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const errorP = waitForError(cli, 'c1');
    cli.sendAndStream('c1', { cwd: '/tmp', model: 'default', message: 'hi' });
    child.emit('error', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const err = await errorP;
    expect(err.kind).toBe('spawn');
  });

  it('同一会话已有运行进程 → 第二次 sendAndStream 同步抛错（不产生孤儿消息）', () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    cli.sendAndStream('c1', { cwd: '/tmp', model: 'default', message: 'first' });
    expect(() => cli.sendAndStream('c1', { cwd: '/tmp', model: 'default', message: 'second' }))
      .toThrow(/already has a running process/);
  });

  it('错误事件后会话被清理，可再次发送（teardown 无泄漏）', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const errorP = waitForError(cli, 'c1');
    cli.sendAndStream('c1', { cwd: '/tmp', model: 'default', message: 'hi' });
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await errorP;
    expect(cli.hasSession('c1')).toBe(false);
  });
});
