import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// SUP-207 — Auth mode: failed owner ACL insert leaves orphaned agent workspace.
//
// In AUTH_MODE, the three agent-creation routes create the agent's on-disk
// workspace BEFORE inserting the owner ACL row:
//   - POST /api/agents              (createAgent + createOwnerAcl)
//   - POST /api/agents/import-template      (importAgentFromTemplate + createOwnerAcl)
//   - POST /api/agents/install-from-skillset (installAgentFromSkillset + createOwnerAcl)
// If the ACL insert throws, the route returns 500 but never deletes the
// just-created workspace, orphaning an agent dir with no owner ACL.
//
// These tests drive the owner ACL insert to fail and assert the route both
// returns 500 AND rolls back the workspace via deleteAgent(slug). Regression
// cases assert the happy path still 201s without any rollback, and that
// non-auth mode neither inserts an ACL nor rolls back.
//
// The mock preamble mirrors security-repro.test.ts: it satisfies the union of
// everything agents.ts imports at module load. The db mock is driven by
// `mockDbInsertValues`, which we can force to throw to simulate the ACL write
// failing.
// ---------------------------------------------------------------------------

const mockDbInsertValues = vi.fn().mockResolvedValue(undefined)
let selectQueue: unknown[][] = []
const mockDbSelectLimit = vi.fn(() => Promise.resolve(selectQueue.shift() ?? []))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbSelectLimit(),
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => mockDbSelectLimit().then(onF, onR),
        }),
      }),
    }),
    insert: () => ({
      values: (...vArgs: unknown[]) => {
        // Throws here if the test installs a throwing implementation.
        mockDbInsertValues(...vArgs)
        const settled = Promise.resolve(undefined)
        return {
          onConflictDoNothing: () => settled,
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => settled.then(onF, onR),
        }
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {}, agentConnectedAccounts: {}, proxyAuditLog: {}, remoteMcpServers: {},
  agentRemoteMcps: {}, mcpAuditLog: {}, agentAcl: {}, user: {}, messageAuthor: {},
  apiScopePolicies: {}, mcpToolPolicies: {},
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

const mockIsAuthMode = vi.fn(() => true)
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockIsAuthMode() }))

const ACTING_USER_ID = 'creator-user'
vi.mock('@shared/lib/auth/config', () => ({
  getAppBaseUrlFromRequest: () => 'http://localhost:3000',
  getCurrentUserId: () => ACTING_USER_ID,
}))

// Agent service: createAgent/deleteAgent are the rollback boundary under test.
const mockCreateAgent = vi.fn()
const mockDeleteAgent = vi.fn().mockResolvedValue(true)
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(), createAgent: (...a: unknown[]) => mockCreateAgent(...a),
  getAgentWithStatus: vi.fn(), getAgent: vi.fn(), updateAgent: vi.fn(),
  deleteAgent: (...a: unknown[]) => mockDeleteAgent(...a),
  agentExists: vi.fn().mockResolvedValue(true),
}))

const mockImportAgentFromTemplate = vi.fn()
const mockInstallAgentFromSkillset = vi.fn()
vi.mock('@shared/lib/services/agent-template-service', () => ({
  exportAgentTemplate: vi.fn(), exportAgentFull: vi.fn(),
  importAgentFromTemplate: (...a: unknown[]) => mockImportAgentFromTemplate(...a),
  MAX_COMPRESSED_SIZE: 500 * 1024 * 1024,
  installAgentFromSkillset: (...a: unknown[]) => mockInstallAgentFromSkillset(...a),
  updateAgentFromSkillset: vi.fn(), getAgentTemplateStatus: vi.fn(), getDiscoverableAgents: vi.fn(),
  refreshSkillsetCaches: vi.fn(), getAgentPRInfo: vi.fn(), createAgentPR: vi.fn(),
  getAgentPublishInfo: vi.fn(), publishAgentToSkillset: vi.fn(), refreshAgentTemplates: vi.fn(),
  hasOnboardingSkill: vi.fn().mockResolvedValue(false),
}))

// install-from-skillset resolves the skillset config from settings, then builds a
// ref via getSkillsetProvider — stub both so the route reaches createOwnerAcl.
vi.mock('@shared/lib/config/settings', () => ({
  getAccountProviderUserId: () => 'test-user',
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({ summarizerModel: 'claude-3-haiku' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({
    container: {},
    skillsets: [{ id: 'test-skillset', url: 'https://example.com/s', name: 'Test Skillset', provider: 'github', providerData: {} }],
  }),
  VALID_SCRIPT_TYPES: [],
}))

vi.mock('@shared/lib/skillset-provider', () => ({
  getSkillsetProvider: () => ({ normalizeProviderData: () => ({}) }),
}))

const mockAuthUser = { id: ACTING_USER_ID, name: 'Creator', email: 'creator@example.com' }
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

vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))

// Sentry reporting on the ACL-insert / rollback failure paths (mock-prefixed so
// it can be referenced inside the hoisted vi.mock factory).
const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}))

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  countActiveTriggersPerAccount: vi.fn().mockResolvedValue({}),
  listWebhookTriggers: vi.fn(), listActiveWebhookTriggers: vi.fn(), listCancelledWebhookTriggers: vi.fn(),
}))

vi.mock('@shared/lib/account-providers', () => ({
  getDefaultAccountProvider: () => ({}), getAccountProviderByName: () => ({}),
  isValidProviderName: () => true, isProviderSupported: () => true,
  getProvider: (slug: string) => ({ slug, displayName: slug }),
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({ fetch: vi.fn(), sendMessage: vi.fn(), start: vi.fn(), stop: vi.fn() }),
    ensureRunning: vi.fn(), getCachedInfo: () => ({ status: 'running', port: 8080 }),
    removeClient: vi.fn(), keepAlive: vi.fn(),
  },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(), broadcastSessionUpdate: vi.fn(), persistMessage: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(), isSessionActive: vi.fn(() => false),
    isSessionAwaitingInput: vi.fn(() => false), hasActiveSessionsForAgent: vi.fn(() => false),
    hasSessionsAwaitingInputForAgent: vi.fn(() => false), isSubscribed: vi.fn(() => true),
    subscribeToSession: vi.fn(), unsubscribeFromSession: vi.fn(), markSessionActive: vi.fn(),
    broadcastSessionEvent: vi.fn(),
  },
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

vi.mock('@shared/lib/proxy/host-url', () => ({ getContainerHostUrl: () => 'localhost', getAppPort: () => 3000 }))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    getPendingReviewsForAgent: () => [], submitDecision: vi.fn(), resolveMatchingPending: vi.fn(),
    resolveMatchingPendingByLabel: vi.fn(), resolveMatchingXAgentByOperation: vi.fn(),
  },
}))

vi.mock('@shared/lib/utils/retry', () => ({ withRetry: vi.fn((fn: () => unknown) => fn()) }))
vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({ messages: { create: vi.fn() } }),
  extractTextFromLlmResponse: () => null,
  createSummarizerText: async () => null,
}))
vi.mock('@shared/lib/utils/message-transform', () => ({ transformMessages: vi.fn(), resolveInterruptedSubagents: vi.fn() }))
vi.mock('@shared/lib/proxy/token-store', () => ({ revokeProxyToken: vi.fn(), validateProxyToken: vi.fn() }))

vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: vi.fn(), readFileOrNull: vi.fn(), writeFile: vi.fn(),
  getAgentSessionsDir: vi.fn(() => '/mock/sessions'), readJsonlFile: vi.fn(),
  getAgentWorkspaceDir: vi.fn((slug: string) => `/mock/workspace/${slug}`),
  getAgentPreferencesPath: vi.fn((slug: string) => `/mock/workspace/${slug}/agent-preferences.json`),
  getTempUploadsDir: vi.fn(() => '/mock/tmp/uploads'),
  ensureDirectory: vi.fn(), removeDirectory: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))
vi.mock('hono/streaming', () => ({ streamSSE: vi.fn() }))

// Import the router after all mocks are registered.
import agents from './agents'

function appWithAgents() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

function importTemplateFormData(): FormData {
  const fd = new FormData()
  fd.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'template.zip', { type: 'application/zip' }))
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue = []
  mockIsAuthMode.mockReturnValue(true)
  mockDbInsertValues.mockReset()
  mockDbInsertValues.mockResolvedValue(undefined)
  mockDeleteAgent.mockReset()
  mockDeleteAgent.mockResolvedValue(true)
})

describe('SUP-207: owner ACL insert failure rolls back the created workspace (AUTH_MODE)', () => {
  it('POST /api/agents — rolls back the created workspace when the owner ACL insert fails', async () => {
    mockCreateAgent.mockResolvedValue({ slug: 'orphan-agent', name: 'Orphan', status: 'stopped', containerPort: null })
    mockDbInsertValues.mockImplementation(() => { throw new Error('ACL insert failed') })

    const res = await appWithAgents().request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Orphan' }),
    })

    expect(res.status).toBe(500)
    // The workspace must be rolled back so no orphaned agent dir is left behind.
    expect(mockDeleteAgent).toHaveBeenCalledWith('orphan-agent')
    // The ACL-insert failure is reported to Sentry; a clean rollback => warning.
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'owner-acl-insert' }),
        extra: expect.objectContaining({ agentSlug: 'orphan-agent', rolledBack: true }),
        level: 'warning',
      }),
    )
  })

  it('POST /api/agents/import-template — rolls back the imported workspace when the owner ACL insert fails', async () => {
    mockImportAgentFromTemplate.mockResolvedValue({ slug: 'orphan-import', name: 'Imported', status: 'stopped', containerPort: null })
    mockDbInsertValues.mockImplementation(() => { throw new Error('ACL insert failed') })

    const res = await appWithAgents().request('http://localhost/api/agents/import-template', {
      method: 'POST',
      body: importTemplateFormData(),
    })

    expect(res.status).toBe(500)
    expect(mockDeleteAgent).toHaveBeenCalledWith('orphan-import')
  })

  it('POST /api/agents/install-from-skillset — rolls back the installed workspace when the owner ACL insert fails', async () => {
    mockInstallAgentFromSkillset.mockResolvedValue({ slug: 'orphan-skillset', name: 'Installed', status: 'stopped', containerPort: null })
    mockDbInsertValues.mockImplementation(() => { throw new Error('ACL insert failed') })

    const res = await appWithAgents().request('http://localhost/api/agents/install-from-skillset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillsetId: 'test-skillset', agentPath: 'agents/demo' }),
    })

    expect(res.status).toBe(500)
    expect(mockDeleteAgent).toHaveBeenCalledWith('orphan-skillset')
  })

  it('does not mask the original error if the rollback itself fails', async () => {
    mockCreateAgent.mockResolvedValue({ slug: 'orphan-agent', name: 'Orphan', status: 'stopped', containerPort: null })
    mockDbInsertValues.mockImplementation(() => { throw new Error('ACL insert failed') })
    mockDeleteAgent.mockRejectedValue(new Error('cleanup also failed'))

    const res = await appWithAgents().request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Orphan' }),
    })

    // Route still surfaces the original failure as a 500 even though cleanup threw.
    expect(res.status).toBe(500)
    expect(mockDeleteAgent).toHaveBeenCalledWith('orphan-agent')
    // The rollback failure (orphaned workspace) is reported as a distinct error…
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'owner-acl-rollback' }),
        level: 'error',
      }),
    )
    // …and the original ACL-insert failure is escalated to error (orphan left behind).
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'owner-acl-insert' }),
        extra: expect.objectContaining({ rolledBack: false }),
        level: 'error',
      }),
    )
  })
})

describe('SUP-207: regression — successful creation does not roll back', () => {
  it('POST /api/agents — 201 and no rollback when the owner ACL insert succeeds (AUTH_MODE)', async () => {
    mockCreateAgent.mockResolvedValue({ slug: 'good-agent', name: 'Good', status: 'stopped', containerPort: null })

    const res = await appWithAgents().request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Good' }),
    })

    expect(res.status).toBe(201)
    expect(mockDbInsertValues).toHaveBeenCalledTimes(1)
    expect(mockDeleteAgent).not.toHaveBeenCalled()
    // No failure => nothing reported to Sentry.
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('POST /api/agents — non-auth mode inserts no ACL and never rolls back', async () => {
    mockIsAuthMode.mockReturnValue(false)
    mockCreateAgent.mockResolvedValue({ slug: 'local-agent', name: 'Local', status: 'stopped', containerPort: null })

    const res = await appWithAgents().request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local' }),
    })

    expect(res.status).toBe(201)
    expect(mockDbInsertValues).not.toHaveBeenCalled()
    expect(mockDeleteAgent).not.toHaveBeenCalled()
  })
})
