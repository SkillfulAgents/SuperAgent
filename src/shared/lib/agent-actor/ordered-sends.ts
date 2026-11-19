/**
 * Sends that must reach the host in the order they were made, though each
 * first waits on a read of its own. The reads run at once, side by side; a
 * send goes out only once every earlier one has. A session's completion
 * notifications are the case: each waits for the transcript's end offset,
 * and a turn whose read finishes first must not be announced before the
 * turn that ended before it.
 */
export class OrderedSends {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  /** `drained` runs whenever the last send made so far has gone, so an owner can let go of it. */
  constructor(private readonly drained?: () => void) {}

  /** `send(await value)`, after every send made before this one. */
  after<T>(value: Promise<T>, send: (value: T) => void): void {
    this.pending += 1
    this.tail = this.tail
      .then(() => value)
      .then(send)
      .catch((error: unknown) => {
        // One failed send must not hold back the ones after it.
        console.error('[OrderedSends] A send failed:', error)
      })
      .finally(() => {
        this.pending -= 1
        if (this.pending === 0) this.drained?.()
      })
  }
}
