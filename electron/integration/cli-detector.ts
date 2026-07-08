import { spawn } from 'child_process';

export interface CliInfo {
  installed: boolean;
  version: string | null;
  error?: string;
}

/**
 * Detect whether the Claude CLI (`claude`) is installed and available on PATH.
 *
 * Strategy: spawn `claude --version`, capture stdout, and inspect the exit code.
 * - Exit code 0  → installed, version captured from stdout.
 * - ENOENT        → not installed (binary not found on PATH).
 * - Timeout (5s)  → installed flag false, error set.
 * - Other non-zero → installed flag false, error set.
 */
export async function detectClaudeCli(): Promise<CliInfo> {
  return new Promise<CliInfo>((resolve) => {
    let child: import('child_process').ChildProcessWithoutNullStreams;
    try {
      child = spawn('claude', ['--version'], {
        shell: false,
        env: { ...process.env },
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        resolve({ installed: false, version: null, error: 'Claude CLI not found on PATH.' });
      } else {
        resolve({ installed: false, version: null, error: e.message });
      }
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        installed: false,
        version: null,
        error: 'Timed out waiting for `claude --version` (5s).',
      });
    }, 5000);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (err.code === 'ENOENT') {
        resolve({ installed: false, version: null, error: 'Claude CLI not found on PATH.' });
      } else {
        resolve({ installed: false, version: null, error: err.message });
      }
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        const version = stdout.trim() || null;
        resolve({ installed: true, version });
      } else {
        resolve({
          installed: false,
          version: null,
          error:
            stderr.trim() ||
            `claude --version exited with code ${code ?? 'null'}.`,
        });
      }
    });
  });
}
