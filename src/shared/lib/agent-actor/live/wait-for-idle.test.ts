import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForIdle, WaitForIdleTimeoutError } from './wait-for-idle'

const POLL_MS = 250

/** A session whose activity the test flips. */
function session(initiallyActive: boolean) {
  let active = initiallyActive
  let reads = 0
  return {
    isActive: () => {
      reads += 1
      return active
    },
    set: (next: boolean) => {
      active = next
    },
    reads: () => reads,
  }
}

/** Settles a promise into a readable state, so a test can check it without awaiting it. */
function track(promise: Promise<void>) {
  const state: { status: 'pending' | 'resolved' | 'rejected'; error?: unknown } = { status: 'pending' }
  promise.then(
    () => {
      state.status = 'resolved'
    },
    (error: unknown) => {
      state.status = 'rejected'
      state.error = error
    },
  )
  return state
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForIdle', () => {
  it('resolves at the first poll that reads idle after the session was seen active', async () => {
    const s = session(true)
    const result = track(waitForIdle(s.isActive))

    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(result.status).toBe('pending')

    s.set(false)
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(result.status).toBe('resolved')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still resolves when the session goes idle long after the observe window', async () => {
    const s = session(true)
    const result = track(waitForIdle(s.isActive, { observeMs: 500 }))

    await vi.advanceTimersByTimeAsync(5_000)
    s.set(false)
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(result.status).toBe('resolved')
  })

  it('waits through an idle start for a turn that begins after the wait did', async () => {
    const s = session(false)
    const result = track(waitForIdle(s.isActive))

    await vi.advanceTimersByTimeAsync(POLL_MS)
    s.set(true)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(result.status).toBe('pending')

    s.set(false)
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(result.status).toBe('resolved')
  })

  it('fails when the session is never seen active within the observe window', async () => {
    const s = session(false)
    const result = track(waitForIdle(s.isActive, { observeMs: 1_000 }))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(result.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(result.status).toBe('rejected')
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error).not.toBeInstanceOf(WaitForIdleTimeoutError)
    expect((result.error as Error).message).toBe('waitForIdle: session never became active')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives the session two seconds to show up by default', async () => {
    const s = session(false)
    const result = track(waitForIdle(s.isActive))

    await vi.advanceTimersByTimeAsync(2_000)
    expect(result.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(result.status).toBe('rejected')
  })

  it('accepts a session that shows up late in the observe window', async () => {
    const s = session(false)
    const result = track(waitForIdle(s.isActive, { observeMs: 1_000 }))

    await vi.advanceTimersByTimeAsync(750)
    s.set(true)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(result.status).toBe('pending')

    s.set(false)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(result.status).toBe('resolved')
  })

  it('times out with WaitForIdleTimeoutError when the session stays active', async () => {
    const s = session(true)
    const result = track(waitForIdle(s.isActive, { timeoutMs: 1_000 }))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(result.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(result.status).toBe('rejected')
    expect(result.error).toBeInstanceOf(WaitForIdleTimeoutError)
    expect((result.error as Error).name).toBe('WaitForIdleTimeoutError')
    expect((result.error as Error).message).toBe('waitForIdle timeout after 1000ms')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits ten minutes by default before timing out', async () => {
    const s = session(true)
    const result = track(waitForIdle(s.isActive))

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(result.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(result.error).toBeInstanceOf(WaitForIdleTimeoutError)
  })

  it('rejects at once, without polling, when the signal is already aborted', async () => {
    const s = session(true)
    const controller = new AbortController()
    controller.abort()

    await expect(waitForIdle(s.isActive, { signal: controller.signal })).rejects.toThrow('waitForIdle aborted')

    expect(s.reads()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects when aborted mid-wait, and stops polling', async () => {
    const s = session(true)
    const controller = new AbortController()
    const result = track(waitForIdle(s.isActive, { signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    const readsBeforeAbort = s.reads()

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(result.status).toBe('rejected')
    expect((result.error as Error).message).toBe('waitForIdle aborted')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(s.reads()).toBe(readsBeforeAbort)
  })

  it('ignores an abort after it has resolved', async () => {
    const s = session(true)
    const controller = new AbortController()
    const result = track(waitForIdle(s.isActive, { signal: controller.signal }))
    s.set(false)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(result.status).toBe('resolved')

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(result.status).toBe('resolved')
  })

  describe('with requireActiveFirst: false', () => {
    it('resolves at once for a session that is already idle', async () => {
      const s = session(false)

      await expect(waitForIdle(s.isActive, { requireActiveFirst: false })).resolves.toBeUndefined()

      expect(s.reads()).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('waits for an active session to go idle', async () => {
      const s = session(true)
      const result = track(waitForIdle(s.isActive, { requireActiveFirst: false }))

      await vi.advanceTimersByTimeAsync(POLL_MS * 2)
      expect(result.status).toBe('pending')

      s.set(false)
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(result.status).toBe('resolved')
    })
  })
})
