import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveSessionRegistry, LIVE_SESSION_MAX_MS } from './live-session-registry'
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Live session cleanup', () => {
  it('frees admission slots on failed hangup and retries without losing cleanup handles', async () => {
    const hangup = vi.fn(async (_id: string) => {}).mockRejectedValue(new Error('Unavailable'))
    const registry = new LiveSessionRegistry()
    for (let i = 0; i < 4; i++) {
      const { handle } = registry.add('alice', () => hangup(`session-${i}`))
      expect(await registry.release(handle, 'alice')).toBe('closing')
    }
    expect(registry.activeCount('alice')).toBe(0)
    hangup.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(hangup).toHaveBeenCalledTimes(8)
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(hangup).toHaveBeenCalledTimes(8)
  })

  it('keeps ownership, deduplicates concurrent releases, and bounds failed cleanup', async () => {
    const hangup = vi.fn(async () => { throw new Error('Unavailable') })
    const registry = new LiveSessionRegistry()
    const { handle } = registry.add('alice', () => hangup())
    expect(await registry.release(handle, 'bob')).toBe('missing')
    expect(hangup).not.toHaveBeenCalled()
    await Promise.all([registry.release(handle, 'alice'), registry.release(handle, 'alice')])
    expect(hangup).toHaveBeenCalledOnce()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(hangup).toHaveBeenCalledTimes(5)
    expect(await registry.release(handle, 'alice')).toBe('missing')
    warning.mockRestore()
  })
})
