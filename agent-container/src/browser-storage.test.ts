import { describe, expect, it, vi } from 'vitest'
import {
  candidateOrigins,
  hostBelongsToSite,
  restoreSiteStorage,
  runBrowserStorage,
  snapshotSiteStorage,
  toStorageCookie,
  type CdpClient,
  type SiteStorageBundle,
} from './browser-storage'
import { READ_ORIGIN_STORAGE_FUNCTION, WRITE_ORIGIN_STORAGE_FUNCTION } from './browser-storage-script'

type Call = { method: string; params: any; sessionId?: string }

/** Scripted CDP peer: records calls in order and drives stub-page navigation events. */
function fakeCdp(options: { cookies?: any[]; pages?: Array<{ url: string }> } = {}) {
  const calls: Call[] = []
  const handlers = new Map<string, Set<(params: any, sessionId?: string) => void>>()
  const emit = (method: string, params: any, sessionId?: string) => {
    for (const handler of [...(handlers.get(method) ?? [])]) handler(params, sessionId)
  }
  let targets = 0
  const client: CdpClient = {
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId })
      switch (method) {
        case 'Storage.getCookies': return { cookies: options.cookies ?? [] }
        case 'Target.getTargets': return { targetInfos: (options.pages ?? []).map((page, i) => ({ targetId: `page-${i}`, type: 'page', url: page.url })) }
        case 'Target.createTarget': return { targetId: `stub-${++targets}` }
        case 'Target.attachToTarget': return { sessionId: `session-${params.targetId}` }
        case 'Page.navigate':
          queueMicrotask(() => {
            emit('Fetch.requestPaused', { requestId: 'favicon', request: { url: 'https://example.org/favicon.ico' } }, sessionId)
            emit('Fetch.requestPaused', { requestId: 'stub', request: { url: params.url } }, sessionId)
            emit('Page.loadEventFired', {}, sessionId)
          })
          return {}
        case 'Runtime.evaluate': return { result: { objectId: 'global' } }
        case 'Runtime.callFunctionOn':
          if (params.functionDeclaration === READ_ORIGIN_STORAGE_FUNCTION) {
            return { result: { value: { localStorage: [['token', 'secret-token']], indexedDB: [], unsupported: [] } } }
          }
          if (params.functionDeclaration === WRITE_ORIGIN_STORAGE_FUNCTION) {
            return { result: { value: { localStorage: params.arguments[0].value.localStorage.length, indexedDB: 0, skippedRecords: 0 } } }
          }
          return { result: { value: [] } }
        default: return {}
      }
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set()
      set.add(handler)
      handlers.set(method, set)
      return () => set.delete(handler)
    },
    close: vi.fn(),
  }
  return { client, calls }
}

const cdpCookie = (overrides: Record<string, unknown>) => ({
  name: 'id', value: 'v', domain: '.example.org', path: '/', expires: 2_000_000_000,
  size: 3, httpOnly: false, secure: true, session: false, sameSite: 'Lax', ...overrides,
})

describe('site matching', () => {
  it('matches the site and its subdomains only', () => {
    expect(hostBelongsToSite('.example.org', 'example.org')).toBe(true)
    expect(hostBelongsToSite('www.Example.org', 'example.org')).toBe(true)
    expect(hostBelongsToSite('notexample.org', 'example.org')).toBe(false)
    expect(hostBelongsToSite('example.org.evil.com', 'example.org')).toBe(false)
  })

  it('derives candidate origins from cookie hosts, open tabs, and extras under the site', () => {
    expect(candidateOrigins(
      'example.org',
      [{ domain: '.example.org', secure: true }, { domain: 'app.example.org', secure: true }, { domain: '.other.com', secure: true }],
      ['https://www.example.org/feed?x=1', 'https://other.com/', 'chrome://newtab/'],
      ['https://auth.example.org'],
    )).toEqual(['https://app.example.org', 'https://auth.example.org', 'https://example.org', 'https://www.example.org'])
  })
})

describe('toStorageCookie', () => {
  it('drops the expiry of session cookies and keeps partition information', () => {
    const partitionKey = { topLevelSite: 'https://top.com', hasCrossSiteAncestor: true }
    expect(toStorageCookie(cdpCookie({ session: true, expires: -1, partitionKey }) as any)).toEqual({
      name: 'id', value: 'v', domain: '.example.org', path: '/', httpOnly: false, secure: true, sameSite: 'Lax', partitionKey,
    })
    expect(toStorageCookie(cdpCookie({}) as any).expires).toBe(2_000_000_000)
  })
})

describe('runBrowserStorage', () => {
  const allow = { validateSession: () => null, isBrowserActive: () => true }

  it('rejects malformed requests before touching the browser', async () => {
    const connect = vi.fn()
    for (const body of [
      { sessionId: 's', site: 'Example.org' },
      { sessionId: 's', site: 'example.org', extra: true },
      { sessionId: 's', site: 'example.org', origins: ['https://example.org/path'] },
      null,
    ]) {
      expect(await runBrowserStorage('capture', body, { ...allow, connect })).toMatchObject({ success: false, status: 400 })
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it('refuses when another session owns the browser or no browser is open', async () => {
    const connect = vi.fn()
    expect(await runBrowserStorage('snapshot', { sessionId: 's', site: 'example.org' }, {
      validateSession: () => 'Browser is owned by session other', isBrowserActive: () => true, connect,
    })).toEqual({ success: false, status: 409, body: { error: 'Browser is owned by session other' } })
    expect(await runBrowserStorage('snapshot', { sessionId: 's', site: 'example.org' }, {
      validateSession: () => null, isBrowserActive: () => false, connect,
    })).toEqual({ success: false, status: 409, body: { error: 'Browser is not active' } })
    expect(connect).not.toHaveBeenCalled()
  })

  it('closes the CDP connection after the operation', async () => {
    const { client } = fakeCdp({ cookies: [cdpCookie({})] })
    const result = await runBrowserStorage('capture', { sessionId: 's', site: 'example.org' }, { ...allow, connect: async () => client })
    expect(result.success).toBe(true)
    expect(client.close).toHaveBeenCalled()
  })
})

describe('snapshotSiteStorage', () => {
  it('returns hashes, never values', async () => {
    const { client } = fakeCdp({ cookies: [cdpCookie({ name: 'auth', value: 'secret-cookie' })] })
    const snapshot = await snapshotSiteStorage(client, 'example.org')
    const text = JSON.stringify(snapshot)
    expect(text).not.toContain('secret-cookie')
    expect(text).not.toContain('secret-token')
    expect(snapshot.cookies[0]).toMatchObject({ name: 'auth', domain: '.example.org' })
    expect(snapshot.origins[0].localStorage.token).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('restoreSiteStorage', () => {
  const bundle: SiteStorageBundle = {
    version: 1,
    site: 'example.org',
    capturedAt: '2026-09-25T00:00:00.000Z',
    cookies: [{ name: 'auth', value: 'new', domain: '.example.org', path: '/', httpOnly: true, secure: true }],
    origins: [{ origin: 'https://example.org', localStorage: [['token', 't']], indexedDB: [], sessionStorage: [['tab', 'x']], unsupported: [] }],
  }

  it('expires existing site cookies before writing the bundle, leaving other sites alone', async () => {
    const { client, calls } = fakeCdp({
      cookies: [cdpCookie({ name: 'stale' }), cdpCookie({ name: 'other', domain: '.other.com' })],
    })
    await restoreSiteStorage(client, bundle)
    const writes = calls.filter((call) => call.method === 'Storage.setCookies').map((call) => call.params.cookies)
    expect(writes).toEqual([
      [expect.objectContaining({ name: 'stale', domain: '.example.org', value: '', expires: 1 })],
      bundle.cookies,
    ])
  })

  it('serves only the stub document on the helper tab and closes it', async () => {
    const { client, calls } = fakeCdp()
    await restoreSiteStorage(client, bundle)
    const fetchCalls = calls.filter((call) => call.method.startsWith('Fetch.') && call.method !== 'Fetch.enable')
    expect(fetchCalls).toEqual([
      expect.objectContaining({ method: 'Fetch.failRequest', params: expect.objectContaining({ requestId: 'favicon' }) }),
      expect.objectContaining({ method: 'Fetch.fulfillRequest', params: expect.objectContaining({ requestId: 'stub' }) }),
    ])
    expect(calls.find((call) => call.method === 'Target.createTarget')?.params).toMatchObject({ background: true })
    expect(calls.at(-1)).toMatchObject({ method: 'Target.closeTarget', params: { targetId: 'stub-1' } })
  })

  it('reports sessionStorage it could not restore because no tab of that origin is open', async () => {
    const { client } = fakeCdp()
    expect((await restoreSiteStorage(client, bundle)).sessionStorageSkipped).toEqual(['https://example.org'])
  })
})
