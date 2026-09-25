/**
 * X-Agent route tests.
 *
 * Strategy: real in-memory SQLite for proxyTokens / agentAcl / xAgentPolicies
 * (so policy + ACL logic is exercised end-to-end). Mock the file-based agent/session
 * services and the container/messagePersister.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'crypto'
import { agentRegistry } from '@shared/lib/agent-actor/registry'
import type { FileOps, OpenFile } from '@shared/lib/agent-actor/types'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import * as schema from '@shared/lib/db/schema'

// Shrink the readLastAssistantMessage retry budget in tests (default is 10×500ms).
// Hoisted via vi.hoisted so it runs before the x-agent module reads these envs.
vi.hoisted(() => {
  process.env.X_AGENT_READ_RETRY_ATTEMPTS = '4'
  process.env.X_AGENT_READ_RETRY_INTERVAL_MS = '50'
  process.env.X_AGENT_SUBSCRIBE_TIMEOUT_MS = '150'
})

// ----------------------------------------------------------------------------
// Mocks (must be set up BEFORE importing the route)
// ----------------------------------------------------------------------------

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>
let prevDataDir: string | undefined

vi.mock('@shared/lib/db', async () => ({
  get db() {
    return testDb
  },
}))

// Auth mode toggle
let authModeEnabled = false
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => authModeEnabled,
}))

// Proxy token validation — returns the caller agent slug (or null)
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: vi.fn(async (token: string): Promise<string | null> => {
    const rows = testDb
      .select()
      .from(schema.proxyTokens)
      .where(undefined as never)
      .all() as schema.ProxyToken[]
    const match = rows.find((r) => r.token === token)
    return match ? match.agentSlug : null
  }),
}))

// Agent service (file-based)
const mockGetAgent = vi.fn()
const mockListAgents = vi.fn()
const mockCreateAgent = vi.fn()
// The route reads identity from the catalog record; the fixtures below are
// still written as AGENTS.md-shaped agents and projected here.
type AgentFixture = { slug: string; frontmatter: { name: string; description?: string; createdAt?: string } }
const recordOf = (agent: AgentFixture | null | undefined) =>
  agent
    ? {
        slug: agent.slug,
        name: agent.frontmatter.name,
        description: agent.frontmatter.description,
        createdAt: new Date(agent.frontmatter.createdAt ?? 0),
        placement: { runtime: 'local', workspaceHandle: null },
      }
    : null
vi.mock('@shared/lib/services/agent-service', () => ({
  getAgentRecord: async (...args: unknown[]) => recordOf(await mockGetAgent(...args)),
  listAgents: async (...args: unknown[]) => ((await mockListAgents(...args)) as AgentFixture[]).map(recordOf),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
}))

// Session service (file-based)
const mockListSessions = vi.fn((..._args: unknown[]): unknown => undefined)
const mockGetTranscript = vi.fn((..._args: unknown[]): unknown => undefined)
const mockRegisterSession = vi.fn(async (..._args: unknown[]) => {})
const mockUpdateSessionMetadata = vi.fn(async (..._args: unknown[]) => {})
const mockGetSessionMetadata = vi.fn(async (..._args: unknown[]): Promise<unknown> => null)
const mockSessionIsKnown = vi.fn(async (..._args: unknown[]) => true)
vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSessionMessagesWithCompact: (...args: unknown[]) => mockGetTranscript(...args),
  // Backed by the same transcript fixture so tests control both read paths.
  findLastSessionEntry: async (
    slug: unknown,
    sessionId: unknown,
    predicate: (entry: unknown) => boolean,
  ) => {
    const entries = ((await mockGetTranscript(slug, sessionId)) ?? []) as unknown[]
    for (let i = entries.length - 1; i >= 0; i--) {
      if (predicate(entries[i])) return entries[i]
    }
    return null
  },
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
  updateSessionMetadata: (...args: unknown[]) => mockUpdateSessionMetadata(...args),
  getSessionMetadata: (...args: unknown[]) => mockGetSessionMetadata(...args),
  sessionIsKnown: (...args: unknown[]) => mockSessionIsKnown(...args),
}))

function openBytes(bytes: Uint8Array | string, size?: number, body?: ReadableStream<Uint8Array>): OpenFile {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return {
    size: async () => size ?? data.length,
    stream: () => body ?? new Response(new Uint8Array(data)).body!,
    close: vi.fn(async () => {}),
    readAt: vi.fn(),
  }
}
const mockSourceOpen = vi.fn<FileOps['open']>()
const mockTargetOpen = vi.fn<FileOps['open']>()
const mockTargetWrite = vi.fn<FileOps['write']>()
const mockTargetDelete = vi.fn<FileOps['delete']>()

// Container manager
const mockCreateSession = vi.fn((..._args: unknown[]): unknown => undefined)
const mockSendMessage = vi.fn((..._args: unknown[]): unknown => undefined)
const mockDeleteSession = vi.fn(async (..._args: unknown[]) => true)
const mockTargetFetch = vi.fn(async (_path: string, _init?: RequestInit): Promise<Response> => Response.json({ success: true }))
const mockEnsureRunning = vi.fn(async (..._args: unknown[]) => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
  fetch: (fetchPath: string, init?: RequestInit) => mockTargetFetch(fetchPath, init),
}))
// The actor reaches the container client through getClient after start();
// hand back whatever ensureRunning last resolved to.
let mockClient: unknown
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      ensureRunning: async (...args: unknown[]) => {
        mockClient = await mockEnsureRunning(...args)
        return mockClient
      },
      getClient: () => mockClient,
    }),
  }
})

// Message persister
// Built by name, not by importing the class from the (wholesale-mocked) module:
// the routes match timeout errors on error.name, and this mirrors that contract.
// message-persister.test.ts pins the real class to this name.
function waitForIdleTimeoutError(): Error {
  return Object.assign(new Error('waitForIdle timeout after 120000ms'), {
    name: 'WaitForIdleTimeoutError',
  })
}

// Sync waits pass the REMAINING end-to-end budget (deadline stamped at handler
// entry minus pre-wait work), so the exact timeoutMs varies — assert the shape
// and that it stays within (0, 120s]. requireActiveFirst is off because sync
// callers mark/observe the session active before waiting, so "inactive" means
// the turn already finished.
function expectBoundedSyncWait(sessionId: string): void {
  expect(mockWaitForIdle).toHaveBeenCalledWith('target-agent', sessionId, {
    timeoutMs: expect.any(Number),
    requireActiveFirst: false,
  })
  const opts = mockWaitForIdle.mock.calls.at(-1)?.[2] as { timeoutMs: number }
  expect(opts.timeoutMs).toBeGreaterThan(0)
  expect(opts.timeoutMs).toBeLessThanOrEqual(120_000)
}
const mockIsSessionActive = vi.fn((_agentSlug?: string, _sessionId?: string): boolean => false)
const mockIsSessionAwaitingInput = vi.fn((_agentSlug?: string, _sessionId?: string): boolean => false)
const mockWaitForIdle = vi.fn(async (..._args: unknown[]) => {})
const mockSubscribeToSession = vi.fn()
const mockMarkSessionActive = vi.fn()
const mockMarkSessionIdle = vi.fn()
const mockBroadcastGlobal = vi.fn()
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    withSessionSend: async (agentSlug: string, sessionId: string, _client: unknown, send: () => Promise<unknown>) => {
      mockMarkSessionActive(agentSlug, sessionId)
      return send()
    },
    isSessionActive: (agentSlug?: string, sessionId?: string) => mockIsSessionActive(agentSlug, sessionId),
    isSessionAwaitingInput: (agentSlug: string, sessionId?: string,) => mockIsSessionAwaitingInput(agentSlug, sessionId),
    waitForIdle: (...args: unknown[]) => mockWaitForIdle(...args),
    isSubscribed: vi.fn(() => false),
    subscribeToSession: (...args: unknown[]) => mockSubscribeToSession(...args),
    unsubscribeFromSession: vi.fn(),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
    markSessionIdle: (...args: unknown[]) => mockMarkSessionIdle(...args),
    setSlashCommands: vi.fn(),
    broadcastGlobal: (...args: unknown[]) => mockBroadcastGlobal(...args),
  },
}))

// Settings + secrets (only used by invoke for new sessions)
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({ agentModel: 'sonnet', browserModel: 'sonnet', agentEffort: 'medium' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ app: {} }),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn(async () => []),
}))

// Agent preferences (file-based) — per-agent default model/effort
const mockReadAgentPreferences = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({}))
vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: (...args: unknown[]) => mockReadAgentPreferences(...args),
}))

// Review manager (direct decision injection)
let reviewDecisions: Array<'allow' | 'deny'> = []
const mockRequestXAgentReview = vi.fn(async (..._args: unknown[]) => {
  const next = reviewDecisions.shift()
  if (!next) throw new Error('No queued review decision')
  return next
})
vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    requestXAgentReview: (...args: unknown[]) => mockRequestXAgentReview(...args),
  },
}))

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

// ----------------------------------------------------------------------------
// Imports (after mocks)
// ----------------------------------------------------------------------------

import xAgentRoute, { resolveSyncWaitTimeoutMs } from './x-agent'

// ----------------------------------------------------------------------------
// Test app + helpers
// ----------------------------------------------------------------------------

let app: Hono
const CALLER_TOKEN = 'caller-token-123'
const CALLER_SLUG = 'caller-agent'
const TARGET_SLUG = 'target-agent'
const OWNER_USER_ID = 'user-owner'
const OTHER_USER_ID = 'user-other'

function authedFetch(path: string, body: unknown, token = CALLER_TOKEN) {
  return app.request(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function grantCallerOwnerTargetAccess() {
  await testDb.insert(schema.agentAcl).values({
    id: randomUUID(),
    userId: OWNER_USER_ID,
    agentSlug: TARGET_SLUG,
    role: 'user',
    createdAt: new Date(),
  })
}

function deliveredFileTranscript(
  filePath: string,
  sizeBytes: number,
  deliveryId = 'delivery-1',
  sha256?: string,
): unknown[] {
  const delivered = JSON.stringify({ sizeBytes, ...(sha256 ? { sha256 } : {}) })
  return [
    {
      uuid: 'assistant-delivery',
      parentUuid: null,
      type: 'assistant',
      sessionId: 'delivered-session',
      timestamp: '2026-09-12T10:00:00.000Z',
      message: {
        role: 'assistant',
        id: 'assistant-message',
        content: [{
          type: 'tool_use',
          id: deliveryId,
          name: 'mcp__user-input__deliver_file',
          input: { filePath, description: 'Result file' },
        }],
      },
    },
    {
      uuid: 'result-delivery',
      parentUuid: 'assistant-delivery',
      type: 'user',
      sessionId: 'delivered-session',
      timestamp: '2026-09-12T10:00:01.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: deliveryId,
          content: `File "${filePath}" (${sizeBytes} bytes) has been delivered to the user.\n\nDelivered: ${delivered}`,
          is_error: false,
        }],
      },
    },
  ]
}

async function seedAgentRows(slugs: string[]) {
  await testDb.insert(schema.agents).values(
    slugs.map((slug) => ({ slug, name: slug, createdAt: new Date(), runtime: 'local' })),
  )
}

beforeEach(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xagent-test-'))
  // Point the data dir at testDir so workspace writes land there. Caller/target
  // are seeded as bare folders matching the legacy-style test slugs.
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = testDir
  await fs.promises.mkdir(path.join(testDir, 'agents', CALLER_SLUG, 'workspace'), { recursive: true })
  await fs.promises.mkdir(path.join(testDir, 'agents', TARGET_SLUG, 'workspace'), { recursive: true })
  testSqlite = new Database(':memory:')
  testSqlite.pragma('foreign_keys = ON')
  testDb = drizzle(testSqlite, { schema })
  const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
  migrate(testDb, { migrationsFolder })
  // The catalog (which agents exist, and slug resolution) is the agents table.
  await seedAgentRows([CALLER_SLUG, TARGET_SLUG])

  // Seed users + caller token (proxyTokens has unique constraint on agentSlug)
  await testDb.insert(schema.user).values([
    { id: OWNER_USER_ID, name: 'Owner', email: 'owner@test', emailVerified: false },
    { id: OTHER_USER_ID, name: 'Other', email: 'other@test', emailVerified: false },
  ])
  await testDb.insert(schema.proxyTokens).values({
    id: randomUUID(),
    agentSlug: CALLER_SLUG,
    token: CALLER_TOKEN,
    createdAt: new Date(),
  })

  // Default: caller has owner ACL
  await testDb.insert(schema.agentAcl).values({
    id: randomUUID(),
    userId: OWNER_USER_ID,
    agentSlug: CALLER_SLUG,
    role: 'owner',
    createdAt: new Date(),
  })

  vi.restoreAllMocks()
  // Reset state
  authModeEnabled = false
  reviewDecisions = []
  vi.clearAllMocks()
  mockIsSessionActive.mockReturnValue(false)
  mockIsSessionAwaitingInput.mockReturnValue(false)
  mockWaitForIdle.mockResolvedValue(undefined)
  mockSessionIsKnown.mockResolvedValue(true)
  mockReadAgentPreferences.mockResolvedValue({})
  mockGetSessionMetadata.mockResolvedValue(null)
  mockEnsureRunning.mockClear()
  mockEnsureRunning.mockResolvedValue({
    createSession: mockCreateSession,
    sendMessage: mockSendMessage,
    deleteSession: mockDeleteSession,
    fetch: mockTargetFetch,
  } as never)
  mockSourceOpen.mockImplementation(async () => openBytes('source'))
  mockTargetOpen.mockImplementation(async () => openBytes('data'))
  const sourceFiles = agentRegistry.get(CALLER_SLUG).files
  const targetFiles = agentRegistry.get(TARGET_SLUG).files
  mockTargetWrite.mockImplementation(targetFiles.write.bind(targetFiles))
  mockTargetDelete.mockImplementation(targetFiles.delete.bind(targetFiles))
  vi.spyOn(sourceFiles, 'open').mockImplementation(mockSourceOpen)
  vi.spyOn(targetFiles, 'open').mockImplementation(mockTargetOpen)
  vi.spyOn(targetFiles, 'write').mockImplementation(mockTargetWrite)
  vi.spyOn(targetFiles, 'delete').mockImplementation(mockTargetDelete)
  mockTargetFetch.mockResolvedValue(Response.json({ success: true }))

  app = new Hono()
  app.route('/x-agent', xAgentRoute)
})

afterEach(async () => {
  testSqlite?.close()
  await fs.promises.rm(testDir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
})

// ============================================================================
// Auth
// ============================================================================

describe('auth', () => {
  it('rejects requests without a token', async () => {
    const res = await app.request('/x-agent/list', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('rejects requests with an invalid token', async () => {
    const res = await authedFetch('/x-agent/list', {}, 'wrong-token')
    expect(res.status).toBe(401)
  })

  it('accepts requests with a valid token (after policy allow)', async () => {
    reviewDecisions.push('allow')
    mockListAgents.mockResolvedValue([])
    const res = await authedFetch('/x-agent/list', {})
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// /list
// ============================================================================

describe('/list', () => {
  it('blocks when policy is block (no review prompt)', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'list', null, 'block')
    const res = await authedFetch('/x-agent/list', {})
    expect(res.status).toBe(403)
  })

  it('allows when policy is allow (no review prompt)', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'list', null, 'allow')
    mockListAgents.mockResolvedValue([
      { slug: 'a', frontmatter: { name: 'Agent A', description: 'd1' } },
      { slug: CALLER_SLUG, frontmatter: { name: 'Caller' } },
    ])
    const res = await authedFetch('/x-agent/list', {})
    expect(res.status).toBe(200)
    const body = await res.json()
    // caller is filtered out
    expect(body.agents).toEqual([{ slug: 'a', name: 'Agent A', description: 'd1' }])
  })

  it('prompts for review when no policy exists, denies if user denies', async () => {
    reviewDecisions.push('deny')
    const res = await authedFetch('/x-agent/list', {})
    expect(res.status).toBe(403)
  })

  it('filters by ACL in auth mode (caller owner can only see their agents)', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    // OWNER_USER_ID owns CALLER_SLUG (seeded) and 'visible-agent' but not 'hidden-agent'
    await testDb.insert(schema.agentAcl).values([
      {
        id: randomUUID(),
        userId: OWNER_USER_ID,
        agentSlug: 'visible-agent',
        role: 'user',
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        userId: OTHER_USER_ID,
        agentSlug: 'hidden-agent',
        role: 'owner',
        createdAt: new Date(),
      },
    ])
    mockListAgents.mockResolvedValue([
      { slug: 'visible-agent', frontmatter: { name: 'Visible' } },
      { slug: 'hidden-agent', frontmatter: { name: 'Hidden' } },
      { slug: CALLER_SLUG, frontmatter: { name: 'Caller' } },
    ])
    const res = await authedFetch('/x-agent/list', {})
    const body = await res.json()
    expect(body.agents.map((a: { slug: string }) => a.slug)).toEqual(['visible-agent'])
  })
})

// ============================================================================
// /create
// ============================================================================

describe('/create', () => {
  it('always reviews — blocks if user denies (no remembered policy)', async () => {
    reviewDecisions.push('deny')
    const res = await authedFetch('/x-agent/create', { name: 'New Helper' })
    expect(res.status).toBe(403)
  })

  it('creates and returns slug on allow', async () => {
    reviewDecisions.push('allow')
    mockCreateAgent.mockResolvedValue({ slug: 'new-helper', displaySlug: 'new-helper', name: 'New Helper' })
    const res = await authedFetch('/x-agent/create', { name: 'New Helper' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ slug: 'new-helper', name: 'New Helper' })
  })

  it('does NOT consult the policy table even with allow stored', async () => {
    // 'create' is intentionally not in the XAgentOperation enum, so we can't store
    // a remembered allow for it. Verify: with the review queue empty, create blocks.
    const res = await authedFetch('/x-agent/create', { name: 'X' })
    expect(res.status).toBe(403) // because reviewDecisions is empty → throws "No queued review decision"
  })

  it('inherits owner ACL from caller in auth mode', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    mockCreateAgent.mockResolvedValue({ slug: 'new-helper', displaySlug: 'new-helper', name: 'New' })
    const res = await authedFetch('/x-agent/create', { name: 'New' })
    expect(res.status).toBe(200)
    const aclRows = testDb
      .select()
      .from(schema.agentAcl)
      .all()
    const newAgentAcl = aclRows.filter((r) => r.agentSlug === 'new-helper')
    expect(newAgentAcl).toHaveLength(1)
    expect(newAgentAcl[0].userId).toBe(OWNER_USER_ID)
    expect(newAgentAcl[0].role).toBe('owner')
  })

  it('broadcasts agent_created only after inherited owner ACL is persisted', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    // slug and displaySlug must DIFFER here: agentSlug is the ACL filter key the
    // global stream matches against, and only the canonical slug is stored in the
    // ACL. A fixture where both are equal cannot tell the two apart.
    mockCreateAgent.mockResolvedValue({
      slug: 'a1b2c3d4e5',
      displaySlug: 'new-a1b2c3d4e5',
      name: 'New',
    })

    let ownerAclAtBroadcast: Array<{ userId: string; role: string }> = []
    mockBroadcastGlobal.mockImplementation(() => {
      ownerAclAtBroadcast = testDb
        .select()
        .from(schema.agentAcl)
        .all()
        .filter((r) => r.agentSlug === 'a1b2c3d4e5' && r.role === 'owner')
        .map((r) => ({ userId: r.userId, role: r.role }))
    })

    const res = await authedFetch('/x-agent/create', { name: 'New' })
    expect(res.status).toBe(200)

    expect(ownerAclAtBroadcast).toEqual([{ userId: OWNER_USER_ID, role: 'owner' }])
    expect(mockBroadcastGlobal).toHaveBeenCalledTimes(1)
    expect(mockBroadcastGlobal).toHaveBeenCalledWith({
      type: 'agent_created',
      agentSlug: 'a1b2c3d4e5',
    })
  })
})

// ============================================================================
// /invoke (cycle cap, self-invoke, ACL)
// ============================================================================

describe('/invoke', () => {
  beforeEach(() => {
    mockGetAgent.mockResolvedValue({
      slug: TARGET_SLUG,
      frontmatter: { name: 'Target', createdAt: '2024-01-01' },
      instructions: '',
    })
    mockCreateSession.mockResolvedValue({ id: 'new-sess-id' })
  })

  it('rejects when caller invokes itself', async () => {
    reviewDecisions.push('allow')
    const res = await authedFetch('/x-agent/invoke', { slug: CALLER_SLUG, prompt: 'hi' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/cannot invoke itself/)
  })

  it('rejects when calling session was itself invoked by another agent (one-hop rule)', async () => {
    reviewDecisions.push('allow')
    const callerSessionId = 'caller-session-invoked'
    // Mark the calling session as having been invoked by some other agent
    mockGetSessionMetadata.mockImplementation(async (store: unknown, sessionId: unknown) => {
      if ((store as { slug: string }).slug === CALLER_SLUG && sessionId === callerSessionId) {
        return { name: 'invoked', createdAt: new Date().toISOString(), invokedByAgentSlug: 'some-other-agent' }
      }
      return null
    })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hi',
      _callerSessionId: callerSessionId,
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/one hop|invoked by/i)
    // Should reject before even consulting the policy/review system
    expect(mockEnsureRunning).not.toHaveBeenCalled()
  })

  it('allows invoke when calling session was NOT invoked by another agent', async () => {
    reviewDecisions.push('allow')
    const callerSessionId = 'caller-session-normal'
    mockGetSessionMetadata.mockImplementation(async (store: unknown, sessionId: unknown) => {
      if ((store as { slug: string }).slug === CALLER_SLUG && sessionId === callerSessionId) {
        return { name: 'normal', createdAt: new Date().toISOString() } // no invokedByAgentSlug
      }
      return null
    })
    mockCreateSession.mockResolvedValue({ id: 'new-sess-1', slashCommands: [] })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hi',
      _callerSessionId: callerSessionId,
    })
    expect(res.status).toBe(200)
  })

  it('returns 404 when target agent does not exist', async () => {
    mockGetAgent.mockResolvedValue(null)
    const res = await authedFetch('/x-agent/invoke', { slug: 'ghost', prompt: 'hi' })
    expect(res.status).toBe(404)
  })

  it('blocks invoke when policy is block', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'invoke', TARGET_SLUG, 'block')
    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hi' })
    expect(res.status).toBe(403)
  })

  it('creates a new session on allow (async)', async () => {
    reviewDecisions.push('allow')
    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hello' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ sessionId: 'new-sess-id', status: 'running' })
    expect(mockEnsureRunning).toHaveBeenCalledWith(TARGET_SLUG)
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMessage: 'hello',
        metadata: { isAutomated: true },
      }),
    )
    expect(mockCreateSession.mock.calls[0][0]).not.toHaveProperty('initialMessageUuid')
    // The id no longer needs claiming: markSessionActive creates the state
    // under a key that already carries the target agent, so it cannot collide
    // with another agent's session of the same id.
    expect(mockMarkSessionActive).toHaveBeenCalledWith(TARGET_SLUG, 'new-sess-id')
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_SLUG }),
      'new-sess-id',
      expect.any(String),
      expect.objectContaining({ invokedByAgentSlug: CALLER_SLUG }),
    )
  })

  it('copies caller attachments before creating a session and sends only target-local paths', async () => {
    reviewDecisions.push('allow')
    const sourceBytes = Uint8Array.from([0, 255, 1, 128])
    mockSourceOpen.mockResolvedValue(openBytes(sourceBytes))

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'inspect this binary',
      attachments: ['/workspace/results/report.bin'],
    })

    expect(res.status).toBe(200)
    expect(mockSourceOpen).toHaveBeenCalledWith('/workspace/results/report.bin', { confined: true })
    expect(await agentRegistry.get(TARGET_SLUG).files.getDoc(mockTargetWrite.mock.calls[0][0])).toEqual(Buffer.from(sourceBytes))
    const initialMessage = (mockCreateSession.mock.calls[0][0] as { initialMessage: string }).initialMessage
    expect(initialMessage).toMatch(/^inspect this binary\n\n\[Attached files:\]\n- \/workspace\/uploads\/x-agent\/[\w-]+\/0\/report\.bin$/)
    expect(initialMessage).not.toContain('/workspace/results/report.bin')
    expect(mockRequestXAgentReview).toHaveBeenCalledWith(
      CALLER_SLUG,
      TARGET_SLUG,
      'Target',
      'invoke',
      'inspect this binary',
      { kind: 'send', paths: ['/workspace/results/report.bin'] },
    )
  })

  it('reviews attachments even when an existing policy allows messages', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'invoke', TARGET_SLUG, 'allow')
    reviewDecisions.push('allow')

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'share this',
      attachments: ['/workspace/report.bin'],
    })

    expect(res.status).toBe(200)
    expect(mockRequestXAgentReview).toHaveBeenCalledWith(
      CALLER_SLUG,
      TARGET_SLUG,
      'Target',
      'invoke',
      'share this',
      { kind: 'send', paths: ['/workspace/report.bin'] },
    )
  })

  it('removes staged attachments when session creation fails', async () => {
    reviewDecisions.push('allow')
    mockCreateSession.mockRejectedValueOnce(new Error('create failed'))

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'inspect this',
      attachments: ['/workspace/report.bin'],
    })

    expect(res.status).toBe(500)
    expect(mockTargetDelete).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/uploads\/x-agent\//), { recursive: true, confined: true })
  })

  it('removes staged attachments when session registration fails', async () => {
    reviewDecisions.push('allow')
    mockRegisterSession.mockRejectedValueOnce(new Error('register failed'))

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'inspect this',
      attachments: ['/workspace/report.bin'],
    })

    expect(res.status).toBe(500)
    expect(mockDeleteSession).toHaveBeenCalledWith('new-sess-id')
    expect(mockTargetDelete).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/uploads\/x-agent\//), { recursive: true, confined: true })
  })

  it('does not read attachments when invoke policy is denied', async () => {
    reviewDecisions.push('deny')

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'do not send',
      attachments: ['/workspace/private.txt'],
    })

    expect(res.status).toBe(403)
    expect(mockSourceOpen).not.toHaveBeenCalled()
    expect(mockTargetFetch).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('does not deliver a prompt when an attachment cannot be read', async () => {
    reviewDecisions.push('allow')
    mockSourceOpen.mockRejectedValue(new WorkspaceFileError('not-found'))

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'missing input',
      attachments: ['/workspace/missing.txt'],
    })

    expect(res.status).toBe(404)
    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockTargetDelete).toHaveBeenCalledWith(expect.stringMatching(/uploads\/x-agent/), { recursive: true, confined: true })
  })

  it('returns 409 without reporting a stream length mismatch to Sentry', async () => {
    reviewDecisions.push('allow')
    mockSourceOpen.mockResolvedValue(openBytes('short', 10))
    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'file', attachments: ['/workspace/changing.bin'] })
    expect(res.status).toBe(409)
    expect(mockCaptureException).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockTargetDelete).toHaveBeenCalled()
  })

  it('names a new session after the caller agent display name', async () => {
    reviewDecisions.push('allow')
    mockGetAgent.mockImplementation(async (slug: unknown) => {
      if (slug === CALLER_SLUG) {
        return {
          slug: CALLER_SLUG,
          frontmatter: { name: 'Business Analyst Agent', createdAt: '2024-01-01' },
          instructions: '',
        }
      }
      return {
        slug: TARGET_SLUG,
        frontmatter: { name: 'Target', createdAt: '2024-01-01' },
        instructions: '',
      }
    })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hello',
    })

    expect(res.status).toBe(200)
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_SLUG }),
      'new-sess-id',
      'Invoked by Business Analyst Agent',
      expect.objectContaining({ invokedByAgentSlug: CALLER_SLUG }),
    )
  })

  it('falls back to the caller slug when display-name lookup fails', async () => {
    reviewDecisions.push('allow')
    mockGetAgent.mockImplementation(async (slug: unknown) => {
      if (slug === CALLER_SLUG) throw new Error('caller metadata unavailable')
      return {
        slug: TARGET_SLUG,
        frontmatter: { name: 'Target', createdAt: '2024-01-01' },
        instructions: '',
      }
    })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hello',
    })

    expect(res.status).toBe(200)
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_SLUG }),
      'new-sess-id',
      `Invoked by ${CALLER_SLUG}`,
      expect.objectContaining({ invokedByAgentSlug: CALLER_SLUG }),
    )
  })

  it('attributes a new invoked message to the latest sender in a shared caller session', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    const callerSessionId = 'shared-caller-session'
    await grantCallerOwnerTargetAccess()
    await testDb.insert(schema.messageAuthor).values([
      {
        id: 'owner-message',
        sessionId: callerSessionId,
        agentSlug: CALLER_SLUG,
        userId: OWNER_USER_ID,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'other-message',
        sessionId: callerSessionId,
        agentSlug: CALLER_SLUG,
        userId: OTHER_USER_ID,
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ])
    mockGetSessionMetadata.mockResolvedValue({
      name: 'Shared session',
      createdAt: new Date().toISOString(),
      createdByUserId: OWNER_USER_ID,
    })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hello from the shared session',
      _callerSessionId: callerSessionId,
    })

    expect(res.status).toBe(200)
    const createArgs = mockCreateSession.mock.calls[0][0] as Record<string, unknown>
    expect(createArgs.initialMessageUuid).toEqual(expect.any(String))
    const targetAuthors = await testDb
      .select()
      .from(schema.messageAuthor)
      .where(eq(schema.messageAuthor.sessionId, 'new-sess-id'))
    expect(targetAuthors).toEqual([
      expect.objectContaining({
        id: createArgs.initialMessageUuid,
        agentSlug: TARGET_SLUG,
        userId: OTHER_USER_ID,
      }),
    ])
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_SLUG }),
      'new-sess-id',
      expect.any(String),
      expect.objectContaining({ createdByUserId: OTHER_USER_ID }),
    )
  })

  it('falls back to the session creator when no message author is recorded', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    const callerSessionId = 'legacy-caller-session'
    await grantCallerOwnerTargetAccess()
    mockGetSessionMetadata.mockResolvedValue({
      name: 'Legacy shared session',
      createdAt: new Date().toISOString(),
      createdByUserId: OTHER_USER_ID,
    })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'legacy hello',
      _callerSessionId: callerSessionId,
    })

    expect(res.status).toBe(200)
    const targetAuthors = await testDb
      .select()
      .from(schema.messageAuthor)
      .where(eq(schema.messageAuthor.sessionId, 'new-sess-id'))
    expect(targetAuthors).toEqual([
      expect.objectContaining({ userId: OTHER_USER_ID }),
    ])
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_SLUG }),
      'new-sess-id',
      expect.any(String),
      expect.objectContaining({ createdByUserId: OTHER_USER_ID }),
    )
  })

  it('falls back to the caller owner when legacy metadata has no user attribution', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    await grantCallerOwnerTargetAccess()

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'owner fallback',
      _callerSessionId: 'legacy-caller-session',
    })

    expect(res.status).toBe(200)
    const targetAuthors = await testDb
      .select()
      .from(schema.messageAuthor)
      .where(eq(schema.messageAuthor.sessionId, 'new-sess-id'))
    expect(targetAuthors).toEqual([
      expect.objectContaining({ userId: OWNER_USER_ID }),
    ])
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_SLUG }),
      'new-sess-id',
      expect.any(String),
      expect.objectContaining({ createdByUserId: OWNER_USER_ID }),
    )
  })

  it('continues without attribution when legacy createdByUserId no longer exists', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    await grantCallerOwnerTargetAccess()
    mockGetSessionMetadata.mockResolvedValue({
      name: 'Deleted user session',
      createdAt: new Date().toISOString(),
      createdByUserId: 'deleted-user',
    })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'still invoke',
      _callerSessionId: 'legacy-caller-session',
    })

    expect(res.status).toBe(200)
    expect(mockRegisterSession).toHaveBeenCalled()
    const targetAuthors = await testDb
      .select()
      .from(schema.messageAuthor)
      .where(eq(schema.messageAuthor.sessionId, 'new-sess-id'))
    expect(targetAuthors).toEqual([])
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_SLUG }),
      'new-sess-id',
      expect.any(String),
      { invokedByAgentSlug: CALLER_SLUG },
    )
  })

  it('attributes a continued target-session message to the shared-session sender', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    const callerSessionId = 'shared-caller-session'
    await grantCallerOwnerTargetAccess()
    await testDb.insert(schema.messageAuthor).values({
      id: 'other-message',
      sessionId: callerSessionId,
      agentSlug: CALLER_SLUG,
      userId: OTHER_USER_ID,
      createdAt: new Date(),
    })

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
      _callerSessionId: callerSessionId,
    })

    expect(res.status).toBe(200)
    expect(mockSendMessage).toHaveBeenCalledWith(
      'existing-sess',
      'follow-up',
      expect.any(String),
      { isAutomated: true },
    )
    const sentMessageUuid = mockSendMessage.mock.calls[0][2]
    const targetAuthors = await testDb
      .select()
      .from(schema.messageAuthor)
      .where(eq(schema.messageAuthor.sessionId, 'existing-sess'))
    expect(targetAuthors).toEqual([
      expect.objectContaining({
        id: sentMessageUuid,
        agentSlug: TARGET_SLUG,
        userId: OTHER_USER_ID,
      }),
    ])
  })

  it('404s when the continued session belongs to some other agent', async () => {
    // Invoke rights on the target say nothing about the session id passed with
    // them. Without an ownership check, a caller allowed to invoke the target
    // could name a THIRD agent's session and have the persister re-point it at
    // the target's container — and the target's transcript written under it.
    reviewDecisions.push('allow')
    await grantCallerOwnerTargetAccess()
    mockSessionIsKnown.mockResolvedValue(false)

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'third-agent-session',
    })

    expect(res.status).toBe(404)
    // Checked against the TARGET, whose container the session would be driven
    // on — not the caller, who never owns it either way.
    expect(mockSessionIsKnown).toHaveBeenCalledWith(expect.objectContaining({ slug: TARGET_SLUG }), 'third-agent-session')
    expect(mockSubscribeToSession).not.toHaveBeenCalled()
    expect(mockMarkSessionActive).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('removes continued-session attribution when sendMessage fails', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    await grantCallerOwnerTargetAccess()
    mockSendMessage.mockRejectedValueOnce(new Error('send failed'))

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
    })

    expect(res.status).toBe(500)
    const targetAuthors = await testDb
      .select()
      .from(schema.messageAuthor)
      .where(eq(schema.messageAuthor.sessionId, 'existing-sess'))
    expect(targetAuthors).toEqual([])
  })

  it('releases an existing session and staged files when the container confirms a failed send never started', async () => {
    reviewDecisions.push('allow')
    mockSendMessage.mockRejectedValueOnce(new Error('send rejected'))
    mockEnsureRunning.mockResolvedValueOnce({
      createSession: mockCreateSession,
      sendMessage: mockSendMessage,
      deleteSession: mockDeleteSession,
      getSession: vi.fn(async () => ({ id: 'existing-sess', isRunning: false })),
      fetch: mockTargetFetch,
    } as never)

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
      attachments: ['/workspace/report.bin'],
    })

    expect(res.status).toBe(500)
    expect(mockMarkSessionIdle).toHaveBeenCalledWith(TARGET_SLUG, 'existing-sess')
    expect(mockTargetDelete).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/uploads\/x-agent\//), { recursive: true, confined: true })
  })

  it('cleans up the container session if registerSession fails (no orphan)', async () => {
    reviewDecisions.push('allow')
    mockRegisterSession.mockRejectedValueOnce(new Error('disk full'))

    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hello' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/disk full/i)
    // Container session should have been deleted to avoid burning model budget on an orphan
    expect(mockDeleteSession).toHaveBeenCalledWith('new-sess-id')
    expect(mockCaptureException).toHaveBeenCalled()
  })

  it('cleans up an attributed author row when registerSession fails', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    await grantCallerOwnerTargetAccess()
    mockRegisterSession.mockRejectedValueOnce(new Error('disk full'))

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hello',
    })

    expect(res.status).toBe(500)
    const targetAuthors = await testDb
      .select()
      .from(schema.messageAuthor)
      .where(eq(schema.messageAuthor.sessionId, 'new-sess-id'))
    expect(targetAuthors).toEqual([])
  })

  it('returns 500 with stage=ensure_running when target container start fails', async () => {
    reviewDecisions.push('allow')
    mockEnsureRunning.mockRejectedValueOnce(new Error('Failed to start container: 500'))

    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hello' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/ensure_running/)
    expect(body.error).toMatch(/Failed to start container: 500/)
    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ area: 'x-agent', op: 'invoke', stage: 'ensure_running' }),
      }),
    )
  })

  it('returns 500 with stage=create_session when session create fails after start', async () => {
    reviewDecisions.push('allow')
    mockCreateSession.mockRejectedValueOnce(
      new Error('Failed to start session - request timed out'),
    )

    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hello' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/create_session/)
    expect(body.error).toMatch(/timed out/)
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'create_session' }),
      }),
    )
  })

  it('promotes sync=true to async (running + guidance note) when the wait times out', async () => {
    // A slow target turn is not a failure: the caller gets the async contract
    // (sessionId + status running) plus explicit guidance to poll the transcript
    // rather than re-invoke. Left as a plain network error, callers retried the
    // invoke and spawned duplicate runs (retry storm).
    reviewDecisions.push('allow')
    mockWaitForIdle.mockRejectedValueOnce(waitForIdleTimeoutError())
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'long-running task',
      sync: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      sessionId: 'new-sess-id',
      status: 'running',
      error: expect.stringMatching(/still working/i),
    })
    expect(body.error).toMatch(/do not re-invoke/i)
    expect(body.error).toMatch(/get_agent_session_transcript/)
    // The sync wait must be capped below the container fetch's 300s header
    // timeout — an uncapped wait surfaces as "fetch failed" on the caller.
    // The budget is end-to-end, so pre-wait work shrinks the passed timeout.
    expectBoundedSyncWait('new-sess-id')
    // No transcript read should have been attempted since waitForIdle failed
    expect(mockGetTranscript).not.toHaveBeenCalled()
  })

  it('promotes sync=true on an existing session to async when the wait times out', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(false)
    mockWaitForIdle.mockRejectedValueOnce(waitForIdleTimeoutError())
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
      sync: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBe('existing-sess')
    expect(body.status).toBe('running')
    expect(body.error).toMatch(/do not re-invoke/i)
    expectBoundedSyncWait('existing-sess')
  })

  it('promotes to async without waiting when pre-delivery work exhausts the sync budget', async () => {
    // Policy review and container startup run before the prompt is delivered
    // and count against the same end-to-end budget — otherwise slow delivery
    // plus a full wait could still cross the container fetch's 300s header
    // timeout and resurface as "fetch failed".
    reviewDecisions.push('allow')
    const realNow = Date.now.bind(Date)
    let clockOffsetMs = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs)
    try {
      // Mirror the real persister: marking active flips the activity flag, so
      // the exhausted-budget check sees a genuinely still-running turn.
      mockMarkSessionActive.mockImplementation(() => mockIsSessionActive.mockReturnValue(true))
      mockSendMessage.mockImplementationOnce(async () => {
        clockOffsetMs = 150_000
      })
      const res = await authedFetch('/x-agent/invoke', {
        slug: TARGET_SLUG,
        prompt: 'slow to deliver',
        sessionId: 'existing-sess',
        sync: true,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessionId).toBe('existing-sess')
      expect(body.status).toBe('running')
      expect(body.error).toMatch(/do not re-invoke/i)
      // The prompt WAS delivered; only the wait was skipped.
      expect(mockSendMessage).toHaveBeenCalled()
      expect(mockWaitForIdle).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('returns completed with the reply when the turn finishes during budget-exhausting delivery', async () => {
    // Exhausted budget + inactive session = the turn finished while we were
    // delivering. That's a completion, not a 'running' the caller must poll.
    reviewDecisions.push('allow')
    const realNow = Date.now.bind(Date)
    let clockOffsetMs = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs)
    try {
      const oldEntry = { type: 'assistant', uuid: 'a-old', message: { role: 'assistant', content: 'old answer' } }
      const newEntry = { type: 'assistant', uuid: 'a-new', message: { role: 'assistant', content: 'fresh answer' } }
      let transcript = [oldEntry]
      mockGetTranscript.mockImplementation(async () => transcript)
      mockMarkSessionActive.mockImplementation(() => mockIsSessionActive.mockReturnValue(true))
      mockSendMessage.mockImplementationOnce(async () => {
        clockOffsetMs = 150_000
        mockIsSessionActive.mockReturnValue(false) // result arrived during delivery
        transcript = [oldEntry, newEntry]
      })
      const res = await authedFetch('/x-agent/invoke', {
        slug: TARGET_SLUG,
        prompt: 'quick question',
        sessionId: 'existing-sess',
        sync: true,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('completed')
      expect(body.lastMessage).toBe('fresh answer')
      expect(mockWaitForIdle).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("returns THIS turn's reply on an existing session, not the previous turn's", async () => {
    // The turn's 'result' event clears isActive before the new assistant entry
    // is flushed to the JSONL file. Without the pre-delivery boundary, the
    // reader would grab the previous turn's answer and present it as this one's.
    reviewDecisions.push('allow')
    const oldEntry = { type: 'assistant', uuid: 'a-old', message: { role: 'assistant', content: 'old answer' } }
    const newEntry = { type: 'assistant', uuid: 'a-new', message: { role: 'assistant', content: 'fresh answer' } }
    let transcript = [oldEntry]
    let reads = 0
    mockGetTranscript.mockImplementation(async () => {
      reads++
      // Read 1 is the boundary capture, read 2 the first post-wait attempt —
      // both see only the previous turn. The new reply flushes by read 3.
      if (reads >= 3) transcript = [oldEntry, newEntry]
      return transcript
    })
    mockMarkSessionActive.mockImplementation(() => mockIsSessionActive.mockReturnValue(true))
    mockWaitForIdle.mockImplementation(async () => {
      mockIsSessionActive.mockReturnValue(false)
    })
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
      sync: true,
    })
    const body = await res.json()
    expect(body.status).toBe('completed')
    expect(body.lastMessage).toBe('fresh answer')
  })

  it('refuses to deliver when startup exceeds the delivery cutoff (existing session)', async () => {
    // Past ~240s the caller's fetch is already dead (undici 300s); delivering
    // anyway creates a ghost run that the caller's retry then duplicates.
    reviewDecisions.push('allow')
    const realNow = Date.now.bind(Date)
    let clockOffsetMs = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs)
    try {
      mockEnsureRunning.mockImplementationOnce(async () => {
        clockOffsetMs = 250_000
        return {
          createSession: mockCreateSession,
          sendMessage: mockSendMessage,
          deleteSession: mockDeleteSession,
        } as never
      })
      const res = await authedFetch('/x-agent/invoke', {
        slug: TARGET_SLUG,
        prompt: 'too late',
        sessionId: 'existing-sess',
        sync: true,
      })
      expect(res.status).toBe(504)
      expect((await res.json()).error).toMatch(/not delivered/i)
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(mockMarkSessionActive).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('refuses to deliver when the stream attach eats the cutoff (existing session)', async () => {
    // The cutoff is checked AFTER subscribe — a check before it could pass,
    // then the unbounded pre-send awaits could carry delivery past the
    // caller's 300s fetch timeout anyway.
    reviewDecisions.push('allow')
    const realNow = Date.now.bind(Date)
    let clockOffsetMs = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs)
    try {
      mockSubscribeToSession.mockImplementationOnce(async () => {
        clockOffsetMs = 250_000
      })
      const res = await authedFetch('/x-agent/invoke', {
        slug: TARGET_SLUG,
        prompt: 'too late',
        sessionId: 'existing-sess',
        sync: true,
      })
      expect(res.status).toBe(504)
      expect((await res.json()).error).toMatch(/not delivered/i)
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(mockMarkSessionActive).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('fails fast instead of hanging when the stream attach stalls (existing session)', async () => {
    // The persister's WebSocket ready promise has no timeout of its own; a
    // wedged container must surface as an error before the prompt goes out,
    // not hold the caller's fetch open indefinitely.
    reviewDecisions.push('allow')
    mockSubscribeToSession.mockImplementationOnce(() => new Promise(() => {}))
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hello',
      sessionId: 'existing-sess',
      sync: true,
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/attaching to session stream/i)
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('revokes a session created after the delivery cutoff', async () => {
    // createSession cannot be cancelled mid-flight; when it lands after the
    // caller's fetch is already dead, the session must be deleted the moment
    // it materializes — otherwise the caller's retry duplicates the run.
    reviewDecisions.push('allow')
    const realNow = Date.now.bind(Date)
    let clockOffsetMs = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs)
    try {
      // Enter createSession with ~50ms left to the cutoff; the create resolves
      // 120ms later — past the deadline.
      mockEnsureRunning.mockImplementationOnce(async () => {
        clockOffsetMs = 239_950
        return {
          createSession: mockCreateSession,
          sendMessage: mockSendMessage,
          deleteSession: mockDeleteSession,
        } as never
      })
      mockCreateSession.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ id: 'late-sess' }), 120)),
      )
      const res = await authedFetch('/x-agent/invoke', {
        slug: TARGET_SLUG,
        prompt: 'slow create',
        sync: true,
      })
      expect(res.status).toBe(504)
      expect((await res.json()).error).toMatch(/safe to retry/i)
      expect(mockRegisterSession).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(mockDeleteSession).toHaveBeenCalledWith('late-sess'))
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('revokes the new session when the stream attach stalls, instead of leaving a ghost run', async () => {
    // Post-delivery, an unsubscribed session would run with nothing persisting
    // its transcript — delete it like a failed registration.
    reviewDecisions.push('allow')
    mockSubscribeToSession.mockImplementationOnce(() => new Promise(() => {}))
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hello',
      sync: true,
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/attach/i)
    expect(mockDeleteSession).toHaveBeenCalledWith('new-sess-id')
  })

  it('refuses to create a session past the delivery cutoff, even for async invokes', async () => {
    // Async invokes also respond only after delivery, so the same ghost-run
    // hazard applies without sync.
    reviewDecisions.push('allow')
    const realNow = Date.now.bind(Date)
    let clockOffsetMs = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs)
    try {
      mockEnsureRunning.mockImplementationOnce(async () => {
        clockOffsetMs = 250_000
        return {
          createSession: mockCreateSession,
          sendMessage: mockSendMessage,
          deleteSession: mockDeleteSession,
        } as never
      })
      const res = await authedFetch('/x-agent/invoke', {
        slug: TARGET_SLUG,
        prompt: 'too late',
      })
      expect(res.status).toBe(504)
      expect((await res.json()).error).toMatch(/not delivered/i)
      expect(mockCreateSession).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('returns running + error (200) when sync=true on existing session and waitForIdle rejects', async () => {
    // Same graceful-degrade behavior on the existing-session path.
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(false)
    mockWaitForIdle.mockRejectedValueOnce(new Error('waitForIdle: session never became active'))
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
      sync: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBe('existing-sess')
    expect(body.status).toBe('running')
    expect(body.error).toMatch(/never became active/)
  })

  it('proceeds with invoke when getSessionMetadata returns null (no metadata file yet)', async () => {
    // Brand-new caller sessions may not have a persisted metadata file. The
    // one-hop check should treat absent metadata as "not invoked by anyone".
    reviewDecisions.push('allow')
    mockGetSessionMetadata.mockResolvedValueOnce(null)
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hi',
      _callerSessionId: 'fresh-session',
    })
    expect(res.status).toBe(200)
    expect(mockGetSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({ slug: CALLER_SLUG }), 'fresh-session')
  })

  it('proceeds with invoke when _callerSessionId is omitted (no metadata lookup)', async () => {
    // Callers without a session context (e.g. host-initiated invocations) skip
    // the one-hop check entirely.
    reviewDecisions.push('allow')
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hi',
    })
    expect(res.status).toBe(200)
    expect(mockGetSessionMetadata).not.toHaveBeenCalled()
  })

  it('waits for idle and returns last message when sync=true', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi back' } },
    ])
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hello',
      sync: true,
    })
    const body = await res.json()
    expectBoundedSyncWait('new-sess-id')
    expect(body.status).toBe('completed')
    expect(body.lastMessage).toBe('hi back')
  })

  it('picks the last ASSISTANT message, not the trailing user/tool_result entry', async () => {
    // Tool-using turns end with a user-typed tool_result entry, not the assistant's reply.
    // We must walk back to the last assistant entry rather than blindly taking entries[-1].
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'do a thing' } },
      { type: 'assistant', message: { role: 'assistant', content: 'final answer' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'result data' }] } },
    ])
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'do a thing',
      sync: true,
    })
    const body = await res.json()
    expect(body.lastMessage).toBe('final answer')
  })

  it('returns null lastMessage (not the prompt echo) when no assistant entry exists', async () => {
    // Bug regression: previously returned the user prompt because we picked entries[-1]
    // even if that entry was the user message.
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'this should not echo back' } },
    ])
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'this should not echo back',
      sync: true,
    })
    const body = await res.json()
    expect(body.status).toBe('completed')
    expect(body.lastMessage).toBeUndefined()
  })

  it('exhausts the full retry budget when no assistant entry ever appears', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'still just the prompt' } },
    ])
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'still just the prompt',
      sync: true,
    })
    const body = await res.json()
    expect(body.status).toBe('completed')
    expect(body.lastMessage).toBeUndefined()
    // One transcript read per attempt (X_AGENT_READ_RETRY_ATTEMPTS=4 above).
    expect(mockGetTranscript).toHaveBeenCalledTimes(4)
  })

  it('stops polling as soon as an assistant entry appears', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript
      .mockResolvedValueOnce([{ type: 'user', message: { role: 'user', content: 'q' } }])
      .mockResolvedValueOnce([{ type: 'user', message: { role: 'user', content: 'q' } }])
      .mockResolvedValue([
        { type: 'user', message: { role: 'user', content: 'q' } },
        { type: 'assistant', message: { role: 'assistant', content: 'late answer' } },
      ])
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'q',
      sync: true,
    })
    const body = await res.json()
    expect(body.status).toBe('completed')
    expect(body.lastMessage).toBe('late answer')
    expect(mockGetTranscript).toHaveBeenCalledTimes(3)
  })

  it('rejects when continuing an already-running session', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(true)
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'hi',
      sessionId: 'existing-sess',
    })
    expect(res.status).toBe(409)
  })

  it('reserves an idle existing session while pre-send work is in progress', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'invoke', TARGET_SLUG, 'allow')
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    mockEnsureRunning.mockImplementationOnce(async () => {
      await startGate
      return {
        createSession: mockCreateSession,
        sendMessage: mockSendMessage,
        deleteSession: mockDeleteSession,
        fetch: mockTargetFetch,
      } as never
    })

    const first = authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'first',
      sessionId: 'existing-sess',
    })
    await vi.waitFor(() => expect(mockEnsureRunning).toHaveBeenCalledOnce())

    const second = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'second',
      sessionId: 'existing-sess',
    })
    expect(second.status).toBe(409)
    const third = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'third', sessionId: 'existing-sess' })
    expect(third.status).toBe(409)
    expect(mockSendMessage).not.toHaveBeenCalled()

    releaseStart()
    expect((await first).status).toBe(200)
    expect(mockSendMessage).toHaveBeenCalledOnce()
  })

  it('continues existing session via sendMessage when not running', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(false)
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
    })
    expect(res.status).toBe(200)
    expect(mockSendMessage).toHaveBeenCalledWith(
      'existing-sess',
      'follow-up',
      undefined,
      { isAutomated: true },
    )
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('copies attachments before continuing an existing session', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(false)
    mockSourceOpen.mockResolvedValue(openBytes('follow-up bytes'))

    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'continued file',
      sessionId: 'existing-sess',
      attachments: ['out/data.txt'],
    })

    expect(res.status).toBe(200)
    expect(mockSendMessage).toHaveBeenCalledWith(
      'existing-sess',
      expect.stringMatching(/^continued file\n\n\[Attached files:\]\n- \/workspace\/uploads\/x-agent\/[\w-]+\/0\/data\.txt$/),
      undefined,
      { isAutomated: true },
    )
  })

  it('blocks in auth mode when caller owner lacks user role on target', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow') // would be allowed by policy if ACL passed
    // OWNER_USER_ID has no ACL row on TARGET_SLUG
    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hi' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/no user access/i)
  })

  it('passes in auth mode when caller owner has user role on target', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')
    await testDb.insert(schema.agentAcl).values({
      id: randomUUID(),
      userId: OWNER_USER_ID,
      agentSlug: TARGET_SLUG,
      role: 'user',
      createdAt: new Date(),
    })
    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hi' })
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// /invoke model and effort resolution
// ============================================================================

describe('/invoke model and effort resolution', () => {
  // /invoke has no per-call model/effort override, so the order is:
  // target agent default > app default. Same inherit helper as the other start paths.
  beforeEach(() => {
    mockGetAgent.mockResolvedValue({
      slug: TARGET_SLUG,
      frontmatter: { name: 'Target', createdAt: '2024-01-01' },
      instructions: '',
    })
    mockCreateSession.mockResolvedValue({ id: 'new-sess-id' })
    reviewDecisions.push('allow')
  })

  it('uses the target agent default over the global default', async () => {
    mockReadAgentPreferences.mockResolvedValue({
      defaultModel: 'opus',
      defaultEffort: 'high',
      defaultSpeed: 'fast',
    })
    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hello' })
    expect(res.status).toBe(200)
    expect(mockReadAgentPreferences).toHaveBeenCalledWith(TARGET_SLUG)
    const args = mockCreateSession.mock.calls[0][0] as Record<string, unknown>
    expect(args.model).toBe('opus')
    expect(args.effort).toBe('high')
    expect(args.speed).toBe('fast')
  })

  it('falls back to the global default model and effort when the agent sets none', async () => {
    const res = await authedFetch('/x-agent/invoke', { slug: TARGET_SLUG, prompt: 'hello' })
    expect(res.status).toBe(200)
    const args = mockCreateSession.mock.calls[0][0] as Record<string, unknown>
    expect(args.model).toBe('sonnet')
    expect(args.effort).toBe('medium')
    expect(args.speed).toBeUndefined()
  })
})

// ============================================================================
// /get-sessions and /get-transcript (read access + ACL)
// ============================================================================

describe('/get-sessions', () => {
  beforeEach(() => {
    mockGetAgent.mockResolvedValue({
      slug: TARGET_SLUG,
      frontmatter: { name: 'Target', createdAt: '2024-01-01' },
      instructions: '',
    })
  })

  it('returns sessions with isRunning annotation', async () => {
    reviewDecisions.push('allow')
    mockListSessions.mockResolvedValue([
      { id: 'sess-1', name: 'S1', createdAt: new Date(), lastActivityAt: new Date(), messageCount: 3 },
      { id: 'sess-2', name: 'S2', createdAt: new Date(), lastActivityAt: new Date(), messageCount: 0 },
    ])
    mockIsSessionActive.mockImplementation((_agentSlug?: string, id?: string) => id === 'sess-1')
    const res = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG })
    const body = await res.json()
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions[0]).toEqual(expect.objectContaining({ id: 'sess-1', isRunning: true }))
    expect(body.sessions[1]).toEqual(expect.objectContaining({ id: 'sess-2', isRunning: false }))
  })

  it('does NOT auto-allow read just because invoke=allow (the two are independent)', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'invoke', TARGET_SLUG, 'allow')
    // No 'read' policy and no review queued — should prompt for review (which then errors out)
    mockListSessions.mockResolvedValue([])
    const res = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG })
    expect(res.status).toBe(403)
  })

  it('explicit read=allow + invoke=review supports view-only access', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'read', TARGET_SLUG, 'allow')
    mockListSessions.mockResolvedValue([])
    const res = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG })
    expect(res.status).toBe(200)
  })

  it('global read=allow (target=null) lets get-sessions through with no per-target policy', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'read', null, 'allow')
    mockListSessions.mockResolvedValue([])
    const res = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG })
    expect(res.status).toBe(200)
  })

  it('per-target block overrides a global read=allow', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'read', null, 'allow')
    await setPolicy(CALLER_SLUG, 'read', TARGET_SLUG, 'block')
    mockListSessions.mockResolvedValue([])
    const res = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG })
    expect(res.status).toBe(403)
  })

  it('paginates with limit and offset, returns total', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'read', TARGET_SLUG, 'allow')
    const all = Array.from({ length: 75 }, (_, i) => ({
      id: `sess-${i}`,
      name: `S${i}`,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messageCount: i,
    }))
    mockListSessions.mockResolvedValue(all)

    const res1 = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG })
    const body1 = await res1.json()
    expect(body1.sessions).toHaveLength(50)
    expect(body1.total).toBe(75)
    expect(body1.offset).toBe(0)
    expect(body1.limit).toBe(50)
    expect(body1.sessions[0].id).toBe('sess-0')

    const res2 = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG, offset: 50 })
    const body2 = await res2.json()
    expect(body2.sessions).toHaveLength(25)
    expect(body2.total).toBe(75)
    expect(body2.sessions[0].id).toBe('sess-50')

    const res3 = await authedFetch('/x-agent/get-sessions', { slug: TARGET_SLUG, limit: 10, offset: 5 })
    const body3 = await res3.json()
    expect(body3.sessions).toHaveLength(10)
    expect(body3.sessions[0].id).toBe('sess-5')
  })
})

describe('/get-transcript', () => {
  beforeEach(() => {
    mockGetAgent.mockResolvedValue({
      slug: TARGET_SLUG,
      frontmatter: { name: 'Target', createdAt: '2024-01-01' },
      instructions: '',
    })
  })

  it('returns idle status + compact messages', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      },
    ])
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
    })
    const body = await res.json()
    expect(body.status).toBe('idle')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' })
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'hi' })
  })

  it('keeps tool stubs when fullTranscript is true', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      },
    ])
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      fullTranscript: true,
    })
    const body = await res.json()
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: 'hi\n[tool_use: Bash]',
      toolName: 'Bash',
    })
  })

  it('404s before consulting global status for a session outside the target', async () => {
    reviewDecisions.push('allow')
    mockSessionIsKnown.mockResolvedValue(false)

    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'third-agent-session',
      sync: true,
    })

    expect(res.status).toBe(404)
    expect(mockSessionIsKnown).toHaveBeenCalledWith(expect.objectContaining({ slug: TARGET_SLUG }), 'third-agent-session')
    expect(mockIsSessionActive).not.toHaveBeenCalled()
    expect(mockIsSessionAwaitingInput).not.toHaveBeenCalled()
    expect(mockWaitForIdle).not.toHaveBeenCalled()
    expect(mockGetTranscript).not.toHaveBeenCalled()
  })

  it('reports running / awaiting_input status', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(true)
    mockGetTranscript.mockResolvedValue([])
    let res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
    })
    expect((await res.json()).status).toBe('running')

    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(false)
    mockIsSessionAwaitingInput.mockReturnValue(true)
    res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-2',
    })
    expect((await res.json()).status).toBe('awaiting_input')
  })

  it('waits for idle when sync=true and session is running', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockImplementation(() => true)
    mockWaitForIdle.mockImplementation(async () => {
      mockIsSessionActive.mockReturnValue(false)
    })
    mockGetTranscript.mockResolvedValue([])
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      sync: true,
    })
    // Capped below the container fetch's 300s header timeout: sync reads are a
    // bounded long-poll, not an unbounded wait.
    expectBoundedSyncWait('sess-1')
    const body = await res.json()
    expect(body.status).toBe('idle')
  })

  it('returns transcript-so-far with status running (200) when the sync wait times out', async () => {
    // Timeout is the long-poll expiring, not a failure: the caller gets the
    // current transcript and can call again with sync=true to keep waiting.
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(true)
    mockWaitForIdle.mockRejectedValueOnce(waitForIdleTimeoutError())
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'hello' } },
    ])
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      sync: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('running')
    expect(body.messages).toHaveLength(1)
  })

  it('reconciles after a sync wait so idle responses include the awaited reply', async () => {
    // 'result' clears isActive before the final assistant entry is flushed —
    // without reconciling against the pre-wait boundary, the handler returns
    // status idle with a transcript missing the very reply it waited for.
    reviewDecisions.push('allow')
    const oldEntry = { type: 'assistant', uuid: 'a-old', message: { role: 'assistant', content: 'old answer' } }
    const newEntry = { type: 'assistant', uuid: 'a-new', message: { role: 'assistant', content: 'fresh answer' } }
    let transcript = [oldEntry]
    let reads = 0
    mockGetTranscript.mockImplementation(async () => {
      reads++
      // Read 1 = boundary capture, read 2 = first reconcile attempt (stale),
      // read 3 onward sees the flushed reply.
      if (reads >= 3) transcript = [oldEntry, newEntry]
      return transcript
    })
    mockIsSessionActive.mockReturnValue(true)
    mockWaitForIdle.mockImplementation(async () => {
      mockIsSessionActive.mockReturnValue(false)
    })
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      sync: true,
    })
    const body = await res.json()
    expect(body.status).toBe('idle')
    expect(body.messages.map((m: { content: string }) => m.content)).toContain('fresh answer')
  })

  it('reconciles when the turn ends between the wait timing out and the status read', async () => {
    // A timeout followed by the turn finishing in the gap is the same flush
    // race as a completion: without reconciling, the response reports idle
    // with a transcript missing the reply it waited for.
    reviewDecisions.push('allow')
    const oldEntry = { type: 'assistant', uuid: 'a-old', message: { role: 'assistant', content: 'old answer' } }
    const newEntry = { type: 'assistant', uuid: 'a-new', message: { role: 'assistant', content: 'fresh answer' } }
    let transcript = [oldEntry]
    let reads = 0
    mockGetTranscript.mockImplementation(async () => {
      reads++
      if (reads >= 3) transcript = [oldEntry, newEntry]
      return transcript
    })
    mockIsSessionActive.mockReturnValue(true)
    mockWaitForIdle.mockImplementationOnce(async () => {
      mockIsSessionActive.mockReturnValue(false) // turn ended...
      throw waitForIdleTimeoutError() // ...but the wait had already timed out
    })
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      sync: true,
    })
    const body = await res.json()
    expect(body.status).toBe('idle')
    expect(body.messages.map((m: { content: string }) => m.content)).toContain('fresh answer')
  })

  it('still 504s when the sync wait fails for a non-timeout reason', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(true)
    mockWaitForIdle.mockRejectedValueOnce(new Error('waitForIdle aborted'))
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      sync: true,
    })
    expect(res.status).toBe(504)
    expect((await res.json()).error).toMatch(/did not idle.*aborted/)
    // Only the pre-wait boundary capture read the transcript — the failure
    // must short-circuit before the response transcript is assembled.
    expect(mockGetTranscript).toHaveBeenCalledTimes(1)
  })

  it('returns only the last `limit` messages and the total count', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'first' } },
      { type: 'assistant', message: { role: 'assistant', content: 'one' } },
      { type: 'user', message: { role: 'user', content: 'second' } },
      { type: 'assistant', message: { role: 'assistant', content: 'two' } },
      { type: 'assistant', message: { role: 'assistant', content: 'three' } },
    ])
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      limit: 2,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(5)
    expect(body.messages).toHaveLength(2)
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['two', 'three'])
  })

  it('returns delivered files independently of message pagination', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      ...deliveredFileTranscript('/workspace/output/report.bin', 4),
      { type: 'assistant', message: { role: 'assistant', content: 'final' } },
    ])

    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      limit: 1,
    })

    const body = await res.json()
    expect(body.messages).toEqual([{ role: 'assistant', content: 'final' }])
    expect(body.deliveredFiles).toEqual([{
      deliveryId: 'delivery-1',
      filename: 'report.bin',
      description: 'Result file',
      sizeBytes: 4,
    }])
  })

  it('returns the full transcript and total when limit is omitted', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'a' } },
      { type: 'assistant', message: { role: 'assistant', content: 'b' } },
    ])
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
    })
    const body = await res.json()
    expect(body.total).toBe(2)
    expect(body.messages).toHaveLength(2)
  })

  it('rejects limit below 1 and above 500', async () => {
    reviewDecisions.push('allow')
    for (const limit of [0, 501]) {
      const res = await authedFetch('/x-agent/get-transcript', {
        slug: TARGET_SLUG,
        sessionId: 'sess-1',
        limit,
      })
      expect(res.status).toBe(400)
    }
  })

  it('slices after the quiet view, so limit 1 is the last spoken turn', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'do not leak this' }],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'secret' } }],
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: 'final' } },
    ])
    const res = await authedFetch('/x-agent/get-transcript', {
      slug: TARGET_SLUG,
      sessionId: 'sess-1',
      limit: 1,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(2)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toBe('final')
    expect(JSON.stringify(body)).not.toContain('do not leak this')
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})

describe('/download-file', () => {
  beforeEach(() => {
    mockGetAgent.mockResolvedValue({
      slug: TARGET_SLUG,
      frontmatter: { name: 'Target', createdAt: '2024-01-01' },
      instructions: '',
    })
    mockGetTranscript.mockResolvedValue(deliveredFileTranscript('/workspace/output/result.bin', 4))
  })

  it('streams exact delivered bytes and derives the source path only from the transcript', async () => {
    reviewDecisions.push('allow')
    const bytes = Uint8Array.from([0, 255, 1, 128])
    mockTargetOpen.mockResolvedValue(openBytes(bytes))

    const res = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
      filePath: '/workspace/private/forged.bin',
    })

    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(mockTargetOpen).toHaveBeenCalledWith('/workspace/output/result.bin', { confined: true })
    expect(res.headers.get('Content-Disposition')).toContain('filename="result.bin"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(mockRequestXAgentReview).toHaveBeenCalledWith(
      CALLER_SLUG,
      TARGET_SLUG,
      'Target',
      'read',
      undefined,
      { kind: 'download', filename: 'result.bin' },
    )
  })

  it.each(['allow', 'deny'] as const)('requires fresh file approval despite a saved read grant: %s', async (decision) => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'read', TARGET_SLUG, 'allow')
    reviewDecisions.push(decision)
    const res = await authedFetch('/x-agent/download-file', { slug: TARGET_SLUG, sessionId: 'delivered-session', deliveryId: 'delivery-1' })
    expect(res.status).toBe(decision === 'allow' ? 200 : 403)
    expect(mockRequestXAgentReview).toHaveBeenCalledOnce()
    if (decision === 'deny') expect(mockTargetOpen).not.toHaveBeenCalled()
    else await res.arrayBuffer()
  })

  it('rejects unknown, unresolved, and errored delivery IDs', async () => {
    reviewDecisions.push('allow', 'allow', 'allow')
    const unknown = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'unknown',
    })
    expect(unknown.status).toBe(404)

    const unresolved = deliveredFileTranscript('/workspace/output/result.bin', 4)
    unresolved.pop()
    mockGetTranscript.mockResolvedValue(unresolved)
    const unresolvedResponse = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
    })
    expect(unresolvedResponse.status).toBe(404)

    const errored = deliveredFileTranscript('/workspace/output/result.bin', 4) as Array<{
      message?: { content?: Array<{ is_error?: boolean }> }
    }>
    errored[1].message!.content![0].is_error = true
    mockGetTranscript.mockResolvedValue(errored)
    const erroredResponse = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
    })
    expect(erroredResponse.status).toBe(404)
    expect(mockTargetOpen).not.toHaveBeenCalled()
  })

  it('rejects unknown sessions before reading the transcript', async () => {
    reviewDecisions.push('allow')
    mockSessionIsKnown.mockResolvedValue(false)

    const res = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'other-session',
      deliveryId: 'delivery-1',
    })

    expect(res.status).toBe(404)
    expect(mockGetTranscript).not.toHaveBeenCalled()
    expect(mockTargetOpen).not.toHaveBeenCalled()
  })

  it('applies target viewer ACL and read policy before opening the file', async () => {
    authModeEnabled = true
    reviewDecisions.push('allow')

    const res = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
    })

    expect(res.status).toBe(403)
    expect(mockGetTranscript).not.toHaveBeenCalled()
    expect(mockTargetOpen).not.toHaveBeenCalled()
  })

  it('rejects a file whose current size differs from the successful delivery', async () => {
    reviewDecisions.push('allow')
    mockTargetOpen.mockResolvedValue(openBytes('changed'))

    const res = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
    })

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/changed/i)
  })

  it('downloads current same-size contents even when an old delivery recorded a digest', async () => {
    reviewDecisions.push('allow')
    const original = Buffer.from('good')
    const replacement = Buffer.from('evil')
    mockGetTranscript.mockResolvedValue(deliveredFileTranscript(
      '/workspace/output/result.bin',
      original.length,
      'delivery-1',
      'a'.repeat(64),
    ))
    mockTargetOpen.mockResolvedValue(openBytes(replacement))

    const res = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe(String(replacement.length))
    expect(Buffer.from(await res.arrayBuffer())).toEqual(replacement)
  })

  it.each([false, true])('streams current bytes over real HTTP (truncated: %s)', async (truncated) => {
    const { serve } = await import('@hono/node-server')
    reviewDecisions.push('allow')
    const original = Buffer.alloc(128 * 1024, 65)
    const bytes = Buffer.alloc(truncated ? original.length / 2 : original.length, 66)
    mockGetTranscript.mockResolvedValue(deliveredFileTranscript(
      '/workspace/output/result.bin', original.length, 'delivery-1',
      'a'.repeat(64),
    ))
    let finishUpstream!: () => void
    const upstreamFinished = new Promise<void>((resolve) => { finishUpstream = resolve })
    mockTargetOpen.mockResolvedValue(openBytes(bytes, original.length, new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bytes)
        await upstreamFinished
        controller.close()
      },
    })))
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
      const address = server.address() as { port: number }
      const response = await fetch(`http://127.0.0.1:${address.port}/x-agent/download-file`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CALLER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: TARGET_SLUG, sessionId: 'delivered-session', deliveryId: 'delivery-1' }),
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      let received = 0
      while (received < bytes.length) {
        const chunk = await reader.read()
        expect(chunk.done).toBe(false)
        received += chunk.value!.byteLength
      }
      // Truncation must fail at EOF; a complete download can finish as soon
      // as the declared byte count arrives, without a digest pass.
      const completion = reader.read()
      const assertion = truncated
        ? expect(completion).rejects.toThrow()
        : expect(completion).resolves.toMatchObject({ done: true })
      finishUpstream()
      await assertion
    } finally {
      finishUpstream()
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('does not expose target container error details', async () => {
    reviewDecisions.push('allow')
    mockTargetOpen.mockRejectedValue(new WorkspaceFileError('not-found', '/secret/host/path missing'))

    const res = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Delivered file is no longer available' })
  })

  it('rejects a legacy delivery whose transcript path escapes the workspace', async () => {
    reviewDecisions.push('allow')
    mockGetTranscript.mockResolvedValue(deliveredFileTranscript('/workspace/../../etc/passwd', 4))

    const res = await authedFetch('/x-agent/download-file', {
      slug: TARGET_SLUG,
      sessionId: 'delivered-session',
      deliveryId: 'delivery-1',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Delivered file path is invalid' })
    expect(mockTargetOpen).not.toHaveBeenCalled()
  })
})

describe('resolveSyncWaitTimeoutMs', () => {
  it('defaults to 120s when unset or unparseable', () => {
    expect(resolveSyncWaitTimeoutMs(undefined)).toBe(120_000)
    expect(resolveSyncWaitTimeoutMs('')).toBe(120_000)
    expect(resolveSyncWaitTimeoutMs('not-a-number')).toBe(120_000)
  })

  it('rejects non-positive and non-finite overrides', () => {
    // A zero/negative budget would promote every sync call immediately, and
    // Infinity would restore the unbounded wait behind the transport cliff.
    expect(resolveSyncWaitTimeoutMs('0')).toBe(120_000)
    expect(resolveSyncWaitTimeoutMs('-5000')).toBe(120_000)
    expect(resolveSyncWaitTimeoutMs('Infinity')).toBe(120_000)
    expect(resolveSyncWaitTimeoutMs('NaN')).toBe(120_000)
  })

  it('lets overrides shorten the wait but never extend it', () => {
    expect(resolveSyncWaitTimeoutMs('30000')).toBe(30_000)
    expect(resolveSyncWaitTimeoutMs('120000')).toBe(120_000)
    // The tool docs promise "up to ~2 minutes" and the transport dies at 300s
    // — a longer override would break the former and threaten the latter.
    expect(resolveSyncWaitTimeoutMs('240000')).toBe(120_000)
    expect(resolveSyncWaitTimeoutMs('600000')).toBe(120_000)
  })
})

// ============================================================================
// Display-slug resolution: model-facing slugs resolve to the canonical id,
// and every ACL / policy / runtime call below keys on the id (not the prefix).
// ============================================================================

describe('display-slug resolution', () => {
  const TARGET_ID = 't1234567ab' // 10-char minted id
  const DISPLAY_SLUG = `pretty-target-${TARGET_ID}`

  beforeEach(async () => {
    await fs.promises.mkdir(path.join(testDir, 'agents', TARGET_ID), { recursive: true })
    await seedAgentRows([TARGET_ID])
    mockGetAgent.mockResolvedValue({
      slug: TARGET_ID,
      frontmatter: { name: 'Pretty Target', createdAt: '2024-01-01' },
      instructions: '',
    })
    mockCreateSession.mockResolvedValue({ id: 'sess-id' })
  })

  it('/list projects {slug(name)}-{id} for a minted agent', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'list', null, 'allow')
    mockListAgents.mockResolvedValue([{ slug: TARGET_ID, frontmatter: { name: 'Pretty Target' } }])
    const res = await authedFetch('/x-agent/list', {})
    const body = await res.json()
    expect(body.agents).toEqual([{ slug: DISPLAY_SLUG, name: 'Pretty Target' }])
  })

  it('/invoke accepts the display slug and keys runtime calls on the id', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'invoke', TARGET_ID, 'allow')
    const res = await authedFetch('/x-agent/invoke', { slug: DISPLAY_SLUG, prompt: 'hello' })
    expect(res.status).toBe(200)
    expect(mockRegisterSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: TARGET_ID }),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ invokedByAgentSlug: CALLER_SLUG }),
    )
  })

  it('/invoke accepts a wrong-prefix slug (the prefix is decorative)', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'invoke', TARGET_ID, 'allow')
    const res = await authedFetch('/x-agent/invoke', { slug: `anything-${TARGET_ID}`, prompt: 'hi' })
    expect(res.status).toBe(200)
  })

  it('policy is keyed on the resolved id — a block on the id blocks a display-slug invoke', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'invoke', TARGET_ID, 'block')
    const res = await authedFetch('/x-agent/invoke', { slug: DISPLAY_SLUG, prompt: 'hi' })
    expect(res.status).toBe(403)
  })

  it('/get-sessions accepts the display slug and lists by id', async () => {
    const { setPolicy } = await import('@shared/lib/services/x-agent-policy-service')
    await setPolicy(CALLER_SLUG, 'read', TARGET_ID, 'allow')
    mockListSessions.mockResolvedValue([])
    const res = await authedFetch('/x-agent/get-sessions', { slug: DISPLAY_SLUG })
    expect(res.status).toBe(200)
    expect(mockListSessions).toHaveBeenCalledWith(expect.objectContaining({ slug: TARGET_ID }))
  })

  it('returns 404 for a well-formed display slug whose id does not exist', async () => {
    const res = await authedFetch('/x-agent/invoke', { slug: 'ghost-zzzzzzzzzz', prompt: 'hi' })
    expect(res.status).toBe(404)
  })
})
