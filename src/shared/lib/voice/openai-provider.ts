import { BaseVoiceProvider } from './voice-provider'
import { getEffectiveModels } from '../config/settings'
import { getConfiguredLlmClient, createSummarizerText } from '../llm-provider/helpers'
import { resolveActiveProviderModel } from '../llm-provider'
import { liveRequestSchema, type LiveConversationProvider, type LiveMappingInput, type LiveSessionAnswer, type VoiceHistory } from './live-types'
import { LIVE_CONVERSATION_PROMPT, LIVE_REPLY_PROMPT, LIVE_REQUEST_PROMPT } from '../../prompts/voice-live'

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

export class OpenaiVoiceProvider extends BaseVoiceProvider implements LiveConversationProvider {
  readonly id = 'openai' as const
  readonly name = 'OpenAI'
  protected readonly settingsKeyField = 'openaiApiKey' as const
  protected readonly envVarName = 'OPENAI_API_KEY'

  override getConversationEngine() {
    return 'openai-live' as const
  }

  override getLiveConversation(): LiveConversationProvider {
    return this
  }

  /** The project key stays on the host; the renderer receives only an SDP answer. */
  async createLiveSession(sdp: string, history: VoiceHistory): Promise<LiveSessionAnswer> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Add your OpenAI API key in Settings > Voice.')
    // Check the mapping dependency before creating a billable voice session.
    getConfiguredLlmClient()
    const res = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        session: {
          model: 'gpt-live-1',
          instructions: LIVE_CONVERSATION_PROMPT,
          delegation: { type: 'client' },
          audio: { output: { voice: 'marin' } },
          store: false,
          client: { data_channel: { allowed_client_events: [
            'session.commentary.append', 'session.thinking.append', 'session.instructions.append',
            'session.input_audio.mute', 'session.input_audio.unmute', 'session.close',
          ] } },
          input: history.filter((message) => message.content.trim()).slice(-12).map((message) => ({
            role: message.role,
            content: [{ type: message.role === 'user' ? 'input_text' : 'text', text: message.content.slice(-800) }],
          })),
        },
        transport: { type: 'webrtc', sdp },
      }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI Live session failed (${res.status}). Check your key, GPT-Live access, and billing.`)
    }
    const answer = await res.json() as LiveSessionAnswer
    if (!answer.session?.id || !answer.transport?.sdp) throw new Error('OpenAI Live returned an invalid session answer.')
    return { session: { id: answer.session.id }, transport: { type: 'webrtc', sdp: answer.transport.sdp } }
  }

  async closeLiveSession(id: string): Promise<void> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) return
    const response = await fetch(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000),
    })
    if (!response.ok && response.status !== 404) throw new Error('Could not close OpenAI Live session.')
  }

  /** Provider-owned translation using the app's configured summarizer. */
  async mapLiveConversation(input: LiveMappingInput, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(12_000)
    const text = await createSummarizerText(getConfiguredLlmClient(), {
      model: resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer'),
      system: input.kind === 'request' ? LIVE_REQUEST_PROMPT : LIVE_REPLY_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(input) }],
      ...(input.kind === 'request' ? { output_config: { format: {
        type: 'json_schema' as const,
        schema: {
          type: 'object',
          properties: { action: { type: 'string', enum: liveRequestSchema.shape.action.options }, text: { type: 'string' } },
          required: ['action', 'text'], additionalProperties: false,
        },
      } } } : {}),
    }, signal ? AbortSignal.any([signal, deadline]) : deadline)
    if (!text) throw new Error('The configured summarizer returned no voice mapping. Please try again.')
    if (input.kind === 'reply') return { text: text.slice(0, 1800) }
    try {
      const request = liveRequestSchema.parse(JSON.parse(text))
      if (request.action !== 'none' && !request.text.trim()) throw new Error('Empty request')
      return request
    } catch {
      throw new Error('The configured summarizer returned an invalid voice request. Please try again.')
    }
  }

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
