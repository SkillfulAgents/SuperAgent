import { addRendererBreadcrumb } from './error-reporting'

const STATIC_SEGMENTS = new Set([
  'api', 'agents', 'sessions', 'messages', 'preferences', 'notable', 'start', 'stop',
  'interrupt', 'queued-messages', 'tool-calls', 'subagent', 'workflows', 'tree',
  'chat-integrations', 'access', 'approve', 'deny', 'revoke', 'status', 'chats',
  'notifications', 'activity', 'stats', 'settings', 'user-settings', 'pending-requests',
  'webhook-triggers', 'answer-question', 'files', 'file-content', 'content', 'auth',
  'platform', 'runtime-status', 'automations', 'skills', 'templates', 'usage', 'upload-file',
  'upload-folder', 'artifacts', 'bookmarks', 'folders', 'entries', 'cloud-workspace',
])
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/

type TransportKind = 'offline' | 'abort' | 'timeout' | 'dns' | 'connection' | 'network' | 'unknown'
export type ApiOriginClass = 'same-origin' | 'loopback' | 'cloud-proxy' | 'remote'

export interface SafeApiContext {
  routeTemplate: string
  method: string
  operation: string
  originClass: ApiOriginClass
  online: boolean | 'unknown'
  visibility: 'visible' | 'hidden' | 'prerender' | 'unknown'
  lifecycle: 'request' | 'online' | 'offline' | 'pageshow' | 'visibility' | 'unknown'
  failureStreak: number
  durationBucket: '<250ms' | '<1s' | '<5s' | '<30s' | '>=30s'
  status?: number
  code?: string
  requestId?: string
  transport?: TransportKind
}

let lastLifecycle: SafeApiContext['lifecycle'] = 'unknown'
let listenersInstalled = false
const failureStreaks = new Map<string, number>()

function installLifecycleListeners(): void {
  if (listenersInstalled || typeof window === 'undefined') return
  listenersInstalled = true
  window.addEventListener('online', () => { lastLifecycle = 'online' })
  window.addEventListener('offline', () => { lastLifecycle = 'offline' })
  window.addEventListener('pageshow', () => { lastLifecycle = 'pageshow' })
  document?.addEventListener?.('visibilitychange', () => { lastLifecycle = 'visibility' })
}

export function sanitizeRouteTemplate(path: string): string {
  let pathname: string
  try {
    pathname = new URL(path, 'http://internal').pathname
  } catch {
    return '/invalid-route'
  }
  const segments = pathname.split('/').filter(Boolean).slice(0, 16)
  if (segments.length === 0) return '/'
  return `/${segments.map((segment) => STATIC_SEGMENTS.has(segment) ? segment : ':id').join('/')}`
}

export function classifyApiOrigin(baseUrl: string): ApiOriginClass {
  if (!baseUrl) return 'same-origin'
  try {
    const url = new URL(baseUrl, 'http://internal')
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
      return url.pathname.includes('/cloud/') ? 'cloud-proxy' : 'loopback'
    }
    if (typeof window !== 'undefined' && url.origin === window.location.origin) return 'same-origin'
    return 'remote'
  } catch {
    return 'remote'
  }
}

function durationBucket(durationMs: number): SafeApiContext['durationBucket'] {
  if (durationMs < 250) return '<250ms'
  if (durationMs < 1_000) return '<1s'
  if (durationMs < 5_000) return '<5s'
  if (durationMs < 30_000) return '<30s'
  return '>=30s'
}

function classifyTransport(error: unknown): TransportKind {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
  if (error instanceof DOMException && error.name === 'AbortError') return 'abort'
  const name = error instanceof Error ? error.name.toLowerCase() : ''
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (name.includes('abort')) return 'abort'
  if (name.includes('timeout') || message.includes('timeout')) return 'timeout'
  if (message.includes('dns') || message.includes('name_not_resolved')) return 'dns'
  if (message.includes('connection') || message.includes('socket')) return 'connection'
  if (error instanceof TypeError) return 'network'
  return 'unknown'
}

function browserState(): Pick<SafeApiContext, 'online' | 'visibility' | 'lifecycle'> {
  installLifecycleListeners()
  const visibility = typeof document !== 'undefined' &&
    (document.visibilityState === 'visible' || document.visibilityState === 'hidden' || document.visibilityState === 'prerender')
    ? document.visibilityState
    : 'unknown'
  return {
    online: typeof navigator === 'undefined' ? 'unknown' : navigator.onLine,
    visibility,
    lifecycle: lastLifecycle,
  }
}

export function beginApiRequest(path: string, init: RequestInit | undefined, baseUrl: string, operation?: string) {
  const routeTemplate = sanitizeRouteTemplate(path)
  const method = (init?.method ?? 'GET').toUpperCase().slice(0, 12)
  const key = `${method}:${routeTemplate}`
  const startedAt = Date.now()
  const base = {
    routeTemplate,
    method,
    operation: (operation && SAFE_CODE.test(operation) ? operation : `${method.toLowerCase()}-request`).slice(0, 64),
    originClass: classifyApiOrigin(baseUrl),
  }

  const finish = (response: Response): SafeApiContext => {
    const failed = !response.ok
    const failureStreak = failed ? (failureStreaks.get(key) ?? 0) + 1 : 0
    if (failed) failureStreaks.set(key, failureStreak)
    else failureStreaks.delete(key)
    const requestIdHeader = response.headers.get('x-request-id') ?? response.headers.get('request-id')
    const context: SafeApiContext = {
      ...base,
      ...browserState(),
      lifecycle: lastLifecycle === 'unknown' ? 'request' : lastLifecycle,
      failureStreak,
      durationBucket: durationBucket(Date.now() - startedAt),
      status: response.status,
      ...(requestIdHeader && SAFE_REQUEST_ID.test(requestIdHeader) ? { requestId: requestIdHeader } : {}),
    }
    if (failed) addApiFailureBreadcrumb(context)
    return context
  }

  const fail = (error: unknown): SafeApiContext => {
    const failureStreak = (failureStreaks.get(key) ?? 0) + 1
    failureStreaks.set(key, failureStreak)
    const context: SafeApiContext = {
      ...base,
      ...browserState(),
      lifecycle: lastLifecycle === 'unknown' ? 'request' : lastLifecycle,
      failureStreak,
      durationBucket: durationBucket(Date.now() - startedAt),
      transport: classifyTransport(error),
    }
    addApiFailureBreadcrumb(context)
    return context
  }

  return { finish, fail }
}

function addApiFailureBreadcrumb(context: SafeApiContext): void {
  addRendererBreadcrumb({
    category: 'api.request',
    message: `${context.operation} failed`,
    level: 'warning',
    data: { ...context },
  })
}

export class ApiRequestError extends Error {
  readonly context: SafeApiContext

  constructor(context: SafeApiContext) {
    super(`${context.operation} failed${context.status ? ` (HTTP ${context.status})` : ` (${context.transport ?? 'unknown'})`}`)
    this.name = 'ApiRequestError'
    this.context = Object.freeze({ ...context })
  }
}

const responseContexts = new WeakMap<Response, SafeApiContext>()

export function rememberResponseContext(response: Response, context: SafeApiContext): void {
  responseContexts.set(response, context)
}

export function responseContext(response: Response, path: string, operation: string): SafeApiContext {
  return responseContexts.get(response) ?? {
    routeTemplate: sanitizeRouteTemplate(path),
    method: 'GET',
    operation: SAFE_CODE.test(operation) ? operation : 'api-request',
    originClass: 'same-origin',
    ...browserState(),
    failureStreak: 1,
    durationBucket: '<250ms',
    status: response.status,
  }
}

export async function apiErrorFromResponse(response: Response, path: string, operation: string): Promise<ApiRequestError> {
  const context = { ...responseContext(response, path, operation), operation }
  try {
    const payload = await response.clone().json() as { code?: unknown }
    if (typeof payload?.code === 'string' && SAFE_CODE.test(payload.code)) context.code = payload.code
  } catch {
    // Bodies are deliberately neither retained nor reported.
  }
  return new ApiRequestError(context)
}

export async function throwApiError(response: Response, path: string, operation: string): Promise<never> {
  throw await apiErrorFromResponse(response, path, operation)
}

/** Convert a failed response already observed by apiFetch into a typed, body-free error. */
export async function throwApiResponseError(response: Response, operation: string): Promise<never> {
  const remembered = responseContexts.get(response)
  throw await apiErrorFromResponse(response, remembered?.routeTemplate ?? '/unknown-route', operation)
}

export function apiTransportError(error: unknown, context: SafeApiContext): ApiRequestError {
  if (error instanceof ApiRequestError) return error
  return new ApiRequestError(context)
}

export function resetApiObservabilityForTest(): void {
  failureStreaks.clear()
  lastLifecycle = 'unknown'
}
