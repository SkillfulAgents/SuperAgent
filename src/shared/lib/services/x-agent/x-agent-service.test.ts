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

const TARGET = 'target-agent'
const OTHER = 'other-agent'
const CALLER_AGENT = 'caller-agent'
const USER_ID = 'user-1'
const SESSION_ID = 'session-1'

// The target agent, as the operations reach it.
const mockWaitForIdle = vi.fn(async (..._args: unknown[]): Promise<'idle' | 'timeout'> => 'idle')
const mockDeliver = vi.fn(async (..._args: unknown[]) => {})
const mockIsActive = vi.fn(() => false)
const fakeActor = {
  container: { start: vi.fn(async () => {}) },
  files: {},
  live: async () => ({ activeSessionIds: [] as string[] }),
  inputs: { reviews: { requestXAgent: (...args: unknown[]) => mockRequestXAgent(...args) } },
  sessions: {
    isKnown: vi.fn(async () => true),
    attach: vi.fn(async () => {}),
    metadata: vi.fn(async () => null),
    list: vi.fn(async () => [{ id: SESSION_ID, name: 'A session', createdAt: new Date(0), lastActivityAt: new Date(0) }]),
    live: vi.fn(async () => ({ isActive: mockIsActive(), isAwaitingInput: false })),
    waitForIdle: (...args: unknown[]) => mockWaitForIdle(...args),
  },
  messages: {
    findLastEntry: vi.fn(async () => undefined),
    deliver: (...args: unknown[]) => mockDeliver(...args),
    transcriptView: vi.fn(async () => ({ messages: [], total: 0, deliveredFiles: [] })),
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
