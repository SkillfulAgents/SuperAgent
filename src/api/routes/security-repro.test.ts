import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ============================================================================
// Security regression guardrails for the agent workspace file download route.
//
// Unlike agents.test.ts (which mocks `fs` wholesale), this suite exercises the
// route against the REAL filesystem so that the actual path resolution and
// containment check are validated end to end. `getAgentWorkspaceDir` is pointed
// at a throwaway temp dir that stands in for the agents data root, so that
// getAgentWorkspaceDir(slug) === <agentDataRoot>/<slug>. That layout lets us
// reproduce the sibling-prefix traversal: workspace "agent" and sibling
// "agent-victim" share the "agent" path prefix.
// ============================================================================

// Real temp dir acting as the agents data root. Each test gets a fresh one.
let agentDataRoot = ''

// ============================================================================
// Mocks — must be declared before importing the router. We deliberately do NOT
// mock `fs` or `stream`; everything else mirrors agents.test.ts so the heavy
// dependency graph (db, container manager, services, …) imports cleanly.
// ============================================================================

// Auth middleware — passthrough.
const mockAuthUser = { id: 'test-user-id', name: 'Test User', email: 'test@example.com' }
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentRead: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentUser: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentAdmin: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
}))

// Container manager
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

// DB
vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: vi.fn() }) }),
    delete: () => ({ where: vi.fn() }),
    update: () => ({ set: vi.fn() }),
    transaction: (cb: (...a: unknown[]) => unknown) => cb({
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({ all: () => [] }) }) }) }),
      update: () => ({ set: () => ({ where: () => ({ run: vi.fn() }) }) }),
      delete: () => ({ where: () => ({ run: vi.fn() }) }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {}, agentConnectedAccounts: {}, proxyAuditLog: {}, remoteMcpServers: {},
  agentRemoteMcps: {}, mcpAuditLog: {}, agentAcl: {}, user: {}, messageAuthor: {},
  apiScopePolicies: {}, mcpToolPolicies: {},
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

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'test-user-id' }))

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

vi.mock('@shared/lib/account-providers', () => ({ getProvider: vi.fn() }))

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

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({ summarizerModel: 'claude-3-haiku' }),
  getEffectiveAgentLimits: () => ({}), getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {}, skillsets: [] }),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({ revokeProxyToken: vi.fn(), validateProxyToken: vi.fn() }))

// Point getAgentWorkspaceDir at our temp data root so getAgentWorkspaceDir(slug)
// === <agentDataRoot>/<slug>. All other exports are stubbed (the download route
// only needs getAgentWorkspaceDir; the rest exist so the module imports).
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

// Import the agents router after all mocks are set up.
import agents from './agents'

// ============================================================================
// Helpers
// ============================================================================

function appWithAgents() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/agents/:id/files/* — workspace containment', () => {
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
