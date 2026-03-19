import fs from 'fs'
import path from 'path'
import { getSettings, getEffectiveBrowserbaseApiKey, getEffectiveBrowserbaseProjectId } from '@shared/lib/config/settings'
import { getDataDir } from '@shared/lib/config/data-dir'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo, BrowserDebugInfo } from './types'

const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1'
const CONTEXTS_FILE = 'browserbase-contexts.json'

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

export class BrowserbaseProvider implements HostBrowserProvider {
  readonly id = 'browserbase' as const
  readonly name = 'Browserbase'

  /** Maps instanceId → Browserbase session ID */
  private sessions: Map<string, string> = new Map()

  onExternalClose: ((instanceId: string) => void) | null = null

  detect(): HostBrowserProviderStatus {
    const apiKey = getEffectiveBrowserbaseApiKey()
    const projectId = getEffectiveBrowserbaseProjectId()

    if (!apiKey || !projectId) {
      return {
        id: this.id,
        name: this.name,
        available: false,
        reason: !apiKey ? 'API key not configured' : 'Project ID not configured',
      }
    }

    return { id: this.id, name: this.name, available: true }
  }

  async launch(instanceId: string, _options?: Record<string, string>, agentId?: string): Promise<BrowserConnectionInfo> {
    const apiKey = getEffectiveBrowserbaseApiKey()
    const projectId = getEffectiveBrowserbaseProjectId()

    if (!apiKey || !projectId) {
      throw new Error('Browserbase API key and project ID must be configured')
    }

    // If we already have a session for this instance, check if it's still running
    const existingSessionId = this.sessions.get(instanceId)
    if (existingSessionId) {
      try {
        const session = await this.fetchSession(existingSessionId, apiKey)
        if (session.status === 'RUNNING') {
          // Session alive — get a fresh debug browser URL for the CDP connection
          const debugUrl = await this.getDebugBrowserUrl(existingSessionId, apiKey)
          if (debugUrl) {
            console.log(`[BrowserbaseProvider] Reusing session ${existingSessionId} for instance ${instanceId}`)
            return { cdpUrl: debugUrl }
          }
        }
      } catch {
        // Session no longer valid
      }
      this.sessions.delete(instanceId)
    }

    // Get or create a persistent context for this agent (preserves cookies/storage across sessions)
    const contextKey = agentId || instanceId
    const contextId = await this.getOrCreateContext(contextKey, projectId, apiKey)

    // Build session creation payload with optional stealth & proxy settings
    const settings = getSettings()
    const browserSettings: Record<string, unknown> = {
      context: { id: contextId, persist: true },
    }

    // Advanced Stealth Mode
    if (settings.app?.browserbaseAdvancedStealth) {
      browserSettings.advancedStealth = true
      if (settings.app.browserbaseStealthOs) {
        browserSettings.os = settings.app.browserbaseStealthOs
      }
    }

    const sessionPayload: Record<string, unknown> = { projectId, keepAlive: true, browserSettings }

    // Proxy configuration
    if (settings.app?.browserbaseProxies) {
      const { browserbaseProxyCountry, browserbaseProxyCity, browserbaseProxyState } = settings.app
      if (browserbaseProxyCountry || browserbaseProxyCity || browserbaseProxyState) {
        // Geolocation proxy
        const geolocation: Record<string, string> = {}
        if (browserbaseProxyCountry) geolocation.country = browserbaseProxyCountry
        if (browserbaseProxyState) geolocation.state = browserbaseProxyState
        if (browserbaseProxyCity) geolocation.city = browserbaseProxyCity
        sessionPayload.proxies = [{ type: 'browserbase', geolocation }]
      } else {
        // Simple built-in proxy (best-effort US)
        sessionPayload.proxies = true
      }
    }

    // Create a new session with keepAlive so it survives agent-browser disconnecting
    const response = await fetch(`${BROWSERBASE_API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': apiKey,
      },
      body: JSON.stringify(sessionPayload),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to create Browserbase session: ${response.status} ${body}`)
    }

    const session = await response.json() as BrowserbaseSession
    this.sessions.set(instanceId, session.id)
    console.log(`[BrowserbaseProvider] Created session ${session.id} for instance ${instanceId} (keepAlive: ${session.keepAlive})`)

    // Use the debug browser URL as the CDP endpoint (supports multiple connections,
    // unlike the connectUrl which is single-use)
    const debugUrl = await this.getDebugBrowserUrl(session.id, apiKey)
    if (debugUrl) {
      return { cdpUrl: debugUrl }
    }

    // Fallback to connectUrl (single-use, but better than nothing)
    return { cdpUrl: session.connectUrl }
  }

  async getDebugInfo(instanceId: string): Promise<BrowserDebugInfo | null> {
    const sessionId = this.sessions.get(instanceId)
    if (!sessionId) return null

    const apiKey = getEffectiveBrowserbaseApiKey()
    if (!apiKey) return null

    const response = await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}/debug`, {
      headers: { 'X-BB-API-Key': apiKey },
    })

    if (!response.ok) {
      console.error(`[BrowserbaseProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
      return null
    }

    const debug = await response.json() as BrowserbaseDebugResponse
    if (!debug.pages || debug.pages.length === 0) return null

    // Build page-level debug WebSocket URLs
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

    const apiKey = getEffectiveBrowserbaseApiKey()
    const projectId = getEffectiveBrowserbaseProjectId()
    if (!apiKey || !projectId) return

    try {
      await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BB-API-Key': apiKey,
        },
        body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
      })
      console.log(`[BrowserbaseProvider] Released session ${sessionId}`)
    } catch (error) {
      console.error(`[BrowserbaseProvider] Error releasing session ${sessionId}:`, error)
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

  /** Load the persistent instanceId → contextId map from disk */
  private loadContextMap(): Record<string, string> {
    try {
      const filePath = path.join(getDataDir(), CONTEXTS_FILE)
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  /** Save the persistent instanceId → contextId map to disk */
  private saveContextMap(map: Record<string, string>): void {
    const filePath = path.join(getDataDir(), CONTEXTS_FILE)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2))
  }

  /** Get or create a Browserbase context for the given instance */
  private async getOrCreateContext(instanceId: string, projectId: string, apiKey: string): Promise<string> {
    const map = this.loadContextMap()
    if (map[instanceId]) {
      return map[instanceId]
    }

    const response = await fetch(`${BROWSERBASE_API_BASE}/contexts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': apiKey,
      },
      body: JSON.stringify({ projectId }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to create Browserbase context: ${response.status} ${body}`)
    }

    const context = await response.json() as { id: string }
    map[instanceId] = context.id
    this.saveContextMap(map)
    console.log(`[BrowserbaseProvider] Created context ${context.id} for instance ${instanceId}`)
    return context.id
  }

  /** Get the debug browser-level WebSocket URL for a session */
  private async getDebugBrowserUrl(sessionId: string, apiKey: string): Promise<string | null> {
    try {
      const response = await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}/debug`, {
        headers: { 'X-BB-API-Key': apiKey },
      })

      if (!response.ok) {
        console.error(`[BrowserbaseProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
        return null
      }

      const debug = await response.json() as BrowserbaseDebugResponse
      return debug.wsUrl || null
    } catch (err) {
      console.error('[BrowserbaseProvider] Failed to get debug URL:', err)
      return null
    }
  }

  private async fetchSession(sessionId: string, apiKey: string): Promise<BrowserbaseSession> {
    const response = await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}`, {
      headers: { 'X-BB-API-Key': apiKey },
    })

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.status}`)
    }

    return response.json() as Promise<BrowserbaseSession>
  }
}
