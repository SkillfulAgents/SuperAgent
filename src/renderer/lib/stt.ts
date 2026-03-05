// --- Types ---

import type { SttProvider } from '@shared/lib/config/settings'
export type { SttProvider }

const CONNECT_TIMEOUT_MS = 10_000

export interface TranscriptEvent {
  type: 'interim' | 'final' | 'speech_ended'
  text: string
}

export type TranscriptCallback = (event: TranscriptEvent) => void
export type ErrorCallback = (error: Error) => void

export interface SttAdapter {
  /** Required audio sample rate in Hz. Defaults to 16000 if not set. */
  readonly sampleRate?: number
  connect(token: string): Promise<void>
  sendAudio(chunk: ArrayBuffer): void
  onTranscript(cb: TranscriptCallback): void
  onError(cb: ErrorCallback): void
  close(): void
}

// --- Deepgram Adapter ---

const DEEPGRAM_WS_PARAMS = new URLSearchParams({
  model: 'nova-3',
  interim_results: 'true',
  smart_format: 'true',
  endpointing: '300',
  vad_events: 'true',
  utterance_end_ms: '1000',
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
})

class DeepgramAdapter implements SttAdapter {
  private ws: WebSocket | null = null
  private transcriptCb: TranscriptCallback | null = null
  private errorCb: ErrorCallback | null = null
  private connected = false

  async connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.deepgram.com/v1/listen?${DEEPGRAM_WS_PARAMS.toString()}`
      this.ws = new WebSocket(url, ['bearer', token])

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Deepgram WebSocket connection timed out'))
      }, CONNECT_TIMEOUT_MS)

      this.ws.onopen = () => {
        clearTimeout(timeout)
        this.connected = true
        resolve()
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        const err = new Error('Deepgram WebSocket connection failed')
        if (!this.connected) {
          reject(err)
        } else {
          this.errorCb?.(err)
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)
          if (data.type === 'Results') {
            const alt = data.channel?.alternatives?.[0]
            if (!alt) return
            const text = alt.transcript || ''
            if (!text) return

            if (data.speech_final) {
              this.transcriptCb?.({ type: 'final', text })
            } else if (data.is_final) {
              this.transcriptCb?.({ type: 'final', text })
            } else {
              this.transcriptCb?.({ type: 'interim', text })
            }
          } else if (data.type === 'UtteranceEnd') {
            this.transcriptCb?.({ type: 'speech_ended', text: '' })
          }
        } catch {
          // Ignore non-JSON messages
        }
      }

      this.ws.onclose = (event) => {
        if (event.code !== 1000 && event.code !== 1005) {
          this.errorCb?.(new Error(`Deepgram connection closed: ${event.code} ${event.reason}`))
        }
      }
    })
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    }
  }

  onTranscript(cb: TranscriptCallback): void {
    this.transcriptCb = cb
  }

  onError(cb: ErrorCallback): void {
    this.errorCb = cb
  }

  close(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      }
      this.ws.close()
      this.ws = null
    }
  }
}

// --- OpenAI Adapter ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

class OpenaiAdapter implements SttAdapter {
  private ws: WebSocket | null = null
  private transcriptCb: TranscriptCallback | null = null
  private errorCb: ErrorCallback | null = null
  private pendingDelta = ''
  private connected = false
  readonly sampleRate = 24000

  async connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription'
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
        this.ws?.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                noise_reduction: { type: 'near_field' },
                transcription: {
                  model: 'gpt-4o-mini-transcribe',
                },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  silence_duration_ms: 500,
                  prefix_padding_ms: 300,
                },
              },
            },
          },
        }))
        resolve()
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        const err = new Error('OpenAI Realtime WebSocket connection failed')
        if (!this.connected) {
          reject(err)
        } else {
          this.errorCb?.(err)
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)

          switch (data.type) {
            case 'conversation.item.input_audio_transcription.delta':
              if (data.delta) {
                // Accumulate deltas so interim events carry the full text so far
                this.pendingDelta += data.delta
                this.transcriptCb?.({ type: 'interim', text: this.pendingDelta })
              }
              break
            case 'conversation.item.input_audio_transcription.completed':
              this.pendingDelta = ''
              if (data.transcript) {
                this.transcriptCb?.({ type: 'final', text: data.transcript })
              }
              break
            case 'input_audio_buffer.speech_stopped':
              this.transcriptCb?.({ type: 'speech_ended', text: '' })
              break
            case 'error':
              this.errorCb?.(new Error(data.error?.message || 'OpenAI Realtime error'))
              break
          }
        } catch {
          // Ignore non-JSON messages
        }
      }

      this.ws.onclose = (event) => {
        if (event.code !== 1000 && event.code !== 1005) {
          this.errorCb?.(new Error(`OpenAI connection closed: ${event.code} ${event.reason}`))
        }
      }
    })
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: arrayBufferToBase64(chunk),
      }))
    }
  }

  onTranscript(cb: TranscriptCallback): void {
    this.transcriptCb = cb
  }

  onError(cb: ErrorCallback): void {
    this.errorCb = cb
  }

  close(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      }
      this.ws.close()
      this.ws = null
    }
  }
}

// --- Factory ---

export function createSttAdapter(provider: SttProvider): SttAdapter {
  switch (provider) {
    case 'deepgram':
      return new DeepgramAdapter()
    case 'openai':
      return new OpenaiAdapter()
    default:
      throw new Error(`Unknown STT provider: ${provider}`)
  }
}

// --- Shared audio capture ---

/** Convert Float32 audio samples [-1, 1] to Int16 PCM */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  return int16
}

export interface AudioCaptureHandle {
  stream: MediaStream
  audioContext: AudioContext
  processor: ScriptProcessorNode
  analyser: AnalyserNode
  cleanup: () => void
}

/**
 * Set up microphone capture and pipe PCM audio chunks to an SttAdapter.
 * Returns handles for the resources and a cleanup function.
 *
 * TODO: Migrate from deprecated createScriptProcessor to AudioWorkletNode.
 */
export async function startAudioCapture(
  adapter: SttAdapter,
  options?: { withAnalyser?: boolean },
): Promise<AudioCaptureHandle> {
  const sampleRate = adapter.sampleRate ?? 16000

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })

  const audioContext = new AudioContext({ sampleRate })
  // The context may start suspended if created outside a synchronous user-gesture
  // handler (e.g. after awaiting network requests). Explicitly resume it.
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }
  const source = audioContext.createMediaStreamSource(stream)

  const analyser = audioContext.createAnalyser()
  if (options?.withAnalyser) {
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)
  }

  const processor = audioContext.createScriptProcessor(2048, 1, 1)
  processor.onaudioprocess = (e) => {
    const float32 = e.inputBuffer.getChannelData(0)
    adapter.sendAudio(float32ToInt16(float32).buffer as ArrayBuffer)
  }

  source.connect(processor)
  processor.connect(audioContext.destination)

  const cleanup = () => {
    processor.disconnect()
    audioContext.close()
    stream.getTracks().forEach(t => t.stop())
  }

  return { stream, audioContext, processor, analyser, cleanup }
}
