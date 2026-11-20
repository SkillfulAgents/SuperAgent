import { useSyncExternalStore } from 'react'

/**
 * Whether the notifications stream is delivering right now, for the queries it
 * keeps current: while it is, their fallback poll only has to catch an event
 * that was never sent, so it can be slow; while it is not, the poll is all
 * they have and runs at its own rate.
 *
 * Delivering means the server said `connected` (it follows every channel, and
 * the handler has just read everything again) and a frame arrived lately. The
 * server pings an idle stream every 30 s, so a stream that stays silent past
 * `STREAM_SILENT_AFTER_MS` has stalled without an error (a sleeping laptop, a
 * proxy holding the response). Any later frame proves it again: one response
 * is read in order, and a server that had to drop frames ends the stream.
 */
export const STREAM_SILENT_AFTER_MS = 75_000
const SILENCE_CHECK_MS = 15_000

/** The fallback poll of a query whose every change the stream announces, while the stream delivers. */
export const STREAM_BACKED_POLL_MS = 5 * 60_000

let connected = false
let lastFrameAt = 0
let delivering = false
let silenceCheck: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function settle(): void {
  const next = connected && Date.now() - lastFrameAt <= STREAM_SILENT_AFTER_MS
  if (connected && !silenceCheck) silenceCheck = setInterval(settle, SILENCE_CHECK_MS)
  if (!connected && silenceCheck) {
    clearInterval(silenceCheck)
    silenceCheck = null
  }
  if (next === delivering) return
  delivering = next
  for (const listener of [...listeners]) listener()
}

/** A frame arrived. `connected` is the server's greeting, sent once it follows every channel. */
export function noteNotificationStreamFrame(type: unknown): void {
  if (type === 'connected') connected = true
  if (!connected) return
  lastFrameAt = Date.now()
  settle()
}

/** The stream errored or was closed: nothing is delivered until the next `connected`. */
export function noteNotificationStreamDown(): void {
  connected = false
  settle()
}

export function isNotificationStreamDelivering(): boolean {
  return delivering
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The interval for a fallback poll: `pollMs` as it always was, or the slow
 * `STREAM_BACKED_POLL_MS` while the notifications stream delivers. Only for a
 * query whose every change the stream announces: for any other, the poll is
 * what finds the change, and stays as it is.
 */
export function useStreamBackedPollMs(pollMs: number): number {
  const streamDelivers = useSyncExternalStore(subscribe, isNotificationStreamDelivering, () => false)
  return streamDelivers ? Math.max(pollMs, STREAM_BACKED_POLL_MS) : pollMs
}
