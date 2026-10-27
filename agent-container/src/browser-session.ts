import { createHash } from 'crypto'
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
 * cookies set for its host, its subdomains, or a parent domain (Google's
 * session lives on .google.com, its sign-in on accounts.google.com), and the
 * localStorage and IndexedDB of its host's and subdomains' origins. Never a
 * sibling host: tenants of one domain (acme.okta.com, beta.okta.com) are
 * separate accounts. sessionStorage belongs to a tab, so it is not saved; a
 * restore empties it in the site's open tabs.
 *
 * Storage needs a document of its origin, so it is read and written on a
 * blank stub document served for that origin by request interception: the
 * site is never contacted, its service worker is bypassed, and none of its
 * scripts run there. A capture reads on a hidden tab of its own, beside the
 * agent's work; a restore parks the agent's own tab on the stub first, so the
 * sign-in page unloads before its state is replaced and cannot write its
 * signed-out state back over the restored one, then sends the tab back to
 * where it was.
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
const WORLD_NAME = 'superagent-session'
/** What a restore empties on each origin in scope before writing. */
const CLEARED_STORAGE = 'local_storage,indexeddb,cache_storage,service_workers'
/** The largest bundle kept, as JSON: past it, databases are left out, biggest first. */
export const MAX_BUNDLE_CHARS = 1_000_000

export class SessionTooLargeError extends Error {}

const hostnameOf = (site: string) => site.replace(/:\d+$/, '')

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** Whether a cookie with this domain is in the site's scope: set for its host, a subdomain, or a parent domain. */
export function cookieInScope(domain: string, site: string): boolean {
  const host = hostnameOf(site)
  const cookieHost = domain.replace(/^\./, '').toLowerCase()
  return cookieHost === host || cookieHost.endsWith(`.${host}`) || host.endsWith(`.${cookieHost}`)
}

/**
 * Whether a cookie came from the site's own port. Cookies ignore ports, so
 * two sites on one host (dev servers on localhost) see each other's; a site
 * named with a port keeps only the ones its port set, as Chrome records it
 * (`sourcePort`). Unknown is -1, and a cookie set with no port named (over
 * CDP, by a test tool) records its scheme's default: neither rules one out.
 */
export function cookieFromSitePort(sourcePort: number | undefined, site: string): boolean {
  const port = /:(\d+)$/.exec(site)?.[1]
  if (!port || sourcePort === undefined || sourcePort < 0 || sourcePort === 80 || sourcePort === 443) return true
  return sourcePort === Number(port)
}

/** Whether an origin's storage is in the site's scope: its host's or a subdomain's. */
export function originInScope(origin: string, site: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return url.host === site || url.hostname.endsWith(`.${hostnameOf(site)}`)
  } catch {
    return false
  }
}

/**
 * The origins in scope whose storage to read or empty. Chrome lists no
 * origins that hold storage, so these are the ones the browser shows: the
 * sign-in's own, the subdomains its cookies are set for, and those of the
 * open tabs and their history (an app.* the sign-in redirected to).
 */
export function candidateOrigins(scope: SessionScope, cookies: ReadonlyArray<{ domain: string }>, urls: readonly string[]): string[] {
  const origins = new Set<string>([scope.origin])
  const host = hostnameOf(scope.site)
  for (const cookie of cookies) {
    const cookieHost = cookie.domain.replace(/^\./, '').toLowerCase()
    if (cookieHost.endsWith(`.${host}`)) origins.add(`https://${cookieHost}`)
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
 * A fingerprint of the cookies in scope, values included and expiries not:
 * a sign-in that completes (a push approved, a provider's redirect landing)
 * changes it; a sliding expiry being pushed out does not.
 */
export function hashCookies(cookies: readonly SessionCookie[]): string {
  const keys = cookies
    .map((cookie) => JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey?.topLevelSite ?? null, cookie.value]))
    .sort()
  return createHash('sha256').update(keys.join('\n')).digest('base64url')
}

/** An already-expired copy: setting it deletes the cookie. */
function expired(cookie: SessionCookie): SessionCookie {
  return { ...cookie, value: '', expires: 1 }
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
 * The browser context the agent's tabs are in, when it is not the default
 * one (remote providers keep pages in their own): cookies and new tabs must
 * go there.
 */
async function agentContext(cdp: CdpConnection, pages: readonly PageInfo[]): Promise<Record<string, string>> {
  const contextId = pages[0]?.browserContextId
  if (!contextId) return {}
  const { browserContextIds } = await cdp.send<{ browserContextIds: string[] }>('Target.getBrowserContexts')
    .catch((): { browserContextIds: string[] } => ({ browserContextIds: [] }))
  return browserContextIds.includes(contextId) ? { browserContextId: contextId } : {}
}

async function readCookies(cdp: CdpConnection, context: Record<string, string>, site: string): Promise<SessionCookie[]> {
  const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies', context)
  return cookies.flatMap((cookie) => {
    if (!cookieInScope(cookie.domain, site) || !cookieFromSitePort(cookie.sourcePort, site)) return []
    const converted = toSessionCookie(cookie)
    return converted ? [converted] : []
  })
}

async function attach(cdp: CdpConnection, targetId: string): Promise<string> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  return sessionId
}

async function detach(cdp: CdpConnection, sessionId: string): Promise<void> {
  await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
}

/** Call a page function with arguments passed by value; a failure names no value (our scripts never put one in an error). */
async function callInPage<T>(cdp: CdpConnection, sessionId: string, functionDeclaration: string, args: unknown[] = [], contextId?: number): Promise<T> {
  const global = await cdp.send<{ result?: { objectId?: string } }>('Runtime.evaluate', { expression: 'globalThis', ...(contextId ? { contextId } : {}) }, sessionId)
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

/**
 * Empty sessionStorage in the open tabs on the site's origins, each from an
 * isolated world (the page's own scripts cannot stand in for the API) and
 * only while the tab is still on the origin it was listed with.
 */
async function clearSessionStorage(cdp: CdpConnection, pages: readonly PageInfo[], site: string): Promise<void> {
  for (const page of pages) {
    const origin = originOf(page.url)
    if (!origin || !originInScope(origin, site)) continue
    const sessionId = await attach(cdp, page.targetId)
    try {
      const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId)
      const world = await cdp.send<{ executionContextId: number }>(
        'Page.createIsolatedWorld',
        { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false },
        sessionId,
      )
      await callInPage(cdp, sessionId, CLEAR_SESSION_STORAGE_FUNCTION, [origin], world.executionContextId)
    } finally {
      await detach(cdp, sessionId)
    }
  }
}

// ── Capture ────────────────────────────────────────────────────────────────

interface ReadOrigin {
  localStorage: Array<[string, string]>
  indexedDB: OriginStorage['indexedDB']
  oversized: number
  unsupported: string[]
}

export type CaptureResult =
  | { unchanged: true; cookieHash: string }
  | { unchanged: false; cookieHash: string; bundle: SessionBundle; unsupported: string[] }

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
 * Read the site's session out of the browser. With `unlessCookieHash`, a
 * browser whose cookies in scope still have that fingerprint is not read any
 * further: nothing about the sign-in changed since that capture.
 */
export async function captureSession(cdp: CdpConnection, scope: SessionScope, options: { unlessCookieHash?: string } = {}): Promise<CaptureResult> {
  const pages = await listPages(cdp)
  if (pages.length === 0) throw new Error('no browser page is open')
  const context = await agentContext(cdp, pages)
  const cookies = await readCookies(cdp, context, scope.site)
  const cookieHash = hashCookies(cookies)
  if (options.unlessCookieHash === cookieHash) return { unchanged: true, cookieHash }

  const candidates = candidateOrigins(scope, cookies, await visitedUrls(cdp, pages))
  const unsupported = new Set<string>()
  let leftOut = 0
  const origins = await withStubTab(cdp, context, async (tab) => {
    const read: OriginStorage[] = []
    for (const origin of candidates) {
      await tab.open(origin)
      const stored = await tab.call<ReadOrigin>(READ_ORIGIN_STORAGE_FUNCTION, [origin])
      leftOut += stored.oversized
      for (const type of stored.unsupported) unsupported.add(type)
      if (stored.localStorage.length > 0 || stored.indexedDB.length > 0) {
        read.push({ origin, localStorage: stored.localStorage, indexedDB: stored.indexedDB })
      }
    }
    return read
  })
  const bundle = fitBundle({
    version: 1,
    site: scope.site,
    capturedAt: new Date().toISOString(),
    cookies,
    origins,
    ...(leftOut > 0 ? { leftOut } : {}),
  })
  return { unchanged: false, cookieHash, bundle: sessionBundleSchema.parse(bundle), unsupported: [...unsupported] }
}

// ── Restore ────────────────────────────────────────────────────────────────

export interface RestoreOutcome {
  /** Saved records whose values could not be written back (a key that cannot leave its browser). */
  skippedRecords: number
  /** The fingerprint of the site's cookies as restored (hashCookies): a later capture saves only a change. */
  cookieHash: string
}

/**
 * A restore that failed. `touched`: the browser changed (the agent's tab
 * left its page, or the site's state was partly replaced), so the page the
 * agent mapped is gone; then `cleared` says whether the site was emptied
 * after, as a sign-out, rather than left with two accounts' state mixed.
 */
export class SessionRestoreError extends Error {
  constructor(message: string, readonly touched: boolean, readonly cleared: boolean) {
    super(message)
  }
}

interface ParkedTab {
  targetId: string
  sessionId: string
  /** Its origin before it was parked, if it showed an http(s) page. */
  origin: string | null
  stubs: StubTab
  pages: readonly PageInfo[]
  context: Record<string, string>
}

/**
 * Make the site's state in the browser the bundle's. `tabId` is the agent's
 * tab: parked on the stub of its own origin while the state is replaced (see
 * the module comment), then sent back to its URL, whatever happened. A
 * failure once something changed empties the site before the tab goes back.
 */
export async function restoreSession(cdp: CdpConnection, scope: SessionScope, bundle: SessionBundle, tabId: string): Promise<RestoreOutcome> {
  let touched = false
  let sessionId: string | null = null
  let returnTo: string | null = null
  let stubs: StubTab | null = null
  try {
    const pages = await listPages(cdp)
    const tab = pages.find((page) => page.targetId === tabId)
    if (!tab) throw new Error('the agent\'s tab is gone')
    const context = await agentContext(cdp, pages)
    sessionId = await attach(cdp, tabId)
    stubs = await interceptStubs(cdp, sessionId)
    const parked: ParkedTab = { targetId: tabId, sessionId, origin: originOf(tab.url), stubs, pages, context }
    touched = true
    returnTo = parked.origin ? tab.url : null
    try {
      return await replaceSiteState(cdp, scope, bundle, parked)
    } catch (error) {
      const cleared = await replaceSiteState(cdp, scope, null, parked).then(() => true, () => false)
      throw new SessionRestoreError(error instanceof Error ? error.message : 'unknown error', true, cleared)
    }
  } catch (error) {
    if (error instanceof SessionRestoreError) throw error
    throw new SessionRestoreError(error instanceof Error ? error.message : 'unknown error', touched, false)
  } finally {
    await stubs?.release()
    if (sessionId && returnTo) await navigateBack(cdp, sessionId, returnTo)
    if (sessionId) await detach(cdp, sessionId)
  }
}

/** Send the parked tab back to its page; one that fails or takes long to load is the agent's to see. */
async function navigateBack(cdp: CdpConnection, sessionId: string, url: string): Promise<void> {
  const loaded = loadFired(cdp, sessionId)
  loaded.catch(() => {})
  const navigation = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sessionId).catch(() => null)
  if (navigation && !navigation.errorText) await loaded.catch(() => {})
}

/** The site's state made the bundle's, or emptied (null), with the agent's tab parked on a stub. */
async function replaceSiteState(cdp: CdpConnection, scope: SessionScope, bundle: SessionBundle | null, tab: ParkedTab): Promise<RestoreOutcome> {
  const { sessionId, stubs, context } = tab
  // Only what is the site's goes in, whatever the bundle holds.
  const cookies = bundle?.cookies.filter((cookie) => cookieInScope(cookie.domain, scope.site) && cookieFromSitePort(cookie.sourcePort, scope.site)) ?? []
  const stores = bundle?.origins.filter((origin) => originInScope(origin.origin, scope.site)) ?? []
  if (tab.origin) {
    await stubs.open(tab.origin)
    // The tab's own sessionStorage on the site, with what the page wrote on its way out.
    if (originInScope(tab.origin, scope.site)) await stubs.call(CLEAR_SESSION_STORAGE_FUNCTION, [tab.origin])
  }
  const existing = await readCookies(cdp, context, scope.site)
  const origins = new Set([
    ...candidateOrigins(scope, existing, await visitedUrls(cdp, tab.pages)),
    ...stores.map((stored) => stored.origin),
  ])
  if (existing.length > 0) await cdp.send('Storage.setCookies', { cookies: existing.map(expired), ...context })
  for (const origin of origins) {
    await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: CLEARED_STORAGE }, sessionId)
  }
  let skippedRecords = 0
  for (const stored of stores) {
    await stubs.open(stored.origin)
    const written = await stubs.call<{ skippedRecords: number }>(WRITE_ORIGIN_STORAGE_FUNCTION, [stored])
    skippedRecords += written.skippedRecords
  }
  // Last: the site's server sees the restored account only once its storage is in place.
  if (cookies.length > 0) await cdp.send('Storage.setCookies', { cookies, ...context })
  await clearSessionStorage(cdp, tab.pages.filter((page) => page.targetId !== tab.targetId), scope.site)
  // As the browser took them: one already expired is not set at all.
  return { skippedRecords, cookieHash: hashCookies(await readCookies(cdp, context, scope.site)) }
}
