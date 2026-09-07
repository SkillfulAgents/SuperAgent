import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { createTtsAdapter, type VoiceProvider } from '@renderer/lib/tts'
import { SpeechPlayer } from '@renderer/lib/speech/speech-player'
import { markdownToSpokenWords, type SpokenWord } from '@renderer/lib/speech/spoken-words'
import { stableMarkdownPrefix } from '@renderer/lib/speech/stable-markdown'

export type ReadAloudStatus = 'idle' | 'connecting' | 'speaking' | 'paused'

export interface ReadAloudSnapshot {
  /** Id of the message being read (or about to be), or null when silent. */
  activeId: string | null
  status: ReadAloudStatus
  /** Last failure, shown under the message it happened on until the next play. */
  error: string | null
  /** The message `error` belongs to. */
  errorId: string | null
}

interface TtsCredentials {
  provider: VoiceProvider
  token: string
  voice: string
  speed: number
}

const IDLE: ReadAloudSnapshot = { activeId: null, status: 'idle', error: null, errorId: null }

/** Credentials are reused across the players of one streaming read for this long. */
const CREDENTIALS_MAX_AGE_MS = 4 * 60_000
/** A streaming read gives up after this many players fail in a row. */
const MAX_STREAM_FAILURES = 2

/**
 * A reply being read as it streams in. One logical read that may span
 * several players: the synthesizer closes an idle connection during a long
 * tool call, and the next words open a fresh one.
 */
interface StreamReading {
  id: string
  /** Markdown of the current assistant message so far. */
  fed: string
  /** How many of its spoken words have been taken (queued or appended). */
  appended: number
  /** Settled words waiting for a player to open. */
  pending: SpokenWord[]
  /** Every word handed to the open player, in order, so a restart can re-queue the unspoken tail. */
  playerWords: SpokenWord[]
  /** No more text is coming; finish once the last audio drains. */
  ended: boolean
  /** A player is being opened (credentials in flight). */
  opening: boolean
  failures: number
  /** Playback is turned down while the person talks over it. */
  ducked: boolean
  /**
   * Where the current message's first word sits in the open player's word
   * list, once appended — the highlight addresses words per message, the
   * player counts per connection.
   */
  segmentStart: { player: SpeechPlayer; index: number } | null
  /** Words of the current message already spoken by players since closed. */
  segmentSpokenBefore: number
  /** Index in `pending` where the current message's words begin, until they are appended. */
  pendingSegmentStart: number | null
}

/** The reader id voice mode reads a session's replies under. */
export function voiceStreamId(sessionId: string): string {
  return `voice:${sessionId}`
}

/** Playback volume while the person is talking over the reply. */
const DUCKED_VOLUME = 0.15

/**
 * Audio output must be unlocked inside the user's gesture on autoplay-blocked
 * browsers (iOS Safari), and speak() is what the click handler calls — so the
 * context is created here, before the token round-trip, not in the player.
 */
function createUnlockedAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  const ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

/**
 * One reader for the whole app: playing a message stops whatever was playing
 * before. Lives outside React so the spoken-word cursor can be polled per
 * frame without going through state.
 */
class ReadAloudController {
  private snapshot: ReadAloudSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private player: SpeechPlayer | null = null
  /** What is playing, so a restart (speed change) can pick it back up. */
  private current: { id: string; markdown: string } | null = null
  private stream: StreamReading | null = null
  private credentials: { value: TtsCredentials; fetchedAt: number } | null = null
  // Bumped whenever the cache is dropped, so a fetch that was already in
  // flight does not write the credentials it got (for the old speed) back.
  private credentialsGeneration = 0
  /** An audio context created inside a user gesture, for the next player to adopt. */
  private unlockedContext: AudioContext | null = null
  // Bumped by every speak()/stop() so a token round-trip that resolves after
  // the user moved on doesn't start a stale player.
  private generation = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ReadAloudSnapshot => this.snapshot

  /** The live player, for per-frame cursor reads. Null when silent. */
  getPlayer(): SpeechPlayer | null {
    return this.player
  }

  /** Whether the reader is putting out sound right now (not merely connected or waiting on the synthesizer). */
  isAudible(): boolean {
    return this.player?.isAudible ?? false
  }

  /**
   * Read `markdown` aloud as message `id`, from word `fromWord` (a restart
   * mid-reply keeps the words before it lit).
   */
  async speak(id: string, markdown: string, fromWord = 0, options: { paused?: boolean } = {}): Promise<void> {
    this.stop()
    const generation = ++this.generation
    this.current = { id, markdown }
    this.update({ activeId: id, status: 'connecting', error: null, errorId: null })
    const ctx = createUnlockedAudioContext()

    let credentials: TtsCredentials
    try {
      const res = await apiFetch('/api/voice/tts-token')
      const data: TtsCredentials | { error: string } = await res.json()
      if (!res.ok) throw new Error(('error' in data ? data.error : null) || 'Failed to get text-to-speech credentials')
      credentials = data as TtsCredentials
    } catch (err) {
      if (generation !== this.generation) {
        void ctx?.close()
        return
      }
      this.current = null
      void ctx?.close()
      this.update({ ...IDLE, error: err instanceof Error ? err.message : 'Failed to start text-to-speech', errorId: id })
      return
    }
    if (generation !== this.generation) {
      void ctx?.close()
      return
    }

    let startPaused = options.paused ?? false
    const player = new SpeechPlayer({
      adapter: createTtsAdapter(credentials.provider),
      token: credentials.token,
      voice: { voice: credentials.voice, speed: credentials.speed },
      firstWordIndex: fromWord,
      ...(ctx ? { createAudioContext: () => ctx } : {}),
      onStatus: (status, error) => {
        if (this.player !== player) return
        if (status === 'speaking' && startPaused) {
          // A speed change while paused stays paused: hold at the first chunk.
          startPaused = false
          player.pause()
          return
        }
        if (status === 'speaking' || status === 'paused') this.update({ activeId: id, status, error: null, errorId: null })
        else if (status === 'done' || status === 'stopped') this.settle(player, id, null)
        else if (status === 'error') {
          console.error('Text-to-speech error:', error)
          this.settle(player, id, error?.message ?? 'Text-to-speech failed')
        }
      },
    })
    this.player = player
    player.start()
    player.append(markdownToSpokenWords(markdown).slice(fromWord))
    player.end()
  }

  stop(): void {
    this.generation++
    this.current = null
    this.stream = null
    const player = this.player
    if (player) {
      this.player = null
      player.stop()
    }
    if (this.snapshot.activeId !== null) {
      this.update({ ...IDLE, error: this.snapshot.error, errorId: this.snapshot.errorId })
    }
  }

  pause(): void {
    this.player?.pause()
  }

  resume(): void {
    this.player?.resume()
  }

  /**
   * Carry the current message on from the word being spoken, with fresh
   * credentials — the way a changed voice or speed takes effect, since both
   * are fixed for the life of a synthesizer connection. Nothing to do once
   * playback has ended.
   */
  restart(): void {
    // Always, even with nothing playing: the cache carries the speed and
    // voice, and between replies it is all a change has to reach.
    this.dropCredentials()
    if (this.stream) {
      this.restartStream()
      return
    }
    const current = this.current
    const player = this.player
    if (!current || !player) return
    const fromWord = Math.max(0, Math.floor(player.getWordCursor()))
    void this.speak(current.id, current.markdown, fromWord, { paused: player.status === 'paused' })
  }

  /**
   * The streaming case: close the open player and hand every word it had
   * not yet spoken, plus what was waiting, to a fresh one on fresh
   * credentials. The word being spoken is said again; the words before it
   * stay counted for the highlight, as after an idle close.
   */
  private restartStream(): void {
    const stream = this.stream
    if (!stream) return
    const player = this.player
    if (!player) return // nothing open: the next player fetches fresh credentials anyway
    this.requeueUnspoken(stream, player)
    stream.failures = 0
    this.player = null
    player.stop()
    this.update({ activeId: stream.id, status: 'connecting', error: null, errorId: null })
    if (stream.pending.length > 0) this.flushStreamWords()
    else if (stream.ended) this.settleStream(null)
  }

  /**
   * Move every word `player` was given but has not spoken back to the front
   * of the queue, for the next player. The word being spoken is said again;
   * the words before it stay counted for the highlight.
   */
  private requeueUnspoken(stream: StreamReading, player: SpeechPlayer): void {
    const from = Math.max(0, Math.floor(player.getWordCursor()))
    const remaining = stream.playerWords.slice(from)
    if (stream.segmentStart?.player === player) {
      stream.segmentSpokenBefore += Math.max(0, from - stream.segmentStart.index)
      stream.pendingSegmentStart = Math.max(0, stream.segmentStart.index - from)
      stream.segmentStart = null
    } else if (stream.pendingSegmentStart !== null) {
      stream.pendingSegmentStart += remaining.length
    }
    if (stream.segmentStart === null && stream.pendingSegmentStart === null) stream.pendingSegmentStart = 0
    stream.pending = [...remaining, ...stream.pending]
    stream.playerWords = []
  }

  /**
   * Create the audio output now, inside the user's gesture, for the next
   * streaming read to adopt: on autoplay-blocked browsers a context made
   * later (when the reply arrives, with no gesture in sight) stays silent.
   */
  unlockAudio(): void {
    if (this.unlockedContext && this.unlockedContext.state !== 'closed') return
    this.unlockedContext = createUnlockedAudioContext()
  }

  /**
   * Start reading a reply that is still streaming in, as `id`. Feed it with
   * pushStream() as the text grows, nextStreamSegment() when one assistant
   * message ends and another begins, and endStream() when the turn is over.
   */
  beginStream(id: string): void {
    this.stop()
    this.stream = {
      id,
      fed: '',
      appended: 0,
      pending: [],
      playerWords: [],
      ended: false,
      opening: false,
      failures: 0,
      ducked: false,
      segmentStart: null,
      segmentSpokenBefore: 0,
      pendingSegmentStart: 0,
    }
    this.update({ activeId: id, status: 'connecting', error: null, errorId: null })
  }

  /** The current assistant message's Markdown so far (the whole text, not a delta). */
  pushStream(id: string, markdown: string): void {
    const stream = this.stream
    if (!stream || stream.id !== id || stream.ended) return
    stream.fed = markdown
    this.drainStream(false)
  }

  /** The current assistant message is complete; the next push starts a new one. */
  nextStreamSegment(id: string): void {
    const stream = this.stream
    if (!stream || stream.id !== id || stream.ended) return
    this.drainStream(true)
    stream.fed = ''
    stream.appended = 0
    stream.pendingSegmentStart = stream.pending.length
    stream.segmentSpokenBefore = 0
    stream.segmentStart = null
  }

  /**
   * The word of the current message being spoken, as a fractional index
   * into that message's spoken words (-1 before any), for the highlight.
   */
  getStreamWordCursor(): number {
    const stream = this.stream
    const player = this.player
    if (!stream) return -1
    if (!player || !stream.segmentStart || stream.segmentStart.player !== player) return stream.segmentSpokenBefore - 1
    return stream.segmentSpokenBefore + player.getWordCursor() - stream.segmentStart.index
  }

  /**
   * Turn the streaming read down (the person started talking over it) or
   * back up (they stopped short of an interruption). Applies to the player
   * that is open and to any opened after.
   */
  duckStream(id: string, ducked: boolean): void {
    const stream = this.stream
    if (!stream || stream.id !== id) return
    stream.ducked = ducked
    this.player?.setVolume(ducked ? DUCKED_VOLUME : 1)
  }

  /** The turn is over: say what is left, then finish. */
  endStream(id: string): void {
    const stream = this.stream
    if (!stream || stream.id !== id || stream.ended) return
    this.drainStream(true)
    stream.ended = true
    if (this.player) this.player.end()
    else if (!stream.opening) this.settleStream(null)
  }

  /**
   * Take every settled word not yet taken from the current message and hand
   * it to the player — or queue it for the player being opened.
   */
  private drainStream(final: boolean): void {
    const stream = this.stream
    if (!stream) return
    const stable = final ? stream.fed : stableMarkdownPrefix(stream.fed)
    const words = markdownToSpokenWords(stable)
    if (words.length > stream.appended) {
      stream.pending.push(...words.slice(stream.appended))
      stream.appended = words.length
    }
    this.flushStreamWords()
  }

  /** Append the queued words to the player, opening one if there is none. */
  private flushStreamWords(): void {
    const stream = this.stream
    if (!stream || stream.pending.length === 0) return
    if (!this.player) {
      void this.openStreamPlayer()
      return
    }
    // Idle-closed by the synthesizer but still playing out what it has: the
    // words wait, and its 'done' opens the next player for them.
    if (!this.player.acceptsWords) return
    if (stream.pendingSegmentStart !== null) {
      stream.segmentStart = { player: this.player, index: this.player.totalWords + stream.pendingSegmentStart }
      stream.pendingSegmentStart = null
    }
    const words = stream.pending
    stream.pending = []
    stream.playerWords.push(...words)
    this.player.append(words)
  }

  private async openStreamPlayer(): Promise<void> {
    const stream = this.stream
    if (!stream || stream.opening || this.player) return
    stream.opening = true
    const generation = this.generation
    const ctx = this.unlockedContext && this.unlockedContext.state !== 'closed' ? this.unlockedContext : createUnlockedAudioContext()
    this.unlockedContext = null

    let credentials: TtsCredentials
    try {
      credentials = await this.getCredentials()
    } catch (err) {
      void ctx?.close()
      if (generation !== this.generation || this.stream !== stream) return
      stream.opening = false
      this.settleStream(err instanceof Error ? err.message : 'Failed to start text-to-speech')
      return
    }
    if (generation !== this.generation || this.stream !== stream) {
      void ctx?.close()
      return
    }

    const player = new SpeechPlayer({
      adapter: createTtsAdapter(credentials.provider),
      token: credentials.token,
      voice: { voice: credentials.voice, speed: credentials.speed },
      finishOnIdleClose: true,
      ...(ctx ? { createAudioContext: () => ctx } : {}),
      onStatus: (status, error) => {
        if (this.player !== player || this.stream !== stream) return
        if (status === 'speaking' || status === 'paused') {
          // Failures are counted in a row: a player that got as far as
          // speaking is a success, whatever happened before it.
          stream.failures = 0
          this.update({ activeId: stream.id, status, error: null, errorId: null })
          return
        }
        if (status === 'error') {
          console.error('Text-to-speech error:', error)
          stream.failures++
          if (stream.failures >= MAX_STREAM_FAILURES) {
            this.settleStream(error?.message ?? 'Text-to-speech failed')
            return
          }
          // A failure mid-reply: whatever this player had not said yet goes
          // to the next one, on fresh credentials, rather than being lost.
          this.dropCredentials()
          this.requeueUnspoken(stream, player)
          this.player = null
          this.update({ activeId: stream.id, status: 'connecting', error: null, errorId: null })
          if (stream.pending.length > 0) this.flushStreamWords()
          else if (stream.ended) this.settleStream(null)
          return
        }
        if (stream.ended && stream.pending.length === 0) {
          // 'done' / 'stopped' with nothing more to come.
          this.settleStream(null)
          return
        }
        // This player is finished (an idle close) but the reply is not, or
        // words arrived while it was playing out: the next words open a
        // fresh one, and the message's words this one said stay counted
        // for the highlight.
        if (stream.segmentStart?.player === player) {
          stream.segmentSpokenBefore += player.totalWords - stream.segmentStart.index
          stream.segmentStart = null
          stream.pendingSegmentStart = 0
        } else if (stream.segmentStart === null && stream.pendingSegmentStart === null) {
          stream.pendingSegmentStart = 0
        }
        this.player = null
        stream.playerWords = []
        this.update({ activeId: stream.id, status: 'connecting', error: null, errorId: null })
        stream.failures = 0
        this.flushStreamWords()
      },
    })
    stream.opening = false
    this.player = player
    if (stream.ducked) player.setVolume(DUCKED_VOLUME)
    player.start()
    this.flushStreamWords()
    if (stream.ended) player.end()
  }

  private dropCredentials(): void {
    this.credentials = null
    this.credentialsGeneration++
  }

  private async getCredentials(): Promise<TtsCredentials> {
    const cached = this.credentials
    if (cached && Date.now() - cached.fetchedAt < CREDENTIALS_MAX_AGE_MS) return cached.value
    const generation = this.credentialsGeneration
    const res = await apiFetch('/api/voice/tts-token')
    const data: TtsCredentials | { error: string } = await res.json()
    if (!res.ok) throw new Error(('error' in data ? data.error : null) || 'Failed to get text-to-speech credentials')
    // Dropped while this was in flight (a speed change): these are stale.
    if (generation === this.credentialsGeneration) this.credentials = { value: data as TtsCredentials, fetchedAt: Date.now() }
    return data as TtsCredentials
  }

  private settleStream(error: string | null): void {
    const stream = this.stream
    if (!stream) return
    this.stream = null
    const player = this.player
    this.player = null
    player?.stop()
    this.update({ ...IDLE, error, errorId: error ? stream.id : null })
  }

  private settle(player: SpeechPlayer, id: string, error: string | null): void {
    if (this.player !== player) return
    this.player = null
    this.current = null
    this.update({ ...IDLE, error, errorId: error ? id : null })
  }

  private update(next: ReadAloudSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

export const readAloud = new ReadAloudController()

/**
 * Whether `id` is the message being read. Selects a boolean so the many
 * subscribed message rows re-render only when their own answer changes,
 * not on every store update.
 */
export function useIsBeingRead(id: string): boolean {
  const isActive = useCallback(() => readAloud.getSnapshot().activeId === id, [id])
  return useSyncExternalStore(readAloud.subscribe, isActive, isActive)
}

/** Whether voice mode is reading `sessionId`'s replies right now. */
export function useIsVoiceReading(sessionId: string | undefined): boolean {
  const select = useCallback(() => sessionId !== undefined && readAloud.getSnapshot().activeId === voiceStreamId(sessionId), [sessionId])
  return useSyncExternalStore(readAloud.subscribe, select, select)
}

/** Play/stop control for one message. */
export function useReadAloud(id: string, markdown: string) {
  const isActive = useIsBeingRead(id)
  // Only the active message's control follows the full snapshot; idle ones
  // share the stable IDLE object and never re-render on store updates.
  const select = useCallback(() => (isActive ? readAloud.getSnapshot() : IDLE), [isActive])
  const snapshot = useSyncExternalStore(readAloud.subscribe, select, select)
  const status: ReadAloudStatus = isActive ? snapshot.status : 'idle'
  // A failure leaves the message idle, so its error is selected on its own.
  const selectError = useCallback(() => {
    const s = readAloud.getSnapshot()
    return s.errorId === id ? s.error : null
  }, [id])
  const error = useSyncExternalStore(readAloud.subscribe, selectError, selectError)

  const toggle = useCallback(() => {
    if (isActive) readAloud.stop()
    else void readAloud.speak(id, markdown)
  }, [isActive, id, markdown])
  const pause = useCallback(() => readAloud.pause(), [])
  const resume = useCallback(() => readAloud.resume(), [])

  return { status, isActive, toggle, pause, resume, error }
}

interface SpokenWordHighlightOptions {
  /** Where playback is, as a word index; defaults to the read-aloud player's cursor. */
  getCursor?: () => number
  /** The prose is still changing (a streaming reply): spans are re-collected as it does. */
  live?: boolean
}

function playerCursor(): number {
  return readAloud.getPlayer()?.getWordCursor() ?? -1
}

/**
 * Lights up the `[data-spoken-word]` spans inside `container` as playback
 * reaches them. Runs a frame loop only while `active`, and touches only the
 * spans whose state changed since the last frame.
 */
export function useSpokenWordHighlight(
  container: RefObject<HTMLElement | null>,
  active: boolean,
  { getCursor = playerCursor, live = false }: SpokenWordHighlightOptions = {},
): void {
  useEffect(() => {
    const root = container.current
    if (!active || !root) return

    // Word indices are non-decreasing in document order (a word split by
    // inline markup repeats its index), so the lit prefix only ever grows or
    // shrinks at its end.
    let spans: HTMLElement[] = []
    const indexOf = (span: HTMLElement) => Number(span.dataset.spokenWord)
    let lit = 0 // spans[0..lit) carry data-spoken
    let frame = 0
    const collect = () => {
      for (const span of spans) delete span.dataset.spoken
      spans = Array.from(root.querySelectorAll<HTMLElement>('[data-spoken-word]'))
      lit = 0
    }
    collect()
    // A streaming reply re-renders its tail on every delta: start over from
    // the new spans (attribute writes below are not childList mutations, so
    // this never observes itself).
    const observer = live && typeof MutationObserver !== 'undefined' ? new MutationObserver(collect) : null
    observer?.observe(root, { childList: true, subtree: true })

    const tick = () => {
      const cursor = Math.floor(getCursor())
      for (; lit < spans.length && indexOf(spans[lit]) <= cursor; lit++) spans[lit].dataset.spoken = ''
      for (; lit > 0 && indexOf(spans[lit - 1]) > cursor; lit--) delete spans[lit - 1].dataset.spoken
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      for (const span of spans) delete span.dataset.spoken
    }
  }, [container, active, getCursor, live])
}
