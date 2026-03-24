export const DEFAULT_PLATFORM_BASE_URL = 'http://localhost:3000'

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
  const nextUrl = new URL('/auth/superagent', getPlatformBaseUrl())
  nextUrl.searchParams.set('app_callback', callbackUri)
  if (options?.clientInstanceId) {
    nextUrl.searchParams.set('client_instance_id', options.clientInstanceId)
  }
  if (options?.deviceName) {
    nextUrl.searchParams.set('device_name', options.deviceName)
  }
  const loginUrl = new URL('/auth/login', getPlatformBaseUrl())
  loginUrl.searchParams.set('next', `${nextUrl.pathname}${nextUrl.search}`)
  loginUrl.searchParams.set('agent', 'superagent')
  return loginUrl.toString()
}
