/**
 * Normalize and validate the working directory for CLI subprocesses.
 *
 * `child_process.spawn` does NOT expand `~`, and an ENOENT caused by a
 * missing/non-directory cwd is misreported by the Claude Agent SDK as
 * "native binary exists but failed to launch". Resolve `~` and empty paths
 * to a safe fallback (home dir).
 *
 * 关键修复：目录不存在时**自动创建**（mkdir -p），而不是回退 home。
 * 续接历史会话（终端/其他客户端创建的 session）时，项目目录可能已被
 * 删除或移动，但 ~/.claude/projects/ 下的 session 文件仍在。若回退到
 * home，CLI 会在错误的项目目录里找 session → "No conversation found
 * with session ID"。自动重建目录后 resume 即可正确定位。
 */
import * as path from 'path';
import * as os from 'os';
import { existsSync, statSync, mkdirSync } from 'fs';

export function resolveCwd(cwd: string | undefined): string {
  const home = os.homedir();
  if (!cwd || cwd.trim() === '') return home;
  const expanded = cwd.startsWith('~') ? path.join(home, cwd.slice(1)) : cwd;
  try {
    if (existsSync(expanded) && statSync(expanded).isDirectory()) return expanded;
    // 目录不存在：自动创建（幂等），使 resume 能定位到正确的 session
    mkdirSync(expanded, { recursive: true });
    return expanded;
  } catch {
    // 无权限等情况 → 回退 home，保证子进程有合法 cwd
    return home;
  }
}
