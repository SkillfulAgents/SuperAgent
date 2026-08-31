import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockGetAgent = vi.fn<(...args: unknown[]) => unknown>()
const { AgentContainerStopError } = vi.hoisted(() => ({
  AgentContainerStopError: class AgentContainerStopError extends Error {
    readonly slug: string
    constructor(slug: string, _cause: unknown) {
      super(`Failed to stop the container for agent "${slug}"`)
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
  deleteAgent: vi.fn(),
  agentExists: vi.fn().mockResolvedValue(true),
  AgentContainerStopError,
}))

vi.mock('@shared/lib/services/agent-cleanup-service', () => ({
  cleanupAgentData: vi.fn(),
}))

vi.mock('@shared/lib/services/x-agent-policy-service', () => ({
  deletePoliciesForAgent: vi.fn(),
  listPoliciesForCaller: vi.fn(() => []),
  replacePoliciesForCaller: vi.fn(),
  replacePoliciesForCallerInputSchema: { safeParse: vi.fn(() => ({ success: false, error: {} })) },
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  revokeProxyToken: vi.fn(),
  validateProxyToken: vi.fn(),
}))

const mockSendMessage = vi.fn()
const mockEnsureRunning = vi.fn<(...args: unknown[]) => Promise<{ sendMessage: typeof mockSendMessage }>>(async () => ({ sendMessage: mockSendMessage }))
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({ fetch: vi.fn(), sendMessage: mockSendMessage, start: vi.fn(), stop: vi.fn() }),
    ensureRunning: (...args: unknown[]) => mockEnsureRunning(...args),
    getCachedInfo: () => ({ status: 'running', port: 8080 }),
    removeClient: vi.fn(),
    keepAlive: vi.fn(),
  },
}))

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: vi.fn(),
}))

const accessRows: Array<Record<string, unknown>> = []
const userEmailRows: Array<{ id: string; email: string; name: string }> = []
vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => {
      const chain: Record<string, unknown> = {}
      const resolve = () => Promise.resolve(accessRows.length ? accessRows : userEmailRows)
      chain.from = () => chain
      chain.innerJoin = () => chain
      chain.where = () => chain
      chain.limit = () => chain
      chain.all = () => []
      chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        resolve().then(onFulfilled, onRejected)
      return chain
    },
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

const mockAuthUser = { id: 'me', name: 'Graham', email: 'g@x' }
const mockGetAuthorizedAgentRole = vi.fn<(...args: unknown[]) => string>(() => 'owner')
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentRead: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentUser: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentAdmin: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (c: { set: (k: string, v: unknown) => void; req: { param: (k: string) => string } }, next: () => Promise<void>) => { c.set('agentId', c.req.param('id')); return next() },
  getAgentId: (c: { get: (k: string) => string; req: { param: (k: string) => string } }) => c.get('agentId') ?? c.req.param('id'),
  getAuthorizedAgentRole: (...args: unknown[]) => mockGetAuthorizedAgentRole(...args),
  getRequestDeviceId: () => null,
}))

vi.mock('@shared/lib/auth/config', () => ({
  getAppBaseUrlFromRequest: () => 'http://localhost:3000',
  getCurrentUserId: () => 'me',
}))

const mockIsAuthMode = vi.fn<(...args: unknown[]) => boolean>(() => true)
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: (...args: unknown[]) => mockIsAuthMode(...args) }))

vi.mock('@shared/lib/config/settings', () => ({
  getAccountProviderUserId: () => 'test-user',
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({ summarizerModel: 'claude-3-haiku' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {}, skillsets: [] }),
  VALID_SCRIPT_TYPES: [],
}))

const mockTrackServerEvent = vi.fn<(...args: unknown[]) => unknown>()
const mockResolveAnalyticsUserId = vi.fn((id: string) => `analytics:${id}`)
vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: (...args: unknown[]) => mockTrackServerEvent(...args),
  resolveAnalyticsUserId: (id: string) => mockResolveAnalyticsUserId(id),
}))

const mockPromoteAutomatedSession = vi.fn<(...args: unknown[]) => unknown>()
const mockMarkSessionActive = vi.fn<(...args: unknown[]) => unknown>()
const mockCancelAwaitingInput = vi.fn<(...args: unknown[]) => unknown>()
const mockCoalesceIfRecovering = vi.fn<(...args: unknown[]) => boolean>(() => false)
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(), broadcastSessionUpdate: vi.fn(), persistMessage: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(), isSessionActive: vi.fn(() => false),
    isSessionAwaitingInput: vi.fn(() => false), hasActiveSessionsForAgent: vi.fn(() => false),
    hasSessionsAwaitingInputForAgent: vi.fn(() => false), isSubscribed: vi.fn(() => true),
    subscribeToSession: vi.fn(), unsubscribeFromSession: vi.fn(),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
    broadcastSessionEvent: vi.fn(),
    promoteAutomatedSession: (...args: unknown[]) => mockPromoteAutomatedSession(...args),
    cancelAwaitingInput: (...args: unknown[]) => mockCancelAwaitingInput(...args),
    coalesceIfRecovering: (...args: unknown[]) => mockCoalesceIfRecovering(...args),
  },
}))

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  countActiveTriggersPerAccount: vi.fn().mockResolvedValue({}),
  listWebhookTriggers: vi.fn(), listActiveWebhookTriggers: vi.fn(), listCancelledWebhookTriggers: vi.fn(),
}))

const mockGetSessionMetadata = vi.fn<(...args: unknown[]) => unknown>()
const mockListSessionsFromSummary = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => [])
vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: vi.fn(), listSessionsFromSummary: (...args: unknown[]) => mockListSessionsFromSummary(...args), updateSessionName: vi.fn(), registerSession: vi.fn(),
  getSessionMessagesWithCompact: vi.fn(), getSession: vi.fn(),
  getSessionMetadata: (...args: unknown[]) => mockGetSessionMetadata(...args),
  sessionExists: vi.fn().mockResolvedValue(true), sessionBelongsToAgent: vi.fn().mockResolvedValue(true),
  sessionIsKnown: vi.fn().mockResolvedValue(true),
  reserveSessionOwnership: vi.fn().mockResolvedValue(undefined), updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
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
  listPendingWakesByAgent: vi.fn(async () => []),
  getPendingWakeForSession: vi.fn(async () => null),
}))

vi.mock('@shared/lib/services/session-unread-service', () => ({
  markSessionUnread: vi.fn(),
  clearSessionUnread: vi.fn(),
  getSessionIdsMarkedUnread: vi.fn(async () => new Set()),
  getSessionIdsMarkedUnreadByAgents: vi.fn(async () => new Map()),
  deleteSessionUnreadMarks: vi.fn(),
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

const mockGetAgentAccessUserIds = vi.fn<(...args: unknown[]) => Promise<string[]>>(async () => ['me', 'u2'])
const mockGetOldestUnreadMentionBySession = vi.fn<(...args: unknown[]) => Promise<Map<string, string>>>(async () => new Map())
const mockGetSessionIdsWithUnreadNotifications = vi.fn<(...args: unknown[]) => Promise<Set<string>>>(async () => new Set())
vi.mock('@shared/lib/services/notification-service', () => ({
  getSessionIdsWithUnreadNotifications: (...args: unknown[]) => mockGetSessionIdsWithUnreadNotifications(...args),
  getUnreadNotificationsByAgents: vi.fn(() => Promise.resolve(new Map())),
  getSessionIdsWithUnreadMentionsByAgents: vi.fn(() => Promise.resolve(new Map())),
  getAgentAccessUserIds: (...args: unknown[]) => mockGetAgentAccessUserIds(...args),
  getOldestUnreadMentionBySession: (...args: unknown[]) => mockGetOldestUnreadMentionBySession(...args),
  deleteNotificationsBySessionIds: vi.fn(),
}))

const mockTriggerSessionMentions = vi.fn<(...args: unknown[]) => unknown>()
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionMentions: (...args: unknown[]) => mockTriggerSessionMentions(...args),
  },
}))

vi.mock('@shared/lib/services/session-summary-cache', () => ({
  recordSessionActivity: vi.fn(),
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
  getSessionJsonlPath: vi.fn(), readFileOrNull: vi.fn(), writeFile: vi.fn(),
  getAgentSessionsDir: vi.fn(() => '/mock/sessions'), readJsonlFile: vi.fn(),
  getAgentWorkspaceDir: vi.fn((slug: string) => `/mock/workspace/${slug}`),
  getAgentPreferencesPath: vi.fn((slug: string) => `/mock/workspace/${slug}/agent-preferences.json`),
  getTempUploadsDir: vi.fn(() => '/mock/tmp/uploads'),
  ensureDirectory: vi.fn(), removeDirectory: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))
vi.mock('hono/streaming', () => ({ streamSSE: vi.fn() }))

import agents from './agents'

function appWithAgents() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

function post(body: Record<string, unknown>) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('session mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    accessRows.length = 0
    userEmailRows.length = 0
    userEmailRows.push({ id: 'u2', email: 'i@x', name: 'Iddo Gino' })
    mockIsAuthMode.mockReturnValue(true)
    mockGetAuthorizedAgentRole.mockReturnValue('owner')
    mockGetAgent.mockResolvedValue({ slug: 'billing', name: 'Billing', frontmatter: { name: 'Billing' } })
    mockGetSessionMetadata.mockResolvedValue({ name: 'Refunds' })
    mockGetAgentAccessUserIds.mockResolvedValue(['me', 'u2'])
    mockTriggerSessionMentions.mockResolvedValue(undefined)
    mockSendMessage.mockResolvedValue(undefined)
    mockListSessionsFromSummary.mockResolvedValue([])
    mockGetOldestUnreadMentionBySession.mockResolvedValue(new Map())
    mockGetSessionIdsWithUnreadNotifications.mockResolvedValue(new Set())
  })

  it('rejects a marker for a user outside the ACL and writes nothing', async () => {
    const res = await appWithAgents().request('/api/agents/billing/sessions/s1/messages', post({ content: 'hi [[mention:outsider|X]]' }))
    expect(res.status).toBe(400)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockTriggerSessionMentions).not.toHaveBeenCalled()
  })

  it('appends without a turn, skips active-state mutations, notifies, tracks', async () => {
    const res = await appWithAgents().request('/api/agents/billing/sessions/s1/messages', post({ content: 'hi [[mention:u2|Iddo Gino]]' }))
    expect(res.status).toBe(201)
    const { uuid } = await res.json() as { uuid: string }
    expect(mockSendMessage).toHaveBeenCalledWith('s1', expect.stringContaining('[[mention-context: Graham tagged'), uuid, expect.objectContaining({ shouldQuery: false }))
    expect(mockMarkSessionActive).not.toHaveBeenCalled()
    expect(mockPromoteAutomatedSession).not.toHaveBeenCalled()
    expect(mockCancelAwaitingInput).not.toHaveBeenCalled()
    expect(mockTriggerSessionMentions).toHaveBeenCalledWith(expect.objectContaining({ recipients: [{ userId: 'u2', name: 'Iddo Gino' }], messageUuid: uuid }))
    expect(mockTrackServerEvent).toHaveBeenCalledWith('added_user_tag_in_session', expect.objectContaining({ taggeeId: 'u2', taggerId: 'me' }), 'analytics:me')
    expect(mockTrackServerEvent).toHaveBeenCalledWith('tagged_in_session', expect.objectContaining({ taggeeId: 'u2' }), 'analytics:u2')
  })

  it('does not track when the notification batch fails', async () => {
    mockTriggerSessionMentions.mockRejectedValueOnce(new Error('db'))
    const res = await appWithAgents().request('/api/agents/billing/sessions/s1/messages', post({ content: '[[mention:u2|Iddo]]' }))
    expect(res.status).toBe(201)
    expect(mockTrackServerEvent).not.toHaveBeenCalled()
  })

  it('rewrites a spoofed display name from membership before persist', async () => {
    const res = await appWithAgents().request('/api/agents/billing/sessions/s1/messages', post({ content: 'hi [[mention:u2|Not Iddo]]' }))
    expect(res.status).toBe(201)
    expect(mockSendMessage).toHaveBeenCalledWith('s1', expect.stringContaining('[[mention:u2|Iddo%20Gino]]'), expect.any(String), expect.anything())
    expect(mockTriggerSessionMentions).toHaveBeenCalledWith(expect.objectContaining({ recipients: [{ userId: 'u2', name: 'Iddo Gino' }] }))
  })

  it('rejects mentions when the agent is not shared', async () => {
    mockIsAuthMode.mockReturnValue(false)
    const res = await appWithAgents().request('/api/agents/billing/sessions/s1/messages', post({ content: 'hi [[mention:u2|Iddo]]' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Mentions need a shared agent' })
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockTriggerSessionMentions).not.toHaveBeenCalled()
  })

  it('ignores a client-supplied shouldQuery:true when markers are present', async () => {
    await appWithAgents().request('/api/agents/billing/sessions/s1/messages', post({ content: '[[mention:u2|Iddo]]', shouldQuery: true }))
    expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ shouldQuery: false }))
  })

  it('non-admin member gets the narrow access projection', async () => {
    mockGetAuthorizedAgentRole.mockReturnValue('user')
    accessRows.push(
      { userId: 'me', role: 'owner', createdAt: new Date(), userName: 'Graham', userEmail: 'g@x' },
      { userId: 'u2', role: 'user', createdAt: new Date(), userName: 'Iddo Gino', userEmail: 'i@x' },
    )
    const res = await appWithAgents().request('/api/agents/billing/access')
    expect(await res.json()).toEqual([{ userId: 'me', userName: 'Graham', userEmail: 'g@x' }, { userId: 'u2', userName: 'Iddo Gino', userEmail: 'i@x' }])
  })

  it('session list carries the oldest unread mention for the current user only', async () => {
    mockListSessionsFromSummary.mockResolvedValue([{ id: 's1', agentSlug: 'billing', name: 'Refunds', createdAt: new Date(), lastActivityAt: new Date(), messageCount: 1 }])
    mockGetOldestUnreadMentionBySession.mockResolvedValue(new Map([['s1', 'm-old']]))
    mockGetSessionIdsWithUnreadNotifications.mockResolvedValue(new Set(['s1']))
    const mine = await (await appWithAgents().request('/api/agents/billing/sessions')).json() as Array<Record<string, unknown>>
    expect(mine.find((s) => s.id === 's1')).toMatchObject({ hasUnreadNotifications: true, unreadMentionMessageUuid: 'm-old' })

    mockGetOldestUnreadMentionBySession.mockResolvedValue(new Map())
    mockGetSessionIdsWithUnreadNotifications.mockResolvedValue(new Set())
    const theirs = await (await appWithAgents().request('/api/agents/billing/sessions')).json() as Array<Record<string, unknown>>
    expect(theirs.find((s) => s.id === 's1')).toMatchObject({ hasUnreadNotifications: false, unreadMentionMessageUuid: null })
  })
})
