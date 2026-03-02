import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing container-manager
// ============================================================================

const mockStart = vi.fn()
const mockStop = vi.fn()
const mockStopSync = vi.fn()
const mockGetInfoFromRuntime = vi.fn()
const mockGetStats = vi.fn()

vi.mock('./client-factory', () => ({
  createContainerClient: () => ({
    start: mockStart,
    stop: mockStop,
    stopSync: mockStopSync,
    getInfoFromRuntime: mockGetInfoFromRuntime,
    getStats: mockGetStats,
    fetch: vi.fn(),
  }),
  checkAllRunnersAvailability: vi.fn().mockResolvedValue([]),
  checkImageExists: vi.fn().mockResolvedValue(true),
  pullImage: vi.fn(),
  canBuildImage: vi.fn().mockReturnValue(false),
  buildImage: vi.fn(),
  startRunner: vi.fn(),
  refreshRunnerAvailability: vi.fn(),
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

import { containerManager } from './container-manager'

describe('containerManager.ensureRunning — env var construction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear internal state by removing the client
    containerManager.removeClient('test-agent')

    mockGetOrCreateProxyToken.mockResolvedValue('synth-token-123')
    mockGetContainerHostUrl.mockReturnValue('192.168.1.100')
    mockGetAppPort.mockReturnValue(3000)

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
})
