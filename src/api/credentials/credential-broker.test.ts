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
      installable: false,
      suggestions: [],
    })
    expect(provider.list).not.toHaveBeenCalled()
  })

  it('advertises configuration only when the host has an installable provider', async () => {
    const provider: PairableCredentialProvider = {
      ...mockProvider(),
      connectionStatus: vi.fn().mockResolvedValue({
        provider: 'test-provider',
        providerLabel: 'Test Passwords',
        installable: true,
        status: 'disconnected',
      }),
      beginPairing: vi.fn().mockResolvedValue({ status: 'pin_required' }),
      completePairing: vi.fn().mockResolvedValue(undefined),
    }

    await expect(new CredentialBroker([provider]).suggest(
      scope,
      'https://example.com/login',
      [],
    )).resolves.toMatchObject({ status: 'unconfigured', installable: true })
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
        installable: true,
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
      installable: true,
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

describe('CredentialBroker search and provider lifecycle', () => {
  it('registers the 1Password provider', () => {
    expect(new CredentialBroker().hasProvider('onepassword')).toBe(true)
  })

  it('search minting replaces only prior search selections for the scope', async () => {
    const provider = {
      ...mockProvider(),
      search: vi.fn()
        .mockResolvedValueOnce([{ providerKey: 'search-1', title: 'First' }])
        .mockResolvedValueOnce([{ providerKey: 'search-2', title: 'Second' }]),
    }
    const broker = new CredentialBroker([provider])
    const listed = await broker.suggest(scope, 'https://example.com/login', ['test-provider'])
    const firstSearch = await broker.suggest(scope, 'https://example.com/login', ['test-provider'], 'git')
    const secondSearch = await broker.suggest(scope, 'https://example.com/login', ['test-provider'], 'hub')

    await expect(broker.retrieve(scope, listed.suggestions[0].id, 'https://example.com/login'))
      .resolves.toMatchObject({ expectedOrigin: 'https://example.com' })
    await expect(broker.retrieve(scope, firstSearch.suggestions[0].id, 'https://example.com/login'))
      .rejects.toMatchObject({ code: 'selection_not_found' })
    await expect(broker.retrieve(scope, secondSearch.suggestions[0].id, 'https://example.com/login'))
      .resolves.toMatchObject({ expectedOrigin: 'https://example.com' })
  })

  it('a no-query suggest keeps live search selections for the scope', async () => {
    const provider = {
      ...mockProvider(),
      search: vi.fn().mockResolvedValue([{ providerKey: 'search-1', title: 'GitHub' }]),
    }
    const broker = new CredentialBroker([provider])
    const searched = await broker.suggest(scope, 'https://example.com/login', ['test-provider'], 'git')
    await broker.suggest(scope, 'https://example.com/login', ['test-provider'])
    await expect(broker.retrieve(scope, searched.suggestions[0].id, 'https://example.com/login'))
      .resolves.toMatchObject({ expectedOrigin: 'https://example.com' })
  })

  it('query against a non-searchable provider throws provider_error, never falls back to list', async () => {
    const provider = mockProvider()
    const broker = new CredentialBroker([provider])
    await expect(broker.suggest(scope, 'https://example.com/login', ['test-provider'], 'git'))
      .rejects.toMatchObject({ code: 'provider_error' })
    expect(provider.list).not.toHaveBeenCalled()
  })

  it('passes warming and searchable through the response', async () => {
    const provider = {
      ...mockProvider(),
      id: 'onepassword',
      label: '1Password',
      isWarming: () => true,
      list: vi.fn().mockResolvedValue({ status: 'warming', items: [] }),
      search: vi.fn().mockResolvedValue([]),
    }
    const broker = new CredentialBroker([provider])
    expect(broker.warmingProviderId(['onepassword'])).toBe('onepassword')
    expect(broker.warmingProviderId([])).toBeNull()
    expect(broker.providerLabel('onepassword')).toBe('1Password')
    expect(broker.providerLabel('missing')).toBe('Password manager')
    await expect(broker.suggest(scope, 'https://example.com/login', ['onepassword'])).resolves.toMatchObject({
      status: 'warming',
      searchable: true,
    })
    await expect(broker.suggest(scope, 'https://example.com/login', [])).resolves.toMatchObject({
      searchable: false,
    })
  })

  it('retrieve refuses a selection whose provider is no longer configured', async () => {
    const broker = new CredentialBroker([mockProvider()])
    const result = await broker.suggest(scope, 'https://example.com/login', ['test-provider'])
    await expect(broker.retrieve(scope, result.suggestions[0].id, 'https://example.com/login', []))
      .rejects.toMatchObject({ code: 'selection_not_found' })
  })

  it('shutdown(id) clears only that provider selections and shuts only it down', async () => {
    const first = { ...mockProvider(), id: 'apple-passwords', shutdown: vi.fn().mockResolvedValue(undefined) }
    const second = { ...mockProvider(), id: 'onepassword', shutdown: vi.fn().mockResolvedValue(undefined) }
    const broker = new CredentialBroker([first, second])
    const apple = await broker.suggest(scope, 'https://example.com/login', ['apple-passwords'])
    const otherScope = { ...scope, toolUseId: 'tool-b' }
    const one = await broker.suggest(otherScope, 'https://example.com/login', ['onepassword'])

    await broker.shutdown('onepassword')

    expect(second.shutdown).toHaveBeenCalledOnce()
    expect(first.shutdown).not.toHaveBeenCalled()
    await expect(broker.retrieve(otherScope, one.suggestions[0].id, 'https://example.com/login'))
      .rejects.toMatchObject({ code: 'selection_not_found' })
    await expect(broker.retrieve(scope, apple.suggestions[0].id, 'https://example.com/login'))
      .resolves.toMatchObject({ expectedOrigin: 'https://example.com' })
  })

  it('does not mint suggestions from a list that finishes after shutdown', async () => {
    let release!: (result: { status: 'ready'; items: Array<{ providerKey: string; username: string }> }) => void
    const provider = {
      ...mockProvider(),
      list: vi.fn().mockReturnValue(new Promise((resolve) => {
        release = resolve
      })),
    }
    const broker = new CredentialBroker([provider])
    const pending = broker.suggest(scope, 'https://example.com/login', ['test-provider'])
    await broker.shutdown()
    release({
      status: 'ready',
      items: [{ providerKey: 'late', username: 'late@x.com' }],
    })
    await expect(pending).resolves.toMatchObject({ suggestions: [] })
  })

  it('shutdown() keeps app-wide behavior', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const provider = { ...mockProvider(), shutdown }
    const broker = new CredentialBroker([provider])
    const result = await broker.suggest(scope, 'https://example.com/login')
    await broker.shutdown()
    expect(shutdown).toHaveBeenCalledOnce()
    await expect(broker.retrieve(scope, result.suggestions[0].id, 'https://example.com/login'))
      .rejects.toMatchObject({ code: 'selection_not_found' })
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
