import { splitSpeechText } from '@shared/lib/voice/text-chunks'
import { apiFetch } from './api'
import type { VoiceProvider } from '@shared/lib/config/settings'
import { fetchWithIdleTimeout } from '@shared/lib/voice/streaming-fetch'
import type { TtsAdapter, TtsAudioCallback, TtsEventCallback, TtsVoiceOptions } from './tts'

/** Adapt finite HTTP audio streams to the player's ordered Speak/Flush batches. */
export class HttpTtsAdapter implements TtsAdapter {
  readonly sampleRate = 24000
  private options: TtsVoiceOptions | null = null
  private pending = ''
  private queue: Array<{ text: string; sequenceId: number }> = []
  private sequence = 0
  private generation = 0
  private closed = false
  private active: AbortController | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private audioCb: TtsAudioCallback | null = null
  private eventCb: TtsEventCallback | null = null

  constructor(private readonly provider: VoiceProvider) {}

  async connect(options: TtsVoiceOptions) {
    if (this.closed) return
    this.options = options
    void this.pump()
  }

  speak(text: string) { if (!this.closed) this.pending += text }

  flush() {
    if (this.closed) return
    this.queue.push({ text: this.pending.trim(), sequenceId: this.sequence++ })
    this.pending = ''
    void this.pump()
  }

  clear() {
    if (this.closed) return
    this.cancel()
    this.eventCb?.({ type: 'cleared', sequenceId: this.sequence++ })
  }

  close() { this.closed = true; this.cancel() }
  onAudio(cb: TtsAudioCallback) { this.audioCb = cb }
  onEvent(cb: TtsEventCallback) { this.eventCb = cb }

  private cancel() {
    this.generation++
    this.pending = ''
    this.queue = []
    this.active?.abort()
    this.active = null
    void this.reader?.cancel().catch(() => {})
    this.reader = null
  }

  private async pump() {
    if (this.closed || this.active || !this.options || !this.queue.length) return
    const batch = this.queue.shift()!
    const options = this.options
    const generation = this.generation
    const controller = new AbortController()
    this.active = controller
    const current = () => !this.closed && generation === this.generation
    try {
      for (const chunk of splitSpeechText(batch.text, 4096, 'utf16', true)) {
        if (!current()) return
        const text = chunk.trim()
        if (!text) continue
        const response = await fetchWithIdleTimeout(apiFetch, '/api/voice/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: this.provider, text, voice: options.voice, speed: options.speed ?? 1 }),
          signal: controller.signal,
        })
        if (!current()) { void response.body?.cancel().catch(() => {}); return }
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(data?.error || `Speech synthesis failed (${response.status}).`)
        }
        if (!response.body) throw new Error('Speech synthesis returned no audio stream.')
        const reader = response.body.getReader()
        this.reader = reader
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (!current()) return
            if (done) break
            if (value.byteLength) this.audioCb?.(value.slice().buffer)
          }
        } finally {
          reader.releaseLock()
          if (this.reader === reader) this.reader = null
        }
      }
      if (current()) this.eventCb?.({ type: 'flushed', sequenceId: batch.sequenceId })
    } catch (error) {
      if (current()) {
        this.close()
        this.eventCb?.({ type: 'error', error: error instanceof Error ? error : new Error('Speech synthesis failed.') })
      }
    } finally {
      if (this.active === controller) this.active = null
      if (current()) void this.pump()
    }
  }
}
