import { createHash } from 'crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  READ_ORIGIN_STORAGE_FUNCTION,
  READ_SESSION_STORAGE_FUNCTION,
  WRITE_ORIGIN_STORAGE_FUNCTION,
  WRITE_SESSION_STORAGE_FUNCTION,
} from './browser-storage-script'

const CDP_TIMEOUT_MS = 15_000
const STUB_PATH = '/__superagent_storage__'
const STUB_HTML_BASE64 = Buffer.from('<!doctype html><title></title>').toString('base64')

// ---------------------------------------------------------------------------
// Bundle format
// ---------------------------------------------------------------------------

const siteSchema = z.string().max(253).regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'site must be a lowercase registrable domain')

const originSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}, 'must be an http(s) origin')

const entriesSchema = z.array(z.tuple([z.string(), z.string()])).max(10_000)

const cookieSchema = z.object({
  name: z.string().max(4096),
  value: z.string().max(16_384),
  domain: z.string().min(1).max(253),
  path: z.string().max(2048),
  expires: z.number().optional(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  priority: z.enum(['Low', 'Medium', 'High']).optional(),
  sourceScheme: z.enum(['Unset', 'NonSecure', 'Secure']).optional(),
  sourcePort: z.number().int().optional(),
  partitionKey: z.object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() }).optional(),
}).strict()

const keyPathSchema = z.union([z.string(), z.array(z.string())])

const indexedDbDatabaseSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(z.object({
    name: z.string(),
    keyPath: keyPathSchema.nullable(),
    autoIncrement: z.boolean(),
    indexes: z.array(z.object({
      name: z.string(),
      keyPath: keyPathSchema,
      unique: z.boolean(),
      multiEntry: z.boolean(),
    }).strict()),
    records: z.array(z.object({ key: z.unknown(), value: z.unknown() }).strict()),
  }).strict()),
}).strict()

const originStorageSchema = z.object({
  origin: originSchema,
  localStorage: entriesSchema,
  indexedDB: z.array(indexedDbDatabaseSchema).max(100),
  /** Only present when a tab of this origin was open at capture time. */
  sessionStorage: entriesSchema.optional(),
  /** Value types that cannot leave the browser (e.g. non-extractable CryptoKey). */
  unsupported: z.array(z.string()),
}).strict()

export const siteStorageBundleSchema = z.object({
  version: z.literal(1),
  site: siteSchema,
  capturedAt: z.string(),
  cookies: z.array(cookieSchema).max(5000),
  origins: z.array(originStorageSchema).max(100),
}).strict()

export type StorageCookie = z.infer<typeof cookieSchema>
export type OriginStorage = z.infer<typeof originStorageSchema>
export type SiteStorageBundle = z.infer<typeof siteStorageBundleSchema>

export interface SiteStorageSnapshot {
  site: string
  cookies: Array<{
    name: string
    domain: string
    path: string
    partitionKey?: StorageCookie['partitionKey']
    expires?: number
    valueHash: string
  }>
  origins: Array<{
    origin: string
    localStorage: Record<string, string>
    indexedDB: Array<{ name: string; version: number; hash: string }>
    sessionStorage?: Record<string, string>
  }>
}

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

const hashValue = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

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
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
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
        if (message.error) call.reject(new Error(`${message.error.message ?? 'CDP error'}`))
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
          pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
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
  if (response.exceptionDetails) throw new Error('Browser storage script failed')
  return response.result.value
}

/**
 * Run `fn` on a background tab whose document is a blank page served for
 * `origin`. Fetch interception answers every request for the origin, so the
 * real site is never contacted and the viewer never switches to this tab.
 */
async function withStubPage<T>(cdp: CdpClient, origin: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true })
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
  unsupported: string[]
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function captureSiteStorage(cdp: CdpClient, site: string, extraOrigins: string[] = []): Promise<SiteStorageBundle> {
  const cookies = await siteCookies(cdp, site)
  const pages = await listPages(cdp)
  const origins: OriginStorage[] = []
  for (const origin of candidateOrigins(site, cookies, pages.map((page) => page.url), extraOrigins)) {
    const read = await withStubPage(cdp, origin, (sessionId) => callInPage<ReadOriginResult>(cdp, sessionId, READ_ORIGIN_STORAGE_FUNCTION))
    const sessionStorage = await withOpenTab(cdp, pages, origin, (sessionId) =>
      callInPage<Array<[string, string]>>(cdp, sessionId, READ_SESSION_STORAGE_FUNCTION))
    origins.push({
      origin,
      localStorage: read.localStorage,
      indexedDB: read.indexedDB,
      ...(sessionStorage ? { sessionStorage } : {}),
      unsupported: read.unsupported,
    })
  }
  return siteStorageBundleSchema.parse({ version: 1, site, capturedAt: new Date().toISOString(), cookies, origins })
}

/** Same scopes as a capture, but values are hashed so the caller can diff before/after a login without holding secrets. */
export async function snapshotSiteStorage(cdp: CdpClient, site: string, extraOrigins: string[] = []): Promise<SiteStorageSnapshot> {
  const bundle = await captureSiteStorage(cdp, site, extraOrigins)
  const hashEntries = (entries: Array<[string, string]>) => Object.fromEntries(entries.map(([key, value]) => [key, hashValue(value)]))
  return {
    site,
    cookies: bundle.cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
      valueHash: hashValue(cookie.value),
    })),
    origins: bundle.origins.map((origin) => ({
      origin: origin.origin,
      localStorage: hashEntries(origin.localStorage),
      indexedDB: origin.indexedDB.map((db) => ({ name: db.name, version: db.version, hash: hashValue(JSON.stringify(db.stores)) })),
      ...(origin.sessionStorage ? { sessionStorage: hashEntries(origin.sessionStorage) } : {}),
    })),
  }
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
    const written = await withStubPage(cdp, origin.origin, (sessionId) => callInPage<{ localStorage: number; indexedDB: number; skippedRecords: number }>(
      cdp, sessionId, WRITE_ORIGIN_STORAGE_FUNCTION, [{ localStorage: origin.localStorage, indexedDB: origin.indexedDB }]))
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

export type BrowserStorageAction = 'snapshot' | 'capture' | 'restore'

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
  return run(sessionId, (cdp) => action === 'capture'
    ? captureSiteStorage(cdp, site, origins)
    : snapshotSiteStorage(cdp, site, origins))
}
