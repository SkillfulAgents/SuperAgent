import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react'
import { readAloud, voiceStreamId, READ_ALOUD_IDLE as IDLE, type ReadAloudStatus } from '@renderer/lib/voice/shared/read-aloud'

export function useIsReadAloudAvailable(): boolean {
  return useSyncExternalStore(readAloud.subscribe, readAloud.isAvailable, readAloud.isAvailable)
}

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
