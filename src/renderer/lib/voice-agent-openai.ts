import type { VoiceAgentAdapter, VoiceAgentConfig, VoiceAgentEventCallback } from './voice-agent'
import { arrayBufferToBase64 } from './stt'

const CONNECT_TIMEOUT_MS = 10_000

export class OpenAIVoiceAgentAdapter implements VoiceAgentAdapter {
  private ws: WebSocket | null = null
  private eventCb: VoiceAgentEventCallback | null = null
  private connected = false
  readonly inputSampleRate = 24000
  readonly outputSampleRate = 24000

  async connect(token: string, config: VoiceAgentConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = 'wss://api.openai.com/v1/realtime?model=gpt-realtime'
      this.ws = new WebSocket(url, [
        'realtime',
        `openai-insecure-api-key.${token}`,
      ])

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('OpenAI Realtime WebSocket connection timed out'))
      }, CONNECT_TIMEOUT_MS)

      this.ws.onopen = () => {
        clearTimeout(timeout)
        this.connected = true
        this.configureSession(config)
        this.eventCb?.({ type: 'connected' })
        resolve()
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        const err = new Error('OpenAI Realtime WebSocket connection failed')
        if (!this.connected) {
          reject(err)
        } else {
          this.eventCb?.({ type: 'error', message: err.message })
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)
          this.handleMessage(data)
        } catch {
          // Ignore non-JSON messages
        }
      }

      this.ws.onclose = (event) => {
        if (event.code !== 1000 && event.code !== 1005) {
          this.eventCb?.({ type: 'error', message: `OpenAI connection closed: ${event.code} ${event.reason}` })
        }
        this.eventCb?.({ type: 'disconnected' })
      }
    })
  }

  private configureSession(config: VoiceAgentConfig): void {
    // Build tools array for the session
    const tools = (config.tools ?? []).map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))

    // Send session configuration using the GA Realtime API field structure
    // (Beta used flat fields like `modalities`, `input_audio_format` etc.
    //  GA nests everything under `audio.input` / `audio.output`)
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: 'Always respond in English regardless of what language the user speaks.\n\n' + config.systemPrompt,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: 'near_field' },
            transcription: {
              model: 'gpt-4o-mini-transcribe',
              language: 'en',
            },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'coral',
          },
        },
        tools,
        tool_choice: 'auto',
      },
    })

    // Inject conversation context if provided
    if (config.conversationContext?.length) {
      for (const msg of config.conversationContext) {
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: msg.role,
            content: [{
              type: msg.role === 'user' ? 'input_text' : 'text',
              text: msg.content,
            }],
          },
        })
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(data: any): void {
    // Log all events for debugging (except noisy audio deltas)
    if (data.type !== 'response.audio.delta' && data.type !== 'response.output_audio.delta' && data.type !== 'input_audio_buffer.speech_started') {
      console.log('[OpenAI Realtime]', data.type, data.type === 'error' ? data.error : '')
    }

    switch (data.type) {
      case 'session.updated':
        // Session config confirmed — now trigger the initial greeting
        this.send({ type: 'response.create' })
        break

      case 'input_audio_buffer.speech_started':
        this.eventCb?.({ type: 'user_speaking' })
        break

      case 'input_audio_buffer.speech_stopped':
        this.eventCb?.({ type: 'user_stopped_speaking' })
        break

      case 'response.audio.delta':          // Beta event name
      case 'response.output_audio.delta':   // GA event name
        if (data.delta) {
          try {
            const binary = atob(data.delta)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i)
            }
            this.eventCb?.({ type: 'agent_audio', audio: bytes.buffer as ArrayBuffer })
          } catch {
            // Ignore invalid base64 chunks
          }
        }
        break

      case 'response.audio.done':
      case 'response.output_audio.done':
        this.eventCb?.({ type: 'agent_audio_done' })
        break

      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (data.delta) {
          this.eventCb?.({ type: 'transcript', role: 'assistant', text: data.delta, final: false })
        }
        break

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (data.transcript) {
          this.eventCb?.({ type: 'transcript', role: 'assistant', text: data.transcript, final: true })
        }
        break

      case 'conversation.item.input_audio_transcription.completed':
        if (data.transcript) {
          this.eventCb?.({ type: 'transcript', role: 'user', text: data.transcript, final: true })
        }
        break

      case 'response.function_call_arguments.done':
        this.eventCb?.({
          type: 'function_call',
          id: data.call_id,
          name: data.name,
          arguments: data.arguments,
        })
        break

      case 'error':
        this.eventCb?.({ type: 'error', message: friendlyRealtimeError(data.error) })
        break

      case 'response.done':
        if (data.response?.status === 'failed') {
          this.eventCb?.({ type: 'error', message: friendlyRealtimeError(data.response?.status_details?.error) })
        }
        break
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: arrayBufferToBase64(chunk),
    })
  }

  respondToFunctionCall(callId: string, result: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: result,
      },
    })
    // Trigger the model to continue responding after the function call
    this.send({ type: 'response.create' })
  }

  onEvent(cb: VoiceAgentEventCallback): void {
    this.eventCb = cb
  }

  close(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}

/** Map OpenAI Realtime error objects to user-friendly messages. */
function friendlyRealtimeError(err: { code?: string; message?: string } | undefined): string {
  const code = err?.code || ''
  const msg = err?.message || 'OpenAI Realtime error'
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' ||
      code === 'rate_limit_exceeded' || /quota|billing|insufficient/i.test(msg)) {
    return 'OpenAI API quota exceeded. Please check your OpenAI account balance and billing settings.'
  }
  return msg
}
