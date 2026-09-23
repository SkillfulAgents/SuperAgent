import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { GenericLlmProvider } from './generic-provider'
import { connectionConfigSchema, mergeConnectionConfig } from './connection-schema'

vi.mock('../config/settings', () => ({ getSettings: () => ({}), getModelCatalogSettings: () => ({}) }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function endpoint() {
  const requests: Array<{ url: string; auth?: string; body: any }> = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    requests.push({ url: req.url!, auth: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
    if (body.model === 'denied') {
      res.statusCode = 429
      return res.end(JSON.stringify({ error: { message: 'Quota exhausted' } }))
    }
    const responses = req.url?.endsWith('/responses')
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream')
      const events = responses ? [
        { type: 'response.created', response: { id: 'r', model: 'test-model' } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Answer' },
        { type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2 } } },
      ] : [
        { id: 'c', model: 'test-model', choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: null }] },
        { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ]
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.end(JSON.stringify(responses
      ? { id: 'r', status: 'completed', output: [{ type: 'function_call', call_id: 'call', name: 'read', arguments: '{"path":"a"}' }], usage: { input_tokens: 3, output_tokens: 2 } }
      : { id: 'c', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, requests }
}
const prompt = { model: 'test-model', max_tokens: 512, messages: [{ role: 'user' as const, content: 'Hello' }] }

describe('generic OpenAI connection', () => {
  it('preserves the format on credential-only edits and leaves old connections native', async () => {
    const previous = connectionConfigSchema.parse({ apiFormat: 'responses', apiKeys: { genericApiKey: 'old' } })
    expect(mergeConnectionConfig(previous, { apiKeys: { genericApiKey: 'new' }, env: {} }).apiFormat).toBe('responses')
    const native = new GenericLlmProvider({ apiKeys: { genericApiKey: 'key', genericBaseUrl: 'https://example.com' }, env: {} })
    expect(await native.getContainerProxyConfig()).toBeUndefined()
    expect(native.toolSearchEnv).toBeUndefined()
  })

  it.each(['chat-completions', 'responses'] as const)('runs helper tools, streams, discovery and errors through %s', async apiFormat => {
    const upstream = await endpoint()
    const provider = new GenericLlmProvider({ apiFormat, apiKeys: { genericApiKey: 'key', genericBaseUrl: `${upstream.url}/v1` }, env: {} })
    const client = provider.createClient().withOptions({ maxRetries: 0 })
    const reply = await client.messages.create({ ...prompt, tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] })
    expect(reply.content).toContainEqual({ type: 'tool_use', id: 'call', name: 'read', input: { path: 'a' } })
    expect(reply.usage.input_tokens).toBe(3)
    expect(upstream.requests[0].url).toBe(apiFormat === 'responses' ? '/v1/responses' : '/v1/chat/completions')
    expect(upstream.requests[0].auth).toBe('Bearer key')
    expect(upstream.requests[0].body[apiFormat === 'responses' ? 'max_output_tokens' : 'max_completion_tokens']).toBe(512)
    const streamed = await client.messages.stream(prompt).finalMessage()
    expect(streamed.content).toContainEqual({ type: 'text', text: 'Answer' })
    await expect(client.messages.create({ ...prompt, model: 'denied' })).rejects.toThrow('Quota exhausted')
    expect(await provider.validateKey('')).toEqual({ valid: true })
    expect((await provider.searchModels('test'))[0].id).toBe('test-model')
    expect(upstream.requests.at(-1)?.url).toBe('/v1/models')
    const runtime = await provider.getContainerProxyConfig()
    expect(runtime?.format).toBe(apiFormat)
    expect(runtime?.baseUrl).toContain('host.docker.internal')
    expect(provider.toolSearchEnv).toBe('true')
  })

  it.each(['https://endpoint.example', 'https://endpoint.example/v1/', 'https://endpoint.example/custom'])('uses the configured API path for %s', async baseUrl => {
    const provider = new GenericLlmProvider({ apiFormat: 'responses', apiKeys: { genericApiKey: 'key', genericBaseUrl: baseUrl }, env: {} })
    expect((await provider.getContainerProxyConfig())?.baseUrl).toBe(baseUrl.endsWith('/custom') ? baseUrl : 'https://endpoint.example/v1')
  })
})
