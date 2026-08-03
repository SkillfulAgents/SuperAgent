import { describe, expect, it, vi } from 'vitest'
import { ApplePasswordsProvider } from './apple-passwords-provider'
import { ApplePasswordsRuntimeError, type ApplePasswordsRuntimeLike } from './apple-passwords-runtime'

const context = { url: 'https://example.com/login', origin: 'https://example.com' }

function runtime(overrides: Partial<ApplePasswordsRuntimeLike> = {}): ApplePasswordsRuntimeLike {
  return {
    state: vi.fn().mockResolvedValue({ state: 'SessionKeySet', nativeReady: true }),
    beginPairing: vi.fn().mockResolvedValue({ status: 'pin_required' }),
    completePairing: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ STATUS: 0, Entries: [] }),
    retrieve: vi.fn().mockResolvedValue({ STATUS: 0, Entries: [] }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('ApplePasswordsProvider', () => {
  it('reports connection state independently of a browser URL', async () => {
    await expect(new ApplePasswordsProvider(runtime()).connectionStatus()).resolves.toEqual({
      provider: 'apple-passwords',
      providerLabel: 'Apple Passwords',
      status: 'connected',
    })
    await expect(new ApplePasswordsProvider(runtime({
      state: vi.fn().mockResolvedValue({ state: 'NotInSession', nativeReady: true }),
    })).connectionStatus()).resolves.toMatchObject({
      provider: 'apple-passwords',
      status: 'disconnected',
    })
  })

  it('returns metadata without leaking a password from the list response', async () => {
    const backend = runtime({
      list: vi.fn().mockResolvedValue({
        STATUS: 0,
        Entries: [{
          USR: 'person@example.com',
          PWD: 'must-not-escape',
          sites: ['example.com'],
          customTitle: 'Example',
        }],
      }),
    })
    const result = await new ApplePasswordsProvider(backend).list(context)
    expect(result).toEqual({
      status: 'ready',
      items: [{
        providerKey: '0:person@example.com',
        username: 'person@example.com',
        domain: 'example.com',
        title: 'Example',
      }],
    })
    expect(JSON.stringify(result)).not.toContain('must-not-escape')
    expect(backend.list).toHaveBeenCalledWith('example.com')
  })

  it('reports an unpaired runtime as locked', async () => {
    const result = await new ApplePasswordsProvider(runtime({
      state: vi.fn().mockResolvedValue({ state: 'NotInSession', nativeReady: true }),
    })).list(context)
    expect(result).toMatchObject({ status: 'locked', items: [] })
  })

  it('reports a missing local extension as unavailable', async () => {
    const provider = new ApplePasswordsProvider(runtime({
      state: vi.fn().mockRejectedValue(
        new ApplePasswordsRuntimeError('extension_not_found', 'Install the extension'),
      ),
    }))
    await expect(provider.list(context)).resolves.toEqual({
      status: 'unavailable',
      message: 'Install the extension',
      items: [],
    })
    await expect(provider.connectionStatus()).resolves.toMatchObject({
      status: 'unavailable',
      remediation: {
        code: 'extension_not_found',
        action: {
          kind: 'open_in_chrome',
          label: 'Install in Chrome',
        },
      },
    })
  })

  it('retrieves a password only on demand', async () => {
    const backend = runtime({
      retrieve: vi.fn().mockResolvedValue({
        STATUS: 0,
        Entry_0: { USR: 'person@example.com', PWD: 's3cret', sites: ['example.com'] },
      }),
    })
    await expect(new ApplePasswordsProvider(backend).retrieve(context, {
      providerKey: 'opaque', username: 'person@example.com', domain: 'example.com',
    })).resolves.toEqual({ username: 'person@example.com', password: 's3cret' })
    expect(backend.retrieve).toHaveBeenCalledWith('example.com', 'person@example.com')
  })

  it('delegates first-use pairing without exposing the PIN', async () => {
    const backend = runtime()
    const provider = new ApplePasswordsProvider(backend)
    await expect(provider.beginPairing()).resolves.toEqual({ status: 'pin_required' })
    await provider.completePairing('123456')
    expect(backend.completePairing).toHaveBeenCalledWith('123456')
  })

  it('shuts down its managed runtime', async () => {
    const backend = runtime()
    await new ApplePasswordsProvider(backend).shutdown()
    expect(backend.shutdown).toHaveBeenCalledOnce()
  })
})
