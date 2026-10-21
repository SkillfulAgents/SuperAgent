/**
 * Cross-agent session scoping — REAL services, REAL filesystem.
 *
 * `agents.test.ts` already covers this surface, but it mocks `sessionIsKnown`.
 * Those tests prove the routes CALL a gate and honour its answer; they cannot
 * prove the gate is right, and they would stay green if the mechanism behind
 * it were replaced with a broken one.
 *
 * This file closes that gap. The session service, the file-storage paths and
 * the agents' live sessions are all real, over a real temp data dir. Only the
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
// Stubs. Note what is NOT here: session-service, file-storage, fs and the
// agents' live sessions are all REAL.
// ---------------------------------------------------------------------------

const mockInterruptSession = vi.fn((..._args: unknown[]) => Promise.resolve({ interrupted: true, processKept: true }))
const mockSendMessage = vi.fn((..._args: unknown[]) => Promise.resolve(undefined))
const mockContainerFetch = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, json: async () => ({}) }))
const mockCreateSession = vi.fn((..._args: unknown[]) => Promise.resolve({ id: 'container-session', slashCommands: [] }))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
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
    }),
  }
})

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
vi.mock('@shared/lib/services/agent-integration-service', () => ({
  listAgentIntegrations: vi.fn(() => []), listAgentIntegrationsByAgents: vi.fn(() => new Map()),
}))
vi.mock('@shared/lib/services/notification-service', () => ({
  getSessionIdsWithUnreadNotifications: vi.fn(async () => new Set()),
  getSessionIdsWithUnreadMentions: vi.fn(async () => new Set()),
  getUnreadMentionsByAgents: vi.fn(async () => new Map()),
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
import { agentRegistry } from '@shared/lib/agent-actor'
import { drain, drained } from '@shared/lib/agent-actor/testing/drain'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
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
  mockInterruptSession.mockResolvedValue({ interrupted: true, processKept: true })
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
  await registerSession(createLocalSessionStore(VICTIM), victimSession, 'Victim session')
  await registerSession(createLocalSessionStore(ATTACKER), attackerSession, 'Attacker session')
  writeTranscript(VICTIM, victimSession)
  writeTranscript(ATTACKER, attackerSession)

  // The victim's session is LIVE: subscribed and streaming.
  await agentRegistry.get(VICTIM).sessions.attach(victimSession)
  await agentRegistry.get(ATTACKER).sessions.attach(attackerSession)
  agentRegistry.get(VICTIM).sessions.markActive(victimSession)

  victimEvents = []
  attackerEvents = []
  cleanupVictimSse = drain(await agentRegistry.get(VICTIM).messages.subscribe(victimSession), (d) => { victimEvents.push(d) })
  cleanupAttackerSse = drain(await agentRegistry.get(ATTACKER).messages.subscribe(attackerSession), (d) => { attackerEvents.push(d) })
})

afterEach(() => {
  cleanupVictimSse?.()
  cleanupAttackerSse?.()
  agentRegistry.get(VICTIM).sessions.unsubscribeStream(victimSession)
  agentRegistry.get(ATTACKER).sessions.unsubscribeStream(attackerSession)
  realFs.rmSync(tmpDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
})

/**
 * The property under test, stated once. Every attack asserts exactly this.
 * Note what it does NOT mention: status codes, ownership indexes, map keys.
 */
async function expectVictimUntouched(): Promise<void> {
  await drained()
  expect(agentRegistry.get(VICTIM).sessions.isActive(victimSession)).toBe(true)
  expect(agentRegistry.get(VICTIM).sessions.isStreamSubscribed(victimSession)).toBe(true)
  expect(victimEvents).toEqual([])
}

// ---------------------------------------------------------------------------

describe('a session id from another agent cannot drive that agent’s live session', () => {
  it('interrupt', async () => {
    const res = await post(url(ATTACKER, victimSession, '/interrupt'))
    expect(res.status).toBe(404)
    expect(mockInterruptSession).not.toHaveBeenCalled()
    await expectVictimUntouched()
  })

  it('interrupt, when the container call throws (the handler’s catch path)', async () => {
    mockInterruptSession.mockRejectedValue(new Error('container exploded'))
    const res = await post(url(ATTACKER, victimSession, '/interrupt'))
    expect(res.status).toBe(404)
    await expectVictimUntouched()
  })

  it('message', async () => {
    const res = await post(url(ATTACKER, victimSession, '/messages'), { content: 'hi' })
    expect(res.status).toBe(404)
    expect(mockSendMessage).not.toHaveBeenCalled()
    await expectVictimUntouched()
  })

  it('typing', async () => {
    const res = await post(url(ATTACKER, victimSession, '/typing'))
    expect(res.status).toBe(404)
    await expectVictimUntouched()
  })

  it('delete', async () => {
    const res = await app().request(url(ATTACKER, victimSession), { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(await sessionExists(createLocalSessionStore(VICTIM), victimSession)).toBe(true)
    await expectVictimUntouched()
  })

  it('a session id that escapes the agent’s own session directory', async () => {
    const res = await post(url(ATTACKER, '..%2F..%2Fvictim-agent%2Fvictim-session-0000', '/interrupt'))
    expect(res.status).toBe(404)
    await expectVictimUntouched()
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
    await expectVictimUntouched()
  })

  it('message', async () => {
    await post(url(ATTACKER, victimSession, '/messages'), { content: 'injected' })
    await expectVictimUntouched()
  })

  it('typing', async () => {
    await post(url(ATTACKER, victimSession, '/typing'))
    await expectVictimUntouched()
  })

  it('delete leaves the victim’s real transcript on disk', async () => {
    await app().request(url(ATTACKER, victimSession), { method: 'DELETE' })
    expect(await sessionExists(createLocalSessionStore(VICTIM), victimSession)).toBe(true)
    await expectVictimUntouched()
  })
})

describe('a symlink forged in the attacker’s workspace resolves to the victim’s file', () => {
  // Sharper than the plain forged file: a symlink named after the victim's
  // session, planted in the attacker's own bind-mounted directory, RESOLVES to
  // the victim's real transcript. A containment check that compares only path
  // strings treats it as the attacker's own session. There is no benign
  // reading of this id — it points at a file the attacker does not own — so
  // here every gated route MUST refuse it (404), not merely leave the victim
  // untouched.
  beforeEach(() => {
    const attackerDir = getAgentSessionsDir(ATTACKER)
    realFs.mkdirSync(attackerDir, { recursive: true })
    const link = path.join(attackerDir, `${victimSession}.jsonl`)
    realFs.rmSync(link, { force: true })
    realFs.symlinkSync(path.join(getAgentSessionsDir(VICTIM), `${victimSession}.jsonl`), link)
  })

  it('the messages listing refuses the id', async () => {
    const res = await app().request(url(ATTACKER, victimSession, '/messages'), { method: 'GET' })
    expect(res.status).toBe(404)
    await expectVictimUntouched()
  })

  it('the single-session read refuses the id', async () => {
    const res = await app().request(url(ATTACKER, victimSession), { method: 'GET' })
    expect(res.status).toBe(404)
    await expectVictimUntouched()
  })

  it('interrupt refuses the id', async () => {
    const res = await post(url(ATTACKER, victimSession, '/interrupt'))
    expect(res.status).toBe(404)
    expect(mockInterruptSession).not.toHaveBeenCalled()
    await expectVictimUntouched()
  })

  it('delete refuses the id and leaves the victim’s real transcript', async () => {
    const res = await app().request(url(ATTACKER, victimSession), { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(await sessionExists(createLocalSessionStore(VICTIM), victimSession)).toBe(true)
    await expectVictimUntouched()
  })

  it('media refuses the id even when the attacker also forges its metadata', async () => {
    // The metadata makes sessionIsKnown pass (it is satisfied by a metadata
    // entry alone), so only the media route's realpath guard stands between the
    // request and openMediaBlob following the link into the victim's transcript.
    await registerSession(createLocalSessionStore(ATTACKER), victimSession, 'Forged')
    const res = await app().request(url(ATTACKER, victimSession, '/media/anyref'), { method: 'GET' })
    expect(res.status).toBe(404)
    await expectVictimUntouched()
  })
})

describe('the subagent-messages route stays inside the agent’s own tree', () => {
  it('refuses a traversal-shaped session id', async () => {
    const res = await app().request(
      `http://localhost/api/agents/${ATTACKER}/sessions/..%2F..%2F${VICTIM}%2Fworkspace/subagent/x/messages`,
      { method: 'GET' },
    )
    expect(res.status).toBe(404)
    await expectVictimUntouched()
  })

  it('refuses a traversal-shaped subagent id that escapes the session tree', async () => {
    // Enough `..` to climb out of the agent's session directory entirely (the
    // `agent-` filename prefix absorbs the first one). Without the guard this
    // reads an arbitrary file off disk.
    const escape = Array(10).fill('..').join('%2F')
    const res = await app().request(
      `http://localhost/api/agents/${ATTACKER}/sessions/${attackerSession}/subagent/${escape}%2Fetc%2Fpasswd/messages`,
      { method: 'GET' },
    )
    expect(res.status).toBe(404)
    await expectVictimUntouched()
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
    await drained()
    expect(attackerEvents).toContainEqual(expect.objectContaining({ type: 'user_typing' }))
    expect(victimEvents).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The session stream on the wire: the real route over the real live sessions.
// ---------------------------------------------------------------------------

/** An SSE response read frame by frame, as a browser's EventSource would. */
async function openStream(target: string, headers: Record<string, string> = {}) {
  const controller = new AbortController()
  const res = await app().request(target, { method: 'GET', headers, signal: controller.signal })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  return {
    /** The next frame that is not a keep-alive ping: its id (if any) and parsed data. */
    async next(): Promise<{ id: string | undefined; data: Record<string, unknown> }> {
      for (;;) {
        const end = buffered.indexOf('\n\n')
        if (end >= 0) {
          const block = buffered.slice(0, end)
          buffered = buffered.slice(end + 2)
          const lines = block.split('\n')
          const id = lines.find((line) => line.startsWith('id: '))?.slice(4)
          const data = JSON.parse(lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n'))
          if (data.type !== 'ping') return { id, data }
          continue
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffered += decoder.decode(value, { stream: true })
      }
    },
    close: () => controller.abort(),
  }
}

describe('the session stream on the wire', () => {
  const emit = (event: Record<string, unknown>) =>
    agentRegistry.get(ATTACKER).messages.broadcastEvent(attackerSession, event)

  it('opens with the connected snapshot and numbers every frame after it', async () => {
    agentRegistry.get(ATTACKER).sessions.markActive(attackerSession)
    const viewer = await openStream(url(ATTACKER, attackerSession, '/stream'))

    const connected = await viewer.next()
    expect(connected.data).toMatchObject({ type: 'connected', isActive: true, backgroundTasks: [], activeSubagents: [] })
    expect(connected.id).toMatch(/^[0-9a-f]{8}:\d+$/)

    emit({ type: 'stream_delta', text: 'hi' })
    const delta = await viewer.next()
    const [epoch, seq] = connected.id!.split(':')
    expect(delta).toEqual({ id: `${epoch}:${Number(seq) + 1}`, data: { type: 'stream_delta', text: 'hi' } })
    viewer.close()
  })

  it('resumes a viewer that comes back with Last-Event-ID: exactly the frames it missed, no snapshot', async () => {
    const first = await openStream(url(ATTACKER, attackerSession, '/stream'))
    await first.next()
    emit({ type: 'stream_delta', text: 'one' })
    const lastSeen = await first.next()
    first.close()
    emit({ type: 'stream_delta', text: 'two' })
    emit({ type: 'stream_delta', text: 'three' })

    const again = await openStream(url(ATTACKER, attackerSession, '/stream'), { 'Last-Event-ID': lastSeen.id! })

    expect((await again.next()).data).toEqual({ type: 'stream_delta', text: 'two' })
    expect((await again.next()).data).toEqual({ type: 'stream_delta', text: 'three' })
    emit({ type: 'session_idle' })
    expect((await again.next()).data).toMatchObject({ type: 'session_idle' })
    again.close()
  })

  it('starts a viewer over from a snapshot when its id is from somewhere else', async () => {
    const viewer = await openStream(url(ATTACKER, attackerSession, '/stream'), { 'Last-Event-ID': 'gone:7' })
    expect((await viewer.next()).data).toMatchObject({ type: 'connected' })
    viewer.close()
  })
})
