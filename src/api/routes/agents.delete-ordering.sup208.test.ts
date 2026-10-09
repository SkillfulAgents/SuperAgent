import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// Agent deletion drains while credentials still work, cleans up peripheral
// rows, then removes the workspace. Exercise the real router with an explicit
// service boundary for the final irreversible removal.
// --- agent-service ----------------------------------------------------------
// `getAgent` provides the existence check + audit name; `deleteAgent` is the
// irreversible workspace removal we are gating.
const mockGetAgent = vi.fn()
const mockDeleteAgent = vi.fn()
const mockRemoveWorkspace = vi.fn()
const mockStopContainer = vi.fn()
const mockStartContainer = vi.fn()
const mockRemoveMount = vi.fn()
// SUP-209: a genuine container stop-failure surfaces from deleteAgent as this
// typed error, which the route maps to 409. Hoisted so the mock factory and the
// test share one class — the route's `instanceof` resolves to this same
// stand-in via the mocked module.
const { AgentContainerStopError } = vi.hoisted(() => ({
  AgentContainerStopError: class AgentContainerStopError extends Error {
    readonly slug: string
    constructor(slug: string, cause: unknown) {
      super(`Failed to stop the container for agent "${slug}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
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
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      getClient: () => ({ fetch: vi.fn(), sendMessage: vi.fn(), start: vi.fn(), stop: vi.fn() }),
      ensureRunning: (...args: unknown[]) => mockStartContainer(...args),
      stopContainer: (...args: unknown[]) => mockStopContainer(...args),
      getCachedInfo: () => ({ status: 'running', port: 8080 }),
      removeClient: (...args: unknown[]) => mockRemoveClient(...args),
      keepAlive: vi.fn(),
    }),
  }
})

const mockLogAuditEvent = vi.fn()
vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}))

vi.mock('@shared/lib/services/mount-service', () => ({
  getMountsWithHealth: vi.fn(), addMount: vi.fn(), attachMount: vi.fn(),
  removeMount: (...args: unknown[]) => mockRemoveMount(...args), volumeSummary: vi.fn(),
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
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (c: any, next: () => Promise<void>) => { c.set('agentId', c.req.param('id')); return next() },
  getAgentId: (c: any) => c.get('agentId') ?? c.req.param('id'),
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
  listSessions: vi.fn(), listSessionsFromSummary: vi.fn(), updateSessionName: vi.fn(), registerSession: vi.fn(),
  getSessionMessagesWithCompact: vi.fn(), getSession: vi.fn(), getSessionMetadata: vi.fn(),
  sessionExists: vi.fn().mockResolvedValue(true), updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn(), removeMessage: vi.fn(), removeToolCall: vi.fn(),
  getSessionSummary: vi.fn().mockResolvedValue({ sessionIds: [], sessionCount: 0, lastActivityAt: null }),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  listSecrets: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn(), updateSecret: vi.fn(), deleteSecret: vi.fn(),
  getSecretEnvVars: vi.fn(),
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

vi.mock('@shared/lib/services/agent-integration-service', () => ({
  listAgentIntegrations: vi.fn(() => []), listAgentIntegrationsByAgents: vi.fn(() => new Map()),
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
  getAgentTemplatePrompt: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/lib/utils/retry', () => ({ withRetry: vi.fn((fn: () => unknown) => fn()) }))

vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({ messages: { create: vi.fn() } }),
  extractTextFromLlmResponse: () => null,
  createSummarizerText: async () => null,
}))

vi.mock('@shared/lib/utils/message-transform', () => ({
  transformMessages: vi.fn(), resolveInterruptedSubagents: vi.fn(),
}))

vi.mock('@shared/lib/utils/file-storage', () => ({
  displaySlug: (_name: string, slug: string) => slug,
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
import { ContainerStopDeferredError } from '@shared/lib/container/volume-stop-schema'

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
    mockDeleteAgent.mockImplementation(async (_slug, options) => {
      await options?.cleanup?.()
      mockRemoveWorkspace()
      return true
    })
    mockStopContainer.mockResolvedValue(undefined)
    mockStartContainer.mockResolvedValue(undefined)
    mockRemoveMount.mockResolvedValue(undefined)
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
    expect(mockRemoveWorkspace).not.toHaveBeenCalled()
  })

  it('does not remove the workspace if policy cleanup fails', async () => {
    mockDeletePoliciesForAgent.mockRejectedValue(new Error('policy cleanup failed'))

    const res = await deleteAgentReq()

    expect(res.status).toBe(500)
    expect(mockRemoveWorkspace).not.toHaveBeenCalled()
  })

  it('runs peripheral cleanup BEFORE the irreversible workspace removal (happy path)', async () => {
    const res = await deleteAgentReq()

    expect(res.status).toBe(204)
    expect(mockDeleteAgent).toHaveBeenCalledTimes(1)
    expect(mockCleanupAgentData).toHaveBeenCalledTimes(1)
    expect(mockDeletePoliciesForAgent).toHaveBeenCalledTimes(1)

    const deleteOrder = mockRemoveWorkspace.mock.invocationCallOrder[0]
    const cleanupOrder = mockCleanupAgentData.mock.invocationCallOrder[0]
    const policyOrder = mockDeletePoliciesForAgent.mock.invocationCallOrder[0]

    expect(cleanupOrder).toBeLessThan(deleteOrder)
    expect(policyOrder).toBeLessThan(deleteOrder)
  })

  it('returns 404 and never touches the workspace when the agent does not exist', async () => {
    mockGetAgent.mockResolvedValue(null)

    const res = await deleteAgentReq()

    expect(res.status).toBe(404)
    expect(mockRemoveWorkspace).not.toHaveBeenCalled()
    expect(mockCleanupAgentData).not.toHaveBeenCalled()
  })

  it('returns 409 (not 500) with an actionable message when the container cannot be stopped (SUP-209)', async () => {
    // Stop is first; even upload credentials must survive a refused stop.
    mockDeleteAgent.mockRejectedValue(
      new AgentContainerStopError('test-agent', new Error('runtime wedged: cannot stop container'))
    )

    const res = await deleteAgentReq()

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/container/i)
    expect(mockCleanupAgentData).not.toHaveBeenCalled()
    expect(mockRevokeProxyToken).not.toHaveBeenCalled()
  })
  it('returns a structured upload warning and accepts the explicit delete override', async () => {
    mockDeleteAgent.mockRejectedValueOnce(new AgentContainerStopError('test-agent', new ContainerStopDeferredError('Pending uploads', true)))
    const response = await deleteAgentReq()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'volume_stop_deferred', error: 'Pending uploads', workStopped: true })
    expect(mockRevokeProxyToken).not.toHaveBeenCalled()
    const forced = await appWithAgents().request('/api/agents/test-agent?force=true', { method: 'DELETE' })
    expect(forced.status).toBe(204)
    expect(mockDeleteAgent).toHaveBeenLastCalledWith('test-agent', expect.objectContaining({ discardPendingUploads: true }))
  })

  it('leaves the attachment grant in place when detaching cannot drain', async () => {
    mockStopContainer.mockRejectedValueOnce(new ContainerStopDeferredError('Pending uploads'))
    const response = await appWithAgents().request('/api/agents/test-agent/mounts/m1?restart=true', { method: 'DELETE' })
    expect(response.status).toBe(409)
    expect(mockRemoveMount).not.toHaveBeenCalled()
    expect(mockStartContainer).not.toHaveBeenCalled()
  })

  it.each([false, true])('stops before removing the attachment grant (restart=%s)', async restart => {
    const response = await appWithAgents().request(`/api/agents/test-agent/mounts/m1?restart=${restart}&force=true`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(mockStopContainer).toHaveBeenCalledWith('test-agent', { discardPendingUploads: true })
    expect(mockStopContainer.mock.invocationCallOrder[0]).toBeLessThan(mockRemoveMount.mock.invocationCallOrder[0])
    if (restart) {
      expect(mockRemoveMount.mock.invocationCallOrder[0]).toBeLessThan(mockStartContainer.mock.invocationCallOrder[0])
    } else expect(mockStartContainer).not.toHaveBeenCalled()
  })

  it('rejects invalid force options before deleting anything', async () => {
    const response = await appWithAgents().request('/api/agents/test-agent?force=yes', { method: 'DELETE' })
    expect(response.status).toBe(400)
    expect(mockDeleteAgent).not.toHaveBeenCalled()
    expect(mockRevokeProxyToken).not.toHaveBeenCalled()
  })
  it('offers an explicit override for a blocked manual stop', async () => {
    mockStopContainer.mockRejectedValueOnce(new ContainerStopDeferredError('Uploads pending', false))
    const response = await appWithAgents().request('/api/agents/test-agent/stop', { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'volume_stop_deferred', error: 'Uploads pending', workStopped: false })
    const forced = await appWithAgents().request('/api/agents/test-agent/stop?force=true', { method: 'POST' })
    expect(forced.status).toBe(200)
    expect(mockStopContainer).toHaveBeenLastCalledWith('test-agent', { discardPendingUploads: true })
  })
})
