/**
 * SessionWatcher — 实时监听 Claude Code 的 session `.jsonl` 文件，
 * 解析新增行，提取结构化事件（工具调用、diff、文件变更、思考过程等）。
 *
 * Claude Code 会在 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
 * 中写入完整的会话日志（JSONL 格式，每行一个 JSON 对象）。
 *
 * 我们不需要 Claude Code 的源码，只需要监听这个文件就能获取全部结构化数据。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types — 与渲染进程共享的结构化事件
// ---------------------------------------------------------------------------

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type SessionEventType =
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'text'
  | 'user_message'
  | 'meta';

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  timestamp: string;
  // tool_use
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  // tool_result
  stdout?: string;
  stderr?: string;
  diff?: DiffHunk[];
  filePath?: string;
  isError?: boolean;
  // text/thinking/user_message
  content?: string;
  // meta
  permissionMode?: string;
  gitBranch?: string;
  cwd?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// SessionWatcher
// ---------------------------------------------------------------------------

/** 文件不存在时的轮询间隔 (ms) */
const POLL_INTERVAL = 1000;
/** 文件存在时的 watch 间隔 (ms) — fs.watch 不可靠时的 fallback */
const WATCH_FALLBACK_INTERVAL = 500;

export class SessionWatcher {
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private filePath: string | null = null;
  private onEvent: ((event: SessionEvent) => void) | null = null;

  /** 已读取的字节偏移量 */
  private byteOffset = 0;
  /** 累积的行 buffer（处理跨 chunk 的不完整行） */
  private lineBuffer = '';
  /** 已解析的全部事件（用于面板初始化时回放） */
  private events: SessionEvent[] = [];

  /** fs.watch 的 watcher 实例 */
  private watcher: fs.FSWatcher | null = null;
  /** 轮询定时器（fallback 或等待文件创建） */
  private pollTimer: NodeJS.Timeout | null = null;
  /** 是否已停止 */
  private stopped = false;

  /**
   * 启动 session 文件监听。
   *
   * @param sessionId Claude Code 的 session ID
   * @param cwd 项目工作目录
   * @param onEvent 每次解析出新事件时的回调
   */
  start(sessionId: string, cwd: string, onEvent: (event: SessionEvent) => void): void {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.onEvent = onEvent;

    // 构造 .jsonl 文件路径
    const encodedCwd = cwd.replace(/\//g, '-').replace(/^-+/, '');
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    const projectDir = path.join(claudeDir, encodedCwd);
    this.filePath = path.join(projectDir, `${sessionId}.jsonl`);

    console.log(`[SessionWatcher] Starting: ${this.filePath}`);

    // 先尝试读取已有内容（回放历史）
    this.readExistingContent();

    // 启动文件监听
    this.startWatching();
  }

  /**
   * 停止监听。
   */
  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(`[SessionWatcher] Stopped: ${this.filePath}`);
  }

  /**
   * 获取已解析的全部事件（用于面板初始化时回放）。
   */
  getEvents(): SessionEvent[] {
    return [...this.events];
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /**
   * 读取文件已有内容（从上次 offset 开始）。
   * 用于首次启动时回放历史事件。
   */
  private readExistingContent(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > this.byteOffset) {
        const content = fs.readFileSync(this.filePath, { encoding: 'utf-8' });
        // 从 byteOffset 开始读取
        const newContent = content.slice(this.byteOffset);
        this.byteOffset = stat.size;
        this.processChunk(newContent);
      }
    } catch (err) {
      console.error('[SessionWatcher] Error reading existing content:', err);
    }
  }

  /**
   * 启动文件监听。
   * 使用 fs.watch + 轮询 fallback 双保险。
   */
  private startWatching(): void {
    if (!this.filePath || this.stopped) return;

    // 如果文件还不存在，轮询等待创建
    const watchPath = this.filePath;
    if (!fs.existsSync(watchPath)) {
      console.log(`[SessionWatcher] File not found, polling for creation: ${this.filePath}`);
      this.pollTimer = setInterval(() => {
        if (this.stopped) return;
        if (fs.existsSync(watchPath)) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          this.readExistingContent();
          this.startWatching();
        }
      }, POLL_INTERVAL);
      return;
    }

    // 使用 fs.watch 监听文件变化
    try {
      this.watcher = fs.watch(this.filePath, (eventType: string) => {
        if (this.stopped) return;
        if (eventType === 'change') {
          this.readNewContent();
        } else if (eventType === 'rename') {
          // 文件可能被删除或重命名，尝试重新监听
          this.watcher?.close();
          this.watcher = null;
          setTimeout(() => {
            if (!this.stopped) this.startWatching();
          }, 200);
        }
      });
    } catch {
      // fs.watch 失败，使用轮询 fallback
      console.warn('[SessionWatcher] fs.watch failed, using polling fallback');
    }

    // 轮询 fallback — macOS 上 fs.watch 不可靠
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      this.readNewContent();
    }, WATCH_FALLBACK_INTERVAL);
  }

  /**
   * 读取文件新增内容。
   */
  private readNewContent(): void {
    if (!this.filePath || this.stopped) return;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.byteOffset) return;

      // 创建 read stream 从 byteOffset 开始读取
      const stream = fs.createReadStream(this.filePath, {
        start: this.byteOffset,
        encoding: 'utf-8',
      });

      stream.on('data', (chunk: string | Buffer) => {
        this.processChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      });

      stream.on('end', () => {
        this.byteOffset = stat.size;
      });

      stream.on('error', (err: Error) => {
        console.error('[SessionWatcher] Read stream error:', err);
      });
    } catch {
      // 文件可能临时不可用，忽略
    }
  }

  /**
   * 处理新增的文本 chunk，按行分割并解析。
   */
  private processChunk(chunk: string): void {
    this.lineBuffer += chunk;

    // 按换行符分割
    const lines = this.lineBuffer.split('\n');
    // 最后一段可能不完整（没有换行符），保留在 buffer 中
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  /**
   * 解析单个 JSONL 行，提取结构化事件。
   */
  private parseLine(line: string): void {
    if (!this.sessionId || !this.onEvent) return;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      // 不是合法 JSON，跳过
      return;
    }

    const type = obj.type as string;
    const timestamp = (obj.timestamp as string) || new Date().toISOString();

    // 提取 meta 信息（从任何行中）
    const sid = this.sessionId!;
    const permissionMode = obj.permissionMode as string | undefined;
    const gitBranch = obj.gitBranch as string | undefined;
    const cwd = obj.cwd as string | undefined;

    switch (type) {
      case 'assistant': {
        this.parseAssistantMessage(obj, sid, permissionMode, gitBranch, cwd, timestamp);
        break;
      }
      case 'user': {
        this.parseUserMessage(obj, sid, permissionMode, gitBranch, cwd, timestamp);
        break;
      }
      case 'queue-operation':
      case 'attachment':
      case 'ai-title':
        // 忽略这些内部类型
        break;
      default:
        // 未知类型，忽略
        break;
    }
  }

  /**
   * 解析 assistant 消息，提取 thinking / text / tool_use blocks。
   */
  private parseAssistantMessage(
    obj: Record<string, unknown>,
    sid: string,
    permissionMode: string | undefined,
    gitBranch: string | undefined,
    cwd: string | undefined,
    timestamp: string,
  ): void {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content as unknown[];
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      const blockType = b.type as string;

      switch (blockType) {
        case 'thinking': {
          const event: SessionEvent = {
            type: 'thinking',
            sessionId: sid,
            timestamp,
            content: (b.thinking as string) || '',
            permissionMode,
            gitBranch,
            cwd,
          };
          this.emitEvent(event);
          break;
        }
        case 'text': {
          const event: SessionEvent = {
            type: 'text',
            sessionId: sid,
            timestamp,
            content: (b.text as string) || '',
            permissionMode,
            gitBranch,
            cwd,
          };
          this.emitEvent(event);
          break;
        }
        case 'tool_use': {
          const event: SessionEvent = {
            type: 'tool_use',
            sessionId: sid,
            timestamp,
            toolName: (b.name as string) || '',
            toolInput: (b.input as Record<string, unknown>) || {},
            toolUseId: (b.id as string) || '',
            permissionMode,
            gitBranch,
            cwd,
          };
          this.emitEvent(event);
          break;
        }
        default:
          // 其他 block 类型（如 server_tool_use），忽略
          break;
      }
    }
  }

  /**
   * 解析 user 消息，提取 tool_result blocks 和用户文本。
   */
  private parseUserMessage(
    obj: Record<string, unknown>,
    sid: string,
    permissionMode: string | undefined,
    gitBranch: string | undefined,
    cwd: string | undefined,
    timestamp: string,
  ): void {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content;

    // 用户纯文本消息
    if (typeof content === 'string') {
      const event: SessionEvent = {
        type: 'user_message',
        sessionId: sid,
        timestamp,
        content,
        permissionMode,
        gitBranch,
        cwd,
      };
      this.emitEvent(event);
      return;
    }

    // tool_result blocks
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_result') {
        const toolUseId = (b.tool_use_id as string) || '';
        const isErr = !!(b.is_error as boolean);

        // tool_result 的 content 可能是字符串或数组
        const resultContent = b.content;
        let stdout: string | undefined;
        let diff: DiffHunk[] | undefined;
        let filePath: string | undefined;

        if (typeof resultContent === 'string') {
          stdout = resultContent;
          // 尝试从 stdout 中提取 diff 信息
          const parsed = this.parseToolResultStdout(resultContent);
          if (parsed.diff) diff = parsed.diff;
          if (parsed.filePath) filePath = parsed.filePath;
        } else if (Array.isArray(resultContent)) {
          // 数组形式：每个元素是 { type: 'text', text: '...' }
          const texts: string[] = [];
          for (const rc of resultContent) {
            if (typeof rc === 'object' && rc !== null) {
              const rcObj = rc as Record<string, unknown>;
              if (rcObj.type === 'text' && typeof rcObj.text === 'string') {
                texts.push(rcObj.text);
              }
            }
          }
          stdout = texts.join('\n');
          // 尝试提取 diff
          const parsed = this.parseToolResultStdout(stdout);
          if (parsed.diff) diff = parsed.diff;
          if (parsed.filePath) filePath = parsed.filePath;
        }

        const event: SessionEvent = {
          type: 'tool_result',
          sessionId: sid,
          timestamp,
          toolUseId,
          stdout,
          diff,
          filePath,
          isError: isErr,
          permissionMode,
          gitBranch,
          cwd,
        };
        this.emitEvent(event);
      }
    }
  }

  /**
   * 从工具结果文本中尝试提取 diff 和文件路径。
   * Claude Code 的 Edit 工具返回 structuredPatch 格式的 diff。
   */
  private parseToolResultStdout(text: string): { diff?: DiffHunk[]; filePath?: string } {
    const result: { diff?: DiffHunk[]; filePath?: string } = {};

    // 尝试解析 structuredPatch 格式
    // 格式示例：
    // {
    //   "oldPath": "file.ts",
    //   "newPath": "file.ts",
    //   "oldHeader": "...",
    //   "newHeader": "...",
    //   "hunks": [
    //     { "oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 5, "lines": [...] }
    //   ]
    // }

    // 方法 1：尝试 JSON 解析（structuredPatch 是 JSON 对象）
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const oldPath = parsed.oldPath || parsed.oldStart;
        const newPath = parsed.newPath || parsed.newStart;
        if (newPath && typeof newPath === 'string') {
          result.filePath = newPath;
        } else if (oldPath && typeof oldPath === 'string') {
          result.filePath = oldPath;
        }
        if (Array.isArray(parsed.hunks)) {
          result.diff = parsed.hunks.map((h: Record<string, unknown>) => ({
            oldStart: (h.oldStart as number) || 0,
            oldLines: (h.oldLines as number) || 0,
            newStart: (h.newStart as number) || 0,
            newLines: (h.newLines as number) || 0,
            lines: (h.lines as string[]) || [],
          }));
        }
      }
    } catch {
      // 不是 JSON，继续尝试其他方法
    }

    // 方法 2：从文本中提取文件路径（常见模式：File: path/to/file.ts）
    if (!result.filePath) {
      const fileMatch = text.match(/(?:File|file|Path|path):\s*([^\s\n]+)/);
      if (fileMatch) {
        result.filePath = fileMatch[1];
      }
    }

    return result;
  }

  /**
   * 发射事件到回调并存储。
   */
  private emitEvent(event: SessionEvent): void {
    this.events.push(event);
    if (this.onEvent) {
      this.onEvent(event);
    }
  }
}

// ---------------------------------------------------------------------------
// SessionWatcherManager — 管理多个 session watcher 实例
// ---------------------------------------------------------------------------

export class SessionWatcherManager {
  private watchers = new Map<string, SessionWatcher>();

  /**
   * 启动（或重启）一个 session watcher。
   */
  start(
    id: string,
    sessionId: string,
    cwd: string,
    onEvent: (event: SessionEvent) => void,
  ): void {
    // 如果已有 watcher，先停止
    this.stop(id);

    const watcher = new SessionWatcher();
    watcher.start(sessionId, cwd, onEvent);
    this.watchers.set(id, watcher);
  }

  /**
   * 停止一个 session watcher。
   */
  stop(id: string): void {
    const watcher = this.watchers.get(id);
    if (watcher) {
      watcher.stop();
      this.watchers.delete(id);
    }
  }

  /**
   * 获取一个 watcher 已解析的全部事件。
   */
  getEvents(id: string): SessionEvent[] {
    const watcher = this.watchers.get(id);
    return watcher ? watcher.getEvents() : [];
  }

  /**
   * 停止所有 watcher。
   */
  stopAll(): void {
    for (const [id] of this.watchers) {
      this.stop(id);
    }
  }
}
