/**
 * A thin client for a Tab Tender server's public REST API: the calls the Tab
 * Tender host-browser provider and the settings check make. One instance per
 * operation, from the URL and key that operation read; nothing is kept past it.
 */
import {
  tabtenderErrorSchema,
  tabtenderHealthSchema,
  tabtenderSessionListSchema,
  tabtenderSessionSchema,
  type TabtenderHealth,
  type TabtenderSession,
} from './tabtender-schemas'

/** No call waits longer: creating a session launches Chrome (a few seconds); a stalled network must not hold a launch or shutdown. */
const REQUEST_TIMEOUT_MS = 30_000

/** A non-2xx answer from Tab Tender, with the error code its body names (e.g. `profile_in_use`). */
export class TabtenderApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'TabtenderApiError'
  }
}

/** The server's base URL as entered, without a trailing slash; null when it is not an http(s) URL. */
export function normalizeTabtenderUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Whether a server URL names this machine's loopback (`localhost`, `127.x`,
 * `::1`): Tab Tender builds a session's CDP URL on the address it was reached
 * at, and an agent container cannot reach the host's loopback.
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return false
  }
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127\./.test(hostname)
}

export class TabtenderApi {
  private readonly baseUrl: string

  constructor(baseUrl: string, private readonly apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async createSession(body: { ttlSeconds?: number; profile?: string; headless?: boolean }): Promise<TabtenderSession> {
    return tabtenderSessionSchema.parse(await this.request('POST', '/v1/sessions', body))
  }

  async getSession(sessionId: string): Promise<TabtenderSession> {
    return tabtenderSessionSchema.parse(await this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`))
  }

  async listSessions(): Promise<TabtenderSession[]> {
    return tabtenderSessionListSchema.parse(await this.request('GET', '/v1/sessions')).sessions
  }

  /** Terminate a session. Tab Tender answers 404 for one already ended, which counts as done. */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`)
    } catch (error) {
      if (error instanceof TabtenderApiError && error.status === 404) return
      throw error
    }
  }

  /** One authenticated read, which launches nothing: is the server there, and does it accept this key? */
  async health(): Promise<TabtenderHealth> {
    return tabtenderHealthSchema.parse(await this.request('GET', '/v1/health'))
  }

  /** The parsed JSON body of a 2xx answer; any other answer throws a {@link TabtenderApiError}. */
  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      // Not JSON (a proxy's or tunnel's HTML error page): reported with the status below.
    }
    if (!response.ok) {
      const error = tabtenderErrorSchema.safeParse(json)
      const code = error.success ? error.data.error.code : undefined
      const message = error.success && error.data.error.message ? error.data.error.message : text.slice(0, 500)
      throw new TabtenderApiError(
        response.status,
        code,
        `Tab Tender ${method} ${path} answered ${response.status}${code ? ` (${code})` : ''}: ${message}`,
      )
    }
    return json
  }
}
