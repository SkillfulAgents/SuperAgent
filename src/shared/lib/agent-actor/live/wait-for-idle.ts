export interface WaitForIdleOptions {
  /** Give up (resolving `'timeout'`) after this long. Default 10 minutes. */
  timeoutMs?: number
  signal?: AbortSignal
  /** The session must be seen active first (default): one that never started is an error. */
  requireActiveFirst?: boolean
  /** How long to wait to see it active. Default 2 seconds. */
  observeMs?: number
}

const POLL_MS = 250

/**
 * Resolve `'idle'` once `isActive` reads false (a result, a stop or a lost
 * connection ended the session), or `'timeout'` when it still reads true
 * past the timeout. Polled, so a turn that starts and ends between two reads
 * still counts once it has been seen active.
 */
export function waitForIdle(isActive: () => boolean, opts: WaitForIdleOptions = {}): Promise<'idle' | 'timeout'> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000
  const requireActiveFirst = opts.requireActiveFirst ?? true
  const observeMs = opts.observeMs ?? 2000
  return new Promise<'idle' | 'timeout'>((resolve, reject) => {
    const startedAt = Date.now()
    let everActive = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new Error('waitForIdle aborted'))
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new Error('waitForIdle aborted'))
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    const tick = () => {
      const active = isActive()
      if (active) everActive = true
      if (!active) {
        if (!requireActiveFirst || everActive) {
          cleanup()
          resolve('idle')
          return
        }
        if (Date.now() - startedAt > observeMs) {
          cleanup()
          reject(new Error('waitForIdle: session never became active'))
          return
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        cleanup()
        resolve('timeout')
        return
      }
      timer = setTimeout(tick, POLL_MS)
    }
    tick()
  })
}
