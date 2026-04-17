import type { VoiceAgentAdapter, VoiceAgentConfig, VoiceAgentEventCallback } from './voice-agent'

const CONNECT_TIMEOUT_MS = 10_000
const KEEPALIVE_INTERVAL_MS = 5_000

export class DeepgramVoiceAgentAdapter implements VoiceAgentAdapter {
  private ws: WebSocket | null = null
  private eventCb: VoiceAgentEventCallback | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private connected = false
  readonly inputSampleRate = 16000
  readonly outputSampleRate = 24000

  async connect(token: string, config: VoiceAgentConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = 'wss://agent.deepgram.com/v1/agent/converse'
      // Browsers can't set Authorization headers on WebSocket — use subprotocol
      // Must match the format used by the STT adapter (see stt.ts DeepgramAdapter)
      this.ws = new WebSocket(url, ['bearer', token])

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Deepgram Voice Agent WebSocket connection timed out'))
      }, CONNECT_TIMEOUT_MS)

      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        clearTimeout(timeout)
        this.connected = true
        this.sendSettings(config)
        this.startKeepAlive()
        this.eventCb?.({ type: 'connected' })
        resolve()
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        const err = new Error('Deepgram Voice Agent WebSocket connection failed')
        if (!this.connected) {
          reject(err)
        } else {
          this.eventCb?.({ type: 'error', message: err.message })
        }
      }

      this.ws.onmessage = (event) => {
        // Binary frames are audio from the agent
        if (event.data instanceof ArrayBuffer) {
          this.eventCb?.({ type: 'agent_audio', audio: event.data })
          return
        }

        try {
          const data = JSON.parse(event.data as string)
          this.handleMessage(data)
        } catch {
          // Ignore non-JSON messages
        }
      }

      this.ws.onclose = (event) => {
        this.stopKeepAlive()
        if (event.code !== 1000 && event.code !== 1005) {
          this.eventCb?.({ type: 'error', message: `Deepgram connection closed: ${event.code} ${event.reason}` })
        }
        this.eventCb?.({ type: 'disconnected' })
      }
    })
  }

  private sendSettings(config: VoiceAgentConfig): void {
    // Build client-side function definitions (no endpoint = client-side)
    const functions = (config.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))

    const settings: Record<string, unknown> = {
      type: 'Settings',
      audio: {
        input: {
          encoding: 'linear16',
          sample_rate: this.inputSampleRate,
        },
        output: {
          encoding: 'linear16',
          sample_rate: this.outputSampleRate,
          container: 'none',
        },
      },
      agent: {
        language: 'en',
        listen: {
          provider: {
            type: 'deepgram',
            model: 'nova-3',
          },
        },
        think: {
          provider: {
            type: 'open_ai',
            model: 'gpt-4o-mini',
          },
          prompt: config.systemPrompt,
          functions,
        },
        speak: {
          provider: {
            type: 'deepgram',
            model: 'aura-2-thalia-en',
            speed: 1.2,
          },
        },
      },
    }

    // Inject conversation context if provided
    const agent = settings.agent as Record<string, unknown>
    if (config.conversationContext?.length) {
      agent.context = {
        messages: config.conversationContext.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      }
    }

    if (config.greeting) {
      agent.greeting = config.greeting
    }

    this.send(settings)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(data: any): void {
    switch (data.type) {
      case 'UserStartedSpeaking':
        this.eventCb?.({ type: 'user_speaking' })
        break

      case 'AgentThinking':
        this.eventCb?.({ type: 'agent_thinking' })
        break

      case 'AgentStartedSpeaking':
        // Audio will follow as binary frames
        break

      case 'AgentAudioDone':
        this.eventCb?.({ type: 'agent_audio_done' })
        break

      case 'ConversationText':
        if (data.content) {
          this.eventCb?.({
            type: 'transcript',
            role: data.role === 'assistant' ? 'assistant' : 'user',
            text: data.content,
            final: true,
          })
        }
        break

      case 'FunctionCallRequest':
        if (Array.isArray(data.functions)) {
          for (const fn of data.functions) {
            this.eventCb?.({
              type: 'function_call',
              id: fn.id,
              name: fn.name,
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments),
            })
          }
        }
        break

      case 'Error':
        this.eventCb?.({ type: 'error', message: data.description || 'Deepgram Voice Agent error' })
        break

      case 'Warning':
        console.warn('Deepgram Voice Agent warning:', data.description)
        break
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    // Deepgram expects raw binary audio frames
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    }
  }

  respondToFunctionCall(callId: string, result: string): void {
    this.send({
      type: 'FunctionCallResponse',
      id: callId,
      content: result,
    })
  }

  onEvent(cb: VoiceAgentEventCallback): void {
    this.eventCb = cb
  }

  close(): void {
    this.stopKeepAlive()
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

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      this.send({ type: 'KeepAlive' })
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }
}
