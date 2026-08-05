/**
 * 权限模式映射 — 统一管理所有后端（CLI spawner / Claude PTY / Agent SDK）
 * 的 permission mode 映射，避免三处重复且可能不一致的 mapping。
 *
 * 前端使用的 PermissionMode 值：
 *   'ask'       — 每次询问
 *   'auto-edit' — 自动批准编辑
 *   'plan'      — 计划模式（只读）
 *   'skip'      — 跳过所有权限（完全信任）
 *
 * CLI --permission-mode 取值：
 *   default | acceptEdits | plan | bypassPermissions | dontAsk | auto
 *
 * Agent SDK permissionMode 取值：
 *   default | acceptEdits | bypassPermissions | plan | dontAsk | auto
 */

/** 前端 PermissionMode → CLI --permission-mode 参数 */
export const UI_TO_CLI_MODE: Record<string, string> = {
  'ask': 'default',
  'auto-edit': 'acceptEdits',
  'plan': 'plan',
  'skip': 'bypassPermissions',
};

/** 前端 PermissionMode → Agent SDK permissionMode */
export const UI_TO_SDK_MODE: Record<string, 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'> = {
  'ask': 'default',
  'auto-edit': 'acceptEdits',
  'plan': 'plan',
  'skip': 'bypassPermissions',
};

/**
 * 将前端 PermissionMode 转为 CLI --permission-mode 参数值。
 * 返回 undefined 表示不应该传递该参数（CLI 默认行为 = 'ask'）。
 */
export function mapPermissionModeForCli(uiMode?: string): string | undefined {
  if (!uiMode || uiMode === 'ask') return undefined; // CLI 默认就是 'ask'
  return UI_TO_CLI_MODE[uiMode];
}

/**
 * 将前端 PermissionMode 转为 Agent SDK permissionMode 参数值。
 * 返回 undefined 表示不应该传递该参数（SDK 默认行为 = 'default'）。
 */
export function mapPermissionModeForSdk(uiMode?: string): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' | undefined {
  if (!uiMode || uiMode === 'ask') return undefined;
  return UI_TO_SDK_MODE[uiMode];
}

/**
 * 将前端 PermissionMode 转为 Claude PTY 的 --permission-mode 参数值。
 * PTY 与 CLI spawner 共用同一套映射。
 */
export const mapPermissionModeForPty = mapPermissionModeForCli;