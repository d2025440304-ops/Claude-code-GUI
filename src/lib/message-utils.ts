/**
 * 消息展示工具（Chat 模式历史消息恢复）。
 * 从 App.tsx 抽出，纯函数可单测。
 */
import type { Message, DiffHunk, ContentBlock } from '../types'

export function getProjectName(path: string | null): string | null {
  if (!path) return null
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/**
 * 如果 content 是 JSON 数组（结构化 parts），提取其中 text 部分拼接为纯文本。
 * 用于 HistoryMessage 等不需要 contentBlocks 的场景。
 */
export function plainifyJSONContent<T extends { role: string; content: string }>(msg: T): T {
  if (msg.role !== 'assistant' || !msg.content) return msg
  try {
    const v = JSON.parse(msg.content)
    if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && 'type' in v[0]) {
      const text = v.filter((p: Record<string, unknown>) => p.type === 'text' && p.text).map((p: Record<string, unknown>) => p.text as string).join('')
      if (text) return { ...msg, content: text }
    }
  } catch {}
  return msg
}

/**
 * Parse assistant messages whose `content` field contains a JSON-serialized
 * array of structured parts (text / thinking / tool_use / tool_result) back
 * into `contentBlocks` so that ChatView can render them with proper formatting
 * (markdown, code highlighting, tool cards) instead of raw JSON.
 */
export function deserializeMessageBlocks(msg: Message): Message {
  if (msg.role !== 'assistant' || !msg.content || msg.contentBlocks?.length) return msg
  let parsed: Array<Record<string, unknown>> | null = null
  try {
    const v = JSON.parse(msg.content)
    if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && 'type' in v[0]) parsed = v
  } catch { return msg }
  if (!parsed) return msg
  const blocks: ContentBlock[] = []
  let i = 0
  for (const p of parsed) {
    const t = p.type as string
    if (t === 'text' && p.text) {
      blocks.push({ id: `db-${i}`, type: 'text', content: p.text as string, status: 'completed' })
    } else if (t === 'thinking' && p.text) {
      blocks.push({ id: `db-${i}`, type: 'thinking', content: p.text as string, status: 'completed' })
    } else if (t === 'tool_use') {
      blocks.push({
        id: `db-${i}`, type: 'tool_use', toolName: p.toolName as string,
        toolUseId: p.toolUseId as string, toolInput: p.input as Record<string, unknown> | undefined,
        status: 'completed',
      })
    } else if (t === 'tool_result') {
      const idx = blocks.findIndex(b => b.toolUseId === p.toolUseId && b.type === 'tool_use')
      const result = {
        content: p.content as string | undefined,
        stdout: p.stdout as string | undefined,
        stderr: p.stderr as string | undefined,
        isError: !!p.isError,
        diff: p.diff as DiffHunk[] | undefined,
        filePath: p.filePath as string | undefined,
      }
      if (idx >= 0) {
        blocks[idx] = { ...blocks[idx], ...result, status: (p.isError ? 'error' : 'completed') }
      } else {
        blocks.push({ id: `db-${i}`, type: 'tool_result', toolUseId: p.toolUseId as string, ...result, status: 'completed' })
      }
    }
    i++
  }
  // Derive a plain-text content from blocks for fallback / preview.
  const textContent = blocks
    .filter((b) => b.type === 'text' && b.content)
    .map((b) => b.content as string)
    .join('')
  return { ...msg, contentBlocks: blocks, content: textContent || msg.content }
}
