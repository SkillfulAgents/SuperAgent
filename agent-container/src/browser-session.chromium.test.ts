// Real-Chromium tests for saved sessions: capture and restore over our own
// browser-level CDP connection, beside a page Playwright drives as the agent
// would. *.localhost resolves to loopback and is a secure context, so service
// workers work over plain http. Skipped when no Chromium is installed.
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { CdpConnection } from './login-cdp'
import { captureSession, restoreSession, SessionRestoreError, type SessionScope } from './browser-session'
import type { SessionBundle } from './browser-session-schema'
import { MAX_LOCAL_STORAGE_VALUE_CHARS, WRITE_ORIGIN_STORAGE_FUNCTION } from './browser-session-script'

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
    const result = await captureSession(cdp, scope())
    if (result.unchanged) throw new Error('expected a capture')
    return result.bundle
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

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab))

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

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab))

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

    await restoreSession(cdp, scope(), tampered, await targetIdOf(agentTab))

    expect(await cookieNames()).not.toContain('other.localhost planted=x')
    const sibling = await open(SIBLING_HOST)
    expect(await sibling.evaluate(() => localStorage.getItem('token'))).toBeNull()
  })

  it('does not let the sign-in page write its state back over the restored one on its way out', async () => {
    await signIn('alice')
    const bundle = await capture()
    const agentTab = await open(SITE_HOST, '/login')
    await agentTab.waitForFunction(() => (window as unknown as { db?: unknown }).db)

    await restoreSession(cdp, scope(), bundle, await targetIdOf(agentTab))

    // The page held an IndexedDB connection open, and wrote on pagehide: neither got in the way.
    expect(await agentTab.evaluate(() => [localStorage.getItem('token'), sessionStorage.getItem('flow')])).toEqual(['alice', null])
  })

  it('does not let a service worker run the site\'s code on the stub', async () => {
    const page = await open(SITE_HOST)
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
    await signIn('alice')

    const bundle = await capture()
    await restoreSession(cdp, scope(), bundle, await targetIdOf(page))

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

    const failure = await restoreSession(failingSecondWrite, scope(), bundle, await targetIdOf(agentTab)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SessionRestoreError)
    expect(failure).toMatchObject({ touched: true, cleared: true })
    expect(await cookieNames()).toEqual([])
    expect(agentTab.url()).toBe(`${originOf(SITE_HOST)}/login`)
    expect(await agentTab.evaluate(() => localStorage.getItem('token'))).toBeNull()
    const subdomain = await open(`app.${SITE_HOST}`)
    expect(await subdomain.evaluate(() => localStorage.getItem('token'))).toBeNull()
  })

  it('reads nothing more while the site\'s cookies have not changed since the last capture', async () => {
    await signIn('alice')
    const first = await captureSession(cdp, scope())
    const again = await captureSession(cdp, scope(), { unlessCookieHash: first.cookieHash })
    await context.addCookies([cookie('sid', 'alice-approved', SITE_HOST)])
    const changed = await captureSession(cdp, scope(), { unlessCookieHash: first.cookieHash })

    expect(again).toEqual({ unchanged: true, cookieHash: first.cookieHash })
    expect(changed.unchanged).toBe(false)
    expect(changed.cookieHash).not.toBe(first.cookieHash)
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
})
