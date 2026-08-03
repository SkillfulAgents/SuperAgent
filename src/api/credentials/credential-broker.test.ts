import { describe, expect, it, vi } from 'vitest'
import { CredentialBroker, normalizeCredentialContext } from './credential-broker'
import type { CredentialProvider, CredentialRequestScope, PairableCredentialProvider } from './types'

const scope: CredentialRequestScope = {
  agentSlug: 'agent-a',
  sessionId: 'session-a',
  toolUseId: 'tool-a',
}

function mockProvider(): CredentialProvider {
  return {
    id: 'test-provider',
    label: 'Test Passwords',
    list: vi.fn().mockResolvedValue({
      status: 'ready',
      items: [{
        providerKey: 'provider-secret-key',
        username: 'person@example.com',
        domain: 'example.com',
        title: 'Example',
      }],
    }),
    retrieve: vi.fn().mockResolvedValue({
      username: 'person@example.com',
      password: 'super-secret-password',
    }),
  }
}

describe('CredentialBroker', () => {
  it('does not query providers until one is durably configured', async () => {
    const provider = mockProvider()
    const broker = new CredentialBroker([provider])

    await expect(broker.suggest(scope, 'https://example.com/login', [])).resolves.toMatchObject({
      provider: 'none',
      providerLabel: 'Password manager',
      status: 'unconfigured',
      suggestions: [],
    })
    expect(provider.list).not.toHaveBeenCalled()
  })

  it('returns only metadata and an opaque short-lived selection id', async () => {
    const provider = mockProvider()
    const broker = new CredentialBroker([provider])

    const result = await broker.suggest(scope, 'https://example.com/login#fragment')

    expect(result).toMatchObject({
      provider: 'test-provider',
      origin: 'https://example.com',
      suggestions: [{ username: 'person@example.com', domain: 'example.com', title: 'Example' }],
    })
    expect(result.suggestions[0].id).not.toBe('provider-secret-key')
    expect(JSON.stringify(result)).not.toContain('super-secret-password')
    expect(provider.list).toHaveBeenCalledWith({
      url: 'https://example.com/login',
      origin: 'https://example.com',
    })
  })

  it('binds a selection to the exact agent, session, and tool request', async () => {
    const broker = new CredentialBroker([mockProvider()])
    const result = await broker.suggest(scope, 'https://example.com/login')

    await expect(broker.retrieve(
      { ...scope, sessionId: 'session-b' },
      result.suggestions[0].id,
      'https://example.com/login',
    )).rejects.toMatchObject({ code: 'selection_not_found' })
  })

  it('refuses retrieval after the active origin changes', async () => {
    const provider = mockProvider()
    const broker = new CredentialBroker([provider])
    const result = await broker.suggest(scope, 'https://example.com/login')

    await expect(broker.retrieve(
      scope,
      result.suggestions[0].id,
      'https://evil.example/login',
    )).rejects.toMatchObject({ code: 'origin_changed' })
    expect(provider.retrieve).not.toHaveBeenCalled()
  })

  it('expires selections and makes successful retrieval one-shot', async () => {
    let now = 100
    const provider = mockProvider()
    const broker = new CredentialBroker([provider], 50, () => now)
    const expired = await broker.suggest(scope, 'https://example.com/login')
    now = 151
    await expect(broker.retrieve(scope, expired.suggestions[0].id, 'https://example.com/login'))
      .rejects.toMatchObject({ code: 'selection_not_found' })

    const live = await broker.suggest(scope, 'https://example.com/login')
    await expect(broker.retrieve(scope, live.suggestions[0].id, 'https://example.com/login'))
      .resolves.toEqual({
        credential: { username: 'person@example.com', password: 'super-secret-password' },
        expectedOrigin: 'https://example.com',
      })
    await expect(broker.retrieve(scope, live.suggestions[0].id, 'https://example.com/login'))
      .rejects.toMatchObject({ code: 'selection_not_found' })
  })

  it('addresses connection setup by provider id', async () => {
    const provider: PairableCredentialProvider = {
      ...mockProvider(),
      connectionStatus: vi.fn().mockResolvedValue({
        provider: 'test-provider',
        providerLabel: 'Test Passwords',
        status: 'disconnected',
      }),
      beginPairing: vi.fn().mockResolvedValue({ status: 'pin_required' }),
      completePairing: vi.fn().mockResolvedValue(undefined),
    }
    const broker = new CredentialBroker([provider])

    expect(broker.hasProvider('test-provider')).toBe(true)
    expect(broker.hasProvider('missing-provider')).toBe(false)

    await expect(broker.connectionStatuses()).resolves.toEqual([{
      provider: 'test-provider',
      providerLabel: 'Test Passwords',
      status: 'disconnected',
    }])
    await expect(broker.beginPairing('test-provider')).resolves.toEqual({ status: 'pin_required' })
    await broker.completePairing('test-provider', '123456')
    expect(provider.completePairing).toHaveBeenCalledWith('123456')
  })

  it('shuts down managed providers and invalidates pending selections', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const provider = { ...mockProvider(), shutdown }
    const broker = new CredentialBroker([provider])
    const result = await broker.suggest(scope, 'https://example.com/login')

    await broker.shutdown()

    expect(shutdown).toHaveBeenCalledOnce()
    await expect(broker.retrieve(
      scope,
      result.suggestions[0].id,
      'https://example.com/login',
    )).rejects.toMatchObject({ code: 'selection_not_found' })
  })
})

describe('normalizeCredentialContext', () => {
  it('accepts only web URLs and strips fragments', () => {
    expect(normalizeCredentialContext('https://EXAMPLE.com/login#token')).toEqual({
      url: 'https://example.com/login',
      origin: 'https://example.com',
    })
    expect(() => normalizeCredentialContext('file:///tmp/login.html')).toThrow(/HTTP or HTTPS/)
  })
})
