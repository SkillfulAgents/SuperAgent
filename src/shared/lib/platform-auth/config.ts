export const DEFAULT_PLATFORM_BASE_URL = process.env.SUPERAGENT_PLATFORM_BASE_URL || 'https://platform-web-git-staging-data-wizz.vercel.app'

export function getPlatformBaseUrl(): string {
  return process.env.SUPERAGENT_PLATFORM_BASE_URL || DEFAULT_PLATFORM_BASE_URL
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
