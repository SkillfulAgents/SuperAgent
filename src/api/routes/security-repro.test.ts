import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Security guardrail repro tests.
//
// This file collects focused regression tests for security fixes. Each suite
// reproduces a specific vulnerability and asserts the guardrail that closes it:
//
//   - SUP-198: connected-account reconnect ownership (AUTH_MODE). A user must
//     not be able to reconnect (take over) an account owned by another user by
//     supplying a `reconnectAccountId` they happen to know.
//   - SUP-200: agent workspace file-download containment. A `..`-encoded path
//     must not be able to escape the workspace into a sibling agent directory
//     that merely shares the workspace path prefix.
//   - SUP-201: deployment-global platform-auth mutation (AUTH_MODE). An
//     ordinary user must not be able to overwrite or revoke the shared platform
//     credential via the `/complete` / `/revoke` endpoints.
//   - SUP-199: remote MCP assignment ownership (AUTH_MODE). A user with access
//     to any agent must not be able to attach another user's remote MCP (and its
//     stored bearer/OAuth credentials) by supplying an `mcpId` they do not own.
//
// The mock preamble is shared across the suites. `vi.mock` is module-scoped and
// hoisted, so a module can only be mocked once per file — the blocks below
// satisfy the union of what every router imports. The agent download route never
// touches the db, so the SUP-198 db mock serves both suites unchanged.
// ---------------------------------------------------------------------------

// --- SUP-198 db harness -----------------------------------------------------
// The db mock is driven by `selectQueue`: each terminal of a select chain shifts
// the next pre-seeded result. A terminal is either `.limit()` (SUP-198) or an
// awaited `.where()` (SUP-199, whose ownership lookups have no `.limit()`), so
// the `.where()` result is both chainable and a thenable. `updateWhereCalls`
// records every `db.update(...).set(...).where(...)` so we can assert no write
// happened; `mockDbInsertValues` records every `db.insert(...).values(...)`.
let selectQueue: unknown[][] = []
const updateWhereCalls: unknown[][] = []

const mockDbSelectLimit = vi.fn(() => Promise.resolve(selectQueue.shift() ?? []))
const mockDbUpdateWhere = vi.fn((...args: unknown[]) => {
  updateWhereCalls.push(args)
  return Promise.resolve(undefined)
})
const mockDbInsertValues = vi.fn().mockResolvedValue(undefined)
const mockDbDeleteWhere = vi.fn().mockResolvedValue(undefined)

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbSelectLimit(),
          orderBy: () => ({ $dynamic: () => ({ where: () => mockDbSelectLimit() }) }),
          // Awaited directly (terminal `.where()` with no `.limit()`).
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => mockDbSelectLimit().then(onF, onR),
        }),
        orderBy: () => ({ $dynamic: () => ({ where: () => mockDbSelectLimit() }) }),
      }),
    }),
    insert: () => ({
      values: (...vArgs: unknown[]) => {
        mockDbInsertValues(...vArgs)
        const settled = Promise.resolve(undefined)
        // Awaitable both directly and via `.onConflictDoNothing()`.
        return {
          onConflictDoNothing: () => settled,
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => settled.then(onF, onR),
        }
      },
    }),
    update: () => ({
      set: () => ({ where: (...wArgs: unknown[]) => mockDbUpdateWhere(...wArgs) }),
    }),
    delete: () => ({ where: (...wArgs: unknown[]) => mockDbDeleteWhere(...wArgs) }),
  },
}))

// Schema: detailed connectedAccounts (used by connected-accounts.ts) plus the
// other tables imported by agents.ts (unused by these suites, so stubbed).
vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {
    id: 'id',
    providerConnectionId: 'provider_connection_id',
    providerName: 'provider_name',
    userId: 'user_id',
  },
  agentConnectedAccounts: {},
  proxyAuditLog: {}, remoteMcpServers: {}, agentRemoteMcps: {}, mcpAuditLog: {},
  agentAcl: {}, user: {}, messageAuthor: {}, apiScopePolicies: {}, mcpToolPolicies: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  desc: (col: string) => ({ desc: col }),
  and: (...args: unknown[]) => args,
  inArray: (col: string, vals: string[]) => ({ col, vals }),
  count: () => 'count_fn',
  like: (col: string, val: string) => ({ col, val }),
  or: (...args: unknown[]) => args,
}))

const mockProvider = {
  name: 'composio',
  initiateConnection: vi.fn(),
  getConnection: vi.fn(),
  deleteConnection: vi.fn(),
  getAccountDisplayName: vi.fn(),
}

vi.mock('@shared/lib/account-providers', () => ({
  getDefaultAccountProvider: () => mockProvider,
  getAccountProviderByName: () => mockProvider,
  isValidProviderName: (name: string) => ['composio', 'nango'].includes(name),
  isProviderSupported: () => true,
  getProvider: (slug: string) => ({ slug, displayName: slug.charAt(0).toUpperCase() + slug.slice(1) }),
}))

// Acting (attacker) user. The victim rows seeded into `selectQueue` are owned by
// a different user, so ownership checks must reject the reconnect.
const ACTING_USER_ID = 'attacker-user'

vi.mock('@shared/lib/auth/config', () => ({
  getAppBaseUrlFromRequest: () => 'http://localhost:3000',
  getCurrentUserId: () => ACTING_USER_ID,
}))

// isAuthMode is a toggle: SUP-198/200 need auth mode on (the default), and
// SUP-201's two repro tests do too. SUP-201's control test flips it off to prove
// the new guard does not over-reject local/desktop (non-auth) mode.
const mockIsAuthMode = vi.fn(() => true)
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getAccountProviderUserId: () => 'test-user',
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({ summarizerModel: 'claude-3-haiku' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {}, skillsets: [] }),
  VALID_SCRIPT_TYPES: [],
}))

// Auth middleware — passthrough for both routers' middlewares.
const mockAuthUser = { id: ACTING_USER_ID, name: 'Test User', email: 'test@example.com' }
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentRead: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentUser: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentAdmin: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  OwnsAccount: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  Or: (..._mw: unknown[]) => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (c: any, next: () => Promise<void>) => { c.set('agentId', c.req.param('id')); return next() },
  getAgentId: (c: any) => c.get('agentId') ?? c.req.param('id'),
}))

vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: vi.fn(),
}))

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  countActiveTriggersPerAccount: vi.fn().mockResolvedValue({}),
  listWebhookTriggers: vi.fn(),
  listActiveWebhookTriggers: vi.fn(),
  listCancelledWebhookTriggers: vi.fn(),
}))

// --- SUP-201 platform-auth harness ------------------------------------------
// The guard rejects /complete and /revoke (in auth mode) before the service is
// reached, so the service is mocked purely to assert it is NOT called — and to
// drive the non-auth control test. platform-service is stubbed to keep the
// import graph small; it is never exercised by these tests.
const mockSavePlatformAuth = vi.fn()
const mockRevokePlatformToken = vi.fn()
const mockGetPlatformAuthStatus = vi.fn()

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  savePlatformAuth: (...args: unknown[]) => mockSavePlatformAuth(...args),
  revokePlatformToken: (...args: unknown[]) => mockRevokePlatformToken(...args),
  getPlatformAuthStatus: (...args: unknown[]) => mockGetPlatformAuthStatus(...args),
}))

vi.mock('@shared/lib/services/platform-service', () => ({
  platformService: {
    refreshBilling: vi.fn(),
    getCachedBilling: vi.fn(),
    getLastRefreshedAt: vi.fn(),
    onAuthChanged: vi.fn(),
  },
}))

// --- agents.ts (SUP-200) dependency mocks -----------------------------------
// We deliberately do NOT mock `fs` or `stream`: the SUP-200 suite exercises the
// download route against the REAL filesystem so the actual path resolution and
// containment check are validated end to end.

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({ fetch: vi.fn(), sendMessage: vi.fn(), start: vi.fn(), stop: vi.fn() }),
    ensureRunning: vi.fn(),
    getCachedInfo: () => ({ status: 'running', port: 8080 }),
    removeClient: vi.fn(),
    keepAlive: vi.fn(),
  },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(),
    broadcastSessionUpdate: vi.fn(),
    persistMessage: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
    isSessionActive: vi.fn(() => false),
    isSessionAwaitingInput: vi.fn(() => false),
    hasActiveSessionsForAgent: vi.fn(() => false),
    hasSessionsAwaitingInputForAgent: vi.fn(() => false),
    isSubscribed: vi.fn(() => true),
    subscribeToSession: vi.fn(),
    unsubscribeFromSession: vi.fn(),
    markSessionActive: vi.fn(),
    broadcastSessionEvent: vi.fn(),
  },
}))

// agentExists gates `/:id/*` routes — must resolve true so the request reaches
// the download handler.
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(), createAgent: vi.fn(), getAgentWithStatus: vi.fn(),
  getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(),
  agentExists: vi.fn().mockResolvedValue(true),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: vi.fn(), updateSessionName: vi.fn(), registerSession: vi.fn(),
  getSessionMessagesWithCompact: vi.fn(), getSession: vi.fn(), getSessionMetadata: vi.fn(),
  sessionExists: vi.fn().mockResolvedValue(true), updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn(), removeMessage: vi.fn(), removeToolCall: vi.fn(),
  getSessionSummary: vi.fn().mockResolvedValue({ sessionIds: [], sessionCount: 0, lastActivityAt: null }),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  listSecrets: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn(),
  keyToEnvVar: vi.fn(), getSecretEnvVars: vi.fn(),
}))

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listScheduledTasks: vi.fn(), listPendingScheduledTasks: vi.fn(),
  listPendingScheduledTasksByAgents: vi.fn(() => Promise.resolve(new Map())),
  listCancelledScheduledTasks: vi.fn(),
}))

vi.mock('@shared/lib/services/skillset-service', () => ({
  getAgentSkillsWithStatus: vi.fn(), getDiscoverableSkills: vi.fn(), installSkillFromSkillset: vi.fn(),
  updateSkillFromSkillset: vi.fn(), createSkillPR: vi.fn(), getSkillPRInfo: vi.fn(),
  getSkillPublishInfo: vi.fn(), publishSkillToSkillset: vi.fn(), refreshAgentSkills: vi.fn(),
  exportSkill: vi.fn(), importSkillFromZip: vi.fn(), SKILL_MAX_COMPRESSED_SIZE: 100 * 1024 * 1024,
}))

vi.mock('@shared/lib/services/artifact-service', () => ({
  listArtifactsFromFilesystem: vi.fn(), deleteArtifactFromFilesystem: vi.fn(), renameArtifactOnFilesystem: vi.fn(),
}))

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  listChatIntegrations: vi.fn(() => []), listChatIntegrationsByAgents: vi.fn(() => new Map()),
}))

vi.mock('@shared/lib/services/notification-service', () => ({
  getSessionIdsWithUnreadNotifications: vi.fn(() => Promise.resolve(new Set())),
  getUnreadNotificationsByAgents: vi.fn(() => Promise.resolve(new Map())),
}))

vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => 'localhost', getAppPort: () => 3000,
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    getPendingReviewsForAgent: () => [],
    submitDecision: vi.fn(), resolveMatchingPending: vi.fn(),
    resolveMatchingPendingByLabel: vi.fn(), resolveMatchingXAgentByOperation: vi.fn(),
  },
}))

vi.mock('@shared/lib/services/agent-template-service', () => ({
  exportAgentTemplate: vi.fn(), exportAgentFull: vi.fn(), importAgentFromTemplate: vi.fn(),
  MAX_COMPRESSED_SIZE: 500 * 1024 * 1024, installAgentFromSkillset: vi.fn(), updateAgentFromSkillset: vi.fn(),
  getAgentTemplateStatus: vi.fn(), getDiscoverableAgents: vi.fn(), refreshSkillsetCaches: vi.fn(),
  getAgentPRInfo: vi.fn(), createAgentPR: vi.fn(), getAgentPublishInfo: vi.fn(),
  publishAgentToSkillset: vi.fn(), refreshAgentTemplates: vi.fn(), hasOnboardingSkill: vi.fn(),
}))

vi.mock('@shared/lib/utils/retry', () => ({ withRetry: vi.fn((fn: () => unknown) => fn()) }))

vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({ messages: { create: vi.fn() } }),
  extractTextFromLlmResponse: () => null,
}))

vi.mock('@shared/lib/utils/message-transform', () => ({
  transformMessages: vi.fn(), resolveInterruptedSubagents: vi.fn(),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({ revokeProxyToken: vi.fn(), validateProxyToken: vi.fn() }))

// Real temp dir acting as the agents data root. Each SUP-200 test gets a fresh
// one so getAgentWorkspaceDir(slug) === <agentDataRoot>/<slug>; that layout lets
// us reproduce the sibling-prefix traversal (workspace "agent" vs "agent-victim").
let agentDataRoot = ''
const mockGetAgentWorkspaceDir = vi.fn((slug: string) => path.join(agentDataRoot, slug))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: vi.fn(), readFileOrNull: vi.fn(), writeFile: vi.fn(),
  getAgentSessionsDir: vi.fn(() => '/mock/sessions'), readJsonlFile: vi.fn(),
  getAgentWorkspaceDir: (slug: string) => mockGetAgentWorkspaceDir(slug),
  getAgentPreferencesPath: vi.fn((slug: string) => `/mock/workspace/${slug}/agent-preferences.json`),
  getTempUploadsDir: vi.fn(() => '/mock/tmp/uploads'),
  ensureDirectory: vi.fn(), removeDirectory: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))
vi.mock('hono/streaming', () => ({ streamSSE: vi.fn() }))

// Import routers after all mocks are set up.
import connectedAccountsRouter from './connected-accounts'
import agents from './agents'
import platformAuthRoute from './platform-auth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appWithConnectedAccounts() {
  const app = new Hono()
  app.route('/api/connected-accounts', connectedAccountsRouter)
  return app
}

function appWithAgents() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

function appWithPlatformAuth() {
  const app = new Hono()
  app.route('/api/platform-auth', platformAuthRoute)
  return app
}

function expectClientError(status: number) {
  expect(status).toBeGreaterThanOrEqual(400)
  expect(status).toBeLessThan(500)
}

// ---------------------------------------------------------------------------
// SUP-198
// ---------------------------------------------------------------------------

describe('SUP-198: connected account reconnect ownership (AUTH_MODE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectQueue = []
    updateWhereCalls.length = 0
    // Defaults so /complete reaches the reconnect branch (active connection).
    mockProvider.getConnection.mockResolvedValue({ id: 'attacker-new-connection', status: 'ACTIVE' })
    mockProvider.getAccountDisplayName.mockResolvedValue('Attacker GitHub')
    mockProvider.deleteConnection.mockResolvedValue(undefined)
  })

  it('rejects initiating reconnect for another user connected account by id', async () => {
    selectQueue = [[{ id: 'victim-account-id', providerConnectionId: 'victim-old-connection', userId: 'victim-user' }]]

    const res = await appWithConnectedAccounts().request('http://localhost/api/connected-accounts/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerSlug: 'github',
        reconnectAccountId: 'victim-account-id',
      }),
    })

    expectClientError(res.status)
    expect(mockProvider.initiateConnection).not.toHaveBeenCalled()
  })

  it('rejects reconnecting another user connected account by id', async () => {
    selectQueue = [[{ providerConnectionId: 'victim-old-connection', userId: 'victim-user' }]]

    const res = await appWithConnectedAccounts().request('http://localhost/api/connected-accounts/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'attacker-new-connection',
        toolkit: 'github',
        providerName: 'composio',
        reconnectAccountId: 'victim-account-id',
      }),
    })

    expectClientError(res.status)
    expect(updateWhereCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SUP-200
// ---------------------------------------------------------------------------

describe('SUP-200: GET /api/agents/:id/files/* — workspace containment', () => {
  beforeEach(() => {
    agentDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sup200-'))
  })

  afterEach(() => {
    if (agentDataRoot) fs.rmSync(agentDataRoot, { recursive: true, force: true })
  })

  it('rejects downloading files from a sibling agent directory with the same slug prefix', async () => {
    const attackerDir = path.join(agentDataRoot, 'agent')
    const victimDir = path.join(agentDataRoot, 'agent-victim')
    fs.mkdirSync(attackerDir, { recursive: true })
    fs.mkdirSync(victimDir, { recursive: true })
    fs.writeFileSync(path.join(victimDir, 'secret.txt'), 'victim secret')

    const res = await appWithAgents().request('http://localhost/api/agents/agent/files/%2e%2e%2fagent-victim/secret.txt')

    expect(res.status).toBe(400)
  })

  it('still serves a legitimate file inside the agent workspace', async () => {
    const workspace = path.join(agentDataRoot, 'agent')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'report.txt'), 'hello world')

    const res = await appWithAgents().request('http://localhost/api/agents/agent/files/report.txt')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello world')
  })
})

// ---------------------------------------------------------------------------
// SUP-201
// ---------------------------------------------------------------------------
//
// The platform-auth `/complete` and `/revoke` endpoints write/clear a single
// deployment-global `settings.platformAuth` record and ignore the calling user.
// In AUTH_MODE the UI renders these controls read-only ("managed by this
// deployment"), but the API was guarded only by `Authenticated()`, so any
// logged-in user could overwrite or wipe the shared platform identity.
//
// These tests mount the REAL route (service mocked) and assert that, in auth
// mode, an ordinary user is rejected with a 4xx and the mutating service
// functions are never reached.

describe('platform auth: deployment-global mutation guard (SUP-201)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Auth mode on, no env-managed PLATFORM_TOKEN — the deployment-global
    // settings record is what would be written.
    mockIsAuthMode.mockReturnValue(true)
    delete process.env.PLATFORM_TOKEN
    mockSavePlatformAuth.mockResolvedValue({ connected: true, tokenPreview: 'plat_…', email: null })
    mockRevokePlatformToken.mockResolvedValue(true)
    mockGetPlatformAuthStatus.mockReturnValue({ connected: false })
  })

  it('rejects changing deployment-global platform auth in auth mode without an env token', async () => {
    const res = await appWithPlatformAuth().request('http://localhost/api/platform-auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'plat_attacker_token_1234567890abcdef',
        orgId: 'attacker-org',
        userId: 'attacker-platform-user',
        memberId: 'attacker-member',
      }),
    })

    expectClientError(res.status)
    expect(mockSavePlatformAuth).not.toHaveBeenCalled()
  })

  it('rejects revoking deployment-global platform auth in auth mode without an env token', async () => {
    const res = await appWithPlatformAuth().request('http://localhost/api/platform-auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearLocal: true }),
    })

    expectClientError(res.status)
    expect(mockRevokePlatformToken).not.toHaveBeenCalled()
  })

  // Guard must not regress local/Electron (non-auth) mode, where platform auth
  // is genuinely user-owned and the connect/disconnect flow is expected to work.
  it('still allows platform auth changes when auth mode is disabled', async () => {
    mockIsAuthMode.mockReturnValue(false)

    const complete = await appWithPlatformAuth().request('http://localhost/api/platform-auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'plat_local_token_1234567890', orgId: 'my-org' }),
    })
    expect(complete.status).toBe(200)
    expect(mockSavePlatformAuth).toHaveBeenCalledOnce()

    const revoke = await appWithPlatformAuth().request('http://localhost/api/platform-auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearLocal: true }),
    })
    expect(revoke.status).toBe(200)
    expect(mockRevokePlatformToken).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// SUP-199
// ---------------------------------------------------------------------------
//
// `POST /api/agents/:id/remote-mcps` and
// `POST /api/agents/:id/sessions/:sessionId/provide-remote-mcp` only proved the
// caller had `AgentUser()` access to the target agent — not that the requested
// `mcpIds` belong to the acting user. In auth mode a user with access to any
// agent could attach another user's remote MCP by id, after which the agent's
// mcp-proxy token would use the victim MCP's stored bearer/OAuth credentials.
//
// Both routes now resolve the requested ids scoped to the acting user before
// inserting any `agent_remote_mcps` mapping. The ownership filter is gated on
// `isAuthMode()`, so single-user (non-auth) installs are unaffected.
//
// Harness note: `selectQueue` feeds the route's ownership lookup first, then its
// existing-mappings lookup. `mockDbInsertValues` records mapping inserts.

describe('SUP-199: remote MCP assignment ownership (AUTH_MODE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectQueue = []
    mockIsAuthMode.mockReturnValue(true)
  })

  it('rejects attaching another user remote MCP id to an agent', async () => {
    // Ownership lookup returns nothing → the acting user owns no requested MCP.
    selectQueue = [[]]

    const res = await appWithAgents().request('http://localhost/api/agents/attacker-agent/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['victim-mcp-id'] }),
    })

    expectClientError(res.status)
    expect(mockDbInsertValues).not.toHaveBeenCalled()
  })

  it('rejects providing another user remote MCP id at runtime approval', async () => {
    selectQueue = [[]]

    const res = await appWithAgents().request('http://localhost/api/agents/attacker-agent/sessions/sess-1/provide-remote-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: 'tu-1', remoteMcpId: 'victim-mcp-id' }),
    })

    expectClientError(res.status)
    expect(mockDbInsertValues).not.toHaveBeenCalled()
  })

  it('allows attaching a remote MCP the acting user owns', async () => {
    // 1) ownership lookup → owned; 2) existing-mappings lookup → none.
    selectQueue = [[{ id: 'my-mcp-id' }], []]

    const res = await appWithAgents().request('http://localhost/api/agents/my-agent/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['my-mcp-id'] }),
    })

    expect(res.status).toBe(200)
    expect(mockDbInsertValues).toHaveBeenCalledTimes(1)
    expect(mockDbInsertValues).toHaveBeenCalledWith([
      expect.objectContaining({ agentSlug: 'my-agent', remoteMcpId: 'my-mcp-id' }),
    ])
  })

  it('does not gate on ownership when auth mode is disabled', async () => {
    mockIsAuthMode.mockReturnValue(false)
    // Ownership lookup is skipped entirely in non-auth mode, so the only select
    // is the existing-mappings lookup → none assigned yet.
    selectQueue = [[]]

    const res = await appWithAgents().request('http://localhost/api/agents/my-agent/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['shared-mcp-id'] }),
    })

    expect(res.status).toBe(200)
    expect(mockDbInsertValues).toHaveBeenCalledTimes(1)
  })
})
