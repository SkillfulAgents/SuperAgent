vi.mock('@shared/lib/agent-integrations/mcp', () => ({ integrationMcpProjection: vi.fn(async () => []) }))
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Custom env vars must not override reserved agent runtime env vars
//
// Standalone harness (separate from container-host.test.ts) so it can mock
// getSettings to return `customEnvVars` containing reserved keys. The shared
// test file's getSettings mock returns app:{} with no customEnvVars hook.
// ============================================================================

const mockStart = vi.fn()
const mockStop = vi.fn()
const mockStopSync = vi.fn()
const mockGetInfoFromRuntime = vi.fn()
const mockGetStats = vi.fn()
const mockIsHealthy = vi.fn()
const mockBuildVolumeFlag = vi.fn(
  (hostPath: string, containerPath: string) => `"${hostPath}:${containerPath}"`
)

vi.mock('./client-factory', () => ({
  createContainerClient: () => ({
    start: mockStart,
    stop: mockStop,
    stopSync: mockStopSync,
    getInfoFromRuntime: mockGetInfoFromRuntime,
    getStats: mockGetStats,
    isHealthy: (...args: unknown[]) => mockIsHealthy(...args),
    onFatalResult: () => 'settle',
    observeUnexpectedDeath: async () => ({ action: 'settle' as const }),
    getRuntimeGenerationId: () => null,
    fetch: vi.fn(),
    getHostApiBaseUrl: () => `http://${mockGetContainerHostUrl()}:${mockGetAppPort()}`,
    buildVolumeFlag: (...args: unknown[]) => mockBuildVolumeFlag(...(args as [string, string])),
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

const mockGetOrCreateProxyToken = vi.fn()
vi.mock('@shared/lib/proxy/token-store', () => ({
  getOrCreateProxyToken: (...args: unknown[]) => mockGetOrCreateProxyToken(...args),
}))

const mockGetOrCreateHostToken = vi.fn((..._args: unknown[]) => 'real-host-token')
vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: (...args: unknown[]) => mockGetOrCreateHostToken(...args),
}))

const mockGetContainerHostUrl = vi.fn()
const mockGetAppPort = vi.fn()
vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => mockGetContainerHostUrl(),
  getAppPort: () => mockGetAppPort(),
}))

const mockDbWhere = vi.fn()
const mockDbInnerJoin = vi.fn()
const mockMcpWhere = vi.fn()
const mockMcpInnerJoin = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === 'agent_connected_accounts_table') {
          return { innerJoin: mockDbInnerJoin }
        }
        if (table === 'agent_remote_mcps_table') {
          return { innerJoin: mockMcpInnerJoin }
        }
        return { innerJoin: mockDbInnerJoin }
      }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {
    id: 'id',
    toolkitSlug: 'toolkit_slug',
    providerConnectionId: 'provider_connection_id',
    providerName: 'provider_name',
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

// The reserved-env repro: settings provide customEnvVars that try to clobber
// reserved runtime keys plus one benign key that should pass through.
const mockGetSettings = vi.fn()
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
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

vi.mock('node:fs/promises', () => ({
  statfs: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => false,
}))

const relayState = vi.hoisted(() => ({ available: false }))
vi.mock('@shared/lib/webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/webhook-relay')>()),
  getWebhookRelay: () => ({ snapshot: () => ({ available: relayState.available }) }),
}))

vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: () => 'America/New_York',
}))

const mockGetMountsWithHealth = vi.fn()
vi.mock('@shared/lib/services/mount-service', () => ({
  getMountsWithHealth: (...args: unknown[]) => mockGetMountsWithHealth(...args),
}))

import { containerHost } from './container-host'
import { messagePersister } from './message-persister'
import { createFakeWebhookRelay } from '@shared/lib/webhook-relay/testing/fake-webhook-relay'

describe('ContainerRuntime.ensureRunning — customEnvVars cannot override reserved runtime env vars', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerHost.dropRuntime('test-agent')

    mockGetOrCreateProxyToken.mockResolvedValue('real-proxy-token')
    mockGetContainerHostUrl.mockReturnValue('192.168.1.100')
    mockGetAppPort.mockReturnValue(3000)
    mockGetMountsWithHealth.mockReturnValue([])

    containerHost.runtime('test-agent').updateCachedStatus('stopped', null)
    relayState.available = false
    mockStart.mockResolvedValue(undefined)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 8080 })

    // No connected accounts / MCPs by default
    mockDbInnerJoin.mockReturnValue({ where: mockDbWhere })
    mockDbWhere.mockResolvedValue([])
    mockMcpInnerJoin.mockReturnValue({ where: mockMcpWhere })
    mockMcpWhere.mockResolvedValue([])

    // Settings include customEnvVars that try to clobber reserved keys, plus a
    // benign custom var that should pass through untouched.
    mockGetSettings.mockReturnValue({
      container: { agentImage: 'test-image', containerRunner: 'docker' },
      app: {},
      customEnvVars: {
        PROXY_TOKEN: 'attacker-token',
        PROXY_BASE_URL: 'http://evil.example/api/proxy/spoofed',
        SUPERAGENT_AGENT_SLUG: 'not-the-real-agent',
        SUPERAGENT_HOST_API_URL: 'http://evil.example/api',
        SUPERAGENT_HOST_TOKEN: 'attacker-host-token',
        CONNECTED_ACCOUNTS: '{"gmail":[{"name":"spoof","id":"x"}]}',
        TZ: 'Antarctica/Troll',
        HOST_PLATFORM: 'spoofed-os',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '1',
        WEBHOOK_RELAY_AVAILABLE: 'true',
        MY_CUSTOM: 'foo',
      },
    })
  })

  it('keeps PROXY_TOKEN from getOrCreateProxyToken, not the custom override', async () => {
    await containerHost.runtime('test-agent').ensureRunning()

    expect(mockStart).toHaveBeenCalledOnce()
    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.PROXY_TOKEN).toBe('real-proxy-token')
  })

  it('keeps computed PROXY_BASE_URL / SUPERAGENT_* / CONNECTED_ACCOUNTS', async () => {
    await containerHost.runtime('test-agent').ensureRunning()

    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.PROXY_BASE_URL).toBe('http://192.168.1.100:3000/api/proxy/test-agent')
    expect(envVars.SUPERAGENT_AGENT_SLUG).toBe('test-agent')
    expect(envVars.SUPERAGENT_HOST_API_URL).toBe('http://192.168.1.100:3000/api')
    expect(envVars.SUPERAGENT_HOST_TOKEN).toBe('real-host-token')
    // No active accounts -> empty object, not the spoofed metadata.
    expect(envVars.CONNECTED_ACCOUNTS).toBe('{}')
  })

  it('keeps computed TZ / HOST_PLATFORM / CLAUDE_CODE_ATTRIBUTION_HEADER', async () => {
    await containerHost.runtime('test-agent').ensureRunning()

    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.TZ).toBe('America/New_York')
    expect(envVars.HOST_PLATFORM).toBe(process.platform)
    expect(envVars.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  })

  it('still passes non-reserved custom env vars through unchanged', async () => {
    await containerHost.runtime('test-agent').ensureRunning()

    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.MY_CUSTOM).toBe('foo')
  })
})

describe('ContainerRuntime webhook relay env', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerHost.dropRuntime('test-agent')
    mockGetOrCreateProxyToken.mockResolvedValue('real-proxy-token')
    mockGetContainerHostUrl.mockReturnValue('192.168.1.100')
    mockGetAppPort.mockReturnValue(3000)
    mockGetMountsWithHealth.mockReturnValue([])
    mockStart.mockResolvedValue(undefined)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 8080 })
    mockDbInnerJoin.mockReturnValue({ where: mockDbWhere })
    mockDbWhere.mockResolvedValue([])
    mockMcpInnerJoin.mockReturnValue({ where: mockMcpWhere })
    mockMcpWhere.mockResolvedValue([])
    mockGetSettings.mockReturnValue({ container: { agentImage: 'test-image', containerRunner: 'docker' }, app: {} })
    containerHost.runtime('test-agent').updateCachedStatus('stopped', null)
  })

  async function start(available: boolean) {
    relayState.available = available
    await containerHost.runtime('test-agent').ensureRunning()
    return mockStart.mock.calls.at(-1)![0].envVars as Record<string, string>
  }

  it('sets WEBHOOK_RELAY_AVAILABLE only while the relay can receive webhooks', async () => {
    expect((await start(true)).WEBHOOK_RELAY_AVAILABLE).toBe('true')

    containerHost.runtime('test-agent').updateCachedStatus('stopped', null)
    // Also covers the custom-env clobber: the key is reserved.
    mockGetSettings.mockReturnValue({
      container: { agentImage: 'test-image', containerRunner: 'docker' },
      app: {},
      customEnvVars: { WEBHOOK_RELAY_AVAILABLE: 'true' },
    })
    expect((await start(false)).WEBHOOK_RELAY_AVAILABLE).toBeUndefined()
  })

  it('goes stale when availability moves away from what its env was built with', async () => {
    await start(false)
    const runtime = containerHost.runtime('test-agent')

    containerHost.reconcileWebhookRelay(false)
    expect(runtime.isStale()).toBe(false)

    containerHost.reconcileWebhookRelay(true)
    expect(runtime.isStale()).toBe(true)
  })

  it('assumes a container it did not start matches, until availability moves', () => {
    const runtime = containerHost.runtime('test-agent')
    runtime.updateCachedStatus('running', 8080)

    containerHost.reconcileWebhookRelay(true)
    expect(runtime.isStale()).toBe(false)

    containerHost.reconcileWebhookRelay(false)
    expect(runtime.isStale()).toBe(true)
  })

  it('forgets the start-time availability once stopped', async () => {
    await start(true)
    const runtime = containerHost.runtime('test-agent')
    runtime.updateCachedStatus('stopped', null)
    runtime.updateCachedStatus('running', 8080)

    containerHost.reconcileWebhookRelay(false)
    expect(runtime.isStale()).toBe(false)
  })
})

describe('ContainerHost.watchWebhookRelay', () => {
  it('publishes status changes and marks agents whose webhook tools went out of date', () => {
    containerHost.dropRuntime('test-agent')
    const runtime = containerHost.runtime('test-agent')
    runtime.updateCachedStatus('running', 8080)
    const relay = createFakeWebhookRelay()

    const stop = containerHost.watchWebhookRelay(relay)
    relay.setSnapshot({ available: false, unavailableReason: 'platform_disconnected', transport: 'idle', lastClaimAt: null, lastError: null })
    stop()

    expect(messagePersister.broadcastGlobal).toHaveBeenCalledWith({
      type: 'webhook_relay_changed',
      status: { available: false, unavailableReason: 'platform_disconnected', transport: 'idle', lastClaimAt: null },
    })
    expect(runtime.isStale()).toBe(true)
  })
})
