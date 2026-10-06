import { createHash } from 'crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  READ_ORIGIN_STORAGE_FUNCTION,
  READ_SESSION_STORAGE_FUNCTION,
  WRITE_ORIGIN_STORAGE_FUNCTION,
  WRITE_SESSION_STORAGE_FUNCTION,
} from './browser-storage-script'
import {
  originSchema,
  siteSchema,
  siteStorageBundleSchema,
  type OriginStorage,
  type SiteStorageBundle,
  type StorageCookie,
} from './browser-storage-bundle'

const CDP_TIMEOUT_MS = 15_000
const STUB_PATH = '/__superagent_storage__'
const STUB_HTML_BASE64 = Buffer.from('<!doctype html><title></title>').toString('base64')

export interface RestoreResult {
  cookies: number
  origins: Array<{ origin: string; localStorage: number; indexedDB: number; skippedRecords: number }>
  /** Origins whose sessionStorage was not restored because no tab of that origin was open. */
  sessionStorageSkipped: string[]
}

// ---------------------------------------------------------------------------
// Site matching
// ---------------------------------------------------------------------------

export function hostBelongsToSite(host: string, site: string): boolean {
  const normalized = host.replace(/^\./, '').toLowerCase()
  return normalized === site || normalized.endsWith(`.${site}`)
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * Chrome has no API that lists origins holding web storage, so check every
 * origin we can name under the site: the hosts its cookies are scoped to,
 * the tabs currently open on it, and any the caller adds.
 */
export function candidateOrigins(
  site: string,
  cookies: Array<{ domain: string; secure: boolean }>,
  pageUrls: string[],
  extraOrigins: string[] = [],
): string[] {
  const origins = new Set<string>()
  for (const cookie of cookies) {
    const host = cookie.domain.replace(/^\./, '')
    if (hostBelongsToSite(host, site)) origins.add(`https://${host}`)
  }
  for (const url of [...pageUrls, ...extraOrigins]) {
    const origin = originOf(url)
    if (origin && hostBelongsToSite(new URL(origin).hostname, site)) origins.add(origin)
  }
  return [...origins].sort()
}

// ---------------------------------------------------------------------------
// Cookie conversion
// ---------------------------------------------------------------------------

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
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
}

/** Keep every attribute Storage.setCookies accepts; a session cookie has no expiry. */
export function toStorageCookie(cookie: CdpCookie): StorageCookie {
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
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  }
}

/** What identifies a cookie in the browser's jar; setting a cookie with the same key replaces it. */
function cookieKey(cookie: Pick<StorageCookie, 'name' | 'domain' | 'path' | 'partitionKey'>): string {
  return JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey?.topLevelSite ?? null, cookie.partitionKey?.hasCrossSiteAncestor ?? null])
}

function cookieFingerprint(cookie: StorageCookie): string {
  return createHash('sha256').update(cookieKey(cookie)).update('\0').update(cookie.value).digest('base64')
}

/** An already-expired copy of a cookie; setting it deletes the original. */
function expiredCookie(cookie: StorageCookie): StorageCookie {
  return { ...cookie, value: '', expires: 1 }
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

type CdpEventHandler = (params: any, sessionId?: string) => void

export interface CdpClient {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  on(method: string, handler: CdpEventHandler): () => void
  close(): void
}

/** Minimal browser-level CDP client. Raw CDP (not Playwright) so helper tabs open in the background and download behavior is left alone. */
export function connectCdp(browserWsUrl: string, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl, { handshakeTimeout: timeoutMs })
    const pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
    const handlers = new Map<string, Set<CdpEventHandler>>()
    let nextId = 0

    const failAll = (error: Error) => {
      for (const { reject: rejectCall, timer } of pending.values()) {
        clearTimeout(timer)
        rejectCall(error)
      }
      pending.clear()
    }

    ws.on('message', (raw) => {
      let message: any
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (typeof message.id === 'number') {
        const call = pending.get(message.id)
        if (!call) return
        pending.delete(message.id)
        clearTimeout(call.timer)
        // CDP error texts carry no page data; the method says which step failed.
        if (message.error) call.reject(new Error(`${call.method}: ${message.error.message ?? 'CDP error'}`))
        else call.resolve(message.result)
        return
      }
      for (const handler of handlers.get(message.method) ?? []) handler(message.params, message.sessionId)
    })
    ws.on('close', () => failAll(new Error('CDP connection closed')))
    ws.on('error', (error) => {
      failAll(error)
      reject(error)
    })
    ws.on('open', () => resolve({
      send(method, params = {}, sessionId) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId
          const timer = setTimeout(() => {
            pending.delete(id)
            rejectCall(new Error(`CDP ${method} timed out`))
          }, timeoutMs)
          pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer })
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        })
      },
      on(method, handler) {
        const set = handlers.get(method) ?? new Set()
        set.add(handler)
        handlers.set(method, set)
        return () => set.delete(handler)
      },
      close() {
        ws.close()
      },
    }))
  })
}

async function callInPage<T>(cdp: CdpClient, sessionId: string, functionDeclaration: string, args: unknown[] = []): Promise<T> {
  const global = await cdp.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: 'globalThis' }, sessionId)
  if (!global.result.objectId) throw new Error('Could not access browser page')
  const response = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
    objectId: global.result.objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  }, sessionId)
  if (response.exceptionDetails) {
    // First line only, e.g. "QuotaExceededError: ..."; our scripts never put storage values in errors.
    const description = (response.exceptionDetails as { exception?: { description?: string } }).exception?.description
    throw new Error(`Browser storage script failed${description ? `: ${description.split('\n')[0].slice(0, 200)}` : ''}`)
  }
  return response.result.value
}

const stubTargetIds = new Set<string>()

/** Background tabs opened by this module; tab listings must skip them so the live view never follows one. */
export function isStorageStubTarget(targetId: string): boolean {
  return stubTargetIds.has(targetId)
}

/**
 * Run `fn` on a background tab whose document is a blank page served for
 * `origin`. Fetch interception answers every request for the origin, so the
 * real site is never contacted, and service workers are bypassed so an
 * installed one cannot serve the site's own page here instead.
 */
async function withStubPage<T>(cdp: CdpClient, origin: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true })
  stubTargetIds.add(targetId)
  let unsubscribe = () => {}
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    unsubscribe = cdp.on('Fetch.requestPaused', (params, eventSessionId) => {
      if (eventSessionId !== sessionId) return
      const stub = params.request?.url === `${origin}${STUB_PATH}`
      void cdp.send(stub ? 'Fetch.fulfillRequest' : 'Fetch.failRequest', stub
        ? {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
            body: STUB_HTML_BASE64,
          }
        : { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {})
    })
    // The bypass only takes effect once the Network domain is enabled.
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }, sessionId)
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    const loaded = new Promise<void>((resolve) => {
      const off = cdp.on('Page.loadEventFired', (_params, eventSessionId) => {
        if (eventSessionId === sessionId) {
          off()
          resolve()
        }
      })
    })
    const navigation = await cdp.send<{ errorText?: string }>('Page.navigate', { url: `${origin}${STUB_PATH}` }, sessionId)
    if (navigation.errorText) throw new Error(`Could not open a page for ${origin}`)
    await loaded
    return await fn(sessionId)
  } finally {
    unsubscribe()
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    stubTargetIds.delete(targetId)
  }
}

async function listPages(cdp: CdpClient): Promise<Array<{ targetId: string; url: string }>> {
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
  return targetInfos.filter((target) => target.type === 'page')
}

/** Run a sessionStorage page function in one tab; it gets `origin` first and returns null if the tab left it. */
async function inTab<T>(cdp: CdpClient, targetId: string, origin: string, functionDeclaration: string, args: unknown[] = []): Promise<T | null> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  try {
    return await callInPage<T | null>(cdp, sessionId, functionDeclaration, [origin, ...args])
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
}

/**
 * Run a sessionStorage page function in every open tab listed on `origin`;
 * sessionStorage only exists per tab. Returns the results of tabs still on
 * the origin.
 */
async function inOpenTabs<T>(cdp: CdpClient, pages: Array<{ targetId: string; url: string }>, origin: string, functionDeclaration: string, args: unknown[] = []): Promise<T[]> {
  const results: T[] = []
  for (const page of pages) {
    if (originOf(page.url) !== origin || page.url.endsWith(STUB_PATH)) continue
    const result = await inTab<T>(cdp, page.targetId, origin, functionDeclaration, args)
    if (result !== null) results.push(result)
  }
  return results
}

async function allCookies(cdp: CdpClient): Promise<StorageCookie[]> {
  const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies')
  return cookies.map(toStorageCookie)
}

async function siteCookies(cdp: CdpClient, site: string): Promise<StorageCookie[]> {
  return (await allCookies(cdp)).filter((cookie) => hostBelongsToSite(cookie.domain, site))
}

interface ReadOriginResult {
  localStorage: Array<[string, string]>
  indexedDB: OriginStorage['indexedDB']
  oversizedDatabases: string[]
  unsupported: string[]
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** URLs in each open tab's back/forward history, e.g. an accounts.* page a sign-in redirected through. */
async function historyUrls(cdp: CdpClient, pages: Array<{ targetId: string; url: string }>): Promise<string[]> {
  const urls: string[] = []
  for (const page of pages) {
    if (page.url.endsWith(STUB_PATH)) continue
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    try {
      const { entries } = await cdp.send<{ entries: Array<{ url: string }> }>('Page.getNavigationHistory', {}, sessionId)
        .catch(() => ({ entries: [] }))
      urls.push(...entries.map((entry) => entry.url))
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }
  return urls
}

async function visitedUrls(cdp: CdpClient, pages: Array<{ targetId: string; url: string }>): Promise<string[]> {
  return [...pages.map((page) => page.url), ...await historyUrls(cdp, pages)]
}

// A sign-in can depend on cookies of another site (e.g. an identity provider
// on its own domain). Chrome lists every cookie, so the jar is fingerprinted
// when a sign-in starts, and capture adds other sites' cookies that changed
// since. Web storage of other sites cannot be listed, so it is not captured.
const LOGIN_BASELINE_TTL_MS = 30 * 60_000
const loginBaselines = new Map<string, { recordedAt: number; fingerprints: Set<string> }>()

const baselineKey = (sessionId: string, site: string) => `${sessionId}\0${site}`

/**
 * Fingerprint the cookie jar before a sign-in to `site`. A fresh baseline
 * already recorded for the same sign-in (e.g. its 2FA step) is kept, so
 * cookies set by an earlier step still count as changed.
 */
export async function recordLoginBaseline(cdp: CdpClient, sessionId: string, site: string, now = Date.now()): Promise<void> {
  for (const [key, baseline] of loginBaselines) {
    if (now - baseline.recordedAt > LOGIN_BASELINE_TTL_MS) loginBaselines.delete(key)
  }
  const key = baselineKey(sessionId, site)
  if (loginBaselines.has(key)) return
  const fingerprints = new Set((await allCookies(cdp)).map(cookieFingerprint))
  loginBaselines.set(key, { recordedAt: now, fingerprints })
}

function takeLoginBaseline(sessionId: string, site: string, now = Date.now()): Set<string> | undefined {
  const key = baselineKey(sessionId, site)
  const baseline = loginBaselines.get(key)
  loginBaselines.delete(key)
  return baseline && now - baseline.recordedAt <= LOGIN_BASELINE_TTL_MS ? baseline.fingerprints : undefined
}

/**
 * Read the site's cookies and web storage. With a `baseline`, cookies of
 * other sites that are new or changed since it was recorded are kept too.
 */
export async function captureSiteStorage(cdp: CdpClient, site: string, extraOrigins: string[] = [], baseline?: Set<string>): Promise<SiteStorageBundle> {
  const cookies = (await allCookies(cdp)).filter((cookie) =>
    hostBelongsToSite(cookie.domain, site) || (baseline !== undefined && !baseline.has(cookieFingerprint(cookie))))
  const pages = await listPages(cdp)
  const origins: OriginStorage[] = []
  for (const origin of candidateOrigins(site, cookies, await visitedUrls(cdp, pages), extraOrigins)) {
    const { oversizedDatabases, ...read } = await withStubPage(cdp, origin, (sessionId) =>
      callInPage<ReadOriginResult>(cdp, sessionId, READ_ORIGIN_STORAGE_FUNCTION))
    const [sessionStorage] = await inOpenTabs<Array<[string, string]>>(cdp, pages, origin, READ_SESSION_STORAGE_FUNCTION)
    origins.push({
      origin,
      ...read,
      ...(sessionStorage ? { sessionStorage } : {}),
      ...(oversizedDatabases.length > 0 ? { oversizedDatabases } : {}),
    })
  }
  return siteStorageBundleSchema.parse({ version: 1, site, capturedAt: new Date().toISOString(), cookies, origins })
}

// sessionStorage lives in a tab, so a restore with no open tab of an origin
// keeps its entries here until the agent's browser shows that origin.
const pendingSessionStorage = new Map<string, Array<[string, string]>>()

function forgetPendingSessionStorage(site: string): void {
  for (const origin of pendingSessionStorage.keys()) {
    if (hostBelongsToSite(new URL(origin).hostname, site)) pendingSessionStorage.delete(origin)
  }
}

export function hasPendingSessionStorage(): boolean {
  return pendingSessionStorage.size > 0
}

/** Pending entries belong to one browser; call when it closes. */
export function clearPendingSessionStorage(): void {
  pendingSessionStorage.clear()
}

/**
 * Write pending sessionStorage into open tabs that now show its origin and
 * reload each once so the page reads it. Returns the origins applied.
 */
export async function applyPendingSessionStorage(cdp: CdpClient): Promise<string[]> {
  const applied: string[] = []
  for (const page of await listPages(cdp)) {
    const origin = originOf(page.url)
    const entries = origin && !page.url.endsWith(STUB_PATH) ? pendingSessionStorage.get(origin) : undefined
    if (!origin || !entries) continue
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    try {
      if (await callInPage<number | null>(cdp, sessionId, WRITE_SESSION_STORAGE_FUNCTION, [origin, entries]) === null) continue
      await cdp.send('Page.reload', {}, sessionId)
      pendingSessionStorage.delete(origin)
      applied.push(origin)
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }
  return applied
}

/**
 * Empty localStorage, IndexedDB and open tabs' sessionStorage of `origins`.
 * Returns the origins with an open tab whose sessionStorage was emptied.
 */
async function clearOrigins(cdp: CdpClient, pages: Array<{ targetId: string; url: string }>, origins: string[]): Promise<string[]> {
  if (origins.length === 0) return []
  // One stub tab's session reaches the agent's browser context, which remote providers keep out of the default one.
  await withStubPage(cdp, origins[0], async (sessionId) => {
    for (const origin of origins) {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' }, sessionId)
    }
  })
  const cleared: string[] = []
  for (const origin of origins) {
    if ((await inOpenTabs(cdp, pages, origin, WRITE_SESSION_STORAGE_FUNCTION, [[]])).length > 0) cleared.push(origin)
  }
  return cleared
}

/**
 * Make the browser's state for the bundle's site match the bundle. Every
 * cookie under the site is replaced (a stale anonymous device cookie next to
 * the restored one breaks some logins), and so is the web storage of every
 * site origin the browser is known to hold: origins the bundle lacks are
 * emptied, so no state of a previous login survives beside the new one.
 */
async function writeSiteStorage(cdp: CdpClient, bundle: SiteStorageBundle, extraOrigins: string[] = []): Promise<RestoreResult> {
  forgetPendingSessionStorage(bundle.site)
  const existing = await siteCookies(cdp, bundle.site)
  const pages = await listPages(cdp)
  const incoming = new Set(bundle.origins.map((origin) => origin.origin))
  const stale = candidateOrigins(bundle.site, existing, await visitedUrls(cdp, pages), extraOrigins)
    .filter((origin) => !incoming.has(origin))

  if (existing.length > 0) await cdp.send('Storage.setCookies', { cookies: existing.map(expiredCookie) })
  if (bundle.cookies.length > 0) await cdp.send('Storage.setCookies', { cookies: bundle.cookies })
  await clearOrigins(cdp, pages, stale)

  const origins: RestoreResult['origins'] = []
  const sessionStorageSkipped: string[] = []
  for (const origin of bundle.origins) {
    const written = await withStubPage(cdp, origin.origin, async (sessionId) => {
      // Browser-side delete force-closes open IndexedDB connections (e.g. the agent's own tab on this origin); an
      // in-page deleteDatabase would block on them. Sent on the tab's session so it targets the tab's browser
      // context: remote providers (Browserbase) keep pages out of the default one and fail a browser-level call.
      // Databases capture left out for size stay as they are: the bundle has nothing to put back.
      const keep = new Set(origin.oversizedDatabases ?? [])
      const { databaseNames } = await cdp.send<{ databaseNames: string[] }>(
        'IndexedDB.requestDatabaseNames', { securityOrigin: origin.origin }, sessionId)
      for (const databaseName of databaseNames) {
        if (!keep.has(databaseName)) await cdp.send('IndexedDB.deleteDatabase', { securityOrigin: origin.origin, databaseName }, sessionId)
      }
      return callInPage<{ localStorage: number; indexedDB: number; skippedRecords: number }>(
        cdp, sessionId, WRITE_ORIGIN_STORAGE_FUNCTION, [{ localStorage: origin.localStorage, indexedDB: origin.indexedDB }])
    })
    origins.push({ origin: origin.origin, ...written })
    // Tabs without saved entries are emptied too, so they keep nothing from the previous login.
    const restored = await inOpenTabs<number>(cdp, pages, origin.origin, WRITE_SESSION_STORAGE_FUNCTION, [origin.sessionStorage ?? []])
    if (origin.sessionStorage && restored.length === 0) {
      sessionStorageSkipped.push(origin.origin)
      pendingSessionStorage.set(origin.origin, origin.sessionStorage)
    }
  }
  return { cookies: bundle.cookies.length, origins, sessionStorageSkipped }
}

interface Rollback {
  backup: SiteStorageBundle
  /** Each open tab's own sessionStorage; the bundle keeps only one tab's per origin. */
  tabs: Array<{ targetId: string; origin: string; entries: Array<[string, string]> }>
  /** The bundle's cookies outside the site, and the cookies they replace. */
  crossSiteCookies: StorageCookie[]
  replacedCookies: StorageCookie[]
}

/**
 * Restore `bundle` as one unit. The site's current state, including the
 * bundle's origins even when they are empty now, is captured first; if the
 * write fails it is put back, and if that fails too, or the backup could not
 * hold all of it, the site is cleared so the browser never keeps a mix of two
 * logins. The thrown error says which.
 */
export async function restoreSiteStorage(cdp: CdpClient, bundle: SiteStorageBundle): Promise<RestoreResult> {
  const backup = await captureSiteStorage(cdp, bundle.site, bundle.origins.map((origin) => origin.origin))
  const scope = new Set(backup.origins.map((origin) => origin.origin))
  const tabs: Rollback['tabs'] = []
  for (const page of await listPages(cdp)) {
    const origin = originOf(page.url)
    if (!origin || !scope.has(origin) || page.url.endsWith(STUB_PATH)) continue
    const entries = await inTab<Array<[string, string]>>(cdp, page.targetId, origin, READ_SESSION_STORAGE_FUNCTION)
    if (entries) tabs.push({ targetId: page.targetId, origin, entries })
  }
  const crossSiteCookies = bundle.cookies.filter((cookie) => !hostBelongsToSite(cookie.domain, bundle.site))
  const crossSiteKeys = new Set(crossSiteCookies.map(cookieKey))
  const replacedCookies = crossSiteCookies.length > 0
    ? (await allCookies(cdp)).filter((cookie) => crossSiteKeys.has(cookieKey(cookie)))
    : []
  try {
    return await writeSiteStorage(cdp, bundle)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    throw new Error(`${reason}; ${await recover(cdp, { backup, tabs, crossSiteCookies, replacedCookies })}`)
  }
}

/** Databases left out for size or values that cannot leave the browser mean the backup cannot put the site back as it was. */
function isLossy(backup: SiteStorageBundle): boolean {
  return backup.origins.some((origin) => (origin.oversizedDatabases?.length ?? 0) > 0 || origin.unsupported.length > 0)
}

async function recover(cdp: CdpClient, rollback: Rollback): Promise<string> {
  const { backup, tabs, crossSiteCookies, replacedCookies } = rollback
  const scope = backup.origins.map((origin) => origin.origin)
  const putBackCrossSiteCookies = async () => {
    if (crossSiteCookies.length > 0) await cdp.send('Storage.setCookies', { cookies: crossSiteCookies.map(expiredCookie) })
    if (replacedCookies.length > 0) await cdp.send('Storage.setCookies', { cookies: replacedCookies })
  }
  const succeeded = (write: () => Promise<unknown>) => write().then(() => true, () => false)
  const lossy = isLossy(backup)
  if (!lossy && await succeeded(async () => {
    await writeSiteStorage(cdp, backup, scope)
    for (const tab of tabs) await inTab(cdp, tab.targetId, tab.origin, WRITE_SESSION_STORAGE_FUNCTION, [tab.entries])
    await putBackCrossSiteCookies()
  })) return 'the previous state was put back'
  if (await succeeded(async () => {
    await writeSiteStorage(cdp, { ...backup, cookies: [], origins: [] }, scope)
    await putBackCrossSiteCookies()
  })) {
    return lossy
      ? 'the previous state could not be fully backed up, so the site was cleared'
      : 'the previous state could not be put back, so the site was cleared'
  }
  return 'the previous state could not be put back or cleared'
}

export async function clearSiteStorage(cdp: CdpClient, site: string, storedOrigins: string[]): Promise<{ skipped: string[] }> {
  forgetPendingSessionStorage(site)
  const existing = await siteCookies(cdp, site)
  const pages = await listPages(cdp)
  const candidates = candidateOrigins(site, existing, await visitedUrls(cdp, pages), storedOrigins)
  if (existing.length > 0) await cdp.send('Storage.setCookies', { cookies: existing.map(expiredCookie) })
  const clearedSessionOrigins = await clearOrigins(cdp, pages, candidates)

  // Reload so open pages stop showing the signed-in state they still hold in memory.
  for (const page of pages) {
    const origin = originOf(page.url)
    if (!origin || !clearedSessionOrigins.includes(origin)) continue
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    try {
      await cdp.send('Page.reload', {}, sessionId)
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }
  // Session storage lives only in open tabs, so a stored origin with no open tab has none left to clear.
  const openOrigins = [...new Set(pages.map((page) => originOf(page.url)))]
    .filter((origin): origin is string => origin !== null && hostBelongsToSite(new URL(origin).hostname, site))
  return { skipped: openOrigins.filter((origin) => !clearedSessionOrigins.includes(origin)) }
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

const siteRequestSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  site: siteSchema,
  origins: z.array(originSchema).max(50).optional(),
}).strict()

const restoreRequestSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  bundle: siteStorageBundleSchema,
}).strict()

const clearRequestSchema = siteRequestSchema.extend({
  origins: z.array(originSchema).max(100),
}).refine(({ site, origins }) => origins.every((origin) => hostBelongsToSite(new URL(origin).hostname, site)))

export type BrowserStorageAction = 'baseline' | 'capture' | 'restore' | 'clear'

export interface BrowserStorageOptions {
  validateSession: (sessionId: string) => string | null
  isBrowserActive: () => boolean
  connect: () => Promise<CdpClient>
}

export type BrowserStorageResponse =
  | { success: true; body: unknown }
  | { success: false; status: 400 | 409 | 500; body: { error: string } }

export async function runBrowserStorage(
  action: BrowserStorageAction,
  rawBody: unknown,
  options: BrowserStorageOptions,
): Promise<BrowserStorageResponse> {
  const run = async (sessionId: string, operation: (cdp: CdpClient) => Promise<unknown>): Promise<BrowserStorageResponse> => {
    const validationError = options.validateSession(sessionId)
    if (validationError) return { success: false, status: 409, body: { error: validationError } }
    if (!options.isBrowserActive()) return { success: false, status: 409, body: { error: 'Browser is not active' } }
    const cdp = await options.connect()
    try {
      return { success: true, body: await operation(cdp) }
    } finally {
      cdp.close()
    }
  }
  const invalid: BrowserStorageResponse = { success: false, status: 400, body: { error: 'Invalid browser storage request' } }

  if (action === 'restore') {
    const parsed = restoreRequestSchema.safeParse(rawBody)
    if (!parsed.success) return invalid
    return run(parsed.data.sessionId, (cdp) => restoreSiteStorage(cdp, parsed.data.bundle))
  }
  if (action === 'clear') {
    const parsed = clearRequestSchema.safeParse(rawBody)
    if (!parsed.success) return invalid
    return run(parsed.data.sessionId, (cdp) => clearSiteStorage(cdp, parsed.data.site, parsed.data.origins))
  }
  const parsed = siteRequestSchema.safeParse(rawBody)
  if (!parsed.success) return invalid
  const { sessionId, site, origins } = parsed.data
  if (action === 'baseline') {
    return run(sessionId, async (cdp) => {
      await recordLoginBaseline(cdp, sessionId, site)
      return {}
    })
  }
  return run(sessionId, (cdp) => captureSiteStorage(cdp, site, origins, takeLoginBaseline(sessionId, site)))
}
