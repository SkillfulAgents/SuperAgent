import { afterEach, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { createServer, type ServerResponse } from 'node:http'
import { normalizeGrokResponses } from './llm-proxy-grok'
import { startLlmProxy } from './llm-proxy'

type Json = Record<string, any>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const prompt = { model: 'grok-4.7', max_tokens: 512, messages: [{ role: 'user' as const, content: 'Check the three pages' }] }
async function grok(handler: (body: Json, res: ServerResponse) => void, format: 'messages' | 'responses' = 'responses') {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    expect(req.url).toBe('/v1/responses')
    expect(req.headers.authorization).toBe('Bearer test-token')
    handler(JSON.parse(Buffer.concat(chunks).toString()), res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const handle = await startLlmProxy({ llmProviderId: 'grok-account', config: {
    adapter: 'grok', format, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    credential: { accessToken: 'test-token', accountId: 'account', generation: 1 }, headers: {},
  } })
  cleanup.push(handle.close)
  return new Anthropic({ baseURL: handle.env.ANTHROPIC_BASE_URL, apiKey: handle.env.ANTHROPIC_API_KEY, maxRetries: 0 })
}
function stream(res: ServerResponse, events: Json[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const bytes = Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  for (let i = 0; i < bytes.length; i += 17) res.write(bytes.subarray(i, i + 17))
  res.end()
}
function answer(res: ServerResponse) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ id: 'r', status: 'completed', output: [{ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }], usage: { input_tokens: 20, output_tokens: 2 } }))
}
it('maps disabled thinking to supported low effort without removing other reasoning settings or mutating input', () => {
  const input = { reasoning: { effort: 'none', summary: 'auto' }, include: ['reasoning.encrypted_content'] }
  expect(normalizeGrokResponses(input)).toEqual({ ...input, reasoning: { effort: 'low', summary: 'auto' } })
  expect(input.reasoning.effort).toBe('none')
  expect(normalizeGrokResponses({ reasoning: { effort: 'xhigh' } })).toEqual({ reasoning: { effort: 'xhigh' } })
  expect(normalizeGrokResponses({})).toEqual({})
})

// #1186 repaired reused thinking/text indexes because the CLI otherwise fell
// back to a non-streamed answer: chat/email never received text_delta. Assert
// actual deltas and indexes through the shared codec, not just finalMessage().
it.each(['messages', 'responses'] as const)('streams thinking and text through Responses for a %s Grok runtime descriptor', async format => {
  const reasoning = { id: 'rs', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checking' }], encrypted_content: 'opaque-reasoning' }
  const client = await grok((body, res) => {
    expect(body.reasoning.effort).toBe('low')
    stream(res, [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.7' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs', type: 'reasoning', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs', summary_index: 0, delta: 'Checking' },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { id: 'm', type: 'message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', output_index: 1, item_id: 'm', content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'm', content_index: 0, delta: 'Hello 🌍' },
      { type: 'response.completed', response: { id: 'r', model: 'grok-4.7', status: 'completed', output: [reasoning], usage: { input_tokens: 10, output_tokens: 3 } } },
    ])
  }, format)
  const events: Anthropic.MessageStreamEvent[] = []
  const result = await client.messages.stream({ ...prompt, thinking: { type: 'disabled' } }).on('streamEvent', event => events.push(event)).finalMessage()
  expect(result.content).toContainEqual({ type: 'text', text: 'Hello 🌍' })
  expect(events.filter(e => e.type === 'content_block_start').map(e => e.index)).toEqual([0, 1])
  expect(events).toContainEqual({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking' } })
  expect(events).toContainEqual({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello 🌍' } })
  expect(events.filter(e => e.type === 'content_block_stop').map(e => e.index)).toEqual([0, 1])
  expect(events.find(e => e.type === 'message_delta')).not.toHaveProperty('index')
  expect(events.at(-1)?.type).toBe('message_stop')
})

it('keeps parallel calls separate, restores long MCP names, and replays each result with its own call ID', async () => {
  const name = 'mcp__web__' + 'web_fetch_'.repeat(7)
  const inputs = ['a', 'b', 'c'].map(page => ({ url: `https://example.com/${page}`, maxChars: 3000 }))
  let turn = 0
  const client = await grok((body, res) => {
    if (turn++ > 0) {
      expect(body.input.filter((item: Json) => item.type === 'function_call_output')).toEqual(inputs.map((_, i) => ({ type: 'function_call_output', call_id: `call_${i}`, output: `page ${i}` })))
      answer(res); return
    }
    const calls = inputs.map((input, i) => ({ id: `fc_${i}`, type: 'function_call', call_id: `call_${i}`, name: body.tools[0].name, arguments: JSON.stringify(input) }))
    const events: Json[] = [{ type: 'response.created', response: { id: 'r', model: 'grok-4.7' } }]
    calls.forEach((call, i) => events.push({ type: 'response.output_item.added', output_index: i, item: { ...call, arguments: '' } }))
    // Interleave fragments from all three calls, as a parallel provider can.
    for (const slice of [0, 1]) calls.forEach((call, i) => events.push({ type: 'response.function_call_arguments.delta', output_index: i, item_id: call.id, delta: slice === 0 ? call.arguments.slice(0, 12) : call.arguments.slice(12) }))
    calls.forEach((call, i) => events.push({ type: 'response.output_item.done', output_index: i, item: call }))
    events.push({ type: 'response.completed', response: { id: 'r', model: 'grok-4.7', status: 'completed', output: calls, usage: { input_tokens: 10, output_tokens: 100 } } })
    stream(res, events)
  })
  const first = await client.messages.stream({ ...prompt, tools: [{ name, input_schema: { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'integer' } }, required: ['url'] } }] }).finalMessage()
  expect(first.content).toEqual(inputs.map((input, i) => ({ type: 'tool_use', id: `call_${i}`, name, input })))
  expect(first.stop_reason).toBe('tool_use')
  const next = await client.messages.create({ ...prompt, messages: [...prompt.messages,
    { role: 'assistant', content: first.content },
    { role: 'user', content: inputs.map((_, i) => ({ type: 'tool_result', tool_use_id: `call_${i}`, content: `page ${i}` })) },
  ] })
  expect(next.content).toContainEqual({ type: 'text', text: 'Done' })
})

it('preserves discovered schemas, system notes, direct images and nested tool-result images through the shared codec', async () => {
  const client = await grok((body, res) => {
    expect(body.tools.map((tool: Json) => tool.name)).toEqual(['read'])
    expect(body.tools[0].parameters.properties).toHaveProperty('optional')
    expect(body.tools[0].strict).toBe(false)
    expect(body.input).toContainEqual({ role: 'system', content: [{ type: 'input_text', text: 'mid-turn note' }] })
    const images = body.input.flatMap((item: Json) => item.content ?? []).filter((part: Json) => part.type === 'input_image')
    expect(images.map((image: Json) => image.image_url)).toEqual(['data:image/png;base64,dG9vbA==', 'data:image/png;base64,dXNlcg=='])
    expect(JSON.stringify(body)).not.toContain('foreign-signature')
    expect(JSON.stringify(body)).not.toContain('tool_reference')
    answer(res)
  })
  const body = { ...prompt, tools: [
    { name: 'read', defer_loading: true, input_schema: { type: 'object', properties: { optional: { type: 'object', properties: {} } } } },
    { name: 'unloaded', defer_loading: true, input_schema: { type: 'object' } },
  ], messages: [
    { role: 'system', content: 'mid-turn note' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign', signature: 'foreign-signature' }, { type: 'tool_use', name: 'read', id: 'read', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read', content: [{ type: 'tool_reference', tool_name: 'read' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'dG9vbA==' } }] },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'dXNlcg==' } },
    ] },
  ] }
  await client.messages.create(body as unknown as Anthropic.MessageCreateParamsNonStreaming)
})

it('still routes the SDK hosted WebSearch helper through Responses', async () => {
  const client = await grok((body, res) => { expect(body.tools).toEqual([{ type: 'web_search' }]); answer(res) })
  await client.messages.create({ ...prompt, tools: [{ type: 'web_search_20250305', name: 'web_search' }] })
})
