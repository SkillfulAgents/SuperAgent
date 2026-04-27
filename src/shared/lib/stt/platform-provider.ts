import { attribution, type Attribution } from '@shared/lib/attribution'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { BaseSttProvider } from './stt-provider'
import type { ApiKeyStatus, SttProvider } from '../config/settings'

export class PlatformSttProvider extends BaseSttProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'
  // Unused: status/key methods below override the base flow.
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

  async validateKey(_platformToken: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Token-validity probe: just hit the proxy with raw bearer. No
      // member attribution -- this is asking "is this token usable",
      // not "what would <user> see right now".
      const token = getPlatformAccessToken()
      if (!token) {
        return { valid: false, error: 'Platform authentication failed' }
      }
      const headers = new Headers({ Authorization: `Bearer ${token}` })
      const res = await fetch(`${getPlatformProxyBaseUrl()}/v1/deepgram/projects`, { headers })
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

  override supportsVoiceAgent(): boolean {
    return true
  }

  // BaseSttProvider.mint{Ephemeral,VoiceAgent}Token take an apiKey arg
  // we don't use; the real flow goes through the overrides below.
  async mintEphemeralToken(_platformToken: string): Promise<string> {
    return this.mintWithAuth(this.requireRequestAuth())
  }

  override async mintVoiceAgentToken(_platformToken: string): Promise<string> {
    return this.mintWithAuth(this.requireRequestAuth())
  }

  override async getEphemeralToken(): Promise<{ provider: SttProvider; token: string }> {
    return { provider: this.id, token: await this.mintWithAuth(this.requireRequestAuth()) }
  }

  override async getVoiceAgentToken(): Promise<{ provider: SttProvider; token: string }> {
    if (!this.supportsVoiceAgent()) {
      throw new Error(`Voice Agent not supported by ${this.name}`)
    }
    return { provider: this.id, token: await this.mintWithAuth(this.requireRequestAuth()) }
  }

  private requireRequestAuth(): Attribution {
    const auth = attribution.fromCurrentRequest()
    if (!auth) {
      throw new Error(`No API key configured for ${this.name}. Add one in Settings > Voice.`)
    }
    return auth
  }

  private async mintWithAuth(auth: Attribution): Promise<string> {
    const base = getPlatformProxyBaseUrl()
    const headers = new Headers()
    auth.applyTo(headers)
    headers.set('Content-Type', 'application/json')
    const res = await fetch(`${base}/v1/deepgram/auth/grant`, {
      method: 'POST',
      headers,
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
