import { createHash } from 'crypto'
import {
  getSettings,
  effectiveTabtenderApiKeyFrom,
  effectiveTabtenderUrlFrom,
  type AppSettings,
} from '@shared/lib/config/settings'
import { GooglePasskeyRecovery } from './google-passkey-recovery'
import { TabtenderApi, TabtenderApiError } from './tabtender-api'
import type { TabtenderSession } from './tabtender-schemas'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo } from './types'

/**
 * How long a session may run. Tab Tender ends a session at its TTL and caps
 * it at the server's `sessions.maxTTL` (4 hours by default): a request over
 * the cap is refused with the cap in the message, and the session is created
 * again at the cap.
 */
export const TABTENDER_SESSION_TTL_SECONDS = 6 * 60 * 60

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * The agent's named Tab Tender profile: `superagent-<agent id>`, or a digest
 * of the id when that is not a valid profile name (1–64 letters, digits, `-`
 * and `_`).
 */
export function tabtenderProfileName(agentId: string): string {
  const name = `superagent-${agentId}`
  if (PROFILE_NAME_RE.test(name)) return name
  return `superagent-${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`
}

/** The server's cap in a refused TTL ("… exceeds the maximum session TTL of 14400 seconds"), or null. */
export function maxTtlFrom(message: string): number | null {
  const match = message.match(/maximum session TTL of (\d+) seconds/)
  return match ? Number(match[1]) : null
}

function apiFrom(settings: Pick<AppSettings, 'apiKeys'>): TabtenderApi | null {
  const baseUrl = effectiveTabtenderUrlFrom(settings)
  const apiKey = effectiveTabtenderApiKeyFrom(settings)
  return baseUrl && apiKey ? new TabtenderApi(baseUrl, apiKey) : null
}

/**
 * Tab Tender (https://github.com/SkillfulAgents/tabtender): a self-hosted
 * browser session server, one native Chrome per session, reached by URL with
 * an API key. Each agent's browser is one Tab Tender session on the agent's
 * named profile, which persists on the server, so the agent stays signed in
 * from one browser to the next. A named profile is locked while a session
 * holds it (`profile_in_use`): that session is the agent's browser from before
 * the app restarted, and is used again.
 *
 * The container is handed the session's `cdpUrl`: its CDP endpoint with a
 * token for that one session in the query, so the API key never reaches it.
 * The token stays the same for the session's life (any read of the session
 * returns the same URL), and stops working when the session ends. Tab Tender
 * builds the URL for the address it was reached at, so the server URL must be
 * one the container can reach too (a tunnel or LAN address, not loopback).
 *
 * Tab Tender serves no page-level endpoints, so there is no `getDebugInfo`:
 * the container finds pages over the browser-level endpoint.
 *
 * An instance's profile key is its agent's id: the routes pass the agent's id
 * as the instance id too.
 */
export class TabtenderProvider implements HostBrowserProvider {
  readonly id = 'tabtender' as const
  readonly name = 'Tab Tender'

  /** Maps instanceId → its Tab Tender session and the CDP URL the container was given. */
  private sessions: Map<string, { id: string; cdpUrl: string }> = new Map()
  /** Launches under way, so a second open for the instance joins the first instead of creating another session. */
  private launches: Map<string, Promise<BrowserConnectionInfo>> = new Map()
  private passkeyRecovery = new GooglePasskeyRecovery()

  onExternalClose: ((instanceId: string) => void) | null = null

  async detect(): Promise<HostBrowserProviderStatus> {
    const settings = await getSettings()
    if (!effectiveTabtenderUrlFrom(settings)) {
      return { id: this.id, name: this.name, available: false, reason: 'Server URL not configured' }
    }
    if (!effectiveTabtenderApiKeyFrom(settings)) {
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
    const api = apiFrom(await getSettings())
    if (!api) throw new Error('Tab Tender server URL and API key must be configured')

    // The container asks again on every open: a session still running is the same browser.
    const existing = this.sessions.get(instanceId)
    if (existing) {
      const status = await this.statusOf(api, existing.id)
      if (status === 'live' || status === 'unknown') {
        // Unknown: the server did not answer. The browser the container has is the best guess.
        this.passkeyRecovery.watch(instanceId, existing.cdpUrl)
        return { cdpUrl: existing.cdpUrl }
      }
      // It reached its TTL, crashed, or the server restarted.
      this.forget(instanceId)
    }

    const profile = tabtenderProfileName(profileKey)
    let session: TabtenderSession
    try {
      session = await this.createSession(api, profile)
    } catch (error) {
      if (!(error instanceof TabtenderApiError) || error.code !== 'profile_in_use') throw error
      // A session holds the agent's profile: its browser from before the app restarted.
      const holder = await this.liveSessionOn(api, profile)
      if (!holder) throw error
      console.log(`[TabtenderProvider] Using live session ${holder.id} on profile ${profile}`)
      session = holder
    }
    return this.connected(instanceId, session)
  }

  /** Create a session for the TTL asked for, or at the server's cap when it names one below it. */
  private async createSession(api: TabtenderApi, profile: string): Promise<TabtenderSession> {
    try {
      return await api.createSession({ profile, ttlSeconds: TABTENDER_SESSION_TTL_SECONDS })
    } catch (error) {
      if (!(error instanceof TabtenderApiError) || error.code !== 'validation_error') throw error
      const cap = maxTtlFrom(error.message)
      if (!cap || cap >= TABTENDER_SESSION_TTL_SECONDS) throw error
      return api.createSession({ profile, ttlSeconds: cap })
    }
  }

  /** Whether a session is live, has ended, or the server could not say (a network error, a 5xx). */
  private async statusOf(api: TabtenderApi, sessionId: string): Promise<'live' | 'ended' | 'unknown'> {
    try {
      const { status } = await api.getSession(sessionId)
      return status === 'running' || status === 'starting' ? 'live' : 'ended'
    } catch (error) {
      // Gone: ended over ten minutes ago, or the server restarted (sessions do not survive it).
      return error instanceof TabtenderApiError && error.status === 404 ? 'ended' : 'unknown'
    }
  }

  private async liveSessionOn(api: TabtenderApi, profile: string): Promise<TabtenderSession | null> {
    const sessions = await api.listSessions()
    return sessions.find((s) => s.profile === profile && (s.status === 'running' || s.status === 'starting')) ?? null
  }

  private connected(instanceId: string, session: TabtenderSession): BrowserConnectionInfo {
    if (!session.cdpUrl) throw new Error(`Tab Tender session ${session.id} has no CDP URL (status ${session.status})`)
    console.log(`[TabtenderProvider] Session ${session.id} on profile ${session.profile} for instance ${instanceId}`)
    this.sessions.set(instanceId, { id: session.id, cdpUrl: session.cdpUrl })
    this.passkeyRecovery.watch(instanceId, session.cdpUrl)
    return { cdpUrl: session.cdpUrl }
  }

  /** Drop what this process keeps about the instance's session. */
  private forget(instanceId: string): void {
    this.sessions.delete(instanceId)
    this.passkeyRecovery.stop(instanceId)
  }

  /**
   * Stop the instance's browser. One this process does not know is the live
   * session on the agent's profile: a browser opened before the app restarted,
   * which the container kept using and now asks to stop.
   */
  async stop(instanceId: string): Promise<void> {
    // A launch under way would create a session after this stop: wait for it, and end that.
    await this.launches.get(instanceId)?.catch(() => {})
    const api = apiFrom(await getSettings())
    if (this.sessions.has(instanceId)) return this.stopWith(instanceId, api)
    if (!api) return
    try {
      const holder = await this.liveSessionOn(api, tabtenderProfileName(instanceId))
      if (holder) await this.end(api, holder.id)
    } catch (error) {
      console.error(`[TabtenderProvider] Error stopping the browser of ${instanceId}:`, error)
    }
  }

  private async stopWith(instanceId: string, api: TabtenderApi | null): Promise<void> {
    await this.launches.get(instanceId)?.catch(() => {})
    const session = this.sessions.get(instanceId)
    if (!session) return
    this.forget(instanceId)
    if (api) await this.end(api, session.id)
  }

  /** End a session: Tab Tender shuts the browser down cleanly, and its profile stays for the next one. */
  private async end(api: TabtenderApi, sessionId: string): Promise<void> {
    try {
      await api.deleteSession(sessionId)
      console.log(`[TabtenderProvider] Ended session ${sessionId}`)
    } catch (error) {
      console.error(`[TabtenderProvider] Error ending session ${sessionId}:`, error)
    }
  }

  async stopAll(): Promise<void> {
    const instanceIds = Array.from(this.sessions.keys())
    if (instanceIds.length === 0) return
    // One read for the whole batch.
    const api = apiFrom(await getSettings())
    await Promise.all(instanceIds.map((id) => this.stopWith(id, api)))
  }

  isRunning(instanceId?: string): boolean {
    if (instanceId) {
      return this.sessions.has(instanceId)
    }
    return this.sessions.size > 0
  }
}
