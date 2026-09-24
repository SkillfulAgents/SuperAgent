import { afterEach, describe, expect, it, vi } from 'vitest'
import { readConnectionUsage } from './connection-usage'
import { usageSnapshot } from './usage-schema'
const read = vi.hoisted(() => vi.fn())
vi.mock('./connections', () => ({ providerForConnection: () => ({ getUsage: read }) }))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); read.mockReset() })
const row = { provider: 'codex-subscription', config: '{}', generation: 1 }
describe('subscription usage cache', () => {
  it('coalesces simultaneous reads, caches for a minute and invalidates rotated credentials', async () => {
    vi.useFakeTimers()
    let finish!: (value: ReturnType<typeof usageSnapshot>) => void
    read.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValue(usageSnapshot([]))
    const request = { ...row, id: 'coalesce' }
    const first = readConnectionUsage(request)
    const second = readConnectionUsage(request)
    expect(read).toHaveBeenCalledTimes(1)
    finish(usageSnapshot([]))
    await Promise.all([first, second])
    await readConnectionUsage(request)
    expect(read).toHaveBeenCalledTimes(1)
    await readConnectionUsage({ ...request, generation: 2 })
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await readConnectionUsage({ ...request, generation: 2 })
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('caches failed reads and throttles sanitized diagnostics', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValue(new Error('secret provider response'))
    const request = { ...row, provider: 'grok-subscription', id: 'failure' }
    expect((await readConnectionUsage(request)).status).toBe('unavailable')
    await readConnectionUsage(request)
    await readConnectionUsage({ ...request, id: 'other-account' })
    expect(read).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  })
  it('never shares or caches member-attributed Platform reads', async () => {
    read.mockResolvedValue(usageSnapshot([]))
    const request = { ...row, provider: 'platform', id: 'platform' }
    await Promise.all([readConnectionUsage(request), readConnectionUsage(request)])
    expect(read).toHaveBeenCalledTimes(2)
  })
})
