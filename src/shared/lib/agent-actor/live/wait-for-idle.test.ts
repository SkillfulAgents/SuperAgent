import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForIdle } from './wait-for-idle'

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
function track<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' }
  promise.then(
    (value) => {
      state.status = 'resolved'
      state.value = value
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
  it('resolves at the first poll that reads idle', async () => {
    const s = session(true)
    const result = track(waitForIdle(s.isActive))

    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(result.status).toBe('pending')

    s.set(false)
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(result.status).toBe('resolved')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers timeout when the session stays active', async () => {
    const s = session(true)
    const result = track(waitForIdle(s.isActive, { timeoutMs: 1_000 }))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(result.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(result.status).toBe('resolved')
    expect(result.value).toBe('timeout')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits ten minutes by default before timing out', async () => {
    const s = session(true)
    const result = track(waitForIdle(s.isActive))

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(result.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(result.value).toBe('timeout')
  })

  it('resolves at once for a session that is already idle', async () => {
    const s = session(false)

    await expect(waitForIdle(s.isActive)).resolves.toBe('idle')

    expect(s.reads()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
