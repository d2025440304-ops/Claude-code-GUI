/**
 * Stream parser for Claude CLI v2.x stream-json output.
 *
 * Actual format (from claude -p --output-format stream-json --include-partial-messages):
 *
 *   {"type":"system","subtype":"init","session_id":"...","model":"kimi-k2.7-code",...}
 *   {"type":"system","subtype":"status","status":"requesting"}
 *   {"type":"stream_event","event":{"type":"message_start","message":{...}}}
 *   {"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}}
 *   {"type":"stream_event","event":{"type":"content_block_stop"}}
 *   {"type":"stream_event","event":{"type":"message_stop"}}
 *   {"type":"result","result":"final text","session_id":"..."}
 *
 * We normalise into ParsedChunk objects the renderer can use.
 */

export interface ParsedChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'meta';
  content?: string;
  tool?: string;
  input?: string;
  toolUseId?: string;
  error?: string;
  meta?: { sessionId?: string; model?: string };
}

export class StreamParser {
  private buffer = '';

  /** Feed raw stdout data. Returns all complete chunks found. */
  parse(data: string): ParsedChunk[] {
    this.buffer += data;
    const chunks: ParsedChunk[] = [];
    let nl: number;

    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const chunk = this.tryLine(line);
      if (chunk) chunks.push(chunk);
    }

    return chunks;
  }

  /** Try to drain any remaining buffered content as a final line. */
  flush(): ParsedChunk[] {
    if (!this.buffer.trim()) { this.buffer = ''; return []; }
    const chunk = this.tryLine(this.buffer.trim());
    this.buffer = '';
    return chunk ? [chunk] : [];
  }

  clear(): void { this.buffer = ''; }

  private tryLine(line: string): ParsedChunk | null {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return null; // not valid JSON, skip
    }

    const type = obj.type as string | undefined;

    // --- system init: extract session_id + model ---
    if (type === 'system' && obj.subtype === 'init') {
      return {
        type: 'meta',
        meta: {
          sessionId: obj.session_id,
          model: obj.model,
        },
      };
    }

    // --- system status: ignore ---
    if (type === 'system') return null;

    // --- stream_event: unwrap the event ---
    if (type === 'stream_event' && obj.event) {
      return this.parseEvent(obj.event);
    }

    // --- result: skip (when using --include-partial-messages, text_delta
    //     chunks already contain the full text; processing result would
    //     duplicate the content) ---
    if (type === 'result') return null;

    // --- error ---
    if (type === 'error') {
      const msg = typeof obj.error === 'string' ? obj.error
        : (obj.error?.message || 'Unknown error');
      return { type: 'error', error: msg };
    }

    return null;
  }

  private parseEvent(event: any): ParsedChunk | null {
    const eventType = event.type as string | undefined;

    // content_block_delta with text_delta → text content
    if (eventType === 'content_block_delta' && event.delta) {
      const deltaType = event.delta.type as string;

      if (deltaType === 'text_delta' && event.delta.text) {
        return { type: 'text', content: event.delta.text as string };
      }

      // thinking_delta — skip (internal reasoning, not shown to user)
      if (deltaType === 'thinking_delta') return null;

      // input_json_delta — partial tool input, skip for now
      if (deltaType === 'input_json_delta') return null;
    }

    // content_block_start with tool_use → tool call
    if (eventType === 'content_block_start' && event.content_block) {
      const blockType = event.content_block.type as string;
      if (blockType === 'tool_use') {
        return {
          type: 'tool_use',
          tool: event.content_block.name as string,
          toolUseId: event.content_block.id as string,
        };
      }
    }

    // message_start — could extract model info but not critical
    // content_block_stop, message_delta, message_stop — not needed
    return null;
  }
}
