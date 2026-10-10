import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFatalShutdown, FATAL_SHUTDOWN_TIMEOUT_MS } from './fatal-shutdown'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

function setup() {
  const deps = {
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => true),
    exit: vi.fn(),
    logError: vi.fn(),
  }
  return { ...deps, start: createFatalShutdown(deps) }
}

describe('fatal shutdown', () => {
  it('flushes reports, drains, and exits with failure status without waiting for the deadline', async () => {
    const t = setup()
    t.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.flush.mock.invocationCallOrder[0]).toBeLessThan(t.shutdown.mock.invocationCallOrder[0])
    expect(t.shutdown.mock.invocationCallOrder[0]).toBeLessThan(t.exit.mock.invocationCallOrder[0])
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(1)
    await vi.advanceTimersByTimeAsync(FATAL_SHUTDOWN_TIMEOUT_MS)
    expect(t.exit).toHaveBeenCalledOnce()
  })

  it('logs a refused drain and exits at the fatal deadline instead of running indefinitely', async () => {
    const t = setup()
    t.shutdown.mockResolvedValue(false)
    t.start()
    await vi.advanceTimersByTimeAsync(FATAL_SHUTDOWN_TIMEOUT_MS - 1)
    expect(t.logError).toHaveBeenCalledWith(expect.stringContaining('Safe shutdown was declined'))
    expect(t.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(t.logError).toHaveBeenCalledWith(expect.stringContaining('unsynced files'))
  })

  it.each(['flush', 'shutdown'] as const)('bounds a hung %s and ignores its late completion', async stage => {
    const t = setup()
    let release!: () => void
    if (stage === 'flush') t.flush.mockImplementation(() => new Promise(resolve => { release = resolve }))
    else t.shutdown.mockImplementation(() => new Promise(resolve => { release = () => resolve(true) }))
    t.start()
    await vi.advanceTimersByTimeAsync(FATAL_SHUTDOWN_TIMEOUT_MS)
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.exit).toHaveBeenCalledOnce()
    if (stage === 'flush') expect(t.shutdown).not.toHaveBeenCalled()
  })

  it('keeps the deadline when reporting and shutdown both fail', async () => {
    const t = setup()
    t.flush.mockRejectedValue(new Error('report unavailable'))
    t.shutdown.mockRejectedValue(new Error('cleanup failed'))
    t.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.shutdown).toHaveBeenCalledOnce()
    expect(t.logError).toHaveBeenCalledWith(expect.stringContaining('Fatal shutdown failed'), expect.any(Error))
    await vi.advanceTimersByTimeAsync(FATAL_SHUTDOWN_TIMEOUT_MS)
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('does not start competing shutdown attempts or postpone the deadline on another fatal error', async () => {
    const t = setup()
    t.shutdown.mockResolvedValue(false)
    t.start()
    await vi.advanceTimersByTimeAsync(FATAL_SHUTDOWN_TIMEOUT_MS / 2)
    t.start()
    await vi.advanceTimersByTimeAsync(FATAL_SHUTDOWN_TIMEOUT_MS / 2)
    expect(t.flush).toHaveBeenCalledOnce()
    expect(t.shutdown).toHaveBeenCalledOnce()
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})
