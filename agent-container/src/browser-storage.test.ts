import { describe, expect, it, vi } from 'vitest'
import {
  applyPendingSessionStorage,
  candidateOrigins,
  captureSiteStorage,
  clearPendingSessionStorage,
  clearSiteStorage,
  hasPendingSessionStorage,
  hostBelongsToSite,
  isStorageStubTarget,
  restoreSiteStorage,
  runBrowserStorage,
  toStorageCookie,
  type CdpClient,
} from './browser-storage'
import type { SiteStorageBundle } from './browser-storage-bundle'
import { READ_ORIGIN_STORAGE_FUNCTION, WRITE_ORIGIN_STORAGE_FUNCTION, WRITE_SESSION_STORAGE_FUNCTION } from './browser-storage-script'

type Call = { method: string; params: any; sessionId?: string }

/** Scripted CDP peer: records calls in order and drives stub-page navigation events. */
function fakeCdp(options: { cookies?: any[]; pages?: Array<{ url: string; history?: string[] }>; read?: Record<string, unknown>; actualOrigin?: string; databases?: string[] } = {}) {
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
        case 'IndexedDB.requestDatabaseNames': return { databaseNames: options.databases ?? [] }
        case 'Target.getTargets': return { targetInfos: (options.pages ?? []).map((page, i) => ({ targetId: `page-${i}`, type: 'page', url: page.url })) }
        case 'Target.createTarget': return { targetId: `stub-${++targets}` }
        case 'Target.attachToTarget': return { sessionId: `session-${params.targetId}` }
        case 'Page.getNavigationHistory': {
          const page = options.pages?.[Number(sessionId?.replace('session-page-', ''))]
          return { entries: (page?.history ?? []).map((url) => ({ url })) }
        }
        case 'Page.navigate':
          queueMicrotask(() => {
            emit('Fetch.requestPaused', { requestId: 'favicon', request: { url: 'https://example.org/favicon.ico' } }, sessionId)
            emit('Fetch.requestPaused', { requestId: 'stub', request: { url: params.url } }, sessionId)
            emit('Page.loadEventFired', {}, sessionId)
          })
          return {}
        case 'Runtime.evaluate': {
          if (params.expression === 'location.origin') {
            const index = Number(sessionId?.replace('session-page-', ''))
            return { result: { value: options.actualOrigin ?? new URL(options.pages![index].url).origin } }
          }
          return { result: { objectId: 'global' } }
        }
        case 'Runtime.callFunctionOn':
          if (params.functionDeclaration === READ_ORIGIN_STORAGE_FUNCTION) {
            return { result: { value: { localStorage: [['token', 'secret-token']], indexedDB: [], oversizedDatabases: [], unsupported: [], ...options.read } } }
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
    expect(await runBrowserStorage('capture', { sessionId: 's', site: 'example.org' }, {
      validateSession: () => 'Browser is owned by session other', isBrowserActive: () => true, connect,
    })).toEqual({ success: false, status: 409, body: { error: 'Browser is owned by session other' } })
    expect(await runBrowserStorage('capture', { sessionId: 's', site: 'example.org' }, {
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

  it('refuses to clear another site or a browser owned by another session', async () => {
    const connect = vi.fn()
    const body = { sessionId: 's', site: 'example.org', origins: ['https://other.org'] }
    expect(await runBrowserStorage('clear', body, { ...allow, connect })).toMatchObject({ success: false, status: 400 })
    expect(await runBrowserStorage('clear', { ...body, origins: ['https://example.org'] }, {
      ...allow, validateSession: () => 'Browser is owned by another session', connect,
    })).toMatchObject({ success: false, status: 409 })
    expect(connect).not.toHaveBeenCalled()
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

  it('deletes IndexedDB databases on the stub tab\'s session before writing through it', async () => {
    const { client, calls } = fakeCdp({ databases: ['auth', 'prefs'] })
    await restoreSiteStorage(client, bundle)
    const deletes = calls.filter((call) => call.method === 'IndexedDB.deleteDatabase')
    const write = calls.findIndex((call) => call.params.functionDeclaration === WRITE_ORIGIN_STORAGE_FUNCTION)
    expect(deletes).toEqual([
      { method: 'IndexedDB.deleteDatabase', params: { securityOrigin: 'https://example.org', databaseName: 'auth' }, sessionId: 'session-stub-1' },
      { method: 'IndexedDB.deleteDatabase', params: { securityOrigin: 'https://example.org', databaseName: 'prefs' }, sessionId: 'session-stub-1' },
    ])
    expect(calls.lastIndexOf(deletes[1])).toBeLessThan(write)
  })

  it('keeps databases capture left out for size, since the bundle cannot put them back', async () => {
    const { client, calls } = fakeCdp({ databases: ['auth', 'message-cache'] })
    await restoreSiteStorage(client, {
      ...bundle,
      origins: bundle.origins.map((origin) => ({ ...origin, oversizedDatabases: ['message-cache'] })),
    })
    expect(calls.filter((call) => call.method === 'IndexedDB.deleteDatabase').map((call) => call.params.databaseName)).toEqual(['auth'])
  })

  it('hides the stub tab from tab listings only while it is open', async () => {
    const { client } = fakeCdp()
    const send = client.send.bind(client)
    let hiddenDuringWrite = false
    client.send = async (method, params, sessionId) => {
      if (params?.functionDeclaration === WRITE_ORIGIN_STORAGE_FUNCTION) hiddenDuringWrite = isStorageStubTarget('stub-1')
      return send(method, params, sessionId)
    }
    await restoreSiteStorage(client, bundle)
    expect(hiddenDuringWrite).toBe(true)
    expect(isStorageStubTarget('stub-1')).toBe(false)
  })

  it('reports sessionStorage it could not restore because no tab of that origin is open', async () => {
    const { client } = fakeCdp()
    expect((await restoreSiteStorage(client, bundle)).sessionStorageSkipped).toEqual(['https://example.org'])
  })
})

describe('captureSiteStorage', () => {
  it('records IndexedDB databases left out for size', async () => {
    const pages = [{ url: 'https://example.org/' }]
    const withOversized = await captureSiteStorage(fakeCdp({ pages, read: { oversizedDatabases: ['message-cache'] } }).client, 'example.org')
    expect(withOversized.origins[0].oversizedDatabases).toEqual(['message-cache'])
    const without = await captureSiteStorage(fakeCdp({ pages }).client, 'example.org')
    expect(without.origins[0]).not.toHaveProperty('oversizedDatabases')
  })

  it('reads origins a tab passed through during sign-in, from its history', async () => {
    const { client } = fakeCdp({
      pages: [{ url: 'https://www.example.org/home', history: ['https://app.example.org/login', 'https://auth.other.com/sso', 'https://www.example.org/home'] }],
    })
    const bundle = await captureSiteStorage(client, 'example.org')
    expect(bundle.origins.map((origin) => origin.origin)).toEqual(['https://app.example.org', 'https://www.example.org'])
  })
})

describe('clearSiteStorage', () => {
  it('clears closed saved origins, every open site tab and cookies, but not other sites', async () => {
    const { client, calls } = fakeCdp({
      cookies: [cdpCookie({}), cdpCookie({ domain: '.other.org' })],
      pages: [
        { url: 'https://www.example.org/one' },
        { url: 'https://www.example.org/two' },
        { url: 'https://other.org/' },
      ],
    })

    const result = await clearSiteStorage(client, 'example.org', ['https://auth.example.org'])

    expect(result).toEqual({ skipped: [] })
    expect(calls.filter((call) => call.method === 'Storage.setCookies').map((call) => call.params.cookies))
      .toEqual([[expect.objectContaining({ domain: '.example.org', value: '', expires: 1 })]])
    expect(calls.filter((call) => call.method === 'Storage.clearDataForOrigin').every((call) => call.sessionId === 'session-stub-1')).toBe(true)
    expect(calls.filter((call) => call.method === 'Storage.clearDataForOrigin').map((call) => call.params))
      .toEqual([
        { origin: 'https://auth.example.org', storageTypes: 'local_storage,indexeddb' },
        { origin: 'https://example.org', storageTypes: 'local_storage,indexeddb' },
        { origin: 'https://www.example.org', storageTypes: 'local_storage,indexeddb' },
      ])
    expect(calls.filter((call) => call.params.functionDeclaration === WRITE_SESSION_STORAGE_FUNCTION)).toHaveLength(2)
    expect(calls.filter((call) => call.method === 'Page.reload')).toHaveLength(2)
    expect(calls.filter((call) => call.method === 'Target.createTarget')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'Target.closeTarget')).toHaveLength(1)
  })

  it('does not touch a tab that navigated to another site before clearing session storage', async () => {
    const { client, calls } = fakeCdp({
      pages: [{ url: 'https://example.org/' }], actualOrigin: 'https://other.org',
    })

    expect(await clearSiteStorage(client, 'example.org', ['https://example.org']))
      .toEqual({ skipped: ['https://example.org'] })

    expect(calls.some((call) => call.params.functionDeclaration === WRITE_SESSION_STORAGE_FUNCTION)).toBe(false)
    expect(calls.some((call) => call.method === 'Page.reload')).toBe(false)
  })
})

describe('pending sessionStorage', () => {
  const bundle: SiteStorageBundle = {
    version: 1,
    site: 'example.org',
    capturedAt: '2026-09-28T00:00:00.000Z',
    cookies: [],
    origins: [{ origin: 'https://app.example.org', localStorage: [], indexedDB: [], sessionStorage: [['tab', 'x']], unsupported: [] }],
  }

  it('writes saved sessionStorage into the first tab that shows its origin, once', async () => {
    clearPendingSessionStorage()
    await restoreSiteStorage(fakeCdp().client, bundle)
    expect(hasPendingSessionStorage()).toBe(true)

    const unrelated = fakeCdp({ pages: [{ url: 'https://other.org/' }] })
    expect(await applyPendingSessionStorage(unrelated.client)).toEqual([])

    const { client, calls } = fakeCdp({ pages: [{ url: 'https://app.example.org/home' }] })
    expect(await applyPendingSessionStorage(client)).toEqual(['https://app.example.org'])
    expect(calls.find((call) => call.params.functionDeclaration === WRITE_SESSION_STORAGE_FUNCTION)?.params.arguments)
      .toEqual([{ value: [['tab', 'x']] }])
    expect(calls.some((call) => call.method === 'Page.reload')).toBe(true)
    expect(hasPendingSessionStorage()).toBe(false)
  })

  it('drops pending sessionStorage when the site is cleared or the browser closes', async () => {
    clearPendingSessionStorage()
    await restoreSiteStorage(fakeCdp().client, bundle)
    await clearSiteStorage(fakeCdp().client, 'example.org', [])
    expect(hasPendingSessionStorage()).toBe(false)

    await restoreSiteStorage(fakeCdp().client, bundle)
    clearPendingSessionStorage()
    expect(hasPendingSessionStorage()).toBe(false)
  })
})
