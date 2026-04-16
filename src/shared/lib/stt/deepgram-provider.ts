import { BaseSttProvider } from './stt-provider'

export class DeepgramSttProvider extends BaseSttProvider {
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

  override supportsVoiceAgent(): boolean {
    return true
  }

  override async mintVoiceAgentToken(apiKey: string): Promise<string> {
    // Same Deepgram token works for both STT and Voice Agent endpoints
    return this.mintEphemeralToken(apiKey)
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
        throw new Error('Deepgram API key lacks permission to create temporary tokens. Ensure the key has at least Member-level access.')
      }
      const text = await res.text()
      throw new Error(`Deepgram token grant failed (${res.status}): ${text}`)
    }
    const data = await res.json()
    if (!data.access_token || typeof data.access_token !== 'string') {
      throw new Error('Deepgram returned an unexpected response: missing access_token')
    }
    return data.access_token
  }
}
