import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing container-manager
// ============================================================================

const mockStart = vi.fn()
const mockStop = vi.fn()
const mockStopSync = vi.fn()
const mockGetInfoFromRuntime = vi.fn()
const mockGetStats = vi.fn()

const mockClearRunnerAvailabilityCache = vi.fn()

const mockBuildVolumeFlag = vi.fn((hostPath: string, containerPath: string) => `"${hostPath}:${containerPath}"`)

vi.mock('./client-factory', () => ({
  createContainerClient: () => ({
    start: mockStart,
    stop: mockStop,
    stopSync: mockStopSync,
    getInfoFromRuntime: mockGetInfoFromRuntime,
    getStats: mockGetStats,
    fetch: vi.fn(),
    buildVolumeFlag: (...args: unknown[]) => mockBuildVolumeFlag(...args as [string, string]),
  }),
  checkAllRunnersAvailability: vi.fn().mockResolvedValue([]),
  checkImageExists: vi.fn().mockResolvedValue(true),
  validateImage: vi.fn(),
  pullImage: vi.fn(),
  canBuildImage: vi.fn().mockReturnValue(false),
  buildImage: vi.fn(),
  startRunner: vi.fn(),
  refreshRunnerAvailability: vi.fn(),
  clearRunnerAvailabilityCache: (...args: unknown[]) => mockClearRunnerAvailabilityCache(...args),
  getRunnerDisplayName: (runner: string) => runner,
}))

const mockGetOrCreateProxyToken = vi.fn()
vi.mock('@shared/lib/proxy/token-store', () => ({
  getOrCreateProxyToken: (...args: unknown[]) => mockGetOrCreateProxyToken(...args),
}))

const mockGetContainerHostUrl = vi.fn()
const mockGetAppPort = vi.fn()
vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => mockGetContainerHostUrl(),
  getAppPort: () => mockGetAppPort(),
}))

// DB mock: agentConnectedAccounts join query
const mockDbWhere = vi.fn()
const mockDbInnerJoin = vi.fn()

// DB mock: remote MCPs join query
const mockMcpWhere = vi.fn()
const mockMcpInnerJoin = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        // agentConnectedAccounts table (first call)
        if (table === 'agent_connected_accounts_table') {
          return { innerJoin: mockDbInnerJoin }
        }
        // agentRemoteMcps table (second call)
        if (table === 'agent_remote_mcps_table') {
          return { innerJoin: mockMcpInnerJoin }
        }
        // Default: return the connected accounts chain
        return { innerJoin: mockDbInnerJoin }
      }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {
    id: 'id',
    toolkitSlug: 'toolkit_slug',
    composioConnectionId: 'composio_connection_id',
    status: 'status',
    displayName: 'display_name',
  },
  agentConnectedAccounts: 'agent_connected_accounts_table',
  agentRemoteMcps: 'agent_remote_mcps_table',
  remoteMcpServers: 'remote_mcp_servers_table',
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ container: { agentImage: 'test-image', containerRunner: 'docker' }, app: {} }),
  updateSettings: vi.fn(),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getAgentWorkspaceDir: (id: string) => `/workspace/${id}`,
}))

vi.mock('./message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(),
    setStopContainerCallback: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
  },
}))

vi.mock('./health-monitor', () => ({
  healthMonitor: {
    checkAll: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('@shared/lib/browser/chrome-profile', () => ({
  copyChromeProfileData: vi.fn().mockReturnValue(false),
}))

vi.mock('@shared/lib/services/agent-service', () => ({}))

vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => false,
}))

vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: () => 'America/New_York',
}))

const mockGetMountsWithHealth = vi.fn()
vi.mock('@shared/lib/services/mount-service', () => ({
  getMountsWithHealth: (...args: unknown[]) => mockGetMountsWithHealth(...args),
}))

import { containerManager } from './container-manager'

describe('containerManager.ensureRunning — env var construction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear internal state by removing the client
    containerManager.removeClient('test-agent')

    mockGetOrCreateProxyToken.mockResolvedValue('synth-token-123')
    mockGetContainerHostUrl.mockReturnValue('192.168.1.100')
    mockGetAppPort.mockReturnValue(3000)

    // Default: no mounts
    mockGetMountsWithHealth.mockReturnValue([])

    // Default: container not running
    containerManager.updateCachedStatus('test-agent', 'stopped', null)

    // Mock start + sync
    mockStart.mockResolvedValue(undefined)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 8080 })
  })

  function setupAccountMocks(
    accounts: Array<{
      id: string
      toolkitSlug: string
      displayName: string
      status: string
      composioConnectionId: string
    }>
  ) {
    // First db.select().from() call: connected accounts
    mockDbInnerJoin.mockReturnValue({ where: mockDbWhere })
    mockDbWhere.mockResolvedValue(
      accounts.map((a) => ({ account: a }))
    )

    // Second db.select().from() call: remote MCPs
    mockMcpInnerJoin.mockReturnValue({ where: mockMcpWhere })
    mockMcpWhere.mockResolvedValue([])
  }

  it('sets PROXY_BASE_URL with correct format', async () => {
    setupAccountMocks([])

    await containerManager.ensureRunning('test-agent')

    expect(mockStart).toHaveBeenCalledOnce()
    const startOpts = mockStart.mock.calls[0][0]
    expect(startOpts.envVars.PROXY_BASE_URL).toBe(
      'http://192.168.1.100:3000/api/proxy/test-agent'
    )
  })

  it('sets PROXY_TOKEN from getOrCreateProxyToken return value', async () => {
    setupAccountMocks([])
    mockGetOrCreateProxyToken.mockResolvedValue('custom-proxy-token')

    await containerManager.ensureRunning('test-agent')

    const startOpts = mockStart.mock.calls[0][0]
    expect(startOpts.envVars.PROXY_TOKEN).toBe('custom-proxy-token')
    expect(mockGetOrCreateProxyToken).toHaveBeenCalledWith('test-agent')
  })

  it('CONNECTED_ACCOUNTS includes only active accounts, grouped by toolkitSlug', async () => {
    setupAccountMocks([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active', composioConnectionId: 'c1' },
      { id: 'acc-2', toolkitSlug: 'gmail', displayName: 'user2@gmail.com', status: 'active', composioConnectionId: 'c2' },
      { id: 'acc-3', toolkitSlug: 'slack', displayName: 'My Slack', status: 'active', composioConnectionId: 'c3' },
      { id: 'acc-4', toolkitSlug: 'github', displayName: 'My GH', status: 'expired', composioConnectionId: 'c4' },
    ])

    await containerManager.ensureRunning('test-agent')

    const startOpts = mockStart.mock.calls[0][0]
    const metadata = JSON.parse(startOpts.envVars.CONNECTED_ACCOUNTS)

    expect(metadata.gmail).toHaveLength(2)
    expect(metadata.slack).toHaveLength(1)
    expect(metadata.github).toBeUndefined() // expired, excluded
  })

  it('each account entry has { name, id } structure', async () => {
    setupAccountMocks([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active', composioConnectionId: 'c1' },
    ])

    await containerManager.ensureRunning('test-agent')

    const startOpts = mockStart.mock.calls[0][0]
    const metadata = JSON.parse(startOpts.envVars.CONNECTED_ACCOUNTS)

    expect(metadata.gmail[0]).toEqual({ name: 'user@gmail.com', id: 'acc-1' })
  })

  it('empty CONNECTED_ACCOUNTS ({}) when no accounts exist', async () => {
    setupAccountMocks([])

    await containerManager.ensureRunning('test-agent')

    const startOpts = mockStart.mock.calls[0][0]
    const metadata = JSON.parse(startOpts.envVars.CONNECTED_ACCOUNTS)
    expect(metadata).toEqual({})
  })

  it('inactive accounts are excluded from metadata', async () => {
    setupAccountMocks([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'active@gmail.com', status: 'active', composioConnectionId: 'c1' },
      { id: 'acc-2', toolkitSlug: 'gmail', displayName: 'inactive@gmail.com', status: 'inactive', composioConnectionId: 'c2' },
      { id: 'acc-3', toolkitSlug: 'slack', displayName: 'expired-slack', status: 'expired', composioConnectionId: 'c3' },
    ])

    await containerManager.ensureRunning('test-agent')

    const startOpts = mockStart.mock.calls[0][0]
    const metadata = JSON.parse(startOpts.envVars.CONNECTED_ACCOUNTS)

    expect(metadata.gmail).toHaveLength(1)
    expect(metadata.gmail[0].name).toBe('active@gmail.com')
    expect(metadata.slack).toBeUndefined()
  })

  it('sets TZ env var from resolveTimezoneForAgent', async () => {
    setupAccountMocks([])

    await containerManager.ensureRunning('test-agent')

    const startOpts = mockStart.mock.calls[0][0]
    expect(startOpts.envVars.TZ).toBe('America/New_York')
  })
})

// ============================================================================
// ensureRunning — mount volume integration
// ============================================================================

describe('containerManager.ensureRunning — mount volumes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.removeClient('test-agent')

    mockGetOrCreateProxyToken.mockResolvedValue('token')
    mockGetContainerHostUrl.mockReturnValue('127.0.0.1')
    mockGetAppPort.mockReturnValue(3000)

    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    mockStart.mockResolvedValue(undefined)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 8080 })

    // Default DB mocks (no accounts, no MCPs)
    mockDbInnerJoin.mockReturnValue({ where: mockDbWhere })
    mockDbWhere.mockResolvedValue([])
    mockMcpInnerJoin.mockReturnValue({ where: mockMcpWhere })
    mockMcpWhere.mockResolvedValue([])
  })

  it('passes additionalVolumes from healthy mounts to client.start()', async () => {
    mockGetMountsWithHealth.mockReturnValue([
      { id: 'm1', hostPath: '/host/project', containerPath: '/mounts/project', folderName: 'project', addedAt: '2025-01-01', health: 'ok' },
    ])

    await containerManager.ensureRunning('test-agent')

    expect(mockStart).toHaveBeenCalledOnce()
    const opts = mockStart.mock.calls[0][0]
    expect(opts.additionalVolumes).toHaveLength(1)
    // The volume flag is produced by buildVolumeFlag which we can't inspect exactly
    // since the client is mocked, but it should be an array of strings
    expect(typeof opts.additionalVolumes[0]).toBe('string')
  })

  it('skips missing mounts and broadcasts warning', async () => {
    mockGetMountsWithHealth.mockReturnValue([
      { id: 'm1', hostPath: '/host/ok', containerPath: '/mounts/ok', folderName: 'ok', addedAt: '2025-01-01', health: 'ok' },
      { id: 'm2', hostPath: '/host/gone', containerPath: '/mounts/gone', folderName: 'gone', addedAt: '2025-01-01', health: 'missing' },
    ])

    await containerManager.ensureRunning('test-agent')

    const opts = mockStart.mock.calls[0][0]
    // Only healthy mount should be in volumes
    expect(opts.additionalVolumes).toHaveLength(1)

    // Should broadcast mount health warning
    const broadcasts = vi.mocked(messagePersister.broadcastGlobal).mock.calls
    const mountWarnings = broadcasts.filter(([msg]: any) => msg.type === 'mount_health_warning')
    expect(mountWarnings).toHaveLength(1)
    expect(mountWarnings[0][0]).toMatchObject({
      type: 'mount_health_warning',
      agentSlug: 'test-agent',
      missingMounts: [{ folderName: 'gone', hostPath: '/host/gone' }],
    })
  })

  it('passes empty additionalVolumes when no mounts exist', async () => {
    mockGetMountsWithHealth.mockReturnValue([])

    await containerManager.ensureRunning('test-agent')

    const opts = mockStart.mock.calls[0][0]
    expect(opts.additionalVolumes).toEqual([])
  })
})

// ============================================================================
// restartContainer
// ============================================================================

describe('containerManager.restartContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.removeClient('test-agent')
    mockGetMountsWithHealth.mockReturnValue([])
    mockGetOrCreateProxyToken.mockResolvedValue('token')
    mockGetContainerHostUrl.mockReturnValue('127.0.0.1')
    mockGetAppPort.mockReturnValue(3000)
    mockDbInnerJoin.mockReturnValue({ where: mockDbWhere })
    mockDbWhere.mockResolvedValue([])
    mockMcpInnerJoin.mockReturnValue({ where: mockMcpWhere })
    mockMcpWhere.mockResolvedValue([])
  })

  it('calls stop then ensureRunning', async () => {
    containerManager.getClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'running', 4001)
    mockStop.mockResolvedValue({ forceStopUsed: false })
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4002 })
    mockStart.mockResolvedValue(undefined)

    await containerManager.restartContainer('test-agent')

    expect(mockStop).toHaveBeenCalledOnce()
    expect(mockStart).toHaveBeenCalledOnce()
    // Stop should have been called before start
    const stopOrder = mockStop.mock.invocationCallOrder[0]
    const startOrder = mockStart.mock.invocationCallOrder[0]
    expect(stopOrder).toBeLessThan(startOrder)
  })
})

// ============================================================================
// Status caching — getCachedInfo / updateCachedStatus / markAsStopped
// ============================================================================

describe('containerManager — status caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.clearClients()
  })

  it('getCachedInfo returns stopped when agent has no cached status', () => {
    const info = containerManager.getCachedInfo('unknown-agent')
    expect(info).toEqual({ status: 'stopped', port: null })
  })

  it('getCachedInfo returns cached status after updateCachedStatus', () => {
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    const info = containerManager.getCachedInfo('agent-1')
    expect(info).toEqual({ status: 'running', port: 4001 })
  })

  it('updateCachedStatus overwrites previous status', () => {
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    containerManager.updateCachedStatus('agent-1', 'stopped', null)
    const info = containerManager.getCachedInfo('agent-1')
    expect(info).toEqual({ status: 'stopped', port: null })
  })

  it('markAsStopped sets status to stopped with null port', () => {
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    containerManager.markAsStopped('agent-1')
    const info = containerManager.getCachedInfo('agent-1')
    expect(info).toEqual({ status: 'stopped', port: null })
  })

  it('clearClients removes all cached statuses', () => {
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    containerManager.updateCachedStatus('agent-2', 'running', 4002)
    containerManager.clearClients()
    expect(containerManager.getCachedInfo('agent-1')).toEqual({ status: 'stopped', port: null })
    expect(containerManager.getCachedInfo('agent-2')).toEqual({ status: 'stopped', port: null })
  })

  it('removeClient clears cache for specific agent only', () => {
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    containerManager.updateCachedStatus('agent-2', 'running', 4002)
    containerManager.removeClient('agent-1')
    expect(containerManager.getCachedInfo('agent-1')).toEqual({ status: 'stopped', port: null })
    expect(containerManager.getCachedInfo('agent-2')).toEqual({ status: 'running', port: 4002 })
  })
})

// ============================================================================
// hasRunningAgents / getRunningAgentIds
// ============================================================================

describe('containerManager — hasRunningAgents / getRunningAgentIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.clearClients()
  })

  it('hasRunningAgents returns false when no agents are cached', () => {
    expect(containerManager.hasRunningAgents()).toBe(false)
  })

  it('hasRunningAgents returns false when all agents are stopped', () => {
    containerManager.updateCachedStatus('agent-1', 'stopped', null)
    containerManager.updateCachedStatus('agent-2', 'stopped', null)
    expect(containerManager.hasRunningAgents()).toBe(false)
  })

  it('hasRunningAgents returns true when at least one agent is running', () => {
    containerManager.updateCachedStatus('agent-1', 'stopped', null)
    containerManager.updateCachedStatus('agent-2', 'running', 4002)
    expect(containerManager.hasRunningAgents()).toBe(true)
  })

  it('getRunningAgentIds returns empty array when none are running', () => {
    containerManager.updateCachedStatus('agent-1', 'stopped', null)
    expect(containerManager.getRunningAgentIds()).toEqual([])
  })

  it('getRunningAgentIds returns only running agent IDs', () => {
    containerManager.updateCachedStatus('agent-1', 'stopped', null)
    containerManager.updateCachedStatus('agent-2', 'running', 4002)
    containerManager.updateCachedStatus('agent-3', 'running', 4003)
    const running = containerManager.getRunningAgentIds()
    expect(running).toHaveLength(2)
    expect(running).toContain('agent-2')
    expect(running).toContain('agent-3')
  })

  it('getRunningAgentIds reflects status changes', () => {
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    expect(containerManager.getRunningAgentIds()).toContain('agent-1')

    containerManager.markAsStopped('agent-1')
    expect(containerManager.getRunningAgentIds()).not.toContain('agent-1')
  })
})

// ============================================================================
// Health warning change detection
// ============================================================================

import { healthMonitor } from './health-monitor'
import { messagePersister } from './message-persister'

describe('containerManager — health warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.clearClients()
  })

  it('getHealthWarnings returns empty array for unknown agent', () => {
    expect(containerManager.getHealthWarnings('unknown')).toEqual([])
  })

  it('getHealthWarnings returns empty array after clearClients', () => {
    // We can't directly set healthWarnings, but clearClients clears them
    containerManager.clearClients()
    expect(containerManager.getHealthWarnings('any-agent')).toEqual([])
  })

  it('removeClient clears health warnings for that agent', () => {
    // Create a client first (so it registers internally)
    containerManager.getClient('health-agent')
    containerManager.updateCachedStatus('health-agent', 'running', 4001)

    // Run health checks with a warning
    const mockWarning = { checkName: 'memory', status: 'warning' as const, message: 'High mem' }
    vi.mocked(healthMonitor.checkAll).mockReturnValue([mockWarning])
    mockGetStats.mockResolvedValue({
      memoryUsageBytes: 400_000_000,
      memoryLimitBytes: 512_000_000,
      memoryPercent: 78,
      cpuPercent: 50,
    })

    containerManager.removeClient('health-agent')
    expect(containerManager.getHealthWarnings('health-agent')).toEqual([])
  })
})

// ============================================================================
// ensureImageReady — state machine (CHECKING -> READY / ERROR / RUNTIME_UNAVAILABLE)
// ============================================================================

import { checkAllRunnersAvailability, checkImageExists, validateImage, pullImage, canBuildImage, buildImage } from './client-factory'

describe('containerManager.ensureImageReady — state machine', () => {
  const originalE2eMock = process.env.E2E_MOCK

  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.clearClients()
    delete process.env.E2E_MOCK
  })

  afterEach(() => {
    // Restore E2E_MOCK
    if (originalE2eMock !== undefined) {
      process.env.E2E_MOCK = originalE2eMock
    } else {
      delete process.env.E2E_MOCK
    }
  })

  it('sets READY immediately in E2E mock mode', async () => {
    process.env.E2E_MOCK = 'true'

    await containerManager.ensureImageReady()

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('READY')
    expect(readiness.message).toContain('E2E mock')

    // Should NOT have called any real runner checks
    expect(checkAllRunnersAvailability).not.toHaveBeenCalled()
  })

  it('transitions to READY when runner is available and image exists', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(true)
    vi.mocked(validateImage).mockResolvedValue()

    await containerManager.ensureImageReady()

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('READY')
    expect(readiness.pullProgress).toBeNull()
    expect(validateImage).toHaveBeenCalledWith('docker', 'test-image')
  })

  it('transitions to RUNTIME_UNAVAILABLE when configured runner is not available', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: false, running: false, available: false, canStart: false },
    ])

    await containerManager.ensureImageReady()

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('RUNTIME_UNAVAILABLE')
    expect(readiness.message).toContain('docker')
  })

  it('pulls image when runner available but image does not exist', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(false)
    vi.mocked(canBuildImage).mockReturnValue(false)
    vi.mocked(pullImage).mockImplementation(async (_runner, _image, _onProgress) => {
      // Simulate successful pull
    })

    await containerManager.ensureImageReady()

    expect(pullImage).toHaveBeenCalled()
    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('READY')
  })

  it('builds image when canBuildImage is true and image does not exist', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(false)
    vi.mocked(canBuildImage).mockReturnValue(true)
    vi.mocked(buildImage).mockImplementation(async (_runner, _image, _onProgress) => {
      // Simulate successful build
    })

    await containerManager.ensureImageReady()

    expect(buildImage).toHaveBeenCalled()
    expect(pullImage).not.toHaveBeenCalled()
    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('READY')
  })

  it('transitions to ERROR when pull fails', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(false)
    vi.mocked(canBuildImage).mockReturnValue(false)
    vi.mocked(pullImage).mockRejectedValue(new Error('Network timeout pulling image'))

    await containerManager.ensureImageReady()

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('ERROR')
    expect(readiness.message).toContain('Network timeout pulling image')
  })

  it('transitions to ERROR when build fails', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(false)
    vi.mocked(canBuildImage).mockReturnValue(true)
    vi.mocked(buildImage).mockRejectedValue(new Error('Dockerfile not found'))

    await containerManager.ensureImageReady()

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('ERROR')
    expect(readiness.message).toContain('Dockerfile not found')
  })

  it('broadcasts readiness changes via SSE', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(true)
    vi.mocked(validateImage).mockResolvedValue()

    await containerManager.ensureImageReady()

    // Should have broadcasted at least: CHECKING and READY
    const broadcasts = vi.mocked(messagePersister.broadcastGlobal).mock.calls
    const readinessEvents = broadcasts
      .filter(([msg]: any) => msg.type === 'runtime_readiness_changed')
      .map(([msg]: any) => msg.readiness.status)

    expect(readinessEvents).toContain('CHECKING')
    expect(readinessEvents).toContain('READY')
  })

  it('auto-switches runner when configured runner unavailable but alternative exists', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: false, running: false, available: false, canStart: false },
      { runner: 'podman', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(true)
    vi.mocked(validateImage).mockResolvedValue()

    await containerManager.ensureImageReady()

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('READY')

    // Should have called checkImageExists with the alternative runner
    expect(checkImageExists).toHaveBeenCalledWith('podman', 'test-image')
  })

  it('pulls image after validation rebuild removes Lima image', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'lima', installed: true, running: true, available: true, canStart: true },
    ])
    vi.mocked(checkImageExists)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    vi.mocked(validateImage).mockResolvedValue()
    vi.mocked(canBuildImage).mockReturnValue(false)
    vi.mocked(pullImage).mockResolvedValue()

    await containerManager.ensureImageReady()

    expect(validateImage).toHaveBeenCalledWith('lima', 'test-image')
    expect(pullImage).toHaveBeenCalledWith('lima', 'test-image', expect.any(Function))
    expect(containerManager.getReadiness().status).toBe('READY')
  })

  it('reports RUNTIME_UNAVAILABLE when runner installed but not running and no alternative', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: false, available: false, canStart: false },
    ])

    await containerManager.ensureImageReady()

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('RUNTIME_UNAVAILABLE')
    expect(readiness.message).toContain('not running')
  })

  it('invokes progress callback during pull', async () => {
    vi.mocked(checkAllRunnersAvailability).mockResolvedValue([
      { runner: 'docker', installed: true, running: true, available: true, canStart: false },
    ])
    vi.mocked(checkImageExists).mockResolvedValue(false)
    vi.mocked(canBuildImage).mockReturnValue(false)
    vi.mocked(pullImage).mockImplementation(async (_runner, _image, onProgress) => {
      // Simulate progress callbacks
      if (onProgress) {
        onProgress({ status: 'Layer 1/3', percent: 33, completedLayers: 1, totalLayers: 3 })
        onProgress({ status: 'Layer 2/3', percent: 66, completedLayers: 2, totalLayers: 3 })
        onProgress({ status: 'Layer 3/3', percent: 100, completedLayers: 3, totalLayers: 3 })
      }
    })

    await containerManager.ensureImageReady()

    // Broadcasts should include PULLING_IMAGE with progress
    const broadcasts = vi.mocked(messagePersister.broadcastGlobal).mock.calls
    const pullEvents = broadcasts
      .filter(([msg]: any) => msg.type === 'runtime_readiness_changed' && msg.readiness.status === 'PULLING_IMAGE')

    expect(pullEvents.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// syncAgentStatus — broadcasts on status change
// ============================================================================

describe('containerManager.syncAgentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.clearClients()
  })

  it('updates cached status from runtime', async () => {
    containerManager.getClient('sync-agent')
    containerManager.updateCachedStatus('sync-agent', 'stopped', null)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4005 })

    await containerManager.syncAgentStatus('sync-agent')

    expect(containerManager.getCachedInfo('sync-agent')).toEqual({
      status: 'running',
      port: 4005,
    })
  })

  it('broadcasts status change when runtime status differs from cache', async () => {
    containerManager.getClient('sync-agent')
    containerManager.updateCachedStatus('sync-agent', 'running', 4005)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })

    await containerManager.syncAgentStatus('sync-agent')

    expect(messagePersister.broadcastGlobal).toHaveBeenCalledWith({
      type: 'agent_status_changed',
      agentSlug: 'sync-agent',
      status: 'stopped',
    })
  })

  it('does not broadcast when status has not changed', async () => {
    containerManager.getClient('sync-agent')
    containerManager.updateCachedStatus('sync-agent', 'running', 4005)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4005 })

    await containerManager.syncAgentStatus('sync-agent')

    expect(messagePersister.broadcastGlobal).not.toHaveBeenCalled()
  })

  it('marks sessions inactive when container transitions to stopped', async () => {
    containerManager.getClient('sync-agent')
    containerManager.updateCachedStatus('sync-agent', 'running', 4005)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })

    await containerManager.syncAgentStatus('sync-agent')

    expect(messagePersister.markAllSessionsInactiveForAgent).toHaveBeenCalledWith('sync-agent')
  })
})

// ============================================================================
// resetReadiness — PULLING_IMAGE guard
// ============================================================================

describe('containerManager.resetReadiness', () => {
  it('resets to CHECKING when current status is READY', () => {
    // Set initial state to READY
    ;(containerManager as any)._readiness = {
      status: 'READY',
      message: 'Runtime ready',
      pullProgress: null,
    }

    containerManager.resetReadiness('Restarting...')

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('CHECKING')
    expect(readiness.message).toBe('Restarting...')
  })

  it('resets to CHECKING when current status is ERROR', () => {
    ;(containerManager as any)._readiness = {
      status: 'ERROR',
      message: 'Something failed',
      pullProgress: null,
    }

    containerManager.resetReadiness()

    expect(containerManager.getReadiness().status).toBe('CHECKING')
  })

  it('resets to CHECKING when current status is RUNTIME_UNAVAILABLE', () => {
    ;(containerManager as any)._readiness = {
      status: 'RUNTIME_UNAVAILABLE',
      message: 'No runtime',
      pullProgress: null,
    }

    containerManager.resetReadiness()

    expect(containerManager.getReadiness().status).toBe('CHECKING')
  })

  it('does NOT reset when current status is PULLING_IMAGE', () => {
    const pullProgress = {
      status: '3 of 7 layers',
      percent: 43,
      completedLayers: 3,
      totalLayers: 7,
    }
    ;(containerManager as any)._readiness = {
      status: 'PULLING_IMAGE',
      message: 'Pulling...',
      pullProgress,
    }

    containerManager.resetReadiness('Should be ignored')

    const readiness = containerManager.getReadiness()
    expect(readiness.status).toBe('PULLING_IMAGE')
    expect(readiness.message).toBe('Pulling...')
    expect(readiness.pullProgress).toEqual(pullProgress)
  })

  it('uses default message when none provided', () => {
    ;(containerManager as any)._readiness = {
      status: 'READY',
      message: 'Ready',
      pullProgress: null,
    }

    containerManager.resetReadiness()

    expect(containerManager.getReadiness().message).toBe('Restarting runtime...')
  })
})

// ============================================================================
// stopAll — timeout and error isolation
// ============================================================================

describe('containerManager.stopAll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.clearClients()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops all containers and clears state', async () => {
    containerManager.getClient('agent-1')
    containerManager.getClient('agent-2')
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    containerManager.updateCachedStatus('agent-2', 'running', 4002)
    mockStop.mockResolvedValue({ forceStopUsed: false })
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })

    const promise = containerManager.stopAll()
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(mockStop).toHaveBeenCalledTimes(2)
    // After stopAll, clients and statuses are cleared — getCachedInfo returns default 'stopped'
    expect(containerManager.getCachedInfo('agent-1')).toEqual({ status: 'stopped', port: null })
  })

  it('does not throw when individual container stop fails', async () => {
    containerManager.getClient('agent-1')
    containerManager.getClient('agent-2')
    containerManager.updateCachedStatus('agent-1', 'running', 4001)
    containerManager.updateCachedStatus('agent-2', 'running', 4002)
    // First stop fails, second succeeds
    mockStop.mockRejectedValueOnce(new Error('connection refused'))
    mockStop.mockResolvedValueOnce({ forceStopUsed: false })
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })

    const promise = containerManager.stopAll()
    await vi.advanceTimersByTimeAsync(0)
    // Should not throw
    await expect(promise).resolves.toBeUndefined()
  })

  it('times out individual containers without blocking others', async () => {
    containerManager.getClient('fast-agent')
    containerManager.getClient('slow-agent')
    containerManager.updateCachedStatus('fast-agent', 'running', 4001)
    containerManager.updateCachedStatus('slow-agent', 'running', 4002)

    let callCount = 0
    mockStop.mockImplementation(() => {
      callCount++
      if (callCount === 2) {
        // Second container hangs
        return new Promise(() => {})
      }
      return Promise.resolve({ forceStopUsed: false })
    })
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })

    const promise = containerManager.stopAll()
    // Advance past the 30s timeout (full escalation chain)
    await vi.advanceTimersByTimeAsync(31000)
    await promise

    // Both were attempted
    expect(mockStop).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// stopContainer — forceStopUsed recovery
// ============================================================================

describe('containerManager.stopContainer force stop recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.clearClients()
  })

  it('marks all other running agents as stopped when forceStopUsed', async () => {
    containerManager.getClient('stuck-agent')
    containerManager.getClient('other-agent-1')
    containerManager.getClient('other-agent-2')

    // Simulate other agents as running
    containerManager.updateCachedStatus('stuck-agent', 'running', 4001)
    containerManager.updateCachedStatus('other-agent-1', 'running', 4002)
    containerManager.updateCachedStatus('other-agent-2', 'running', 4003)

    // The stuck agent required force stop
    mockStop.mockResolvedValue({ forceStopUsed: true })

    await containerManager.stopContainer('stuck-agent')

    // All agents should now be stopped
    expect(containerManager.getCachedInfo('stuck-agent')).toEqual({ status: 'stopped', port: null })
    expect(containerManager.getCachedInfo('other-agent-1')).toEqual({ status: 'stopped', port: null })
    expect(containerManager.getCachedInfo('other-agent-2')).toEqual({ status: 'stopped', port: null })

    // Sessions should be marked inactive for all agents
    expect(messagePersister.markAllSessionsInactiveForAgent).toHaveBeenCalledWith('stuck-agent')
    expect(messagePersister.markAllSessionsInactiveForAgent).toHaveBeenCalledWith('other-agent-1')
    expect(messagePersister.markAllSessionsInactiveForAgent).toHaveBeenCalledWith('other-agent-2')
  })

  it('broadcasts agent_status_changed for all affected agents', async () => {
    containerManager.getClient('stuck-agent')
    containerManager.getClient('other-agent')
    containerManager.updateCachedStatus('stuck-agent', 'running', 4001)
    containerManager.updateCachedStatus('other-agent', 'running', 4002)

    mockStop.mockResolvedValue({ forceStopUsed: true })

    await containerManager.stopContainer('stuck-agent')

    const broadcasts = vi.mocked(messagePersister.broadcastGlobal).mock.calls
    const statusEvents = broadcasts
      .filter(([msg]: any) => msg.type === 'agent_status_changed')
      .map(([msg]: any) => ({ agentSlug: msg.agentSlug, status: msg.status }))

    expect(statusEvents).toContainEqual({ agentSlug: 'stuck-agent', status: 'stopped' })
    expect(statusEvents).toContainEqual({ agentSlug: 'other-agent', status: 'stopped' })
  })

  it('broadcasts system_alert when forceStopUsed', async () => {
    containerManager.getClient('stuck-agent')
    containerManager.updateCachedStatus('stuck-agent', 'running', 4001)

    mockStop.mockResolvedValue({ forceStopUsed: true })

    await containerManager.stopContainer('stuck-agent')

    const broadcasts = vi.mocked(messagePersister.broadcastGlobal).mock.calls
    const alertEvents = broadcasts.filter(([msg]: any) => msg.type === 'system_alert')

    expect(alertEvents).toHaveLength(1)
    expect(alertEvents[0][0]).toMatchObject({
      type: 'system_alert',
      level: 'warning',
    })
  })

  it('clears runner availability cache when forceStopUsed', async () => {
    containerManager.getClient('stuck-agent')
    containerManager.updateCachedStatus('stuck-agent', 'running', 4001)

    mockStop.mockResolvedValue({ forceStopUsed: true })

    await containerManager.stopContainer('stuck-agent')

    expect(mockClearRunnerAvailabilityCache).toHaveBeenCalled()
  })

  it('does not trigger recovery when forceStopUsed is false', async () => {
    containerManager.getClient('normal-agent')
    containerManager.getClient('other-agent')
    containerManager.updateCachedStatus('normal-agent', 'running', 4001)
    containerManager.updateCachedStatus('other-agent', 'running', 4002)

    mockStop.mockResolvedValue({ forceStopUsed: false })

    await containerManager.stopContainer('normal-agent')

    // Only the stopped agent should be marked stopped
    expect(containerManager.getCachedInfo('normal-agent')).toEqual({ status: 'stopped', port: null })
    expect(containerManager.getCachedInfo('other-agent')).toEqual({ status: 'running', port: 4002 })

    // No system_alert
    const broadcasts = vi.mocked(messagePersister.broadcastGlobal).mock.calls
    const alertEvents = broadcasts.filter(([msg]: any) => msg.type === 'system_alert')
    expect(alertEvents).toHaveLength(0)

    // No cache clear
    expect(mockClearRunnerAvailabilityCache).not.toHaveBeenCalled()
  })

  it('still cleans up even when stop() throws', async () => {
    containerManager.getClient('error-agent')
    containerManager.updateCachedStatus('error-agent', 'running', 4001)

    mockStop.mockRejectedValue(new Error('unexpected error'))

    await expect(containerManager.stopContainer('error-agent')).rejects.toThrow('unexpected error')

    // Should still be marked as stopped despite the error
    expect(containerManager.getCachedInfo('error-agent')).toEqual({ status: 'stopped', port: null })
    expect(messagePersister.markAllSessionsInactiveForAgent).toHaveBeenCalledWith('error-agent')
  })
})
