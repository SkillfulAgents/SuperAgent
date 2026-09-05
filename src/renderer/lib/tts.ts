// --- Types ---

import type { SttProvider } from '@shared/lib/config/settings'
export type { SttProvider }

const CONNECT_TIMEOUT_MS = 10_000

export type TtsEvent =
  /** The server finished sending audio for everything queued before the k-th flush(). */
  | { type: 'flushed'; sequenceId: number }
  /** The server dropped its queued text/audio in response to clear(). */
  | { type: 'cleared'; sequenceId: number }
  | { type: 'error'; error: Error }

export type TtsAudioCallback = (chunk: ArrayBuffer) => void
export type TtsEventCallback = (event: TtsEvent) => void

/**
 * Streaming text-to-speech session: text goes in as it becomes available,
 * PCM audio comes back. The mirror image of SttAdapter.
 *
 * Text is buffered until the socket opens, so callers can queue and flush
 * immediately after connect() without awaiting it.
 */
export interface TtsAdapter {
  /** Sample rate of the returned int16 mono PCM. */
  readonly sampleRate: number
  connect(token: string, voice: string): Promise<void>
  /** Queue text for synthesis. May be called repeatedly with partial text. */
  speak(text: string): void
  /**
   * Ask the server to synthesize everything queued so far. A 'flushed' event
   * follows the last audio chunk of that batch, which is how callers learn
   * where one batch's audio ends and the next begins.
   */
  flush(): void
  /** Drop queued text and any audio not yet delivered. */
  clear(): void
  onAudio(cb: TtsAudioCallback): void
  onEvent(cb: TtsEventCallback): void
  close(): void
}

// --- Deepgram Adapter ---

const DEEPGRAM_SAMPLE_RATE = 24000

/**
 * Deepgram Aura over the speak WebSocket. Authenticated with the same
 * short-lived grant token the STT adapter uses.
 * https://developers.deepgram.com/reference/text-to-speech/speak-streaming
 */
export class DeepgramTtsAdapter implements TtsAdapter {
  readonly sampleRate = DEEPGRAM_SAMPLE_RATE
  private ws: WebSocket | null = null
  private connected = false
  private closed = false
  private pending: string[] = []
  private audioCb: TtsAudioCallback | null = null
  private eventCb: TtsEventCallback | null = null

  connect(token: string, voice: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: voice,
        encoding: 'linear16',
        sample_rate: String(DEEPGRAM_SAMPLE_RATE),
      })
      const ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${params.toString()}`, ['bearer', token])
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Deepgram speak WebSocket connection timed out'))
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        clearTimeout(timeout)
        this.connected = true
        for (const message of this.pending) ws.send(message)
        this.pending = []
        resolve()
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        const err = new Error('Deepgram speak WebSocket connection failed')
        if (!this.connected) reject(err)
        else if (!this.closed) this.eventCb?.({ type: 'error', error: err })
      }

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength > 0) this.audioCb?.(event.data)
          return
        }
        let data: any
        try {
          data = JSON.parse(event.data as string)
        } catch {
          return // Ignore non-JSON messages
        }
        this.handleMessage(data)
      }

      ws.onclose = (event) => {
        if (this.closed) return
        this.closed = true
        if (event.code !== 1000 && event.code !== 1005) {
          this.eventCb?.({
            type: 'error',
            error: new Error(`Deepgram speak connection closed: ${event.code} ${event.reason}`),
          })
        }
      }
    })
  }

  private handleMessage(data: any): void {
    switch (data?.type) {
      case 'Flushed':
        this.eventCb?.({ type: 'flushed', sequenceId: Number(data.sequence_id) })
        break
      case 'Cleared':
        this.eventCb?.({ type: 'cleared', sequenceId: Number(data.sequence_id) })
        break
      case 'Error':
        this.eventCb?.({ type: 'error', error: new Error(data.description || data.message || 'Deepgram speak error') })
        break
      case 'Warning':
        console.warn('Deepgram speak warning:', data.description ?? data)
        break
      // Metadata and anything else: nothing to do
    }
  }

  private send(message: object): void {
    if (this.closed) return
    const encoded = JSON.stringify(message)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encoded)
    else if (!this.connected) this.pending.push(encoded)
  }

  speak(text: string): void {
    if (!text) return
    this.send({ type: 'Speak', text })
  }

  flush(): void {
    this.send({ type: 'Flush' })
  }

  clear(): void {
    this.pending = []
    this.send({ type: 'Clear' })
  }

  onAudio(cb: TtsAudioCallback): void {
    this.audioCb = cb
  }

  onEvent(cb: TtsEventCallback): void {
    this.eventCb = cb
  }

  close(): void {
    this.closed = true
    this.pending = []
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

// --- Factory ---

export function createTtsAdapter(provider: SttProvider): TtsAdapter {
  switch (provider) {
    case 'deepgram':
    case 'platform':
      return new DeepgramTtsAdapter()
    default:
      throw new Error(`Text-to-speech not supported by ${provider}`)
  }
}
