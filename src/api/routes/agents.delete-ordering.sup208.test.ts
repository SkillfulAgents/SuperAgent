import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// SUP-208: agent delete must run peripheral cleanup BEFORE the irreversible
// workspace removal.
//
// `DELETE /api/agents/:id` used to call `deleteAgent(slug)` (which removes the
// agent workspace directory) first, then run `deletePoliciesForAgent` and
// `cleanupAgentData`. If peripheral cleanup threw, the route returned 500 with
// the workspace already gone, orphaning scheduled tasks / integrations / ACLs /
// policies / messages / audit rows that point at a non-existent agent.
//
// These tests mount the REAL agents router (its db + peripheral services
// mocked) and assert ordering:
//   1. when `cleanupAgentData` rejects, `deleteAgent` (workspace removal) must
//      NOT have been called — peripheral cleanup gates the irreversible step.
//   2. in the happy path, `cleanupAgentData` + `deletePoliciesForAgent` run
//      BEFORE `deleteAgent` (asserted via mock.invocationCallOrder).
//
// Recorded mock fns are prefixed `mock*` so they can be referenced from the
// hoisted `vi.mock` factories; the router is imported at the bottom of the file
// after every mock is registered.
// ---------------------------------------------------------------------------

// --- agent-service ----------------------------------------------------------
// `getAgent` provides the existence check + audit name; `deleteAgent` is the
// irreversible workspace removal we are gating.
const mockGetAgent = vi.fn()
const mockDeleteAgent = vi.fn()
// SUP-209: a genuine container stop-failure surfaces from deleteAgent as this
// typed error, which the route maps to 409. Hoisted so the mock factory and the
// test share one class — the route's `instanceof` resolves to this same
// stand-in via the mocked module.
const { AgentContainerStopError } = vi.hoisted(() => ({
  AgentContainerStopError: class AgentContainerStopError extends Error {
    readonly slug: string
    constructor(slug: string, cause: unknown) {
      super(`Failed to stop the container for agent "${slug}": ${cause instanceof Error ? cause.message : String(cause)}`)
      this.name = 'AgentContainerStopError'
      this.slug = slug
    }
  },
}))
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(),
  createAgent: vi.fn(),
  getAgentWithStatus: vi.fn(),
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
  updateAgent: vi.fn(),
  deleteAgent: (...args: unknown[]) => mockDeleteAgent(...args),
  agentExists: vi.fn().mockResolvedValue(true),
  AgentContainerStopError,
}))

// --- peripheral cleanup services --------------------------------------------
const mockCleanupAgentData = vi.fn()
vi.mock('@shared/lib/services/agent-cleanup-service', () => ({
  cleanupAgentData: (...args: unknown[]) => mockCleanupAgentData(...args),
}))

const mockDeletePoliciesForAgent = vi.fn()
vi.mock('@shared/lib/services/x-agent-policy-service', () => ({
  deletePoliciesForAgent: (...args: unknown[]) => mockDeletePoliciesForAgent(...args),
  listPoliciesForCaller: vi.fn(() => []),
  replacePoliciesForCaller: vi.fn(),
  replacePoliciesForCallerInputSchema: { safeParse: vi.fn(() => ({ success: false, error: {} })) },
}))

const mockRevokeProxyToken = vi.fn()
vi.mock('@shared/lib/proxy/token-store', () => ({
  revokeProxyToken: (...args: unknown[]) => mockRevokeProxyToken(...args),
  validateProxyToken: vi.fn(),
}))

const mockRemoveClient = vi.fn()
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({ fetch: vi.fn(), sendMessage: vi.fn(), start: vi.fn(), stop: vi.fn() }),
    ensureRunning: vi.fn(),
    getCachedInfo: () => ({ status: 'running', port: 8080 }),
    removeClient: (...args: unknown[]) => mockRemoveClient(...args),
    keepAlive: vi.fn(),
  },
}))

const mockLogAuditEvent = vi.fn()
vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}))

// --- generic db / orm harness (unused by the DELETE path; satisfies imports) -
vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]), all: () => [] }) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
    transaction: (cb: (tx: unknown) => unknown) => cb({}),
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

// --- auth + config ----------------------------------------------------------
const mockAuthUser = { id: 'test-user-id', name: 'Test User', email: 'test@example.com' }
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentRead: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentUser: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentAdmin: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
}))

vi.mock('@shared/lib/auth/config', () => ({
  getAppBaseUrlFromRequest: () => 'http://localhost:3000',
  getCurrentUserId: () => 'test-user-id',
}))

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))

vi.mock('@shared/lib/config/settings', () => ({
  getAccountProviderUserId: () => 'test-user',
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({ summarizerModel: 'claude-3-haiku' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {}, skillsets: [] }),
  VALID_SCRIPT_TYPES: [],
}))

// --- remaining imports pulled in by the agents router -----------------------
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))

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

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  countActiveTriggersPerAccount: vi.fn().mockResolvedValue({}),
  listWebhookTriggers: vi.fn(), listActiveWebhookTriggers: vi.fn(), listCancelledWebhookTriggers: vi.fn(),
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
    getPendingReviewsForAgent: () => [], submitDecision: vi.fn(), resolveMatchingPending: vi.fn(),
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

function deleteAgentReq() {
  return appWithAgents().request('http://localhost/api/agents/test-agent', { method: 'DELETE' })
}

describe('SUP-208: DELETE /api/agents/:id — peripheral cleanup precedes workspace removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default happy-path wiring: agent exists, all cleanup steps succeed.
    mockGetAgent.mockResolvedValue({ slug: 'test-agent', frontmatter: { name: 'Test Agent' } })
    mockDeleteAgent.mockResolvedValue(true)
    mockDeletePoliciesForAgent.mockResolvedValue(undefined)
    mockCleanupAgentData.mockResolvedValue(undefined)
    mockRevokeProxyToken.mockResolvedValue(undefined)
  })

  it('does not remove the workspace before peripheral cleanup succeeds', async () => {
    // cleanupAgentData fails — the irreversible workspace removal must not have
    // run, so the operation is safely retryable instead of half-destroyed.
    mockCleanupAgentData.mockRejectedValue(new Error('db cleanup failed'))

    const res = await deleteAgentReq()

    expect(res.status).toBe(500)
    expect(mockDeleteAgent).not.toHaveBeenCalled()
  })

  it('does not remove the workspace if policy cleanup fails', async () => {
    mockDeletePoliciesForAgent.mockRejectedValue(new Error('policy cleanup failed'))

    const res = await deleteAgentReq()

    expect(res.status).toBe(500)
    expect(mockDeleteAgent).not.toHaveBeenCalled()
  })

  it('runs peripheral cleanup BEFORE the irreversible workspace removal (happy path)', async () => {
    const res = await deleteAgentReq()

    expect(res.status).toBe(204)
    expect(mockDeleteAgent).toHaveBeenCalledTimes(1)
    expect(mockCleanupAgentData).toHaveBeenCalledTimes(1)
    expect(mockDeletePoliciesForAgent).toHaveBeenCalledTimes(1)

    const deleteOrder = mockDeleteAgent.mock.invocationCallOrder[0]
    const cleanupOrder = mockCleanupAgentData.mock.invocationCallOrder[0]
    const policyOrder = mockDeletePoliciesForAgent.mock.invocationCallOrder[0]

    expect(cleanupOrder).toBeLessThan(deleteOrder)
    expect(policyOrder).toBeLessThan(deleteOrder)
  })

  it('returns 404 and never touches the workspace when the agent does not exist', async () => {
    mockGetAgent.mockResolvedValue(null)

    const res = await deleteAgentReq()

    expect(res.status).toBe(404)
    expect(mockDeleteAgent).not.toHaveBeenCalled()
    expect(mockCleanupAgentData).not.toHaveBeenCalled()
  })

  it('returns 409 (not 500) with an actionable message when the container cannot be stopped (SUP-209)', async () => {
    // deleteAgent aborts with the typed stop-failure error AFTER peripheral
    // cleanup has run but BEFORE the workspace is removed. The route must map it
    // to an actionable 409 so the UI can tell the user to retry, not a generic 500.
    mockDeleteAgent.mockRejectedValue(
      new AgentContainerStopError('test-agent', new Error('runtime wedged: cannot stop container'))
    )

    const res = await deleteAgentReq()

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/container/i)
    // Peripheral cleanup still ran (it precedes the stop); only the workspace survived.
    expect(mockCleanupAgentData).toHaveBeenCalledTimes(1)
  })
})
