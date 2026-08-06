/**
 * 流式 content block 工具（Chat 模式）。
 * 从 App.tsx 抽出，纯函数可单测。
 */
import type { ContentBlock } from '../types';
import type { StreamChunk } from './ipc';

export type StreamBlockOutcome = 'completed' | 'error';

/** 安全解析 JSON，失败返回 undefined */
export function safeParseJSON(s?: string): Record<string, unknown> | undefined {
  if (!s) return undefined
  try { return JSON.parse(s) as Record<string, unknown> } catch { return undefined }
}

/**
 * 将流式 chunk 应用到 assistant message 的 contentBlocks 数组。
 *
 * 规则：
 * - text/thinking：blockStart=true 时新建 block；否则追加到最后一个同类型 streaming block
 * - tool_use：blockStart=true 新建（只有 toolName+toolUseId）；后续带 input 的更新同 toolUseId 的 block
 * - tool_result：按 toolUseId 关联到对应 tool_use block，填入 stdout/diff/isError
 * - permission_denial：直接新建
 */
export function applyChunkToBlocks(blocks: ContentBlock[], chunk: StreamChunk): ContentBlock[] {
  const next = [...blocks]

  switch (chunk.type) {
    case 'text': {
      if (chunk.blockStart || next.length === 0 || next[next.length - 1].type !== 'text' || next[next.length - 1].status !== 'streaming') {
        next.push({ id: crypto.randomUUID(), type: 'text', content: chunk.content || '', status: 'streaming' })
      } else {
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, content: (last.content || '') + (chunk.content || '') }
      }
      break
    }
    case 'thinking': {
      if (chunk.blockStart || next.length === 0 || next[next.length - 1].type !== 'thinking' || next[next.length - 1].status !== 'streaming') {
        next.push({ id: crypto.randomUUID(), type: 'thinking', content: chunk.content || '', status: 'streaming' })
      } else {
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, content: (last.content || '') + (chunk.content || '') }
      }
      break
    }
    case 'tool_use': {
      // 带 input：更新已存在的 block（content_block_stop 触发）
      if (chunk.input && chunk.toolUseId) {
        const idx = next.findIndex(b => b.toolUseId === chunk.toolUseId)
        if (idx >= 0) {
          next[idx] = { ...next[idx], toolName: chunk.tool || next[idx].toolName, toolInput: safeParseJSON(chunk.input), status: 'completed' }
        } else {
          next.push({ id: crypto.randomUUID(), type: 'tool_use', toolName: chunk.tool, toolUseId: chunk.toolUseId, toolInput: safeParseJSON(chunk.input), status: 'completed' })
        }
      } else if (chunk.toolUseId) {
        // content_block_start：新建 streaming tool_use block
        next.push({ id: crypto.randomUUID(), type: 'tool_use', toolName: chunk.tool, toolUseId: chunk.toolUseId, status: 'streaming' })
      }
      break
    }
    case 'tool_result': {
      if (chunk.toolUseId) {
        const idx = next.findIndex(b => b.toolUseId === chunk.toolUseId)
        const resultPatch: Partial<ContentBlock> = {
          stdout: chunk.stdout,
          stderr: chunk.stderr,
          diff: chunk.diff,
          filePath: chunk.filePath,
          isError: chunk.isError,
          content: chunk.content,
          status: chunk.isError ? 'error' : 'completed',
        }
        if (idx >= 0) {
          next[idx] = { ...next[idx], ...resultPatch }
        } else {
          next.push({ id: crypto.randomUUID(), type: 'tool_result', toolUseId: chunk.toolUseId, ...resultPatch } as ContentBlock)
        }
      }
      break
    }
    case 'permission_denial': {
      next.push({
        id: crypto.randomUUID(),
        type: 'permission_denial',
        toolName: chunk.tool,
        toolInput: safeParseJSON(chunk.input),
        content: chunk.content,
        status: 'error',
      })
      break
    }
  }

  return next
}

/**
 * C10 修复：终结 assistant message 中所有 status === 'streaming' 的 content block。
 *
 * - stream:end（正常结束/用户停止）→ 'completed'：即使 tool_use 没有对应的
 *   tool_result，流已经结束，block 必须离开 streaming 状态，否则 UI 永久显示 spinner。
 * - stream:error（报错/中断）→ 'error'：状态与实际语义一致。
 *
 * 只修改 streaming 状态；已 completed/error 的 block 及其内容（tool_result、
 * thinking、text）原样保留，绝不覆盖。
 */
export function finalizeStreamingBlocks(
  blocks: ContentBlock[],
  outcome: StreamBlockOutcome,
): ContentBlock[] {
  return blocks.map((b) => (b.status === 'streaming' ? { ...b, status: outcome } : b));
}
