/**
 * Cross-agent session scoping — REAL services, REAL filesystem.
 *
 * `agents.test.ts` already covers this surface, but it mocks `sessionIsKnown`
 * and `sessionBelongsToAgent`. Those tests prove the routes CALL a gate and
 * honour its answer; they cannot prove the gate is right, and they would stay
 * green if the mechanism behind it were replaced with a broken one.
 *
 * This file closes that gap. The session service, the file-storage paths and
 * the message persister are all real, over a real temp data dir. Only the
 * container, the db and the auth middleware are stubbed.
 *
 * EVERY assertion here is phrased against an OBSERVABLE security property —
 * "the victim's live session was not touched" — never against the mechanism
 * that delivers it. That is deliberate: these tests are meant to survive a
 * change of mechanism (see the forgery case below, where the status code
 * legitimately depends on the implementation but the property does not).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import * as realFs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Stubs. Note what is NOT here: session-service, file-storage, fs and
// message-persister are all REAL.
// ---------------------------------------------------------------------------

const mockInterruptSession = vi.fn((..._args: unknown[]) => Promise.resolve(true))
const mockSendMessage = vi.fn((..._args: unknown[]) => Promise.resolve(undefined))
const mockContainerFetch = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, json: async () => ({}) }))
const mockCreateSession = vi.fn((..._args: unknown[]) => Promise.resolve({ id: 'container-session', slashCommands: [] }))
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({
      fetch: (...args: unknown[]) => mockContainerFetch(...args),
      sendMessage: (...args: unknown[]) => mockSendMessage(...args),
      interruptSession: (...args: unknown[]) => mockInterruptSession(...args),
      createSession: (...args: unknown[]) => mockCreateSession(...args),
      getSession: () => Promise.resolve(null),
      deleteSession: vi.fn(),
      subscribeToStream: vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() })),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    ensureRunning: vi.fn(() => Promise.resolve({ status: 'running', port: 8080 })),
    getCachedInfo: () => ({ status: 'running', port: 8080 }),
    removeClient: vi.fn(),
    keepAlive: vi.fn(),
  },
}))

const mockAuthUser = { id: 'test-user-id', name: 'Test User', email: 'test@example.com' }
vi.mock('../middleware/auth', () => ({
  getRequestDeviceId: () => null,
  // Deliberately permissive: the agent ACL is NOT what is under test here. The
  // caller is authorized on whatever agent is in the URL — which is exactly the
  // attacker's position in SUP-479.
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentRead: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); c.set('authorizedAgentRole', 'owner'); return next() },
  AgentUser: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); c.set('authorizedAgentRole', 'owner'); return next() },
  AgentAdmin: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); c.set('authorizedAgentRole', 'owner'); return next() },
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (c: any, next: () => Promise<void>) => { c.set('agentId', c.req.param('id')); return next() },
  getAgentId: (c: any) => c.get('agentId') ?? c.req.param('id'),
}))

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
  eq: (col: string, val: string) => ({ col, val }), desc: (col: string) => ({ desc: col }),
  and: (...args: unknown[]) => args, inArray: (col: string, vals: string[]) => ({ col, vals }),
  count: () => 'count_fn', like: (col: string, val: string) => ({ col, val }),
  or: (...args: unknown[]) => args,
}))

vi.mock('@shared/lib/auth/config', () => ({
  getAppBaseUrlFromRequest: () => 'http://localhost:3000',
  getCurrentUserId: () => 'test-user-id',
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => true }))

vi.mock('@shared/lib/config/settings', () => ({
  getAccountProviderUserId: () => 'test-user',
  getEffectiveAnthropicApiKey: () => 'test-key',
  getEffectiveModels: () => ({ summarizerModel: 'claude-3-haiku' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ container: {}, skillsets: [] }),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'allow' }),
  getModelCatalogSettings: () => ({}),
  VALID_SCRIPT_TYPES: { darwin: ['shell'], linux: ['shell'], win32: ['powershell'] },
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(), createAgent: vi.fn(), getAgentWithStatus: vi.fn(),
  getAgent: vi.fn(async () => ({ frontmatter: { name: 'Agent' } })),
  updateAgent: vi.fn(), deleteAgent: vi.fn(),
  agentExists: vi.fn(async () => true),
  AgentContainerStopError: class extends Error {},
}))

vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/services/x-agent-policy-service', () => ({
  deletePoliciesForAgent: vi.fn(), listPoliciesForCaller: vi.fn(() => []),
  replacePoliciesForCaller: vi.fn(),
  replacePoliciesForCallerInputSchema: { safeParse: vi.fn(() => ({ success: false, error: {} })) },
}))
vi.mock('@shared/lib/proxy/token-store', () => ({ revokeProxyToken: vi.fn(), validateProxyToken: vi.fn() }))
vi.mock('@shared/lib/proxy/host-url', () => ({ getContainerHostUrl: () => 'localhost', getAppPort: () => 3000 }))
vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    getPendingReviewsForAgent: () => [], submitDecision: vi.fn(), resolveMatchingPending: vi.fn(),
    resolveMatchingPendingByLabel: vi.fn(), resolveMatchingXAgentByOperation: vi.fn(),
    denyAllForAgent: vi.fn(),
  },
}))
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  countActiveTriggersPerAccount: vi.fn(async () => ({})), listWebhookTriggers: vi.fn(),
  listActiveWebhookTriggers: vi.fn(async () => []), listCancelledWebhookTriggers: vi.fn(),
  createWebhookTrigger: vi.fn(), cancelWebhookTriggerWithCleanup: vi.fn(), getWebhookTrigger: vi.fn(),
  resolvePlatformMemberForCandidates: () => null,
}))
vi.mock('@shared/lib/services/secrets-service', () => ({
  listSecrets: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn(), updateSecret: vi.fn(),
  deleteSecret: vi.fn(), getSecretEnvVars: vi.fn(),
}))
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listScheduledTasks: vi.fn(), listPendingScheduledTasks: vi.fn(async () => []),
  listPendingScheduledTasksByAgents: vi.fn(async () => new Map()),
  listCancelledScheduledTasks: vi.fn(), createScheduledTask: vi.fn(), createSessionWake: vi.fn(),
  getScheduledTask: vi.fn(async () => null), cancelScheduledTask: vi.fn(),
  pauseScheduledTask: vi.fn(), resumeScheduledTask: vi.fn(),
}))
vi.mock('@shared/lib/services/skillset-service', () => ({
  getAgentSkillsWithStatus: vi.fn(), getDiscoverableSkills: vi.fn(), installSkillFromSkillset: vi.fn(),
  updateSkillFromSkillset: vi.fn(), createSkillPR: vi.fn(), getSkillPRInfo: vi.fn(),
  getSkillPublishInfo: vi.fn(), publishSkillToSkillset: vi.fn(), refreshAgentSkills: vi.fn(),
  exportSkill: vi.fn(), importSkillFromZip: vi.fn(), SKILL_MAX_COMPRESSED_SIZE: 100 * 1024 * 1024,
}))
vi.mock('@shared/lib/services/artifact-service', () => ({
  listArtifactsFromFilesystem: vi.fn(), deleteArtifactFromFilesystem: vi.fn(),
  renameArtifactOnFilesystem: vi.fn(),
}))
vi.mock('@shared/lib/services/chat-integration-service', () => ({
  listChatIntegrations: vi.fn(() => []), listChatIntegrationsByAgents: vi.fn(() => new Map()),
}))
vi.mock('@shared/lib/services/notification-service', () => ({
  getSessionIdsWithUnreadNotifications: vi.fn(async () => new Set()),
  getUnreadNotificationsByAgents: vi.fn(async () => new Map()),
}))
vi.mock('@shared/lib/services/agent-template-service', () => ({
  exportAgentTemplate: vi.fn(), exportAgentFull: vi.fn(), importAgentFromTemplate: vi.fn(),
  MAX_COMPRESSED_SIZE: 500 * 1024 * 1024, installAgentFromSkillset: vi.fn(),
  updateAgentFromSkillset: vi.fn(), getAgentTemplateStatus: vi.fn(), getDiscoverableAgents: vi.fn(),
  refreshSkillsetCaches: vi.fn(), getAgentPRInfo: vi.fn(), createAgentPR: vi.fn(),
  getAgentPublishInfo: vi.fn(), publishAgentToSkillset: vi.fn(), refreshAgentTemplates: vi.fn(),
  hasOnboardingSkill: vi.fn(), getAgentTemplatePrompt: vi.fn(async () => undefined),
}))
vi.mock('@shared/lib/utils/retry', () => ({ withRetry: vi.fn((fn: () => unknown) => fn()) }))
vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({ messages: { create: vi.fn() } }),
  extractTextFromLlmResponse: () => null, createSummarizerText: async () => null,
}))
vi.mock('@shared/lib/utils/message-transform', () => ({
  transformMessages: vi.fn(() => []), resolveInterruptedSubagents: vi.fn(),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(async () => undefined),
    triggerSessionWaitingInput: vi.fn(async () => undefined),
  },
}))
vi.mock('@shared/lib/services/timezone-resolver', () => ({ resolveTimezoneForAgent: () => 'UTC' }))
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))

// Import after every mock is registered.
import agents from './agents'
import { messagePersister } from '@shared/lib/container/message-persister'
import { registerSession, sessionExists } from '@shared/lib/services/session-service'
import { getAgentSessionsDir } from '@shared/lib/utils/file-storage'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const VICTIM = 'victim-agent'
const ATTACKER = 'attacker-agent'

let tmpDir: string
let previousDataDir: string | undefined
let victimSession: string
let attackerSession: string
let victimEvents: unknown[]
let attackerEvents: unknown[]
let cleanupVictimSse: () => void
let cleanupAttackerSse: () => void

function makeMockClient() {
  let onMessage: ((m: unknown) => void) | null = null
  return {
    _emit(content: unknown) {
      onMessage?.({ type: 'message', content, timestamp: new Date(), sessionId: 'x' })
    },
    start: vi.fn(), stop: vi.fn(), stopSync: vi.fn(), getInfoFromRuntime: vi.fn(), getInfo: vi.fn(),
    fetch: vi.fn(), waitForHealthy: vi.fn(), isHealthy: vi.fn(), getStats: vi.fn(),
    createSession: vi.fn(), getSession: vi.fn(async () => null), deleteSession: vi.fn(),
    sendMessage: vi.fn(), interruptSession: vi.fn(),
    subscribeToStream: vi.fn((_id: string, cb: (m: unknown) => void) => {
      onMessage = cb
      return { unsubscribe: vi.fn(), ready: Promise.resolve() }
    }),
    on: vi.fn(), off: vi.fn(), onFatalResult: vi.fn(() => 'settle'),
    observeUnexpectedDeath: vi.fn(async () => ({ action: 'settle' })),
    getRuntimeGenerationId: vi.fn(() => null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function app(): Hono {
  const a = new Hono()
  a.route('/api/agents', agents)
  return a
}

function url(agentSlug: string, sessionId: string, suffix = ''): string {
  return `http://localhost/api/agents/${agentSlug}/sessions/${sessionId}${suffix}`
}

async function post(target: string, body: unknown = {}): Promise<Response> {
  return app().request(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Write a transcript into an agent's OWN session directory. */
function writeTranscript(agentSlug: string, sessionId: string): void {
  const dir = getAgentSessionsDir(agentSlug)
  realFs.mkdirSync(dir, { recursive: true })
  realFs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n')
}

beforeEach(async () => {
  vi.clearAllMocks()
  // clearAllMocks drops recorded calls but keeps implementations, so a test
  // that made the container throw would leak that into the next one.
  mockInterruptSession.mockResolvedValue(true)
  mockSendMessage.mockResolvedValue(undefined)
  previousDataDir = process.env.SUPERAGENT_DATA_DIR
  tmpDir = realFs.realpathSync(realFs.mkdtempSync(path.join(os.tmpdir(), 'session-scope-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir

  victimSession = 'victim-session-0000'
  attackerSession = 'attacker-session-0000'

  for (const slug of [VICTIM, ATTACKER]) {
    realFs.mkdirSync(getAgentSessionsDir(slug), { recursive: true })
  }

  // Both sessions are created the way the product creates them, so whatever
  // bookkeeping a real session gets is in place before the attack runs.
  await registerSession(VICTIM, victimSession, 'Victim session')
  await registerSession(ATTACKER, attackerSession, 'Attacker session')
  writeTranscript(VICTIM, victimSession)
  writeTranscript(ATTACKER, attackerSession)

  // The victim's session is LIVE: subscribed and streaming.
  await messagePersister.subscribeToSession(victimSession, makeMockClient(), victimSession, VICTIM)
  await messagePersister.subscribeToSession(attackerSession, makeMockClient(), attackerSession, ATTACKER)
  messagePersister.markSessionActive(victimSession, VICTIM)

  victimEvents = []
  attackerEvents = []
  cleanupVictimSse = messagePersister.addSSEClient(victimSession, (d) => { victimEvents.push(d) })
  cleanupAttackerSse = messagePersister.addSSEClient(attackerSession, (d) => { attackerEvents.push(d) })
})

afterEach(() => {
  cleanupVictimSse?.()
  cleanupAttackerSse?.()
  messagePersister.unsubscribeFromSession(victimSession)
  messagePersister.unsubscribeFromSession(attackerSession)
  realFs.rmSync(tmpDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
})

/**
 * The property under test, stated once. Every attack asserts exactly this.
 * Note what it does NOT mention: status codes, ownership indexes, map keys.
 */
function expectVictimUntouched(): void {
  expect(messagePersister.isSessionActive(victimSession)).toBe(true)
  expect(messagePersister.isSubscribed(victimSession)).toBe(true)
  expect(victimEvents).toEqual([])
}

// ---------------------------------------------------------------------------

describe('a session id from another agent cannot drive that agent’s live session', () => {
  it('interrupt', async () => {
    const res = await post(url(ATTACKER, victimSession, '/interrupt'))
    expect(res.status).toBe(404)
    expect(mockInterruptSession).not.toHaveBeenCalled()
    expectVictimUntouched()
  })

  it('interrupt, when the container call throws (the handler’s catch path)', async () => {
    mockInterruptSession.mockRejectedValue(new Error('container exploded'))
    const res = await post(url(ATTACKER, victimSession, '/interrupt'))
    expect(res.status).toBe(404)
    expectVictimUntouched()
  })

  it('message', async () => {
    const res = await post(url(ATTACKER, victimSession, '/messages'), { content: 'hi' })
    expect(res.status).toBe(404)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expectVictimUntouched()
  })

  it('typing', async () => {
    const res = await post(url(ATTACKER, victimSession, '/typing'))
    expect(res.status).toBe(404)
    expectVictimUntouched()
  })

  it('delete', async () => {
    const res = await app().request(url(ATTACKER, victimSession), { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(await sessionExists(VICTIM, victimSession)).toBe(true)
    expectVictimUntouched()
  })

  it('a session id that escapes the agent’s own session directory', async () => {
    const res = await post(url(ATTACKER, '..%2F..%2Fvictim-agent%2Fvictim-session-0000', '/interrupt'))
    expect(res.status).toBe(404)
    expectVictimUntouched()
  })
})

describe('a forged transcript does not buy access to another agent’s live session', () => {
  // The attacker's workspace is bind-mounted read/write into its own container,
  // so it can create any file it likes there — including one named after a
  // session it does not own. This is the escalation that makes "is there a
  // transcript with this name in my directory?" an unsafe answer on its own.
  //
  // NO STATUS CODE IS ASSERTED HERE. Whether the route 404s (the id is refused)
  // or succeeds against the attacker's own empty state (the id is accepted, but
  // resolves inside the attacker's own namespace) is an implementation choice.
  // The property that has to hold either way is that the victim is untouched.
  beforeEach(() => {
    writeTranscript(ATTACKER, victimSession)
  })

  it('interrupt', async () => {
    await post(url(ATTACKER, victimSession, '/interrupt'))
    expectVictimUntouched()
  })

  it('message', async () => {
    await post(url(ATTACKER, victimSession, '/messages'), { content: 'injected' })
    expectVictimUntouched()
  })

  it('typing', async () => {
    await post(url(ATTACKER, victimSession, '/typing'))
    expectVictimUntouched()
  })

  it('delete leaves the victim’s real transcript on disk', async () => {
    await app().request(url(ATTACKER, victimSession), { method: 'DELETE' })
    expect(await sessionExists(VICTIM, victimSession)).toBe(true)
    expectVictimUntouched()
  })
})

describe('scoping does not over-block the caller’s own session', () => {
  it('interrupts its own session', async () => {
    const res = await post(url(ATTACKER, attackerSession, '/interrupt'))
    expect(res.status).toBe(200)
  })

  it('broadcasts typing into its own session only', async () => {
    const res = await post(url(ATTACKER, attackerSession, '/typing'))
    expect(res.status).toBe(200)
    expect(attackerEvents).toContainEqual(expect.objectContaining({ type: 'user_typing' }))
    expect(victimEvents).toEqual([])
  })
})
