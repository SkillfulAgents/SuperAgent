import { afterEach, expect, it, vi } from 'vitest'
import { GrokSubscriptionLlmProvider, GROK_CLIENT_HEADERS } from './grok-subscription-provider'
vi.mock('../config/settings', () => ({ getSettings: () => ({}), getModelCatalogSettings: () => ({}) }))
afterEach(() => vi.restoreAllMocks())
const credential = { accessToken: 'old', refreshToken: 'secret-refresh', accountId: 'a', generation: 1, expiresAt: Date.now() + 3600000 }
const prompt = { model: 'grok-4.7', max_tokens: 512, messages: [{ role: 'user' as const, content: 'Hi' }] }
const reply = { id: 'r', status: 'completed', output: [{ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 3, output_tokens: 1 } }
function provider(resolveCredential = vi.fn().mockResolvedValue(credential)) {
  return new GrokSubscriptionLlmProvider({ apiKeys: {}, env: {}, oauth: credential, resolveCredential })
}
it('issues an access-only Responses proxy descriptor', async () => {
  const config = await provider().getContainerProxyConfig()
  expect(config).toMatchObject({ adapter: 'grok', format: 'responses', headers: GROK_CLIENT_HEADERS, credential: { accessToken: 'old' } })
  expect(JSON.stringify(config)).not.toContain('secret-refresh')
})
it('translates host helper calls, thinking configuration, tools and usage through Responses', async () => {
  const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(reply))
  const result = await provider().createClient().messages.create({ ...prompt, thinking: { type: 'disabled' }, tools: [{ name: 'optional', input_schema: { type: 'object', properties: { value: { type: 'string' } } } }] })
  const [url, init] = upstream.mock.calls[0]
  expect(url).toBe('https://cli-chat-proxy.grok.com/v1/responses')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer old')
  expect(new Headers(init?.headers).get('x-grok-client-mode')).toBe('cli')
  expect(new Headers(init?.headers).has('x-api-key')).toBe(false)
  expect(init?.redirect).toBe('error')
  expect(JSON.parse(String(init?.body))).toMatchObject({ store: false, reasoning: { effort: 'low' }, tools: [{ type: 'function', name: 'optional', strict: false }] })
  expect(result.content).toEqual([{ type: 'text', text: 'OK' }])
  expect(result.usage.input_tokens).toBe(3)
})
it('retranslates after a 401 so another account cannot receive old reasoning', async () => {
  const resolve = vi.fn().mockResolvedValue(credential)
  const source = { ...reply, output: [{ id: 'rs', type: 'reasoning', encrypted_content: 'account-a-reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }, ...reply.output] }
  const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(source))
  const client = provider(resolve).createClient().withOptions({ maxRetries: 0 })
  const first = await client.messages.create(prompt)
  upstream.mockResolvedValueOnce(Response.json({ error: { message: 'expired' } }, { status: 401 })).mockResolvedValueOnce(Response.json(reply))
  resolve.mockResolvedValueOnce(credential).mockResolvedValueOnce({ ...credential, accessToken: 'new', accountId: 'b', generation: 2 })
  await client.messages.create({ ...prompt, messages: [...prompt.messages, { role: 'assistant', content: first.content }, { role: 'user', content: 'Continue' }] })
  expect(resolve).toHaveBeenLastCalledWith(1)
  expect(String(upstream.mock.calls[1][1]?.body)).toContain('account-a-reasoning')
  expect(String(upstream.mock.calls[2][1]?.body)).not.toContain('account-a-reasoning')
  expect(new Headers(upstream.mock.calls[2][1]?.headers).get('authorization')).toBe('Bearer new')
})
it('does not refresh for quota errors', async () => {
  const resolve = vi.fn().mockResolvedValue(credential)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'Quota exhausted' } }, { status: 429 }))
  await expect(provider(resolve).createClient().withOptions({ maxRetries: 0 }).messages.create(prompt)).rejects.toThrow('Quota exhausted')
  expect(resolve).toHaveBeenCalledTimes(1)
})
