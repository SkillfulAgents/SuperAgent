import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionLlmProvider } from './claude-subscription-provider'
import { AnthropicLlmProvider } from './anthropic-provider'
import { CLAUDE_BARE_CATALOG } from './builtin-catalogs'
import { createLlmProvider } from './index'

afterEach(() => vi.unstubAllEnvs())

describe('Claude Subscription', () => {
  it('uses only the selected connection token and never host credentials', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'host-token')
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-key')
    const provider = createLlmProvider('claude-subscription', {
      apiKeys: { claudeSubscriptionToken: 'subscription-token' },
      env: { ANTHROPIC_API_KEY: 'stale-key' },
    })
    expect(await provider.getContainerEnvVars()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' })
    expect(provider.getApiKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
    expect(new ClaudeSubscriptionLlmProvider().getApiKeyStatus().isConfigured).toBe(false)
    expect(createLlmProvider('claude-subscription', { apiKeys: {}, env: {} }).getEffectiveApiKey()).toBeUndefined()
    expect(await new AnthropicLlmProvider({ apiKeys: { anthropicApiKey: 'direct-key' }, env: {} }).getContainerEnvVars()).toEqual({
      ANTHROPIC_API_KEY: 'direct-key', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
    })
  })

  it('shares the code-driven Claude catalog, rejects direct clients and does not claim token validation', async () => {
    const provider = new ClaudeSubscriptionLlmProvider()
    expect(provider.getBuiltinCatalog()).toBe(CLAUDE_BARE_CATALOG)
    expect(provider.supportsDirectApi).toBe(false)
    expect(() => provider.createClient()).toThrow('API-capable')
    expect(await provider.validateKey()).toMatchObject({ valid: false, error: expect.stringContaining('agent message') })
  })

  it('makes expired/revoked tokens actionable without mislabeling quota or permission errors', () => {
    const provider = new ClaudeSubscriptionLlmProvider()
    expect(provider.presentationForTurnError(401, 'Unauthorized', 'authentication_failed')?.message).toContain('claude setup-token')
    expect(provider.presentationForTurnError(undefined, 'OAuth token has expired', 'unknown')?.message).toContain('replace the token')
    expect(provider.presentationForTurnError(429, 'Quota exhausted', 'rate_limit')?.message).not.toContain('sign-in expired')
    expect(provider.presentationForTurnError(403, 'Model not permitted', 'unknown')).toBeNull()
  })
})
