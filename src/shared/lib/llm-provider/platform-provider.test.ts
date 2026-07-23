import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub everything with side effects: attribution pulls in the DB, auth-service
// reads settings storage, config resolves the proxy URL from the environment.
const currentAttribution = vi.fn()
const getPlatformProxyBaseUrl = vi.fn(() => 'https://proxy.example/v1')
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { current: () => currentAttribution() },
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => 'platform-token',
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => getPlatformProxyBaseUrl(),
}))
vi.mock('../config/settings', () => ({
  getSettings: () => ({}),
}))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))

import { PlatformLlmProvider, sanitizeAgentName } from './platform-provider'

const provider = new PlatformLlmProvider()

beforeEach(() => {
  currentAttribution.mockReturnValue(null)
  getPlatformProxyBaseUrl.mockReturnValue('https://proxy.example/v1')
})

describe('getContainerEnvVars agent identity', () => {
  const dockerHost = 'host.docker.internal'

  it('injects agent id and name env vars when identity is provided', () => {
    const env = provider.getContainerEnvVars({ id: 'abc123', name: 'My Agent' }, dockerHost)
    expect(env.SUPERAGENT_AGENT_ID).toBe('abc123')
    expect(env.SUPERAGENT_AGENT_NAME).toBe('My Agent')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('platform-token')
  })

  it('omits identity env vars when no identity is provided', () => {
    const env = provider.getContainerEnvVars(undefined, dockerHost)
    expect(env).not.toHaveProperty('SUPERAGENT_AGENT_ID')
    expect(env).not.toHaveProperty('SUPERAGENT_AGENT_NAME')
  })

  it('omits the name var when the name is missing or sanitizes to empty', () => {
    expect(provider.getContainerEnvVars({ id: 'abc123' }, dockerHost)).not.toHaveProperty(
      'SUPERAGENT_AGENT_NAME',
    )
    expect(
      provider.getContainerEnvVars({ id: 'abc123', name: '\n\t ' }, dockerHost),
    ).not.toHaveProperty('SUPERAGENT_AGENT_NAME')
  })

  it('flattens control characters out of the name', () => {
    const env = provider.getContainerEnvVars({ id: 'abc123', name: 'Multi\nLine\tBot' }, dockerHost)
    expect(env.SUPERAGENT_AGENT_NAME).toBe('Multi Line Bot')
  })

  // Rewrite edge cases: container-url.test.ts. Here: provider wiring only.
  it('rewrites a loopback platform proxy using the threaded host address', () => {
    getPlatformProxyBaseUrl.mockReturnValue('http://localhost:47891/v1')
    const env = provider.getContainerEnvVars({ id: 'abc123' }, '192.168.64.1')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://192.168.64.1:47891/v1')
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
