import { CredentialRefreshError } from './credential-refresh-error'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import { startLlmProxy, type LlmProxyHandle } from './llm-proxy'
import { expandDeferredTools } from './llm-proxy-tools'
import type { LlmProxyConfig } from './llm-proxy-schema'

type Json = Record<string, any>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function upstream(handler: (body: Json, req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    handler(JSON.parse(Buffer.concat(chunks).toString()), req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/v1`
}
const reply = { id: 'msg_1', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } }
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}
async function proxy(baseUrl: string, format: LlmProxyConfig['format'] = 'messages', extras: Partial<Parameters<typeof startLlmProxy>[0]> = {}) {
  const handle = await startLlmProxy({ llmProviderId: 'account-a', config: {
    baseUrl, format, credential: { accessToken: 'upstream-key', generation: 1 }, headers: {},
  }, ...extras })
  cleanup.push(handle.close)
  return handle
}
function client(handle: LlmProxyHandle) {
  return new Anthropic({ baseURL: handle.env.ANTHROPIC_BASE_URL, apiKey: handle.env.ANTHROPIC_API_KEY, maxRetries: 0 })
}
const prompt = { model: 'test', max_tokens: 512, messages: [{ role: 'user' as const, content: 'Hi' }] }

describe('embedded provider proxy', () => {
  it.each(['chat-completions', 'responses'] as const)('translates %s JSON and preserves tool names and usage', async format => {
    const name = 'mcp__' + 'very_long_tool_name_'.repeat(5)
    const base = await upstream((body, req, res) => {
      expect(req.headers.authorization).toBe('Bearer upstream-key')
      expect(req.url).toBe(format === 'responses' ? '/v1/responses' : '/v1/chat/completions')
      const toolName = format === 'responses' ? body.tools[0].name : body.tools[0].function.name
      expect(toolName.length).toBeLessThanOrEqual(64)
      json(res, format === 'responses' ? {
        id: 'r', model: 'test', status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: toolName, arguments: '{"x":1}' }], usage: { input_tokens: 10, output_tokens: 3 },
      } : { id: 'c', model: 'test', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: '{"x":1}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3 } })
    })
    const result = await client(await proxy(base, format)).messages.create({ ...prompt, tools: [{ name, input_schema: { type: 'object' } }] })
    expect(result.content).toContainEqual({ type: 'tool_use', id: 'call_1', name, input: { x: 1 } })
    expect(result.stop_reason).toBe('tool_use')
    expect(result.usage.input_tokens).toBe(10)
  })

  it.each(['chat-completions', 'responses'] as const)('streams %s through the real Anthropic client', async format => {
    const base = await upstream((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = format === 'responses' ? [
        { type: 'response.created', response: { id: 'r', model: 'test' } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.completed', response: { id: 'r', model: 'test', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1 } } },
      ] : [
        { id: 'c', model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
        { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      ]
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
    const result = await client(await proxy(base, format)).messages.stream(prompt).finalMessage()
    expect(result.content).toContainEqual({ type: 'text', text: 'OK' })
    expect(result.usage.output_tokens).toBe(1)
  })

  it.each(['chat-completions', 'responses'] as const)('keeps tool-result images when translating %s', async format => {
    const base = await upstream((body, _req, res) => {
      expect(JSON.stringify(body)).toContain('data:image/png;base64,aGVsbG8=')
      json(res, format === 'responses'
        ? { id: 'r', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }
        : { id: 'c', choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
    })
    await client(await proxy(base, format)).messages.create({ ...prompt, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ] }] },
    ] })
  })

  it('reports truncated streams as errors rather than successful answers', async () => {
    const base = await upstream((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"id":"c","model":"test","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
    })
    await expect(client(await proxy(base, 'chat-completions')).messages.stream(prompt).finalMessage()).rejects.toThrow()
  })

  it('coalesces refresh across concurrent rejected requests and retries once', async () => {
    let exchanges = 0
    let attempts = 0
    const base = await upstream((_body, req, res) => {
      attempts++
      if (req.headers.authorization === 'Bearer upstream-key') json(res, { error: { message: 'expired' } }, 401)
      else json(res, reply)
    })
    const handle = await proxy(base, 'messages', { refreshCredential: async (old, rejected) => {
      expect(rejected).toBe(true); expect(old.generation).toBe(1); exchanges++
      await new Promise(resolve => setTimeout(resolve, 20))
      return { accessToken: 'fresh', generation: 2 }
    } })
    const results = await Promise.all([client(handle).messages.create(prompt), client(handle).messages.create(prompt)])
    expect(results).toHaveLength(2); expect(exchanges).toBe(1); expect(attempts).toBeLessThanOrEqual(4)
  })

  it('drops reasoning from the prior account when an auth retry changes the account', async () => {
    let phase = 'first'
    const base = await upstream((body, req, res) => {
      if (phase === 'retry' && req.headers.authorization === 'Bearer upstream-key') {
        expect(JSON.stringify(body)).toContain('encrypted-account-a')
        json(res, { error: { message: 'expired' } }, 401)
        return
      }
      if (phase === 'retry') expect(JSON.stringify(body)).not.toContain('encrypted-account-a')
      json(res, { id: 'r', status: 'completed', output: [
        { type: 'reasoning', id: 'rs', encrypted_content: 'encrypted-account-a', summary: [{ type: 'summary_text', text: 'Reasoning' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] },
      ], usage: { input_tokens: 1, output_tokens: 1 } })
    })
    const first = await client(await proxy(base, 'responses')).messages.create(prompt)
    phase = 'retry'
    const next = await proxy(base, 'responses', { refreshCredential: async () => ({ accessToken: 'other-account', generation: 2 }) })
    await client(next).messages.create({ ...prompt, messages: [
      ...prompt.messages, { role: 'assistant', content: first.content }, { role: 'user', content: 'Continue' },
    ] })
  })

  it('swaps credentials without replacing the listener and ignores stale snapshots', async () => {
    const seen: unknown[] = []
    const base = await upstream((_body, req, res) => { seen.push(req.headers.authorization); json(res, reply) })
    const handle = await proxy(base)
    const url = handle.env.ANTHROPIC_BASE_URL
    handle.updateCredential({ accessToken: 'rotated', generation: 2 })
    handle.updateCredential({ accessToken: 'stale', generation: 1 })
    await client(handle).messages.create(prompt)
    expect(handle.env.ANTHROPIC_BASE_URL).toBe(url)
    expect(seen).toEqual(['Bearer rotated'])
  })

  it('does not let an in-flight refresh overwrite a newer runtime credential', async () => {
    let release!: (value: { accessToken: string; generation: number }) => void
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const seen: unknown[] = []
    const base = await upstream((_body, req, res) => { seen.push(req.headers.authorization); json(res, reply) })
    const handle = await proxy(base, 'messages', {
      config: { baseUrl: base, format: 'messages', headers: {}, credential: { accessToken: 'old', generation: 1, expiresAt: 0 } },
      refreshCredential: () => { began(); return new Promise(resolve => { release = resolve }) },
    })
    const result = client(handle).messages.create(prompt)
    const pending = result.then(value => value)
    await started
    handle.updateCredential({ accessToken: 'reconnected', generation: 3 })
    release({ accessToken: 'outdated-refresh', generation: 2 })
    await pending
    expect(seen).toEqual(['Bearer reconnected'])
  })

  it('does not retry a revoked refresh token and recovers after reconnect', async () => {
    let exchanges = 0
    const base = await upstream((_body, req, res) => {
      if (req.headers.authorization === 'Bearer reconnected') json(res, reply)
      else json(res, { error: { message: 'expired' } }, 401)
    })
    const handle = await proxy(base, 'messages', { refreshCredential: async () => { exchanges++; throw new CredentialRefreshError(401) } })
    const retrying = new Anthropic({ baseURL: handle.env.ANTHROPIC_BASE_URL, apiKey: handle.env.ANTHROPIC_API_KEY, maxRetries: 2 })
    for (let i = 0; i < 3; i++) await expect(retrying.messages.create(prompt)).rejects.toMatchObject({ status: 401 })
    expect(exchanges).toBe(1)
    handle.updateCredential({ accessToken: 'reconnected', generation: 2 })
    await retrying.messages.create(prompt)
  })
  it('backs off transient refresh failures without exposing host exception details', async () => {
    let exchanges = 0
    const base = await upstream((_body, _req, res) => json(res, { error: { message: 'expired' } }, 401))
    const handle = await proxy(base, 'messages', { refreshCredential: async () => { exchanges++; throw new Error('private credential details') } })
    for (let i = 0; i < 3; i++) {
      const error = await client(handle).messages.create(prompt).catch(error => error)
      expect(error.status).toBe(503)
      expect(error.message).toContain('temporarily unavailable')
      expect(error.message).not.toContain('private credential details')
    }
    expect(exchanges).toBe(1)
  })

  it('adapts Codex requests and collects streams for non-streaming callers', async () => {
    const seen: string[] = []
    const base = await upstream((body, req, res) => {
      seen.push(String(req.headers['chatgpt-account-id']))
      expect(body.store).toBe(false)
      expect(body.stream).toBe(true)
      expect(body.instructions).toBe('')
      expect(body.max_output_tokens).toBeUndefined()
      if (req.headers.authorization === 'Bearer old') { json(res, { error: { message: 'expired' } }, 401); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {
        id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
        usage: { input_tokens: 3, output_tokens: 1 },
      } })}\n\n`)
    })
    const handle = await proxy(base, 'responses', { config: { adapter: 'codex', baseUrl: base, format: 'responses', headers: {},
      credential: { accessToken: 'old', accountId: 'account-a', generation: 1 } },
      refreshCredential: async () => ({ accessToken: 'new', accountId: 'account-b', generation: 2 }),
    })
    const message = await client(handle).messages.create(prompt)
    expect(message.content).toContainEqual({ type: 'text', text: 'OK' })
    expect(message.usage.input_tokens).toBe(3)
    expect(seen).toEqual(['account-a', 'account-b'])
  })

  it('preserves Codex model eligibility errors', async () => {
    const base = await upstream((_body, _req, res) => json(res, { detail: 'This model is not supported with a ChatGPT account' }, 400))
    const handle = await proxy(base, 'responses', { config: { adapter: 'codex', baseUrl: base, format: 'responses', headers: {}, credential: { accessToken: 'key', generation: 0 } } })
    await expect(client(handle).messages.create(prompt)).rejects.toThrow('not supported with a ChatGPT account')
  })

  it('rejects truncated non-streaming Codex responses', async () => {
    const base = await upstream((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n')
    })
    const handle = await proxy(base, 'responses', { config: { adapter: 'codex', baseUrl: base, format: 'responses', headers: {}, credential: { accessToken: 'key', accountId: 'a', generation: 0 } } })
    await expect(client(handle).messages.create(prompt)).rejects.toThrow('Provider proxy request failed')
  })

  it('does not refresh quota errors and preserves the error message', async () => {
    let refreshed = false
    const base = await upstream((_body, _req, res) => json(res, { error: { message: 'Quota used' } }, 429))
    const handle = await proxy(base, 'responses', { refreshCredential: async () => { refreshed = true; throw new Error('unexpected') } })
    await expect(client(handle).messages.create(prompt)).rejects.toThrow('Quota used')
    expect(refreshed).toBe(false)
  })

  it('bounds auth retry even when the replacement token is rejected', async () => {
    let attempts = 0
    const base = await upstream((_body, _req, res) => { attempts++; json(res, { error: { message: 'Revoked' } }, 401) })
    const handle = await proxy(base, 'messages', { refreshCredential: async () => ({ accessToken: 'fresh', generation: 2 }) })
    await expect(client(handle).messages.create(prompt)).rejects.toThrow('Revoked')
    expect(attempts).toBe(2)
  })

  it('refreshes near expiry before sending and does not forward client auth or routing headers', async () => {
    const base = await upstream((_body, req, res) => {
      expect(req.headers.authorization).toBe('Bearer fresh')
      expect(req.headers['x-api-key']).toBeUndefined()
      expect(req.headers['x-upstream']).toBeUndefined()
      json(res, reply)
    })
    const handle = await proxy(base, 'messages', {
      config: { baseUrl: base, format: 'messages', headers: {}, credential: { accessToken: 'old', expiresAt: Date.now() - 1, generation: 1 } },
      refreshCredential: async (_old, rejected) => { expect(rejected).toBe(false); return { accessToken: 'fresh', generation: 2 } },
    })
    await client(handle).messages.create(prompt, { headers: { 'x-upstream': 'https://other.invalid' } })
  })

  it('isolates concurrent sessions and rejects unknown callers', async () => {
    const seen: unknown[] = []
    const base = await upstream((_body, req, res) => { seen.push(req.headers.authorization); json(res, reply) })
    const a = await proxy(base)
    const b = await proxy(base, 'messages', { config: { baseUrl: base, format: 'messages', headers: {}, credential: { accessToken: 'other', generation: 1 } }, llmProviderId: 'account-b' })
    await Promise.all([client(a).messages.create(prompt), client(b).messages.create(prompt)])
    expect(seen.sort()).toEqual(['Bearer other', 'Bearer upstream-key'])
    const denied = await fetch(`${a.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: JSON.stringify(prompt), headers: { 'x-api-key': b.env.ANTHROPIC_API_KEY } })
    expect(denied.status).toBe(401)
    expect(seen).toHaveLength(2)
  })

  it('aborts an in-flight upstream when the client disconnects', async () => {
    let closed!: () => void
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const base = await upstream((_body, _req, res) => { res.on('close', closed); ready() })
    const handle = await proxy(base)
    const abort = new AbortController()
    const pending = client(handle).messages.create(prompt, { signal: abort.signal }).catch(() => undefined)
    await started; abort.abort(); await pending; await disconnected
  })
})

describe('deferred tool compatibility', () => {
  it('expands discovered schemas, preserves images, and keeps undiscovered tools deferred', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }
    const body = { tools: [
      { name: 'ToolSearch', input_schema: { type: 'object' } },
      { name: 'loaded', defer_loading: true, input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
      { name: 'hidden', defer_loading: true, input_schema: { type: 'object' } },
    ], messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 's', content: [{ type: 'tool_reference', tool_name: 'loaded' }, image] }] }] }
    const out = expandDeferredTools(body) as Json
    expect(out.tools.map((t: Json) => t.name)).toEqual(['ToolSearch', 'loaded'])
    expect(out.messages[0].content[0].content[1]).toEqual(image)
    expect(out.messages[0].content[0].content[0].text).toContain('parameters')
    expect(JSON.stringify(out)).not.toContain('tool_reference')
    expect(body.tools[1].defer_loading).toBe(true)
  })
  it('keeps tools used earlier callable and preserves compacted references as names', () => {
    const out = expandDeferredTools({ tools: [{ name: 'used', defer_loading: true }], messages: [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'used' }] },
      { role: 'user', content: [{ type: 'tool_reference', tool_name: 'compacted' }] },
    ] }) as Json
    expect(out.tools).toEqual([{ name: 'used' }])
    expect(out.messages[1].content[0].text).toContain('compacted')
  })
})
