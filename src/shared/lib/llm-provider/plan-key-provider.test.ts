import { afterEach, expect, it, vi } from 'vitest'
import { QwenSubscriptionLlmProvider } from './qwen-subscription-provider'
import { DoubaoSubscriptionLlmProvider } from './doubao-subscription-provider'
import { connectionConfigSchema } from './connection-schema'
vi.mock('../config/settings', () => ({ getSettings: () => ({}), getModelCatalogSettings: () => ({}) }))
afterEach(() => vi.restoreAllMocks())
const configuration = { apiKeys: { planApiKey: 'sk-sp-plan-key' }, env: {} }

it('sends the Qwen plan key to the Token Plan Anthropic endpoint', async () => {
  const provider = new QwenSubscriptionLlmProvider(configuration)
  expect(await provider.getContainerEnvVars()).toEqual({
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-sp-plan-key',
  })
  expect(await provider.getContainerProxyConfig()).toBeUndefined()
  expect(provider.getApiKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
})

it('routes Doubao through the Agent Plan Responses endpoint', async () => {
  const provider = new DoubaoSubscriptionLlmProvider(configuration)
  expect(await provider.getContainerEnvVars()).toEqual({})
  expect(await provider.getContainerProxyConfig()).toMatchObject({
    format: 'responses', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', credential: { accessToken: 'sk-sp-plan-key' },
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'bad key' } }, { status: 401 }))
  expect((await provider.validateKey('')).valid).toBe(false)
  const [url, init] = fetch.mock.calls[0]
  expect(String(url)).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/responses')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-sp-plan-key')
})

it('reports a missing plan key as not configured', () => {
  expect(new QwenSubscriptionLlmProvider({ apiKeys: {}, env: {} }).getApiKeyStatus().isConfigured).toBe(false)
  expect(connectionConfigSchema.parse({ apiKeys: { planApiKey: ' sk-sp-plan-key ' } }).apiKeys.planApiKey).toBe('sk-sp-plan-key')
})
