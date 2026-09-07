import { getSettings, type ApiKeySettings, type ApiKeyStatus, type SttProvider } from '../config/settings'
import type { TtsVoiceInfo } from './tts-preferences'

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

  /** Convenience: resolve the effective key and mint an ephemeral token. */
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

  /**
   * Voices this provider can read with, in the order the settings picker
   * shows them. Empty when the provider cannot synthesize speech. The ids
   * are the provider's own (they go straight into its synthesis request),
   * which is why the catalogue lives with the provider and not in settings.
   */
  getTtsVoices(): readonly TtsVoiceInfo[] {
    return []
  }

  /** Whether this provider supports streaming text-to-speech. */
  supportsTts(): boolean {
    return this.getTtsVoices().length > 0
  }

  /** The voice used when nobody has picked one. Undefined when the provider cannot speak. */
  getDefaultTtsVoice(): string | undefined {
    return this.getTtsVoices()[0]?.id
  }

  hasTtsVoice(id: unknown): id is string {
    return typeof id === 'string' && this.getTtsVoices().some((voice) => voice.id === id)
  }

  /**
   * The first pick this provider can honour, else its default: a user's own
   * choice, then the deployment's. A stored id the provider no longer offers
   * (a retired voice, or a pick made under another provider) falls through.
   */
  resolveTtsVoice(...picks: unknown[]): string | undefined {
    return picks.find((pick) => this.hasTtsVoice(pick)) as string | undefined ?? this.getDefaultTtsVoice()
  }

  /** Mint a token for a text-to-speech session. Override in providers that support it. */
  async mintTtsToken(apiKey: string): Promise<string> {
    void apiKey
    throw new Error(`Text-to-speech not supported by ${this.name}`)
  }

  /** Convenience: resolve the effective key and mint a text-to-speech token. */
  async getTtsToken(): Promise<{ provider: SttProvider; token: string }> {
    if (!this.supportsTts()) {
      throw new Error(`Text-to-speech not supported by ${this.name}`)
    }
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) {
      throw new Error(`No API key configured for ${this.name}. Add one in Settings > Voice.`)
    }
    const token = await this.mintTtsToken(apiKey)
    return { provider: this.id, token }
  }

  /** Whether this provider supports batch audio file transcription. */
  supportsTranscription(): boolean {
    return false
  }

  /** Transcribe an audio buffer to text. Override in providers that support it. */
  async transcribeAudio(_apiKey: string, _audioBuffer: Buffer, _mimeType: string): Promise<string> {
    throw new Error(`Batch transcription not supported by ${this.name}`)
  }

  /** Convenience: resolve the effective key and transcribe an audio buffer. */
  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
    if (!this.supportsTranscription()) {
      throw new Error(`Batch transcription not supported by ${this.name}`)
    }
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) {
      throw new Error(`No API key configured for ${this.name}. Add one in Settings > Voice.`)
    }
    return this.transcribeAudio(apiKey, audioBuffer, mimeType)
  }
}
