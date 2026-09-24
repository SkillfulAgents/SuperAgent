import { expect, it } from 'vitest'
import { normalizeGrokMessages, normalizeGrokMessagesStream, grokWireFormat } from './llm-proxy-grok'

async function rewrite(input: string): Promise<string> {
  const stream = normalizeGrokMessagesStream(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(input)
      controller.enqueue(bytes.slice(0, 20))
      controller.enqueue(bytes.slice(20))
      controller.close()
    },
  }))
  const reader = stream.getReader()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out += new TextDecoder().decode(value)
  }
}
function data(event: unknown) {
  return JSON.parse(String(event).split('\n').find(line => line.startsWith('data:'))!.slice(5))
}

it('normalizes full SDK system messages, optional schemas and nested tool-result images without mutation', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test' } }
  const input = { system: 'original', messages: [
    { role: 'system', content: 'mid-turn' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign', signature: 'other-provider' }, { type: 'tool_use', id: 'read' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: [image] }] },
  ], tools: [{ name: 'Example', input_schema: { type: 'object', properties: { optional: { type: 'object', properties: {} } } } }] }
  const original = JSON.stringify(input)
  const output = normalizeGrokMessages(input) as typeof input
  expect(output.system).toEqual([{ type: 'text', text: 'original' }, { type: 'text', text: 'mid-turn' }])
  expect(output.messages[1].content).toContainEqual(image)
  expect(JSON.stringify(output.tools)).toContain('"required":[]')
  expect(JSON.stringify(output)).not.toContain('other-provider')
  expect(JSON.stringify(input)).toBe(original)
})
it('uses Responses only for native hosted search', () => {
  expect(grokWireFormat({ tools: [{ name: 'ToolSearch', input_schema: {} }] })).toBe('messages')
  expect(grokWireFormat({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] })).toBe('responses')
})

it('does not invent a system field when the request has none', () => {
  expect(normalizeGrokMessages({ messages: [{ role: 'user', content: 'Hi' }] })).not.toHaveProperty('system')
})

it('assigns sequential block indexes and fills a missing delta index', async () => {
  const sse = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
    '',
  ].join('\n')
  const events = (await rewrite(sse)).trim().split('\n\n').map(data)
  expect(events.map(event => event.index)).toEqual([0, 0, 0, 1, 1, undefined])
  expect(events[1].delta).toEqual({ type: 'thinking_delta', thinking: 'hmm' })
  expect(events[4].delta).toEqual({ type: 'text_delta', text: 'Hi' })
  expect(events[5].delta).toEqual({ stop_reason: 'end_turn' })
})
