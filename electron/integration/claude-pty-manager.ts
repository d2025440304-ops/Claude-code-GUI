/**
 * ClaudePtyManager — 管理交互式 Claude Code PTY 会话。
 *
 * 与 CliSpawner（one-shot `claude -p` 模式）不同，此管理器创建持久的
 * 交互式 `claude` 进程（不带 `-p` 标志），完整保留 Claude Code 的
 * 交互式 TUI 体验：斜杠命令、权限提示、工具调用等全部可用。
 *
 * 每个 PTY 会话对应一个 conversation，使用 --resume 或 --session-id
 * 维持会话连续性。
 */

import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export interface ClaudePtyOptions {
  /** 工作目录（项目路径） */
  cwd: string;
  /** 模型别名或 ID */
  model?: string;
  /** Claude 会话 ID（用于 --resume） */
  resumeSessionId?: string;
  /** 权限模式: default | acceptEdits | plan | bypassPermissions */
  permissionMode?: string;
  /** 额外目录（--add-dir） */
  addDirs?: string[];
  /** 额外 CLI 参数 */
  extraArgs?: string[];
}

export interface ClaudePtyInstance {
  id: string;
  pty: pty.IPty;
  cwd: string;
  createdAt: number;
  /** 标记是否已退出 */
  exited: boolean;
}

/** 权限提示信息 */
export interface ClaudePtyPermission {
  /** 会话 ID */
  id: string;
  /** 权限提示的原始文本（已去除 ANSI 码） */
  text: string;
  /** 检测到的选项（如 ["Yes", "Yes, and don't ask again", "No"]） */
  options: string[];
}

export class ClaudePtyManager {
  private instances = new Map<string, ClaudePtyInstance>();
  private dataCallbacks = new Map<string, (data: string) => void>();
  private exitCallbacks = new Map<string, (exitCode: number) => void>();
  private permissionCallbacks = new Map<string, (permission: ClaudePtyPermission) => void>();

  /** 用于权限检测的最近输出 buffer（去除 ANSI 后的纯文本） */
  private outputBuffers = new Map<string, string>();
  /** 最近一次发射权限提示的时间戳，避免重复发射 */
  private lastPermissionTime = new Map<string, number>();

  /**
   * 去除 ANSI 转义序列，返回纯文本。
   */
  private static stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b[()][AB012]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }

  /**
   * 检测 PTY 输出中的权限提示。
   * Claude Code 的权限提示通常包含 "Allow" + "?" 和编号选项（1. Yes  2. No 等）。
   */
  private detectPermission(id: string, data: string): void {
    const plain = ClaudePtyManager.stripAnsi(data);
    if (!plain) return;

    // 追加到 buffer（保留最近 2000 字符）
    let buf = this.outputBuffers.get(id) || '';
    buf += plain;
    if (buf.length > 2000) buf = buf.slice(-2000);
    this.outputBuffers.set(id, buf);

    // 检测权限提示模式
    // 模式 1: "Allow ... ?" + "1. Yes" / "2. ..." / "3. No"
    // 模式 2: "Do you want to allow"
    // 模式 3: "Allow?" 后跟 y/n 选项
    const hasAllowQuestion = /allow.*\?/i.test(buf) || /do you want to allow/i.test(buf);
    if (!hasAllowQuestion) return;

    // 避免重复发射（5 秒内的相同提示不重复）
    const now = Date.now();
    const lastTime = this.lastPermissionTime.get(id) || 0;
    if (now - lastTime < 5000) return;

    // 提取选项行（如 "1. Yes", "2. Yes, and don't ask again", "3. No"）
    const options: string[] = [];
    const optionRegex = /\d+\.\s+(.+)/g;
    let match: RegExpExecArray | null;
    while ((match = optionRegex.exec(buf)) !== null) {
      const opt = match[1].trim();
      if (opt) options.push(opt);
    }

    // 如果没找到编号选项，尝试 y/n 模式
    if (options.length === 0) {
      if (/\byes\b/i.test(buf) && /\bno\b/i.test(buf)) {
        options.push('Yes', 'No');
      }
    }

    // 只有找到至少 2 个选项时才发射权限事件
    if (options.length < 2) return;

    this.lastPermissionTime.set(id, now);

    // 提取权限提示的文本（从 "Allow" 到 buffer 末尾）
    const allowIdx = buf.toLowerCase().indexOf('allow');
    const text = allowIdx >= 0 ? buf.slice(allowIdx) : buf.slice(-200);

    const permission: ClaudePtyPermission = {
      id,
      text: text.trim(),
      options,
    };

    const cb = this.permissionCallbacks.get(id);
    if (cb) cb(permission);

    // 清空 buffer 避免重复检测
    this.outputBuffers.set(id, '');
  }

  /**
   * 查找 claude 可执行文件路径。
   *
   * macOS GUI 应用的 PATH 通常不包含用户 shell 配置的路径（如 nvm、homebrew），
   * 因此需要通过 login shell 解析完整的 PATH 后再查找。
   */
  private findClaudeBinary(): string {
    // 方法 1：直接检查 process.env.PATH
    const envPaths = (process.env.PATH || '').split(':');
    for (const p of envPaths) {
      if (!p) continue;
      const candidate = path.join(p, 'claude');
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // ignore
      }
    }

    // 方法 2：通过 login shell 查找（确保加载用户 .zshrc / .bash_profile）
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const result = execSync(`${shell} -l -c 'which claude'`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      // shell 查找失败，继续回退
    }

    // 方法 3：检查常见安装路径
    const commonPaths = [
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(os.homedir(), '.local/bin/claude'),
      path.join(os.homedir(), '.npm-global/bin/claude'),
      path.join(os.homedir(), '.bun/bin/claude'),
      path.join(os.homedir(), '.volta/bin/claude'),
    ];
    for (const p of commonPaths) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          return p;
        }
      } catch {
        // ignore
      }
    }

    // 最后回退：直接用 'claude'，node-pty 可能仍能找到
    return 'claude';
  }

  /**
   * 通过 login shell 获取完整的环境变量（特别是 PATH）。
   * macOS GUI 应用的 PATH 通常不完整，需要从 shell 配置中补充。
   */
  private getShellEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      // 获取 login shell 的完整 PATH
      const shellPath = execSync(`${shell} -l -c 'echo $PATH'`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (shellPath) {
        // 合并 shell PATH 和现有 PATH，去重
        const existingPaths = new Set((env.PATH || '').split(':'));
        const newPaths = shellPath.split(':').filter((p) => p && !existingPaths.has(p));
        env.PATH = [...(env.PATH ? env.PATH.split(':') : []), ...newPaths].join(':');
      }
    } catch {
      // 如果获取失败，使用现有环境
    }
    // 确保终端环境变量正确设置，Claude Code TUI 需要这些
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'claude-code-desktop';
    env.TERM_PROGRAM_VERSION = '1.0.0';
    // 确保 HOME 正确设置
    if (!env.HOME) env.HOME = os.homedir();
    // 确保 SHELL 正确设置
    if (!env.SHELL) env.SHELL = '/bin/zsh';
    return env;
  }

  /**
   * 创建一个新的交互式 Claude Code PTY 会话。
   * 不使用 -p 标志，保留完整的交互式 TUI 体验。
   */
  create(id: string, opts: ClaudePtyOptions): { ok: boolean; error?: string } {
    // 如果已有实例，先关闭
    if (this.instances.has(id)) {
      this.kill(id);
    }

    const claudeBin = this.findClaudeBinary();
    // 处理 '~' 或空路径，回退到用户主目录
    let cwd = opts.cwd || os.homedir();
    if (cwd === '~' || cwd === '') cwd = os.homedir();

    // 构建参数：交互式模式（不带 -p）
    const args: string[] = [];

    // 模型
    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    // 会话恢复
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    // 权限模式
    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }

    // 额外目录
    if (opts.addDirs && opts.addDirs.length > 0) {
      args.push('--add-dir', ...opts.addDirs);
    }

    // 额外参数
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }

    try {
      // 使用 node-pty 创建真正的伪终端
      // 使用从 login shell 获取的完整环境变量
      const shellEnv = this.getShellEnv();
      console.log(`[ClaudePty] Spawning: ${claudeBin} ${args.join(' ')} (cwd: ${cwd})`);
      const ptyProcess = pty.spawn(claudeBin, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: shellEnv,
      });

      const instance: ClaudePtyInstance = {
        id,
        pty: ptyProcess,
        cwd,
        createdAt: Date.now(),
        exited: false,
      };

      this.instances.set(id, instance);

      // 监听输出
      ptyProcess.onData((data: string) => {
        const cb = this.dataCallbacks.get(id);
        if (cb) cb(data);
        // 权限提示检测
        this.detectPermission(id, data);
      });

      // 监听退出
      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        console.log(`[ClaudePty] Session ${id} exited with code ${exitCode}`);
        const inst = this.instances.get(id);
        if (inst) inst.exited = true;
        const cb = this.exitCallbacks.get(id);
        if (cb) cb(exitCode);
        // 不立即删除实例，允许退出后仍读取状态
      });

      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * 向指定 PTY 写入数据（用户输入、按键等）。
   */
  write(id: string, data: string): void {
    const instance = this.instances.get(id);
    if (instance && !instance.exited) {
      instance.pty.write(data);
    }
  }

  /**
   * 调整指定 PTY 的尺寸。
   */
  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id);
    if (instance && !instance.exited) {
      try {
        instance.pty.resize(cols, rows);
      } catch {
        // 忽略 resize 错误
      }
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
      this.permissionCallbacks.delete(id);
      this.outputBuffers.delete(id);
      this.lastPermissionTime.delete(id);
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
   * 注册权限提示回调。
   * 当 PTY 输出中检测到权限提示时，调用此回调。
   */
  onPermission(id: string, callback: (permission: ClaudePtyPermission) => void): void {
    this.permissionCallbacks.set(id, callback);
  }

  /**
   * 检查指定 PTY 是否存在且未退出。
   */
  isActive(id: string): boolean {
    const instance = this.instances.get(id);
    return !!instance && !instance.exited;
  }

  /**
   * 获取指定 PTY 实例。
   */
  getInstance(id: string): ClaudePtyInstance | undefined {
    return this.instances.get(id);
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
