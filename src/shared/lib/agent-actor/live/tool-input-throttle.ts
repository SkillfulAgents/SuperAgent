/**
 * Paces the frames that carry a tool call's input while it is being written.
 *
 * Each of those frames carries the whole input so far (redaction needs the
 * whole text, and a frame replaces the one before it: `supersedesKey` in
 * session-channel.ts), so one frame per provider delta costs bytes that grow
 * with the square of the input. Any frame but the last can be skipped: this
 * sends the first at once, then at most one per interval, and the caller
 * flushes what is held when the input ends, before the frame that says so.
 *
 * The interval is a request-local pacing timer, not background work: it lives
 * and dies with one tool call's input (docs/background-work.md, "Left where
 * they are").
 */

/** The shortest time between two frames of one tool call's input. */
export const TOOL_INPUT_FRAME_MIN_INTERVAL_MS = 100

/**
 * What one tool call's input may put on the wire, per millisecond, once it
 * is large: a frame of n characters is followed by at least n / this
 * milliseconds of quiet (64 KB a second). Below 6,400 characters the minimum
 * interval governs; a 50 KB input updates every ~0.8 s, a 200 KB one every
 * ~3 s. Without it a slowly streamed input stays quadratic at any fixed
 * interval: a model writes a few hundred bytes a second, so 50 KB takes
 * minutes, and a frame every 100 ms for minutes is as many frames as deltas.
 */
export const TOOL_INPUT_WIRE_CHARS_PER_MS = 64

/** How long after a frame of `length` characters the next one may go out. */
export function toolInputFrameInterval(length: number): number {
  return Math.max(TOOL_INPUT_FRAME_MIN_INTERVAL_MS, Math.ceil(length / TOOL_INPUT_WIRE_CHARS_PER_MS))
}

export class ToolInputThrottle {
  private lastSentAt: number | null = null
  private lastSentLength = 0
  private pending: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  /**
   * `mayFireLate`: asked when the timer fires, outside any frame of the
   * stream. False drops the held frame: the input's owner has ended in a way
   * that told nobody here.
   */
  constructor(private readonly mayFireLate: () => boolean = () => true) {}

  /**
   * The input grew to `length` characters. `send` emits the frame for the
   * input as it stands when called: now, or later in place of every frame
   * held since.
   */
  offer(length: number, send: () => void): void {
    const now = Date.now()
    const wait = this.lastSentAt === null ? 0 : this.lastSentAt + toolInputFrameInterval(this.lastSentLength) - now
    if (wait <= 0) {
      this.clearTimer()
      this.pending = null
      this.sent(now, length)
      send()
      return
    }
    this.pending = () => {
      this.sent(Date.now(), length)
      send()
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.mayFireLate()) this.flush()
      else this.pending = null
    }, wait)
  }

  /** The input ended: send the frame being held, if any. */
  flush(): void {
    this.clearTimer()
    const send = this.pending
    this.pending = null
    send?.()
  }

  /** The input is gone, or another starts: nothing held is sent, and the next frame goes at once. */
  reset(): void {
    this.clearTimer()
    this.pending = null
    this.lastSentAt = null
    this.lastSentLength = 0
  }

  private sent(at: number, length: number): void {
    this.lastSentAt = at
    this.lastSentLength = length
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
