import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { startTabPolling, stopTabPolling } from './tab-poll'

describe('tab polling ownership', () => {
  const started: NodeJS.Timeout[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // Vacate the module-level slot so state can't leak between tests
    for (const handle of started.splice(0)) stopTabPolling(handle)
    vi.useRealTimers()
  })

  function start(poll: () => void, intervalMs?: number): NodeJS.Timeout {
    const handle = startTabPolling(poll, intervalMs)
    started.push(handle)
    return handle
  }

  it('polls at the given interval', () => {
    const poll = vi.fn()
    start(poll, 2000)

    vi.advanceTimersByTime(6000)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('a new connection replaces the previous timer instead of leaking it', () => {
    const pollA = vi.fn()
    const pollB = vi.fn()
    start(pollA, 2000)
    start(pollB, 2000)

    vi.advanceTimersByTime(4000)
    expect(pollA).not.toHaveBeenCalled()
    expect(pollB).toHaveBeenCalledTimes(2)
  })

  it("an old connection's late close does not stop the new viewer's polling", () => {
    const pollA = vi.fn()
    const pollB = vi.fn()
    const handleA = start(pollA, 2000)
    start(pollB, 2000)

    // Old socket's close event fires after the new viewer already connected
    stopTabPolling(handleA)

    vi.advanceTimersByTime(4000)
    expect(pollB).toHaveBeenCalledTimes(2)
  })

  it('stopping the current viewer stops polling and a later connection starts fresh', () => {
    const pollA = vi.fn()
    const handleA = start(pollA, 2000)
    stopTabPolling(handleA)

    vi.advanceTimersByTime(4000)
    expect(pollA).not.toHaveBeenCalled()

    const pollB = vi.fn()
    start(pollB, 2000)
    vi.advanceTimersByTime(2000)
    expect(pollB).toHaveBeenCalledTimes(1)
  })

  it('is safe to stop the same connection twice (error then close)', () => {
    const pollA = vi.fn()
    const handleA = start(pollA, 2000)
    stopTabPolling(handleA)
    stopTabPolling(handleA)

    const pollB = vi.fn()
    start(pollB, 2000)
    vi.advanceTimersByTime(2000)
    expect(pollB).toHaveBeenCalledTimes(1)
  })

  it('double-stop of an old handle does not vacate the new viewer', () => {
    const pollA = vi.fn()
    const pollB = vi.fn()
    const handleA = start(pollA, 2000)
    const handleB = start(pollB, 2000)

    // Old socket fires 'error' then 'close' after B connected
    stopTabPolling(handleA)
    stopTabPolling(handleA)

    vi.advanceTimersByTime(2000)
    expect(pollB).toHaveBeenCalledTimes(1)

    stopTabPolling(handleB)
    vi.advanceTimersByTime(4000)
    expect(pollB).toHaveBeenCalledTimes(1)
  })
})
