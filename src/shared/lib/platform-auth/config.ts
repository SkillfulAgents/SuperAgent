declare global {
  var __PLATFORM_BASE_URL__: string | undefined
  var __PLATFORM_PROXY_URL__: string | undefined
}

function getConfiguredValue(runtimeValue: string | undefined, buildValue: string | undefined): string {
  return runtimeValue?.trim() || buildValue?.trim() || ''
}

function getBuildPlatformBaseUrl(): string {
  return getConfiguredValue(undefined, globalThis.__PLATFORM_BASE_URL__)
}

function getBuildPlatformProxyUrl(): string {
  return getConfiguredValue(undefined, globalThis.__PLATFORM_PROXY_URL__)
}

export function getPlatformBaseUrl(): string {
  return getConfiguredValue(process.env.PLATFORM_BASE_URL, getBuildPlatformBaseUrl())
}

/**
 * A Telegram web_app button (and anything else that opens in a public webview)
 * only accepts a public https URL. Return the base URL when it parses as https,
 * otherwise the empty string so callers treat a missing, malformed, or http base
 * the same way and fall back to a non-interactive surface.
 */
export function httpsBaseUrlOrEmpty(base: string): string {
  try {
    return new URL(base).protocol === 'https:' ? base : ''
  } catch {
    return ''
  }
}

/**
 * The base URL the Telegram dashboard Mini App can actually be served from, or
 * empty if there isn't one. This is NOT the same as getPlatformBaseUrl(): in the
 * Electron desktop app PLATFORM_BASE_URL is baked to the cloud platform URL (for
 * login/proxy), but the embedded local server isn't reachable there, so a
 * dashboard button would dead-end. Electron (process.type === 'browser') is
 * therefore treated as "no servable URL". Web/server mode (hosted or self-hosted)
 * is the only place this server actually serves the Mini App.
 */
export function miniAppBaseUrlOrEmpty(): string {
  if (process.type === 'browser') return ''
  return httpsBaseUrlOrEmpty(getPlatformBaseUrl())
}

/**
 * One-line, operator-facing summary of whether Telegram dashboard sharing is
 * available, logged at server boot. A button that dead-ends is usually a
 * misconfigured PLATFORM_BASE_URL; this makes the configured value visible so an
 * operator can see at a glance whether sharing is on and what URL it points at.
 */
export function dashboardSharingStatus(): string {
  const base = getPlatformBaseUrl()
  const publicUrl = httpsBaseUrlOrEmpty(base)
  if (publicUrl) {
    return `Telegram dashboard sharing enabled; Mini Apps open from ${publicUrl}`
  }
  if (base) {
    return `Telegram dashboard sharing disabled: PLATFORM_BASE_URL ("${base}") is not a public HTTPS URL`
  }
  return 'Telegram dashboard sharing disabled: no PLATFORM_BASE_URL set (agents get a plain-text fallback)'
}

/**
 * Resolve the platform proxy base URL (no trailing slash, no /v1 suffix).
 * Used by the LLM provider, STT provider, and Composio client.
 */
export function getPlatformProxyBaseUrl(): string {
  const raw = getConfiguredValue(
    process.env.PLATFORM_PROXY_URL,
    getBuildPlatformProxyUrl(),
  ).replace(/\/+$/, '')
  return raw.endsWith('/v1') ? raw.slice(0, -3) : raw
}

export function getPlatformCallbackUri(protocolScheme: string): string {
  return `${protocolScheme}://platform-auth-callback`
}

export function buildPlatformLoginUrl(
  protocolScheme: string,
  options?: {
    clientInstanceId?: string
    deviceName?: string
  }
): string {
  const callbackUri = getPlatformCallbackUri(protocolScheme)
  let url: URL
  try {
    url = new URL('/auth/superagent', getPlatformBaseUrl())
  } catch {
    throw new Error(`Invalid platform base URL: ${getPlatformBaseUrl()}`)
  }
  url.searchParams.set('app_callback', callbackUri)
  if (options?.clientInstanceId) {
    url.searchParams.set('client_instance_id', options.clientInstanceId)
  }
  if (options?.deviceName) {
    url.searchParams.set('device_name', options.deviceName)
  }
  return url.toString()
}
