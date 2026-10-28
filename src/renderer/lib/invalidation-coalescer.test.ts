import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { createInvalidationCoalescer } from './invalidation-coalescer'

function fakeClient() {
  const invalidateQueries = vi.fn().mockResolvedValue(undefined)
  return { client: { invalidateQueries } as unknown as QueryClient, invalidateQueries }
}

describe('createInvalidationCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs a burst once per key, after the delay from the first request', () => {
    const { client, invalidateQueries } = fakeClient()
    const batch = createInvalidationCoalescer(client, 500)

    batch.invalidate(['agents'])
    vi.advanceTimersByTime(300)
    batch.invalidate(['agents'])
    batch.invalidate(['todos'])
    expect(invalidateQueries).not.toHaveBeenCalled()

    // The window is anchored to the first request, so a steady stream still
    // confirms at least once per delay rather than waiting for a lull.
    vi.advanceTimersByTime(200)
    expect(invalidateQueries.mock.calls).toEqual([[{ queryKey: ['agents'] }], [{ queryKey: ['todos'] }]])
  })

  it('treats keys with the same contents as one', () => {
    const { client, invalidateQueries } = fakeClient()
    const batch = createInvalidationCoalescer(client, 500)

    batch.invalidate(['sessions', 'a'])
    batch.invalidate(['sessions', 'a'])
    batch.invalidate(['sessions', 'b'])
    vi.advanceTimersByTime(500)
    expect(invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['sessions', 'a'] }],
      [{ queryKey: ['sessions', 'b'] }],
    ])
  })

  it('starts a new window after a flush', () => {
    const { client, invalidateQueries } = fakeClient()
    const batch = createInvalidationCoalescer(client, 500)

    batch.invalidate(['agents'])
    vi.advanceTimersByTime(500)
    batch.invalidate(['agents'])
    vi.advanceTimersByTime(499)
    expect(invalidateQueries).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(invalidateQueries).toHaveBeenCalledTimes(2)
  })

  it('flush runs what is queued now and cancels the timer', () => {
    const { client, invalidateQueries } = fakeClient()
    const batch = createInvalidationCoalescer(client, 500)

    batch.invalidate(['agents'])
    batch.flush()
    expect(invalidateQueries).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(invalidateQueries).toHaveBeenCalledTimes(1)

    // Nothing queued: a flush is a no-op.
    batch.flush()
    expect(invalidateQueries).toHaveBeenCalledTimes(1)
  })
})
