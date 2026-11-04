import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalJobManager } from './local-job-manager'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('LocalJobManager', () => {
  let manager: LocalJobManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new LocalJobManager()
  })

  afterEach(() => {
    for (const { id } of manager.list()) manager.unregister(id)
    vi.useRealTimers()
  })

  it('runs a job first after its start delay, then on every interval', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    manager.register({ id: 'sync', intervalMs: 60_000, startDelayMs: 10_000, run })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('ignores a second job with the same id', async () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)

    expect(manager.register({ id: 'sync', intervalMs: 60_000, run: first })).toBe(true)
    expect(manager.register({ id: 'sync', intervalMs: 1_000, run: second })).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).not.toHaveBeenCalled()
  })

  it('skips a run that comes due while the previous one is still going', async () => {
    const gate = deferred()
    const run = vi.fn(() => gate.promise)
    manager.register({ id: 'slow', intervalMs: 1_000, run })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(manager.list()[0]).toMatchObject({ id: 'slow', running: true })

    gate.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps running a job after a pass fails', async () => {
    const sync = vi.fn().mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(undefined)
    const report = vi.fn()
    manager.register({ id: 'flaky', intervalMs: 1_000, run: () => sync().catch(report) })

    await vi.advanceTimersByTimeAsync(1_000)

    expect(report).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('stops a job once unregistered, before or after its first run', async () => {
    const early = vi.fn().mockResolvedValue(undefined)
    const late = vi.fn().mockResolvedValue(undefined)
    manager.register({ id: 'early', intervalMs: 1_000, startDelayMs: 5_000, run: early })
    manager.register({ id: 'late', intervalMs: 1_000, run: late })
    await vi.advanceTimersByTimeAsync(0)

    manager.unregister('early')
    manager.unregister('late')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(early).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
