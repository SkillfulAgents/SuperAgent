// Cache for the API base URL (fetched once from Electron main process)
let cachedApiBaseUrl: string | null = null
let apiUrlPromise: Promise<string> | null = null

/**
 * Initialize the API base URL (call this at app startup in Electron)
 */
export async function initApiBaseUrl(): Promise<void> {
  if (isElectron() && window.electronAPI?.getApiUrl) {
    cachedApiBaseUrl = await window.electronAPI.getApiUrl()
  }
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
 * Get the API base URL, fetching it if not yet cached.
 * Use this for the first API call if initApiBaseUrl hasn't been called yet.
 */
export async function getApiBaseUrlAsync(): Promise<string> {
  if (cachedApiBaseUrl) {
    return cachedApiBaseUrl
  }

  if (isElectron() && window.electronAPI?.getApiUrl) {
    if (!apiUrlPromise) {
      apiUrlPromise = window.electronAPI.getApiUrl().then((url) => {
        cachedApiBaseUrl = url
        return url
      })
    }
    return apiUrlPromise
  }

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
