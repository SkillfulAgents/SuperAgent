vi.mock('@shared/lib/agent-integrations/mcp', () => ({ integrationMcpProjection: vi.fn(async () => []) }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing container-host
// ============================================================================

const mockStart = vi.fn().mockResolvedValue({ status: 'running', port: 4001 })
const mockStop = vi.fn().mockResolvedValue({ forceStopUsed: false, stopped: true })
const mockGetInfoFromRuntime = vi.fn().mockResolvedValue({ status: 'running', port: 4001 })

vi.mock('./client-factory', () => ({
  createContainerClient: () => ({
    start: mockStart,
    stop: mockStop,
    stopSync: vi.fn(),
    getInfoFromRuntime: (...args: unknown[]) => mockGetInfoFromRuntime(...args),
    getStats: vi.fn(),
    fetch: vi.fn(),
    getHostApiBaseUrl: () => 'http://127.0.0.1:3000',
    buildVolumeFlag: (hostPath: string, containerPath: string) => `"${hostPath}:${containerPath}"`,
    createSession: vi.fn(),
    onFatalResult: () => 'settle',
    observeUnexpectedDeath: async () => ({ action: 'settle' as const }),
    getRuntimeGenerationId: () => null,
  }),
  getContainerClientClass: () => ({ requiresLocalImage: true }),
  checkAllRunnersAvailability: vi.fn().mockResolvedValue([]),
  checkImageExists: vi.fn().mockResolvedValue(true),
  pullImage: vi.fn(),
  canBuildImage: vi.fn().mockReturnValue(false),
  buildImage: vi.fn(),
  startRunner: vi.fn(),
  refreshRunnerAvailability: vi.fn(),
  clearRunnerAvailabilityCache: vi.fn(),
  getRunnerDisplayName: (runner: string) => runner,
  reconcileRunnerState: vi.fn().mockResolvedValue(false),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  getOrCreateProxyToken: vi.fn().mockResolvedValue('test-token'),
}))

vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: vi.fn(() => 'test-host-token'),
}))

vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => '127.0.0.1',
  getAppPort: () => 3000,
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: vi.fn().mockResolvedValue([]) }) }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id' },
  agentConnectedAccounts: 'agent_connected_accounts_table',
  agentRemoteMcps: 'agent_remote_mcps_table',
  remoteMcpServers: 'remote_mcp_servers_table',
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

// The timeout is read at every arm, so the tests change it in place.
const settings = { container: { agentImage: 'test-image', containerRunner: 'docker' }, app: { autoSleepTimeoutMinutes: 30 } }

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => settings,
  updateSettings: vi.fn(),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getAgentWorkspaceDir: (id: string) => `/workspace/${id}`,
}))

const mockHasActive = vi.fn(() => false)
const mockHasAwaiting = vi.fn(() => false)

vi.mock('./message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
    hasActiveSessionsForAgent: () => mockHasActive(),
    hasSessionsAwaitingInputForAgent: () => mockHasAwaiting(),
    snapshotMidTurnSessions: vi.fn(() => []),
    consumeLastFatal: vi.fn(() => null),
    settleRecoveringSessions: vi.fn(),
    markRecovered: vi.fn(),
    takeCoalescedUserMessages: vi.fn(() => []),
    isSessionRecovering: vi.fn(() => false),
    isSubscribed: vi.fn(() => false),
    subscribeToSession: vi.fn(),
  },
}))

vi.mock('./health-monitor', () => ({
  healthMonitor: { checkAll: vi.fn().mockReturnValue([]) },
}))

vi.mock('@shared/lib/browser/chrome-profile', () => ({
  copyChromeProfileData: vi.fn().mockReturnValue(false),
}))

vi.mock('@shared/lib/computer-use/executor', () => ({ ungrabAC: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/lib/computer-use/permission-manager', () => ({
  computerUsePermissionManager: { getGrabbedApp: () => null, clearGrabbedApp: vi.fn() },
}))
vi.mock('@shared/lib/services/agent-service', () => ({}))
vi.mock('@shared/lib/composio/client', () => ({ isPlatformComposioActive: () => false }))
vi.mock('@shared/lib/services/timezone-resolver', () => ({ resolveTimezoneForAgent: () => 'UTC' }))
vi.mock('@shared/lib/services/mount-service', () => ({ getMountsWithHealth: () => [] }))

import { containerHost } from './container-host'

const MINUTE = 60_000
const TIMEOUT = 30 * MINUTE
const T0 = new Date('2026-03-01T12:00:00Z').getTime()
const SLUG = 'agent-alarm'

// ============================================================================
// The runtime sleeps itself
//
// Every mark on the activity clock (start, keep-alive, session write) arms the
// idle alarm for the auto-sleep timeout; the alarm stops the container through
// the runtime's own stop, never escalating to a force-stop of the shared VM.
// ============================================================================

describe('ContainerRuntime idle alarm', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    vi.clearAllMocks()
    settings.app.autoSleepTimeoutMinutes = 30
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    mockHasActive.mockReturnValue(false)
    mockHasAwaiting.mockReturnValue(false)
    containerHost.dropRuntime(SLUG)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    containerHost.dropRuntime(SLUG)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function startRuntime() {
    const runtime = containerHost.runtime(SLUG)
    await runtime.ensureRunning()
    expect(runtime.getCachedInfo().status).toBe('running')
    return runtime
  }

  it('a start arms the alarm, and the alarm stops the container one timeout later without force-stopping', async () => {
    const runtime = await startRuntime()
    expect(runtime.idleAlarm.isArmed()).toBe(true)
    expect(runtime.idleSince()).toBe(T0)

    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(mockStop.mock.calls[0][0]).toMatchObject({ escalateToForceStop: false, stopTimeoutMs: 60_000, killTimeoutMs: 30_000 })
    expect(runtime.getCachedInfo().status).toBe('stopped')
    expect(runtime.idleAlarm.isArmed()).toBe(false)
    expect(runtime.idleSince()).toBeNull()
  })

  it('a keep-alive and a session write each push the alarm out', async () => {
    const runtime = await startRuntime()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    runtime.keepAlive()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    runtime.noteSessionActivity()
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('leaves a busy container alone and sleeps it once its sessions are quiet', async () => {
    const runtime = await startRuntime()
    mockHasActive.mockReturnValue(true)
    expect(runtime.idleSince()).toBeNull()
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).not.toHaveBeenCalled()
    expect(runtime.idleAlarm.isArmed()).toBe(true)

    mockHasActive.mockReturnValue(false)
    mockHasAwaiting.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()

    mockHasAwaiting.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('never sleeps while auto-sleep is disabled', async () => {
    settings.app.autoSleepTimeoutMinutes = 0
    const runtime = await startRuntime()
    expect(runtime.idleAlarm.isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('a shortened timeout applies to running containers when the host re-arms them', async () => {
    await startRuntime()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    settings.app.autoSleepTimeoutMinutes = 5
    containerHost.rearmIdleAlarms()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('retries when the stop did not complete, and gives up once the container is gone', async () => {
    mockStop.mockResolvedValueOnce({ forceStopUsed: false, stopped: false })
    const runtime = await startRuntime()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).toHaveBeenCalledTimes(1)
    // Still running: the alarm is armed for a retry, not forgotten.
    expect(runtime.getCachedInfo().status).toBe('running')
    expect(runtime.idleAlarm.isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(mockStop).toHaveBeenCalledTimes(2)
    expect(runtime.getCachedInfo().status).toBe('stopped')
    expect(runtime.idleAlarm.isArmed()).toBe(false)
  })

  it('a session write to a stopped agent marks the clock but arms nothing, and the next start is unaffected', async () => {
    const runtime = containerHost.runtime(SLUG)
    // Deleting a message or appending to a transcript offline records activity.
    runtime.noteSessionActivity()
    expect(runtime.idleAlarm.isArmed()).toBe(false)
    expect(runtime.idleSince()).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()

    await runtime.ensureRunning()
    expect(runtime.idleAlarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('a stale mark during an in-flight start neither arms nor fires against the start', async () => {
    let finishStart!: (info: { status: 'running'; port: number }) => void
    mockStart.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve }))
    const runtime = containerHost.runtime(SLUG)
    const starting = runtime.ensureRunning()
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.isStarting()).toBe(true)

    runtime.noteSessionActivity(T0 - TIMEOUT - MINUTE)
    expect(runtime.idleAlarm.isArmed()).toBe(false)
    await runtime.idleAlarm.fire()
    expect(mockStop).not.toHaveBeenCalled()

    finishStart({ status: 'running', port: 4001 })
    await starting
    expect(runtime.getCachedInfo().status).toBe('running')
    // The start is the newest mark: a full window from now, not the stale one.
    expect(runtime.idleAlarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('re-arms when a status sync sees the container running again after reporting it stopped', async () => {
    const runtime = await startRuntime()
    // A transient inspect failure (or a real external stop) is reported as stopped:
    // the alarm is disarmed, and one that fires in that window finds nothing to sleep.
    mockGetInfoFromRuntime.mockResolvedValueOnce({ status: 'stopped', port: null })
    await runtime.syncAgentStatus()
    expect(runtime.getCachedInfo().status).toBe('stopped')
    expect(runtime.idleAlarm.isArmed()).toBe(false)
    await runtime.idleAlarm.fire()
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).not.toHaveBeenCalled()

    // The next sync sees it running: the clock was never reset, so the alarm
    // arms from the original start mark, which is already past the timeout.
    await runtime.syncAgentStatus()
    expect(runtime.getCachedInfo().status).toBe('running')
    expect(runtime.idleAlarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(runtime.getCachedInfo().status).toBe('stopped')
  })

  it('a periodic sync that keeps seeing the container running does not push the alarm out', async () => {
    const runtime = await startRuntime()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    await runtime.syncAgentStatus()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(mockStop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('dropping the runtime disarms it', async () => {
    const runtime = await startRuntime()
    containerHost.dropRuntime(SLUG)
    expect(runtime.idleAlarm.isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()
  })
})
