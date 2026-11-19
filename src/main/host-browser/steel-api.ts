/**
 * A thin client for the Steel cloud REST API: the calls the Steel host-browser
 * provider and the settings key check make. One instance per operation, from
 * the key that operation read; nothing is kept past it.
 */
import {
  steelErrorSchema,
  steelProfileSchema,
  steelSessionListSchema,
  steelSessionSchema,
  type SteelProfile,
  type SteelSession,
} from './steel-schemas'

export const STEEL_API_BASE = 'https://api.steel.dev/v1'

/** No call waits longer (session creation takes ~1 s): a stalled network must not hold a launch or shutdown. */
const REQUEST_TIMEOUT_MS = 30_000

/** A non-2xx answer from Steel, with the error code its body names (e.g. `profile_not_ready`). */
export class SteelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'SteelApiError'
  }
}

export class SteelApi {
  constructor(private readonly apiKey: string) {}

  async createSession(body: Record<string, unknown>): Promise<SteelSession> {
    return steelSessionSchema.parse(await this.request('POST', '/sessions', body))
  }

  async getSession(sessionId: string): Promise<SteelSession> {
    return steelSessionSchema.parse(await this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`))
  }

  /** Release a session. Steel answers 200 for one already released. */
  async releaseSession(sessionId: string): Promise<void> {
    await this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/release`)
  }

  async getProfile(profileId: string): Promise<SteelProfile> {
    return steelProfileSchema.parse(await this.request('GET', `/profiles/${encodeURIComponent(profileId)}`))
  }

  /** A live session using `profileId`, if any. */
  async findLiveSessionOnProfile(profileId: string): Promise<SteelSession | null> {
    return (await this.listLiveSessions((session) => session.profileId === profileId, 1))[0] ?? null
  }

  /** The account's live sessions that `match` (all of them by default), up to `limit`. */
  async listLiveSessions(match: (session: SteelSession) => boolean = () => true, limit = Infinity): Promise<SteelSession[]> {
    const found: SteelSession[] = []
    let cursor: string | null | undefined
    // Live sessions are few (a plan's concurrency limit); the page cap only stops a cursor loop.
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ status: 'live', limit: '100' })
      if (cursor) query.set('cursorId', cursor)
      const list = steelSessionListSchema.parse(await this.request('GET', `/sessions?${query}`))
      for (const session of list.sessions) {
        if (!match(session)) continue
        found.push(session)
        if (found.length >= limit) return found
      }
      cursor = list.nextCursor
      if (!cursor || list.sessions.length === 0) break
    }
    return found
  }

  /** One authenticated read, which creates nothing billable: does Steel accept this key? */
  async checkKey(): Promise<void> {
    await this.request('GET', '/sessions?limit=1')
  }

  /** The parsed JSON body of a 2xx answer; any other answer throws a {@link SteelApiError}. */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${STEEL_API_BASE}${path}`, {
      method,
      headers: {
        'steel-api-key': this.apiKey,
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
      // Not JSON (a proxy's HTML error page): reported with the status below.
    }
    if (!response.ok) {
      const error = steelErrorSchema.safeParse(json)
      const code = error.success ? error.data.code : undefined
      const message = error.success && error.data.message ? error.data.message : text.slice(0, 500)
      throw new SteelApiError(
        response.status,
        code,
        `Steel ${method} ${path.split('?')[0]} answered ${response.status}${code ? ` (${code})` : ''}: ${message}`,
        error.success ? error.data.retryAfterSeconds : undefined,
      )
    }
    return json
  }
}
