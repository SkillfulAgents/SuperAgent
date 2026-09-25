import { describe, expect, it, vi } from 'vitest'
import { CODEX_BASE_URL, CodexSubscriptionLlmProvider } from './codex-subscription-provider'

describe('Codex subscription provider', () => {
  it('sends only the selected account access credential to the agent proxy', async () => {
    const credential = { accessToken: 'access', refreshToken: 'private-refresh', accountId: 'account', expiresAt: Date.now() + 100000, generation: 8 }
    const provider = new CodexSubscriptionLlmProvider({ apiKeys: {}, env: {}, oauth: credential, resolveCredential: vi.fn().mockResolvedValue(credential) })
    const runtime = await provider.getContainerProxyConfig()
    expect(runtime).toMatchObject({ adapter: 'codex', format: 'responses', credential: { accessToken: 'access', accountId: 'account', generation: 8 } })
    expect(JSON.stringify(runtime)).not.toContain('private-refresh')
    expect(await provider.getContainerEnvVars()).toEqual({})
    expect(new CodexSubscriptionLlmProvider().getApiKeyStatus().isConfigured).toBe(false)
  })
  it('tells the agent to call the real image endpoints with the session credential', () => {
    const prompt = new CodexSubscriptionLlmProvider().mediaPrompt
    expect(prompt).toContain('"/llm-runtime/resolve"')
    expect(prompt).toContain(`${CODEX_BASE_URL}/images/generations`)
    expect(prompt).toContain(`${CODEX_BASE_URL}/images/edits`)
    expect(prompt).toContain('originator: codex_cli_rs')
  })
  it('uses code-driven subscription models and directs helpers to a separate API provider', () => {
    const provider = new CodexSubscriptionLlmProvider()
    expect(provider.supportsDirectApi).toBe(false)
    expect(() => provider.createClient()).toThrow('API-capable global summarizer')
    const models = provider.getBuiltinCatalog()
    expect(models.find(model => model.isLatest)?.id).toBe('gpt-5.6-sol')
    expect(models.every(model => model.contextWindow === 272000)).toBe(true)
    for (const model of models) expect(model.supportedSpeeds).toEqual(['normal', 'fast'])
    expect(models.some(model => model.id === 'codex-auto-review')).toBe(false)
  })
  it('offers discovered fast mode only when the subscription model advertises it', async () => {
    const credential = { accessToken: 'access', accountId: 'account', expiresAt: Date.now() + 100000, generation: 1 }
    const provider = new CodexSubscriptionLlmProvider({ apiKeys: {}, env: {}, resolveCredential: vi.fn().mockResolvedValue(credential) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ models: [
      { slug: 'fast-model', visibility: 'list', additional_speed_tiers: ['fast'] },
      { slug: 'priority-model', visibility: 'list', service_tiers: [{ id: 'priority' }] },
      { slug: 'standard-model', visibility: 'list' },
      { slug: 'hidden-model', visibility: 'hide', additional_speed_tiers: ['fast'] },
    ] })))
    try {
      const models = await provider.searchModels('')
      expect(models.map(model => [model.id, model.supportedSpeeds])).toEqual([
        ['fast-model', ['normal', 'fast']], ['priority-model', ['normal', 'fast']], ['standard-model', undefined],
      ])
    } finally { fetchSpy.mockRestore() }
  })
  it('distinguishes authentication, entitlement and rate limits without matching token budgets', () => {
    const provider = new CodexSubscriptionLlmProvider()
    expect(provider.presentationForTurnError(undefined, 'Invalid credential', 'authentication_failed')?.message).toContain('Reconnect in Settings')
    expect(provider.presentationForTurnError(undefined, 'API Error: 401', 'unknown')?.message).toContain('Reconnect')
    expect(provider.presentationForTurnError(403, 'Denied', 'unknown')?.message).toContain('access was denied')
    expect(provider.presentationForTurnError(429, 'Limit', 'unknown')?.message).toContain('rate or subscription limit')
    expect(provider.presentationForTurnError(400, 'max_tokens invalid', 'invalid_request')?.message).not.toContain('Reconnect')
  })
})
