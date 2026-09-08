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
  /**
   * A reply still streaming in can leave the synthesizer idle for as long as
   * a tool call takes, and the server closes an idle connection. With this
   * set, a close that arrives once every queued segment's audio is in hand
   * ends this player cleanly (its audio plays out) instead of failing; the
   * caller opens a fresh player for the words that follow.
   */
  finishOnIdleClose?: boolean
}

interface ScheduledSegment extends SpeechSegment {
  /** Context time the segment's first audio chunk starts, once one is scheduled. */
  startTime: number | null
  /** Context time its latest scheduled chunk ends. */
  endTime: number | null
  /** The server has sent every chunk for this segment. */
  flushed: boolean
  /** This segment's own output gain, for leveling. Created with its first chunk. */
  gain: GainNode | null
  /** Sum of squares and count of the segment's voiced samples so far. */
  levelSumSq: number
  levelCount: number
  /** Linear gain the segment is playing at. */
  level: number
  /** Chunks kept back until the segment's level is known. */
  held: Float32Array[]
  heldSamples: number
}

/** Small lead before the first chunk so scheduling never lands in the past. */
const LEAD_S = 0.05
/** Slack after the last scheduled sample before declaring playback done. */
const DONE_GRACE_MS = 80
/** How often the watchdog looks at the synthesizer and the audio clock. */
const WATCHDOG_MS = 1_000
/**
 * A sentence handed to the synthesizer with nothing back (no audio, no
 * flush) for this long: the connection is dead, whatever the socket says.
 * Its first audio normally arrives well under a second.
 */
export const SYNTHESIS_STALL_MS = 10_000
/**
 * Audio scheduled ahead but the clock not moving for this long: the output
 * device went away (headphones off, a Bluetooth switch) and the browser did
 * not say so. A resume is tried first.
 */
export const CLOCK_STALL_MS = 4_000
/**
 * How far ahead of playback to keep audio scheduled. Segments are sent only
 * as this runs down (plus a couple in flight so the synthesizer's latency is
 * hidden), so a stop or a speed change early in a long reply wastes at most
 * this much synthesis rather than the whole message.
 */
const AHEAD_S = 10
const MAX_IN_FLIGHT = 2

/**
 * Leveling. The synthesizer lands each sentence at its own loudness (4–5 dB
 * between neighbours is normal, and the same sentence varies between
 * requests), which is heard as the volume jumping at sentence breaks. Each
 * segment is brought to the same RMS over its voiced samples. Measured as
 * chunks arrive: synthesis runs well ahead of playback, so a segment's gain
 * is nearly always settled before its first sample plays.
 */
const TARGET_RMS_DB = -23
/** Never boost or cut a segment by more than this. */
const LEVEL_MAX_DB = 6
/** A segment inherits the previous one's gain until this much of it is voiced. */
const LEVEL_MIN_VOICED_S = 0.2
/** Windows quieter than this are pauses, and do not count toward the level. */
const VOICED_FLOOR_DB = -45
const LEVEL_WINDOW_S = 0.02
/** Gain moves with a short ramp, so a refinement mid-segment is never a click. */
const LEVEL_RAMP_S = 0.05
/**
 * A segment's audio is kept back until its level is known, so its first
 * word plays at its own gain rather than the previous segment's. At most
 * this much is held: past it (a segment that opens with a long pause) the
 * audio goes out at the inherited gain and refines as it plays.
 */
const LEVEL_HOLD_MAX_S = 0.5

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
  private readonly finishOnIdleClose: boolean

  private ctx: AudioContext | null = null
  /** Output volume, so playback can be ducked while the person talks over it. */
  private gain: GainNode | null = null
  private volume = 1
  private readonly firstWordIndex: number
  private readonly segmenter: SpeechSegmenter
  private readonly segments: ScheduledSegment[] = []
  /** Index of the segment whose audio is currently arriving. */
  private receiving = 0
  /** Segments [0, sent) have been handed to the synthesizer. */
  private sent = 0
  /** The most recent segment's gain, which the next one starts at. */
  private lastLevel = 1
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private nextTime = 0
  /** A dangling byte from a chunk that split an int16 sample. */
  private carry: Uint8Array | null = null
  private ended = false
  private doneTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  /** When the synthesizer last sent anything, or was last asked. */
  private lastSynthesisAt = 0
  private lastClock = -1
  private clockStalledSince: number | null = null
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
    this.finishOnIdleClose = options.finishOnIdleClose ?? false
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

  /**
   * Whether audio is coming out right now: speaking, with samples scheduled
   * past the playhead. False in the silence between a message's sentences
   * when the synthesizer lags, and through a tool call — voice mode fills
   * those with the hold sound.
   */
  get isAudible(): boolean {
    return this._status === 'speaking' && this.bufferedAhead() > 0
  }

  /** Open the audio output and the synthesizer connection. Text may be appended immediately. */
  start(): void {
    const ctx = this.createAudioContext(this.adapter.sampleRate)
    this.ctx = ctx
    this.gain = ctx.createGain()
    this.gain.gain.value = this.volume
    this.gain.connect(ctx.destination)
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
    // Neither the socket nor the audio graph promises to report its death;
    // a player that waits on either forever is minutes of silent "speaking".
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_MS)
  }

  private watchdog(): void {
    if (this.isTerminal || this._status === 'paused') return
    const ctx = this.ctx
    const now = Date.now()
    if (ctx && this.bufferedAhead() > 0) {
      if (ctx.currentTime === this.lastClock) {
        this.clockStalledSince ??= now
        if (ctx.state === 'suspended') ctx.resume().catch(() => {})
        if (now - this.clockStalledSince >= CLOCK_STALL_MS) {
          this.fail(new Error('Audio output stalled'))
          return
        }
      } else {
        this.clockStalledSince = null
      }
      this.lastClock = ctx.currentTime
    } else {
      this.clockStalledSince = null
      if (ctx) this.lastClock = ctx.currentTime
    }
    if (this.sent > this.receiving && now - this.lastSynthesisAt >= SYNTHESIS_STALL_MS) {
      this.fail(new Error('Text-to-speech stalled: nothing came back for the last sentence'))
    }
  }

  /**
   * Whether words can still be queued. False once ended, including by an
   * idle close, while buffered audio may still be playing out: the caller
   * keeps further words for the next player rather than handing them here.
   */
  get acceptsWords(): boolean {
    return !this.isTerminal && !this.ended
  }

  /** Queue more words. Complete sentences are sent to the synthesizer right away. */
  append(words: readonly SpokenWord[]): void {
    if (!this.acceptsWords) return
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

  /**
   * Playback volume, 0..1, with a short ramp. Voice mode ducks the reply
   * as soon as the person starts talking over it, so their first words
   * are not fighting the speaker for the microphone.
   */
  setVolume(volume: number): void {
    this.volume = volume
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.04)
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
    // The pause is not the synthesizer's silence.
    this.lastSynthesisAt = Date.now()
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
      this.segments.push({ ...segment, startTime: null, endTime: null, flushed: false, gain: null, levelSumSq: 0, levelCount: 0, level: 1, held: [], heldSamples: 0 })
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
      this.lastSynthesisAt = Date.now()
    }
    if (this.sent < this.segments.length && this.sent - this.receiving < MAX_IN_FLIGHT) {
      const delayMs = Math.max(100, (this.bufferedAhead() - AHEAD_S) * 1000)
      this.pumpTimer = setTimeout(() => this.pump(), delayMs)
    }
  }

  private handleAudio(chunk: ArrayBuffer): void {
    const ctx = this.ctx
    if (!ctx || this.isTerminal) return
    this.lastSynthesisAt = Date.now()

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
    const segment = this.segments[this.receiving]
    if (!segment) {
      this.scheduleChunk(ctx, float32, this.gain ?? ctx.destination, null)
      return
    }
    this.measureLevel(ctx, segment, float32)
    if (segment.startTime === null && !this.levelKnown(segment)) {
      segment.held.push(float32)
      segment.heldSamples += float32.length
      if (segment.heldSamples < LEVEL_HOLD_MAX_S * this.adapter.sampleRate) return
      this.releaseHeld(ctx, segment)
      return
    }
    this.releaseHeld(ctx, segment)
    this.scheduleChunk(ctx, float32, segment.gain ?? this.gain ?? ctx.destination, segment)
  }

  private scheduleChunk(ctx: AudioContext, samples: Float32Array, output: AudioNode, segment: ScheduledSegment | null): void {
    const buffer = ctx.createBuffer(1, samples.length, this.adapter.sampleRate)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(output)

    const startAt = Math.max(this.nextTime, ctx.currentTime + LEAD_S)
    source.start(startAt)
    this.nextTime = startAt + buffer.duration

    if (segment) {
      if (segment.startTime === null) segment.startTime = startAt
      segment.endTime = this.nextTime
    }
    if (this._status === 'connecting') this.setStatus('speaking')
  }

  private levelKnown(segment: ScheduledSegment): boolean {
    return segment.levelCount >= LEVEL_MIN_VOICED_S * this.adapter.sampleRate
  }

  /** Play what the segment kept back, at the level it has now. */
  private releaseHeld(ctx: AudioContext, segment: ScheduledSegment): void {
    if (segment.held.length === 0) return
    const held = segment.held
    segment.held = []
    segment.heldSamples = 0
    for (const samples of held) this.scheduleChunk(ctx, samples, segment.gain ?? this.gain ?? ctx.destination, segment)
  }

  /**
   * Fold this chunk into the segment's level. The segment's gain starts
   * where the previous segment's was, and moves to its own once enough of
   * it has been heard: set outright while nothing of it is scheduled yet,
   * ramped once it is playing.
   */
  private measureLevel(ctx: AudioContext, segment: ScheduledSegment, samples: Float32Array): void {
    if (!segment.gain) {
      segment.level = this.lastLevel
      segment.gain = ctx.createGain()
      segment.gain.gain.value = segment.level
      segment.gain.connect(this.gain ?? ctx.destination)
    }
    const window = Math.max(1, Math.round(LEVEL_WINDOW_S * this.adapter.sampleRate))
    for (let start = 0; start + window <= samples.length; start += window) {
      let sumSq = 0
      for (let i = start; i < start + window; i++) sumSq += samples[i] * samples[i]
      if (10 * Math.log10(sumSq / window) > VOICED_FLOOR_DB) {
        segment.levelSumSq += sumSq
        segment.levelCount += window
      }
    }
    if (this.levelKnown(segment)) this.applyMeasuredLevel(ctx, segment)
  }

  private applyMeasuredLevel(ctx: AudioContext, segment: ScheduledSegment): void {
    if (!segment.gain || segment.levelCount === 0) return
    const rmsDb = 10 * Math.log10(segment.levelSumSq / segment.levelCount)
    const gainDb = Math.max(-LEVEL_MAX_DB, Math.min(LEVEL_MAX_DB, TARGET_RMS_DB - rmsDb))
    const level = 10 ** (gainDb / 20)
    this.lastLevel = level
    if (Math.abs(level - segment.level) <= 1e-3) return
    segment.level = level
    if (segment.startTime === null) segment.gain.gain.value = level
    else segment.gain.gain.setTargetAtTime(level, ctx.currentTime, LEVEL_RAMP_S)
  }

  private handleEvent(event: TtsEvent): void {
    if (this.isTerminal) return
    switch (event.type) {
      case 'flushed': {
        this.lastSynthesisAt = Date.now()
        const segment = this.segments[this.receiving]
        if (segment) {
          // A short segment may never reach the measuring threshold: level
          // it on what there is, and let it go.
          if (segment.held.length > 0 && this.ctx) {
            this.applyMeasuredLevel(this.ctx, segment)
            this.releaseHeld(this.ctx, segment)
          }
          segment.flushed = true
        }
        this.receiving++
        this.pump()
        this.maybeFinish()
        break
      }
      case 'closed':
        // The socket is closed on our side only once every segment is in;
        // any earlier close means the rest of the reply will never arrive.
        if (this.receiving < this.segments.length) {
          this.fail(new Error('Text-to-speech connection closed before the reply finished'))
        } else if (!this.ended) {
          if (!this.finishOnIdleClose) {
            this.fail(new Error('Text-to-speech connection closed before the reply finished'))
            break
          }
          // Idle close between segments of a streaming reply: nothing queued
          // is lost. Finish once what was scheduled has played.
          this.ended = true
          this.maybeFinish()
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
    // Pin the cursor while the clock is still there: the reader hands the
    // words past it to the next player.
    this.getWordCursor()
    this.cleanup()
    this.setStatus('error', error)
  }

  private cleanup(): void {
    if (this.doneTimer) {
      clearTimeout(this.doneTimer)
      this.doneTimer = null
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
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
