import { expect, it } from 'vitest'
import { normalizeGrokMessages, grokWireFormat } from './llm-proxy-grok'

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
