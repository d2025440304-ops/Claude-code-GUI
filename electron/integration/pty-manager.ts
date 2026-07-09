/**
 * PTY 管理器 — 管理多个伪终端实例。
 *
 * 使用 node-pty 创建真正的伪终端，
 * 通过 IPC 与渲染进程双向通信。
 */

import * as pty from 'node-pty';
import * as os from 'os';

interface PtyInstance {
  id: string;
  pty: pty.IPty;
  createdAt: number;
}

export class PtyManager {
  private instances = new Map<string, PtyInstance>();
  private dataCallbacks = new Map<string, (data: string) => void>();
  private exitCallbacks = new Map<string, (exitCode: number) => void>();

  /**
   * 创建一个新的 PTY 实例。
   */
  create(id: string, cwd?: string): { ok: boolean; error?: string } {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      // 使用 login shell 确保加载用户环境
      const ptyProcess = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: cwd || os.homedir(),
        env: { ...process.env } as Record<string, string>,
      });

      const instance: PtyInstance = {
        id,
        pty: ptyProcess,
        createdAt: Date.now(),
      };

      this.instances.set(id, instance);

      // 监听输出
      ptyProcess.onData((data: string) => {
        const cb = this.dataCallbacks.get(id);
        if (cb) cb(data);
      });

      // 监听退出
      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        const cb = this.exitCallbacks.get(id);
        if (cb) cb(exitCode);
        this.instances.delete(id);
        this.dataCallbacks.delete(id);
        this.exitCallbacks.delete(id);
      });

      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * 向指定 PTY 写入数据（stdin）。
   */
  write(id: string, data: string): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.pty.write(data);
    }
  }

  /**
   * 调整指定 PTY 的尺寸。
   */
  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.pty.resize(cols, rows);
    }
  }

  /**
   * 关闭指定 PTY。
   */
  kill(id: string): void {
    const instance = this.instances.get(id);
    if (instance) {
      try {
        instance.pty.kill();
      } catch {}
      this.instances.delete(id);
      this.dataCallbacks.delete(id);
      this.exitCallbacks.delete(id);
    }
  }

  /**
   * 注册输出回调。
   */
  onData(id: string, callback: (data: string) => void): void {
    this.dataCallbacks.set(id, callback);
  }

  /**
   * 注册退出回调。
   */
  onExit(id: string, callback: (exitCode: number) => void): void {
    this.exitCallbacks.set(id, callback);
  }

  /**
   * 关闭所有 PTY 实例。
   */
  killAll(): void {
    for (const [id] of this.instances) {
      this.kill(id);
    }
  }
}
