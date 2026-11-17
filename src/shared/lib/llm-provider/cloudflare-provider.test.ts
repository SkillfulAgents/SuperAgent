import { afterEach, expect, it, vi } from 'vitest'
import { CloudflareLlmProvider } from './cloudflare-provider'
import { modelCatalogSchema } from './model-catalog-schema'

vi.mock('../config/settings', () => ({ getSettings: async () => ({}) }))
afterEach(() => vi.restoreAllMocks())
const configuration = { apiKeys: { cloudflareApiToken: 'cf-token', cloudflareAccountId: 'account-123' }, env: {} }
const accountUrl = 'https://api.cloudflare.com/client/v4/accounts/account-123'

it('sends agents to the account Chat Completions endpoint', async () => {
  const provider = new CloudflareLlmProvider(configuration)
  expect(await provider.getContainerProxyConfig()).toEqual({
    format: 'chat-completions', baseUrl: `${accountUrl}/ai/v1`, credential: { accessToken: 'cf-token', generation: 0 },
    headers: {}, chatTokenLimitField: 'max_completion_tokens',
  })
  expect(await provider.getContainerEnvVars()).toEqual({})
  expect(await provider.getApiKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
  const withoutAccount = new CloudflareLlmProvider({ apiKeys: { cloudflareApiToken: 'cf-token' }, env: {} })
  expect(await withoutAccount.getApiKeyStatus()).toEqual({ isConfigured: false, source: 'none' })
})

it('translates host Messages calls to Chat Completions', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    id: 'chatcmpl-1', object: 'chat.completion', model: '@cf/zai-org/glm-5.3',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  }))
  const client = await new CloudflareLlmProvider(configuration).createClient()
  const message = await client.messages.create({ model: '@cf/zai-org/glm-5.3', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
  expect(message.content).toEqual([expect.objectContaining({ type: 'text', text: 'Hello' })])
  const [url, init] = fetch.mock.calls[0]
  expect(String(url)).toBe(`${accountUrl}/ai/v1/chat/completions`)
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cf-token')
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: '@cf/zai-org/glm-5.3', max_completion_tokens: 16 })
})

it('validates the token and account ID with one model search', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: false }, { status: 403 }))
  const result = await new CloudflareLlmProvider(configuration).validateKey('')
  expect(result.valid).toBe(false)
  expect(result.error).toContain('Workers AI')
  const [url, init] = fetch.mock.calls[0]
  expect(String(url)).toBe(`${accountUrl}/ai/models/search?task=Text+Generation&per_page=1`)
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cf-token')
})

it('lists only tool-calling models that are still served', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-16T12:00:00Z'), toFake: ['Date'] })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, result: [
    { name: '@cf/zai-org/glm-5.3', description: 'GLM model', properties: [
      { property_id: 'function_calling', value: 'true' }, { property_id: 'context_window', value: '1048576' },
      { property_id: 'vision', value: 'true' },
      { property_id: 'price', value: [{ unit: 'per M input tokens', price: 1.4, currency: 'USD' }, { unit: 'per M output tokens', price: 4.4, currency: 'USD' }] },
    ] },
    { name: '@cf/zai-org/glm-5.2', properties: [{ property_id: 'function_calling', value: 'true' }, { property_id: 'planned_deprecation_date', value: '2026-11-20' }] },
    { name: '@cf/zai-org/glm-4.6', properties: [{ property_id: 'function_calling', value: 'true' }, { property_id: 'planned_deprecation_date', value: '2026-11-01' }] },
    { name: '@cf/meta/llama-guard-3-8b', properties: [{ property_id: 'context_window', value: '131072' }] },
  ] }))
  try {
    const models = await new CloudflareLlmProvider(configuration).searchModels('glm')
    expect(String(fetch.mock.calls[0][0])).toBe(`${accountUrl}/ai/models/search?task=Text+Generation&per_page=100&search=glm`)
    expect(models).toEqual([
      { id: '@cf/zai-org/glm-5.3', label: 'glm-5.3', blurb: 'GLM model', family: 'glm', supportedEfforts: ['low', 'medium', 'high'],
        supportsWebSearch: false, supportsImageInput: true, contextWindow: 1_048_576, pricing: { inputPerMtok: 1.4, outputPerMtok: 4.4 } },
      { id: '@cf/zai-org/glm-5.2', label: 'glm-5.2', blurb: undefined, family: 'glm', supportedEfforts: ['low', 'medium', 'high'],
        supportsWebSearch: false, supportsImageInput: false },
    ])
  } finally {
    vi.useRealTimers()
  }
})

it('ships a valid built-in catalog with one default per family', () => {
  const catalog = modelCatalogSchema.parse(new CloudflareLlmProvider().getBuiltinCatalog())
  expect(catalog.map(model => [model.id, model.family, model.isLatest])).toEqual([
    ['@cf/zai-org/glm-5.3', 'glm', true],
    ['@cf/deepseek-ai/deepseek-v4.1-flash-1017', 'deepseek', true],
    ['@cf/openai/gpt-oss-120b', 'gpt-oss', true],
  ])
})
