export const STREAM_RECONNECT_MS = 1_000
export const STREAM_RECONNECT_MAX_MS = 30_000

// Wait before the n-th reopen (n starts at 0): 1s, 2s, 4s ... capped at 30s.
// A down backend gets a bounded trickle instead of a request per second.
export function reconnectDelayMs(attempt: number): number {
  return Math.min(STREAM_RECONNECT_MS * 2 ** attempt, STREAM_RECONNECT_MAX_MS)
}
