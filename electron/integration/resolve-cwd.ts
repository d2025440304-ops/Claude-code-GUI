/**
 * Normalize and validate the working directory for CLI subprocesses.
 *
 * `child_process.spawn` does NOT expand `~`, and an ENOENT caused by a
 * missing/non-directory cwd is misreported by the Claude Agent SDK as
 * "native binary exists but failed to launch". Resolve `~`, empty, missing,
 * or non-directory paths to a safe fallback (home dir) so subprocesses
 * always have a valid cwd.
 */
import * as path from 'path';
import * as os from 'os';
import { existsSync, statSync } from 'fs';

export function resolveCwd(cwd: string | undefined): string {
  const home = os.homedir();
  if (!cwd || cwd.trim() === '') return home;
  const expanded = cwd.startsWith('~') ? path.join(home, cwd.slice(1)) : cwd;
  try {
    if (existsSync(expanded) && statSync(expanded).isDirectory()) return expanded;
  } catch {
    // fall through to home
  }
  return home;
}
