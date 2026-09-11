import { describe, expect, it, vi } from 'vitest'
import { OpError } from '@shared/lib/onepassword/op-client'
import { OnePasswordProvider, type OnePasswordRuntimeLike } from './onepassword-provider'
import type { OnePasswordRuntimeState, RuntimeCandidate, RuntimeSearchHit } from './onepassword-runtime'

const context = { url: 'https://mail.corp.com/login', origin: 'https://mail.corp.com' }

const candidate: RuntimeCandidate = {
  itemId: 'ACC1:item1',
  title: 'Mail',
  username: 'a@x.com',
  host: 'mail.corp.com',
  confidence: 'exact',
  providerKey: 'ACC1:item1',
}

function runtime(overrides: Partial<OnePasswordRuntimeLike> = {}): OnePasswordRuntimeLike {
  return {
    prerequisites: vi.fn().mockReturnValue({ opInstalled: true, appInstalled: true }),
    state: vi.fn().mockReturnValue({ state: 'none' } satisfies OnePasswordRuntimeState),
    isWarming: vi.fn().mockReturnValue(false),
    connect: vi.fn().mockResolvedValue(undefined),
    listCandidates: vi.fn().mockReturnValue([candidate]),
    searchItems: vi.fn().mockReturnValue([]),
    retrieve: vi.fn().mockResolvedValue({ username: 'a@x.com', password: 's3cret' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('OnePasswordProvider', () => {
  it('reports missing prerequisites as unavailable with only the missing steps', async () => {
    const backend = runtime({
      prerequisites: vi.fn().mockReturnValue({ opInstalled: false, appInstalled: false }),
    })
    const provider = new OnePasswordProvider(backend)
    await expect(provider.list(context)).resolves.toMatchObject({ status: 'unavailable', items: [] })
    await expect(provider.connectionStatus()).resolves.toMatchObject({
      provider: 'onepassword',
      providerLabel: '1Password',
      status: 'unavailable',
      installable: process.platform === 'darwin',
      remediation: {
        title: 'Set up 1Password',
        instructions: [
          'Download and install the 1Password desktop app, then sign in.',
          'Install the 1Password command-line tool (op).',
          'In 1Password, turn on Settings → Developer → Integrate with 1Password CLI.',
          'Return here and refresh.',
        ],
        action: { kind: 'open_url', label: 'Download 1Password' },
      },
    })
  })

  it('reports an unconnected runtime as disconnected and locked', async () => {
    const provider = new OnePasswordProvider(runtime())
    await expect(provider.connectionStatus()).resolves.toMatchObject({
      status: 'disconnected',
      message: "You'll approve access in the 1Password app when needed",
    })
    await expect(provider.list(context)).resolves.toEqual({
      status: 'locked',
      message: 'Check your password manager to show saved logins for this page',
      items: [],
    })
  })

  it('reports a building runtime as connected and warming', async () => {
    const backend = runtime({
      state: vi.fn().mockReturnValue({ state: 'building' }),
      isWarming: vi.fn().mockReturnValue(true),
    })
    const provider = new OnePasswordProvider(backend)
    await expect(provider.connectionStatus()).resolves.toMatchObject({ status: 'connected' })
    await expect(provider.list(context)).resolves.toEqual({ status: 'warming', items: [] })
  })

  it('returns metadata without leaking a password from the list response', async () => {
    const backend = runtime({
      state: vi.fn().mockReturnValue({ state: 'ready', builtAt: 1 }),
    })
    const result = await new OnePasswordProvider(backend).list(context)
    expect(result).toEqual({
      status: 'ready',
      items: [{
        providerKey: 'ACC1:item1',
        username: 'a@x.com',
        domain: 'mail.corp.com',
        title: 'Mail',
      }],
    })
    expect(JSON.stringify(result)).not.toContain('s3cret')
  })

  it('maps a failed build to disconnected and locked with the taxonomy reason', async () => {
    const backend = runtime({
      state: vi.fn().mockReturnValue({
        state: 'failed',
        code: 'unlock_denied',
        message: 'authorization prompt was dismissed',
      }),
    })
    const provider = new OnePasswordProvider(backend)
    await expect(provider.connectionStatus()).resolves.toMatchObject({
      status: 'disconnected',
      message: 'authorization prompt was dismissed',
    })
    await expect(provider.list(context)).resolves.toEqual({
      status: 'locked',
      message: "1Password couldn't load your logins: authorization prompt was dismissed. Check again.",
      items: [],
    })
  })

  it('beginPairing returns ready after connect and completePairing is unused', async () => {
    const backend = runtime()
    const provider = new OnePasswordProvider(backend)
    await expect(provider.beginPairing()).resolves.toEqual({ status: 'ready' })
    expect(backend.connect).toHaveBeenCalledOnce()
    await expect(provider.completePairing('123456')).rejects.toMatchObject({ code: 'provider_error' })
  })

  it('search omits domain and username when the item has none', async () => {
    const hit: RuntimeSearchHit = {
      itemId: 'ACC1:obscure',
      title: 'Obscure Tool',
      username: null,
      providerKey: 'ACC1:obscure',
    }
    const backend = runtime({
      searchItems: vi.fn().mockReturnValue([hit]),
    })
    const result = await new OnePasswordProvider(backend).search('obscure')
    expect(result).toEqual([{ providerKey: 'ACC1:obscure', title: 'Obscure Tool' }])
    expect(JSON.stringify(result)).not.toContain('s3cret')
  })

  it('retrieve delegates by providerKey', async () => {
    const backend = runtime()
    await expect(new OnePasswordProvider(backend).retrieve(context, {
      providerKey: 'ACC1:item1',
      title: 'Mail',
    })).resolves.toEqual({ username: 'a@x.com', password: 's3cret' })
    expect(backend.retrieve).toHaveBeenCalledWith('ACC1:item1')
  })

  it('maps item_unreadable to a refreshable provider error', async () => {
    const backend = runtime({
      retrieve: vi.fn().mockRejectedValue(new OpError('item_unreadable', 'gone')),
    })
    await expect(new OnePasswordProvider(backend).retrieve(context, {
      providerKey: 'ACC1:item1',
    })).rejects.toMatchObject({
      code: 'provider_error',
      message: 'Refresh the available credentials and try again',
    })
  })

  it('shuts down its managed runtime', async () => {
    const backend = runtime()
    await new OnePasswordProvider(backend).shutdown()
    expect(backend.shutdown).toHaveBeenCalledOnce()
  })
})
