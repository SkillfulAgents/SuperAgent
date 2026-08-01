export const BROWSER_OPEN_LOCATIONS = ['configured', 'container'] as const

/** Location requested by the model when opening a browser. */
export type BrowserOpenLocation = typeof BROWSER_OPEN_LOCATIONS[number]

/** Location of the Chromium process that is actually active. */
export type BrowserRuntimeLocation = 'host' | 'container'

/**
 * Resolve the model-facing location onto the browser process we should use.
 * "configured" preserves the existing host-provider preference, while an
 * explicit "container" always bypasses it.
 */
export function resolveBrowserRuntimeLocation(
  requested: BrowserOpenLocation = 'configured',
  hostBrowserConfigured: boolean = !!process.env.AGENT_BROWSER_USE_HOST,
): BrowserRuntimeLocation {
  return requested === 'container' || !hostBrowserConfigured ? 'container' : 'host'
}

/** Whether an open request must tear down the current provider before launch. */
export function requiresBrowserLocationSwitch(
  current: BrowserRuntimeLocation | null,
  requested: BrowserRuntimeLocation,
): boolean {
  return current !== null && current !== requested
}

/** URLs that normally refer to a service in the browser's own network namespace. */
export function isLoopbackBrowserUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '0.0.0.0'
      || hostname === '[::1]'
  } catch {
    return false
  }
}
