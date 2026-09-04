import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub everything with side effects: attribution pulls in the DB, auth-service
// reads settings storage, config resolves the proxy URL from the environment.
const currentAttribution = vi.fn()
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { current: () => currentAttribution() },
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => 'platform-token',
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.example/v1',
}))
vi.mock('../config/settings', () => ({
  getSettings: () => ({}),
}))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))

import { PlatformLlmProvider, sanitizeAgentName } from './platform-provider'

const provider = new PlatformLlmProvider()

beforeEach(() => {
  currentAttribution.mockReturnValue(null)
})

describe('PlatformLlmProvider — tool search', () => {
  // The proxy expands the CLI's deferred tools for every model it serves.
  it('turns ENABLE_TOOL_SEARCH on', () => {
    expect(new PlatformLlmProvider().toolSearchEnv).toBe('true')
  })
})

describe('getContainerEnvVars agent identity', () => {
  it('injects agent id and name env vars when identity is provided', () => {
    const env = provider.getContainerEnvVars({ id: 'abc123', name: 'My Agent' })
    expect(env.SUPERAGENT_AGENT_ID).toBe('abc123')
    expect(env.SUPERAGENT_AGENT_NAME).toBe('My Agent')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('platform-token')
  })

  it('omits identity env vars when no identity is provided', () => {
    const env = provider.getContainerEnvVars()
    expect(env).not.toHaveProperty('SUPERAGENT_AGENT_ID')
    expect(env).not.toHaveProperty('SUPERAGENT_AGENT_NAME')
  })

  it('omits the name var when the name is missing or sanitizes to empty', () => {
    expect(provider.getContainerEnvVars({ id: 'abc123' })).not.toHaveProperty('SUPERAGENT_AGENT_NAME')
    expect(provider.getContainerEnvVars({ id: 'abc123', name: '\n\t ' })).not.toHaveProperty(
      'SUPERAGENT_AGENT_NAME'
    )
  })

  it('flattens control characters out of the name', () => {
    const env = provider.getContainerEnvVars({ id: 'abc123', name: 'Multi\nLine\tBot' })
    expect(env.SUPERAGENT_AGENT_NAME).toBe('Multi Line Bot')
  })
})

describe('presentationForTurnError', () => {
  const SPEND_CAP = 'A spend cap for this workspace was reached. It resets within 30 days.'
  const INSUFFICIENT = 'API Error: 402 insufficient balance — top up to continue.'

  it('returns warning markdown for a workspace spend cap', () => {
    const parsed = provider.presentationForTurnError(
      429,
      'A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.',
      'rate_limit',
    )
    expect(parsed).toEqual({
      severity: 'warning',
      icon: 'circle-dollar-sign',
      message:
        '**Spend Limit Reached:** A spend cap for this workspace was reached. It resets within 30 days. [Raise spend limit in the admin dashboard](/dashboard/organizations/{orgId}?tab=billing)',
    })
  })

  it('falls back to the generic banner for a non-spend 429', () => {
    const parsed = provider.presentationForTurnError(429, 'Rate limit exceeded. Slow down and retry shortly.', 'rate_limit')
    expect(parsed?.severity).toBe('error')
    expect(parsed?.message).toContain('**LLM Provider Error:**')
  })

  it('attaches a recognized class even when the SDK code is generic', () => {
    const parsed = provider.presentationForTurnError(429, SPEND_CAP, 'unknown')
    expect(parsed?.message).toContain('**Spend Limit Reached:**')
  })

  it('attaches the generic banner when the SDK code marks a provider error', () => {
    const parsed = provider.presentationForTurnError(500, 'Overloaded', 'server_error')
    expect(parsed?.message).toContain('**LLM Provider Error:**')
  })

  it('returns null for an unrecognized error with a non-provider SDK code', () => {
    expect(provider.presentationForTurnError(undefined, 'Output too long', 'max_output_tokens')).toBeNull()
    expect(provider.presentationForTurnError(undefined, 'Output too long', null)).toBeNull()
  })

  it('does not let a recognized class claim a max_output_tokens failure', () => {
    expect(provider.presentationForTurnError(undefined, SPEND_CAP, 'max_output_tokens')).toBeNull()
  })

  it('does not let a recognized class claim a turn that failed without an API error', () => {
    expect(provider.presentationForTurnError(undefined, INSUFFICIENT, null)).toBeNull()
    expect(provider.presentationForTurnError(undefined, INSUFFICIENT, undefined)).toBeNull()
  })
})

describe('sanitizeAgentName', () => {
  it('collapses runs of control chars and spaces to a single space', () => {
    expect(sanitizeAgentName('a\r\n\r\nb   c')).toBe('a b c')
  })

  it('caps at 200 code points without splitting surrogate pairs', () => {
    const out = sanitizeAgentName('\u{1F680}'.repeat(300))
    expect(out).toBe('\u{1F680}'.repeat(200))
  })
})
