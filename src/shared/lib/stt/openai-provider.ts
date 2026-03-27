import { BaseSttProvider } from './stt-provider'

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
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'transcription',
        },
      }),
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
