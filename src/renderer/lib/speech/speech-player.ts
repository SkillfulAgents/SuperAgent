import { pcm16ToFloat32 } from '@renderer/lib/stt'
import type { TtsAdapter, TtsEvent } from '@renderer/lib/tts'
import { SpeechSegmenter, type SpeechSegment } from './speech-segmenter'
import type { SpokenWord } from './spoken-words'

export type SpeechPlayerStatus = 'connecting' | 'speaking' | 'done' | 'stopped' | 'error'

export interface SpeechPlayerOptions {
  adapter: TtsAdapter
  token: string
  voice: string
  onStatus?: (status: SpeechPlayerStatus, error?: Error) => void
  /** Injectable for tests; defaults to `new AudioContext({ sampleRate })`. */
  createAudioContext?: (sampleRate: number) => AudioContext
}

interface ScheduledSegment extends SpeechSegment {
  /** Context time the segment's first audio chunk starts, once one is scheduled. */
  startTime: number | null
  /** Context time its latest scheduled chunk ends. */
  endTime: number | null
  /** The server has sent every chunk for this segment. */
  flushed: boolean
}

/** Small lead before the first chunk so scheduling never lands in the past. */
const LEAD_S = 0.05
/** Slack after the last scheduled sample before declaring playback done. */
const DONE_GRACE_MS = 80

/**
 * Speaks a stream of words through a TtsAdapter and plays the audio as it
 * arrives. Words are cut into sentence-sized segments, each sent as its own
 * batch; the server's per-batch completion event ties the audio it returned to
 * the words it was for, which is what lets `getWordCursor()` say which word
 * is being spoken right now without any timestamps from the provider.
 *
 * Push-based (`append` then `end`) so a finished message and a message still
 * streaming in use the same path.
 */
export class SpeechPlayer {
  private readonly adapter: TtsAdapter
  private readonly token: string
  private readonly voice: string
  private readonly onStatus?: SpeechPlayerOptions['onStatus']
  private readonly createAudioContext: (sampleRate: number) => AudioContext

  private ctx: AudioContext | null = null
  private readonly segmenter = new SpeechSegmenter()
  private readonly segments: ScheduledSegment[] = []
  /** Index of the segment whose audio is currently arriving. */
  private receiving = 0
  private nextTime = 0
  /** A dangling byte from a chunk that split an int16 sample. */
  private carry: Uint8Array | null = null
  private ended = false
  private doneTimer: ReturnType<typeof setTimeout> | null = null
  private _status: SpeechPlayerStatus = 'connecting'
  private wordCount = 0

  constructor(options: SpeechPlayerOptions) {
    this.adapter = options.adapter
    this.token = options.token
    this.voice = options.voice
    this.onStatus = options.onStatus
    this.createAudioContext = options.createAudioContext ?? ((sampleRate) => new AudioContext({ sampleRate }))
  }

  get status(): SpeechPlayerStatus {
    return this._status
  }

  get totalWords(): number {
    return this.wordCount
  }

  private get isTerminal(): boolean {
    return this._status === 'done' || this._status === 'stopped' || this._status === 'error'
  }

  /** Open the audio output and the synthesizer connection. Text may be appended immediately. */
  start(): void {
    const ctx = this.createAudioContext(this.adapter.sampleRate)
    this.ctx = ctx
    // Created outside a synchronous user-gesture handler (after the token
    // round-trip) the context may start suspended.
    if (ctx.state === 'suspended') void ctx.resume()
    this.adapter.onAudio((chunk) => this.handleAudio(chunk))
    this.adapter.onEvent((event) => this.handleEvent(event))
    this.adapter.connect(this.token, this.voice).catch((err: unknown) => {
      this.fail(err instanceof Error ? err : new Error('Failed to connect to text-to-speech'))
    })
  }

  /** Queue more words. Complete sentences are sent to the synthesizer right away. */
  append(words: readonly SpokenWord[]): void {
    if (this.isTerminal || this.ended) return
    this.wordCount += words.length
    this.enqueue(this.segmenter.push(words))
  }

  /** No more words are coming. Playback finishes once the last audio drains. */
  end(): void {
    if (this.isTerminal || this.ended) return
    this.ended = true
    this.enqueue(this.segmenter.end())
    if (this.segments.length === 0) this.finish()
    else this.maybeFinish()
  }

  /** Cut playback off immediately. */
  stop(): void {
    if (this.isTerminal) return
    this.adapter.clear()
    this.cleanup()
    this.setStatus('stopped')
  }

  /**
   * Fractional index of the word being spoken: words at or below it have been
   * (or are being) said. -1 before any audio has played, `totalWords` once done.
   */
  getWordCursor(): number {
    if (this._status === 'done') return this.wordCount
    const ctx = this.ctx
    if (!ctx) return -1
    const now = ctx.currentTime
    let cursor = -1
    for (const segment of this.segments) {
      if (segment.startTime === null) {
        // Flushed but produced no audio (punctuation-only text): counts as said.
        if (segment.flushed) { cursor = segment.wordEnd; continue }
        break
      }
      if (now < segment.startTime) break
      if (segment.endTime !== null && now >= segment.endTime) {
        cursor = segment.wordEnd
        continue
      }
      // Inside this segment: interpolate by elapsed time. While its audio is
      // still arriving the known end understates the true end, but chunks
      // arrive far faster than real time so the window is brief.
      const end = segment.endTime ?? now
      const span = Math.max(end - segment.startTime, 1e-6)
      const progress = Math.min(1, (now - segment.startTime) / span)
      cursor = segment.wordStart + progress * (segment.wordEnd - segment.wordStart)
      break
    }
    return cursor
  }

  private enqueue(segments: SpeechSegment[]): void {
    for (const segment of segments) {
      this.segments.push({ ...segment, startTime: null, endTime: null, flushed: false })
      this.adapter.speak(segment.text)
      this.adapter.flush()
    }
  }

  private handleAudio(chunk: ArrayBuffer): void {
    const ctx = this.ctx
    if (!ctx || this.isTerminal) return

    let bytes = new Uint8Array(chunk)
    if (this.carry) {
      const merged = new Uint8Array(this.carry.length + bytes.length)
      merged.set(this.carry, 0)
      merged.set(bytes, this.carry.length)
      bytes = merged
      this.carry = null
    }
    if (bytes.length % 2 === 1) {
      this.carry = bytes.slice(bytes.length - 1)
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    if (bytes.length === 0) return

    const float32 = pcm16ToFloat32(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const buffer = ctx.createBuffer(1, float32.length, this.adapter.sampleRate)
    buffer.copyToChannel(float32 as Float32Array<ArrayBuffer>, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const startAt = Math.max(this.nextTime, ctx.currentTime + LEAD_S)
    source.start(startAt)
    this.nextTime = startAt + buffer.duration

    const segment = this.segments[this.receiving]
    if (segment) {
      if (segment.startTime === null) segment.startTime = startAt
      segment.endTime = this.nextTime
    }
    if (this._status === 'connecting') this.setStatus('speaking')
  }

  private handleEvent(event: TtsEvent): void {
    if (this.isTerminal) return
    switch (event.type) {
      case 'flushed': {
        const segment = this.segments[this.receiving]
        if (segment) segment.flushed = true
        this.receiving++
        this.maybeFinish()
        break
      }
      case 'error':
        this.fail(event.error)
        break
      case 'cleared':
        break
    }
  }

  /** Every segment's audio is in hand: finish once the last of it has played. */
  private maybeFinish(): void {
    if (!this.ended || this.receiving < this.segments.length) return
    // The socket has nothing left to deliver.
    this.adapter.close()
    const ctx = this.ctx
    const remainingMs = ctx ? Math.max(0, (this.nextTime - ctx.currentTime) * 1000) : 0
    if (this.doneTimer) clearTimeout(this.doneTimer)
    this.doneTimer = setTimeout(() => this.finish(), remainingMs + DONE_GRACE_MS)
  }

  private finish(): void {
    if (this.isTerminal) return
    this.cleanup()
    this.setStatus('done')
  }

  private fail(error: Error): void {
    if (this.isTerminal) return
    this.cleanup()
    this.setStatus('error', error)
  }

  private cleanup(): void {
    if (this.doneTimer) {
      clearTimeout(this.doneTimer)
      this.doneTimer = null
    }
    this.adapter.close()
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
  }

  private setStatus(status: SpeechPlayerStatus, error?: Error): void {
    this._status = status
    this.onStatus?.(status, error)
  }
}
