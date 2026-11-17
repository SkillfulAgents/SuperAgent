// Real-Chromium tests for saved sessions: capture and restore over our own
// browser-level CDP connection, beside a page Playwright drives as the agent
// would. *.localhost resolves to loopback and is a secure context, so service
// workers work over plain http. Skipped when no Chromium is installed.
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Dialog, type Page } from 'playwright-core'
import { CdpConnection } from './login-cdp'
import { captureSession, restoreSession, SessionRestoreError, type SessionScope, type SettleTiming } from './browser-session'
import type { SessionBundle } from './browser-session-schema'
import {
  MAX_INDEXEDDB_DATABASE_MS,
  MAX_INDEXEDDB_VALUE_DEPTH,
  MAX_LOCAL_STORAGE_VALUE_CHARS,
  WRITE_ORIGIN_STORAGE_FUNCTION,
} from './browser-session-script'

function findChromium(): string | null {
  const candidates = [
    process.env.LOGIN_TEST_CHROMIUM,
    (() => { try { return chromium.executablePath() } catch { return undefined } })(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate)) ?? null
}

const CHROMIUM = findChromium()

// The agent's tab settles at once after a restore, but where the settle is what is tested: SETTLE_TIMING waits 5 s at least.
const FAST_SETTLE: SettleTiming = { minMs: 0, quietMs: 200, movedQuietMs: 200, maxMs: 2_000 }

// A tenant of a shared domain: its sibling is another account's.
const SITE_HOST = 'acme.tenant.localhost'
const SIBLING_HOST = 'beta.tenant.localhost'

const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname === '/__superagent_session__') {
    event.respondWith(new Response('<script>localStorage.setItem("siteCodeRan", "yes")</script>', { headers: { 'Content-Type': 'text/html' } }));
  }
});`

// A sign-in page as some apps are: it keeps an IndexedDB connection open, and
// writes its (signed-out) state back to storage on its way out.
const LOGIN_PAGE = `<!doctype html><title>Sign in</title><input type="password">
<script>
  const r = indexedDB.open('auth', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { window.db = r.result; };
  addEventListener('pagehide', () => { localStorage.setItem('token', 'written-on-unload'); sessionStorage.setItem('flow', 'unload'); });
</script>`

// An app as many are: it reads its token once, keeps it in memory, and writes it back on its own.
const APP_PAGE = `<!doctype html><title>App</title>
<script>
  const token = localStorage.getItem('token');
  const keep = () => { if (token) localStorage.setItem('token', token); };
  setInterval(keep, 20);
  addEventListener('storage', keep);
</script>`

// A sign-in page that, like Google's, checks for a session in its scripts a moment after it loads, and moves on when there is one.
const PASSIVE_PAGE = `<!doctype html><title>Sign in</title><input type="password">
<script>
  addEventListener('load', () => setTimeout(async () => {
    const { signedIn } = await (await fetch('/whoami')).json();
    if (signedIn) location.replace('/app');
  }, 400));
</script>`

// A page holding a request open (a long poll), as mail and chat apps do.
const POLLING_PAGE = `<!doctype html><title>Inbox</title><script>fetch('/never').catch(() => {})</script>`

// A page that keeps a database open (?db=) and does not let go of it when the site deletes or upgrades it elsewhere.
const HOLDER_PAGE = `<!doctype html><title>Holder</title>
<script>
  const r = indexedDB.open(new URLSearchParams(location.search).get('db'), 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv').put('v', 'k');
  r.onsuccess = () => { window.db = r.result; window.ready = true; };
</script>`

describe.skipIf(!CHROMIUM)('saved sessions in real Chromium', { timeout: 60_000 }, () => {
  let server: http.Server
  let port = 0
  let userDataDir = ''
  let browserWs = ''
  let context: BrowserContext
  let cdp: CdpConnection
  const opened: Page[] = []

  const originOf = (host: string) => `http://${host}:${port}`
  const scope = (): SessionScope => ({ site: `${SITE_HOST}:${port}`, origin: originOf(SITE_HOST) })

  async function open(host: string, pathname = '/app'): Promise<Page> {
    const page = await context.newPage()
    opened.push(page)
    await page.goto(`${originOf(host)}${pathname}`)
    return page
  }

  async function targetIdOf(page: Page): Promise<string> {
    const session = await context.newCDPSession(page)
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo')
      return targetInfo.targetId
    } finally {
      await session.detach()
    }
  }

  const cookie = (name: string, value: string, domain: string) => ({ name, value, domain, path: '/' })
  const cookieNames = async () => (await context.cookies()).map((c) => `${c.domain} ${c.name}=${c.value}`).sort()

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname === '/sw.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SERVICE_WORKER)
      else if (pathname === '/login') res.writeHead(200, { 'Content-Type': 'text/html' }).end(LOGIN_PAGE)
      else if (pathname === '/spa') res.writeHead(200, { 'Content-Type': 'text/html' }).end(APP_PAGE)
      else if (pathname === '/passive') res.writeHead(200, { 'Content-Type': 'text/html' }).end(PASSIVE_PAGE)
      else if (pathname === '/polling') res.writeHead(200, { 'Content-Type': 'text/html' }).end(POLLING_PAGE)
      else if (pathname === '/holder') res.writeHead(200, { 'Content-Type': 'text/html' }).end(HOLDER_PAGE)
      else if (pathname === '/whoami') {
        const signedIn = /(^|; )sid=alice(;|$)/.test(req.headers.cookie ?? '')
        setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ signedIn })), 600)
      } else if (pathname === '/never') setTimeout(() => { if (!res.destroyed) res.writeHead(204).end() }, 9_000).unref()
      else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>app</title>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-chromium-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROMIUM!,
      headless: true,
      args: ['--no-sandbox', '--remote-debugging-port=0'],
    })
    const portFile = path.join(userDataDir, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    const [debugPort, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n')
    browserWs = `ws://127.0.0.1:${debugPort}${browserPath}`
    cdp = await CdpConnection.openBrowser(browserWs, { callTimeoutMs: 20_000 })
  }, 60_000)

  afterEach(async () => {
    for (const page of opened.splice(0)) await page.close().catch(() => {})
    await context.clearCookies()
    const page = await context.newPage()
    for (const host of [SITE_HOST, SIBLING_HOST, `app.${SITE_HOST}`]) {
      await page.goto(`${originOf(host)}/app`)
      await page.evaluate(async () => {
        localStorage.clear()
        sessionStorage.clear()
        for (const info of await indexedDB.databases()) if (info.name) indexedDB.deleteDatabase(info.name)
        for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister()
        const files = await navigator.storage.getDirectory()
        for await (const name of (files as unknown as { keys(): AsyncIterable<string> }).keys()) await files.removeEntry(name, { recursive: true })
      })
    }
    await page.close()
  })

  afterAll(async () => {
    cdp?.close()
    await context?.close().catch(() => {})
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  async function signIn(account: string): Promise<Page> {
    await context.addCookies([
      cookie('sid', account, SITE_HOST),
      cookie('device', `${account}-device`, '.tenant.localhost'),
      cookie('api', account, `api.${SITE_HOST}`),
    ])
    const page = await open(SITE_HOST)
    await page.evaluate(async (who) => {
      localStorage.setItem('token', who)
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('auth', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('kv')
        r.onsuccess = () => resolve(r.result)
      })
      await new Promise((resolve) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put({ who, at: new Date(5), bytes: new Uint8Array([1, 2]) }, 'session')
        tx.oncomplete = resolve
      })
      db.close()
    }, account)
    return page
  }

  async function capture(): Promise<SessionBundle> {
    const { bundle } = await captureSession(cdp, scope())
    if (!bundle) throw new Error('expected a capture')
    return bundle
  }

  /** Alice's session captured, then the browser signed in as Bob, with the agent on the sign-in page. */
  async function aliceSavedBobSignedIn(): Promise<{ bundle: SessionBundle; agentTab: Page }> {
    await signIn('alice')
    const bundle = await capture()
    for (const page of opened.splice(0)) await page.close()
    await context.clearCookies()
    await signIn('bob')
    return { bundle, agentTab: await open(SITE_HOST, '/login') }
  }

  const tokenIn = (page: Page) => page.evaluate(() => localStorage.getItem('token'))

  /** A database of the site's holding one record that only the page can make: nested `nested` deep (in objects or Maps), or a blob. */
  async function putRecord(page: Page, database: string, value: { nested: number; in: 'object' | 'map' } | { blob: number }): Promise<void> {
    await page.evaluate(async ({ database, value }) => {
      let record: unknown = { leaf: true }
      if ('blob' in value) record = new Blob(['x'.repeat(value.blob)], { type: 'text/plain' })
      else for (let i = 0; i < value.nested; i++) record = value.in === 'map' ? new Map([['a', record]]) : { a: record }
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open(database, 1)
        r.onupgradeneeded = () => r.result.createObjectStore('kv')
        r.onsuccess = () => resolve(r.result)
      })
      await new Promise((resolve) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put(record, 'k')
        tx.oncomplete = resolve
      })
      db.close()
    }, { database, value })
  }

  /** The site deleting one of its databases, held up by a tab of its own that keeps it open. */
  async function deletionHeldUp(database: string): Promise<{ holder: Page; site: Page }> {
    const holder = await open(SITE_HOST, `/holder?db=${database}`)
    await holder.waitForFunction(() => (window as unknown as { ready?: boolean }).ready)
    const site = await open(SITE_HOST)
    expect(await site.evaluate((name) => new Promise((resolve) => {
      const deleting = indexedDB.deleteDatabase(name)
      deleting.onblocked = () => resolve('blocked')
      deleting.onsuccess = () => { (window as unknown as { deleted?: boolean }).deleted = true; resolve('deleted') }
    }), database)).toBe('blocked')
    return { holder, site }
  }

  it('captures the site\'s cookies (its host, subdomains, parent domain) and storage, never a sibling tenant\'s', async () => {
    await signIn('alice')
    await context.addCookies([cookie('sid', 'bob', SIBLING_HOST), cookie('x', 'y', 'other.localhost')])
    const sibling = await open(SIBLING_HOST)
    await sibling.evaluate(() => localStorage.setItem('token', 'bob'))

    const bundle = await capture()

    expect(bundle.cookies.map((c) => `${c.domain} ${c.name}=${c.value}`).sort()).toEqual([
      '.tenant.localhost device=alice-device',
      `${SITE_HOST} sid=alice`,
      `api.${SITE_HOST} api=alice`,
    ])
    expect(bundle.origins.map((origin) => origin.origin)).toEqual([originOf(SITE_HOST)])
    expect(bundle.origins[0].localStorage).toEqual([['token', 'alice']])
    expect(bundle.origins[0].indexedDB.map((db) => db.name)).toEqual(['auth'])
  })

  it('keeps a site on a port to the cookies its port set: another port of the host is another site', async () => {
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=other-port; Path=/' }).end('<!doctype html><title>other</title>')
    })
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    try {
      const otherPort = (other.address() as { port: number }).port
      const page = await open(SITE_HOST)
      await page.goto(`http://${SITE_HOST}:${otherPort}/`)
      await page.goto(`${originOf(SITE_HOST)}/app`)
      await page.evaluate(() => { document.cookie = 'mine=this-port; path=/' })

      const bundle = await capture()

      expect(bundle.cookies.map((c) => `${c.name}=${c.value}`)).toEqual(['mine=this-port'])
    } finally {
      // The browser keeps its connection alive: close it rather than wait it out.
      other.closeAllConnections()
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
  })

  it('puts a captured session back, with IndexedDB values intact, in place of another account\'s', async () => {
    await signIn('alice')
    const bundle = await capture()
    for (const page of opened.splice(0)) await page.close()
    await context.clearCookies()
    await signIn('bob')
    const agentTab = await open(SITE_HOST, '/login')
    await agentTab.evaluate(() => sessionStorage.setItem('flow', 'bob'))

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE)

    expect(await cookieNames()).toEqual([
      '.tenant.localhost device=alice-device',
      `${SITE_HOST} sid=alice`,
      `api.${SITE_HOST} api=alice`,
    ])
    expect(agentTab.url()).toBe(`${originOf(SITE_HOST)}/login`)
    expect(await agentTab.evaluate(() => [localStorage.getItem('token'), sessionStorage.getItem('flow')])).toEqual(['alice', null])
    expect(await agentTab.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('auth'); r.onsuccess = () => resolve(r.result) })
      const value = await new Promise<{ who: string; at: Date; bytes: Uint8Array }>((resolve) => {
        const r = db.transaction('kv').objectStore('kv').get('session')
        r.onsuccess = () => resolve(r.result)
      })
      db.close()
      return { who: value.who, at: value.at.getTime(), bytes: [...value.bytes] }
    })).toEqual({ who: 'alice', at: 5, bytes: [1, 2] })
  })

  it('leaves no trace of the account signed in before, on origins the bundle lacks or tabs it never saw', async () => {
    await signIn('alice')
    const bundle = await capture()
    const subdomain = await open(`app.${SITE_HOST}`)
    await subdomain.evaluate(() => { localStorage.setItem('token', 'bob'); sessionStorage.setItem('flow', 'bob') })
    await context.addCookies([cookie('stale', 'bob', SITE_HOST)])
    const agentTab = await open(SITE_HOST, '/login')

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE)

    expect(await subdomain.evaluate(() => [localStorage.getItem('token'), sessionStorage.getItem('flow')])).toEqual([null, null])
    expect(await cookieNames()).not.toContain(`${SITE_HOST} stale=bob`)
  })

  it('writes only what is the site\'s, whatever the bundle holds', async () => {
    await signIn('alice')
    const bundle = await capture()
    const tampered: SessionBundle = {
      ...bundle,
      cookies: [...bundle.cookies, { name: 'planted', value: 'x', domain: 'other.localhost', path: '/', httpOnly: false, secure: false }],
      origins: [...bundle.origins, { origin: originOf(SIBLING_HOST), localStorage: [['token', 'planted']], indexedDB: [] }],
    }
    const agentTab = await open(SITE_HOST, '/login')

    await restoreSession(cdp, scope(), tampered, await targetIdOf(agentTab), FAST_SETTLE)

    expect(await cookieNames()).not.toContain('other.localhost planted=x')
    const sibling = await open(SIBLING_HOST)
    expect(await sibling.evaluate(() => localStorage.getItem('token'))).toBeNull()
  })

  it('does not let the sign-in page write its state back over the restored one on its way out', async () => {
    await signIn('alice')
    const bundle = await capture()
    const agentTab = await open(SITE_HOST, '/login')
    await agentTab.waitForFunction(() => (window as unknown as { db?: unknown }).db)

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE)

    // The page held an IndexedDB connection open, and wrote on pagehide: neither got in the way.
    expect(await agentTab.evaluate(() => [localStorage.getItem('token'), sessionStorage.getItem('flow')])).toEqual(['alice', null])
  })

  it('does not let a service worker run the site\'s code on the stub', async () => {
    const page = await open(SITE_HOST)
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
    await signIn('alice')

    const bundle = await capture()
    await restoreSession(cdp, scope(), bundle, await targetIdOf(page), FAST_SETTLE)

    expect(await page.evaluate(() => localStorage.getItem('siteCodeRan'))).toBeNull()
  })

  it('empties the site when a write fails, rather than leave two accounts\' state mixed', async () => {
    await signIn('alice')
    const bundle: SessionBundle = {
      ...(await capture()),
      origins: [
        { origin: originOf(`app.${SITE_HOST}`), localStorage: [['token', 'alice']], indexedDB: [] },
        { origin: originOf(SITE_HOST), localStorage: [['token', 'alice']], indexedDB: [] },
      ],
    }
    for (const page of opened.splice(0)) await page.close()
    await context.clearCookies()
    await signIn('bob')
    const agentTab = await open(SITE_HOST, '/login')
    let writes = 0
    const failingSecondWrite = new Proxy(cdp, {
      get(target, property, receiver) {
        if (property !== 'send') return Reflect.get(target, property, receiver)
        return (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
          if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === WRITE_ORIGIN_STORAGE_FUNCTION && ++writes === 2) {
            return Promise.reject(new Error('injected write failure'))
          }
          return target.send(method, params, sessionId)
        }
      },
    })

    const failure = await restoreSession(failingSecondWrite, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SessionRestoreError)
    expect(failure).toMatchObject({ touched: true, changed: true, cleared: true })
    expect(await cookieNames()).toEqual([])
    expect(agentTab.url()).toBe(`${originOf(SITE_HOST)}/login`)
    expect(await agentTab.evaluate(() => localStorage.getItem('token'))).toBeNull()
    const subdomain = await open(`app.${SITE_HOST}`)
    expect(await subdomain.evaluate(() => localStorage.getItem('token'))).toBeNull()
  })

  it('fingerprints the cookies outside the site without their values, and says where the agent\'s tab is', async () => {
    await signIn('alice')
    await context.addCookies([cookie('app_session', 'alice-app-secret', SIBLING_HOST), cookie('tracker', 'id-1', 'tracker.localhost')])
    const tab = await open(SIBLING_HOST)
    const tabId = await targetIdOf(tab)

    const first = await captureSession(cdp, scope(), { peek: true, tabId })
    expect(first.tabSite).toBe(`${SIBLING_HOST}:${port}`)
    // The site's own cookies (its host, a subdomain, the parent domain's) are the session's, not outside it.
    expect(first.outside.map((outside) => outside.domain).sort()).toEqual([SIBLING_HOST, 'tracker.localhost'])
    expect(JSON.stringify(first.outside)).not.toContain('alice-app-secret')

    await context.addCookies([cookie('app_session', 'alice-app-renewed', SIBLING_HOST)])
    const later = await captureSession(cdp, scope(), { peek: true, tabId })
    const hashOf = (result: typeof first) => result.outside.find((outside) => outside.domain === SIBLING_HOST)?.valueHash
    expect(hashOf(later)).not.toBe(hashOf(first))
    expect(later.outside.find((outside) => outside.domain === 'tracker.localhost')?.valueHash)
      .toBe(first.outside.find((outside) => outside.domain === 'tracker.localhost')?.valueHash)
  })

  it('sends nothing back while the session is as it was, and sees a change to its cookies or its storage alone', async () => {
    const page = await signIn('alice')
    const first = await captureSession(cdp, scope())
    const again = await captureSession(cdp, scope(), { unlessHash: first.hash })
    const peek = await captureSession(cdp, scope(), { peek: true })
    expect(again).toEqual({ hash: first.hash, unsupported: [], outside: [], tabSite: null })
    expect(peek).toEqual({ hash: first.hash, unsupported: [], outside: [], tabSite: null })

    await context.addCookies([cookie('sid', 'alice-approved', SITE_HOST)])
    const cookieChanged = await captureSession(cdp, scope(), { unlessHash: first.hash })
    expect(cookieChanged.hash).not.toBe(first.hash)
    expect(cookieChanged.bundle?.cookies).toContainEqual(expect.objectContaining({ name: 'sid', value: 'alice-approved' }))

    // An app that keeps its session in storage (Supabase, Firebase) signs in without a cookie changing.
    await page.evaluate(() => localStorage.setItem('sb-auth-token', 'alice-jwt'))
    const stored = await captureSession(cdp, scope(), { unlessHash: cookieChanged.hash })
    expect(stored.bundle?.origins[0].localStorage).toContainEqual(['sb-auth-token', 'alice-jwt'])
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('auth'); r.onsuccess = () => resolve(r.result) })
      await new Promise((resolve) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put('refreshed', 'firebase'); tx.oncomplete = resolve })
      db.close()
    })
    expect((await captureSession(cdp, scope(), { unlessHash: stored.hash })).bundle).toBeDefined()
  })

  it('leaves out caches: a large localStorage value and a database with many records', async () => {
    await signIn('alice')
    const page = opened[opened.length - 1]
    await page.evaluate(async (size) => {
      localStorage.setItem('cache', 'x'.repeat(size + 1))
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('messages', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('m')
        r.onsuccess = () => resolve(r.result)
      })
      await new Promise((resolve) => {
        const tx = db.transaction('m', 'readwrite')
        for (let i = 0; i < 2_500; i++) tx.objectStore('m').put({ i }, i)
        tx.oncomplete = resolve
      })
      db.close()
    }, MAX_LOCAL_STORAGE_VALUE_CHARS)

    const bundle = await capture()

    expect(bundle.leftOut).toBe(2)
    expect(bundle.origins[0].localStorage.map(([key]) => key)).toEqual(['token'])
    expect(bundle.origins[0].indexedDB.map((db) => db.name)).toEqual(['auth'])
  })

  it('keeps its reading tab out of the tab list while it reads, and closes it', async () => {
    await signIn('alice')
    const pagesBefore = context.pages().length
    await capture()
    expect(context.pages().length).toBe(pagesBefore)
  })

  it('parks the site\'s other tabs too: an app holding the old account in memory cannot write it back', async () => {
    const { bundle, agentTab } = await aliceSavedBobSignedIn()
    const app = await open(SITE_HOST, '/spa')
    await new Promise((resolve) => setTimeout(resolve, 100))

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(await tokenIn(agentTab)).toBe('alice')
    // It came back to its page, which read the restored account.
    expect(app.url()).toBe(`${originOf(SITE_HOST)}/spa`)
    expect(await tokenIn(app)).toBe('alice')
  })

  it('takes a parent domain\'s Domain cookies, never the parent host\'s own, and leaves those in place', async () => {
    await signIn('alice')
    await context.addCookies([{ name: 'parent_sid', value: 'owner', url: `http://tenant.localhost:${port}/` }])
    const bundle = await capture()
    expect(bundle.cookies.map((c) => c.name)).not.toContain('parent_sid')

    const agentTab = await open(SITE_HOST, '/login')
    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE)
    expect(await cookieNames()).toContain('tenant.localhost parent_sid=owner')
  })

  it('replaces a site that holds a cookie with no name', async () => {
    const { bundle, agentTab } = await aliceSavedBobSignedIn()
    await agentTab.evaluate(() => { document.cookie = 'nameless-bob' })
    expect(await cookieNames()).toContain(`${SITE_HOST} =nameless-bob`)

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE)

    expect(await cookieNames()).not.toContain(`${SITE_HOST} =nameless-bob`)
    expect(await cookieNames()).toContain(`${SITE_HOST} sid=alice`)
  })

  it('leaves the site as it was when a restore fails before changing anything', async () => {
    await signIn('alice')
    const bundle = await capture()
    for (const page of opened.splice(0)) await page.close()
    await context.clearCookies()
    // On a page with no writer of its own on the way out.
    const agentTab = await signIn('bob')
    const failingCookieRead = new Proxy(cdp, {
      get(target, property, receiver) {
        if (property !== 'send') return Reflect.get(target, property, receiver)
        return (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
          method === 'Storage.getCookies' ? Promise.reject(new Error('injected read failure')) : target.send(method, params, sessionId)
      },
    })

    const failure = await restoreSession(failingCookieRead, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE).catch((error: unknown) => error)

    expect(failure).toMatchObject({ touched: true, changed: false, cleared: false })
    expect(await cookieNames()).toContain(`${SITE_HOST} sid=bob`)
    expect(await tokenIn(agentTab)).toBe('bob')
    expect(agentTab.url()).toBe(`${originOf(SITE_HOST)}/app`)
  })

  it('empties the origin private file system too, and leaves no stub in the tab\'s history', async () => {
    const { bundle, agentTab } = await aliceSavedBobSignedIn()
    await agentTab.evaluate(async () => {
      const file = await (await navigator.storage.getDirectory()).getFileHandle('bob-cache', { create: true })
      const writable = await (file as unknown as { createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> }).createWritable()
      await writable.write('bob')
      await writable.close()
    })

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE)

    expect(await agentTab.evaluate(async () => {
      const names: string[] = []
      for await (const name of (await navigator.storage.getDirectory() as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name)
      return names
    })).toEqual([])
    expect(await agentTab.evaluate(() => history.length)).toBe(1)
    expect(agentTab.url()).toBe(`${originOf(SITE_HOST)}/login`)
  })

  it('lets the agent\'s tab settle: a sign-in page the restored session moves on by itself is left where it went, once it went', async () => {
    await signIn('alice')
    const bundle = await capture()
    for (const page of opened.splice(0)) await page.close()
    await context.clearCookies()
    const agentTab = await open(SITE_HOST, '/passive')

    const outcome = await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab))

    expect(await agentTab.evaluate(() => location.pathname)).toBe('/app')
    expect(outcome.settled?.movedTo).toBe(`${SITE_HOST}:${port}`)
    // It moved about a second after the load: settled a second after that, not at the 5 s given to a page that stays.
    expect(outcome.settled!.waitedMs).toBeLessThan(4_000)
  })

  it('gives a page that stays put its minimum, and does not let a long poll hold it to the limit', async () => {
    const { bundle, agentTab } = await aliceSavedBobSignedIn()

    const still = await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab))
    expect(still.settled).toMatchObject({ movedTo: null })
    expect(still.settled!.waitedMs).toBeGreaterThanOrEqual(5_000)
    expect(still.settled!.waitedMs).toBeLessThan(6_500)

    const inbox = await open(SITE_HOST, '/polling')
    const polling = await restoreSession(cdp, scope(), bundle, await targetIdOf(inbox))
    expect(polling.settled).toMatchObject({ movedTo: null })
    expect(polling.settled!.waitedMs).toBeLessThan(7_000)
  })

  it('sends a tab that showed no page back to it', async () => {
    await signIn('alice')
    const bundle = await capture()
    const blank = await context.newPage()
    opened.push(blank)

    await restoreSession(cdp, scope(), bundle, await targetIdOf(blank), FAST_SETTLE)

    expect(blank.url()).toBe('about:blank')
    const page = await open(SITE_HOST)
    expect(await tokenIn(page)).toBe('alice')
  })

  it('finds a subdomain\'s storage on the site\'s port by its cookie, with no tab open there', async () => {
    await signIn('alice')
    await context.addCookies([cookie('app_sid', 'alice', `app.${SITE_HOST}`)])
    const app = await open(`app.${SITE_HOST}`)
    await app.evaluate(() => localStorage.setItem('token', 'alice-app'))
    await app.close()

    const bundle = await capture()

    expect(bundle.origins.map((origin) => origin.origin)).toContain(originOf(`app.${SITE_HOST}`))
  })

  it('leaves out a database holding a value too big for a session, without reading it all, and keeps the rest', async () => {
    const page = await signIn('alice')
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('media', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('files')
        r.onsuccess = () => resolve(r.result)
      })
      await new Promise((resolve) => {
        const tx = db.transaction('files', 'readwrite')
        for (let i = 0; i < 3; i++) tx.objectStore('files').put(new ArrayBuffer(4_000_000), i)
        tx.oncomplete = resolve
      })
      db.close()
    })

    const bundle = await capture()

    expect(bundle.leftOut).toBe(1)
    expect(bundle.origins[0].indexedDB.map((db) => db.name)).toEqual(['auth'])
  })

  it('leaves out a database that does not open in time (the site\'s own deletion of it is held up), and keeps the rest', async () => {
    await signIn('alice')
    await deletionHeldUp('cache')

    const started = Date.now()
    const bundle = await capture()

    // Not the call's 20 s limit, failing the capture.
    expect(Date.now() - started).toBeLessThan(MAX_INDEXEDDB_DATABASE_MS + 5_000)
    expect(bundle.leftOut).toBe(1)
    expect(bundle.origins[0].indexedDB.map((db) => db.name)).toEqual(['auth'])
  })

  it('never makes a database again that the site deleted while it was being read', async () => {
    await signIn('alice')
    const { holder, site } = await deletionHeldUp('cache')

    // Listed, then waiting to open until the site's deletion goes through.
    const capturing = capture()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await holder.evaluate(() => (window as unknown as { db: IDBDatabase }).db.close())
    const bundle = await capturing

    expect(bundle.origins[0].indexedDB.map((db) => db.name)).toEqual(['auth'])
    await site.waitForFunction(() => (window as unknown as { deleted?: boolean }).deleted)
    expect(await site.evaluate(async () => (await indexedDB.databases()).map((info) => info.name))).toEqual(['auth'])
    // The site's own open makes it afresh, as it first did.
    expect(await site.evaluate(() => new Promise((resolve) => {
      const opening = indexedDB.open('cache', 1)
      let upgraded = false
      opening.onupgradeneeded = () => { upgraded = true; opening.result.createObjectStore('kv') }
      opening.onsuccess = () => { opening.result.close(); resolve(upgraded) }
    }))).toBe(true)
  })

  it('leaves out a database holding a value nested too deep to come back, and keeps one nested as deep as it may be', async () => {
    const page = await signIn('alice')
    // Past what a call's result carries (about 290 levels): the whole capture failed on it.
    await putRecord(page, 'deep', { nested: 400, in: 'object' })
    // Encoded three levels for each of its own, a Map's nesting is the deepest a kept value makes.
    await putRecord(page, 'maps', { nested: MAX_INDEXEDDB_VALUE_DEPTH - 1, in: 'map' })

    const bundle = await capture()

    expect(bundle.leftOut).toBe(1)
    expect(bundle.origins[0].indexedDB.map((db) => db.name).sort()).toEqual(['auth', 'maps'])
  })

  it('leaves out a database it cannot read (a blob whose file is gone), and keeps the rest', async () => {
    const page = await signIn('alice')
    await putRecord(page, 'files', { blob: 5_000 })
    // Its file, once the page that made the blob no longer holds it.
    await page.close()
    const blobDir = path.join(userDataDir, 'Default', 'IndexedDB', `http_${SITE_HOST}_${port}.indexeddb.blob`)
    const filesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? filesIn(full) : [full]
    })
    for (let i = 0; i < 50 && filesIn(blobDir).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(filesIn(blobDir).length).toBeGreaterThan(0)
    for (const file of filesIn(blobDir)) fs.rmSync(file)
    await open(SITE_HOST)

    const bundle = await capture()

    expect(bundle.leftOut).toBe(1)
    expect(bundle.origins[0].indexedDB.map((db) => db.name)).toEqual(['auth'])
  })

  it('fails untouched while another tab on the site cannot be parked (a dialog holds its page), rather than let it write its account back later', async () => {
    const { bundle, agentTab } = await aliceSavedBobSignedIn()
    const held = await open(SITE_HOST, '/spa')
    // Left unanswered: with no listener, Playwright would dismiss it.
    const dialog = new Promise<Dialog>((resolve) => held.once('dialog', resolve))
    await held.evaluate(() => { setTimeout(() => confirm('Discard the draft?'), 0) })
    const pending = await dialog
    await agentTab.evaluate(() => { (window as unknown as { mapped?: boolean }).mapped = true })
    // The container's connection, with a call limit fit for a test (20 s there).
    const quick = await CdpConnection.openBrowser(browserWs, { callTimeoutMs: 2_000 })
    try {
      const failure = await restoreSession(quick, scope(), bundle, await targetIdOf(agentTab), FAST_SETTLE).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(SessionRestoreError)
      expect(failure).toMatchObject({ touched: false, changed: false, cleared: false })
    } finally {
      quick.close()
      await pending.dismiss()
    }
    expect(await cookieNames()).toContain(`${SITE_HOST} sid=bob`)
    // The agent's page never left: what it mapped there is still there.
    expect(await agentTab.evaluate(() => (window as unknown as { mapped?: boolean }).mapped)).toBe(true)
    expect(await tokenIn(agentTab)).toBe('bob')
  })
})
