import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveBrowserLogin = vi.hoisted(() => vi.fn())
const mockSettings = vi.hoisted(() => ({ app: { hostBrowserProvider: undefined as 'chrome' | undefined } }))
vi.mock('@shared/lib/services/browser-credential-service', () => ({ saveBrowserLogin }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => mockSettings }))

import { saveLoginAfterBrowserInput } from './browser-login-save'

const bundle = {
  version: 1,
  site: 'example.com',
  capturedAt: '2026-09-28T00:00:00.000Z',
  cookies: [],
  origins: [],
}

function fakeClient(responses: Record<string, unknown[]>) {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
    const action = path.split('/').pop()!
    const body = responses[action]?.shift()
    return { ok: body !== undefined, status: body === undefined ? 500 : 200, json: async () => body } as unknown as Response
  })
  return { fetch }
}

const request = { sessionId: 'sess-1', agentSlug: 'agent-a', userId: 'alice', url: 'https://www.example.com/login' }
const containerBrowser = { active: true, sessionId: 'sess-1', location: 'container' }

describe('saveLoginAfterBrowserInput', () => {
  beforeEach(() => {
    saveBrowserLogin.mockReset()
    mockSettings.app.hostBrowserProvider = undefined
  })

  it('captures the site of the page the request opened on and saves it', async () => {
    const client = fakeClient({ capture: [bundle], status: [containerBrowser] })
    saveBrowserLogin.mockResolvedValue({ status: 'created', credentialId: 'bc-1', version: 1 })

    expect(await saveLoginAfterBrowserInput({ ...request, client })).toBe('saved')
    expect(client.fetch).toHaveBeenCalledWith('/browser/storage/capture', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'sess-1', site: 'example.com' }),
    }))
    expect(saveBrowserLogin).toHaveBeenCalledWith({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle,
    })
  })

  it('reports an overwritten login as updated', async () => {
    const client = fakeClient({ capture: [bundle], status: [containerBrowser] })
    saveBrowserLogin.mockResolvedValue({ status: 'updated', credentialId: 'bc-1', version: 2 })

    expect(await saveLoginAfterBrowserInput({ ...request, client })).toBe('updated')
  })

  it('uses the active container browser even when Chrome is configured', async () => {
    mockSettings.app.hostBrowserProvider = 'chrome'
    const client = fakeClient({ capture: [bundle], status: [containerBrowser] })
    saveBrowserLogin.mockResolvedValue({ status: 'created', credentialId: 'bc-1', version: 1 })

    await saveLoginAfterBrowserInput({ ...request, client })
    expect(saveBrowserLogin).toHaveBeenCalledWith(expect.objectContaining({ browserType: 'container' }))
  })

  it('uses the configured provider for an active host browser', async () => {
    mockSettings.app.hostBrowserProvider = 'chrome'
    const client = fakeClient({ capture: [bundle], status: [{ ...containerBrowser, location: 'host' }] })
    saveBrowserLogin.mockResolvedValue({ status: 'created', credentialId: 'bc-1', version: 1 })

    await saveLoginAfterBrowserInput({ ...request, client })
    expect(saveBrowserLogin).toHaveBeenCalledWith(expect.objectContaining({ browserType: 'chrome' }))
  })

  it('does not save when the browser session changed', async () => {
    const client = fakeClient({ capture: [bundle], status: [{ ...containerBrowser, sessionId: 'another-session' }] })

    expect(await saveLoginAfterBrowserInput({ ...request, client })).toBe('failed')
    expect(saveBrowserLogin).not.toHaveBeenCalled()
  })

  it('does not touch the browser for a page without a site, e.g. localhost', async () => {
    const client = fakeClient({})

    expect(await saveLoginAfterBrowserInput({ ...request, client, url: 'http://localhost:3000/' })).toBe('failed')
    expect(await saveLoginAfterBrowserInput({ ...request, client, url: null })).toBe('failed')
    expect(client.fetch).not.toHaveBeenCalled()
  })

  it('reports failed when capture fails', async () => {
    const client = fakeClient({})

    expect(await saveLoginAfterBrowserInput({ ...request, client })).toBe('failed')
    expect(saveBrowserLogin).not.toHaveBeenCalled()
  })
})
