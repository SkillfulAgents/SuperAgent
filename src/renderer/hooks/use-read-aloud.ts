import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { createTtsAdapter, type SttProvider } from '@renderer/lib/tts'
import { SpeechPlayer } from '@renderer/lib/speech/speech-player'
import { markdownToSpokenWords } from '@renderer/lib/speech/spoken-words'

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
  provider: SttProvider
  token: string
  voice: string
  speed: number
}

const IDLE: ReadAloudSnapshot = { activeId: null, status: 'idle', error: null, errorId: null }

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
      const res = await apiFetch('/api/stt/tts-token')
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
    const current = this.current
    const player = this.player
    if (!current || !player) return
    const fromWord = Math.max(0, Math.floor(player.getWordCursor()))
    void this.speak(current.id, current.markdown, fromWord, { paused: player.status === 'paused' })
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

/**
 * Lights up the `[data-spoken-word]` spans inside `container` as playback
 * reaches them. Runs a frame loop only while `active`, and touches only the
 * spans whose state changed since the last frame.
 */
export function useSpokenWordHighlight(container: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = container.current
    if (!active || !root) return

    // Word indices are non-decreasing in document order (a word split by
    // inline markup repeats its index), so the lit prefix only ever grows or
    // shrinks at its end.
    const spans = Array.from(root.querySelectorAll<HTMLElement>('[data-spoken-word]'))
    const indexOf = (span: HTMLElement) => Number(span.dataset.spokenWord)
    let lit = 0 // spans[0..lit) carry data-spoken
    let frame = 0

    const tick = () => {
      const cursor = Math.floor(readAloud.getPlayer()?.getWordCursor() ?? -1)
      for (; lit < spans.length && indexOf(spans[lit]) <= cursor; lit++) spans[lit].dataset.spoken = ''
      for (; lit > 0 && indexOf(spans[lit - 1]) > cursor; lit--) delete spans[lit - 1].dataset.spoken
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      for (const span of spans) delete span.dataset.spoken
    }
  }, [container, active])
}
