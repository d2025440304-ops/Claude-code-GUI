/**
 * StreamParser — CLI 流式解析器单元测试
 */
import { describe, it, expect } from 'vitest'
import { StreamParser } from './stream-parser'

describe('StreamParser', () => {
  it('parses system init meta', () => {
    const p = new StreamParser()
    const result = p.parse('{"type":"system","subtype":"init","session_id":"sess_123","model":"claude-sonnet-4"}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'meta', meta: { sessionId: 'sess_123', model: 'claude-sonnet-4' } })
  })

  it('parses text delta from stream_event', () => {
    const p = new StreamParser()
    const result = p.parse('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'text', content: 'Hello' })
  })

  it('parses thinking delta from stream_event', () => {
    const p = new StreamParser()
    const result = p.parse('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"I am thinking..."}}}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'thinking', content: 'I am thinking...' })
  })

  it('parses tool_use block start', () => {
    const p = new StreamParser()
    const result = p.parse('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Bash","id":"toolu_123"}}}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'tool_use', tool: 'Bash', toolUseId: 'toolu_123', blockStart: true })
  })

  it('parses tool_use stop with input', () => {
    const p = new StreamParser()
    // First start the block
    p.parse('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Bash","id":"toolu_123"}}}\n')
    // Then stop it with input
    p.parse('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}}\n')
    const result = p.parse('{"type":"stream_event","event":{"type":"content_block_stop","index":0}}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'tool_use', tool: 'Bash', toolUseId: 'toolu_123' })
    expect(result[0].input).toBe('{"command":"ls"}')
  })

  it('parses user tool_result', () => {
    const p = new StreamParser()
    const result = p.parse('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"Done"}]},"tool_use_result":{"stdout":"Done"}}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_123', stdout: 'Done' })
  })

  it('parses error event', () => {
    const p = new StreamParser()
    const result = p.parse('{"type":"error","error":{"message":"Network error"}}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'error', error: 'Network error' })
  })

  it('parses permission denials from result', () => {
    const p = new StreamParser()
    const result = p.parse('{"type":"result","permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_123","tool_input":{"command":"ls"}}]}\n')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'permission_denial', tool: 'Bash', toolUseId: 'toolu_123' })
  })

  it('handles partial data split across chunks', () => {
    const p = new StreamParser()
    const r1 = p.parse('{"type":"stream_event","event":{"type":"content_block_delta","i')
    expect(r1).toHaveLength(0) // incomplete
    const r2 = p.parse('ndex":0,"delta":{"type":"text_delta","text":"Hello"}}}\n')
    expect(r2).toHaveLength(1)
    expect(r2[0]).toMatchObject({ type: 'text', content: 'Hello' })
  })

  it('handles multiple lines', () => {
    const p = new StreamParser()
    const result = p.parse(
      '{"type":"system","subtype":"init","session_id":"sess_1"}\n' +
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}\n' +
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}\n'
    )
    expect(result).toHaveLength(3)
  })

  it('ignores invalid JSON lines', () => {
    const p = new StreamParser()
    const result = p.parse('not json\n{"type":"text"}\n')
    expect(result).toHaveLength(0) // "not json" is skipped, but "text" is unknown type
  })

  it('flush returns remaining buffered line', () => {
    const p = new StreamParser()
    p.parse('{"type":"system","subtype":"init","session_id":"sess_1"}\n')
    p.parse('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}')
    const result = p.flush()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'text', content: 'Hi' })
  })

  it('clear resets all state', () => {
    const p = new StreamParser()
    p.parse('{"type":"system","subtype":"init","session_id":"sess_1"}\n')
    p.clear()
    expect(p.flush()).toHaveLength(0)
  })
})