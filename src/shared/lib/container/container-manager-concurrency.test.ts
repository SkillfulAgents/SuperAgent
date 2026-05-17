import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing container-manager
// ============================================================================

let startDelay = 0
let startResolvers: Array<() => void> = []

const mockStart = vi.fn().mockImplementation(() => {
  if (startDelay > 0) {
    return new Promise<void>((resolve) => {
      startResolvers.push(resolve)
      setTimeout(resolve, startDelay)
    })
  }
  return new Promise<void>((resolve) => {
    startResolvers.push(resolve)
  })
})

const mockStop = vi.fn().mockResolvedValue({ forceStopUsed: false })
const mockGetInfoFromRuntime = vi.fn()
const mockGetStats = vi.fn()
const mockBuildVolumeFlag = vi.fn((hostPath: string, containerPath: string) => `"${hostPath}:${containerPath}"`)

vi.mock('./client-factory', () => ({
  createContainerClient: () => ({
    start: (...args: unknown[]) => mockStart(...args),
    stop: mockStop,
    stopSync: vi.fn(),
    getInfoFromRuntime: (...args: unknown[]) => mockGetInfoFromRuntime(...args),
    getStats: mockGetStats,
    fetch: vi.fn(),
    buildVolumeFlag: (...args: unknown[]) => mockBuildVolumeFlag(...args as [string, string]),
    createSession: vi.fn(),
  }),
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

vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => '127.0.0.1',
  getAppPort: () => 3000,
}))

const mockDbWhere = vi.fn().mockResolvedValue([])
const mockDbInnerJoin = vi.fn().mockReturnValue({ where: mockDbWhere })

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: mockDbInnerJoin }),
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
  healthMonitor: { checkAll: vi.fn().mockReturnValue([]) },
}))

vi.mock('@shared/lib/browser/chrome-profile', () => ({
  copyChromeProfileData: vi.fn().mockReturnValue(false),
}))

vi.mock('@shared/lib/services/agent-service', () => ({}))

vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => false,
}))

vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: () => 'UTC',
}))

vi.mock('@shared/lib/services/mount-service', () => ({
  getMountsWithHealth: () => [],
}))

import { containerManager } from './container-manager'

// ============================================================================
// Concurrent ensureRunning — race conditions
// ============================================================================

describe('containerManager.ensureRunning — concurrent call safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    startDelay = 0
    containerManager.removeClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
  })

  it('concurrent ensureRunning calls for the same stopped agent only start once', async () => {
    // start() will hang until we manually resolve it
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    const p1 = containerManager.ensureRunning('test-agent')
    const p2 = containerManager.ensureRunning('test-agent')
    const p3 = containerManager.ensureRunning('test-agent')

    // Resolve the single start call
    await vi.waitFor(() => expect(startResolvers).toHaveLength(1))
    startResolvers[0]()

    await Promise.all([p1, p2, p3])

    // start() was only called once despite 3 concurrent ensureRunning calls
    expect(mockStart).toHaveBeenCalledTimes(1)
  })

  it('all concurrent callers receive the same client', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    const p1 = containerManager.ensureRunning('test-agent')
    const p2 = containerManager.ensureRunning('test-agent')

    await vi.waitFor(() => expect(startResolvers).toHaveLength(1))
    startResolvers[0]()

    const [client1, client2] = await Promise.all([p1, p2])

    expect(client1).toBe(client2)
  })

  it('if start() rejects, all concurrent callers receive the error', async () => {
    const startError = new Error('Docker daemon not running')
    mockStart.mockRejectedValue(startError)

    const p1 = containerManager.ensureRunning('test-agent')
    const p2 = containerManager.ensureRunning('test-agent')

    await expect(p1).rejects.toThrow('Docker daemon not running')
    await expect(p2).rejects.toThrow('Docker daemon not running')

    expect(mockStart).toHaveBeenCalledTimes(1)
  })

  it('after a failed start, subsequent ensureRunning calls retry', async () => {
    // First attempt fails
    mockStart.mockRejectedValueOnce(new Error('Docker daemon not running'))

    await expect(containerManager.ensureRunning('test-agent')).rejects.toThrow()

    // Second attempt should try again (not re-use the failed promise)
    mockStart.mockResolvedValueOnce(undefined)
    const client = await containerManager.ensureRunning('test-agent')

    expect(client).toBeDefined()
    expect(mockStart).toHaveBeenCalledTimes(2)
  })

  it('different agents can start concurrently without interference', async () => {
    containerManager.removeClient('agent-a')
    containerManager.removeClient('agent-b')
    containerManager.updateCachedStatus('agent-a', 'stopped', null)
    containerManager.updateCachedStatus('agent-b', 'stopped', null)

    const resolvers: Record<string, () => void> = {}
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      resolvers[mockStart.mock.calls.length === 1 ? 'a' : 'b'] = resolve
    }))

    const pA = containerManager.ensureRunning('agent-a')
    const pB = containerManager.ensureRunning('agent-b')

    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(2))

    resolvers['a']()
    resolvers['b']()

    await Promise.all([pA, pB])

    expect(mockStart).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// Pre-warm race: onConnectionError updates cache mid-start
// ============================================================================

describe('containerManager.ensureRunning — pre-warm cache race', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    containerManager.removeClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
  })

  it('second ensureRunning waits for in-flight start even if cached status is updated to running', async () => {
    // Simulate: start() is in progress (container booting)
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    // First call (pre-warm) begins starting
    const p1 = containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Simulate onConnectionError -> syncAgentStatus updating cache to 'running'
    // This is what happens in the real race: Docker reports the container process
    // as running before the HTTP server inside is ready
    containerManager.updateCachedStatus('test-agent', 'running', 4001)

    // Second call (message handler) should NOT return immediately
    // despite cached status being 'running' — it should wait for the start to complete
    const p2 = containerManager.ensureRunning('test-agent')

    // At this point, start hasn't finished yet. Verify the second promise is still pending.
    let p2Resolved = false
    p2.then(() => { p2Resolved = true })
    await Promise.resolve() // flush microtasks
    expect(p2Resolved).toBe(false)

    // Now complete the start
    startResolvers[0]()
    await Promise.all([p1, p2])

    // start was called only once
    expect(mockStart).toHaveBeenCalledTimes(1)
  })

  it('onConnectionError does not update cache while start is in-flight', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    // Begin starting
    containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Simulate what onConnectionError does: calls syncAgentStatus which
    // calls getInfoFromRuntime then updateCachedStatus.
    // The fix should prevent this from updating cache during startup.
    // We directly call syncAgentStatus here to simulate the race.
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    await containerManager.syncAgentStatus('test-agent')

    // After the sync, the cache should NOT say 'running' because start is still in-flight
    const info = containerManager.getCachedInfo('test-agent')
    expect(info.status).toBe('stopped')

    // Cleanup: resolve start
    startResolvers[0]()
  })

  it('after start completes, syncAgentStatus updates cache normally', async () => {
    mockStart.mockResolvedValue(undefined)

    await containerManager.ensureRunning('test-agent')

    // Now syncAgentStatus should work normally
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4002 })
    await containerManager.syncAgentStatus('test-agent')

    const info = containerManager.getCachedInfo('test-agent')
    expect(info.status).toBe('running')
    expect(info.port).toBe(4002)
  })

  it('second ensureRunning during inflight start does not trigger a new start', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    containerManager.updateCachedStatus('test-agent', 'stopped', null)

    // First call starts the container
    const p1 = containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Simulate onConnectionError updating cache to 'running' mid-start
    containerManager.updateCachedStatus('test-agent', 'running', 4001)

    // Second call should either join inflight OR not trigger a new start
    const p2 = containerManager.ensureRunning('test-agent')

    // Resolve start
    startResolvers[0]()
    await Promise.all([p1, p2])

    // The key invariant: start() was only called once
    expect(mockStart).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// ensureRunning when already running — no-op
// ============================================================================

describe('containerManager.ensureRunning — already running', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    containerManager.removeClient('test-agent')
  })

  it('does not call start when cached status is running and no inflight start', async () => {
    containerManager.updateCachedStatus('test-agent', 'running', 4001)

    const client = await containerManager.ensureRunning('test-agent')

    expect(client).toBeDefined()
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('returns quickly when already running (no blocking)', async () => {
    containerManager.updateCachedStatus('test-agent', 'running', 4001)

    const start = Date.now()
    await containerManager.ensureRunning('test-agent')
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(50)
  })
})

// ============================================================================
// Sequential starts after completion — fresh start allowed
// ============================================================================

describe('containerManager.ensureRunning — sequential restarts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    containerManager.removeClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    mockStart.mockResolvedValue(undefined)
  })

  it('allows a new start after previous ensureRunning completed', async () => {
    await containerManager.ensureRunning('test-agent')
    expect(mockStart).toHaveBeenCalledTimes(1)

    // Simulate container stopped
    containerManager.updateCachedStatus('test-agent', 'stopped', null)

    await containerManager.ensureRunning('test-agent')
    expect(mockStart).toHaveBeenCalledTimes(2)
  })

  it('inflight promise is cleaned up after successful start', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    const p1 = containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(startResolvers).toHaveLength(1))
    startResolvers[0]()
    await p1

    // The inflight promise should be gone — a new call with 'stopped' status should start fresh
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    startResolvers = []
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    const p2 = containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(startResolvers).toHaveLength(1))
    startResolvers[0]()
    await p2

    expect(mockStart).toHaveBeenCalledTimes(2)
  })

  it('inflight promise is cleaned up after failed start', async () => {
    mockStart.mockRejectedValueOnce(new Error('fail'))

    await expect(containerManager.ensureRunning('test-agent')).rejects.toThrow('fail')

    // Should be able to retry
    mockStart.mockResolvedValueOnce(undefined)
    await containerManager.ensureRunning('test-agent')
    expect(mockStart).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// stopContainer during in-flight start
// ============================================================================

describe('containerManager — stopContainer during in-flight start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    containerManager.removeClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    mockStop.mockResolvedValue({ forceStopUsed: false })
  })

  it('stopContainer clears the inflight promise', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    // Begin starting
    const startPromise = containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Stop while start is in-flight
    await containerManager.stopContainer('test-agent')

    // A new ensureRunning should NOT join the old (now orphaned) promise
    // — it should attempt a fresh start
    mockStart.mockResolvedValueOnce(undefined)
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    const client = await containerManager.ensureRunning('test-agent')

    expect(client).toBeDefined()
    expect(mockStart).toHaveBeenCalledTimes(2)

    // Clean up dangling promise
    startResolvers[0]?.()
    await startPromise.catch(() => {})
  })

  it('removeClient clears the inflight promise', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    const startPromise = containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Remove client while start is in-flight
    containerManager.removeClient('test-agent')

    // New ensureRunning creates a fresh client and starts fresh
    mockStart.mockResolvedValueOnce(undefined)
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    const client = await containerManager.ensureRunning('test-agent')

    expect(client).toBeDefined()
    expect(mockStart).toHaveBeenCalledTimes(2)

    // Clean up
    startResolvers[0]?.()
    await startPromise.catch(() => {})
  })
})

// ============================================================================
// syncAllStatuses interaction with in-flight start
// ============================================================================

describe('containerManager — syncAllStatuses during in-flight start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    containerManager.removeClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
  })

  it('syncAllStatuses does not update cache for an agent with in-flight start', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    // Begin starting
    containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Periodic sync fires — Docker reports "running" but we should ignore it
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    await containerManager.syncAllStatuses()

    // Cache should still be 'stopped' — the sync was suppressed
    const info = containerManager.getCachedInfo('test-agent')
    expect(info.status).toBe('stopped')

    // Complete start — NOW the cache should update
    startResolvers[0]()
    // Need to wait for the ensureRunning promise to settle
    await vi.waitFor(() => {
      const updated = containerManager.getCachedInfo('test-agent')
      expect(updated.status).toBe('running')
    })
  })

  it('syncAllStatuses still updates cache for OTHER agents not currently starting', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    // Set up a second agent that's already running
    containerManager.getClient('other-agent')
    containerManager.updateCachedStatus('other-agent', 'running', 4002)

    // Begin starting test-agent
    containerManager.ensureRunning('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Sync — Docker reports other-agent stopped (crashed externally)
    mockGetInfoFromRuntime.mockImplementation(async () => {
      return { status: 'stopped', port: null }
    })
    await containerManager.syncAllStatuses()

    // test-agent: still 'stopped' (suppressed)
    expect(containerManager.getCachedInfo('test-agent').status).toBe('stopped')
    // other-agent: updated to 'stopped' (not suppressed)
    expect(containerManager.getCachedInfo('other-agent').status).toBe('stopped')

    // Cleanup
    startResolvers[0]?.()
  })
})

// ============================================================================
// restartContainer — stop then start interaction
// ============================================================================

describe('containerManager — restartContainer with concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    containerManager.removeClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'running', 4001)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4002 })
    mockStop.mockResolvedValue({ forceStopUsed: false })
    mockStart.mockResolvedValue(undefined)
  })

  it('restartContainer works cleanly (stop clears inflight, then fresh start)', async () => {
    const client = await containerManager.restartContainer('test-agent')

    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(client).toBeDefined()
  })

  it('concurrent ensureRunning during restartContainer joins the restart start', async () => {
    mockStart.mockImplementation(() => new Promise<void>((resolve) => {
      startResolvers.push(resolve)
    }))

    // restartContainer: stop completes, then starts — but start hangs
    const restartPromise = containerManager.restartContainer('test-agent')
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Concurrent ensureRunning while restart's start is in-flight
    const p2 = containerManager.ensureRunning('test-agent')

    // Both should resolve when start completes
    startResolvers[0]()
    const [client1, client2] = await Promise.all([restartPromise, p2])

    expect(client1).toBe(client2)
    expect(mockStart).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// getInfoFromRuntime failure after successful start
// ============================================================================

describe('containerManager — post-start getInfoFromRuntime failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResolvers = []
    containerManager.removeClient('test-agent')
    containerManager.updateCachedStatus('test-agent', 'stopped', null)
  })

  it('if getInfoFromRuntime fails after start(), ensureRunning rejects and cleans up', async () => {
    mockStart.mockResolvedValue(undefined)
    mockGetInfoFromRuntime.mockRejectedValue(new Error('docker inspect failed'))

    await expect(containerManager.ensureRunning('test-agent')).rejects.toThrow('docker inspect failed')

    // Inflight promise should be cleaned up — retry should work
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    const client = await containerManager.ensureRunning('test-agent')
    expect(client).toBeDefined()
    expect(mockStart).toHaveBeenCalledTimes(2)
  })
})
