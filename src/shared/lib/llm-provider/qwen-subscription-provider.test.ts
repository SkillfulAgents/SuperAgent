import { afterEach, expect, it, vi } from 'vitest'
import { QwenSubscriptionLlmProvider } from './qwen-subscription-provider'
import { connectionConfigSchema } from './connection-schema'
import { modelCatalogSchema } from './model-catalog-schema'

vi.mock('../config/settings', () => ({ getSettings: async () => ({}) }))
afterEach(() => vi.restoreAllMocks())
const configuration = { apiKeys: { planApiKey: 'sk-sp-plan-key' }, env: {} }

it('sends the plan key to the Token Plan Anthropic endpoint', async () => {
  const provider = new QwenSubscriptionLlmProvider(configuration)
  expect(await provider.getContainerEnvVars()).toEqual({
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-sp-plan-key',
  })
  expect(await provider.getContainerProxyConfig()).toBeUndefined()
  expect(await provider.getApiKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
})

it('validates the saved key with the default Token Plan model', async () => {
  const provider = new QwenSubscriptionLlmProvider(configuration)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'bad key' } }, { status: 401 }))
  expect((await provider.validateKey('')).valid).toBe(false)
  const [url, init] = fetch.mock.calls[0]
  expect(String(url)).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-sp-plan-key')
  expect(JSON.parse(String(init?.body)).model).toBe('qwen3.8-max')
})

it('declares Messages effort choices for every Token Plan model', () => {
  const catalog = modelCatalogSchema.parse(new QwenSubscriptionLlmProvider().getBuiltinCatalog())
  expect(Object.fromEntries(catalog.map(model => [model.id, model.supportedEfforts]))).toEqual({
    'qwen3.6-flash': ['high'],
    'qwen3.7-plus': ['high'],
    'qwen3.7-max': ['high'],
    'qwen3.8-flash': ['low', 'medium', 'xhigh'],
    'qwen3.8-max': ['low', 'medium', 'xhigh'],
    'qwen4-max-preview': ['low', 'medium', 'xhigh'],
    'deepseek-v4-pro': ['high', 'max'],
    'deepseek-v4.1-flash': ['high'],
    'glm-5.3': ['low', 'high', 'max'],
    'glm-5.2': ['high', 'max'],
  })
})

it('declares a context window for every Token Plan model', () => {
  const catalog = modelCatalogSchema.parse(new QwenSubscriptionLlmProvider().getBuiltinCatalog())
  expect(Object.fromEntries(catalog.map(model => [model.id, model.contextWindow]))).toEqual({
    'qwen3.6-flash': 983_616,
    'qwen3.7-plus': 983_616,
    'qwen3.7-max': 983_616,
    'qwen3.8-flash': 983_616,
    'qwen3.8-max': 983_616,
    'qwen4-max-preview': 983_616,
    'deepseek-v4-pro': 1_000_000,
    'deepseek-v4.1-flash': 1_000_000,
    'glm-5.3': 1_048_576,
    'glm-5.2': 1_048_576,
  })
})

it.each(['low', 'medium', 'xhigh'] as const)('sends %s effort unchanged', async effort => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'bad key' } }, { status: 401 }))
  const client = await new QwenSubscriptionLlmProvider(configuration).createClient()
  await expect(client.messages.create({ model: 'qwen3.8-max', max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }], output_config: { effort } })).rejects.toThrow()
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).output_config.effort).toBe(effort)
})

it('reports a missing plan key as not configured', async () => {
  const provider = new QwenSubscriptionLlmProvider({ apiKeys: {}, env: {} })
  expect((await provider.getApiKeyStatus()).isConfigured).toBe(false)
  expect((await provider.validateKey('')).valid).toBe(false)
  await expect(provider.createClient()).rejects.toThrow('key not configured')
  expect(connectionConfigSchema.parse({ apiKeys: { planApiKey: ' sk-sp-plan-key ' } }).apiKeys.planApiKey).toBe('sk-sp-plan-key')
})
