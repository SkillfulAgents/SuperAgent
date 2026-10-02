import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { chromium, type BrowserContext } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  applyPendingSessionStorage,
  captureSiteStorage,
  clearPendingSessionStorage,
  connectCdp,
  restoreSiteStorage,
  type CdpClient,
} from './browser-storage'
import type { SiteStorageBundle } from './browser-storage-bundle'
import { WRITE_ORIGIN_STORAGE_FUNCTION } from './browser-storage-script'
import { resolveChromiumExecutable } from './dashboard-screenshot'

// Runs the storage primitives against a real Chromium. *.localhost resolves to
// loopback and is a secure context, so service workers work over plain http.
// Needs a Playwright Chromium: `npx playwright install chromium --only-shell`.

const SITE = 'example.localhost'
const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname === '/__superagent_storage__') {
    event.respondWith(new Response('<script>localStorage.setItem("siteCodeRan", "yes")</script>', { headers: { 'Content-Type': 'text/html' } }));
  }
});`

let server: http.Server
let context: BrowserContext
let profileDir: string
let cdp: CdpClient
let port: number
const openedTabs: string[] = []

const originOf = (host: string) => `http://${host}:${port}`

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/sw.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SERVICE_WORKER)
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>app</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port

  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-storage-test-'))
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: resolveChromiumExecutable() ?? undefined,
    args: ['--remote-debugging-port=0'],
  })
  const [debugPort, browserPath] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split('\n')
  cdp = await connectCdp(`ws://127.0.0.1:${debugPort}${browserPath}`)
}, 30_000)

afterEach(async () => {
  clearPendingSessionStorage()
  for (const targetId of openedTabs.splice(0)) await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  // Storage calls need a page session: the launched browser keeps pages out of its default context.
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  for (const host of ['app', 'other', 'fresh']) {
    await cdp.send('Storage.clearDataForOrigin', { origin: originOf(`${host}.${SITE}`), storageTypes: 'all' }, sessionId)
  }
  await cdp.send('Network.clearBrowserCookies', {}, sessionId)
  await cdp.send('Target.closeTarget', { targetId })
})

afterAll(async () => {
  cdp?.close()
  await context?.close()
  server?.close()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

async function evaluate<T>(targetId: string, expression: string): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  try {
    const response = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId)
    if (response.exceptionDetails) throw new Error(`Page script failed: ${JSON.stringify(response.exceptionDetails)}`)
    return response.result.value
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
}

async function waitForLoad(targetId: string, url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const href = await evaluate<string>(targetId, 'document.readyState === "complete" ? location.href : ""').catch(() => '')
    if (href.startsWith(url)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Tab did not load ${url}`)
}

async function openTab(host: string): Promise<string> {
  const url = `${originOf(host)}/app`
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
  openedTabs.push(targetId)
  await waitForLoad(targetId, url)
  return targetId
}

/** A CDP client that runs `before` once, right before the call `matches` selects. */
function interceptOnce(matches: (method: string, params: Record<string, unknown>) => boolean, before: () => Promise<void>): CdpClient {
  let armed = true
  return {
    on: (method, handler) => cdp.on(method, handler),
    close: () => {},
    async send(method, params = {}, sessionId) {
      if (armed && matches(method, params)) {
        armed = false
        await before()
      }
      return cdp.send(method, params, sessionId)
    },
  }
}

/** A CDP client whose origin-storage writes fail from the `failFrom`-th one on (1-based). */
function failingWrites(failFrom: number, failUntil = Infinity): CdpClient {
  let writes = 0
  return {
    on: (method, handler) => cdp.on(method, handler),
    close: () => {},
    async send(method, params = {}, sessionId) {
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === WRITE_ORIGIN_STORAGE_FUNCTION) {
        writes++
        if (writes >= failFrom && writes <= failUntil) throw new Error('injected write failure')
      }
      return cdp.send(method, params, sessionId)
    },
  }
}

const bundleFor = (origins: SiteStorageBundle['origins'], cookies: SiteStorageBundle['cookies'] = []): SiteStorageBundle => ({
  version: 1, site: SITE, capturedAt: new Date().toISOString(), cookies, origins,
})

const localToken = (host: string, value: string): SiteStorageBundle['origins'][number] => ({
  origin: originOf(host), localStorage: [['token', value]], indexedDB: [], unsupported: [],
})

describe('browser storage in Chromium', () => {
  it('round-trips localStorage and IndexedDB values through the page-side codec', async () => {
    const tab = await openTab(`app.${SITE}`)
    await evaluate(tab, `(async () => {
      localStorage.setItem('token', 'account-a');
      const db = await new Promise((resolve) => { const r = indexedDB.open('auth', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => resolve(r.result) });
      await new Promise((resolve) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ at: new Date(5), bytes: new Uint8Array([1, 2]) }, 'session'); tx.oncomplete = resolve });
      db.close();
    })()`)
    const bundle = await captureSiteStorage(cdp, SITE)
    await evaluate(tab, `localStorage.setItem('token', 'account-b')`)

    await restoreSiteStorage(cdp, bundle)

    expect(await evaluate(tab, `localStorage.getItem('token')`)).toBe('account-a')
    expect(await evaluate(tab, `(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('auth'); r.onsuccess = () => resolve(r.result) });
      const value = await new Promise((resolve) => { const r = db.transaction('kv').objectStore('kv').get('session'); r.onsuccess = () => resolve(r.result) });
      db.close();
      return { at: value.at.getTime(), bytes: [...value.bytes] };
    })()`)).toEqual({ at: 5, bytes: [1, 2] })
  })

  it('does not let a service worker run site code on the helper tab', async () => {
    const tab = await openTab(`app.${SITE}`)
    await evaluate(tab, `(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; })()`)

    const bundle = await captureSiteStorage(cdp, SITE)
    await restoreSiteStorage(cdp, bundle)

    expect(await evaluate(tab, `localStorage.getItem('siteCodeRan')`)).toBeNull()
    await evaluate(tab, `(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister() })()`)
  })

  it('captures an origin whose IndexedDB holds a cyclic record, skipping only that record', async () => {
    const tab = await openTab(`app.${SITE}`)
    await evaluate(tab, `(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('graph', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => resolve(r.result) });
      const loop = { name: 'loop' }; loop.self = loop;
      const shared = { token: 't' };
      await new Promise((resolve) => { const tx = db.transaction('kv', 'readwrite'); const s = tx.objectStore('kv'); s.put(loop, 'loop'); s.put({ a: shared, b: shared }, 'shared'); tx.oncomplete = resolve });
      db.close();
    })()`)

    const bundle = await captureSiteStorage(cdp, SITE)
    const result = await restoreSiteStorage(cdp, bundle)

    expect(bundle.origins.find((origin) => origin.origin === originOf(`app.${SITE}`))?.unsupported).toEqual(['cycle'])
    expect(result.origins.find((origin) => origin.origin === originOf(`app.${SITE}`))?.skippedRecords).toBe(1)
    expect(await evaluate(tab, `(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('graph'); r.onsuccess = () => resolve(r.result) });
      const get = (key) => new Promise((resolve) => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => resolve(r.result ?? null) });
      const values = [await get('loop'), (await get('shared')).b.token];
      db.close();
      return values;
    })()`)).toEqual([null, 't'])
  })
})

describe('sessionStorage', () => {
  it('restores into every open tab of the origin, not only the first', async () => {
    const first = await openTab(`app.${SITE}`)
    const second = await openTab(`app.${SITE}`)
    for (const tab of [first, second]) await evaluate(tab, `sessionStorage.setItem('token', 'account-a')`)
    const bundle = bundleFor([{ ...localToken(`app.${SITE}`, 'account-b'), sessionStorage: [['token', 'account-b']] }])

    await restoreSiteStorage(cdp, bundle)

    expect(await evaluate(first, `sessionStorage.getItem('token')`)).toBe('account-b')
    expect(await evaluate(second, `sessionStorage.getItem('token')`)).toBe('account-b')
  })

  it('does not write saved entries into a tab that navigated to another site before the write', async () => {
    const tab = await openTab(`app.${SITE}`)
    const other = `${originOf('other-site.localhost')}/landing`
    const bundle = bundleFor([{ ...localToken(`app.${SITE}`, 'account-b'), sessionStorage: [['token', 'secret']] }])
    // Navigate once restore is writing, i.e. after it listed the tab as being on app.*.
    let writing = false
    const navigatesFirst = interceptOnce(
      (method, params) => {
        if (params.functionDeclaration === WRITE_ORIGIN_STORAGE_FUNCTION) writing = true
        return writing && method === 'Target.attachToTarget' && params.targetId === tab
      },
      async () => {
        await evaluate(tab, `location.href = ${JSON.stringify(other)}`).catch(() => {})
        await waitForLoad(tab, other)
      },
    )

    const result = await restoreSiteStorage(navigatesFirst, bundle)

    expect(await evaluate(tab, 'location.origin')).toBe(originOf('other-site.localhost'))
    expect(await evaluate(tab, `sessionStorage.getItem('token')`)).toBeNull()
    expect(result.sessionStorageSkipped).toEqual([originOf(`app.${SITE}`)])
  })
})

describe('pending sessionStorage', () => {
  const pendingBundle = () => bundleFor([{ ...localToken(`app.${SITE}`, 'account-b'), sessionStorage: [['token', 'secret']] }])

  it('writes saved entries into a tab opened on the origin after the restore', async () => {
    await restoreSiteStorage(cdp, pendingBundle())
    const tab = await openTab(`app.${SITE}`)

    expect(await applyPendingSessionStorage(cdp)).toEqual([originOf(`app.${SITE}`)])
    await waitForLoad(tab, `${originOf(`app.${SITE}`)}/app`)
    expect(await evaluate(tab, `sessionStorage.getItem('token')`)).toBe('secret')
  })

  it('keeps entries pending when the tab navigated to another site before the write', async () => {
    await restoreSiteStorage(cdp, pendingBundle())
    const tab = await openTab(`app.${SITE}`)
    const other = `${originOf('other-site.localhost')}/landing`
    const navigatesFirst = interceptOnce(
      (method, params) => method === 'Target.attachToTarget' && params.targetId === tab,
      async () => {
        await evaluate(tab, `location.href = ${JSON.stringify(other)}`).catch(() => {})
        await waitForLoad(tab, other)
      },
    )

    expect(await applyPendingSessionStorage(navigatesFirst)).toEqual([])
    expect(await evaluate(tab, `sessionStorage.getItem('token')`)).toBeNull()
  })
})

describe('replacement and rollback scope', () => {
  it('clears state of the previous login on site origins the new bundle does not have', async () => {
    const app = await openTab(`app.${SITE}`)
    const other = await openTab(`other.${SITE}`)
    await evaluate(other, `localStorage.setItem('token', 'account-a'); sessionStorage.setItem('token', 'account-a')`)

    await restoreSiteStorage(cdp, bundleFor([localToken(`app.${SITE}`, 'account-b')]))

    expect(await evaluate(app, `localStorage.getItem('token')`)).toBe('account-b')
    expect(await evaluate(other, `[localStorage.getItem('token'), sessionStorage.getItem('token')]`)).toEqual([null, null])
  })

  it('puts the previous state back, including origins it did not have, when a write fails', async () => {
    const app = await openTab(`app.${SITE}`)
    await evaluate(app, `localStorage.setItem('token', 'account-a'); document.cookie = 'sid=account-a; path=/'`)
    const incoming = bundleFor(
      [localToken(`fresh.${SITE}`, 'account-b'), localToken(`app.${SITE}`, 'account-b')],
      [{ name: 'sid', value: 'account-b', domain: `app.${SITE}`, path: '/', httpOnly: false, secure: false }],
    )

    // Origins are written in bundle order, so the second write fails after fresh.* was written.
    await expect(restoreSiteStorage(failingWrites(2, 2), incoming)).rejects.toThrow('injected write failure; the previous state was put back')

    expect(await evaluate(app, `[localStorage.getItem('token'), document.cookie]`)).toEqual(['account-a', 'sid=account-a'])
    const fresh = await openTab(`fresh.${SITE}`)
    expect(await evaluate(fresh, `localStorage.getItem('token')`)).toBeNull()
  })

  it('clears the site when the previous state cannot be put back either', async () => {
    const app = await openTab(`app.${SITE}`)
    await evaluate(app, `localStorage.setItem('token', 'account-a'); document.cookie = 'sid=account-a; path=/'`)
    const incoming = bundleFor(
      [localToken(`fresh.${SITE}`, 'account-b'), localToken(`app.${SITE}`, 'account-b')],
      [{ name: 'sid', value: 'account-b', domain: `app.${SITE}`, path: '/', httpOnly: false, secure: false }],
    )

    await expect(restoreSiteStorage(failingWrites(2), incoming))
      .rejects.toThrow('injected write failure; the previous state could not be put back, so the site was cleared')

    expect(await evaluate(app, `[localStorage.getItem('token'), document.cookie]`)).toEqual([null, ''])
    const fresh = await openTab(`fresh.${SITE}`)
    expect(await evaluate(fresh, `localStorage.getItem('token')`)).toBeNull()
  })
})
