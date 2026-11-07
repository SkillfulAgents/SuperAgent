vi.mock('@shared/lib/account-providers/provider-factory', () => ({
  getDefaultAccountProvider: () => ({ name: 'composio' }),
}))
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing container-host
// ============================================================================

const mockStop = vi.fn().mockResolvedValue({ forceStopUsed: false })

vi.mock('./client-factory', () => ({
  createContainerClient: () => ({
    start: vi.fn(),
    stop: mockStop,
    stopSync: vi.fn(),
    getInfoFromRuntime: vi.fn().mockResolvedValue({ status: 'stopped', port: null }),
    getStats: vi.fn(),
    fetch: vi.fn(async () => new Response(null, { status: 404 })),
    getHostApiBaseUrl: () => 'http://127.0.0.1:3000',
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

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ container: { agentImage: 'test-image', containerRunner: 'docker' }, app: {} }),
  updateSettings: vi.fn(),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getAgentWorkspaceDir: (id: string) => `/workspace/${id}`,
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
  listVolumes: async () => ({ volumes: [], notMounted: [] }),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))

import { finalizeAutomationStatus } from '@shared/lib/services/session-service'
import { containerHost } from './container-host'
import { resetRuntimeRecoveryForTests } from './runtime-recovery'
import { attachLiveSessionsHarness, createStreamClient } from '@shared/lib/agent-actor/testing/live-sessions-harness'

// ============================================================================
// A deliberate stop is a stop, not a crash
//
// Stopping the container (the agent's Stop, a restart, app shutdown) drops
// every session's socket while the container goes down. A session mid-turn
// ends as the user's Stop ends one, not as a runtime that died under it.
// ============================================================================

const SLUG = 'agent-stop'
const SESSION = 'session-1'
const live = attachLiveSessionsHarness()

describe('ContainerRuntime.stopContainer with a session mid-turn', () => {
  beforeEach(() => {
    containerHost.dropRuntime(SLUG)
    containerHost.attachAgentSessions({ peek: (slug) => (slug === SLUG ? live.sessions(SLUG) : undefined) })
  })

  afterEach(() => {
    containerHost.attachAgentSessions(null)
    containerHost.dropRuntime(SLUG)
    live.reset()
    resetRuntimeRecoveryForTests()
    vi.clearAllMocks()
  })

  it('ends the turn as stopped, with no crash error, when the socket drops during the stop', async () => {
    const runtime = containerHost.runtime(SLUG)
    runtime.updateCachedStatus('running', 4001)
    // The sessions reach the runtime's own recovery, as the actor wires them.
    live.runtime.unexpectedDeath.mockImplementation((sessionId) => runtime.handleUnexpectedDeath(sessionId ? [sessionId] : undefined))
    const stream = createStreamClient()
    await live.sessions(SLUG).subscribe(SESSION, stream, SESSION)
    stream.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
    live.sessions(SLUG).markActive(SESSION)
    const { events } = live.collect(SLUG, SESSION)
    // The container goes down mid-turn: its socket closes before the stop returns.
    mockStop.mockImplementationOnce(async () => {
      stream.emit({ type: 'connection_closed' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { forceStopUsed: false }
    })

    await runtime.stopContainer()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(events.filter((event) => event.type === 'session_error')).toEqual([])
    expect(events.filter((event) => event.type === 'session_idle')).toEqual([
      expect.objectContaining({ isActive: false, outcome: 'cancelled' }),
    ])
    expect(live.sessions(SLUG).isActive(SESSION)).toBe(false)
    expect(live.sessions(SLUG).turnOutcome(SESSION)).toMatchObject({ status: 'cancelled' })
  })

  it('records an automation the stop cut short as failed: its run did not finish', async () => {
    const runtime = containerHost.runtime(SLUG)
    runtime.updateCachedStatus('running', 4001)
    const stream = createStreamClient()
    await live.sessions(SLUG).subscribe(SESSION, stream, SESSION)
    live.sessions(SLUG).markActive(SESSION)

    await runtime.stopContainer()

    expect(finalizeAutomationStatus).toHaveBeenCalledWith(expect.objectContaining({ slug: SLUG }), SESSION, 'failed')
  })

  it('leaves a session mid-turn to the crash path when a fatal error takes the container down', async () => {
    const runtime = containerHost.runtime(SLUG)
    runtime.updateCachedStatus('running', 4001)
    const stream = createStreamClient()
    await live.sessions(SLUG).subscribe(SESSION, stream, SESSION)
    live.sessions(SLUG).markActive(SESSION)
    const { events } = live.collect(SLUG, SESSION)

    await runtime.stopContainer({ afterFatalError: true })

    expect(events.filter((event) => event.type === 'session_idle')).toEqual([])
    expect(events.filter((event) => event.type === 'session_error')).toEqual([
      expect.objectContaining({ terminalReason: 'connection_lost', isActive: false }),
    ])
  })
})
