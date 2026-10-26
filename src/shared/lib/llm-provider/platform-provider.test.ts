import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub everything with side effects: attribution pulls in the DB, auth-service
// reads settings storage, config resolves the proxy URL from the environment.
const currentAttribution = vi.fn()
const platformAuthStatus = vi.fn()
const platformAccessToken = vi.fn((): string | null => 'platform-token')
const fetchActingAccount = vi.fn()
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: {
    current: () => currentAttribution(),
  },
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => platformAccessToken(),
  getPlatformAppKey: () => platformAccessToken() ?? undefined,
  getPlatformAuthStatus: () => platformAuthStatus(),
  getStoredPlatformMemberId: () => null,
  fetchActingPlatformAccount: () => fetchActingAccount(),
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.example/v1',
  getPlatformBaseUrl: () => 'https://platform.example.com',
}))
vi.mock('../config/settings', () => ({
  getSettings: () => ({}),
}))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))
const containerToken = vi.fn()
vi.mock('../platform-attribution/container-token', () => ({
  getPlatformContainerToken: (agentId?: string) => containerToken(agentId),
}))

import { PlatformLlmProvider, sanitizeAgentName } from './platform-provider'
import { platformPlanCache } from './platform-plan-cache'

const provider = new PlatformLlmProvider()

beforeEach(() => {
  currentAttribution.mockReset().mockReturnValue(null)
  platformAccessToken.mockReset().mockReturnValue('platform-token')
  platformAuthStatus.mockReturnValue({ connected: true, orgId: 'org_123' })
  fetchActingAccount.mockReset()
  containerToken.mockReset().mockResolvedValue('plat_ag_agent')
  platformPlanCache.clear()
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

  const account = (memberId: string, policy: { plan?: { id: string; name: string } | null; deniedModels?: string[] | null }) => ({
    memberId, orgId: 'org_123', userId: `user_${memberId}`, orgName: null, orgIconUrl: null, role: null, email: null,
    plan: policy.plan ?? null, deniedModels: policy.deniedModels ?? null,
  })
  const PRO_30 = { plan: { id: 'pro-30', name: 'Pro 30' }, deniedModels: ['claude-fable-'] }
  const actAs = (memberId: string) => currentAttribution.mockReturnValue({ actingMemberId: () => memberId })

  it('reads the acting account\'s policy with its identity once, and words it', async () => {
    actAs('member_a')
    fetchActingAccount.mockResolvedValue(account('member_a', PRO_30))
    expect(await provider.getModelAvailability(catalog)).toMatchObject({
      unavailable: expect.arrayContaining([{ modelId: fable.id, reason: "Fable 5.1 isn't included in your Pro 30 plan." }]),
      summary: 'Pro 30 excludes Claude Fable.',
      action: { component: 'platform-plan-upgrade', label: 'Upgrade', href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing' },
    })
    // Cached: the next selection does not wait on the platform.
    await provider.getModelAvailability(catalog)
    expect(fetchActingAccount).toHaveBeenCalledTimes(1)
  })

  it('keeps one policy per account, so seats in one workspace can differ', async () => {
    actAs('member_a')
    fetchActingAccount.mockResolvedValueOnce(account('member_a', PRO_30))
    expect(await provider.getModelAvailability(catalog)).not.toBeNull()
    actAs('member_b')
    fetchActingAccount.mockResolvedValueOnce(account('member_b', { plan: { id: 'pro-200', name: 'Pro 200' }, deniedModels: [] }))
    expect(await provider.getModelAvailability(catalog)).toBeNull()
    actAs('member_a')
    expect(await provider.getModelAvailability(catalog)).not.toBeNull()
    expect(fetchActingAccount).toHaveBeenCalledTimes(2)
  })

  it('leaves an account unrestricted when the proxy does not say (an older proxy, or billing unreachable)', async () => {
    actAs('member_a')
    fetchActingAccount.mockResolvedValue(account('member_a', {}))
    expect(await provider.getModelAvailability(catalog)).toBeNull()
    fetchActingAccount.mockRejectedValue(new Error('offline'))
    platformPlanCache.clear()
    expect(await provider.getModelAvailability(catalog)).toBeNull()
  })

  it('re-reads the account when asked for a fresh answer (after an upgrade)', async () => {
    actAs('member_a')
    fetchActingAccount.mockResolvedValueOnce(account('member_a', PRO_30))
    expect(await provider.getModelAvailability(catalog)).not.toBeNull()
    fetchActingAccount.mockResolvedValueOnce(account('member_a', { plan: { id: 'pro-200', name: 'Pro 200' }, deniedModels: [] }))
    expect(await provider.getModelAvailability(catalog, { fresh: true })).toBeNull()
  })

  it('forgets every policy when a turn is refused for the plan, and only then', async () => {
    actAs('member_a')
    fetchActingAccount.mockResolvedValue(account('member_a', PRO_30))
    await provider.getModelAvailability(catalog)
    provider.noteTurnError(429, 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}')
    await provider.getModelAvailability(catalog)
    expect(fetchActingAccount).toHaveBeenCalledTimes(1)
    provider.noteTurnError(403, 'API Error: 403 {"type":"error","error":{"type":"model_not_in_plan","message":"no","model":"claude-fable-5-1"}}')
    await provider.getModelAvailability(catalog)
    expect(fetchActingAccount).toHaveBeenCalledTimes(2)
  })

  it('drops restrictions on disconnect', async () => {
    platformAuthStatus.mockReturnValue({ connected: false })
    expect(await provider.getModelAvailability(catalog)).toBeNull()
    expect(fetchActingAccount).not.toHaveBeenCalled()
  })
})

describe('getContainerEnvVars auth token', () => {
  it("bakes the agent's limited key", async () => {
    const env = await provider.getContainerEnvVars({ id: 'abc123', name: 'My Agent' })
    expect(containerToken).toHaveBeenCalledWith('abc123')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('plat_ag_agent')
  })

  it("never falls back to the app's own key", async () => {
    containerToken.mockResolvedValue(undefined)
    expect((await provider.getContainerEnvVars({ id: 'abc123' })).ANTHROPIC_AUTH_TOKEN).toBeUndefined()
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
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('plat_ag_agent')
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
