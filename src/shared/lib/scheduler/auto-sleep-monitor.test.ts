import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — must be declared before any import that triggers the module
// ============================================================================

const mockGetRunningAgentIds = vi.fn<() => string[]>(() => [])
const mockGetContainerStartTime = vi.fn<(id: string) => number | undefined>()
const mockGetLastKeepAlive = vi.fn<(id: string) => number | undefined>()
const mockStopContainer = vi.fn()

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getRunningAgentIds: () => mockGetRunningAgentIds(),
    getContainerStartTime: (id: string) => mockGetContainerStartTime(id),
    getLastKeepAlive: (id: string) => mockGetLastKeepAlive(id),
    stopContainer: (...args: unknown[]) => mockStopContainer(...args),
  },
}))

const mockHasActiveSessions = vi.fn<(id: string) => boolean>(() => false)

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    hasActiveSessionsForAgent: (id: string) => mockHasActiveSessions(id),
  },
}))

const mockGetAgentLastActivity = vi.fn<(id: string) => number | undefined>()

vi.mock('@shared/lib/container/agent-activity-clock', () => ({
  getAgentLastActivity: (id: string) => mockGetAgentLastActivity(id),
}))

const mockGetSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))

// Import after mocks
import { autoSleepMonitor } from './auto-sleep-monitor'

// ============================================================================
// Helpers
// ============================================================================

const THIRTY_MINUTES_MS = 30 * 60 * 1000

// ============================================================================
// Tests
// ============================================================================

describe('AutoSleepMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockGetSettings.mockReturnValue({ app: { autoSleepTimeoutMinutes: 30 } })
    mockGetRunningAgentIds.mockReturnValue([])
    mockGetContainerStartTime.mockReturnValue(undefined)
    mockGetLastKeepAlive.mockReturnValue(undefined)
    mockGetAgentLastActivity.mockReturnValue(undefined)
    mockStopContainer.mockResolvedValue(undefined)
  })

  afterEach(() => {
    autoSleepMonitor.stop()
    vi.useRealTimers()
  })

  async function tick() {
    await vi.advanceTimersByTimeAsync(60_000)
  }

  it('stops idle agent after timeout', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 1000)
    mockGetAgentLastActivity.mockReturnValue(now - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).toHaveBeenCalledWith('agent-1', {
      stopTimeoutMs: 60_000,
      killTimeoutMs: 30_000,
      escalateToForceStop: false,
    })
  })

  it('never escalates to force-stopping the VM (escalateToForceStop: false)', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).toHaveBeenCalledTimes(1)
    const [, options] = mockStopContainer.mock.calls[0]
    expect(options).toMatchObject({ escalateToForceStop: false })
  })

  it('does not stop agent with recent activity clock', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 1000)
    mockGetAgentLastActivity.mockReturnValue(now - 5 * 60 * 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('does not stop agent with recent keep-alive despite stale clock', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 60_000)
    mockGetAgentLastActivity.mockReturnValue(now - THIRTY_MINUTES_MS - 60_000)
    mockGetLastKeepAlive.mockReturnValue(now - 5 * 60 * 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('does not stop agent with recent container start floor', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockGetContainerStartTime.mockReturnValue(now - 5 * 60 * 1000)
    mockGetAgentLastActivity.mockReturnValue(now - THIRTY_MINUTES_MS - 60_000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('stops agent when keep-alive is also stale', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 60_000)
    mockGetAgentLastActivity.mockReturnValue(now - THIRTY_MINUTES_MS - 60_000)
    mockGetLastKeepAlive.mockReturnValue(now - THIRTY_MINUTES_MS - 30_000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).toHaveBeenCalledWith('agent-1', expect.anything())
  })

  it('skips agent with active sessions', async () => {
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockHasActiveSessions.mockReturnValue(true)

    await autoSleepMonitor.start()
    await tick()

    expect(mockGetAgentLastActivity).not.toHaveBeenCalled()
    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('skips agent with no activity signals', async () => {
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('does nothing when disabled (timeout = 0)', async () => {
    mockGetSettings.mockReturnValue({ app: { autoSleepTimeoutMinutes: 0 } })
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).not.toHaveBeenCalled()
  })
})
