import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { StreamParser, ParsedChunk } from './stream-parser';

export interface SendMessageOpts {
  cwd: string;
  model: string;
  resumeId?: string;
  message: string;
  images?: { mimeType: string; data: string }[];
  addDirs?: string[];
  /** 权限模式：ask | auto-edit | plan | skip */
  permissionMode?: string;
  /** 思考等级：none | low | medium | high */
  thinkingEffort?: string;
}

export interface ChunkEvent { sessionId: string; chunk: ParsedChunk }
export interface StderrEvent { sessionId: string; data: string }
export interface CloseEvent { sessionId: string; exitCode: number | null }
export interface ErrorEvent { sessionId: string; error: string }

/**
 * Manages Claude CLI one-shot subprocesses.
 * Each user message spawns: claude -p "msg" --output-format stream-json --model X [--resume Y]
 * The process streams JSON chunks on stdout, then exits.
 */
export class CliSpawner extends EventEmitter {
  private processes: Map<string, ChildProcess> = new Map();
  private parsers: Map<string, StreamParser> = new Map();
  private killTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Spawn a one-shot claude -p process for this message. */
  sendAndStream(sessionId: string, opts: SendMessageOpts): void {
    if (this.processes.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a running process.`);
    }

    // Image attachments require stream-json input (base64 content blocks).
    // Plain text uses the -p "<prompt>" positional form.
    const hasImages = !!(opts.images && opts.images.length > 0);

    const args = [
      '-p',
      ...(hasImages ? ['--input-format', 'stream-json'] : [opts.message]),
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    // Only pass --model if explicitly set (not 'default' or empty)
    // This lets cc-switch's configured model be used when no override is needed
    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }
    if (opts.resumeId) {
      args.push('--resume', opts.resumeId);
    }

    // Grant file-read access to directories outside cwd (file attachments).
    if (opts.addDirs && opts.addDirs.length > 0) {
      args.push('--add-dir', ...opts.addDirs);
    }

    // 权限模式映射到 CLI 参数
    // 真实取值：acceptEdits | auto | bypassPermissions | default | dontAsk | plan
    if (opts.permissionMode && opts.permissionMode !== 'ask') {
      const modeMap: Record<string, string> = {
        'auto-edit': 'acceptEdits',
        'plan': 'plan',
        'skip': 'bypassPermissions',
      };
      const cliMode = modeMap[opts.permissionMode];
      if (cliMode) {
        args.push('--permission-mode', cliMode);
      }
    }

    // 思考等级映射到 CLI 参数
    // 真实参数是 --effort，取值：low | medium | high | xhigh | max
    if (opts.thinkingEffort && opts.thinkingEffort !== 'none') {
      const effortMap: Record<string, string> = {
        'low': 'low',
        'medium': 'medium',
        'high': 'high',
      };
      const cliEffort = effortMap[opts.thinkingEffort];
      if (cliEffort) {
        args.push('--effort', cliEffort);
      }
    }

    const child = spawn('claude', args, {
      cwd: opts.cwd,
      shell: false,
      env: { ...process.env },
    });

    // With stream-json input, the prompt (text + images) arrives via stdin.
    if (hasImages) {
      const contentBlocks: Array<Record<string, unknown>> = [];
      if (opts.message) {
        contentBlocks.push({ type: 'text', text: opts.message });
      }
      for (const img of opts.images!) {
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        });
      }
      const payload =
        JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } }) + '\n';
      try {
        child.stdin?.end(payload, 'utf8');
      } catch (err) {
        // If stdin is already closed (e.g. early exit), ignore.
      }
    }

    this.processes.set(sessionId, child);
    this.parsers.set(sessionId, new StreamParser());

    // 收集 stderr 用于错误诊断：进程非零退出且无有效输出时，作为错误信息上报
    let stderrBuffer = '';
    let hasReceivedOutput = false;

    child.stdout?.on('data', (data: Buffer) => {
      const parser = this.parsers.get(sessionId);
      if (!parser) return;
      const chunks = parser.parse(data.toString());
      for (const chunk of chunks) {
        // text / thinking / tool_use / tool_result 都算有效输出
        if ((chunk.type === 'text' || chunk.type === 'thinking' ||
             chunk.type === 'tool_use' || chunk.type === 'tool_result') && chunk.content) {
          hasReceivedOutput = true;
        }
        this.emit('chunk', { sessionId, chunk } as ChunkEvent);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      this.emit('stderr', { sessionId, data: text } as StderrEvent);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.cleanup(sessionId);
      this.emit('error', {
        sessionId,
        error: err.code === 'ENOENT' ? 'Claude CLI not found on PATH.' : err.message,
      } as ErrorEvent);
    });

    child.on('close', (code: number | null) => {
      // Drain any remaining buffered content
      const parser = this.parsers.get(sessionId);
      if (parser) {
        const remaining = parser.flush();
        for (const chunk of remaining) {
          if ((chunk.type === 'text' || chunk.type === 'thinking' ||
               chunk.type === 'tool_use' || chunk.type === 'tool_result') && chunk.content) {
            hasReceivedOutput = true;
          }
          this.emit('chunk', { sessionId, chunk } as ChunkEvent);
        }
        parser.clear();
      }

      // 非零退出且未收到任何有效输出 -> 视为错误，提取 stderr 作为诊断信息
      if (code !== 0 && code !== null && !hasReceivedOutput) {
        const detail = stderrBuffer.trim()
          ? stderrBuffer.trim().split('\n').slice(-5).join('\n')
          : `Claude CLI exited with code ${code} (no output).`;
        this.emit('error', { sessionId, error: detail } as ErrorEvent);
      }

      this.cleanup(sessionId);
      this.emit('close', { sessionId, exitCode: code } as CloseEvent);
    });
  }

  /** Stop a specific session. */
  stopSession(sessionId: string): void {
    const child = this.processes.get(sessionId);
    if (!child || child.killed) return;
    try { child.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => {
      const c = this.processes.get(sessionId);
      if (c && !c.killed) { try { c.kill('SIGKILL'); } catch {} }
      this.killTimers.delete(sessionId);
    }, 3000);
    this.killTimers.set(sessionId, timer);
  }

  stopAll(): void {
    for (const id of Array.from(this.processes.keys())) {
      this.stopSession(id);
    }
  }

  hasSession(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  private cleanup(sessionId: string): void {
    this.processes.delete(sessionId);
    this.parsers.delete(sessionId);
    const timer = this.killTimers.get(sessionId);
    if (timer) { clearTimeout(timer); this.killTimers.delete(sessionId); }
  }
}
