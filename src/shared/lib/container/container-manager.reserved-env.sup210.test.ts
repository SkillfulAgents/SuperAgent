import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// SUP-210 — Custom env vars must not override reserved agent runtime env vars
//
// Standalone harness (separate from container-manager.test.ts) so it can mock
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

vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: () => 'America/New_York',
}))

const mockGetMountsWithHealth = vi.fn()
vi.mock('@shared/lib/services/mount-service', () => ({
  getMountsWithHealth: (...args: unknown[]) => mockGetMountsWithHealth(...args),
}))

import { containerManager } from './container-manager'

describe('SUP-210 — customEnvVars cannot override reserved runtime env vars', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    containerManager.removeClient('test-agent')

    mockGetOrCreateProxyToken.mockResolvedValue('real-proxy-token')
    mockGetContainerHostUrl.mockReturnValue('192.168.1.100')
    mockGetAppPort.mockReturnValue(3000)
    mockGetMountsWithHealth.mockReturnValue([])

    containerManager.updateCachedStatus('test-agent', 'stopped', null)
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
        CONNECTED_ACCOUNTS: '{"gmail":[{"name":"spoof","id":"x"}]}',
        TZ: 'Antarctica/Troll',
        HOST_PLATFORM: 'spoofed-os',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '1',
        MY_CUSTOM: 'foo',
      },
    })
  })

  it('keeps PROXY_TOKEN from getOrCreateProxyToken, not the custom override', async () => {
    await containerManager.ensureRunning('test-agent')

    expect(mockStart).toHaveBeenCalledOnce()
    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.PROXY_TOKEN).toBe('real-proxy-token')
  })

  it('keeps computed PROXY_BASE_URL / SUPERAGENT_* / CONNECTED_ACCOUNTS', async () => {
    await containerManager.ensureRunning('test-agent')

    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.PROXY_BASE_URL).toBe('http://192.168.1.100:3000/api/proxy/test-agent')
    expect(envVars.SUPERAGENT_AGENT_SLUG).toBe('test-agent')
    expect(envVars.SUPERAGENT_HOST_API_URL).toBe('http://192.168.1.100:3000/api')
    // No active accounts -> empty object, not the spoofed metadata.
    expect(envVars.CONNECTED_ACCOUNTS).toBe('{}')
  })

  it('keeps computed TZ / HOST_PLATFORM / CLAUDE_CODE_ATTRIBUTION_HEADER', async () => {
    await containerManager.ensureRunning('test-agent')

    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.TZ).toBe('America/New_York')
    expect(envVars.HOST_PLATFORM).toBe(process.platform)
    expect(envVars.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  })

  it('still passes non-reserved custom env vars through unchanged', async () => {
    await containerManager.ensureRunning('test-agent')

    const envVars = mockStart.mock.calls[0][0].envVars
    expect(envVars.MY_CUSTOM).toBe('foo')
  })
})
