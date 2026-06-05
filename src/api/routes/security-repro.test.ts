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
//
// The mock preamble is shared across both suites. `vi.mock` is module-scoped
// and hoisted, so a module can only be mocked once per file — the blocks below
// satisfy the union of what both routers import. The agent download route never
// touches the db, so the SUP-198 db mock serves both suites unchanged.
// ---------------------------------------------------------------------------

// --- SUP-198 db harness -----------------------------------------------------
// The db mock is driven by `selectQueue`: each terminal `.limit()` of a select
// chain shifts the next pre-seeded result. `updateWhereCalls` records every
// `db.update(...).set(...).where(...)` so we can assert no write happened.
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
        }),
        orderBy: () => ({ $dynamic: () => ({ where: () => mockDbSelectLimit() }) }),
      }),
    }),
    insert: () => ({ values: (...vArgs: unknown[]) => mockDbInsertValues(...vArgs) }),
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

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => true,
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
