import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionInfo } from '@shared/lib/types/agent'

// ============================================================================
// Mocks — must be declared before any import that triggers the module
// ============================================================================

const mockGetRunningAgentIds = vi.fn<() => string[]>(() => [])
const mockGetContainerStartTime = vi.fn<(id: string) => number | undefined>()
const mockGetLastKeepAlive = vi.fn<(id: string) => number | undefined>()
const mockShouldRunHostAutoSleep = vi.fn<(id: string) => boolean>(() => true)
const mockStopContainer = vi.fn()

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getRunningAgentIds: () => mockGetRunningAgentIds(),
    getContainerStartTime: (id: string) => mockGetContainerStartTime(id),
    getLastKeepAlive: (id: string) => mockGetLastKeepAlive(id),
    shouldRunHostAutoSleep: (id: string) => mockShouldRunHostAutoSleep(id),
    stopContainer: (...args: unknown[]) => mockStopContainer(...args),
  },
}))

const mockHasActiveSessions = vi.fn<(id: string) => boolean>(() => false)

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    hasActiveSessionsForAgent: (id: string) => mockHasActiveSessions(id),
  },
}))

const mockListSessions = vi.fn<(slug: string) => Promise<SessionInfo[]>>()

vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: (slug: string) => mockListSessions(slug),
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

function makeSession(id: string, lastActivityAt: Date): SessionInfo {
  return {
    id,
    agentSlug: 'agent-1',
    name: `Session ${id}`,
    createdAt: new Date('2026-01-01'),
    lastActivityAt,
    messageCount: 1,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('AutoSleepMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockGetSettings.mockReturnValue({ app: { autoSleepTimeoutMinutes: 30 } })
    mockGetRunningAgentIds.mockReturnValue([])
    mockListSessions.mockResolvedValue([])
    mockGetContainerStartTime.mockReturnValue(undefined)
    mockGetLastKeepAlive.mockReturnValue(undefined)
    mockShouldRunHostAutoSleep.mockReturnValue(true)
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
    mockListSessions.mockResolvedValue([
      makeSession('s1', new Date(now - THIRTY_MINUTES_MS - 1000)),
    ])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).toHaveBeenCalledWith('agent-1', {
      stopTimeoutMs: 60_000,
      killTimeoutMs: 30_000,
      escalateToForceStop: false,
    })
  })

  it('never escalates to force-stopping the VM (escalateToForceStop: false)', async () => {
    // Auto-sleep is a background sweep; force-stopping the shared Lima VM to
    // reclaim one idle container would kill every running agent. The monitor
    // must always opt out of escalation.
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockListSessions.mockResolvedValue([
      makeSession('s1', new Date(now - THIRTY_MINUTES_MS - 1000)),
    ])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).toHaveBeenCalledTimes(1)
    const [, options] = mockStopContainer.mock.calls[0]
    expect(options).toMatchObject({ escalateToForceStop: false })
  })

  it('does not stop agent with recent session activity', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockListSessions.mockResolvedValue([
      makeSession('s1', new Date(now - 5 * 60 * 1000)),
    ])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('does not stop agent with recent keep-alive despite stale sessions', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockListSessions.mockResolvedValue([
      makeSession('s1', new Date(now - THIRTY_MINUTES_MS - 60_000)),
    ])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 60_000)
    mockGetLastKeepAlive.mockReturnValue(now - 5 * 60 * 1000)

    await autoSleepMonitor.start()
    await tick()

    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('stops agent when keep-alive is also stale', async () => {
    const now = Date.now()
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockListSessions.mockResolvedValue([
      makeSession('s1', new Date(now - THIRTY_MINUTES_MS - 60_000)),
    ])
    mockGetContainerStartTime.mockReturnValue(now - THIRTY_MINUTES_MS - 60_000)
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

    expect(mockListSessions).not.toHaveBeenCalled()
    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('skips all session I/O when the runtime owns idle sleep', async () => {
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockShouldRunHostAutoSleep.mockReturnValue(false)

    await autoSleepMonitor.start()
    await tick()

    expect(mockShouldRunHostAutoSleep).toHaveBeenCalledWith('agent-1')
    expect(mockHasActiveSessions).not.toHaveBeenCalled()
    expect(mockListSessions).not.toHaveBeenCalled()
    expect(mockStopContainer).not.toHaveBeenCalled()
  })

  it('skips agent with no sessions', async () => {
    mockGetRunningAgentIds.mockReturnValue(['agent-1'])
    mockListSessions.mockResolvedValue([])

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
