import { pcm16ToFloat32 } from '@renderer/lib/stt'
import type { TtsAdapter, TtsEvent, TtsVoiceOptions } from '@renderer/lib/tts'
import { SpeechSegmenter, type SpeechSegment } from './speech-segmenter'
import type { SpokenWord } from './spoken-words'

export type SpeechPlayerStatus = 'connecting' | 'speaking' | 'paused' | 'done' | 'stopped' | 'error'

export interface SpeechPlayerOptions {
  adapter: TtsAdapter
  token: string
  voice: TtsVoiceOptions
  onStatus?: (status: SpeechPlayerStatus, error?: Error) => void
  /**
   * Index of the first appended word within the whole message. Lets a
   * restart (a speed change mid-reply) pick up where the last player left
   * off while the cursor keeps addressing the message's spans.
   */
  firstWordIndex?: number
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
 * How far ahead of playback to keep audio scheduled. Segments are sent only
 * as this runs down (plus a couple in flight so the synthesizer's latency is
 * hidden), so a stop or a speed change early in a long reply wastes at most
 * this much synthesis rather than the whole message.
 */
const AHEAD_S = 10
const MAX_IN_FLIGHT = 2

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
  private readonly voice: TtsVoiceOptions
  private readonly onStatus?: SpeechPlayerOptions['onStatus']
  private readonly createAudioContext: (sampleRate: number) => AudioContext

  private ctx: AudioContext | null = null
  private readonly firstWordIndex: number
  private readonly segmenter: SpeechSegmenter
  private readonly segments: ScheduledSegment[] = []
  /** Index of the segment whose audio is currently arriving. */
  private receiving = 0
  /** Segments [0, sent) have been handed to the synthesizer. */
  private sent = 0
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private nextTime = 0
  /** A dangling byte from a chunk that split an int16 sample. */
  private carry: Uint8Array | null = null
  private ended = false
  private doneTimer: ReturnType<typeof setTimeout> | null = null
  private _status: SpeechPlayerStatus = 'connecting'
  private wordCount = 0
  /** High-water mark of the cursor, so it never reads backwards. */
  private cursorHigh: number

  constructor(options: SpeechPlayerOptions) {
    this.adapter = options.adapter
    this.token = options.token
    this.voice = options.voice
    this.onStatus = options.onStatus
    this.firstWordIndex = options.firstWordIndex ?? 0
    // A fresh read has said nothing yet; a restart mid-reply took over the
    // word that was being spoken, which stays lit while its audio is refetched.
    this.cursorHigh = this.firstWordIndex > 0 ? this.firstWordIndex : -1
    this.segmenter = new SpeechSegmenter(this.firstWordIndex)
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
    // A context created outside a user gesture may start suspended. A
    // refused resume is an error, not minutes of silent "speaking".
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        this.fail(new Error('Audio playback was blocked by the browser. Tap the speaker to try again.'))
      })
    }
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
   * Hold playback where it is. Suspending the context freezes its clock, so
   * the word cursor holds too and audio already scheduled waits in place;
   * the synthesizer keeps delivering in the background.
   */
  pause(): void {
    if (this._status !== 'speaking' || !this.ctx) return
    // The done timer counts wall-clock time against a frozen audio clock.
    if (this.doneTimer) {
      clearTimeout(this.doneTimer)
      this.doneTimer = null
    }
    void this.ctx.suspend()
    this.setStatus('paused')
  }

  resume(): void {
    if (this._status !== 'paused' || !this.ctx) return
    void this.ctx.resume()
    this.setStatus('speaking')
    this.pump()
    this.maybeFinish()
  }

  /**
   * Fractional index of the word being spoken: words at or below it have been
   * (or are being) said. -1 before any audio has played (`firstWordIndex`
   * for a restart), `firstWordIndex + totalWords` once done. Never moves
   * backwards: a segment's known end grows as its audio arrives, which would
   * otherwise pull an interpolated position back (visible when paused early
   * in a segment).
   */
  getWordCursor(): number {
    if (this._status === 'done') return this.firstWordIndex + this.wordCount
    this.cursorHigh = Math.max(this.cursorHigh, this.rawWordCursor())
    return this.cursorHigh
  }

  private rawWordCursor(): number {
    const ctx = this.ctx
    if (!ctx) return this.firstWordIndex - 1
    const now = ctx.currentTime
    let cursor = this.firstWordIndex - 1
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
    }
    this.pump()
  }

  /** Seconds of audio scheduled beyond the playhead. */
  private bufferedAhead(): number {
    return this.ctx ? Math.max(0, this.nextTime - this.ctx.currentTime) : 0
  }

  /**
   * Hand the synthesizer the next segments while the scheduled audio is
   * short of AHEAD_S, then come back when it runs down that far. Nothing is
   * sent while paused (the clock is frozen); resume() calls back in.
   */
  private pump(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
    }
    if (this.isTerminal || this._status === 'paused') return
    while (
      this.sent < this.segments.length &&
      this.sent - this.receiving < MAX_IN_FLIGHT &&
      this.bufferedAhead() < AHEAD_S
    ) {
      const segment = this.segments[this.sent++]
      this.adapter.speak(segment.text)
      this.adapter.flush()
    }
    if (this.sent < this.segments.length && this.sent - this.receiving < MAX_IN_FLIGHT) {
      const delayMs = Math.max(100, (this.bufferedAhead() - AHEAD_S) * 1000)
      this.pumpTimer = setTimeout(() => this.pump(), delayMs)
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
        this.pump()
        this.maybeFinish()
        break
      }
      case 'closed':
        // The socket is closed on our side only once every segment is in;
        // any earlier close means the rest of the reply will never arrive.
        if (this.receiving < this.segments.length || !this.ended) {
          this.fail(new Error('Text-to-speech connection closed before the reply finished'))
        }
        break
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
    // Paused: the audio clock is frozen, so a wall-clock timer would fire
    // early. resume() calls back in here.
    if (this._status === 'paused') return
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
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
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
