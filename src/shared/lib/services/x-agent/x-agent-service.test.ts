/**
 * The x-agent service seen from its callers: the per-call sync wait, and the
 * user caller's authorization (its own agent_acl role, no policy, no review).
 * The agent-facing wire contract is pinned by src/api/routes/x-agent.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import * as schema from '../../db/schema'
import type { AppDatabase } from '../../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AgentRole } from '@shared/lib/types/agent'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))

let authModeEnabled = false
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => authModeEnabled,
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

const { mockEvaluatePolicy, mockRequestXAgent } = vi.hoisted(() => ({
  mockEvaluatePolicy: vi.fn(async (..._args: unknown[]): Promise<'allow' | 'block' | 'review'> => 'allow'),
  mockRequestXAgent: vi.fn(),
}))
vi.mock('@shared/lib/services/x-agent-policy-service', () => ({
  evaluate: (...args: unknown[]) => mockEvaluatePolicy(...args),
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  listAgents: async () => [
    { slug: TARGET, name: 'Target', description: 'the target' },
    { slug: OTHER, name: 'Other', description: 'another agent' },
  ],
  getAgentRecord: async (slug: string) => ({ slug, name: slug }),
}))

// A new session's start: settings, secrets and the model resolve, all neutral.
vi.mock('@shared/lib/config/settings', () => ({ getSettings: async () => ({ app: {} }) }))
vi.mock('@shared/lib/services/secrets-service', () => ({ getSecretEnvVars: async () => [] }))
vi.mock('@shared/lib/llm-provider/connection-runtime', () => ({ bindAgentModelChoice: async () => ({}) }))
vi.mock('@shared/lib/services/session-defaults', () => ({
  resolveSessionDefaults: async () => ({
    agentPrefs: {},
    agentLimits: {},
    customEnvVars: undefined,
    maxBrowserTabs: undefined,
    models: {},
    resolve: async () => ({ model: 'sonnet' }),
  }),
}))
vi.mock('@shared/lib/notifications/global-feed', () => ({ globalFeed: { publish: vi.fn() } }))

const TARGET = 'target-agent'
const OTHER = 'other-agent'
const CALLER_AGENT = 'caller-agent'
const USER_ID = 'user-1'
const SESSION_ID = 'session-1'
const NEW_SESSION_ID = 'session-new'

// The target agent, as the operations reach it.
const mockWaitForIdle = vi.fn(async (..._args: unknown[]): Promise<'idle' | 'timeout'> => 'idle')
const mockDeliver = vi.fn(async (..._args: unknown[]) => {})
const mockIsActive = vi.fn(() => false)
const mockStart = vi.fn(async (..._args: unknown[]) => ({ id: NEW_SESSION_ID }))
const fakeActor = {
  container: { start: vi.fn(async () => {}) },
  files: {
    readSized: vi.fn(async () => ({ size: 4, stream: new Blob(['data']).stream() })),
  },
  live: async () => ({ activeSessionIds: [] as string[] }),
  inputs: { reviews: { requestXAgent: (...args: unknown[]) => mockRequestXAgent(...args) } },
  sessions: {
    isKnown: vi.fn(async () => true),
    attach: vi.fn(async () => {}),
    metadata: vi.fn(async () => null),
    list: vi.fn(async () => [{ id: SESSION_ID, name: 'A session', createdAt: new Date(0), lastActivityAt: new Date(0) }]),
    live: vi.fn(async () => ({ isActive: mockIsActive(), isAwaitingInput: false })),
    waitForIdle: (...args: unknown[]) => mockWaitForIdle(...args),
    start: (...args: unknown[]) => mockStart(...args),
  },
  messages: {
    findLastEntry: vi.fn(async () => undefined),
    deliver: (...args: unknown[]) => mockDeliver(...args),
    transcriptView: vi.fn(async () => ({ messages: [], total: 0, deliveredFiles: [] })),
    findDeliveredFile: vi.fn(async () => ({ id: 'd1', filename: 'out.txt', sizeBytes: 4, filePath: '/workspace/out.txt' })),
  },
}

vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: {
    resolveRecord: async (slug: string) => ([TARGET, OTHER, CALLER_AGENT].includes(slug) ? { slug, name: slug } : null),
  },
  agentRegistry: { get: () => fakeActor },
}))

import { userXAgentCaller, agentXAgentCaller, type XAgentCaller } from './caller'
import { getTargetSessions, getTargetTranscript, listVisibleAgents, openDeliveredFile } from './operations'
import { invokeAgent } from './invoke'
import { effectiveSyncWaitMs } from './sync-wait'

async function seedRole(userId: string, agentSlug: string, role: AgentRole) {
  await testDb.insert(schema.agentAcl).values({ id: randomUUID(), userId, agentSlug, role, createdAt: new Date() })
}

/** What the operation handed the target's sessions.start. */
function lastStart(): { name: string; metadata: Record<string, unknown> } {
  return mockStart.mock.calls.at(-1)?.[0] as { name: string; metadata: Record<string, unknown> }
}

/** The timeoutMs the operation handed the target's waitForIdle. */
function lastWaitTimeoutMs(): number {
  const options = mockWaitForIdle.mock.calls.at(-1)?.[1] as { timeoutMs: number }
  return options.timeoutMs
}

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(schema.user).values([
    { id: USER_ID, name: 'User', email: 'user@test', emailVerified: false },
  ])
  await testDb.insert(schema.agents).values(
    [TARGET, OTHER, CALLER_AGENT].map((slug) => ({ slug, name: slug, createdAt: new Date(), runtime: 'local' })),
  )
  authModeEnabled = false
  vi.clearAllMocks()
  mockWaitForIdle.mockResolvedValue('idle')
  mockIsActive.mockReturnValue(false)
  mockEvaluatePolicy.mockResolvedValue('allow')
  mockStart.mockResolvedValue({ id: NEW_SESSION_ID })
})

afterEach(async () => {
  await handle.close()
})

describe('the sync wait a caller asks for', () => {
  const caller = () => userXAgentCaller({ userId: USER_ID })

  it('is the configured maximum when the caller asks for none', () => {
    expect(effectiveSyncWaitMs(undefined)).toBe(120_000)
    expect(effectiveSyncWaitMs(0)).toBe(120_000)
    expect(effectiveSyncWaitMs(-1)).toBe(120_000)
    expect(effectiveSyncWaitMs(Number.NaN)).toBe(120_000)
  })

  it('is clamped to the configured maximum', () => {
    expect(effectiveSyncWaitMs(5_000)).toBe(5_000)
    expect(effectiveSyncWaitMs(600_000)).toBe(120_000)
    expect(effectiveSyncWaitMs(Number.POSITIVE_INFINITY)).toBe(120_000)
  })

  it('a shorter wait bounds the invoke and is the one the promoted note states', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true, syncWaitMs: 5_000 })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(0)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(5_000)
    expect(result).toEqual({ ok: true, value: {
      sessionId: SESSION_ID,
      status: 'running',
      error: expect.stringContaining('Sync wait timed out after 5s'),
    } })
  })

  it('a wait past the maximum is clamped to it', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true, syncWaitMs: 10_000_000 })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)
    expect(result.ok && 'error' in result.value && result.value.error).toContain('Sync wait timed out after 120s')
  })

  it('no wait given is the default, as before', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)
    expect(result.ok && 'error' in result.value && result.value.error).toContain('Sync wait timed out after 120s')
  })

  it('a new session states the caller-supplied wait in its promoted note', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sync: true, syncWaitMs: 3_000 })
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(3_000)
    expect(result).toEqual({ ok: true, value: {
      sessionId: NEW_SESSION_ID,
      status: 'running',
      error: expect.stringContaining('Sync wait timed out after 3s,'),
    } })
  })

  it('a sub-second wait is stated in ms, never as 0s', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true, syncWaitMs: 400 })
    expect(result.ok && 'error' in result.value && result.value.error).toContain('Sync wait timed out after 400ms,')
  })

  it('bounds a sync transcript read the same way', async () => {
    mockIsActive.mockReturnValue(true)
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const short = await getTargetTranscript(caller(), { slug: TARGET, sessionId: SESSION_ID, sync: true, syncWaitMs: 2_000 })
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(2_000)
    expect(short).toMatchObject({ ok: true, value: { status: 'running' } })

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    await getTargetTranscript(caller(), { slug: TARGET, sessionId: SESSION_ID, sync: true, syncWaitMs: 900_000 })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    await getTargetTranscript(caller(), { slug: TARGET, sessionId: SESSION_ID, sync: true })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)
  })
})

describe('a user caller is authorized by its own role on the target', () => {
  beforeEach(() => {
    authModeEnabled = true
  })

  const user = (isAdmin = false): XAgentCaller => userXAgentCaller({ userId: USER_ID, isAdmin })
  const read = (caller: XAgentCaller) => getTargetSessions(caller, { slug: TARGET, limit: 50, offset: 0 })
  const transcript = (caller: XAgentCaller) => getTargetTranscript(caller, { slug: TARGET, sessionId: SESSION_ID })
  const invoke = (caller: XAgentCaller) => invokeAgent(caller, { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID })

  it('a viewer can read sessions and transcripts but not invoke', async () => {
    await seedRole(USER_ID, TARGET, 'viewer')
    expect((await read(user())).ok).toBe(true)
    expect((await transcript(user())).ok).toBe(true)
    expect(await invoke(user())).toEqual({ ok: false, status: 403, error: 'Forbidden: caller has no user access to target agent' })
    expect(mockDeliver).not.toHaveBeenCalled()
  })

  it('a user can invoke', async () => {
    await seedRole(USER_ID, TARGET, 'user')
    expect(await invoke(user())).toEqual({ ok: true, value: { sessionId: SESSION_ID, status: 'running' } })
    expect(mockDeliver).toHaveBeenCalledTimes(1)
  })

  it('no role on the target is refused everywhere', async () => {
    await seedRole(USER_ID, OTHER, 'owner')
    const refused = { ok: false, status: 403, error: 'Forbidden: caller has no access to target agent' }
    expect(await read(user())).toEqual(refused)
    expect(await transcript(user())).toEqual(refused)
    expect(await openDeliveredFile(user(), { slug: TARGET, sessionId: SESSION_ID, deliveryId: 'd1' })).toEqual(refused)
    expect(await invoke(user())).toEqual({ ok: false, status: 403, error: 'Forbidden: caller has no user access to target agent' })
  })

  it('lists only the agents the user can read', async () => {
    await seedRole(USER_ID, TARGET, 'viewer')
    const result = await listVisibleAgents(user())
    expect(result.ok && result.value.agents.map((a) => a.name)).toEqual(['Target'])
  })

  it('an admin passes without a role', async () => {
    expect((await read(user(true))).ok).toBe(true)
    expect((await invoke(user(true))).ok).toBe(true)
  })

  it('the local user passes in non-auth mode', async () => {
    authModeEnabled = false
    const local = userXAgentCaller({ userId: 'local' })
    expect((await read(local)).ok).toBe(true)
    expect((await invoke(local)).ok).toBe(true)
  })

  it('a user caller can download a delivered file it can read', async () => {
    await seedRole(USER_ID, TARGET, 'viewer')
    const result = await openDeliveredFile(user(), { slug: TARGET, sessionId: SESSION_ID, deliveryId: 'd1' })
    if (!result.ok) throw new Error(result.error)
    expect(result.value.filename).toBe('out.txt')
    expect(result.value.sizeBytes).toBe(4)
    expect(await new Response(result.value.body).text()).toBe('data')
  })

  it('refuses attachments from a user caller', async () => {
    await seedRole(USER_ID, TARGET, 'user')
    expect(await invokeAgent(user(), { slug: TARGET, prompt: 'hi', attachments: ['/workspace/a.txt'] }))
      .toEqual({ ok: false, status: 400, error: 'Attachments can only be sent by an agent.' })
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('a user caller must name its target', async () => {
    await seedRole(USER_ID, TARGET, 'owner')
    expect(await invokeAgent(user(), { prompt: 'hi' })).toEqual({ ok: false, status: 404, error: 'Target agent not found' })
  })

  it('no agent policy is consulted and no review is raised', async () => {
    await seedRole(USER_ID, TARGET, 'owner')
    mockEvaluatePolicy.mockResolvedValue('block')
    expect((await listVisibleAgents(user())).ok).toBe(true)
    expect((await read(user())).ok).toBe(true)
    expect((await transcript(user())).ok).toBe(true)
    expect((await invoke(user())).ok).toBe(true)
    expect(mockEvaluatePolicy).not.toHaveBeenCalled()
    expect(mockRequestXAgent).not.toHaveBeenCalled()
  })

  it('an agent caller, by contrast, is held to the policy', async () => {
    await seedRole(USER_ID, CALLER_AGENT, 'owner')
    await seedRole(USER_ID, TARGET, 'owner')
    mockEvaluatePolicy.mockResolvedValue('block')
    expect(await read(agentXAgentCaller(CALLER_AGENT))).toEqual({ ok: false, status: 403, error: 'Blocked by policy' })
    expect(mockEvaluatePolicy).toHaveBeenCalled()
  })
})

describe('a user caller starting a new session', () => {
  beforeEach(async () => {
    authModeEnabled = true
    await seedRole(USER_ID, TARGET, 'user')
  })

  it('names and registers it with the neutral defaults, created by and attributed to the user', async () => {
    const result = await invokeAgent(userXAgentCaller({ userId: USER_ID }), { slug: TARGET, prompt: 'hi' })
    expect(result).toEqual({ ok: true, value: { sessionId: NEW_SESSION_ID, status: 'running' } })
    expect(lastStart().name).toBe('New session')
    expect(lastStart().metadata).toEqual({ createdByUserId: USER_ID })
    const authors = await testDb.select().from(schema.messageAuthor).all()
    expect(authors).toHaveLength(1)
    expect(authors[0]).toMatchObject({ sessionId: NEW_SESSION_ID, agentSlug: TARGET, userId: USER_ID, billedUserId: null, authorAgentSlug: null })
  })

  it('takes the name and metadata the caller supplies', async () => {
    const caller = userXAgentCaller({ userId: USER_ID, sessionName: 'From MCP', sessionMetadata: { starred: true } })
    await invokeAgent(caller, { slug: TARGET, prompt: 'hi' })
    expect(lastStart().name).toBe('From MCP')
    expect(lastStart().metadata).toEqual({ starred: true, createdByUserId: USER_ID })
  })

  it('drops the service-owned keys from supplied metadata', async () => {
    const caller = userXAgentCaller({
      userId: USER_ID,
      sessionMetadata: { invokedByAgentSlug: CALLER_AGENT, createdByUserId: 'someone-else', starred: true },
    })
    await invokeAgent(caller, { slug: TARGET, prompt: 'hi' })
    expect(lastStart().metadata).toEqual({ starred: true, createdByUserId: USER_ID })
  })

  it('drops them even when the service has no creator to record', async () => {
    authModeEnabled = false
    const caller = userXAgentCaller({ userId: 'local', sessionMetadata: { invokedByAgentSlug: CALLER_AGENT, createdByUserId: 'someone-else' } })
    await invokeAgent(caller, { slug: TARGET, prompt: 'hi' })
    expect(lastStart().metadata).toEqual({})
  })
})
