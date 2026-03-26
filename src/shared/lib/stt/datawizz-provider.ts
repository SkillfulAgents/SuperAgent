import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { BaseSttProvider } from './stt-provider'
import type { ApiKeyStatus } from '../config/settings'

const DEFAULT_PROXY_BASE_URL = process.env.DATAWIZZ_PROXY_URL || 'https://platform-proxy-staging.datawizz.workers.dev'

function getProxyBaseUrl(): string {
  const raw = (process.env.DATAWIZZ_PROXY_URL || DEFAULT_PROXY_BASE_URL).trim().replace(/\/+$/, '')
  return raw.endsWith('/v1') ? raw.slice(0, -3) : raw
}

export class DatawizzSttProvider extends BaseSttProvider {
  readonly id = 'datawizz' as const
  readonly name = 'Datawizz Platform'
  protected readonly settingsKeyField = 'deepgramApiKey' as const
  protected readonly envVarName = 'DATAWIZZ_PLATFORM_TOKEN'

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
      const base = getProxyBaseUrl()
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
    const base = getProxyBaseUrl()
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
