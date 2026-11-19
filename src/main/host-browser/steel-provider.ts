import { appState, defineNamespace, type Revision } from '@shared/lib/app-state'
import { getSettings, effectiveSteelApiKeyFrom, type AppSettings } from '@shared/lib/config/settings'
import { getOrCreateMapping, readContextMapping, replaceContextMapping } from './context-map-store'
import { GooglePasskeyRecovery } from './google-passkey-recovery'
import { SteelApi, SteelApiError } from './steel-api'
import { steelPendingSaveSchema, type SteelSession } from './steel-schemas'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo } from './types'

/**
 * How long a session may run. Steel releases a session at its timeout (5
 * minutes when none is given), and each plan caps it (Launch 15 minutes,
 * Scale 1 hour, Enterprise 24 hours): a request over the cap is refused with
 * the cap in the message, and the session is created again at the cap.
 */
export const STEEL_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000

/** How long a launch waits for the agent's profile while its first session holds it (`profile_not_ready`). */
export const STEEL_PROFILE_WAIT_MS = 60_000
const PROFILE_RETRY_MIN_MS = 500
const PROFILE_RETRY_MAX_MS = 2_000
/**
 * How long a launch waits for Steel to save the profile from the agent's last
 * session (measured: 0.2–2.5 s after the release).
 */
export const STEEL_PROFILE_SAVE_WAIT_MS = 30_000
const SAVE_POLL_MS = 500

/**
 * Profile id → the session Steel is saving it from, recorded when a session is
 * seen ending and consumed once the save is seen. Kept past the save wait so a
 * launch in any process waits for it; gone once no launch would.
 */
const pendingSaves = defineNamespace({
  name: 'browser:steel:pending-save',
  consistency: 'strong',
  schema: steelPendingSaveSchema,
  expiry: { ttlMs: 5 * 60_000, onUpdate: 'reset' },
})

function steelApiFrom(settings: Pick<AppSettings, 'apiKeys'>): SteelApi | null {
  const apiKey = effectiveSteelApiKeyFrom(settings)
  return apiKey ? new SteelApi(apiKey) : null
}

/** Session options from the Steel settings (CAPTCHA solving, Steel proxies). */
export function steelSessionOptionsFrom(settings: Pick<AppSettings, 'app'>): Record<string, unknown> {
  const app = settings.app ?? {}
  const options: Record<string, unknown> = {}
  if (app.steelSolveCaptcha) options.solveCaptcha = true
  if (app.steelProxies) {
    const geolocation: Record<string, string> = {}
    if (app.steelProxyCountry) geolocation.country = app.steelProxyCountry
    if (app.steelProxyState) geolocation.state = app.steelProxyState
    if (app.steelProxyCity) geolocation.city = app.steelProxyCity
    options.useProxy = Object.keys(geolocation).length > 0 ? { geolocation } : true
  }
  return options
}

/** The plan's cap in a refused timeout ("Set 'timeout' to 900000 or less"), or null. */
export function planTimeoutCapFrom(message: string): number | null {
  const ms = message.match(/'timeout' to (\d+) or less/)
  if (ms) return Number(ms[1])
  const span = message.match(/maximum of (\d+) (minute|hour)s?/)
  if (span) return Number(span[1]) * (span[2] === 'hour' ? 3_600_000 : 60_000)
  return null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The timeout one launch asks for: lowered to the plan's cap once Steel names it. */
interface SessionTimeout { ms: number }

/**
 * Steel cloud browsers (https://steel.dev), one Steel session per agent's
 * browser. Each agent keeps a Steel profile (cookies, storage, the user data
 * directory) that a session loads and saves again when it ends, so the agent
 * stays signed in from one browser to the next.
 *
 * Steel saves a profile a second or two after the session ends (released,
 * timed out, or its browser closed), and lets a session load the profile in
 * the meantime: that session starts from the state before, and saves it back
 * over the newer one when it ends. So a session seen ending is recorded
 * (before its release is sent), and the agent's next launch waits until the
 * profile names it as its source. Only the session that created a profile
 * holds it (`profile_not_ready`) until saved; any number of sessions can load
 * it once it is.
 *
 * The container is handed the session's `websocketUrl`: a CDP endpoint signed
 * with a token for that one session, so the account's API key never reaches
 * it. The endpoint takes any number of connections (agent-browser, the
 * screencast, a download) and the session outlives them; it ends when it is
 * released, at its timeout, or when a client closes the browser.
 *
 * Steel serves no page-level CDP endpoints, so there is no `getDebugInfo`: the
 * container finds pages over the browser-level endpoint.
 *
 * An instance's profile key is its agent's id: the routes pass the agent's id
 * as the instance id too.
 */
export class SteelProvider implements HostBrowserProvider {
  readonly id = 'steel' as const
  readonly name = 'Steel'

  /**
   * Maps instanceId → its Steel session and the CDP URL the container was
   * given. The URL's token lasts as long as the session, and every read of a
   * session signs a new one: handing the same URL back keeps agent-browser on
   * the connection it has.
   */
  private sessions: Map<string, { id: string; cdpUrl: string; profileId: string | null }> = new Map()
  /** Launches under way, so a second open for the instance joins the first instead of creating another session. */
  private launches: Map<string, Promise<BrowserConnectionInfo>> = new Map()
  private passkeyRecovery = new GooglePasskeyRecovery()

  onExternalClose: ((instanceId: string) => void) | null = null

  async detect(): Promise<HostBrowserProviderStatus> {
    if (!effectiveSteelApiKeyFrom(await getSettings())) {
      return { id: this.id, name: this.name, available: false, reason: 'API key not configured' }
    }
    return { id: this.id, name: this.name, available: true }
  }

  launch(instanceId: string, _options?: Record<string, string>, agentId?: string): Promise<BrowserConnectionInfo> {
    const pending = this.launches.get(instanceId)
    if (pending) return pending
    const launch = this.launchOnce(instanceId, agentId || instanceId).finally(() => {
      this.launches.delete(instanceId)
    })
    this.launches.set(instanceId, launch)
    return launch
  }

  private async launchOnce(instanceId: string, profileKey: string): Promise<BrowserConnectionInfo> {
    // One read for the account and the session options below.
    const settings = await getSettings()
    const steel = steelApiFrom(settings)
    if (!steel) throw new Error('Steel API key must be configured')

    // The container asks again on every open: a session still live is the same browser.
    const existing = this.sessions.get(instanceId)
    if (existing) {
      const status = await this.statusOf(steel, existing.id)
      if (status === 'live' || status === 'unknown') {
        // Unknown: Steel did not answer. The browser the container has is the best guess.
        this.passkeyRecovery.watch(instanceId, existing.cdpUrl)
        return { cdpUrl: existing.cdpUrl }
      }
      // It timed out or its browser was closed: Steel is saving the profile from it.
      if (existing.profileId && status === 'ended') await this.recordPendingSave(existing.profileId, existing.id)
      this.passkeyRecovery.stop(instanceId)
      this.sessions.delete(instanceId)
    }

    const options = steelSessionOptionsFrom(settings)
    const timeout: SessionTimeout = { ms: STEEL_SESSION_TIMEOUT_MS }

    const mapped = await readContextMapping('steel', profileKey)
    if (mapped) {
      await this.profileSaved(steel, mapped)
      // Steel lets any number of sessions load a profile. A live one this
      // process does not know is the agent's own browser from before the app
      // restarted (or a release that failed): it is used again, rather than a
      // second browser opened beside it.
      const holder = await this.liveSessionOn(steel, mapped)
      if (holder) return this.connected(instanceId, holder)
      return this.connected(instanceId, await this.sessionOnProfile(steel, profileKey, mapped, options, timeout))
    }

    // An agent's first session creates its profile, and the mapping is committed
    // from it; getOrCreateMapping runs `create` at most once per key at a time.
    const first: { session?: SteelSession } = {}
    let profileId: string
    try {
      profileId = await getOrCreateMapping('steel', profileKey, async () => {
        const session = await this.createSession(steel, { ...options, persistProfile: true }, timeout)
        first.session = session
        if (!session.profileId) throw new Error(`Steel created session ${session.id} without a profile`)
        console.log(`[SteelProvider] Created profile ${session.profileId} for ${profileKey}`)
        return session.profileId
      })
    } catch (error) {
      // The session was created (and is billed) but is no one's browser.
      if (first.session) await steel.releaseSession(first.session.id).catch(() => {})
      throw error
    }

    let session = first.session
    if (session && session.profileId !== profileId) {
      // Another process mapped this agent first: its profile is the agent's.
      await steel.releaseSession(session.id).catch(() => {})
      session = undefined
    }
    session ??= await this.sessionOnProfile(steel, profileKey, profileId, options, timeout)
    return this.connected(instanceId, session)
  }

  /**
   * A session on the agent's profile. While the profile's first session holds
   * it (`profile_not_ready`), that session, live and unknown to this process,
   * is the agent's browser from before the app restarted: it is used again;
   * once released, the launch waits for the save. A profile Steel no longer
   * has is replaced.
   */
  private async sessionOnProfile(
    steel: SteelApi,
    profileKey: string,
    initialProfileId: string,
    options: Record<string, unknown>,
    timeout: SessionTimeout,
  ): Promise<SteelSession> {
    let profileId = initialProfileId
    const deadline = Date.now() + STEEL_PROFILE_WAIT_MS
    for (;;) {
      try {
        return await this.createSession(steel, { ...options, profileId, persistProfile: true }, timeout)
      } catch (error) {
        if (!(error instanceof SteelApiError)) throw error
        if (error.code === 'profile_not_found') {
          const fresh = await this.createSession(steel, { ...options, persistProfile: true }, timeout)
          let committed: string
          try {
            if (!fresh.profileId) throw new Error(`Steel created session ${fresh.id} without a profile`)
            committed = await replaceContextMapping('steel', profileKey, profileId, fresh.profileId)
          } catch (replaceError) {
            await steel.releaseSession(fresh.id).catch(() => {})
            throw replaceError
          }
          console.log(`[SteelProvider] Profile ${profileId} of ${profileKey} is gone; now ${committed}`)
          if (committed === fresh.profileId) return fresh
          await steel.releaseSession(fresh.id).catch(() => {})
          profileId = committed
          continue
        }
        if (error.code !== 'profile_not_ready') throw error
        // The profile's first session holds it until it is saved.
        const holder = await this.liveSessionOn(steel, profileId)
        if (holder) return holder
        if (Date.now() >= deadline) throw error
        const retryAfterMs = (error.retryAfterSeconds ?? 2) * 1000
        await sleep(Math.min(Math.max(retryAfterMs, PROFILE_RETRY_MIN_MS), PROFILE_RETRY_MAX_MS))
      }
    }
  }

  /** Whether a session is live, has ended, or Steel could not say (a network error, a 5xx). */
  private async statusOf(steel: SteelApi, sessionId: string): Promise<'live' | 'ended' | 'gone' | 'unknown'> {
    try {
      return (await steel.getSession(sessionId)).status === 'live' ? 'live' : 'ended'
    } catch (error) {
      return error instanceof SteelApiError && error.status === 404 ? 'gone' : 'unknown'
    }
  }

  /** Record that Steel is saving `profileId` from `sessionId`; the revision withdraws it if the release fails. */
  private async recordPendingSave(profileId: string, sessionId: string): Promise<Revision> {
    return (await appState().set(pendingSaves.key(profileId), { sessionId })).revision
  }

  /**
   * Wait until the profile is saved from the session last seen ending on it,
   * if any. Past the wait the launch goes on, and says so: the browser may
   * then open without what that last session changed.
   */
  private async profileSaved(steel: SteelApi, profileId: string): Promise<void> {
    const key = pendingSaves.key(profileId)
    const pending = await appState().get(key)
    if (!pending) return
    const { sessionId } = pending.value
    const deadline = Date.now() + STEEL_PROFILE_SAVE_WAIT_MS
    for (;;) {
      try {
        const profile = await steel.getProfile(profileId)
        if (profile.sourceSessionId === sessionId && profile.status === 'READY') break
      } catch (error) {
        // Gone: the create that follows replaces it.
        if (error instanceof SteelApiError && error.status === 404) break
      }
      if (Date.now() >= deadline) {
        console.error(`[SteelProvider] Profile ${profileId} not saved from session ${sessionId} after ${STEEL_PROFILE_SAVE_WAIT_MS} ms; opening it anyway`)
        break
      }
      await sleep(SAVE_POLL_MS)
    }
    // Only this record: a save recorded since stays for the launch after.
    await appState().consume(key, { revision: pending.revision })
  }

  /** A live session on the profile, read afresh (its own URL, signed now). */
  private async liveSessionOn(steel: SteelApi, profileId: string): Promise<SteelSession | null> {
    const listed = await steel.findLiveSessionOnProfile(profileId)
    if (!listed) return null
    const session = await steel.getSession(listed.id)
    if (session.status !== 'live') return null
    console.log(`[SteelProvider] Using live session ${session.id} on profile ${profileId}`)
    return session
  }

  /**
   * Create a session for `timeout.ms`. Refused as over the plan's cap, it is
   * created at the cap, and the cap stands for the rest of the launch.
   */
  private async createSession(steel: SteelApi, body: Record<string, unknown>, timeout: SessionTimeout): Promise<SteelSession> {
    try {
      return await steel.createSession({ ...body, timeout: timeout.ms })
    } catch (error) {
      if (!(error instanceof SteelApiError) || error.code !== 'session_timeout_exceeded') throw error
      const cap = planTimeoutCapFrom(error.message)
      if (!cap || cap >= timeout.ms) throw error
      timeout.ms = cap
      return steel.createSession({ ...body, timeout: cap })
    }
  }

  private connected(instanceId: string, session: SteelSession): BrowserConnectionInfo {
    console.log(`[SteelProvider] Session ${session.id} on profile ${session.profileId} for instance ${instanceId}`)
    this.sessions.set(instanceId, { id: session.id, cdpUrl: session.websocketUrl, profileId: session.profileId ?? null })
    this.passkeyRecovery.watch(instanceId, session.websocketUrl)
    return { cdpUrl: session.websocketUrl }
  }

  /**
   * Stop the instance's browser. One this process does not know is the live
   * session on the agent's profile: a browser opened before the app restarted,
   * which the container kept using and now asks to stop.
   */
  async stop(instanceId: string): Promise<void> {
    // A launch under way would create a session after this stop: wait for it, and release that.
    await this.launches.get(instanceId)?.catch(() => {})
    if (this.sessions.has(instanceId)) return this.stopWith(instanceId)
    const steel = steelApiFrom(await getSettings())
    if (!steel) return
    try {
      const profileId = await readContextMapping('steel', instanceId)
      const holder = profileId ? await steel.findLiveSessionOnProfile(profileId) : null
      if (holder) await this.release(steel, holder.id, profileId)
    } catch (error) {
      console.error(`[SteelProvider] Error stopping the browser of ${instanceId}:`, error)
    }
  }

  /** Stop one session, with the account `stopAll` read for every session, else one read now. */
  private async stopWith(instanceId: string, steel?: SteelApi | null): Promise<void> {
    await this.launches.get(instanceId)?.catch(() => {})
    const session = this.sessions.get(instanceId)
    if (!session) return
    const api = steel === undefined ? steelApiFrom(await getSettings()) : steel
    this.passkeyRecovery.stop(instanceId)
    if (!api) {
      this.sessions.delete(instanceId)
      return
    }
    await this.release(api, session.id, session.profileId, () => this.sessions.delete(instanceId))
  }

  /**
   * Release a session: Steel then saves its profile for the agent's next
   * browser. The save is recorded first, so a launch from here on waits for
   * it instead of loading the profile, or taking this session, mid-release;
   * `forget` runs once it is. A release that fails withdraws the record: the
   * session is still live, and the next launch uses it again.
   */
  private async release(steel: SteelApi, sessionId: string, profileId: string | null, forget?: () => void): Promise<void> {
    const revision = profileId ? await this.recordPendingSave(profileId, sessionId) : null
    forget?.()
    try {
      await steel.releaseSession(sessionId)
      console.log(`[SteelProvider] Released session ${sessionId}`)
    } catch (error) {
      console.error(`[SteelProvider] Error releasing session ${sessionId}:`, error)
      if (profileId && revision) await appState().consume(pendingSaves.key(profileId), { revision }).catch(() => {})
    }
  }

  async stopAll(): Promise<void> {
    const instanceIds = Array.from(this.sessions.keys())
    if (instanceIds.length === 0) return
    // One read for the whole batch.
    const steel = steelApiFrom(await getSettings())
    await Promise.all(instanceIds.map((id) => this.stopWith(id, steel)))
  }

  isRunning(instanceId?: string): boolean {
    if (instanceId) {
      return this.sessions.has(instanceId)
    }
    return this.sessions.size > 0
  }
}
