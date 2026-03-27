const DEFAULT_PLATFORM_BASE_URL = 'https://platform-web-git-staging-data-wizz.vercel.app'  // change to prod or local 
const DEFAULT_PLATFORM_PROXY_URL = 'https://platform-proxy-staging.datawizz.workers.dev'  // change to prod or local 
// TODO: remove this after testing 
export function getPlatformBaseUrl(): string {
  return process.env.SUPERAGENT_PLATFORM_BASE_URL || DEFAULT_PLATFORM_BASE_URL
}

/**
 * Resolve the platform proxy base URL (no trailing slash, no /v1 suffix).
 * Used by the LLM provider, STT provider, and Composio client.
 */
export function getPlatformProxyBaseUrl(): string {
  const raw = (process.env.DATAWIZZ_PROXY_URL || DEFAULT_PLATFORM_PROXY_URL).trim().replace(/\/+$/, '')
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
  const url = new URL('/auth/superagent', getPlatformBaseUrl())
  url.searchParams.set('app_callback', callbackUri)
  if (options?.clientInstanceId) {
    url.searchParams.set('client_instance_id', options.clientInstanceId)
  }
  if (options?.deviceName) {
    url.searchParams.set('device_name', options.deviceName)
  }
  return url.toString()
}
