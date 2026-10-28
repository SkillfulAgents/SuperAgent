export const BROWSER_OPEN_LOCATIONS = ['configured', 'container'] as const

/** Location requested by the model when opening a browser. */
export type BrowserOpenLocation = typeof BROWSER_OPEN_LOCATIONS[number]

/** Location of the Chromium process that is actually active. */
export type BrowserRuntimeLocation = 'host' | 'container'

/**
 * Resolve the model-facing location onto the browser process we should use.
 * An omitted location keeps a live browser where it is; with no live browser,
 * it falls back to the configured provider. Explicit values always win.
 */
export function resolveBrowserRuntimeLocation(
  requested: BrowserOpenLocation | undefined,
  current: BrowserRuntimeLocation | null = null,
  hostBrowserConfigured: boolean = !!process.env.AGENT_BROWSER_USE_HOST,
): BrowserRuntimeLocation {
  if (requested === undefined && current !== null) return current
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

/**
 * Teaching guard for likely model mistakes, not a network security boundary.
 * Host-loopback remains available when explicitly requested with "configured".
 */
export function shouldRefuseImplicitHostLoopback(
  url: string,
  requested: BrowserOpenLocation | undefined,
  resolved: BrowserRuntimeLocation,
): boolean {
  return requested === undefined && resolved === 'host' && isLoopbackBrowserUrl(url)
}
