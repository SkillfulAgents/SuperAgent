import { getSettings, type ApiKeySettings, type ApiKeyStatus, type SttProvider } from '../config/settings'

export abstract class BaseSttProvider {
  abstract readonly id: SttProvider
  abstract readonly name: string

  /** Which field in ApiKeySettings stores this provider's key. */
  protected abstract readonly settingsKeyField: keyof ApiKeySettings
  /** Environment variable name for this provider's key. */
  protected abstract readonly envVarName: string

  /** Check whether an API key is configured and its source. */
  getApiKeyStatus(): ApiKeyStatus {
    const settings = getSettings()
    if (settings.apiKeys?.[this.settingsKeyField]) {
      return { isConfigured: true, source: 'settings' }
    }
    if (process.env[this.envVarName]) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  /** Get the effective API key (settings take precedence over env var). */
  getEffectiveApiKey(): string | undefined {
    const settings = getSettings()
    const fromSettings = settings.apiKeys?.[this.settingsKeyField]
    if (fromSettings) return fromSettings
    return process.env[this.envVarName]
  }

  /** Validate an API key. Returns { valid: true } or { valid: false, error: string }. */
  abstract validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }>

  /** Mint a short-lived ephemeral token for client-side use. */
  abstract mintEphemeralToken(apiKey: string): Promise<string>

  async getEphemeralToken(): Promise<{ provider: SttProvider; token: string }> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) {
      throw new Error(`No API key configured for ${this.name}. Add one in Settings > Voice.`)
    }
    const token = await this.mintEphemeralToken(apiKey)
    return { provider: this.id, token }
  }

  /** Whether this provider supports Voice Agent (S2S) sessions. */
  supportsVoiceAgent(): boolean {
    return false
  }

  /** Mint a token for a Voice Agent session. Override in providers that support it. */
  async mintVoiceAgentToken(apiKey: string): Promise<string> {
    void apiKey
    throw new Error(`Voice Agent not supported by ${this.name}`)
  }

  /** Convenience: resolve the effective key and mint a Voice Agent token. */
  async getVoiceAgentToken(): Promise<{ provider: SttProvider; token: string }> {
    if (!this.supportsVoiceAgent()) {
      throw new Error(`Voice Agent not supported by ${this.name}`)
    }
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) {
      throw new Error(`No API key configured for ${this.name}. Add one in Settings > Voice.`)
    }
    const token = await this.mintVoiceAgentToken(apiKey)
    return { provider: this.id, token }
  }
}
