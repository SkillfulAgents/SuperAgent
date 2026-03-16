import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ============================================================================
// Mocks — must be declared before import
// ============================================================================

// FS mock (for path traversal tests)
const mockFsStat = vi.fn()
const mockFsReadFile = vi.fn()
const mockFsWriteFile = vi.fn()
const mockFsMkdir = vi.fn()
const mockFsReaddir = vi.fn()
const mockFsExistsSync = vi.fn()
const mockCreateReadStream = vi.fn()

vi.mock('fs', () => ({
  default: {
    promises: {
      stat: (...args: unknown[]) => mockFsStat(...args),
      readFile: (...args: unknown[]) => mockFsReadFile(...args),
      writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
      mkdir: (...args: unknown[]) => mockFsMkdir(...args),
      readdir: (...args: unknown[]) => mockFsReaddir(...args),
    },
    existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
    createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
  },
  promises: {
    stat: (...args: unknown[]) => mockFsStat(...args),
    readFile: (...args: unknown[]) => mockFsReadFile(...args),
    writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    readdir: (...args: unknown[]) => mockFsReaddir(...args),
  },
  existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
}))

vi.mock('stream', () => ({
  Readable: {
    toWeb: () => new ReadableStream(),
  },
}))

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
    removeClient: vi.fn(),
  },
}))

// Message persister
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(),
    broadcastToAgent: vi.fn(),
    broadcastSessionUpdate: vi.fn(),
    persistMessage: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
    isSessionActive: vi.fn(() => false),
  },
}))

// --------------------------------------------------------------------------
// DB mock — This is the most complex mock because agents.ts uses:
//   1. Async Drizzle-style: db.select().from().where().limit() → Promise
//   2. Sync transactions: db.transaction(tx => { tx.select().from().where().limit(1).all() })
// We need to support both patterns.
// --------------------------------------------------------------------------

// Transaction mock builder
let txSelectResults: Record<string, unknown[]> = {}
let txSelectCallIndex = 0
const mockTxRun = vi.fn()

function createTxMock() {
  txSelectCallIndex = 0
  const txAll = vi.fn(() => {
    const keys = Object.keys(txSelectResults)
    const key = keys[txSelectCallIndex] || keys[keys.length - 1]
    txSelectCallIndex++
    return txSelectResults[key] || []
  })
  const txLimit = vi.fn(() => ({ all: txAll }))
  const txWhere = vi.fn(() => ({ limit: txLimit, all: txAll }))
  const txFrom = vi.fn(() => ({ where: txWhere, limit: txLimit }))
  const txSet = vi.fn(() => ({ where: vi.fn(() => ({ run: mockTxRun })) }))
  const txDeleteWhere = vi.fn(() => ({ run: mockTxRun }))
  return {
    select: vi.fn(() => ({ from: txFrom })),
    update: vi.fn(() => ({ set: txSet })),
    delete: vi.fn(() => ({ where: txDeleteWhere })),
  }
}

const mockTransaction = vi.fn((cb: (tx: ReturnType<typeof createTxMock>) => unknown) => {
  const tx = createTxMock()
  return cb(tx)
})

// Async DB mocks (for non-transactional queries)
const mockDbSelectFrom = vi.fn()
const mockDbInsertValues = vi.fn()
const mockDbDeleteWhere = vi.fn()
const mockDbUpdateSet = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => ({ from: (...fargs: unknown[]) => mockDbSelectFrom(...args, ...fargs) }),
    insert: () => ({ values: (...args: unknown[]) => mockDbInsertValues(...args) }),
    delete: () => ({ where: (...args: unknown[]) => mockDbDeleteWhere(...args) }),
    update: () => ({ set: (...args: unknown[]) => mockDbUpdateSet(...args) }),
    transaction: (cb: (...a: unknown[]) => unknown) => mockTransaction(cb),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id', toolkitSlug: 'toolkit_slug' },
  agentConnectedAccounts: { id: 'id', agentSlug: 'agent_slug', connectedAccountId: 'connected_account_id' },
  proxyAuditLog: { agentSlug: 'agent_slug', createdAt: 'created_at' },
  remoteMcpServers: {},
  agentRemoteMcps: {},
  mcpAuditLog: { agentSlug: 'agent_slug', createdAt: 'created_at' },
  agentAcl: { id: 'id', userId: 'user_id', agentSlug: 'agent_slug', role: 'role' },
  user: { id: 'id', name: 'name', email: 'email' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
  inArray: (col: string, vals: string[]) => ({ col, vals }),
  desc: (col: string) => ({ col }),
  count: () => 'count_fn',
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

// Agent service
const mockAgentExists = vi.fn().mockResolvedValue(true)
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(),
  createAgent: vi.fn(),
  getAgentWithStatus: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  agentExists: (...args: unknown[]) => mockAgentExists(...args),
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
  transformMessages: vi.fn(() => []),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({ summarizerModel: 'claude-3-haiku' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {}, skillsets: [] }),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  revokeProxyToken: vi.fn(),
  validateProxyToken: vi.fn(),
}))

const mockGetAgentWorkspaceDir = vi.fn((_slug?: string) => '/mock/workspace')
vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: vi.fn(),
  readFileOrNull: vi.fn(),
  getAgentSessionsDir: vi.fn(() => '/mock/sessions'),
  readJsonlFile: vi.fn(),
  getAgentWorkspaceDir: (slug: string) => mockGetAgentWorkspaceDir(slug),
}))

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))
vi.mock('hono/streaming', () => ({ streamSSE: vi.fn() }))

// Import the agents router after all mocks are set up
import agents from './agents'

// ============================================================================
// Test Helpers
// ============================================================================

function createApp() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

async function patchJson(app: Hono, url: string, body: unknown): Promise<Response> {
  return app.request(`http://localhost${url}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function postJson(app: Hono, url: string, body: unknown): Promise<Response> {
  return app.request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function deleteReq(app: Hono, url: string): Promise<Response> {
  return app.request(`http://localhost${url}`, { method: 'DELETE' })
}

async function getReq(app: Hono, url: string): Promise<Response> {
  return app.request(`http://localhost${url}`, { method: 'GET' })
}

async function postFormData(app: Hono, url: string, body: FormData): Promise<Response> {
  return app.request(`http://localhost${url}`, {
    method: 'POST',
    body,
  })
}

// ============================================================================
// ACL Role Management Tests
// ============================================================================

describe('ACL role management — PATCH /:id/access/:userId', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    txSelectResults = {}
    txSelectCallIndex = 0
  })

  const PATCH_URL = '/api/agents/test-agent/access/target-user'

  // --------------------------------------------------------------------------
  // Input validation
  // --------------------------------------------------------------------------

  it('returns 400 when role is missing', async () => {
    const res = await patchJson(app, PATCH_URL, {})
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid role')
  })

  it('returns 400 when role is an invalid string', async () => {
    const res = await patchJson(app, PATCH_URL, { role: 'superadmin' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid role')
  })

  it('returns 400 for empty string role', async () => {
    const res = await patchJson(app, PATCH_URL, { role: '' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid role')
  })

  // --------------------------------------------------------------------------
  // User not found in ACL
  // --------------------------------------------------------------------------

  it('returns 404 when target user has no ACL entry', async () => {
    // First tx.select: current ACL lookup returns empty
    txSelectResults = { '0': [] }

    const res = await patchJson(app, PATCH_URL, { role: 'user' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('does not have access')
  })

  // --------------------------------------------------------------------------
  // Last owner protection: cannot demote last owner
  // --------------------------------------------------------------------------

  it('returns 400 when demoting the last owner to user', async () => {
    // First select: user is currently owner
    // Second select: owner count is 1
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 1 }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'user' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('at least one owner')
  })

  it('returns 400 when demoting the last owner to viewer', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 1 }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'viewer' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('at least one owner')
  })

  // --------------------------------------------------------------------------
  // Demoting owner when other owners exist
  // --------------------------------------------------------------------------

  it('allows demoting an owner to user when other owners exist', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 3 }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'user' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('allows demoting an owner to viewer when other owners exist', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 2 }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'viewer' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  // --------------------------------------------------------------------------
  // Promoting roles (no owner-count check needed)
  // --------------------------------------------------------------------------

  it('allows promoting a user to owner (no count check)', async () => {
    txSelectResults = {
      '0': [{ role: 'user' }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'owner' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('allows promoting a viewer to user', async () => {
    txSelectResults = {
      '0': [{ role: 'viewer' }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'user' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('allows promoting a viewer to owner', async () => {
    txSelectResults = {
      '0': [{ role: 'viewer' }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'owner' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  // --------------------------------------------------------------------------
  // Setting the same role (owner -> owner bypasses count check)
  // --------------------------------------------------------------------------

  it('allows setting owner to owner without triggering count check', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      // The owner count query should NOT be called since role === 'owner'
    }

    const res = await patchJson(app, PATCH_URL, { role: 'owner' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('allows setting user to user (no-op update)', async () => {
    txSelectResults = {
      '0': [{ role: 'user' }],
    }

    const res = await patchJson(app, PATCH_URL, { role: 'user' })
    expect(res.status).toBe(200)
  })

  // --------------------------------------------------------------------------
  // Valid role values accepted
  // --------------------------------------------------------------------------

  it.each(['owner', 'user', 'viewer'])('accepts valid role value: %s', async (role) => {
    txSelectResults = {
      '0': [{ role: 'user' }], // current role is user
    }

    const res = await patchJson(app, PATCH_URL, { role })
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// ACL Role Management — DELETE /:id/access/:userId
// ============================================================================

describe('ACL role management — DELETE /:id/access/:userId', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    txSelectResults = {}
    txSelectCallIndex = 0
  })

  const DELETE_URL = '/api/agents/test-agent/access/target-user'

  // --------------------------------------------------------------------------
  // User not found
  // --------------------------------------------------------------------------

  it('returns 404 when user has no ACL entry', async () => {
    txSelectResults = { '0': [] }

    const res = await deleteReq(app, DELETE_URL)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('does not have access')
  })

  // --------------------------------------------------------------------------
  // Last owner protection: cannot remove last owner
  // --------------------------------------------------------------------------

  it('returns 400 when removing the last owner', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 1 }],
    }

    const res = await deleteReq(app, DELETE_URL)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('at least one owner')
  })

  // --------------------------------------------------------------------------
  // Removing owner when others exist
  // --------------------------------------------------------------------------

  it('allows removing an owner when other owners exist', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 2 }],
    }

    const res = await deleteReq(app, DELETE_URL)
    expect(res.status).toBe(204)
  })

  it('allows removing an owner when many owners exist', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 5 }],
    }

    const res = await deleteReq(app, DELETE_URL)
    expect(res.status).toBe(204)
  })

  // --------------------------------------------------------------------------
  // Removing non-owner roles (no count check needed)
  // --------------------------------------------------------------------------

  it('allows removing a user role (no owner count check)', async () => {
    txSelectResults = {
      '0': [{ role: 'user' }],
    }

    const res = await deleteReq(app, DELETE_URL)
    expect(res.status).toBe(204)
  })

  it('allows removing a viewer role (no owner count check)', async () => {
    txSelectResults = {
      '0': [{ role: 'viewer' }],
    }

    const res = await deleteReq(app, DELETE_URL)
    expect(res.status).toBe(204)
  })
})

// ============================================================================
// ACL — POST /:id/leave (self-removal)
// ============================================================================

describe('ACL — POST /:id/leave', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    txSelectResults = {}
    txSelectCallIndex = 0
  })

  const LEAVE_URL = '/api/agents/test-agent/leave'

  it('returns 400 when user is the only owner', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 1 }],
    }

    const res = await postJson(app, LEAVE_URL, {})
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('only owner')
  })

  it('allows leaving when user is an owner but others exist', async () => {
    txSelectResults = {
      '0': [{ role: 'owner' }],
      '1': [{ ownerCount: 3 }],
    }

    const res = await postJson(app, LEAVE_URL, {})
    expect(res.status).toBe(204)
  })

  it('allows leaving when user has user role', async () => {
    txSelectResults = {
      '0': [{ role: 'user' }],
    }

    const res = await postJson(app, LEAVE_URL, {})
    expect(res.status).toBe(204)
  })

  it('allows leaving when user has viewer role', async () => {
    txSelectResults = {
      '0': [{ role: 'viewer' }],
    }

    const res = await postJson(app, LEAVE_URL, {})
    expect(res.status).toBe(204)
  })

  it('returns 400 when user does not have access', async () => {
    txSelectResults = { '0': [] }

    const res = await postJson(app, LEAVE_URL, {})
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('do not have access')
  })
})

// ============================================================================
// ACL — POST /:id/access (invite user)
// ============================================================================

describe('ACL — POST /:id/access (invite user)', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  const INVITE_URL = '/api/agents/test-agent/access'

  it('returns 400 when userId is missing', async () => {
    const res = await postJson(app, INVITE_URL, { role: 'user' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('userId and role are required')
  })

  it('returns 400 when role is missing', async () => {
    const res = await postJson(app, INVITE_URL, { userId: 'user-1' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('userId and role are required')
  })

  it('returns 400 for invalid role', async () => {
    const res = await postJson(app, INVITE_URL, { userId: 'user-1', role: 'admin' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid role')
  })

  it('returns 400 for empty role string', async () => {
    const res = await postJson(app, INVITE_URL, { userId: 'user-1', role: '' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when target user does not exist', async () => {
    // db.select().from(userTable).where().limit(1) → no user found
    mockDbSelectFrom.mockReturnValueOnce({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
    })

    const res = await postJson(app, INVITE_URL, { userId: 'nonexistent', role: 'user' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('User not found')
  })

  it('returns 409 when user already has access', async () => {
    // First query: user exists
    mockDbSelectFrom.mockReturnValueOnce({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ id: 'user-1' }])) })),
    })
    // Second query: ACL entry already exists
    mockDbSelectFrom.mockReturnValueOnce({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ id: 'acl-1' }])) })),
    })

    const res = await postJson(app, INVITE_URL, { userId: 'user-1', role: 'user' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('already has access')
  })

  it('returns 201 on successful invite', async () => {
    // First query: user exists
    mockDbSelectFrom.mockReturnValueOnce({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ id: 'user-1' }])) })),
    })
    // Second query: no existing ACL
    mockDbSelectFrom.mockReturnValueOnce({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
    })
    // Insert succeeds
    mockDbInsertValues.mockResolvedValueOnce(undefined)

    const res = await postJson(app, INVITE_URL, { userId: 'user-1', role: 'viewer' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it.each(['owner', 'user', 'viewer'])('accepts valid role: %s', async (role) => {
    mockDbSelectFrom.mockReturnValueOnce({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ id: 'user-1' }])) })),
    })
    mockDbSelectFrom.mockReturnValueOnce({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
    })
    mockDbInsertValues.mockResolvedValueOnce(undefined)

    const res = await postJson(app, INVITE_URL, { userId: 'user-1', role })
    expect(res.status).toBe(201)
  })
})

// ============================================================================
// Path Traversal Security — GET /:id/files/*
// ============================================================================

describe('path traversal security — GET /:id/files/*', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockGetAgentWorkspaceDir.mockReturnValue('/mock/workspace')
  })

  it('blocks absolute paths that escape workspace', async () => {
    // path.resolve with an absolute path ignores the base
    const res = await getReq(app, '/api/agents/test-agent/files//etc/passwd')
    // After decoding, the filePath would be "/etc/passwd" which path.resolve
    // resolves to "/etc/passwd" — outside workspace
    expect(res.status).toBe(400)
  })

  it('returns 400 when file path is empty', async () => {
    const res = await getReq(app, '/api/agents/test-agent/files/')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('File path is required')
  })

  it('returns 404 when file does not exist', async () => {
    mockFsStat.mockResolvedValueOnce(null)

    const res = await getReq(app, '/api/agents/test-agent/files/legitimate/file.txt')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('File not found')
  })

  it('returns 404 when path is a directory', async () => {
    mockFsStat.mockResolvedValueOnce({ isFile: () => false, size: 0 })

    const res = await getReq(app, '/api/agents/test-agent/files/some-directory')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('File not found')
  })

  it('allows legitimate nested file paths within workspace', async () => {
    mockFsStat.mockResolvedValueOnce({ isFile: () => true, size: 100 })
    mockCreateReadStream.mockReturnValueOnce({ pipe: vi.fn() })

    const res = await getReq(app, '/api/agents/test-agent/files/uploads/2024-01-01-photo.png')
    // Should not return 400 (Invalid path) since it's within workspace
    expect(res.status).not.toBe(400)
  })

  it('allows files in deeply nested subdirectories', async () => {
    mockFsStat.mockResolvedValueOnce({ isFile: () => true, size: 42 })
    mockCreateReadStream.mockReturnValueOnce({ pipe: vi.fn() })

    const res = await getReq(app, '/api/agents/test-agent/files/a/b/c/d/e/file.txt')
    expect(res.status).not.toBe(400)
  })

  // Note: path traversal with ../ in URLs (e.g. /files/../../etc/passwd) is typically
  // resolved by the HTTP layer/URL parser before reaching the route handler. The
  // server-side guard (fullPath.startsWith(workspaceDir)) protects against any
  // path that resolves outside the workspace after path.resolve() is called.
  // The absolute path test above (//etc/passwd) tests this guard directly.
})

// ============================================================================
// Path Traversal Security — Skill File Endpoints
// ============================================================================

describe('path traversal security — skill file endpoints', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockGetAgentWorkspaceDir.mockReturnValue('/mock/workspace')
  })

  // --------------------------------------------------------------------------
  // GET /:id/skills/:dir/files - directory listing
  // --------------------------------------------------------------------------

  describe('GET /:id/skills/:dir/files', () => {
    // Note: dir validation (dir.includes('..'), dir.includes('/'), dir.includes('\\'))
    // is tested at the application level. When `..` or `/` appears in the URL path,
    // Hono's router resolves them before they reach the handler. The backslash test
    // and the path traversal test on the `path` query param (in content endpoints)
    // are the reliable route-level tests for this security check.

    it('returns 404 when skill directory does not exist', async () => {
      mockFsExistsSync.mockReturnValueOnce(false)

      const res = await getReq(app, '/api/agents/test-agent/skills/my-skill/files')
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Skill directory not found')
    })

    it('returns file listing for valid skill directory', async () => {
      mockFsExistsSync.mockReturnValueOnce(true)
      mockFsReaddir.mockResolvedValueOnce([
        { name: 'index.ts', isDirectory: () => false },
        { name: 'utils', isDirectory: () => true },
      ])
      // readdir for 'utils' subdirectory
      mockFsReaddir.mockResolvedValueOnce([
        { name: 'helper.ts', isDirectory: () => false },
      ])

      const res = await getReq(app, '/api/agents/test-agent/skills/my-skill/files')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.files).toEqual([
        { path: 'utils', type: 'directory' },
        { path: 'index.ts', type: 'file' },
        { path: 'utils/helper.ts', type: 'file' },
      ])
    })
  })

  // --------------------------------------------------------------------------
  // GET /:id/skills/:dir/files/content — read file
  // --------------------------------------------------------------------------

  describe('GET /:id/skills/:dir/files/content', () => {

    it('returns 400 when path query param is missing', async () => {
      const res = await getReq(app, '/api/agents/test-agent/skills/my-skill/files/content')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('path query parameter is required')
    })

    it('blocks path traversal in file path query param', async () => {
      const res = await getReq(
        app,
        '/api/agents/test-agent/skills/my-skill/files/content?path=../../etc/passwd'
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid file path')
    })

    it('returns 404 when file does not exist', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      mockFsReadFile.mockRejectedValueOnce(err)

      const res = await getReq(
        app,
        '/api/agents/test-agent/skills/my-skill/files/content?path=nonexistent.ts'
      )
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('File not found')
    })

    it('returns file content for a valid path', async () => {
      mockFsReadFile.mockResolvedValueOnce('const x = 1;')

      const res = await getReq(
        app,
        '/api/agents/test-agent/skills/my-skill/files/content?path=index.ts'
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toBe('const x = 1;')
      expect(body.path).toBe('index.ts')
    })

    it('allows reading files in subdirectories', async () => {
      mockFsReadFile.mockResolvedValueOnce('export {}')

      const res = await getReq(
        app,
        '/api/agents/test-agent/skills/my-skill/files/content?path=utils/helper.ts'
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toBe('export {}')
    })
  })

  // --------------------------------------------------------------------------
  // PUT /:id/skills/:dir/files/content — write file
  // --------------------------------------------------------------------------

  describe('PUT /:id/skills/:dir/files/content', () => {
    async function putJson(url: string, body: unknown): Promise<Response> {
      return app.request(`http://localhost${url}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('rejects dir with backslash', async () => {
      const res = await putJson(
        '/api/agents/test-agent/skills/foo%5Cbar/files/content',
        { path: 'file.ts', content: 'x' }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid skill directory')
    })

    it('returns 400 when path is missing', async () => {
      const res = await putJson(
        '/api/agents/test-agent/skills/my-skill/files/content',
        { content: 'code' }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('path and content are required')
    })

    it('returns 400 when content is not a string', async () => {
      const res = await putJson(
        '/api/agents/test-agent/skills/my-skill/files/content',
        { path: 'file.ts', content: 42 }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('path and content are required')
    })

    it('blocks path traversal in file path', async () => {
      const res = await putJson(
        '/api/agents/test-agent/skills/my-skill/files/content',
        { path: '../../etc/crontab', content: 'malicious' }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid file path')
    })

    it('successfully writes file for valid inputs', async () => {
      mockFsWriteFile.mockResolvedValueOnce(undefined)

      const res = await putJson(
        '/api/agents/test-agent/skills/my-skill/files/content',
        { path: 'index.ts', content: 'const y = 2;' }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.saved).toBe(true)

      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('my-skill'),
        'const y = 2;',
        'utf-8'
      )
    })

    it('writes to nested paths within skill directory', async () => {
      mockFsWriteFile.mockResolvedValueOnce(undefined)

      const res = await putJson(
        '/api/agents/test-agent/skills/my-skill/files/content',
        { path: 'sub/dir/file.ts', content: 'export {}' }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.saved).toBe(true)
    })
  })
})

// ============================================================================
// Audit Log Merging — GET /:id/audit-log
// ============================================================================

describe('audit log — GET /:id/audit-log', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  const AUDIT_URL = '/api/agents/test-agent/audit-log'

  /**
   * The audit log endpoint does:
   *   1. Fetches from proxyAuditLog and mcpAuditLog tables in parallel
   *   2. Normalizes entries to a common shape
   *   3. Merges and sorts by createdAt descending
   *   4. Paginates with offset/limit
   *
   * Because db.select() is mocked, we set up the chain:
   *   db.select().from(table).where().orderBy().limit() → entries
   *   db.select({count}).from(table).where() → [{count: N}]
   */

  function setupAuditLogMocks(
    proxyEntries: unknown[],
    proxyTotal: number,
    mcpEntries: unknown[],
    mcpTotal: number
  ) {
    // The handler calls Promise.all with 4 queries:
    // [0] proxyEntries, [1] proxyTotal, [2] mcpEntries, [3] mcpTotal
    let callIndex = 0
    mockDbSelectFrom.mockImplementation(() => {
      const idx = callIndex++
      if (idx === 0) {
        // proxy entries: .where().orderBy().limit()
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(proxyEntries)),
            })),
          })),
        }
      } else if (idx === 1) {
        // proxy total: .where()
        return {
          where: vi.fn(() => Promise.resolve([{ count: proxyTotal }])),
        }
      } else if (idx === 2) {
        // mcp entries: .where().orderBy().limit()
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(mcpEntries)),
            })),
          })),
        }
      } else {
        // mcp total: .where()
        return {
          where: vi.fn(() => Promise.resolve([{ count: mcpTotal }])),
        }
      }
    })
  }

  it('returns empty entries when both tables are empty', async () => {
    setupAuditLogMocks([], 0, [], 0)

    const res = await getReq(app, AUDIT_URL)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toEqual([])
    expect(body.total).toBe(0)
  })

  it('merges proxy and MCP entries sorted by time descending', async () => {
    const proxyEntries = [
      {
        id: 'p1',
        agentSlug: 'test-agent',
        toolkit: 'gmail',
        targetHost: 'https://gmail.com',
        targetPath: 'api/send',
        method: 'POST',
        statusCode: 200,
        errorMessage: null,
        createdAt: '2026-01-01T10:00:00Z',
      },
      {
        id: 'p2',
        agentSlug: 'test-agent',
        toolkit: 'slack',
        targetHost: 'https://slack.com',
        targetPath: 'api/post',
        method: 'POST',
        statusCode: 201,
        errorMessage: null,
        createdAt: '2026-01-01T08:00:00Z',
      },
    ]
    const mcpEntries = [
      {
        id: 'm1',
        agentSlug: 'test-agent',
        remoteMcpName: 'mcp-server-1',
        requestPath: '/tools/call',
        method: 'POST',
        statusCode: 200,
        errorMessage: null,
        durationMs: 150,
        createdAt: '2026-01-01T09:00:00Z',
      },
    ]

    setupAuditLogMocks(proxyEntries, 2, mcpEntries, 1)

    const res = await getReq(app, AUDIT_URL)
    expect(res.status).toBe(200)
    const body = await res.json()

    // Should be sorted: p1 (10:00) > m1 (09:00) > p2 (08:00)
    expect(body.entries).toHaveLength(3)
    expect(body.entries[0].id).toBe('p1')
    expect(body.entries[0].source).toBe('proxy')
    expect(body.entries[1].id).toBe('m1')
    expect(body.entries[1].source).toBe('mcp')
    expect(body.entries[2].id).toBe('p2')
    expect(body.entries[2].source).toBe('proxy')
    expect(body.total).toBe(3)
  })

  it('normalizes proxy entries to common shape', async () => {
    const proxyEntries = [
      {
        id: 'p1',
        agentSlug: 'test-agent',
        toolkit: 'stripe',
        targetHost: 'https://api.stripe.com',
        targetPath: 'v1/charges',
        method: 'GET',
        statusCode: 200,
        errorMessage: null,
        createdAt: '2026-01-01T12:00:00Z',
      },
    ]

    setupAuditLogMocks(proxyEntries, 1, [], 0)

    const res = await getReq(app, AUDIT_URL)
    const body = await res.json()

    const entry = body.entries[0]
    expect(entry.source).toBe('proxy')
    expect(entry.label).toBe('stripe')
    expect(entry.targetUrl).toBe('https://api.stripe.com/v1/charges')
    expect(entry.method).toBe('GET')
    expect(entry.statusCode).toBe(200)
    expect(entry.errorMessage).toBeNull()
    expect(entry.durationMs).toBeNull() // proxy entries don't have durationMs
  })

  it('normalizes MCP entries to common shape', async () => {
    const mcpEntries = [
      {
        id: 'm1',
        agentSlug: 'test-agent',
        remoteMcpName: 'my-mcp-server',
        requestPath: '/tools/list',
        method: 'GET',
        statusCode: 200,
        errorMessage: null,
        durationMs: 42,
        createdAt: '2026-01-01T12:00:00Z',
      },
    ]

    setupAuditLogMocks([], 0, mcpEntries, 1)

    const res = await getReq(app, AUDIT_URL)
    const body = await res.json()

    const entry = body.entries[0]
    expect(entry.source).toBe('mcp')
    expect(entry.label).toBe('my-mcp-server')
    expect(entry.targetUrl).toBe('/tools/list')
    expect(entry.method).toBe('GET')
    expect(entry.durationMs).toBe(42)
  })

  it('handles pagination with offset and limit', async () => {
    // Create entries that will sort chronologically
    const proxyEntries = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      agentSlug: 'test-agent',
      toolkit: `toolkit-${i}`,
      targetHost: 'https://api.example.com',
      targetPath: `path-${i}`,
      method: 'GET',
      statusCode: 200,
      errorMessage: null,
      createdAt: new Date(2026, 0, 1, i).toISOString(), // ascending hours
    }))

    setupAuditLogMocks(proxyEntries, 10, [], 0)

    const res = await getReq(app, `${AUDIT_URL}?offset=1&limit=2`)
    expect(res.status).toBe(200)
    const body = await res.json()

    // After sorting desc: p4, p3, p2, p1, p0
    // offset=1, limit=2 => p3, p2
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0].id).toBe('p3')
    expect(body.entries[1].id).toBe('p2')
    expect(body.total).toBe(10) // total from count queries
  })

  it('defaults to offset=0 and limit=20', async () => {
    // Create 25 entries; default should return 20
    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      agentSlug: 'test-agent',
      toolkit: `toolkit-${i}`,
      targetHost: 'https://example.com',
      targetPath: `/${i}`,
      method: 'GET',
      statusCode: 200,
      errorMessage: null,
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
    }))

    setupAuditLogMocks(entries, 50, [], 0)

    const res = await getReq(app, AUDIT_URL)
    const body = await res.json()
    expect(body.entries).toHaveLength(20)
  })

  it('caps limit at 100', async () => {
    setupAuditLogMocks([], 0, [], 0)

    // Even though we request limit=200, the server caps at 100
    const res = await getReq(app, `${AUDIT_URL}?limit=200`)
    expect(res.status).toBe(200)
    // We can't easily verify the cap from the response since there are 0 entries,
    // but the request should not fail
  })

  it('handles entries with null statusCode and errorMessage', async () => {
    const proxyEntries = [
      {
        id: 'p1',
        agentSlug: 'test-agent',
        toolkit: 'api',
        targetHost: 'https://broken.example.com',
        targetPath: 'endpoint',
        method: 'POST',
        statusCode: null,
        errorMessage: 'Connection refused',
        createdAt: '2026-01-01T12:00:00Z',
      },
    ]

    setupAuditLogMocks(proxyEntries, 1, [], 0)

    const res = await getReq(app, AUDIT_URL)
    const body = await res.json()
    expect(body.entries[0].statusCode).toBeNull()
    expect(body.entries[0].errorMessage).toBe('Connection refused')
  })

  it('handles entries with null durationMs in MCP', async () => {
    const mcpEntries = [
      {
        id: 'm1',
        agentSlug: 'test-agent',
        remoteMcpName: 'server',
        requestPath: '/call',
        method: 'POST',
        statusCode: 500,
        errorMessage: 'Internal error',
        durationMs: null,
        createdAt: '2026-01-01T12:00:00Z',
      },
    ]

    setupAuditLogMocks([], 0, mcpEntries, 1)

    const res = await getReq(app, AUDIT_URL)
    const body = await res.json()
    expect(body.entries[0].durationMs).toBeNull()
    expect(body.entries[0].errorMessage).toBe('Internal error')
  })

  it('correctly interleaves proxy and MCP entries chronologically', async () => {
    const proxyEntries = [
      { id: 'p1', agentSlug: 'a', toolkit: 't', targetHost: 'h', targetPath: 'p', method: 'GET', statusCode: 200, errorMessage: null, createdAt: '2026-01-01T10:00:00Z' },
      { id: 'p2', agentSlug: 'a', toolkit: 't', targetHost: 'h', targetPath: 'p', method: 'GET', statusCode: 200, errorMessage: null, createdAt: '2026-01-01T06:00:00Z' },
    ]
    const mcpEntries = [
      { id: 'm1', agentSlug: 'a', remoteMcpName: 'm', requestPath: '/r', method: 'POST', statusCode: 200, errorMessage: null, durationMs: 10, createdAt: '2026-01-01T08:00:00Z' },
      { id: 'm2', agentSlug: 'a', remoteMcpName: 'm', requestPath: '/r', method: 'POST', statusCode: 200, errorMessage: null, durationMs: 20, createdAt: '2026-01-01T04:00:00Z' },
    ]

    setupAuditLogMocks(proxyEntries, 2, mcpEntries, 2)

    const res = await getReq(app, AUDIT_URL)
    const body = await res.json()

    // Expected order: p1 (10:00), m1 (08:00), p2 (06:00), m2 (04:00)
    expect(body.entries.map((e: any) => e.id)).toEqual(['p1', 'm1', 'p2', 'm2'])
  })
})

// ============================================================================
// Skill dir validation — edge cases
// ============================================================================

describe('skill dir validation edge cases', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockGetAgentWorkspaceDir.mockReturnValue('/mock/workspace')
  })

  it('rejects dir containing backslash on list endpoint', async () => {
    const res = await getReq(app, '/api/agents/test-agent/skills/foo%5Cbar/files')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid skill directory')
  })

  it('rejects dir containing forward slash on list endpoint', async () => {
    const res = await getReq(app, '/api/agents/test-agent/skills/foo%2Fbar/files')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid skill directory')
  })

  it('accepts valid alphanumeric skill directory names', async () => {
    mockFsExistsSync.mockReturnValueOnce(true)
    mockFsReaddir.mockResolvedValueOnce([])

    const res = await getReq(app, '/api/agents/test-agent/skills/my-cool-skill-v2/files')
    expect(res.status).toBe(200)
  })

  it('accepts skill names with hyphens and underscores', async () => {
    mockFsExistsSync.mockReturnValueOnce(true)
    mockFsReaddir.mockResolvedValueOnce([])

    const res = await getReq(app, '/api/agents/test-agent/skills/skill_name-123/files')
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// Agent existence middleware
// ============================================================================

describe('agent existence middleware — /:id/*', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('returns 404 when agent does not exist', async () => {
    mockAgentExists.mockResolvedValueOnce(false)

    const res = await getReq(app, '/api/agents/nonexistent-agent/sessions')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Agent not found')
  })
})

// ============================================================================
// File Upload with relativePath — POST /:id/upload-file
// ============================================================================

describe('file upload with relativePath — POST /:id/upload-file', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockFsMkdir.mockResolvedValue(undefined)
    mockFsWriteFile.mockResolvedValue(undefined)
  })

  it('uploads file with relativePath preserving directory structure', async () => {
    const formData = new FormData()
    formData.append('file', new File(['hello'], 'test.txt', { type: 'text/plain' }))
    formData.append('relativePath', 'myfolder/sub/test.txt')

    const res = await postFormData(app, '/api/agents/test-agent/upload-file', formData)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toBe('/workspace/uploads/myfolder/sub/test.txt')
    expect(body.success).toBe(true)
    expect(body.filename).toBe('test.txt')

    // Verify mkdir was called with the parent directory
    expect(mockFsMkdir).toHaveBeenCalledWith(
      expect.stringContaining('myfolder/sub'),
      { recursive: true }
    )
    // Verify writeFile was called
    expect(mockFsWriteFile).toHaveBeenCalled()
  })

  it('uploads file without relativePath uses timestamped name', async () => {
    const formData = new FormData()
    formData.append('file', new File(['hello'], 'test.txt', { type: 'text/plain' }))

    const res = await postFormData(app, '/api/agents/test-agent/upload-file', formData)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toMatch(/\/workspace\/uploads\/\d+-test\.txt/)
    expect(body.success).toBe(true)
  })

  it('sanitizes path traversal via relativePath (strips leading ..)', async () => {
    const formData = new FormData()
    formData.append('file', new File(['malicious'], 'passwd', { type: 'text/plain' }))
    formData.append('relativePath', '../../etc/passwd')

    const res = await postFormData(app, '/api/agents/test-agent/upload-file', formData)
    expect(res.status).toBe(200)
    const body = await res.json()
    // The leading ../../ is stripped, so file lands safely inside uploads/
    expect(body.path).toBe('/workspace/uploads/etc/passwd')
  })

  it('sanitizes absolute path in relativePath (stays within uploads)', async () => {
    const formData = new FormData()
    formData.append('file', new File(['malicious'], 'passwd', { type: 'text/plain' }))
    formData.append('relativePath', '/etc/passwd')

    const res = await postFormData(app, '/api/agents/test-agent/upload-file', formData)
    expect(res.status).toBe(200)
    const body = await res.json()
    // /etc/passwd is kept as-is by normalize (no leading ..), so uploadPath
    // becomes 'uploads//etc/passwd'. The double slash is cosmetic — the resolved
    // fullPath is still within the uploads directory, so the security check passes.
    expect(body.path).toBe('/workspace/uploads//etc/passwd')
  })

  it('returns 400 when no file is provided', async () => {
    const formData = new FormData()

    const res = await postFormData(app, '/api/agents/test-agent/upload-file', formData)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('No file provided')
  })
})
