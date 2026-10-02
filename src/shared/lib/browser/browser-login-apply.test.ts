import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOwnedBrowserLogin = vi.hoisted(() => vi.fn())
const mapAgentToBrowserLogin = vi.hoisted(() => vi.fn())
const listOutdatedAgentBrowserLogins = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/services/browser-credential-service', () => ({
  getOwnedBrowserLogin,
  mapAgentToBrowserLogin,
  listOutdatedAgentBrowserLogins,
  saveBrowserLogin: vi.fn(),
}))
const mockSettings = vi.hoisted(() => ({ app: { hostBrowserProvider: undefined as 'chrome' | undefined } }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => mockSettings }))
vi.mock('./browser-vault-crypto', () => ({ decryptBrowserBundle: () => savedBundle }))
const mockAuthMode = vi.hoisted(() => ({ enabled: false, members: 1 }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockAuthMode.enabled }))
vi.mock('@shared/lib/services/agent-members-service', () => ({ countMembersWithMinRole: async () => mockAuthMode.members }))

import {
  applyBrowserLogin,
  BrowserLoginNotFoundError,
  clearSiteInAgentBrowser,
  syncAgentBrowserLogins,
} from './browser-login-apply'

function bundle(theme: string) {
  return {
    version: 1,
    site: 'example.com',
    capturedAt: '2026-09-28T00:00:00.000Z',
    cookies: [],
    origins: [{ origin: 'https://example.com', localStorage: [['theme', theme]], indexedDB: [], unsupported: [] }],
  }
}
const savedBundle = bundle('saved')
const credential = { id: 'bc-1', site: 'example.com', browserType: 'container', version: 3, bundle: 'v1:…' }

function fakeClient(
  restoreStatuses: number[],
  browserStatus: { active: boolean; sessionId: string | null; location: 'host' | 'container' | null } = {
    active: true, sessionId: 'sess-1', location: 'container',
  },
  restoreResults: Array<{ sessionStorageSkipped: string[] }> = [],
  clearResult = { skipped: [] as string[] },
) {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
    const action = path.split('/').pop()
    const status = action === 'restore' ? restoreStatuses.shift() ?? 200 : 200
    const body = action === 'status' ? browserStatus
      : action === 'restore' ? restoreResults.shift() ?? { sessionStorageSkipped: [] }
      : action === 'clear' ? clearResult : {}
    return { ok: status === 200, status, json: async () => body } as unknown as Response
  })
  return { fetch }
}

function calledActions(client: ReturnType<typeof fakeClient>) {
  return client.fetch.mock.calls.map(([path]) => path.split('/').pop())
}

function restoredBundles(client: ReturnType<typeof fakeClient>) {
  return client.fetch.mock.calls
    .filter(([path]) => path === '/browser/storage/restore')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).bundle)
}

const input = { sessionId: 'sess-1', agentSlug: 'agent-a', userId: 'alice', credentialId: 'bc-1', site: 'example.com' }

describe('applyBrowserLogin', () => {
  beforeEach(() => {
    getOwnedBrowserLogin.mockReset().mockResolvedValue(credential)
    mapAgentToBrowserLogin.mockReset().mockResolvedValue(undefined)
    mockSettings.app.hostBrowserProvider = undefined
  })

  it('does not touch the browser for a login saved for another site', async () => {
    const client = fakeClient([200])
    await expect(applyBrowserLogin({ ...input, client, site: 'other.com' })).rejects.toBeInstanceOf(BrowserLoginNotFoundError)
    expect(client.fetch).not.toHaveBeenCalled()
  })

  it('restores the saved login, reloads the page, then maps the agent to it', async () => {
    const client = fakeClient([200])

    await expect(applyBrowserLogin({ ...input, client })).resolves.toEqual({ site: 'example.com', linked: true })

    expect(calledActions(client)).toEqual(['status', 'restore', 'run'])
    expect(JSON.parse((client.fetch.mock.calls[2][1] as RequestInit).body as string)).toEqual({ sessionId: 'sess-1', args: ['reload'] })

    expect(getOwnedBrowserLogin).toHaveBeenCalledWith('alice', 'bc-1')
    expect(restoredBundles(client)).toEqual([savedBundle])
    expect(mapAgentToBrowserLogin).toHaveBeenCalledWith({
      agentSlug: 'agent-a', credentialId: 'bc-1', site: 'example.com', version: 3,
    })
  })

  it('neither reloads nor maps when restore fails (the container puts the previous state back)', async () => {
    const client = fakeClient([500])

    await expect(applyBrowserLogin({ ...input, client })).rejects.toThrow('restore failed')

    expect(restoredBundles(client)).toEqual([savedBundle])
    expect(calledActions(client)).not.toContain('run')
    expect(mapAgentToBrowserLogin).not.toHaveBeenCalled()
  })

  it('reports not linked when only the mapping fails', async () => {
    mapAgentToBrowserLogin.mockRejectedValue(new Error('db down'))

    await expect(applyBrowserLogin({ ...input, client: fakeClient([200]) }))
      .resolves.toEqual({ site: 'example.com', linked: false })
  })

  it('rejects logins the caller does not own or for another browser type', async () => {
    const client = fakeClient([])
    getOwnedBrowserLogin.mockResolvedValueOnce(undefined)
    await expect(applyBrowserLogin({ ...input, client })).rejects.toBeInstanceOf(BrowserLoginNotFoundError)

    getOwnedBrowserLogin.mockResolvedValueOnce({ ...credential, browserType: 'chrome' })
    await expect(applyBrowserLogin({ ...input, client })).rejects.toBeInstanceOf(BrowserLoginNotFoundError)
    expect(calledActions(client)).not.toContain('restore')
    expect(calledActions(client)).not.toContain('restore')
  })

  it('rejects a host login when this agent is using the container browser', async () => {
    mockSettings.app.hostBrowserProvider = 'chrome'
    getOwnedBrowserLogin.mockResolvedValueOnce({ ...credential, browserType: 'chrome' })
    const client = fakeClient([])

    await expect(applyBrowserLogin({ ...input, client })).rejects.toBeInstanceOf(BrowserLoginNotFoundError)
    expect(calledActions(client)).toEqual(['status'])
  })

  it('accepts the configured provider when this agent is using the host browser', async () => {
    mockSettings.app.hostBrowserProvider = 'chrome'
    getOwnedBrowserLogin.mockResolvedValueOnce({ ...credential, browserType: 'chrome' })
    const client = fakeClient([200], { active: true, sessionId: 'sess-1', location: 'host' })

    await expect(applyBrowserLogin({ ...input, client })).resolves.toEqual({ site: 'example.com', linked: true })
    expect(calledActions(client)).toEqual(['status', 'restore', 'run'])
  })
})

describe('clearSiteInAgentBrowser', () => {
  it('clears the site and all stored origins in an open browser', async () => {
    const client = fakeClient([])
    await expect(clearSiteInAgentBrowser(client, 'example.com', ['https://auth.example.com'])).resolves.toBe(true)
    expect(calledActions(client)).toEqual(['status', 'clear'])
    expect(JSON.parse((client.fetch.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      sessionId: 'sess-1', site: 'example.com', origins: ['https://auth.example.com'],
    })
  })

  it('reports an incomplete clear when an open tab of the site could not be cleared', async () => {
    const client = fakeClient([], undefined, [], { skipped: ['https://example.com'] })
    await expect(clearSiteInAgentBrowser(client, 'example.com', ['https://auth.example.com'])).resolves.toBe(false)
  })

  it('does nothing when the browser is closed', async () => {
    const client = fakeClient([], { active: false, sessionId: null, location: null })
    await expect(clearSiteInAgentBrowser(client, 'example.com', [])).resolves.toBe(false)
    expect(calledActions(client)).toEqual(['status'])
  })
})

describe('syncAgentBrowserLogins', () => {
  beforeEach(() => {
    mockAuthMode.enabled = false
    mockAuthMode.members = 1
  })

  it('leaves a shared agent\'s browser alone', async () => {
    mockAuthMode.enabled = true
    mockAuthMode.members = 2
    listOutdatedAgentBrowserLogins.mockReset().mockResolvedValue([credential])
    const client = fakeClient([200])

    await syncAgentBrowserLogins(client, 'agent-shared', 'sess-1')

    expect(client.fetch).not.toHaveBeenCalled()
    expect(listOutdatedAgentBrowserLogins).not.toHaveBeenCalled()
  })

  it('applies newer versions, records them and reloads once', async () => {
    mapAgentToBrowserLogin.mockReset().mockResolvedValue(undefined)
    listOutdatedAgentBrowserLogins.mockResolvedValue([credential])
    const client = fakeClient([200])

    await syncAgentBrowserLogins(client, 'agent-sync', 'sess-1')

    expect(restoredBundles(client)).toEqual([savedBundle])
    expect(calledActions(client)).toEqual(['status', 'restore', 'run'])
    expect(mapAgentToBrowserLogin).toHaveBeenCalledWith({
      agentSlug: 'agent-sync', credentialId: 'bc-1', site: 'example.com', version: 3,
    })
  })

  it('records the version when sessionStorage had no open tab, so the next open does not overwrite cookies again', async () => {
    mapAgentToBrowserLogin.mockReset().mockResolvedValue(undefined)
    listOutdatedAgentBrowserLogins.mockResolvedValue([credential])
    const client = fakeClient([200], undefined, [{ sessionStorageSkipped: ['https://example.com'] }])

    await syncAgentBrowserLogins(client, 'agent-sync', 'sess-1')

    expect(mapAgentToBrowserLogin).toHaveBeenCalledWith({
      agentSlug: 'agent-sync', credentialId: 'bc-1', site: 'example.com', version: 3,
    })
    expect(calledActions(client)).toEqual(['status', 'restore', 'run'])
  })

  it('runs a browser-open event that arrives mid-sync afterwards, and settles each call after its own run', async () => {
    mapAgentToBrowserLogin.mockReset().mockResolvedValue(undefined)
    listOutdatedAgentBrowserLogins.mockReset().mockResolvedValueOnce([credential]).mockResolvedValueOnce([])
    const client = fakeClient([200])
    const fetch = client.fetch.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let restores = 0
    client.fetch.mockImplementation(async (path, init) => {
      if (path === '/browser/storage/restore' && ++restores === 1) await gate
      return fetch(path, init)
    })

    const first = syncAgentBrowserLogins(client, 'agent-sync-retry', 'sess-1')
    await vi.waitFor(() => expect(restores).toBe(1))
    let secondSettled = false
    const second = syncAgentBrowserLogins(client, 'agent-sync-retry', 'sess-1').then(() => { secondSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondSettled).toBe(false)
    expect(listOutdatedAgentBrowserLogins).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second])
    expect(listOutdatedAgentBrowserLogins).toHaveBeenCalledTimes(2)
    expect(mapAgentToBrowserLogin).toHaveBeenCalledTimes(1)
  })

  it('selects only credentials for the active browser provider', async () => {
    mockSettings.app.hostBrowserProvider = 'chrome'
    listOutdatedAgentBrowserLogins.mockResolvedValue([])

    await syncAgentBrowserLogins(fakeClient([]), 'agent-sync', 'sess-1')
    expect(listOutdatedAgentBrowserLogins).toHaveBeenCalledWith('agent-sync', 'container')
  })

  it('does not record a version whose restore failed', async () => {
    mapAgentToBrowserLogin.mockReset().mockResolvedValue(undefined)
    listOutdatedAgentBrowserLogins.mockResolvedValue([credential])
    const client = fakeClient([500])

    await syncAgentBrowserLogins(client, 'agent-sync', 'sess-1')

    expect(mapAgentToBrowserLogin).not.toHaveBeenCalled()
    expect(calledActions(client)).not.toContain('run')
  })
})
