import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { BaseSttProvider } from './stt-provider'
import type { ApiKeyStatus } from '../config/settings'

export class PlatformSttProvider extends BaseSttProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'
  // Not used — getApiKeyStatus/getEffectiveApiKey are both overridden to
  // read the platform token instead of a settings-stored API key.
  protected readonly settingsKeyField = 'deepgramApiKey' as const
  protected readonly envVarName = 'PLATFORM_TOKEN'

  override getApiKeyStatus(): ApiKeyStatus {
    const token = getPlatformAccessToken()
    if (token) return { isConfigured: true, source: 'settings' }
    return { isConfigured: false, source: 'none' }
  }

  override getEffectiveApiKey(): string | undefined {
    return getPlatformAccessToken() ?? undefined
  }

  async validateKey(platformToken: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const base = getPlatformProxyBaseUrl()
      const res = await fetch(`${base}/v1/deepgram/projects`, {
        headers: { Authorization: `Bearer ${platformToken}` },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Platform authentication failed' }
        }
        return { valid: false, error: `Deepgram API error via proxy: ${res.status}` }
      }
      return { valid: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: `Network error: ${message}` }
    }
  }

  async mintEphemeralToken(platformToken: string): Promise<string> {
    const base = getPlatformProxyBaseUrl()
    const res = await fetch(`${base}/v1/deepgram/auth/grant`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${platformToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: 600 }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Deepgram token grant via proxy failed (${res.status}): ${text}`)
    }
    const data = await res.json()
    if (!data.access_token || typeof data.access_token !== 'string') {
      throw new Error('Deepgram returned an unexpected response: missing access_token')
    }
    return data.access_token
  }
}
