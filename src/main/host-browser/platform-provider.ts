import fs from 'fs'
import path from 'path'
import { getSettings } from '@shared/lib/config/settings'
import { getDataDir } from '@shared/lib/config/data-dir'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo, BrowserDebugInfo } from './types'

/**
 * Platform-managed Browserbase provider.
 *
 * Logically a separate provider — the user is signed in to the platform and
 * the platform's proxy holds the Browserbase API key + project id. The user
 * does NOT configure any Browserbase credentials themselves; they just need
 * a valid platform session.
 *
 * Wire-protocol notes (intentionally different from `BrowserbaseProvider`):
 *  - Base URL is `${platformProxy}/v1/browserbase/*`, not `api.browserbase.com`.
 *  - Auth header is `Authorization: Bearer <platformToken>`, not `X-BB-API-Key`.
 *  - `projectId` is omitted from request bodies; the proxy injects the real
 *    project id server-side from its env, so clients can't pin a project.
 *  - Context map is persisted to a separate file (`platform-browserbase-contexts.json`)
 *    so it never collides with the BYOK BrowserbaseProvider's map.
 *
 * Note: the Browserbase debug `wsUrl` returned by the proxy still points at
 * `wss://connect.browserbase.com/...`. CDP traffic flows directly to
 * Browserbase, not through the platform proxy — the proxy only mediates the
 * REST control plane (create / inspect / release session, create context).
 */
const CONTEXTS_FILE = 'platform-browserbase-contexts.json'

interface BrowserbaseSession {
  id: string
  connectUrl: string
  status: string
  keepAlive: boolean
}

interface BrowserbaseDebugResponse {
  wsUrl?: string
  pages?: Array<{
    id: string
    url: string
    debuggerUrl?: string
    debuggerFullscreenUrl?: string
  }>
}

export class PlatformBrowserProvider implements HostBrowserProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'

  /** Maps instanceId → Browserbase session ID (proxied through platform) */
  private sessions: Map<string, string> = new Map()

  onExternalClose: ((instanceId: string) => void) | null = null

  detect(): HostBrowserProviderStatus {
    if (!getPlatformAccessToken()) {
      return {
        id: this.id,
        name: this.name,
        available: false,
        reason: 'Sign in to Platform to use this provider',
      }
    }
    return { id: this.id, name: this.name, available: true }
  }

  async launch(instanceId: string, _options?: Record<string, string>, agentId?: string): Promise<BrowserConnectionInfo> {
    const token = getPlatformAccessToken()
    if (!token) {
      throw new Error('Not signed in to Platform — cannot use platform-managed Browserbase')
    }

    // Reuse a still-running session if we have one
    const existingSessionId = this.sessions.get(instanceId)
    if (existingSessionId) {
      try {
        const session = await this.fetchSession(existingSessionId, token)
        if (session.status === 'RUNNING') {
          const debugUrl = await this.getDebugBrowserUrl(existingSessionId, token)
          if (debugUrl) {
            console.log(`[PlatformBrowserProvider] Reusing session ${existingSessionId} for instance ${instanceId}`)
            return { cdpUrl: debugUrl }
          }
        }
      } catch {
        // Session no longer valid — drop and create a fresh one below
      }
      this.sessions.delete(instanceId)
    }

    // Persistent context per agent (cookies / storage carried across sessions)
    const contextKey = agentId || instanceId
    const contextId = await this.getOrCreateContext(contextKey, token)

    const settings = getSettings()
    const browserSettings: Record<string, unknown> = {
      context: { id: contextId, persist: true },
    }

    if (settings.app?.browserbaseAdvancedStealth) {
      browserSettings.advancedStealth = true
      if (settings.app.browserbaseStealthOs) {
        browserSettings.os = settings.app.browserbaseStealthOs
      }
    }

    // No `projectId` here — the platform proxy injects it server-side.
    const sessionPayload: Record<string, unknown> = { keepAlive: true, browserSettings }

    if (settings.app?.browserbaseProxies) {
      const { browserbaseProxyCountry, browserbaseProxyCity, browserbaseProxyState } = settings.app
      if (browserbaseProxyCountry || browserbaseProxyCity || browserbaseProxyState) {
        const geolocation: Record<string, string> = {}
        if (browserbaseProxyCountry) geolocation.country = browserbaseProxyCountry
        if (browserbaseProxyState) geolocation.state = browserbaseProxyState
        if (browserbaseProxyCity) geolocation.city = browserbaseProxyCity
        sessionPayload.proxies = [{ type: 'browserbase', geolocation }]
      } else {
        sessionPayload.proxies = true
      }
    }

    const response = await fetch(`${this.proxyBase()}/sessions`, {
      method: 'POST',
      headers: this.authHeaders(token, true),
      body: JSON.stringify(sessionPayload),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to create platform Browserbase session: ${response.status} ${body}`)
    }

    const session = await response.json() as BrowserbaseSession
    this.sessions.set(instanceId, session.id)
    console.log(`[PlatformBrowserProvider] Created session ${session.id} for instance ${instanceId} (keepAlive: ${session.keepAlive})`)

    const debugUrl = await this.getDebugBrowserUrl(session.id, token)
    if (debugUrl) {
      return { cdpUrl: debugUrl }
    }

    // Fallback to single-use connectUrl if the debug endpoint didn't yield one
    return { cdpUrl: session.connectUrl }
  }

  async getDebugInfo(instanceId: string): Promise<BrowserDebugInfo | null> {
    const sessionId = this.sessions.get(instanceId)
    if (!sessionId) return null

    const token = getPlatformAccessToken()
    if (!token) return null

    const response = await fetch(`${this.proxyBase()}/sessions/${sessionId}/debug`, {
      headers: this.authHeaders(token),
    })

    if (!response.ok) {
      console.error(`[PlatformBrowserProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
      return null
    }

    const debug = await response.json() as BrowserbaseDebugResponse
    if (!debug.pages || debug.pages.length === 0) return null

    // Page-level CDP wsUrls connect directly to Browserbase, not through the proxy.
    const pages = debug.pages.map((page) => ({
      id: page.id,
      url: page.url,
      wsUrl: `wss://connect.browserbase.com/debug/${sessionId}/devtools/page/${page.id}`,
    }))

    return { pages }
  }

  async stop(instanceId: string): Promise<void> {
    const sessionId = this.sessions.get(instanceId)
    if (!sessionId) return

    this.sessions.delete(instanceId)

    const token = getPlatformAccessToken()
    if (!token) return

    try {
      await fetch(`${this.proxyBase()}/sessions/${sessionId}`, {
        method: 'POST',
        headers: this.authHeaders(token, true),
        // No projectId — the proxy injects it server-side.
        body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
      })
      console.log(`[PlatformBrowserProvider] Released session ${sessionId}`)
    } catch (error) {
      console.error(`[PlatformBrowserProvider] Error releasing session ${sessionId}:`, error)
    }
  }

  async stopAll(): Promise<void> {
    const instanceIds = Array.from(this.sessions.keys())
    await Promise.all(instanceIds.map((id) => this.stop(id)))
  }

  isRunning(instanceId?: string): boolean {
    if (instanceId) {
      return this.sessions.has(instanceId)
    }
    return this.sessions.size > 0
  }

  /**
   * Resolve the platform proxy URL for Browserbase routes.
   * Read fresh on every call so users that switch platform endpoints (e.g.
   * staging ↔ production) don't need to restart the app.
   */
  private proxyBase(): string {
    const base = getPlatformProxyBaseUrl()
    if (!base) {
      throw new Error('Platform proxy URL is not configured')
    }
    return `${base}/v1/browserbase`
  }

  private authHeaders(token: string, json = false): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (json) headers['Content-Type'] = 'application/json'
    return headers
  }

  private loadContextMap(): Record<string, string> {
    try {
      const filePath = path.join(getDataDir(), CONTEXTS_FILE)
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private saveContextMap(map: Record<string, string>): void {
    const filePath = path.join(getDataDir(), CONTEXTS_FILE)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2))
  }

  private async getOrCreateContext(contextKey: string, token: string): Promise<string> {
    const map = this.loadContextMap()
    if (map[contextKey]) {
      return map[contextKey]
    }

    const response = await fetch(`${this.proxyBase()}/contexts`, {
      method: 'POST',
      headers: this.authHeaders(token, true),
      // No projectId in body — proxy fills it.
      body: JSON.stringify({}),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to create platform Browserbase context: ${response.status} ${body}`)
    }

    const context = await response.json() as { id: string }
    map[contextKey] = context.id
    this.saveContextMap(map)
    console.log(`[PlatformBrowserProvider] Created context ${context.id} for ${contextKey}`)
    return context.id
  }

  private async getDebugBrowserUrl(sessionId: string, token: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.proxyBase()}/sessions/${sessionId}/debug`, {
        headers: this.authHeaders(token),
      })

      if (!response.ok) {
        console.error(`[PlatformBrowserProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
        return null
      }

      const debug = await response.json() as BrowserbaseDebugResponse
      return debug.wsUrl || null
    } catch (err) {
      console.error('[PlatformBrowserProvider] Failed to get debug URL:', err)
      return null
    }
  }

  private async fetchSession(sessionId: string, token: string): Promise<BrowserbaseSession> {
    const response = await fetch(`${this.proxyBase()}/sessions/${sessionId}`, {
      headers: this.authHeaders(token),
    })

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.status}`)
    }

    return response.json() as Promise<BrowserbaseSession>
  }
}
