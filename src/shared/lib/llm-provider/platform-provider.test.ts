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

describe('sanitizeAgentName', () => {
  it('collapses runs of control chars and spaces to a single space', () => {
    expect(sanitizeAgentName('a\r\n\r\nb   c')).toBe('a b c')
  })

  it('caps at 200 code points without splitting surrogate pairs', () => {
    const out = sanitizeAgentName('\u{1F680}'.repeat(300))
    expect(out).toBe('\u{1F680}'.repeat(200))
  })
})
