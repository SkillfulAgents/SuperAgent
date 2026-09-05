import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { createTtsAdapter, type SttProvider } from '@renderer/lib/tts'
import { SpeechPlayer } from '@renderer/lib/speech/speech-player'
import { markdownToSpokenWords } from '@renderer/lib/speech/spoken-words'

export type ReadAloudStatus = 'idle' | 'connecting' | 'speaking'

export interface ReadAloudSnapshot {
  /** Id of the message being read (or about to be), or null when silent. */
  activeId: string | null
  status: ReadAloudStatus
  /** Last failure, cleared on the next play. */
  error: string | null
}

interface TtsCredentials {
  provider: SttProvider
  token: string
  voice: string
}

const IDLE: ReadAloudSnapshot = { activeId: null, status: 'idle', error: null }

/**
 * One reader for the whole app: playing a message stops whatever was playing
 * before. Lives outside React so the spoken-word cursor can be polled per
 * frame without going through state.
 */
class ReadAloudController {
  private snapshot: ReadAloudSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private player: SpeechPlayer | null = null
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

  async speak(id: string, markdown: string): Promise<void> {
    this.stop()
    const generation = ++this.generation
    this.update({ activeId: id, status: 'connecting', error: null })

    let credentials: TtsCredentials
    try {
      const res = await apiFetch('/api/stt/tts-token')
      const data: TtsCredentials | { error: string } = await res.json()
      if (!res.ok) throw new Error(('error' in data ? data.error : null) || 'Failed to get text-to-speech credentials')
      credentials = data as TtsCredentials
    } catch (err) {
      if (generation !== this.generation) return
      this.update({ ...IDLE, error: err instanceof Error ? err.message : 'Failed to start text-to-speech' })
      return
    }
    if (generation !== this.generation) return

    const player = new SpeechPlayer({
      adapter: createTtsAdapter(credentials.provider),
      token: credentials.token,
      voice: credentials.voice,
      onStatus: (status, error) => {
        if (this.player !== player) return
        if (status === 'speaking') this.update({ activeId: id, status: 'speaking', error: null })
        else if (status === 'done' || status === 'stopped') this.settle(player, null)
        else if (status === 'error') {
          console.error('Text-to-speech error:', error)
          this.settle(player, error?.message ?? 'Text-to-speech failed')
        }
      },
    })
    this.player = player
    player.start()
    player.append(markdownToSpokenWords(markdown))
    player.end()
  }

  stop(): void {
    this.generation++
    const player = this.player
    if (player) {
      this.player = null
      player.stop()
    }
    if (this.snapshot.activeId !== null) this.update({ ...IDLE, error: this.snapshot.error })
  }

  private settle(player: SpeechPlayer, error: string | null): void {
    if (this.player === player) this.player = null
    this.update({ ...IDLE, error })
  }

  private update(next: ReadAloudSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

export const readAloud = new ReadAloudController()

export function useReadAloudSnapshot(): ReadAloudSnapshot {
  return useSyncExternalStore(readAloud.subscribe, readAloud.getSnapshot, readAloud.getSnapshot)
}

/** Play/stop control for one message. */
export function useReadAloud(id: string, markdown: string) {
  const snapshot = useReadAloudSnapshot()
  const isActive = snapshot.activeId === id
  const status: ReadAloudStatus = isActive ? snapshot.status : 'idle'

  const toggle = useCallback(() => {
    if (isActive) readAloud.stop()
    else void readAloud.speak(id, markdown)
  }, [isActive, id, markdown])

  return { status, isActive, toggle, error: isActive ? snapshot.error : null }
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
