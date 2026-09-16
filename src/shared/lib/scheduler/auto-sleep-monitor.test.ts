import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — must be declared before any import that triggers the module
// ============================================================================

// The monitor talks to agents only through the actor contract: which are
// running, how long each has been idle, and stop. Test it on the fake actor.
vi.mock('@shared/lib/agent-actor', async () => {
  const { createFakeRegistry } = await import('@shared/lib/agent-actor/testing/fake-agent-actor')
  return { agentRegistry: createFakeRegistry() }
})

const mockGetSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))

// Import after mocks
import { agentRegistry } from '@shared/lib/agent-actor'
import type { FakeRegistry } from '@shared/lib/agent-actor/testing/fake-agent-actor'
import { autoSleepMonitor, idleLongerThan } from './auto-sleep-monitor'

const registry = agentRegistry as FakeRegistry

// ============================================================================
// Helpers
// ============================================================================

const THIRTY_MINUTES_MS = 30 * 60 * 1000
const NOW = new Date('2026-03-01T12:00:00Z').getTime()

/** A running agent whose idle clock reads `idleSince` (null: busy or unknown). */
function running(slug: string, idleSince: number | null) {
  const actor = registry.fake(slug)
  actor.container.idleSince.mockReturnValue(idleSince)
  actor.container.stop.mockResolvedValue(undefined)
  registry.runningSlugs.push(slug)
  return actor
}

// ============================================================================
// Tests
// ============================================================================

describe('idleLongerThan', () => {
  it('is a pure function of the clock and the timeout', () => {
    expect(idleLongerThan(NOW - THIRTY_MINUTES_MS - 1, THIRTY_MINUTES_MS, NOW)).toBe(true)
    expect(idleLongerThan(NOW - THIRTY_MINUTES_MS, THIRTY_MINUTES_MS, NOW)).toBe(false)
    expect(idleLongerThan(NOW - 5 * 60 * 1000, THIRTY_MINUTES_MS, NOW)).toBe(false)
  })

  it('never reaps an agent whose clock is null: busy, or nothing recorded yet', () => {
    expect(idleLongerThan(null, THIRTY_MINUTES_MS, NOW)).toBe(false)
    expect(idleLongerThan(null, 0, NOW)).toBe(false)
  })
})

describe('AutoSleepMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
    registry.evictAll()
    registry.runningSlugs = []
    mockGetSettings.mockReturnValue({ app: { autoSleepTimeoutMinutes: 30 } })
  })

  afterEach(() => {
    autoSleepMonitor.stop()
    vi.useRealTimers()
  })

  it('stops an agent idle for longer than the timeout', async () => {
    const actor = running('agent-1', NOW - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.sweep()

    expect(actor.container.stop).toHaveBeenCalledWith({
      stopTimeoutMs: 60_000,
      killTimeoutMs: 30_000,
      escalateToForceStop: false,
    })
  })

  it('never escalates to force-stopping the VM (escalateToForceStop: false)', async () => {
    // Auto-sleep is a background sweep; force-stopping the shared Lima VM to
    // reclaim one idle container would kill every running agent. The monitor
    // must always opt out of escalation.
    const actor = running('agent-1', NOW - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.sweep()

    expect(actor.container.stop).toHaveBeenCalledTimes(1)
    const [options] = actor.container.stop.mock.calls[0]
    expect(options).toMatchObject({ escalateToForceStop: false })
  })

  it('keeps an agent whose clock is inside the window', async () => {
    // Recent session activity, a recent keep-alive or a recent start all
    // read the same way through the actor: an idleSince inside the timeout.
    const actor = running('agent-1', NOW - 5 * 60 * 1000)

    await autoSleepMonitor.sweep()

    expect(actor.container.stop).not.toHaveBeenCalled()
  })

  it('keeps an agent idle for exactly the timeout', async () => {
    const actor = running('agent-1', NOW - THIRTY_MINUTES_MS)

    await autoSleepMonitor.sweep()

    expect(actor.container.stop).not.toHaveBeenCalled()
  })

  it('skips a busy agent (active or awaiting input: the clock reads null)', async () => {
    const actor = running('agent-1', null)

    await autoSleepMonitor.sweep()

    expect(actor.container.stop).not.toHaveBeenCalled()
  })

  it('reads nothing but the clock: no session listing per tick', async () => {
    const actor = running('agent-1', NOW - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.sweep()

    expect(actor.container.idleSince).toHaveBeenCalledTimes(1)
    expect(actor.sessions.list).not.toHaveBeenCalled()
    expect(actor.sessions.hasActive).not.toHaveBeenCalled()
  })

  it('decides per agent and keeps sweeping after one stop fails', async () => {
    const failing = running('agent-1', NOW - THIRTY_MINUTES_MS - 1000)
    failing.container.stop.mockRejectedValue(new Error('runtime busy'))
    const busy = running('agent-2', null)
    const idle = running('agent-3', NOW - THIRTY_MINUTES_MS - 1000)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await autoSleepMonitor.sweep()

    expect(failing.container.stop).toHaveBeenCalledTimes(1)
    expect(busy.container.stop).not.toHaveBeenCalled()
    expect(idle.container.stop).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('does nothing when disabled (timeout = 0)', async () => {
    mockGetSettings.mockReturnValue({ app: { autoSleepTimeoutMinutes: 0 } })
    const actor = running('agent-1', NOW - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.sweep()

    expect(actor.container.idleSince).not.toHaveBeenCalled()
    expect(actor.container.stop).not.toHaveBeenCalled()
  })

  it('defaults the timeout to 30 minutes', async () => {
    mockGetSettings.mockReturnValue({ app: {} })
    const stale = running('agent-1', NOW - THIRTY_MINUTES_MS - 1000)
    const fresh = running('agent-2', NOW - THIRTY_MINUTES_MS + 1000)

    await autoSleepMonitor.sweep()

    expect(stale.container.stop).toHaveBeenCalledTimes(1)
    expect(fresh.container.stop).not.toHaveBeenCalled()
  })

  it('sweeps on the interval once started', async () => {
    const actor = running('agent-1', NOW - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.start()
    expect(actor.container.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(actor.container.stop).toHaveBeenCalledTimes(1)
  })
})
