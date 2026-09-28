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
 * real site is never contacted.
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

/** First open tab on `origin`; sessionStorage only exists per tab. */
async function withOpenTab<T>(cdp: CdpClient, pages: Array<{ targetId: string; url: string }>, origin: string, fn: (sessionId: string) => Promise<T>): Promise<T | undefined> {
  const page = pages.find((candidate) => originOf(candidate.url) === origin && !candidate.url.endsWith(STUB_PATH))
  if (!page) return undefined
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  try {
    return await fn(sessionId)
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
}

async function siteCookies(cdp: CdpClient, site: string): Promise<StorageCookie[]> {
  const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies')
  return cookies.filter((cookie) => hostBelongsToSite(cookie.domain, site)).map(toStorageCookie)
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

export async function captureSiteStorage(cdp: CdpClient, site: string, extraOrigins: string[] = []): Promise<SiteStorageBundle> {
  const cookies = await siteCookies(cdp, site)
  const pages = await listPages(cdp)
  const visitedUrls = [...pages.map((page) => page.url), ...await historyUrls(cdp, pages)]
  const origins: OriginStorage[] = []
  for (const origin of candidateOrigins(site, cookies, visitedUrls, extraOrigins)) {
    const { oversizedDatabases, ...read } = await withStubPage(cdp, origin, (sessionId) =>
      callInPage<ReadOriginResult>(cdp, sessionId, READ_ORIGIN_STORAGE_FUNCTION))
    const sessionStorage = await withOpenTab(cdp, pages, origin, (sessionId) =>
      callInPage<Array<[string, string]>>(cdp, sessionId, READ_SESSION_STORAGE_FUNCTION))
    origins.push({
      origin,
      ...read,
      ...(sessionStorage ? { sessionStorage } : {}),
      ...(oversizedDatabases.length > 0 ? { oversizedDatabases } : {}),
    })
  }
  return siteStorageBundleSchema.parse({ version: 1, site, capturedAt: new Date().toISOString(), cookies, origins })
}

/**
 * Make the browser's state for the bundle's site match the bundle: existing
 * cookies under the site are removed first (a stale anonymous device cookie
 * next to the restored one breaks some logins), then each origin's storage is
 * replaced. Does not reload any page.
 */
export async function restoreSiteStorage(cdp: CdpClient, bundle: SiteStorageBundle): Promise<RestoreResult> {
  const existing = await siteCookies(cdp, bundle.site)
  if (existing.length > 0) await cdp.send('Storage.setCookies', { cookies: existing.map(expiredCookie) })
  if (bundle.cookies.length > 0) await cdp.send('Storage.setCookies', { cookies: bundle.cookies })

  const pages = await listPages(cdp)
  const origins: RestoreResult['origins'] = []
  const sessionStorageSkipped: string[] = []
  for (const origin of bundle.origins) {
    const written = await withStubPage(cdp, origin.origin, async (sessionId) => {
      // Browser-side clear force-closes open IndexedDB connections (e.g. the agent's own tab on this origin); an
      // in-page deleteDatabase would block on them. Sent on the tab's session so it targets the tab's browser
      // context: remote providers (Browserbase) keep pages out of the default one and fail a browser-level call.
      await cdp.send('Storage.clearDataForOrigin', { origin: origin.origin, storageTypes: 'indexeddb' }, sessionId)
      return callInPage<{ localStorage: number; indexedDB: number; skippedRecords: number }>(
        cdp, sessionId, WRITE_ORIGIN_STORAGE_FUNCTION, [{ localStorage: origin.localStorage, indexedDB: origin.indexedDB }])
    })
    origins.push({ origin: origin.origin, ...written })
    if (origin.sessionStorage) {
      const restored = await withOpenTab(cdp, pages, origin.origin, (sessionId) =>
        callInPage<number>(cdp, sessionId, WRITE_SESSION_STORAGE_FUNCTION, [origin.sessionStorage]))
      if (restored === undefined) sessionStorageSkipped.push(origin.origin)
    }
  }
  return { cookies: bundle.cookies.length, origins, sessionStorageSkipped }
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

export type BrowserStorageAction = 'capture' | 'restore'

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
  const parsed = siteRequestSchema.safeParse(rawBody)
  if (!parsed.success) return invalid
  const { sessionId, site, origins } = parsed.data
  return run(sessionId, (cdp) => captureSiteStorage(cdp, site, origins))
}
