import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContainerConfig } from './types'

// ============================================================================
// Mocks — must be set up before importing container-host
// ============================================================================

/** The config the runtime handed the client factory: its callbacks are what a
 *  client keeps calling after the runtime has been dropped. */
let lastConfig: ContainerConfig | undefined
const mockStart = vi.fn().mockResolvedValue(undefined)
const mockStop = vi.fn().mockResolvedValue({ forceStopUsed: false })

vi.mock('./client-factory', () => ({
  createContainerClient: (config: ContainerConfig) => {
    lastConfig = config
    return {
      start: mockStart,
      stop: mockStop,
      stopSync: vi.fn(),
      getInfoFromRuntime: vi.fn().mockResolvedValue({ status: 'running', port: 4001 }),
      getStats: vi.fn(),
      fetch: vi.fn(),
      getHostApiBaseUrl: () => 'http://127.0.0.1:3000',
      buildVolumeFlag: (hostPath: string, containerPath: string) => `"${hostPath}:${containerPath}"`,
      createSession: vi.fn(),
      onFatalResult: () => 'settle',
      observeUnexpectedDeath: async () => ({ action: 'settle' as const }),
      getRuntimeGenerationId: () => null,
    }
  },
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
    setUnexpectedDeathCallback: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
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

import { containerHost } from './container-host'

// ============================================================================
// A dropped runtime is inert
//
// The persister keeps the client a runtime handed out (stream subscriptions,
// input settlement) and the client keeps calling the runtime's callbacks.
// Dropping the runtime used to reset its `stopping`/`starting` guards, so a
// container dying after an eviction — the delete route stops it through a
// fresh runtime — ran unexpected-death recovery through the dropped one.
// ============================================================================

describe('ContainerRuntime after dropRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastConfig = undefined
    containerHost.dropRuntime('agent-x')
  })

  it("a live runtime's client callback triggers recovery (control)", () => {
    const runtime = containerHost.runtime('agent-x')
    runtime.getClient()
    const recover = vi.spyOn(runtime, 'handleUnexpectedDeath').mockImplementation(() => {})

    lastConfig!.onConnectionError!()

    expect(recover).toHaveBeenCalledTimes(1)
  })

  it("a dropped runtime ignores its old client's connection error and restart", async () => {
    const runtime = containerHost.runtime('agent-x')
    runtime.getClient()
    const recover = vi.spyOn(runtime, 'handleUnexpectedDeath')
    const oldConfig = lastConfig!

    containerHost.dropRuntime('agent-x')

    oldConfig.onConnectionError!()
    await oldConfig.restartAgent!()

    expect(recover).not.toHaveBeenCalled()
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('the host hands out a fresh runtime whose own callbacks still work', () => {
    const dropped = containerHost.runtime('agent-x')
    dropped.getClient()
    containerHost.dropRuntime('agent-x')

    const fresh = containerHost.runtime('agent-x')
    expect(fresh).not.toBe(dropped)
    fresh.getClient()
    const recover = vi.spyOn(fresh, 'handleUnexpectedDeath').mockImplementation(() => {})

    lastConfig!.onConnectionError!()

    expect(recover).toHaveBeenCalledTimes(1)
  })
})
