export interface WaitForIdleOptions {
  /** Give up (resolving `'timeout'`) after this long. Default 10 minutes. */
  timeoutMs?: number
}

const POLL_MS = 250

/**
 * Resolve `'idle'` once `isActive` reads false (a result, a stop or a lost
 * connection ended the session, or it was not running), or `'timeout'` when
 * it still reads true past the timeout. Polled.
 */
export function waitForIdle(isActive: () => boolean, opts: WaitForIdleOptions = {}): Promise<'idle' | 'timeout'> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000
  return new Promise<'idle' | 'timeout'>((resolve) => {
    const startedAt = Date.now()
    const tick = () => {
      if (!isActive()) return resolve('idle')
      if (Date.now() - startedAt > timeoutMs) return resolve('timeout')
      setTimeout(tick, POLL_MS)
    }
    tick()
  })
}
