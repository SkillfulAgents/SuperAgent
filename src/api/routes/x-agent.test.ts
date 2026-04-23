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
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'crypto'
import * as schema from '@shared/lib/db/schema'

// Shrink the readLastAssistantMessage retry budget in tests (default is 10×500ms).
// Hoisted via vi.hoisted so it runs before the x-agent module reads these envs.
vi.hoisted(() => {
  process.env.X_AGENT_READ_RETRY_ATTEMPTS = '4'
  process.env.X_AGENT_READ_RETRY_INTERVAL_MS = '50'
})

// ----------------------------------------------------------------------------
// Mocks (must be set up BEFORE importing the route)
// ----------------------------------------------------------------------------

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('@shared/lib/db', async () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
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
vi.mock('@shared/lib/services/agent-service', () => ({
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
}))

// Session service (file-based)
const mockListSessions = vi.fn((..._args: unknown[]): unknown => undefined)
const mockGetTranscript = vi.fn((..._args: unknown[]): unknown => undefined)
const mockRegisterSession = vi.fn(async (..._args: unknown[]) => {})
const mockUpdateSessionMetadata = vi.fn(async (..._args: unknown[]) => {})
const mockGetSessionMetadata = vi.fn(async (..._args: unknown[]): Promise<unknown> => null)
vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSessionMessagesWithCompact: (...args: unknown[]) => mockGetTranscript(...args),
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
  updateSessionMetadata: (...args: unknown[]) => mockUpdateSessionMetadata(...args),
  getSessionMetadata: (...args: unknown[]) => mockGetSessionMetadata(...args),
}))

// Container manager
const mockCreateSession = vi.fn((..._args: unknown[]): unknown => undefined)
const mockSendMessage = vi.fn((..._args: unknown[]): unknown => undefined)
const mockDeleteSession = vi.fn(async (..._args: unknown[]) => true)
const mockEnsureRunning = vi.fn(async (..._args: unknown[]) => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
}))
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: (...args: unknown[]) => mockEnsureRunning(...args),
  },
}))

// Message persister
const mockIsSessionActive = vi.fn((_sessionId?: string): boolean => false)
const mockIsSessionAwaitingInput = vi.fn((_sessionId?: string): boolean => false)
const mockWaitForIdle = vi.fn(async (..._args: unknown[]) => {})
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    isSessionActive: (sessionId?: string) => mockIsSessionActive(sessionId),
    isSessionAwaitingInput: (sessionId?: string) => mockIsSessionAwaitingInput(sessionId),
    waitForIdle: (...args: unknown[]) => mockWaitForIdle(...args),
    isSubscribed: vi.fn(() => true),
    subscribeToSession: vi.fn(),
    unsubscribeFromSession: vi.fn(),
    markSessionActive: vi.fn(),
    setSlashCommands: vi.fn(),
  },
}))

// Settings + secrets (only used by invoke for new sessions)
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({ agentModel: 'sonnet', browserModel: 'sonnet' }),
  getEffectiveAgentLimits: () => ({}),
  getCustomEnvVars: () => ({}),
  getSettings: () => ({ app: {} }),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn(async () => []),
}))

// Review manager (direct decision injection)
let reviewDecisions: Array<'allow' | 'deny'> = []
vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    requestXAgentReview: vi.fn(async () => {
      const next = reviewDecisions.shift()
      if (!next) throw new Error('No queued review decision')
      return next
    }),
  },
}))

// ----------------------------------------------------------------------------
// Imports (after mocks)
// ----------------------------------------------------------------------------

import xAgentRoute from './x-agent'

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

beforeEach(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xagent-test-'))
  testSqlite = new Database(':memory:')
  testDb = drizzle(testSqlite, { schema })
  const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
  migrate(testDb, { migrationsFolder })

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

  // Reset state
  authModeEnabled = false
  reviewDecisions = []
  vi.clearAllMocks()
  mockIsSessionActive.mockReturnValue(false)
  mockIsSessionAwaitingInput.mockReturnValue(false)
  mockWaitForIdle.mockResolvedValue(undefined)
  mockEnsureRunning.mockClear()
  mockEnsureRunning.mockResolvedValue({
    createSession: mockCreateSession,
    sendMessage: mockSendMessage,
    deleteSession: mockDeleteSession,
  } as never)

  app = new Hono()
  app.route('/x-agent', xAgentRoute)
})

afterEach(async () => {
  testSqlite?.close()
  await fs.promises.rm(testDir, { recursive: true, force: true })
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
    mockCreateAgent.mockResolvedValue({ slug: 'new-helper', name: 'New Helper' })
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
    mockCreateAgent.mockResolvedValue({ slug: 'new-helper', name: 'New' })
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
    mockGetSessionMetadata.mockImplementation(async (slug: unknown, sessionId: unknown) => {
      if (slug === CALLER_SLUG && sessionId === callerSessionId) {
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
    mockGetSessionMetadata.mockImplementation(async (slug: unknown, sessionId: unknown) => {
      if (slug === CALLER_SLUG && sessionId === callerSessionId) {
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
      expect.objectContaining({ initialMessage: 'hello' }),
    )
    expect(mockUpdateSessionMetadata).toHaveBeenCalledWith(
      TARGET_SLUG,
      'new-sess-id',
      expect.objectContaining({ invokedByAgentSlug: CALLER_SLUG }),
    )
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
  })

  it('returns running + error (200, not 500) when sync=true and waitForIdle rejects', async () => {
    // Sync invoke degrades gracefully when the target never idles: caller still
    // gets the sessionId so they can poll/follow up via get-transcript later,
    // plus an error string for visibility. This is intentionally NOT a 500 —
    // the session was successfully created, it just didn't finish in time.
    reviewDecisions.push('allow')
    mockWaitForIdle.mockRejectedValueOnce(new Error('waitForIdle timeout after 600000ms'))
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
      error: expect.stringMatching(/timeout/i),
    })
    // No transcript read should have been attempted since waitForIdle failed
    expect(mockGetTranscript).not.toHaveBeenCalled()
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
    expect(mockGetSessionMetadata).toHaveBeenCalledWith(CALLER_SLUG, 'fresh-session')
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
    expect(mockWaitForIdle).toHaveBeenCalledWith('new-sess-id')
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

  it('continues existing session via sendMessage when not running', async () => {
    reviewDecisions.push('allow')
    mockIsSessionActive.mockReturnValue(false)
    const res = await authedFetch('/x-agent/invoke', {
      slug: TARGET_SLUG,
      prompt: 'follow-up',
      sessionId: 'existing-sess',
    })
    expect(res.status).toBe(200)
    expect(mockSendMessage).toHaveBeenCalledWith('existing-sess', 'follow-up')
    expect(mockCreateSession).not.toHaveBeenCalled()
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
    mockIsSessionActive.mockImplementation((id?: string) => id === 'sess-1')
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
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: 'hi\n[tool_use: Bash]',
      toolName: 'Bash',
    })
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
    expect(mockWaitForIdle).toHaveBeenCalledWith('sess-1')
    const body = await res.json()
    expect(body.status).toBe('idle')
  })
})

