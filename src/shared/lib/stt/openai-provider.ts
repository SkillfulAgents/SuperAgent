import { BaseSttProvider } from './stt-provider'

const MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4a-latm': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-caf': 'caf',
  'audio/amr': 'amr',
}

export class OpenaiSttProvider extends BaseSttProvider {
  readonly id = 'openai' as const
  readonly name = 'OpenAI'
  protected readonly settingsKeyField = 'openaiApiKey' as const
  protected readonly envVarName = 'OPENAI_API_KEY'

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid API key' }
        }
        return { valid: false, error: `OpenAI API error: ${res.status}` }
      }

      return { valid: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: `Network error: ${message}` }
    }
  }

  async mintEphemeralToken(apiKey: string): Promise<string> {
    return this.mintClientSecret(apiKey, { session: { type: 'transcription' } })
  }

  override supportsVoiceAgent(): boolean {
    return true
  }

  override async mintVoiceAgentToken(apiKey: string): Promise<string> {
    return this.mintClientSecret(apiKey, { session: { type: 'realtime' } })
  }

  override supportsTranscription(): boolean {
    return true
  }

  override async transcribeAudio(apiKey: string, audioBuffer: Buffer, mimeType: string): Promise<string> {
    const ext = MIME_TO_EXT[mimeType] || 'wav'
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType })
    const formData = new FormData()
    formData.append('file', blob, `audio.${ext}`)
    formData.append('model', 'whisper-1')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`OpenAI transcription failed (${res.status}): ${text}`)
    }
    const data = await res.json() as { text: string }
    return data.text
  }

  private async mintClientSecret(apiKey: string, body: Record<string, unknown>): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid OpenAI API key. Please check your key in Settings > Voice.')
      }
      if (res.status === 429) {
        throw new Error('OpenAI API quota exceeded. Please check your OpenAI account balance and billing settings.')
      }
      const text = await res.text()
      throw new Error(`OpenAI API error (${res.status}): ${text}`)
    }
    const data = await res.json()
    if (!data.value || typeof data.value !== 'string') {
      throw new Error('OpenAI returned an unexpected response: missing client secret value')
    }
    return data.value
  }
}
