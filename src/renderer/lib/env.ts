import { buildDashboardViewPath } from '@shared/lib/dashboard-url'
import { readPreferredTarget, resolveApiTarget, setActiveTarget } from './api-target'

// Cache for the API base URL (fetched once from Electron main process)
let cachedApiBaseUrl: string | null = null

/**
 * Initialize the API base URL (call this at app startup in Electron).
 *
 * Also settles which Superagent this renderer is driving — see `api-target.ts`.
 * In cloud mode the base URL is the local server's keyed proxy prefix, so every
 * call site keeps targeting loopback and simply arrives at the deployment.
 * Nothing may read the target before this resolves.
 */
export async function initApiBaseUrl(): Promise<void> {
  try {
    if (!isElectron() || !window.electronAPI?.getApiUrl) {
      // Web: same-origin, and no cloud target to choose.
      setActiveTarget('local', null)
      return
    }

    const localBaseUrl = await window.electronAPI.getApiUrl()
    // A missing handler is an older main process, not a failure — treat it as
    // "no cloud workspace" and carry on locally.
    const cloudBaseUrl = (await window.electronAPI.getCloudApiUrl?.().catch(() => null)) ?? null

    const { target, fallback } = resolveApiTarget(readPreferredTarget(), cloudBaseUrl)
    cachedApiBaseUrl = target === 'cloud' && cloudBaseUrl ? cloudBaseUrl : localBaseUrl
    setActiveTarget(target, fallback)
  } catch (error) {
    // The target must end up settled whatever happens. The getters throw rather
    // than guess, so leaving it unset would turn one failed IPC call into a
    // renderer that cannot answer "which Superagent am I?" at all.
    setActiveTarget('local', null)
    throw error
  }
}

/** Test seam: forgets the resolved base URL so a fresh boot can be simulated. */
export function _resetApiBaseUrlForTest(): void {
  cachedApiBaseUrl = null
}

/**
 * Get the base URL for API calls.
 * In Electron, the API runs on a dynamically assigned port.
 * In web browser, the API is served from the same origin via proxy.
 */
export function getApiBaseUrl(): string {
  // Check if running in Electron with cached URL
  if (cachedApiBaseUrl) {
    return cachedApiBaseUrl
  }
  // Web uses same-origin (Vite dev server proxies to API)
  return ''
}

/**
 * Check if running in Electron environment
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

/**
 * Get the current platform (only available in Electron)
 */
export function getPlatform(): string | undefined {
  if (typeof window !== 'undefined') {
    return (window as any).electronAPI?.platform
  }
  return undefined
}

/**
 * Get the OS version (only available in Electron).
 * Examples: macOS "15.4.0" / "26.0.0", Windows "10.0.22631".
 */
export function getOSVersion(): string | undefined {
  if (typeof window !== 'undefined') {
    return (window as any).electronAPI?.osVersion
  }
  return undefined
}

/**
 * Open a dashboard in a new window (Electron) or new tab (web).
 */
export function openDashboardExternal(agentSlug: string, dashboardSlug: string, dashboardName?: string): void {
  if (isElectron() && window.electronAPI?.openDashboardWindow) {
    window.electronAPI.openDashboardWindow(agentSlug, dashboardSlug, dashboardName)
  } else {
    const baseUrl = getApiBaseUrl()
    const url = `${baseUrl}${buildDashboardViewPath(agentSlug, dashboardSlug)}`
    window.open(url, '_blank')
  }
}
