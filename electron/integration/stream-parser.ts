/**
 * Stream parser for Claude CLI v2.x stream-json output.
 *
 * 完整事件清单（NDJSON，每行一个 JSON）：
 *   {"type":"system","subtype":"init",...}                    -> meta
 *   {"type":"stream_event","event":{content_block_start...}}  -> thinking/tool_use 块开始
 *   {"type":"stream_event","event":{content_block_delta...}}  -> text/thinking/input_json 增量
 *   {"type":"stream_event","event":{content_block_stop...}}   -> 块结束，输出完整 input
 *   {"type":"assistant","message":{content:[...]}}            -> assembled 完整消息（兜底）
 *   {"type":"user","message":{content:[tool_result]},tool_use_result} -> 工具执行结果
 *   {"type":"result",usage/cost/permission_denials}           -> 会话总结
 *   {"type":"error",...}                                      -> 错误
 */

/** 统一 diff 块 */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface ParsedChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'permission_denial' | 'error' | 'meta'
  content?: string
  tool?: string
  /** tool_use 的完整输入（JSON 字符串，由 input_json_delta 累积而来） */
  input?: string
  toolUseId?: string
  stdout?: string
  stderr?: string
  isError?: boolean
  diff?: DiffHunk[]
  filePath?: string
  error?: string
  meta?: { sessionId?: string; model?: string; cost?: number; usage?: Record<string, number> }
  /** 标记新 content_block 开始（text/thinking），前端据此新建 block 而非追加 */
  blockStart?: boolean
}

/** 单个 content_block 的累积状态 */
interface BlockBuffer {
  type: string          // 'thinking' | 'tool_use' | 'text'
  thinking?: string     // 累积的思考内容
  inputJson?: string    // 累积的 input_json_delta 片段
  toolName?: string
  toolUseId?: string
}

export class StreamParser {
  private buffer = ''
  /** 按 block index 累积内容，content_block_stop 时消费 */
  private blocks = new Map<number, BlockBuffer>()

  /** Feed raw stdout data. Returns all complete chunks found. */
  parse(data: string): ParsedChunk[] {
    this.buffer += data
    const chunks: ParsedChunk[] = []
    let nl: number

    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      const r = this.tryLine(line)
      if (r) {
        if (Array.isArray(r)) chunks.push(...r)
        else chunks.push(r)
      }
    }

    return chunks
  }

  /** Try to drain any remaining buffered content as a final line. */
  flush(): ParsedChunk[] {
    if (!this.buffer.trim()) { this.buffer = ''; return [] }
    const r = this.tryLine(this.buffer.trim())
    this.buffer = ''
    if (!r) return []
    return Array.isArray(r) ? r : [r]
  }

  clear(): void {
    this.buffer = ''
    this.blocks.clear()
  }

  private tryLine(line: string): ParsedChunk | ParsedChunk[] | null {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return null
    }

    const type = obj.type as string | undefined

    // --- system init: 提取 session_id + model ---
    if (type === 'system' && obj.subtype === 'init') {
      return {
        type: 'meta',
        meta: { sessionId: obj.session_id, model: obj.model },
      }
    }
    if (type === 'system') return null

    // --- stream_event: 解包内层事件 ---
    if (type === 'stream_event' && obj.event) {
      return this.parseEvent(obj.event)
    }

    // --- assembled assistant 消息：兜底，确保拿到完整 input/thinking ---
    if (type === 'assistant' && obj.message?.content) {
      return this.parseAssembledAssistant(obj.message.content)
    }

    // --- user 事件：工具执行结果（stdout/stderr/diff） ---
    if (type === 'user') {
      return this.parseUserEvent(obj)
    }

    // --- result 事件：会话总结 + 权限拒绝 ---
    if (type === 'result') {
      return this.parseResultEvent(obj)
    }

    // --- error ---
    if (type === 'error') {
      const msg = typeof obj.error === 'string' ? obj.error
        : (obj.error?.message || 'Unknown error')
      return { type: 'error', error: msg }
    }

    return null
  }

  private parseEvent(event: any): ParsedChunk | null {
    const eventType = event.type as string | undefined
    const index = typeof event.index === 'number' ? event.index : -1

    // --- content_block_start：标记块开始 ---
    if (eventType === 'content_block_start' && event.content_block) {
      const block = event.content_block
      const blockType = block.type as string

      if (blockType === 'thinking') {
        this.blocks.set(index, { type: 'thinking', thinking: '' })
        return { type: 'thinking', blockStart: true }
      }
      if (blockType === 'text') {
        this.blocks.set(index, { type: 'text', thinking: '', inputJson: '' })
        return { type: 'text', blockStart: true }
      }
      if (blockType === 'tool_use') {
        this.blocks.set(index, {
          type: 'tool_use',
          thinking: '',
          inputJson: '',
          toolName: block.name,
          toolUseId: block.id,
        })
        return {
          type: 'tool_use',
          tool: block.name,
          toolUseId: block.id,
          blockStart: true,
        }
      }
      return null
    }

    // --- content_block_delta：累积增量 ---
    if (eventType === 'content_block_delta' && event.delta) {
      const deltaType = event.delta.type as string
      const buf = index >= 0 ? this.blocks.get(index) : undefined

      if (deltaType === 'text_delta' && event.delta.text) {
        return { type: 'text', content: event.delta.text as string }
      }

      // 思考增量：累积到 buffer
      if (deltaType === 'thinking_delta' && event.delta.thinking) {
        if (buf && buf.type === 'thinking') {
          buf.thinking = (buf.thinking || '') + event.delta.thinking
          return { type: 'thinking', content: event.delta.thinking as string }
        }
        return { type: 'thinking', content: event.delta.thinking as string }
      }

      // 工具输入增量：累积 JSON 片段，不立即输出
      if (deltaType === 'input_json_delta' && event.delta.partial_json) {
        if (buf && buf.type === 'tool_use') {
          buf.inputJson = (buf.inputJson || '') + event.delta.partial_json
        }
        return null
      }
      return null
    }

    // --- content_block_stop：块结束，输出完整 input ---
    if (eventType === 'content_block_stop') {
      const buf = this.blocks.get(index)
      if (buf) {
        this.blocks.delete(index)
        if (buf.type === 'tool_use' && buf.inputJson && buf.toolUseId) {
          return {
            type: 'tool_use',
            tool: buf.toolName,
            toolUseId: buf.toolUseId,
            input: buf.inputJson,
          }
        }
      }
      return null
    }

    // message_start / message_delta / message_stop：不需要
    return null
  }

  /** assembled assistant 事件：兜底补全 thinking/tool_use input */
  private parseAssembledAssistant(content: any[]): ParsedChunk | null {
    // 找最后一个 tool_use 块，输出完整 input（覆盖流式累积的版本）
    for (const block of content) {
      if (block.type === 'tool_use' && block.input) {
        return {
          type: 'tool_use',
          tool: block.name,
          toolUseId: block.id,
          input: JSON.stringify(block.input),
        }
      }
    }
    // thinking 块的完整文本由 thinking_delta 流式输出覆盖，这里不重复
    return null
  }

  /** user 事件：工具执行结果 */
  private parseUserEvent(obj: any): ParsedChunk | null {
    const message = obj.message
    if (!message?.content || !Array.isArray(message.content)) return null

    for (const block of message.content) {
      if (block.type !== 'tool_result') continue

      const result: ParsedChunk = {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        // 优先使用 block.content（权限拒绝等错误信息）
        ...(typeof block.content === 'string' ? { content: block.content } : {}),
      }

      // 结构化结果（tool_use_result 是 message 的兄弟字段）
      const tur = obj.tool_use_result
      if (tur && typeof tur === 'object') {
        // Bash：stdout / stderr
        if (typeof tur.stdout === 'string') result.stdout = tur.stdout
        if (typeof tur.stderr === 'string') result.stderr = tur.stderr

        // Edit：structuredPatch + filePath
        if (Array.isArray(tur.structuredPatch)) {
          result.diff = tur.structuredPatch as DiffHunk[]
          result.filePath = tur.filePath
        }
        // Read：file
        if (tur.file?.filePath) {
          result.filePath = tur.file.filePath
          if (typeof tur.file.content === 'string') result.stdout = tur.file.content
        }
        // Write：filePath
        if (tur.filePath && !result.filePath) result.filePath = tur.filePath
      } else if (typeof tur === 'string' && !result.content) {
        // 字符串形式的错误结果（权限拒绝等），仅当 block.content 不存在时使用
        result.content = tur
        result.isError = true
      }

      // tool_result.content（兜底文本）
      if (!result.content && !result.stdout && typeof block.content === 'string') {
        result.content = block.content
      }

      return result
    }
    return null
  }

  /** result 事件：会话总结 + 权限拒绝 */
  private parseResultEvent(obj: any): ParsedChunk | ParsedChunk[] | null {
    // 权限拒绝：每个 denial 作为独立 chunk
    if (Array.isArray(obj.permission_denials) && obj.permission_denials.length > 0) {
      return obj.permission_denials.map((d: any) => ({
        type: 'permission_denial' as const,
        tool: d.tool_name,
        toolUseId: d.tool_use_id,
        input: d.tool_input ? JSON.stringify(d.tool_input) : undefined,
        content: `Claude 请求执行 ${d.tool_name} 但未被授权。可在权限模式中切换后重试。`,
      }))
    }

    // usage / cost 元信息
    if (obj.usage || obj.total_cost_usd != null) {
      return {
        type: 'meta',
        meta: {
          cost: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
          usage: obj.usage,
        },
      }
    }

    return null
  }
}
