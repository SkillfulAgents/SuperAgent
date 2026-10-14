import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub everything with side effects: attribution pulls in the DB, auth-service
// reads settings storage, config resolves the proxy URL from the environment.
const currentAttribution = vi.fn()
const forAgentAttribution = vi.fn()
const requiresActingMember = vi.fn(() => false)
const captureMessage = vi.fn()
const platformAuthStatus = vi.fn()
const platformAccessToken = vi.fn((): string | null => 'platform-token')
const refreshBilling = vi.fn()
const getCachedBilling = vi.fn()
vi.mock('../services/platform-service', () => ({
  platformService: { refreshBilling: (...args: unknown[]) => refreshBilling(...args), getCachedBilling: () => getCachedBilling() },
}))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: {
    current: () => currentAttribution(),
    forAgent: (slug: string) => forAgentAttribution(slug),
    requiresActingMember: () => requiresActingMember(),
  },
}))
vi.mock('@shared/lib/error-reporting', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => platformAccessToken(),
  getPlatformAuthStatus: () => platformAuthStatus(),
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.example/v1',
  getPlatformBaseUrl: () => 'https://platform.example.com',
}))
vi.mock('../config/settings', () => ({
  getSettings: () => ({}),
}))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))

import { PlatformLlmProvider, sanitizeAgentName } from './platform-provider'
import { getPlatformContainerToken } from '../platform-attribution/container-token'

const provider = new PlatformLlmProvider()

beforeEach(() => {
  currentAttribution.mockReset().mockReturnValue(null)
  forAgentAttribution.mockReset().mockReturnValue(null)
  requiresActingMember.mockReset().mockReturnValue(false)
  captureMessage.mockReset()
  platformAccessToken.mockReset().mockReturnValue('platform-token')
  platformAuthStatus.mockReturnValue({ connected: true, orgId: 'org_123' })
  refreshBilling.mockReset()
  getCachedBilling.mockReset().mockReturnValue(null)
})

describe('getModelAvailability', () => {
  const catalog = provider.getBuiltinCatalog()
  const fable = catalog.find(model => model.id === 'claude-fable-5-1')!

  it('scopes the public cache revision without exposing the account identity', () => {
    expect(provider.getModelAvailabilityRevision()).toMatch(/^[a-f0-9]{64}$/)
    expect(provider.getModelAvailabilityRevision()).not.toContain('org_123')
    platformAuthStatus.mockReturnValue({ connected: false })
    expect(provider.getModelAvailabilityRevision()).toBeNull()
  })

  it('maps platform plan prefixes to concrete connection models, worded by the platform', async () => {
    refreshBilling.mockResolvedValue({ plan: { name: 'Pro 30', deniedModels: ['claude-fable-'] }, deniedModels: ['claude-fable-'] })
    expect(await provider.getModelAvailability(catalog)).toMatchObject({
      unavailable: expect.arrayContaining([{ modelId: fable.id, reason: "Fable 5.1 isn't included in your Pro 30 plan." }]),
      summary: 'Pro 30 excludes Claude Fable.',
      action: { component: 'platform-plan-upgrade', label: 'Upgrade', href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing' },
    })
  })

  it('leaves older billing responses without plan restrictions unrestricted', async () => {
    refreshBilling.mockResolvedValue({ subscription: {}, seat: null })
    expect(await provider.getModelAvailability(catalog)).toBeNull()
  })

  it('drops restrictions on disconnect and uses a cached snapshot on a transient failure', async () => {
    refreshBilling.mockRejectedValue(new Error('offline'))
    getCachedBilling.mockReturnValue({ plan: { name: 'Pro 30', deniedModels: ['claude-fable-'] } })
    expect((await provider.getModelAvailability(catalog))?.unavailable.map(entry => entry.modelId)).toContain(fable.id)
    platformAuthStatus.mockReturnValue({ connected: false })
    expect(await provider.getModelAvailability(catalog)).toBeNull()
  })
})

describe('getContainerEnvVars auth token (cold start)', () => {
  it('does not carry an ambient token into a disconnected container', async () => {
    platformAccessToken.mockReturnValue(null)
    currentAttribution.mockReturnValue({ bearerToken: () => 'old-token::member' })
    expect(await getPlatformContainerToken('abc123')).toBeUndefined()
    expect(forAgentAttribution).not.toHaveBeenCalled()
    expect(currentAttribution).not.toHaveBeenCalled()
  })

  it('bakes the agent-resolved attribution token when an identity is provided', async () => {
    forAgentAttribution.mockReturnValue({ bearerToken: () => 'org-jwt::sub_owner' })
    const env = (await provider.getContainerEnvVars({ id: 'abc123', name: 'My Agent' }))
    expect(forAgentAttribution).toHaveBeenCalledWith('abc123')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('org-jwt::sub_owner')
  })

  it('uses the ambient attribution when no identity is provided', async () => {
    currentAttribution.mockReturnValue({ bearerToken: () => 'org-jwt::sub_ambient' })
    expect((await provider.getContainerEnvVars()).ANTHROPIC_AUTH_TOKEN).toBe('org-jwt::sub_ambient')
    expect(forAgentAttribution).not.toHaveBeenCalled()
  })

  it('reports and falls back to the bare token when an org JWT resolves no member', async () => {
    requiresActingMember.mockReturnValue(true)
    const env = (await provider.getContainerEnvVars({ id: 'abc123' }))
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('platform-token')
    expect(captureMessage).toHaveBeenCalledWith(
      'platform container env built without acting member',
      expect.objectContaining({ tags: { area: 'platform-attribution', op: 'container.env.no_member' } }),
    )
  })

  it('does not report the fallback for an opaque access key', async () => {
    requiresActingMember.mockReturnValue(false)
    expect((await provider.getContainerEnvVars({ id: 'abc123' })).ANTHROPIC_AUTH_TOKEN).toBe('platform-token')
    expect(captureMessage).not.toHaveBeenCalled()
  })
})

describe('PlatformLlmProvider — tool search', () => {
  // The proxy expands the CLI's deferred tools for every model it serves.
  it('turns ENABLE_TOOL_SEARCH on', async () => {
    expect(new PlatformLlmProvider().toolSearchEnv).toBe('true')
  })
})

describe('getContainerEnvVars agent identity', () => {
  it('injects agent id and name env vars when identity is provided', async () => {
    const env = (await provider.getContainerEnvVars({ id: 'abc123', name: 'My Agent' }))
    expect(env.SUPERAGENT_AGENT_ID).toBe('abc123')
    expect(env.SUPERAGENT_AGENT_NAME).toBe('My Agent')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('platform-token')
  })

  it('omits identity env vars when no identity is provided', async () => {
    const env = (await provider.getContainerEnvVars())
    expect(env).not.toHaveProperty('SUPERAGENT_AGENT_ID')
    expect(env).not.toHaveProperty('SUPERAGENT_AGENT_NAME')
  })

  it('omits the name var when the name is missing or sanitizes to empty', async () => {
    expect((await provider.getContainerEnvVars({ id: 'abc123' }))).not.toHaveProperty('SUPERAGENT_AGENT_NAME')
    expect((await provider.getContainerEnvVars({ id: 'abc123', name: '\n\t ' }))).not.toHaveProperty(
      'SUPERAGENT_AGENT_NAME'
    )
  })

  it('flattens control characters out of the name', async () => {
    const env = (await provider.getContainerEnvVars({ id: 'abc123', name: 'Multi\nLine\tBot' }))
    expect(env.SUPERAGENT_AGENT_NAME).toBe('Multi Line Bot')
  })
})

describe('presentationForTurnError', () => {
  const SPEND_CAP = 'A spend cap for this workspace was reached. It resets within 30 days.'
  const INSUFFICIENT = 'API Error: 402 insufficient balance — top up to continue.'

  it('returns warning markdown for a workspace spend cap, linking the connected org billing page', async () => {
    const parsed = provider.presentationForTurnError(
      429,
      'A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.',
      'rate_limit',
    )
    expect(parsed).toEqual({
      severity: 'warning',
      icon: 'circle-dollar-sign',
      message:
        '**Spend Limit Reached:** A spend cap for this workspace was reached. It resets within 30 days. [Raise spend limit in the admin dashboard](https://platform.example.com/dashboard/organizations/org_123?tab=billing)',
    })
  })

  it('drops the billing link and paywall href when the platform is disconnected', async () => {
    platformAuthStatus.mockReturnValue({ connected: false, orgId: null })
    expect(provider.presentationForTurnError(429, SPEND_CAP, 'rate_limit')?.message).not.toContain('](')
    expect(provider.presentationForTurnError(402, INSUFFICIENT, 'unknown')).not.toHaveProperty('href')
  })

  it('attaches the org billing page as the paywall href', async () => {
    expect(provider.presentationForTurnError(402, INSUFFICIENT, 'unknown')?.href).toBe(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
    )
  })

  it('falls back to the generic banner for a non-spend 429', async () => {
    const parsed = provider.presentationForTurnError(429, 'Rate limit exceeded. Slow down and retry shortly.', 'rate_limit')
    expect(parsed?.severity).toBe('error')
    expect(parsed?.message).toContain('**LLM Provider Error:**')
  })

  it('attaches a recognized class even when the SDK code is generic', async () => {
    const parsed = provider.presentationForTurnError(429, SPEND_CAP, 'unknown')
    expect(parsed?.message).toContain('**Spend Limit Reached:**')
  })

  it('attaches the generic banner when the SDK code marks a provider error', async () => {
    const parsed = provider.presentationForTurnError(500, 'Overloaded', 'server_error')
    expect(parsed?.message).toContain('**LLM Provider Error:**')
  })

  it('returns null for an unrecognized error with a non-provider SDK code', async () => {
    expect(provider.presentationForTurnError(undefined, 'Output too long', 'max_output_tokens')).toBeNull()
    expect(provider.presentationForTurnError(undefined, 'Output too long', null)).toBeNull()
  })

  it('does not let a recognized class claim a max_output_tokens failure', async () => {
    expect(provider.presentationForTurnError(undefined, SPEND_CAP, 'max_output_tokens')).toBeNull()
  })

  it('does not let a recognized class claim a turn that failed without an API error', async () => {
    expect(provider.presentationForTurnError(undefined, INSUFFICIENT, null)).toBeNull()
    expect(provider.presentationForTurnError(undefined, INSUFFICIENT, undefined)).toBeNull()
  })

  describe('403 model_not_in_plan (SUP-1143)', () => {
    const NOT_IN_PLAN = 'API Error: 403 {"type":"error","error":{"type":"model_not_in_plan","message":"claude-fable-5-1 is not included in your workspace\'s plan. Upgrade your plan to use it.","model":"claude-fable-5-1"}} · Please run /login'

    it('names the model and routes to the upgrade card, not a credential or generic error', async () => {
      // The CLI may tag a 403 as an auth failure; the plan refusal still wins.
      const parsed = provider.presentationForTurnError(403, NOT_IN_PLAN, 'authentication_failed')
      expect(parsed).toEqual({
        severity: 'warning',
        icon: 'lock',
        message: "**Fable 5.1 isn't included in your plan** Upgrade your workspace's plan to use it, or continue with a model your plan includes.",
        chatText: "⚠️ Fable 5.1 isn't included in your workspace's plan. Upgrade the plan, or pick another model for this integration.",
        component: 'platform-model-not-in-plan',
        placement: 'composer',
        model: { id: 'claude-fable-5-1', label: 'Fable 5.1' },
        href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
      })
    })

    it('recognizes a history row, which carries no status', async () => {
      expect(provider.presentationForTurnError(undefined, NOT_IN_PLAN, 'unknown')?.component).toBe('platform-model-not-in-plan')
    })

    it('still names no model when the body omits it', async () => {
      const parsed = provider.presentationForTurnError(403, 'API Error: 403 {"type":"error","error":{"type":"model_not_in_plan","message":"Not in plan."}}', 'unknown')
      expect(parsed?.message).toMatch(/^\*\*This model isn't included in your plan\*\*/)
      expect(parsed?.model).toBeUndefined()
    })

    it('leaves other 403s to the generic banner', async () => {
      const parsed = provider.presentationForTurnError(403, 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Forbidden"}}', 'authentication_failed')
      expect(parsed?.component).toBeUndefined()
      expect(parsed?.message).toContain('**LLM Provider Error:**')
    })
  })
})

describe('sanitizeAgentName', () => {
  it('collapses runs of control chars and spaces to a single space', async () => {
    expect(sanitizeAgentName('a\r\n\r\nb   c')).toBe('a b c')
  })

  it('caps at 200 code points without splitting surrogate pairs', async () => {
    const out = sanitizeAgentName('\u{1F680}'.repeat(300))
    expect(out).toBe('\u{1F680}'.repeat(200))
  })
})
