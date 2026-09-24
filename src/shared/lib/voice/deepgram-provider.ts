import { VoiceProviderError } from './provider-error'
import { BaseVoiceProvider } from './voice-provider'
import { DEEPGRAM_TTS_VOICES } from './deepgram-voices'
import type { TtsVoiceInfo } from './tts-preferences'

export class DeepgramVoiceProvider extends BaseVoiceProvider {
  readonly id = 'deepgram' as const
  readonly name = 'Deepgram'
  protected readonly settingsKeyField = 'deepgramApiKey' as const
  protected readonly envVarName = 'DEEPGRAM_API_KEY'

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // 1. Check if the key is valid at all
      const projectsRes = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${apiKey}` },
      })

      if (!projectsRes.ok) {
        if (projectsRes.status === 401 || projectsRes.status === 403) {
          return { valid: false, error: 'Invalid API key' }
        }
        return { valid: false, error: `Deepgram API error: ${projectsRes.status}` }
      }

      // 2. Check if the key can create ephemeral tokens (requires Member-level access)
      const grantRes = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl_seconds: 5 }),
      })

      if (!grantRes.ok) {
        return {
          valid: false,
          error: 'API key is valid but lacks permission to create temporary tokens. Use a key with at least Member-level access.',
        }
      }

      return { valid: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: `Network error: ${message}` }
    }
  }

  override getTtsVoices(): readonly TtsVoiceInfo[] {
    return DEEPGRAM_TTS_VOICES
  }

  override async mintTtsToken(apiKey: string): Promise<string> {
    // Same Deepgram token works for the speak endpoint too
    return this.mintEphemeralToken(apiKey)
  }

  override supportsTranscription(): boolean {
    return true
  }

  override async transcribeAudio(apiKey: string, audioBuffer: Buffer, mimeType: string): Promise<string> {
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true', {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': mimeType,
      },
      body: new Uint8Array(audioBuffer),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Deepgram transcription failed (${res.status}): ${text}`)
    }
    const data = await res.json() as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
    }
    return data.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
  }

  async mintEphemeralToken(apiKey: string): Promise<string> {
    const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: 600 }),
    })
    if (!res.ok) {
      if (res.status === 403) {
        void res.body?.cancel().catch(() => {})
        throw new VoiceProviderError('Deepgram API key lacks permission to create temporary tokens. Ensure the key has at least Member-level access.')
      }
      void res.body?.cancel().catch(() => {})
      throw new VoiceProviderError(res.status === 401
        ? 'Deepgram rejected the API key. Update it in Settings > Voice.'
        : `Deepgram token grant failed (${res.status}). Please try again.`)
    }
    const data = await res.json()
    if (!data.access_token || typeof data.access_token !== 'string') {
      throw new Error('Deepgram returned an unexpected response: missing access_token')
    }
    return data.access_token
  }
}
