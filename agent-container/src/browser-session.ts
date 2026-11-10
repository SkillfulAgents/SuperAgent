import { createHash, randomBytes } from 'crypto'
import type { CdpConnection } from './login-cdp'
import {
  CLEAR_SESSION_STORAGE_FUNCTION,
  READ_ORIGIN_STORAGE_FUNCTION,
  STUB_PATH,
  WRITE_ORIGIN_STORAGE_FUNCTION,
} from './browser-session-script'
import { sessionBundleSchema, type OriginStorage, type SessionBundle, type SessionCookie } from './browser-session-schema'

/**
 * Saved sessions: an account's cookies and web storage on its site, read out
 * of the browser after a sign-in (captureSession) and written into a browser
 * of the same type later (restoreSession). The host keeps them sealed in
 * between; nothing here logs or returns a value except to the host.
 *
 * The scope is the account's site as the browser sends its state there: the
 * cookies set for its host or its subdomains, the Domain cookies of a parent
 * domain (Google's session lives on .google.com, its sign-in on
 * accounts.google.com), and the localStorage and IndexedDB of its host's and
 * subdomains' origins. Never a sibling host: tenants of one domain
 * (acme.okta.com, beta.okta.com) are separate accounts. sessionStorage
 * belongs to a tab, so it is not saved; a restore empties it in the site's
 * open tabs.
 *
 * Storage needs a document of its origin, so it is read and written on a
 * blank stub document served for that origin by request interception: the
 * site is never contacted, its service worker is bypassed, and none of its
 * scripts run there. A capture reads on a hidden tab of its own, beside the
 * agent's work. A restore first parks every tab on the site on a stub of its
 * own origin, so none of the site's pages runs while its state is replaced
 * (a page on its way out, or one left running, would write its account's
 * state back), then sends each tab back to where it was.
 *
 * A restore replaces the site's state as a whole: every cookie and origin in
 * scope is emptied before the saved ones are written, so nothing of an
 * account signed in before stays beside the restored one.
 */

/** Where a saved session lives: the account's site (host without www, port kept) and the origin its sign-in page was on. */
export interface SessionScope {
  site: string
  origin: string
}

const STUB_HTML_BASE64 = Buffer.from('<!doctype html><title></title>').toString('base64')
const LOAD_TIMEOUT_MS = 15_000
/** A request in flight longer than this (a long poll) does not keep a tab from settling. */
const LONG_REQUEST_MS = 3_000
const SETTLE_POLL_MS = 100
/** What a restore empties on each origin in scope before writing (file_systems: the origin private file system). */
const CLEARED_STORAGE = 'local_storage,indexeddb,cache_storage,service_workers,file_systems'
/** The largest bundle kept, as JSON: past it, databases are left out, biggest first. */
export const MAX_BUNDLE_CHARS = 1_000_000
/** As many as a bundle holds (browser-session-schema.ts); past them, the rest is left out. */
const MAX_COOKIES = 3_000
const MAX_ORIGINS = 50

export class SessionTooLargeError extends Error {}

const hostnameOf = (site: string) => site.replace(/:\d+$/, '')
const portOf = (site: string) => /:(\d+)$/.exec(site)?.[1] ?? ''

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** A page's site as an account's is named: its host without a leading "www.", port kept. */
function siteOfUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.host.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

/**
 * Whether a cookie with this domain is in the site's scope: set for its host
 * or a subdomain, or a parent domain's Domain cookie (".example.com"), which
 * the browser sends to the host too. A parent host's own cookies (no leading
 * dot) never reach the site, so they are not its.
 */
export function cookieInScope(domain: string, site: string): boolean {
  const host = hostnameOf(site)
  const cookieHost = domain.replace(/^\./, '').toLowerCase()
  return cookieHost === host || cookieHost.endsWith(`.${host}`) || (domain.startsWith('.') && host.endsWith(`.${cookieHost}`))
}

/**
 * Whether a cookie came from the site's own port. Cookies ignore ports, so
 * two sites on one host (dev servers on localhost) see each other's; a site
 * named with a port keeps only the ones its port set, as Chrome records it
 * (`sourcePort`). Unknown is -1, and a cookie set with no port named (over
 * CDP, by a test tool) records its scheme's default: neither rules one out.
 */
export function cookieFromSitePort(sourcePort: number | undefined, site: string): boolean {
  const port = portOf(site)
  if (!port || sourcePort === undefined || sourcePort < 0 || sourcePort === 80 || sourcePort === 443) return true
  return sourcePort === Number(port)
}

/** Whether an origin's storage is in the site's scope: its host's, or a subdomain's on the site's port. */
export function originInScope(origin: string, site: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return url.host === site || (url.hostname.endsWith(`.${hostnameOf(site)}`) && url.port === portOf(site))
  } catch {
    return false
  }
}

/**
 * The origins in scope whose storage to read or empty. Chrome lists no
 * origins that hold storage, so these are the ones the browser shows: the
 * sign-in's own, the subdomains its cookies are set for (on the sign-in's
 * scheme and port), and those of the open tabs and their history (an app.*
 * the sign-in redirected to).
 */
export function candidateOrigins(scope: SessionScope, cookies: ReadonlyArray<{ domain: string }>, urls: readonly string[]): string[] {
  const origins = new Set<string>([scope.origin])
  const host = hostnameOf(scope.site)
  const scheme = scope.origin.startsWith('http://') ? 'http' : 'https'
  const port = portOf(scope.site)
  for (const cookie of cookies) {
    const cookieHost = cookie.domain.replace(/^\./, '').toLowerCase()
    if (cookieHost.endsWith(`.${host}`)) origins.add(`${scheme}://${cookieHost}${port ? `:${port}` : ''}`)
  }
  for (const url of urls) {
    const origin = originOf(url)
    if (origin && originInScope(origin, scope.site)) origins.add(origin)
  }
  return [...origins].sort()
}

interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  priority?: 'Low' | 'Medium' | 'High'
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure'
  sourcePort?: number
  partitionKey?: unknown
}

/** Every attribute Storage.setCookies takes back; a session cookie has no expiry. Null for a partition key in a form this code does not know. */
export function toSessionCookie(cookie: CdpCookie): SessionCookie | null {
  const { partitionKey } = cookie
  const partition = partitionKey === undefined
    ? undefined
    : typeof partitionKey === 'object' && partitionKey !== null &&
        typeof (partitionKey as { topLevelSite?: unknown }).topLevelSite === 'string' &&
        typeof (partitionKey as { hasCrossSiteAncestor?: unknown }).hasCrossSiteAncestor === 'boolean'
      ? partitionKey as { topLevelSite: string; hasCrossSiteAncestor: boolean }
      : null
  if (partition === null) return null
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.session ? {} : { expires: cookie.expires }),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.priority ? { priority: cookie.priority } : {}),
    ...(cookie.sourceScheme ? { sourceScheme: cookie.sourceScheme } : {}),
    ...(cookie.sourcePort !== undefined ? { sourcePort: cookie.sourcePort } : {}),
    ...(partition ? { partitionKey: partition } : {}),
  }
}

/**
 * A fingerprint of a session, values included and cookie expiries not: a
 * sign-in that completes (a push approved, a provider's redirect landing, a
 * token stored by the app) changes it; a sliding expiry being pushed out does
 * not.
 */
export function hashSession(session: Pick<SessionBundle, 'cookies' | 'origins'>): string {
  const cookies = session.cookies
    .map((cookie) => JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey?.topLevelSite ?? null, cookie.value]))
    .sort()
  const origins = session.origins
    .map((stored) => JSON.stringify([
      stored.origin,
      [...stored.localStorage].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      [...stored.indexedDB].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ]))
    .sort()
  return createHash('sha256').update([...cookies, '', ...origins].join('\n')).digest('base64url')
}

/**
 * A cookie outside the site's scope, as the outside-the-scope log compares
 * them (session-outside.ts): which cookie it is, where, and a fingerprint of
 * its value that tells only whether it changed. Never saved or sent.
 */
export interface OutsideCookie {
  /** Domain, path, name and partition. */
  key: string
  domain: string
  sourcePort?: number
  valueHash: string
}

/** Fingerprints are compared only within one run of the container. */
const OUTSIDE_SALT = randomBytes(16)

function outsideCookie(cookie: CdpCookie): OutsideCookie {
  const partition = (cookie.partitionKey as { topLevelSite?: unknown } | undefined)?.topLevelSite
  return {
    key: JSON.stringify([cookie.domain, cookie.path, cookie.name, typeof partition === 'string' ? partition : null]),
    domain: cookie.domain,
    ...(cookie.sourcePort !== undefined ? { sourcePort: cookie.sourcePort } : {}),
    valueHash: createHash('sha256').update(OUTSIDE_SALT).update(cookie.value).digest('base64url').slice(0, 16),
  }
}

/** An already-expired copy: setting it deletes the cookie. The value stays: a nameless cookie with no value is no cookie at all. */
function expired(cookie: SessionCookie): SessionCookie {
  return { ...cookie, expires: 1 }
}

// ── The browser ────────────────────────────────────────────────────────────

interface PageInfo {
  targetId: string
  url: string
  browserContextId?: string
}

/** Tabs this module opened to read storage: tab listings skip them, so neither the agent nor the live view follows one. */
const stubTargets = new Set<string>()

export function isSessionStubTarget(targetId: string): boolean {
  return stubTargets.has(targetId)
}

async function listPages(cdp: CdpConnection): Promise<PageInfo[]> {
  const { targetInfos } = await cdp.send<{ targetInfos: Array<PageInfo & { type: string }> }>('Target.getTargets')
  return targetInfos
    .filter((target) => target.type === 'page' && !stubTargets.has(target.targetId))
    .map(({ targetId, url, browserContextId }) => ({ targetId, url, browserContextId }))
}

/**
 * The browser context of the agent's tab (`tabId`, else the first page),
 * when it is not the default one (remote providers keep pages in their own):
 * cookies and new tabs must go there.
 */
async function agentContext(cdp: CdpConnection, pages: readonly PageInfo[], tabId?: string | null): Promise<Record<string, string>> {
  const contextId = (pages.find((page) => page.targetId === tabId) ?? pages[0])?.browserContextId
  if (!contextId) return {}
  const { browserContextIds } = await cdp.send<{ browserContextIds: string[] }>('Target.getBrowserContexts')
    .catch((): { browserContextIds: string[] } => ({ browserContextIds: [] }))
  return browserContextIds.includes(contextId) ? { browserContextId: contextId } : {}
}

async function browserCookies(cdp: CdpConnection, context: Record<string, string>): Promise<CdpCookie[]> {
  const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies', context)
  return cookies
}

const isSiteCookie = (cookie: CdpCookie, site: string) => cookieInScope(cookie.domain, site) && cookieFromSitePort(cookie.sourcePort, site)

function siteCookies(cookies: readonly CdpCookie[], site: string): SessionCookie[] {
  return cookies.flatMap((cookie) => {
    if (!isSiteCookie(cookie, site)) return []
    const converted = toSessionCookie(cookie)
    return converted ? [converted] : []
  })
}

async function readCookies(cdp: CdpConnection, context: Record<string, string>, site: string): Promise<SessionCookie[]> {
  return siteCookies(await browserCookies(cdp, context), site)
}

async function attach(cdp: CdpConnection, targetId: string): Promise<string> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  return sessionId
}

async function detach(cdp: CdpConnection, sessionId: string): Promise<void> {
  await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
}

/** Call a page function with arguments passed by value; a failure names no value (our scripts never put one in an error). */
async function callInPage<T>(cdp: CdpConnection, sessionId: string, functionDeclaration: string, args: unknown[] = []): Promise<T> {
  const global = await cdp.send<{ result?: { objectId?: string } }>('Runtime.evaluate', { expression: 'globalThis' }, sessionId)
  const objectId = global.result?.objectId
  if (!objectId) throw new Error('the page could not be reached')
  const response = await cdp.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  }, sessionId)
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
    throw new Error(`the page script failed${description ? `: ${description.split('\n')[0].slice(0, 200)}` : ''}`)
  }
  return response.result?.value as T
}

function loadFired(cdp: CdpConnection, sessionId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('the page did not finish loading')) }, LOAD_TIMEOUT_MS)
    const stop = cdp.onEvent((event) => {
      if (event.sessionId !== sessionId || event.method !== 'Page.loadEventFired') return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
}

/** A tab whose requests are answered here: a blank document for any origin's stub URL, nothing else. */
interface StubTab {
  /** Load the blank document of `origin` in the tab. */
  open(origin: string): Promise<void>
  call<T>(functionDeclaration: string, args?: unknown[]): Promise<T>
  /** Hand the tab's requests back to the network. */
  release(): Promise<void>
}

async function interceptStubs(cdp: CdpConnection, sessionId: string): Promise<StubTab> {
  let stubOrigin = ''
  const stop = cdp.onEvent((event) => {
    if (event.sessionId !== sessionId || event.method !== 'Fetch.requestPaused') return
    const isStub = event.params.request?.url === `${stubOrigin}${STUB_PATH}`
    void cdp.send(
      isStub ? 'Fetch.fulfillRequest' : 'Fetch.failRequest',
      isStub
        ? { requestId: event.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: STUB_HTML_BASE64 }
        : { requestId: event.params.requestId, errorReason: 'BlockedByClient' },
      sessionId,
    ).catch(() => {})
  })
  try {
    await cdp.send('Network.enable', {}, sessionId)
    // Only once Network is enabled: an installed service worker would otherwise serve the site's own page.
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }, sessionId)
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
  } catch (error) {
    stop()
    throw error
  }
  return {
    async open(origin) {
      stubOrigin = origin
      const loaded = loadFired(cdp, sessionId)
      // Awaited below; this only keeps a navigation that fails first from leaving it unhandled.
      loaded.catch(() => {})
      const navigation = await cdp.send<{ errorText?: string }>('Page.navigate', { url: `${origin}${STUB_PATH}` }, sessionId)
      if (navigation.errorText) throw new Error(`a page of ${origin} could not be opened`)
      await loaded
    },
    call: (functionDeclaration, args) => callInPage(cdp, sessionId, functionDeclaration, args),
    async release() {
      stop()
      await cdp.send('Fetch.disable', {}, sessionId).catch(() => {})
      await cdp.send('Network.setBypassServiceWorker', { bypass: false }, sessionId).catch(() => {})
    },
  }
}

/** Run `work` on a hidden tab of its own in the agent's browser context, closed after. */
async function withStubTab<T>(cdp: CdpConnection, context: Record<string, string>, work: (tab: StubTab) => Promise<T>): Promise<T> {
  const create = { url: 'about:blank', background: true, ...context }
  // Hidden keeps it out of a visible window's tab strip, where Chrome supports it.
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { ...create, hidden: true })
    .catch(() => cdp.send<{ targetId: string }>('Target.createTarget', create))
  stubTargets.add(targetId)
  try {
    const sessionId = await attach(cdp, targetId)
    const tab = await interceptStubs(cdp, sessionId)
    try {
      return await work(tab)
    } finally {
      await tab.release()
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    stubTargets.delete(targetId)
  }
}

/** URLs the open tabs show and went through (their back/forward history): an app.* a sign-in redirected to. */
async function visitedUrls(cdp: CdpConnection, pages: readonly PageInfo[]): Promise<string[]> {
  const urls = pages.map((page) => page.url)
  for (const page of pages) {
    const sessionId = await attach(cdp, page.targetId).catch(() => null)
    if (!sessionId) continue
    try {
      const { entries } = await cdp.send<{ entries: Array<{ url: string }> }>('Page.getNavigationHistory', {}, sessionId)
        .catch(() => ({ entries: [] }))
      urls.push(...entries.map((entry) => entry.url))
    } finally {
      await detach(cdp, sessionId)
    }
  }
  return urls
}

// ── Capture ────────────────────────────────────────────────────────────────

interface ReadOrigin {
  localStorage: Array<[string, string]>
  indexedDB: OriginStorage['indexedDB']
  leftOut: number
  unsupported: string[]
}

/** A read of the site's session: its fingerprint, and the session itself unless only the fingerprint was asked for or it had not changed. */
export interface CaptureResult {
  hash: string
  bundle?: SessionBundle
  unsupported: string[]
  /** Every cookie outside the site's scope, fingerprinted, for the outside-the-scope log. */
  outside: OutsideCookie[]
  /** The site of the agent's tab, when it shows a web page. */
  tabSite: string | null
}

/** Leave databases out, biggest first, until the bundle fits; past that it is not kept at all. */
function fitBundle(bundle: SessionBundle): SessionBundle {
  let size = JSON.stringify(bundle).length
  if (size <= MAX_BUNDLE_CHARS) return bundle
  const origins = bundle.origins.map((origin) => ({ ...origin, indexedDB: [...origin.indexedDB] }))
  let leftOut = bundle.leftOut ?? 0
  while (size > MAX_BUNDLE_CHARS) {
    let biggest: { origin: number; database: number; size: number } | null = null
    origins.forEach((origin, o) => origin.indexedDB.forEach((database, d) => {
      const databaseSize = JSON.stringify(database).length
      if (!biggest || databaseSize > biggest.size) biggest = { origin: o, database: d, size: databaseSize }
    }))
    if (!biggest) throw new SessionTooLargeError('The site keeps more in the browser than a saved session can hold')
    const { origin, database, size: dropped } = biggest
    origins[origin].indexedDB.splice(database, 1)
    leftOut++
    size -= dropped
  }
  return { ...bundle, origins: origins.filter((origin) => origin.localStorage.length > 0 || origin.indexedDB.length > 0), leftOut }
}

/**
 * Read the site's session out of the browser: its cookies, and the storage
 * of its origins on a hidden tab. `peek` asks only for the fingerprint (the
 * state before a sign-in step, for later reads to be compared with); with
 * `unlessHash`, a session with that fingerprint comes back without its
 * contents: nothing about it changed since. `tabId` is the agent's tab.
 */
export async function captureSession(
  cdp: CdpConnection,
  scope: SessionScope,
  options: { unlessHash?: string; peek?: boolean; tabId?: string | null } = {},
): Promise<CaptureResult> {
  const pages = await listPages(cdp)
  if (pages.length === 0) throw new Error('no browser page is open')
  const context = await agentContext(cdp, pages, options.tabId)
  const everyCookie = await browserCookies(cdp, context)
  const cookies = siteCookies(everyCookie, scope.site)
  const outside = everyCookie.filter((cookie) => !isSiteCookie(cookie, scope.site)).map(outsideCookie)
  const tabSite = siteOfUrl(pages.find((page) => page.targetId === options.tabId)?.url)
  let leftOut = Math.max(0, cookies.length - MAX_COOKIES)
  const candidates = candidateOrigins(scope, cookies, await visitedUrls(cdp, pages))
  const unsupported = new Set<string>()
  const origins = await withStubTab(cdp, context, async (tab) => {
    const read: OriginStorage[] = []
    for (const origin of candidates) {
      await tab.open(origin)
      const stored = await tab.call<ReadOrigin>(READ_ORIGIN_STORAGE_FUNCTION, [origin])
      leftOut += stored.leftOut
      for (const type of stored.unsupported) unsupported.add(type)
      if (stored.localStorage.length === 0 && stored.indexedDB.length === 0) continue
      if (read.length < MAX_ORIGINS) read.push({ origin, localStorage: stored.localStorage, indexedDB: stored.indexedDB })
      else leftOut++
    }
    return read
  })
  const bundle = sessionBundleSchema.parse(fitBundle({
    version: 1,
    site: scope.site,
    capturedAt: new Date().toISOString(),
    cookies: cookies.slice(0, MAX_COOKIES),
    origins,
    ...(leftOut > 0 ? { leftOut } : {}),
  }))
  const hash = hashSession(bundle)
  if (options.peek || options.unlessHash === hash) return { hash, unsupported: [...unsupported], outside, tabSite }
  return { hash, bundle, unsupported: [...unsupported], outside, tabSite }
}

// ── Restore ────────────────────────────────────────────────────────────────

export interface RestoreOutcome {
  /** Saved records whose values could not be written back (a key that cannot leave its browser). */
  skippedRecords: number
  /** How the agent's tab settled after its reload; null when it was not reloaded, or its page did not load. */
  settled: TabSettled | null
}

export interface TabSettled {
  /** How long after the reload's load the tab was seen settled. */
  waitedMs: number
  /** The host the tab went on to by itself after the load; null when it stayed on its page. */
  movedTo: string | null
}

/** How the agent's tab settles after a restore's reload (followTab), from its load. */
export interface SettleTiming {
  /** The sign-in page is given this long to move on by itself, */
  minMs: number
  /** and then settles once nothing moved for this long; */
  quietMs: number
  /** once it moved on, once no navigation started for this long; */
  movedQuietMs: number
  /** and never later than this. */
  maxMs: number
}

/**
 * Measured on Google (Browserbase): the sign-in page went on to Gmail 1.8 s
 * after its load, after 1.5 s with no request; 3 to 5 s in another run.
 */
export const SETTLE_TIMING: SettleTiming = { minMs: 5_000, quietMs: 1_500, movedQuietMs: 1_000, maxMs: 8_000 }

/**
 * A restore that failed. `touched`: the agent's tab left its page (it was
 * parked), so the page the agent mapped is gone; `changed`: some of the
 * site's state was replaced; then `cleared` says whether the site was
 * emptied after, rather than left with two accounts' state mixed.
 */
export class SessionRestoreError extends Error {
  constructor(message: string, readonly touched: boolean, readonly changed: boolean, readonly cleared: boolean) {
    super(message)
  }
}

/** A tab parked on a stub while the site's state is replaced, and where it goes back to. */
interface ParkedTab {
  sessionId: string
  url: string
  stubs: StubTab
  /** It left its page: it goes back once the state is in place. */
  moved: boolean
  /** The agent's tab: it settles after going back, and `settled` says how. */
  settles: boolean
  settled: TabSettled | null
}

/** Park a tab: on the stub of its own origin when it shows a page, with its sessionStorage there emptied when that origin is the site's. */
async function park(cdp: CdpConnection, page: PageInfo, site: string, parked: ParkedTab[], settles = false): Promise<ParkedTab> {
  const sessionId = await attach(cdp, page.targetId)
  let stubs: StubTab
  try {
    stubs = await interceptStubs(cdp, sessionId)
  } catch (error) {
    await detach(cdp, sessionId)
    throw error
  }
  const tab: ParkedTab = { sessionId, url: page.url, stubs, moved: false, settles, settled: null }
  parked.push(tab)
  const origin = originOf(page.url)
  if (origin) {
    tab.moved = true
    await stubs.open(origin)
    // The tab's own sessionStorage on the site, with what the page wrote on its way out.
    if (originInScope(origin, site)) await stubs.call(CLEAR_SESSION_STORAGE_FUNCTION, [origin])
  }
  return tab
}

/** A URL's host, or its scheme when it has none (about:blank). */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host || parsed.protocol
  } catch {
    return 'an unreadable URL'
  }
}

/**
 * Follow a tab's main frame and requests, from before its reload. `settled`,
 * called once the reload has loaded, waits for the tab to settle and says
 * what it did meanwhile: a page the restored state signs in may move on by
 * itself after its load (Google's sign-in page checks the session in its
 * scripts and goes on to Gmail seconds later; told where the tab was at the
 * load, the agent saw the sign-in page and signed in again). Before it moves,
 * settled is `minMs` past the load with nothing moving for `quietMs` (no
 * navigation, no request in flight but a long poll); once it moved, no
 * navigation started for `movedQuietMs`, however long the new page takes to
 * load (Gmail's own requests keep on); at the latest `maxMs` past the load.
 */
async function followTab(cdp: CdpConnection, sessionId: string, timing: SettleTiming): Promise<{ settled(): Promise<TabSettled>; stop(): void }> {
  const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId)
  const mainFrame = frameTree.frame.id
  /** Requests in flight: id → when issued. */
  const inFlight = new Map<string, number>()
  let loading = false
  let busyAt = Date.now()
  let navigatedAt = Date.now()
  let loadedAt: number | null = null
  let movedTo: string | null = null
  const stop = cdp.onEvent(({ method, params, sessionId: from }) => {
    if (from !== sessionId) return
    if (method === 'Network.requestWillBeSent') {
      if (!inFlight.has(params.requestId)) inFlight.set(params.requestId, Date.now())
      // The tab's own navigation, and each of its redirects.
      if (params.type === 'Document' && params.frameId === mainFrame) navigatedAt = Date.now()
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      inFlight.delete(params.requestId)
    } else if (method === 'Page.frameStartedLoading' && params.frameId === mainFrame) {
      loading = true
    } else if (method === 'Page.frameNavigated' && params.frame?.id === mainFrame) {
      if (loadedAt !== null) movedTo = hostOf(params.frame.url)
      navigatedAt = Date.now()
    } else if (method === 'Page.frameStoppedLoading' && params.frameId === mainFrame) {
      loading = false
    } else {
      return
    }
    busyAt = Date.now()
  })
  return {
    stop,
    async settled() {
      const loaded = Date.now()
      loadedAt = loaded
      busyAt = loaded
      for (;;) {
        const now = Date.now()
        if (loading || [...inFlight.values()].some((issuedAt) => now - issuedAt < LONG_REQUEST_MS)) busyAt = now
        const done = movedTo !== null
          ? now - navigatedAt >= timing.movedQuietMs
          : now - loaded >= timing.minMs && now - busyAt >= timing.quietMs
        if (done || now - loaded >= timing.maxMs) return { waitedMs: now - loaded, movedTo }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
      }
    },
  }
}

/**
 * Send a parked tab back to its page, loaded afresh, with no stub left in its
 * history (nor the page it left, held in the back cache). The agent's tab
 * then settles (followTab) before the agent is told where it is.
 */
async function unpark(cdp: CdpConnection, tab: ParkedTab, timing: SettleTiming): Promise<void> {
  await tab.stubs.release()
  if (tab.moved && !tab.url.startsWith('chrome-error:')) {
    const followed = tab.settles ? await followTab(cdp, tab.sessionId, timing).catch(() => null) : null
    try {
      const loaded = loadFired(cdp, tab.sessionId)
      loaded.catch(() => {})
      const navigation = await cdp.send<{ errorText?: string }>('Page.navigate', { url: tab.url }, tab.sessionId).catch(() => null)
      // A page that fails or takes long to load is the agent's to see.
      if (navigation && !navigation.errorText && await loaded.then(() => true, () => false) && followed) tab.settled = await followed.settled()
    } finally {
      followed?.stop()
    }
    await cdp.send('Page.resetNavigationHistory', {}, tab.sessionId).catch(() => {})
  }
  await detach(cdp, tab.sessionId)
}

/**
 * Make the site's state in the browser the bundle's. `tabId` is the agent's
 * tab: the state is written through it. It and every other tab on the site
 * are parked while the state is replaced (see the module comment), then sent
 * back, whatever happened, the agent's tab settling (`settle`) before this
 * returns. The other tabs go first: one that cannot be parked and is still
 * open (a dialog holds its page) would write its account's state back once
 * it runs again, so nothing is replaced, and the agent's page is left as it
 * is. A failure once something changed empties the site before they go back.
 */
export async function restoreSession(
  cdp: CdpConnection,
  scope: SessionScope,
  bundle: SessionBundle,
  tabId: string,
  settle: SettleTiming = SETTLE_TIMING,
): Promise<RestoreOutcome> {
  const parked: ParkedTab[] = []
  let changed = false
  let skippedRecords = 0
  try {
    const pages = await listPages(cdp)
    const agentPage = pages.find((page) => page.targetId === tabId)
    if (!agentPage) throw new Error('the agent\'s tab is gone')
    const context = await agentContext(cdp, pages, tabId)
    for (const page of pages) {
      const origin = originOf(page.url)
      if (page.targetId === tabId || !origin || !originInScope(origin, scope.site)) continue
      await park(cdp, page, scope.site, parked).catch(async () => {
        // Closed meanwhile, it runs nothing of the site's either.
        if ((await listPages(cdp)).some((open) => open.targetId === page.targetId)) throw new Error('another tab on the site is not responding')
      })
    }
    const agentTab = await park(cdp, agentPage, scope.site, parked, true)
    const replace = (from: SessionBundle | null) => replaceSiteState(cdp, scope, from, { tab: agentTab, pages, context }, () => { changed = true })
    try {
      ({ skippedRecords } = await replace(bundle))
    } catch (error) {
      const cleared = changed && await replace(null).then(() => true, () => false)
      throw new SessionRestoreError(error instanceof Error ? error.message : 'unknown error', true, changed, cleared)
    }
  } catch (error) {
    if (error instanceof SessionRestoreError) throw error
    throw new SessionRestoreError(error instanceof Error ? error.message : 'unknown error', parked.some((tab) => tab.settles && tab.moved), changed, false)
  } finally {
    for (const tab of parked) await unpark(cdp, tab, settle).catch(() => {})
  }
  return { skippedRecords, settled: parked.find((tab) => tab.settles)?.settled ?? null }
}

/** The site's state made the bundle's, or emptied (null), with its tabs parked. `onChange` runs before the first change. */
async function replaceSiteState(
  cdp: CdpConnection,
  scope: SessionScope,
  bundle: SessionBundle | null,
  browser: { tab: ParkedTab; pages: readonly PageInfo[]; context: Record<string, string> },
  onChange: () => void,
): Promise<{ skippedRecords: number }> {
  const { tab, pages, context } = browser
  // Only what is the site's goes in, whatever the bundle holds.
  const cookies = bundle?.cookies.filter((cookie) => cookieInScope(cookie.domain, scope.site) && cookieFromSitePort(cookie.sourcePort, scope.site)) ?? []
  const stores = bundle?.origins.filter((origin) => originInScope(origin.origin, scope.site)) ?? []
  const existing = await readCookies(cdp, context, scope.site)
  const origins = new Set([
    ...candidateOrigins(scope, existing, await visitedUrls(cdp, pages)),
    ...stores.map((stored) => stored.origin),
  ])
  onChange()
  if (existing.length > 0) await cdp.send('Storage.setCookies', { cookies: existing.map(expired), ...context })
  for (const origin of origins) {
    await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: CLEARED_STORAGE }, tab.sessionId)
  }
  let skippedRecords = 0
  for (const stored of stores) {
    tab.moved = true
    await tab.stubs.open(stored.origin)
    const written = await tab.stubs.call<{ skippedRecords: number }>(WRITE_ORIGIN_STORAGE_FUNCTION, [stored])
    skippedRecords += written.skippedRecords
  }
  // Last: the site's server sees the restored account only once its storage is in place.
  if (cookies.length > 0) await cdp.send('Storage.setCookies', { cookies, ...context })
  return { skippedRecords }
}
