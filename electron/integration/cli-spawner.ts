import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { StreamParser, ParsedChunk } from './stream-parser';
import { resolveCwd } from './resolve-cwd';

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
export interface CLIErrorEvent { sessionId: string; error: CLIError }

// ---------------------------------------------------------------------------
// Typed CLI errors
// ---------------------------------------------------------------------------

export type CLIErrorKind =
  | 'not_found'
  | 'spawn'
  | 'nonzero_exit'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unknown';

/**
 * Structured error emitted by CliSpawner. Captures the failure category, the
 * process exit code, and any stderr written by the CLI so the IPC layer can
 * surface a precise, actionable message instead of a raw string.
 */
export class CLIError extends Error {
  readonly kind: CLIErrorKind;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(kind: CLIErrorKind, message: string, exitCode: number | null = null, stderr = '') {
    super(message);
    this.name = 'CLIError';
    this.kind = kind;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }

  /** Classify a spawn-time error (ENOENT etc.). */
  static fromSpawnError(err: NodeJS.ErrnoException): CLIError {
    if (err.code === 'ENOENT') {
      return new CLIError('not_found', 'Claude CLI not found on PATH.', null);
    }
    return new CLIError('spawn', err.message, null);
  }

  /** Build an error from a non-zero exit, combining stderr + any CLI-reported error. */
  static fromNonZeroExit(code: number, stderr: string, cliErrorMessage: string | null): CLIError {
    const raw = (stderr.trim() || (cliErrorMessage ?? '')).trim();
    const kind = CLIError.classifyKind(raw);
    const message = raw
      ? raw.split('\n').slice(-5).join('\n')
      : `Claude CLI exited with code ${code} (no output).`;
    return new CLIError(kind, message, code, stderr);
  }

  private static classifyKind(detail: string): CLIErrorKind {
    if (/timed?\s*out|ETIMEDOUT|deadline\s+exceeded/i.test(detail)) return 'timeout';
    if (/network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch\s+failed|overloaded|503|502|529/i.test(detail)) {
      return 'network';
    }
    return 'nonzero_exit';
  }
}

// ---------------------------------------------------------------------------
// Per-session context
// ---------------------------------------------------------------------------

interface SessionContext {
  child: ChildProcess;
  parser: StreamParser;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  /** Disambiguates stale handlers when a conversationId is reused across messages. */
  token: symbol;
  stderrBuffer: string;
  hasReceivedOutput: boolean;
  /** Last {"type":"error"} reported in-stream by the CLI itself (network/timeout). */
  cliErrorMessage: string | null;
  killTimer: NodeJS.Timeout | null;
  forceTimer: NodeJS.Timeout | null;
  /** True once a terminal event (close/error/force) has run for this token. */
  finished: boolean;
}

/**
 * Manages Claude CLI one-shot subprocesses.
 * Each user message spawns: claude -p "msg" --output-format stream-json --model X [--resume Y]
 * The process streams JSON chunks on stdout, then exits.
 *
 * Safety guarantees:
 *   - stdout/stderr are decoded via StringDecoder so multi-byte (CJK) characters
 *     split across Buffer chunks are never corrupted into U+FFFD.
 *   - Every terminal path runs teardown(): removes all listeners, destroys the
 *     stdio streams, clears kill/force timers and drops the context - no zombie
 *     children, no leaked listeners, no retained closures.
 *   - A per-message token guards handlers so a late event from a previous message
 *     on the same conversationId cannot corrupt the active stream.
 */
export class CliSpawner extends EventEmitter {
  private sessions = new Map<string, SessionContext>();

  /** Spawn a one-shot claude -p process for this message. */
  sendAndStream(sessionId: string, opts: SendMessageOpts): void {
    if (this.sessions.has(sessionId)) {
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
      cwd: resolveCwd(opts.cwd),
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

    const token = Symbol(sessionId);
    const ctx: SessionContext = {
      child,
      parser: new StreamParser(),
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      token,
      stderrBuffer: '',
      hasReceivedOutput: false,
      cliErrorMessage: null,
      killTimer: null,
      forceTimer: null,
      finished: false,
    };
    this.sessions.set(sessionId, ctx);

    const isCurrent = (): boolean => this.sessions.get(sessionId)?.token === token;

    const emitChunks = (chunks: ParsedChunk[]): void => {
      for (const chunk of chunks) {
        // text / thinking / tool_use / tool_result 都算有效输出
        if (
          (chunk.type === 'text' || chunk.type === 'thinking' ||
            chunk.type === 'tool_use' || chunk.type === 'tool_result') && chunk.content
        ) {
          ctx.hasReceivedOutput = true;
        }
        if (chunk.type === 'error' && chunk.error) {
          ctx.cliErrorMessage = chunk.error;
        }
        this.emit('chunk', { sessionId, chunk } as ChunkEvent);
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      if (!isCurrent()) return;
      const parser = this.sessions.get(sessionId)?.parser;
      if (!parser) return;
      // StringDecoder retains any trailing partial multi-byte sequence, so CJK
      // text split across chunks is decoded correctly instead of emitting U+FFFD.
      const text = ctx.stdoutDecoder.write(data);
      if (!text) return;
      emitChunks(parser.parse(text));
    });

    child.stderr?.on('data', (data: Buffer) => {
      if (!isCurrent()) return;
      const text = ctx.stderrDecoder.write(data);
      ctx.stderrBuffer += text;
      this.emit('stderr', { sessionId, data: text } as StderrEvent);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (!isCurrent() || ctx.finished) return;
      ctx.finished = true;
      this.teardown(sessionId);
      this.emit('error', {
        sessionId,
        error: CLIError.fromSpawnError(err),
      } as CLIErrorEvent);
    });

    child.on('close', (code: number | null) => {
      if (!isCurrent() || ctx.finished) return;
      ctx.finished = true;

      // Drain the decoders and the parser's final (newline-less) line.
      const parser = this.sessions.get(sessionId)?.parser;
      if (parser) {
        const stdoutTail = ctx.stdoutDecoder.end();
        if (stdoutTail) emitChunks(parser.parse(stdoutTail));
        const remaining = parser.flush();
        emitChunks(remaining);
        parser.clear();
      }
      // Append any trailing stderr bytes.
      const stderrTail = ctx.stderrDecoder.end();
      if (stderrTail) ctx.stderrBuffer += stderrTail;

      // 非零退出且未收到任何有效输出 -> 视为错误，提取 stderr 作为诊断信息
      if (code !== 0 && code !== null && !ctx.hasReceivedOutput) {
        this.emit('error', {
          sessionId,
          error: CLIError.fromNonZeroExit(code, ctx.stderrBuffer, ctx.cliErrorMessage),
        } as CLIErrorEvent);
      }

      this.teardown(sessionId);
      this.emit('close', { sessionId, exitCode: code } as CloseEvent);
    });
  }

  /** Stop a specific session. SIGTERM, then SIGKILL, then forced teardown. */
  stopSession(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx || ctx.finished) return;
    if (ctx.killTimer) return; // already stopping

    try { ctx.child.kill('SIGTERM'); } catch { /* already dead */ }

    const killTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      // Already closed cleanly (or superseded by a new message) - nothing to do.
      if (!current || current.token !== ctx.token || current.finished) return;
      try { current.child.kill('SIGKILL'); } catch { /* ignore */ }

      // Give the kernel one more second to deliver 'close'; if it never comes
      // (zombie / hung child), force a synthetic terminal event so the renderer
      // never hangs waiting for stream:end.
      const forceTimer = setTimeout(() => {
        const c = this.sessions.get(sessionId);
        if (!c || c.token !== ctx.token || c.finished) return;
        c.finished = true;
        this.teardown(sessionId);
        this.emit('error', {
          sessionId,
          error: new CLIError('aborted', 'Generation stopped: process did not exit.', null),
        } as CLIErrorEvent);
        this.emit('close', { sessionId, exitCode: null } as CloseEvent);
      }, 1000);
      current.forceTimer = forceTimer;
      forceTimer.unref();
    }, 3000);
    ctx.killTimer = killTimer;
    killTimer.unref();
  }

  stopAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.stopSession(id);
    }
  }

  /** Immediately SIGKILL every active session and drop its context (shutdown). */
  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      const ctx = this.sessions.get(id);
      if (!ctx) continue;
      ctx.finished = true;
      try { ctx.child.kill('SIGKILL'); } catch { /* ignore */ }
      this.teardown(id);
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Release every resource held for a session: clear the kill/force timers,
   * strip all listeners from the child and its stdio streams, destroy the
   * streams, and drop the context. Idempotent and safe from any terminal path.
   */
  private teardown(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!ctx) return;

    if (ctx.killTimer) { clearTimeout(ctx.killTimer); ctx.killTimer = null; }
    if (ctx.forceTimer) { clearTimeout(ctx.forceTimer); ctx.forceTimer = null; }
    try { ctx.child.stdout?.removeAllListeners(); } catch { /* ignore */ }
    try { ctx.child.stderr?.removeAllListeners(); } catch { /* ignore */ }
    try { ctx.child.stdin?.removeAllListeners(); } catch { /* ignore */ }
    try { ctx.child.removeAllListeners(); } catch { /* ignore */ }
    try { ctx.child.stdout?.destroy(); } catch { /* ignore */ }
    try { ctx.child.stderr?.destroy(); } catch { /* ignore */ }
  }
}
