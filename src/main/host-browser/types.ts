export type HostBrowserProviderId = 'chrome' | 'browserbase'

export interface BrowserConnectionInfo {
  /** Full CDP WebSocket URL (for remote providers like Browserbase) */
  cdpUrl?: string
  /** Local CDP port (for local providers like Chrome — container resolves to CDP URL) */
  port?: number
  /** Host-filesystem path for downloads (local providers only) */
  downloadDir?: string
}

/** Debug info for screencast — page-level CDP URLs for direct connection */
export interface BrowserDebugInfo {
  /** Page-level WebSocket URLs keyed by page ID */
  pages: Array<{ id: string; url: string; wsUrl: string }>
}

export interface HostBrowserProviderStatus {
  id: HostBrowserProviderId
  name: string
  available: boolean
  reason?: string
  /** Chrome-specific: detected browser profiles */
  profiles?: Array<{ id: string; name: string; avatarUrl?: string }>
}

export interface HostBrowserProvider {
  readonly id: HostBrowserProviderId
  readonly name: string

  /** Check if this provider is available (Chrome installed? API key configured?) */
  detect(): HostBrowserProviderStatus

  /** Launch/connect a browser instance. Returns CDP connection info. */
  launch(instanceId: string, options?: Record<string, string>): Promise<BrowserConnectionInfo>

  /** Get debug/screencast connection info for an active instance (optional — for remote providers) */
  getDebugInfo?(instanceId: string): Promise<BrowserDebugInfo | null>

  /** Stop a browser instance */
  stop(instanceId: string): Promise<void>

  /** Stop all instances */
  stopAll(): Promise<void>

  /** Check if a browser instance is running */
  isRunning(instanceId?: string): boolean

  /** Callback when a browser instance closes externally (e.g. user closed Chrome) */
  onExternalClose: ((instanceId: string) => void) | null
}
