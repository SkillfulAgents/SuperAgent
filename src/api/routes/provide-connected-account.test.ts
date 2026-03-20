import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ============================================================================
// Mock all dependencies that agents.ts imports
// ============================================================================

// Auth middleware — passthrough
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

// Container manager
const mockContainerFetch = vi.fn()
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({
      fetch: (...args: unknown[]) => mockContainerFetch(...args),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    ensureRunning: vi.fn(),
    getCachedInfo: () => ({ status: 'running', port: 8080 }),
  },
}))

// Message persister
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(),
    persistMessage: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
  },
}))

// DB mocks
const mockSelectFrom = vi.fn()
const mockSelectWhere = vi.fn()
const mockInsertValues = vi.fn()
const mockInnerJoin = vi.fn()
const mockInnerJoinWhere = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockSelectFrom }),
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {
    id: 'id',
    toolkitSlug: 'toolkit_slug',
    userId: 'user_id',
    status: 'status',
    displayName: 'display_name',
    composioConnectionId: 'composio_connection_id',
  },
  agentConnectedAccounts: {
    id: 'id',
    agentSlug: 'agent_slug',
    connectedAccountId: 'connected_account_id',
  },
  proxyAuditLog: {},
  remoteMcpServers: {},
  agentRemoteMcps: {},
  mcpAuditLog: {},
  agentAcl: {},
  user: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
  inArray: (col: string, vals: string[]) => ({ col, vals }),
  desc: (col: string) => ({ col }),
  count: () => 'count',
  like: (col: string, val: string) => ({ col, val }),
  or: (...args: unknown[]) => args,
}))

// Auth
const mockIsAuthMode = vi.fn().mockReturnValue(false)
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => 'test-user-id',
}))

// Services (not used by this handler but imported by agents.ts)
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(),
  createAgent: vi.fn(),
  getAgentWithStatus: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  agentExists: vi.fn().mockResolvedValue(true),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: vi.fn(),
  updateSessionName: vi.fn(),
  registerSession: vi.fn(),
  getSessionMessagesWithCompact: vi.fn(),
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(),
  deleteSession: vi.fn(),
  removeMessage: vi.fn(),
  removeToolCall: vi.fn(),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  listSecrets: vi.fn(),
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  keyToEnvVar: vi.fn(),
  getSecretEnvVars: vi.fn(),
}))

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listScheduledTasks: vi.fn(),
  listPendingScheduledTasks: vi.fn(),
}))

vi.mock('@shared/lib/composio/providers', () => ({
  getProvider: vi.fn(),
}))

vi.mock('@shared/lib/services/skillset-service', () => ({
  getAgentSkillsWithStatus: vi.fn(),
  getDiscoverableSkills: vi.fn(),
  installSkillFromSkillset: vi.fn(),
  updateSkillFromSkillset: vi.fn(),
  createSkillPR: vi.fn(),
  getSkillPRInfo: vi.fn(),
  getSkillPublishInfo: vi.fn(),
  publishSkillToSkillset: vi.fn(),
  refreshAgentSkills: vi.fn(),
}))

vi.mock('@shared/lib/services/artifact-service', () => ({
  listArtifactsFromFilesystem: vi.fn(),
}))

vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => 'localhost',
  getAppPort: () => 3000,
}))

vi.mock('@shared/lib/services/agent-template-service', () => ({
  exportAgentTemplate: vi.fn(),
  importAgentFromTemplate: vi.fn(),
  installAgentFromSkillset: vi.fn(),
  updateAgentFromSkillset: vi.fn(),
  getAgentTemplateStatus: vi.fn(),
  getDiscoverableAgents: vi.fn(),
  refreshSkillsetCaches: vi.fn(),
  getAgentPRInfo: vi.fn(),
  createAgentPR: vi.fn(),
  getAgentPublishInfo: vi.fn(),
  publishAgentToSkillset: vi.fn(),
  refreshAgentTemplates: vi.fn(),
  hasOnboardingSkill: vi.fn(),
  collectAgentRequiredEnvVars: vi.fn(),
}))

vi.mock('@shared/lib/utils/retry', () => ({
  withRetry: vi.fn(),
}))

vi.mock('@shared/lib/utils/message-transform', () => ({
  transformMessages: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({}),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {} }),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  revokeProxyToken: vi.fn(),
  validateProxyToken: vi.fn(),
}))

vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: vi.fn(),
  readFileOrNull: vi.fn(),
  getAgentSessionsDir: vi.fn(),
  readJsonlFile: vi.fn(),
  getAgentWorkspaceDir: vi.fn(),
}))

// Import the agents router after all mocks are set up
import agents from './agents'

function createApp() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

describe('provide-connected-account handler', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockInsertValues.mockResolvedValue(undefined)
  })

  const ENDPOINT = '/api/agents/test-agent/sessions/sess-1/provide-connected-account'

  async function postJson(body: unknown): Promise<Response> {
    return app.request(`http://localhost${ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns 400 when toolUseId is missing', async () => {
    const res = await postJson({ toolkit: 'gmail', accountIds: ['acc-1'] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('toolUseId')
  })

  it('returns 400 when toolkit is missing', async () => {
    const res = await postJson({ toolUseId: 'tu-1', accountIds: ['acc-1'] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('toolkit')
  })

  it('decline flow → calls container /inputs/{toolUseId}/reject with reason', async () => {
    mockContainerFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })

    const res = await postJson({
      toolUseId: 'tu-decline-1',
      toolkit: 'gmail',
      decline: true,
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.declined).toBe(true)

    expect(mockContainerFetch).toHaveBeenCalledOnce()
    const [path, opts] = mockContainerFetch.mock.calls[0]
    expect(path).toBe('/inputs/tu-decline-1/reject')
    expect(opts.method).toBe('POST')
    const reqBody = JSON.parse(opts.body)
    expect(reqBody.reason).toBe('User declined to provide access')
  })

  it('decline with custom declineReason', async () => {
    mockContainerFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })

    const res = await postJson({
      toolUseId: 'tu-decline-2',
      toolkit: 'gmail',
      decline: true,
      declineReason: 'No suitable accounts available',
    })

    expect(res.status).toBe(200)
    const reqBody = JSON.parse(mockContainerFetch.mock.calls[0][1].body)
    expect(reqBody.reason).toBe('No suitable accounts available')
  })

  it('returns 400 when accountIds empty and not declining', async () => {
    const res = await postJson({
      toolUseId: 'tu-1',
      toolkit: 'gmail',
      accountIds: [],
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('accountIds')
  })

  it('returns 400 when no valid accounts found in DB', async () => {
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere })
    mockSelectWhere.mockResolvedValue([])

    const res = await postJson({
      toolUseId: 'tu-1',
      toolkit: 'gmail',
      accountIds: ['acc-nonexistent'],
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('No valid accounts')
  })

  it('returns 400 when accounts do not match requested toolkit', async () => {
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere })
    mockSelectWhere.mockResolvedValue([
      { id: 'acc-1', toolkitSlug: 'slack', displayName: 'My Slack', status: 'active' },
    ])

    const res = await postJson({
      toolUseId: 'tu-1',
      toolkit: 'gmail',
      accountIds: ['acc-1'],
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("toolkit 'gmail'")
  })

  it('happy path: inserts mappings, updates container /env, resolves /inputs', async () => {
    // DB call 1: select accounts by IDs
    mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere })
    mockSelectWhere.mockResolvedValueOnce([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' },
    ])

    // DB: insert account mapping
    mockInsertValues.mockResolvedValue(undefined)

    // DB call 2: select all mappings (for metadata) — uses innerJoin
    mockSelectFrom.mockReturnValueOnce({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockInnerJoinWhere })
    mockInnerJoinWhere.mockResolvedValue([
      { account: { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' } },
    ])

    // Container: env update
    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })

    // Container: resolve input
    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })

    const res = await postJson({
      toolUseId: 'tu-happy',
      toolkit: 'gmail',
      accountIds: ['acc-1'],
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.accountsProvided).toBe(1)

    // Verify insert was called
    expect(mockInsertValues).toHaveBeenCalled()

    // Verify container env update
    expect(mockContainerFetch).toHaveBeenCalledTimes(2)
    const [envPath, envOpts] = mockContainerFetch.mock.calls[0]
    expect(envPath).toBe('/env')
    const envBody = JSON.parse(envOpts.body)
    expect(envBody.key).toBe('CONNECTED_ACCOUNTS')
    const metadata = JSON.parse(envBody.value)
    expect(metadata.gmail).toEqual([{ name: 'user@gmail.com', id: 'acc-1' }])

    // Verify resolve call
    const [resolvePath] = mockContainerFetch.mock.calls[1]
    expect(resolvePath).toBe('/inputs/tu-happy/resolve')
  })

  it('duplicate mapping insert errors are silently ignored', async () => {
    mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere })
    mockSelectWhere.mockResolvedValueOnce([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' },
    ])

    // Insert throws a duplicate error
    mockInsertValues.mockRejectedValue(new Error('UNIQUE constraint failed'))

    mockSelectFrom.mockReturnValueOnce({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockInnerJoinWhere })
    mockInnerJoinWhere.mockResolvedValue([
      { account: { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' } },
    ])

    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })
    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })

    const res = await postJson({
      toolUseId: 'tu-dup',
      toolkit: 'gmail',
      accountIds: ['acc-1'],
    })

    // Should still succeed despite insert error
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('returns 500 when container /env update fails', async () => {
    mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere })
    mockSelectWhere.mockResolvedValueOnce([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' },
    ])

    mockInsertValues.mockResolvedValue(undefined)

    mockSelectFrom.mockReturnValueOnce({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockInnerJoinWhere })
    mockInnerJoinWhere.mockResolvedValue([
      { account: { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' } },
    ])

    // Container env update fails
    mockContainerFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'container error' }),
    })

    const res = await postJson({
      toolUseId: 'tu-env-fail',
      toolkit: 'gmail',
      accountIds: ['acc-1'],
    })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('metadata')
  })

  it('returns 500 when container /inputs/.../resolve fails', async () => {
    mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere })
    mockSelectWhere.mockResolvedValueOnce([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' },
    ])

    mockInsertValues.mockResolvedValue(undefined)

    mockSelectFrom.mockReturnValueOnce({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockInnerJoinWhere })
    mockInnerJoinWhere.mockResolvedValue([
      { account: { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'user@gmail.com', status: 'active' } },
    ])

    // Env update succeeds
    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })

    // Resolve fails
    mockContainerFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'resolve failed' }),
    })

    const res = await postJson({
      toolUseId: 'tu-resolve-fail',
      toolkit: 'gmail',
      accountIds: ['acc-1'],
    })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('notify agent')
  })

  it('metadata only includes status === active accounts', async () => {
    mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere })
    mockSelectWhere.mockResolvedValueOnce([
      { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'active@gmail.com', status: 'active' },
    ])

    mockInsertValues.mockResolvedValue(undefined)

    mockSelectFrom.mockReturnValueOnce({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockInnerJoinWhere })
    mockInnerJoinWhere.mockResolvedValue([
      { account: { id: 'acc-1', toolkitSlug: 'gmail', displayName: 'active@gmail.com', status: 'active' } },
      { account: { id: 'acc-2', toolkitSlug: 'gmail', displayName: 'expired@gmail.com', status: 'expired' } },
    ])

    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })
    mockContainerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })

    const res = await postJson({
      toolUseId: 'tu-active-only',
      toolkit: 'gmail',
      accountIds: ['acc-1'],
    })

    expect(res.status).toBe(200)

    // Verify metadata sent to container only includes active accounts
    const [, envOpts] = mockContainerFetch.mock.calls[0]
    const envBody = JSON.parse(envOpts.body)
    const metadata = JSON.parse(envBody.value)
    expect(metadata.gmail).toHaveLength(1)
    expect(metadata.gmail[0].name).toBe('active@gmail.com')
  })
})
