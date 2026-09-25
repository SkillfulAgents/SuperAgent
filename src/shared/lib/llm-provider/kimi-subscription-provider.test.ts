import { afterEach, expect, it, vi } from 'vitest'
import { KimiSubscriptionLlmProvider } from './kimi-subscription-provider'
import { modelSearchResultSchema } from './model-catalog-schema'
vi.mock('../config/settings', () => ({ getSettings: () => ({}), getModelCatalogSettings: () => ({}) }))
afterEach(() => vi.restoreAllMocks())
const credential = { accessToken: 't', refreshToken: 'r', accountId: 'a', generation: 1, expiresAt: Date.now() + 3600000 }
const provider = () => new KimiSubscriptionLlmProvider({ apiKeys: {}, env: {}, oauth: credential, resolveCredential: vi.fn().mockResolvedValue(credential) })
it('keeps discovered models without advertised efforts valid', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [
    { id: 'k3', think_efforts: { valid_efforts: ['low', 'high', 'max'] } },
    { id: 'kimi-for-coding-highspeed' },
  ] }))
  const [k3, highspeed] = await provider().searchModels('')
  expect(k3.supportedEfforts).toEqual(['low', 'high', 'max'])
  expect(highspeed.supportedEfforts).toEqual(['high'])
  expect(modelSearchResultSchema.safeParse(highspeed).success).toBe(true)
})
it('shows Kimi quota messages for 403 instead of a membership hint', () => {
  const quota = "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."
  const presentation = provider().presentationForTurnError(403, { error: { message: quota } }, 'billing_error')
  expect(presentation?.message).toContain(quota)
  expect(presentation?.message).not.toContain('membership')
})
