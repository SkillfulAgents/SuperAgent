import { fetchWithIdleTimeout } from './streaming-fetch'
import { VoiceProviderError } from './provider-error'
import { OPENAI_TTS_VOICES } from './openai-voices'
import type { TtsSynthesisInput, TtsSynthesisProvider } from './tts-types'
import { BaseVoiceProvider } from './voice-provider'
import { getEffectiveModels, type VoiceProvider } from '../config/settings'
import { getConfiguredLlmClient, createSummarizerText } from '../llm-provider/helpers'
import { resolveActiveProviderModel } from '../llm-provider'
import { liveRequestSchema, type LiveAgentContext, type LiveConversationProvider, type LiveMappingInput, type LiveSessionAnswer, type VoiceHistory } from './live-types'
import { buildLiveConversationPrompt, LIVE_REPLY_PROMPT, LIVE_REQUEST_PROMPT } from '../../prompts/voice-live'
import { windowVoiceHistory } from './voice-history-window'
import { BYOK_VOICE_MESSAGES, type OpenaiVoiceMessages } from './openai-voice-messages'
import type { SttProtocol } from './stt-protocol'

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

export type { OpenaiVoiceMessages }

export class OpenaiVoiceProvider extends BaseVoiceProvider implements LiveConversationProvider, TtsSynthesisProvider {
  readonly id: VoiceProvider = 'openai'
  readonly name: string = 'OpenAI'
  protected readonly settingsKeyField = 'openaiApiKey' as const
  protected readonly envVarName = 'OPENAI_API_KEY'

  /** Where the OpenAI voice endpoints live; a proxying subclass points this elsewhere. */
  protected apiBaseUrl(): string {
    return 'https://api.openai.com/v1'
  }

  protected messages(): OpenaiVoiceMessages {
    return BYOK_VOICE_MESSAGES
  }

  override getSttProtocol(): SttProtocol {
    return 'openai-realtime'
  }

  protected override missingCredentialMessage(): string {
    return this.messages().missingKey
  }

  override getTtsVoices() { return OPENAI_TTS_VOICES }

  override getTtsSynthesis(): TtsSynthesisProvider { return this }

  async synthesizeSpeech(input: TtsSynthesisInput, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new VoiceProviderError(this.messages().missingKey, 400)
    const response = await fetchWithIdleTimeout(fetch, `${this.apiBaseUrl()}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: input.text, voice: input.voice,
        speed: input.speed, response_format: 'pcm' }),
    })
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new VoiceProviderError(this.failureMessage(response.status,
        `${this.name} speech synthesis failed (${response.status}). Please try again.`))
    }
    return response.body
  }

  override getConversationEngine() {
    return 'openai-live' as const
  }

  override getLiveConversation(): LiveConversationProvider {
    return this
  }

  /** The project key stays on the host; the renderer receives only an SDP answer. */
  async createLiveSession(sdp: string, history: VoiceHistory, agent?: LiveAgentContext): Promise<LiveSessionAnswer> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new VoiceProviderError(this.messages().missingKey, 400)
    // Check the mapping dependency before creating a billable voice session.
    getConfiguredLlmClient()
    const input = windowVoiceHistory(history).map((message) => ({
      role: message.role,
      content: [{ type: message.role === 'user' ? 'input_text' : 'text', text: message.content }],
    }))
    const res = await fetch(`${this.apiBaseUrl()}/live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        session: {
          model: 'gpt-live-1',
          instructions: buildLiveConversationPrompt(agent),
          delegation: { type: 'client' },
          audio: { output: { voice: 'marin' } },
          store: false,
          client: { data_channel: { allowed_client_events: [
            'session.commentary.append', 'session.thinking.append', 'session.instructions.append',
            'session.input_audio.mute', 'session.input_audio.unmute', 'session.close',
          ] } },
          input,
        },
        transport: { type: 'webrtc', sdp },
      }),
    })
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      throw new Error(this.failureMessage(res.status,
        `${this.name} Live session failed (${res.status}). ${this.messages().liveSessionHint}`))
    }
    const answer = await res.json() as LiveSessionAnswer
    if (!answer.session?.id || !answer.transport?.sdp) throw new Error(`${this.name} Live returned an invalid session answer.`)
    return { session: { id: answer.session.id }, transport: { type: 'webrtc', sdp: answer.transport.sdp } }
  }

  async closeLiveSession(id: string, apiKey = this.getEffectiveApiKey()): Promise<void> {
    if (!apiKey) throw new Error(`Could not close ${this.name} Live session.`)
    const response = await fetch(`${this.apiBaseUrl()}/live/sessions/${encodeURIComponent(id)}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000),
    })
    if (!response.ok && response.status !== 404) throw new Error(`Could not close ${this.name} Live session.`)
  }

  /** Provider-owned translation using the app's configured summarizer. */
  async mapLiveConversation(input: LiveMappingInput, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(12_000)
    const bounded = input.kind === 'request' ? { ...input, history: windowVoiceHistory(input.history) } : input
    const text = await createSummarizerText(getConfiguredLlmClient(), {
      model: resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer'),
      system: input.kind === 'request' ? LIVE_REQUEST_PROMPT : LIVE_REPLY_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(bounded) }],
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
      const res = await fetch(`${this.apiBaseUrl()}/models`, {
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

    const res = await fetch(`${this.apiBaseUrl()}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`${this.name} transcription failed (${res.status}): ${text}`)
    }
    const data = await res.json() as { text: string }
    return data.text
  }

  /** 401/403 and 402/429 get credential-owner-specific copy; anything else uses `fallback`. */
  protected failureMessage(status: number, fallback: string): string {
    if (status === 401 || status === 403) return this.messages().authFailed
    if (status === 402 || status === 429) return this.messages().quotaExceeded
    return fallback
  }

  protected async mintClientSecret(apiKey: string, body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.apiBaseUrl()}/realtime/client_secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      throw new Error(this.failureMessage(res.status, `${this.name} API error (${res.status}). Please try again.`))
    }
    const data = await res.json()
    if (!data.value || typeof data.value !== 'string') {
      throw new Error(`${this.name} returned an unexpected response: missing client secret value`)
    }
    return data.value
  }
}
