/**
 * SteelProvider against a fake Steel that behaves as the real API was measured
 * to (2026-11-15, Launch plan):
 * - a timeout over the plan's cap is refused with the cap in the message;
 * - a session that creates a profile holds it (`profile_not_ready`, 409) until
 *   it is released and saved; any number of sessions load a saved profile;
 * - a profile is saved a moment after its session ends (released, timed out,
 *   browser closed), when its `sourceSessionId` names that session. Steel does
 *   not stop a session loading it before then: that session starts from the
 *   older state (a stale load, which the provider must never cause);
 * - a profile Steel no longer has is `profile_not_found` (404);
 * - every read of a session signs a new token into its URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  watch: vi.fn(),
  stopWatch: vi.fn(),
  settings: { apiKeys: { steelApiKey: 'ste-test' } as { steelApiKey?: string }, app: {} as Record<string, unknown> },
  reads: 0,
  mappings: new Map<string, string>(),
  /** Make saving a new mapping fail after its create ran (a database error). */
  mappingWriteFails: false,
}))
vi.mock('./google-passkey-recovery', () => ({
  GooglePasskeyRecovery: class { watch = h.watch; stop = h.stopWatch },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => {
    h.reads++
    return h.settings
  },
  effectiveSteelApiKeyFrom: (settings: typeof h.settings) => settings.apiKeys?.steelApiKey,
}))
// The mapping store's own semantics (insert-if-absent, compare-and-set) are tested in context-map-store.test.ts.
vi.mock('./context-map-store', () => ({
  readContextMapping: async (provider: string, key: string) => h.mappings.get(`${provider}:${key}`) ?? null,
  getOrCreateMapping: async (provider: string, key: string, create: () => Promise<string>) => {
    const k = `${provider}:${key}`
    if (!h.mappings.has(k)) {
      const id = await create()
      if (h.mappingWriteFails) throw new Error('SQLITE_BUSY')
      h.mappings.set(k, id)
    }
    return h.mappings.get(k)!
  },
  replaceContextMapping: async (provider: string, key: string, staleId: string, nextId: string) => {
    const k = `${provider}:${key}`
    if (!h.mappings.has(k) || h.mappings.get(k) === staleId) h.mappings.set(k, nextId)
    return h.mappings.get(k)!
  },
}))

import {
  SteelProvider,
  planTimeoutCapFrom,
  steelSessionOptionsFrom,
  STEEL_PROFILE_SAVE_WAIT_MS,
  STEEL_SESSION_TIMEOUT_MS,
} from './steel-provider'

interface FakeSession { id: string; status: string; profileId?: string; body: Record<string, unknown> }
interface FakeProfile { status: 'READY' | 'UPLOADING'; sourceSessionId: string | null }

/** The fake Steel account: sessions, profiles, and a log of what was asked of it. */
class FakeSteel {
  planCapMs = 900_000
  sessions = new Map<string, FakeSession>()
  profiles = new Map<string, FakeProfile>()
  /** How many profile reads (or refused creates) a save takes to land after its session ends. */
  saveDelay = 2
  /** Saves under way: profile id → the session being saved and the reads left until it lands. */
  saving = new Map<string, { sessionId: string; left: number }>()
  creates: Array<Record<string, unknown>> = []
  createdAt: number[] = []
  /** Session reads answered 503 (Steel briefly unreachable). */
  failingReads = 0
  /** While set, release requests wait for it: a release in flight. */
  releaseGate: Promise<void> | null = null
  releases: string[] = []
  staleLoads = 0
  private tokens = 0

  /** The session ended (released, timed out, browser closed): Steel starts saving its profile. */
  end(sessionId: string) {
    const session = this.sessions.get(sessionId)!
    if (session.status !== 'live') return
    session.status = 'released'
    if (session.profileId && session.body.persistProfile) {
      this.saving.set(session.profileId, { sessionId, left: this.saveDelay })
    }
  }

  private tick(profileId: string) {
    const save = this.saving.get(profileId)
    if (!save || --save.left > 0) return
    this.saving.delete(profileId)
    this.profiles.set(profileId, { status: 'READY', sourceSessionId: save.sessionId })
  }

  wire(session: FakeSession) {
    return {
      id: session.id,
      status: session.status,
      profileId: session.profileId ?? null,
      websocketUrl: `wss://connect.steel.dev?sessionId=${session.id}&token=t${++this.tokens}`,
    }
  }

  handle(url: string, init?: RequestInit): Response {
    const { pathname, searchParams } = new URL(url)
    const method = init?.method ?? 'GET'
    if ((init?.headers as Record<string, string> | undefined)?.['steel-api-key'] !== 'ste-test') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (method === 'POST' && pathname === '/v1/sessions') {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>
      this.creates.push(body)
      this.createdAt.push(Date.now())
      if (Number(body.timeout) > this.planCapMs) {
        return Response.json({
          code: 'session_timeout_exceeded',
          message: `Requested 'timeout' of ${body.timeout} ms exceeds the maximum of 15 minutes on the launch plan. Set 'timeout' to ${this.planCapMs} or less, or upgrade your plan for longer sessions.`,
        }, { status: 400 })
      }
      const id = `session-${this.sessions.size + 1}`
      let profileId = body.profileId as string | undefined
      if (profileId) {
        const profile = this.profiles.get(profileId)
        if (!profile) return Response.json({ code: 'profile_not_found', message: `Profile '${profileId}' not found.` }, { status: 404 })
        if (profile.status === 'UPLOADING') {
          this.tick(profileId)
          return Response.json({ code: 'profile_not_ready', message: 'not ready', retryAfterSeconds: 0 }, { status: 409 })
        }
        if (this.saving.has(profileId)) this.staleLoads++
      } else if (body.persistProfile) {
        profileId = `profile-${this.profiles.size + 1}`
        this.profiles.set(profileId, { status: 'UPLOADING', sourceSessionId: null })
      }
      const session: FakeSession = { id, status: 'live', profileId, body }
      this.sessions.set(id, session)
      return Response.json(this.wire(session), { status: 201 })
    }
    if (method === 'GET' && pathname === '/v1/sessions') {
      const listed = [...this.sessions.values()].filter((s) => searchParams.get('status') !== 'live' || s.status === 'live')
      return Response.json({ sessions: listed.map((s) => this.wire(s)), nextCursor: null })
    }
    const profileRead = pathname.match(/^\/v1\/profiles\/([^/]+)$/)
    if (method === 'GET' && profileRead) {
      if (!this.profiles.has(profileRead[1])) return Response.json({ code: 'profile_not_found' }, { status: 404 })
      this.tick(profileRead[1])
      const profile = this.profiles.get(profileRead[1])!
      return Response.json({ id: profileRead[1], ...profile })
    }
    const release = pathname.match(/^\/v1\/sessions\/([^/]+)\/release$/)
    if (method === 'POST' && release) {
      if (!this.sessions.has(release[1])) return Response.json({ code: 'not_found' }, { status: 404 })
      this.releases.push(release[1])
      this.end(release[1])
      return Response.json({ success: true })
    }
    const get = pathname.match(/^\/v1\/sessions\/([^/]+)$/)
    if (method === 'GET' && get && this.failingReads > 0) {
      this.failingReads--
      return Response.json({ code: 'unavailable', message: 'Service Unavailable' }, { status: 503 })
    }
    if (method === 'GET' && get) {
      const session = this.sessions.get(get[1])
      return session ? Response.json(this.wire(session)) : Response.json({ code: 'not_found' }, { status: 404 })
    }
    return Response.json({ code: 'unexpected', message: `${method} ${pathname}` }, { status: 500 })
  }
}

let steel: FakeSteel
beforeEach(() => {
  vi.clearAllMocks()
  h.settings = { apiKeys: { steelApiKey: 'ste-test' }, app: {} }
  h.reads = 0
  h.mappings.clear()
  steel = new FakeSteel()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mappingWriteFails = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (steel.releaseGate && url.endsWith('/release')) await steel.releaseGate
    return steel.handle(url, init)
  }))
})
afterEach(() => {
  expect(steel.staleLoads).toBe(0)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('detect', () => {
  it('is available with an API key and not without', async () => {
    expect(await new SteelProvider().detect()).toMatchObject({ id: 'steel', available: true })
    h.settings.apiKeys = {}
    expect(await new SteelProvider().detect()).toMatchObject({ available: false, reason: 'API key not configured' })
  })
})

describe('launch', () => {
  it("creates the agent's profile with its first session and hands over the session's signed URL", async () => {
    const provider = new SteelProvider()
    const info = await provider.launch('agent-a', {}, 'agent-a')
    expect(info.cdpUrl).toMatch(/^wss:\/\/connect\.steel\.dev\?sessionId=session-1&token=/)
    expect(info.cdpUrl).not.toContain('ste-test')
    expect(h.mappings.get('steel:agent-a')).toBe('profile-1')
    expect(steel.creates.at(-1)).toMatchObject({ persistProfile: true, timeout: 900_000 })
    expect(steel.creates.at(-1)).not.toHaveProperty('profileId')
    expect(h.watch).toHaveBeenLastCalledWith('agent-a', info.cdpUrl)
    expect(provider.isRunning('agent-a')).toBe(true)
  })

  it('asks for the long timeout first and settles for the plan cap Steel names, once per launch', async () => {
    steel.planCapMs = 3_600_000
    await new SteelProvider().launch('agent-a', {}, 'agent-a')
    expect(steel.creates.map((c) => c.timeout)).toEqual([STEEL_SESSION_TIMEOUT_MS, 3_600_000])
    expect(steel.sessions.size).toBe(1)
  })

  it('reuses a live session with the URL it handed over, without creating another', async () => {
    const provider = new SteelProvider()
    const first = await provider.launch('agent-a', {}, 'agent-a')
    const again = await provider.launch('agent-a', {}, 'agent-a')
    expect(again.cdpUrl).toBe(first.cdpUrl)
    expect(steel.sessions.size).toBe(1)
  })

  it('joins a launch already under way for the instance', async () => {
    const provider = new SteelProvider()
    const [a, b] = await Promise.all([provider.launch('agent-a', {}, 'agent-a'), provider.launch('agent-a', {}, 'agent-a')])
    expect(a).toEqual(b)
    expect(steel.sessions.size).toBe(1)
  })

  it('opens the next browser on the profile only once Steel has saved it from the last one', async () => {
    const provider = new SteelProvider()
    await provider.launch('agent-a', {}, 'agent-a')
    await provider.stop('agent-a')
    expect(steel.releases).toEqual(['session-1'])
    const second = await provider.launch('agent-a', {}, 'agent-a')
    expect(second.cdpUrl).toContain('session-2')
    expect(steel.profiles.get('profile-1')!.sourceSessionId).toBe('session-1')

    // A session that loaded the profile is waited for the same way.
    await provider.stop('agent-a')
    const third = await provider.launch('agent-a', {}, 'agent-a')
    expect(third.cdpUrl).toContain('session-3')
    expect(steel.profiles.get('profile-1')!.sourceSessionId).toBe('session-2')
    expect(steel.creates.at(-1)).toMatchObject({ profileId: 'profile-1', persistProfile: true })
  })

  it('waits for the save of a session that ended on its own (timeout, a client closed the browser)', async () => {
    const provider = new SteelProvider()
    await provider.launch('agent-a', {}, 'agent-a')
    await provider.stop('agent-a')
    await provider.launch('agent-a', {}, 'agent-a')
    steel.saveDelay = 3
    steel.end('session-2')
    const info = await provider.launch('agent-a', {}, 'agent-a')
    expect(info.cdpUrl).toContain('session-3')
    expect(steel.profiles.get('profile-1')!.sourceSessionId).toBe('session-2')
    expect(h.stopWatch).toHaveBeenCalledWith('agent-a')
  })

  it('opens the browser anyway when the save never shows, past the wait', async () => {
    vi.useFakeTimers()
    const provider = new SteelProvider()
    await provider.launch('agent-a', {}, 'agent-a')
    await provider.stop('agent-a')
    // Saved, but naming another session: this one's save never shows.
    steel.saving.delete('profile-1')
    steel.profiles.set('profile-1', { status: 'READY', sourceSessionId: 'session-elsewhere' })
    const launch = provider.launch('agent-a', {}, 'agent-a')
    await vi.advanceTimersByTimeAsync(STEEL_PROFILE_SAVE_WAIT_MS + 1_000)
    expect((await launch).cdpUrl).toContain('session-2')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not saved from session session-1'))
  })

  it("uses the agent's live session again after the app restarted, rather than opening a second", async () => {
    const before = new SteelProvider()
    await before.launch('agent-a', {}, 'agent-a')
    await before.stop('agent-a')
    await before.launch('agent-a', {}, 'agent-a') // session-2 loads the saved profile and stays live
    const restarted = new SteelProvider()
    const info = await restarted.launch('agent-a', {}, 'agent-a')
    expect(info.cdpUrl).toContain('sessionId=session-2')
    expect(steel.sessions.size).toBe(2)
    await restarted.stop('agent-a')
    expect(steel.releases).toEqual(['session-1', 'session-2'])
  })

  it("uses the profile's first session again after a restart while it still holds the profile", async () => {
    await new SteelProvider().launch('agent-a', {}, 'agent-a')
    const info = await new SteelProvider().launch('agent-a', {}, 'agent-a')
    expect(info.cdpUrl).toContain('sessionId=session-1')
    expect(steel.sessions.size).toBe(1)
  })

  it('keeps using the browser it has when Steel does not answer whether it is live', async () => {
    const provider = new SteelProvider()
    const first = await provider.launch('agent-a', {}, 'agent-a')
    steel.failingReads = 1
    const started = Date.now()
    expect((await provider.launch('agent-a', {}, 'agent-a')).cdpUrl).toBe(first.cdpUrl)
    expect(Date.now() - started).toBeLessThan(400)
    expect(steel.sessions.size).toBe(1)
  })

  it('releases the session it created when saving the new mapping fails', async () => {
    h.mappingWriteFails = true
    await expect(new SteelProvider().launch('agent-a', {}, 'agent-a')).rejects.toThrow('SQLITE_BUSY')
    expect(steel.releases).toEqual(['session-1'])
  })

  it('never takes over a session being released, and waits for its save instead', async () => {
    const provider = new SteelProvider()
    await provider.launch('agent-a', {}, 'agent-a')
    let open!: () => void
    steel.releaseGate = new Promise((resolve) => { open = resolve })
    const stopping = provider.stop('agent-a')
    await vi.waitFor(() => expect(provider.isRunning('agent-a')).toBe(false))
    // The release is in flight and session-1 still answers live.
    const launching = provider.launch('agent-a', {}, 'agent-a')
    await new Promise((resolve) => setTimeout(resolve, 50))
    open()
    steel.releaseGate = null
    await stopping
    const info = await launching
    expect(info.cdpUrl).toContain('session-2')
    expect(steel.profiles.get('profile-1')!.sourceSessionId).toBe('session-1')
  })

  it("waits out the first session's save when a restart comes just after its release", async () => {
    const before = new SteelProvider()
    await before.launch('agent-a', {}, 'agent-a')
    await before.stop('agent-a')
    // The new process knows of the release only through AppState.
    const info = await new SteelProvider().launch('agent-a', {}, 'agent-a')
    expect(info.cdpUrl).toContain('session-2')
  })

  it('spaces its retries while the first session holds the profile, whatever retry delay Steel names', async () => {
    await new SteelProvider().launch('agent-a', {}, 'agent-a')
    // A process that never saw it end (its record expired): Steel answers profile_not_ready, retry after 0 s.
    steel.end('session-1')
    steel.saveDelay = 3
    await new SteelProvider().launch('agent-b', {}, 'agent-b') // a different agent: no effect on agent-a
    h.mappings.set('steel:agent-c', 'profile-1')
    const before = steel.createdAt.length
    await new SteelProvider().launch('agent-c', {}, 'agent-c')
    const onProfile = steel.creates.slice(before).map((c, i) => ({ c, at: steel.createdAt[before + i] }))
      .filter(({ c }) => c.profileId === 'profile-1' && c.timeout === 900_000)
    expect(onProfile.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < onProfile.length; i++) expect(onProfile[i].at - onProfile[i - 1].at).toBeGreaterThanOrEqual(450)
  })

  it('replaces a profile Steel no longer has (unused for 30 days)', async () => {
    h.mappings.set('steel:agent-a', 'profile-expired')
    const info = await new SteelProvider().launch('agent-a', {}, 'agent-a')
    expect(info.cdpUrl).toContain('session-1')
    expect(h.mappings.get('steel:agent-a')).toBe('profile-1')
  })

  it('uses the profile another process mapped first, and releases the session it made for its own', async () => {
    h.mappings.set('steel:agent-a', 'profile-expired')
    // Another process replaces the mapping while this one creates a fresh profile.
    const original = steel.handle.bind(steel)
    let raced = false
    steel.handle = (url, init) => {
      const response = original(url, init)
      if (!raced && init?.method === 'POST' && response.status === 201) {
        raced = true
        steel.profiles.set('profile-other', { status: 'READY', sourceSessionId: null })
        h.mappings.set('steel:agent-a', 'profile-other')
      }
      return response
    }
    const info = await new SteelProvider().launch('agent-a', {}, 'agent-a')
    expect(steel.releases).toEqual(['session-1'])
    expect(info.cdpUrl).toContain('session-2')
    expect(steel.sessions.get('session-2')!.profileId).toBe('profile-other')
  })

  it('passes the CAPTCHA and proxy settings to Steel', async () => {
    h.settings.app = { steelSolveCaptcha: true, steelProxies: true, steelProxyCountry: 'US', steelProxyState: 'NY' }
    await new SteelProvider().launch('agent-a', {}, 'agent-a')
    expect(steel.creates.at(-1)).toMatchObject({ solveCaptcha: true, useProxy: { geolocation: { country: 'US', state: 'NY' } } })
  })

  it('surfaces a refusal Steel gives (a plan feature without credits) as the launch error', async () => {
    const original = steel.handle.bind(steel)
    steel.handle = (url, init) => init?.method === 'POST'
      ? Response.json({ code: 'deposit_required', message: 'On the Launch plan, CAPTCHA solving and Steel proxies need at least $10 in paid balance.' }, { status: 403 })
      : original(url, init)
    await expect(new SteelProvider().launch('agent-a', {}, 'agent-a')).rejects.toThrow(/403 \(deposit_required\).*\$10 in paid balance/)
  })

  it('refuses without an API key', async () => {
    h.settings.apiKeys = {}
    await expect(new SteelProvider().launch('agent-a')).rejects.toThrow('Steel API key must be configured')
  })
})

describe('stop', () => {
  it('releases the session, and stopAll releases every one with one settings read', async () => {
    const provider = new SteelProvider()
    await provider.launch('agent-a', {}, 'agent-a')
    await provider.launch('agent-b', {}, 'agent-b')
    await provider.launch('agent-c', {}, 'agent-c')
    await provider.stop('agent-a')
    expect(steel.releases).toEqual(['session-1'])
    expect(h.stopWatch).toHaveBeenCalledWith('agent-a')
    h.reads = 0
    await provider.stopAll()
    expect(h.reads).toBe(1)
    expect(steel.releases.sort()).toEqual(['session-1', 'session-2', 'session-3'])
    expect(provider.isRunning()).toBe(false)
  })

  it('releases the session a launch under way creates', async () => {
    const provider = new SteelProvider()
    const launch = provider.launch('agent-a', {}, 'agent-a')
    await provider.stop('agent-a')
    await launch
    expect(steel.releases).toEqual(['session-1'])
    expect(provider.isRunning('agent-a')).toBe(false)
  })

  it('is a no-op for an instance with no browser and no profile', async () => {
    await new SteelProvider().stop('agent-x')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops the browser a container kept using across an app restart (live on the profile, unknown here)', async () => {
    await new SteelProvider().launch('agent-a', {}, 'agent-a')
    await new SteelProvider().launch('agent-b', {}, 'agent-b')
    const restarted = new SteelProvider()
    expect(restarted.isRunning('agent-a')).toBe(false)
    await restarted.stop('agent-a')
    expect(steel.releases).toEqual(['session-1'])
    expect(steel.sessions.get('session-2')!.status).toBe('live')
    // Its next browser waits for that save, like any other.
    expect((await restarted.launch('agent-a', {}, 'agent-a')).cdpUrl).toContain('session-3')
  })

  it("releases nothing when the agent's profile has no live session", async () => {
    const provider = new SteelProvider()
    await provider.launch('agent-a', {}, 'agent-a')
    await provider.stop('agent-a')
    await new SteelProvider().stop('agent-a')
    expect(steel.releases).toEqual(['session-1'])
  })
})

describe('helpers', () => {
  it('reads the plan cap from either form of the refusal', () => {
    expect(planTimeoutCapFrom("Requested 'timeout' of 86400000 ms exceeds the maximum of 15 minutes on the launch plan. Set 'timeout' to 900000 or less, or upgrade")).toBe(900_000)
    expect(planTimeoutCapFrom('exceeds the maximum of 1 hour on the scale plan')).toBe(3_600_000)
    expect(planTimeoutCapFrom('something else')).toBeNull()
  })

  it('maps the settings to session options', () => {
    expect(steelSessionOptionsFrom({ app: {} })).toEqual({})
    expect(steelSessionOptionsFrom({ app: { steelProxies: true } })).toEqual({ useProxy: true })
    expect(steelSessionOptionsFrom({ app: { steelProxies: false, steelProxyCountry: 'US', steelSolveCaptcha: true } })).toEqual({ solveCaptcha: true })
    expect(steelSessionOptionsFrom({ app: { steelProxies: true, steelProxyCountry: 'DE', steelProxyCity: 'BERLIN' } }))
      .toEqual({ useProxy: { geolocation: { country: 'DE', city: 'BERLIN' } } })
  })
})
