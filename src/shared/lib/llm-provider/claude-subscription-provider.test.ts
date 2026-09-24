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

  it.each<[number | undefined, unknown]>([
    [401, 'Unauthorized'],
    [undefined, 'API Error: 401 Invalid token'],
    [undefined, { error: { type: 'authentication_error', message: 'Unauthorized' } }],
    [undefined, { type: 'authentication_error', message: 'Unauthorized' }],
    [undefined, 'authentication_error: Unauthorized'],
    [undefined, 'OAuth token has expired'],
    [undefined, 'Access token has been revoked'],
    [undefined, 'Expired OAuth token'],
  ])('makes authentication failures actionable (%s, %j)', (status, body) => {
    const provider = new ClaudeSubscriptionLlmProvider()
    expect(provider.presentationForTurnError(status, body, 'unknown')?.message).toContain('claude setup-token')
  })

  it('uses the SDK authentication code when no status or recognizable text is supplied', () => {
    const provider = new ClaudeSubscriptionLlmProvider()
    expect(provider.presentationForTurnError(undefined, 'Invalid credential', 'authentication_failed')?.message).toContain('claude setup-token')
    expect(provider.presentationForTurnError(undefined, 'Invalid value for max_tokens', 'invalid_request')?.message).not.toContain('claude setup-token')
  })

  it.each<[number | undefined, unknown]>([
    [400, 'Invalid value for max_tokens'],
    [400, { error: { type: 'invalid_request_error', message: 'budget_tokens: invalid value' } }],
    [400, 'Invalid token budget'],
    [400, 'max_tokens exceeds the limit; this value is invalid'],
    [429, 'Quota exhausted'],
    [403, 'Model not permitted'],
  ])('does not mislabel ordinary errors as expired credentials (%s, %j)', (status, body) => {
    const provider = new ClaudeSubscriptionLlmProvider()
    expect(provider.presentationForTurnError(status, body, 'unknown')).toBeNull()
  })
})
