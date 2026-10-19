import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOwnedBrowserLogin = vi.hoisted(() => vi.fn())
const mapAgentToBrowserLogin = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/services/browser-credential-service', () => ({
  getOwnedBrowserLogin,
  mapAgentToBrowserLogin,
  saveBrowserLogin: vi.fn(),
}))
const mockSettings = vi.hoisted(() => ({ app: { hostBrowserProvider: undefined as 'chrome' | undefined } }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => mockSettings }))
vi.mock('./browser-vault-crypto', () => ({ decryptBrowserBundle: () => savedBundle }))

import { applyBrowserLogin, BrowserLoginNotFoundError } from './browser-login-apply'

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

function fakeClient(restoreStatuses: number[], location: 'host' | 'container' = 'container') {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
    const action = path.split('/').pop()
    const status = action === 'restore' ? restoreStatuses.shift() ?? 200 : 200
    const body = action === 'status' ? { active: true, sessionId: 'sess-1', location } : {}
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
    const client = fakeClient([200], 'host')

    await expect(applyBrowserLogin({ ...input, client })).resolves.toEqual({ site: 'example.com', linked: true })
    expect(calledActions(client)).toEqual(['status', 'restore', 'run'])
  })
})
