/**
 * Tests for the GET / PUT /api/agents/:id/x-agent-policies routes
 * (the per-agent UI for reviewing remembered cross-agent permissions).
 *
 * Uses in-memory SQLite + mocks for file-based services. Mounts agents.ts as a sub-app.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@shared/lib/db/schema'

// ----------------------------------------------------------------------------
// DB
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

// ----------------------------------------------------------------------------
// Auth: bypass middleware (non-auth mode is the default)
// ----------------------------------------------------------------------------

let authModeEnabled = false
let currentUserId = 'user-default'
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => authModeEnabled,
}))
vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => currentUserId,
}))

vi.mock('../middleware/auth', () => {
  const passthrough = () => async (_c: unknown, next: () => Promise<void>) => next()
  return {
    Authenticated: passthrough,
    AgentRead: passthrough,
    AgentUser: passthrough,
    AgentAdmin: passthrough,
    EntityAgentRole: () => () => passthrough(),
    OwnsAccount: passthrough,
    OwnsAccountByParam: () => passthrough(),
    UsersMcpServer: passthrough,
    OwnsMcpByParam: () => passthrough(),
    HasNotificationAccess: passthrough,
    IsAdmin: passthrough,
    IsAgent: passthrough,
    Or: () => passthrough(),
  }
})

// ----------------------------------------------------------------------------
// Mock all the heavy stuff agents.ts pulls in. We only care about the policy routes.
// ----------------------------------------------------------------------------

const mockGetAgent = vi.fn()
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: vi.fn(async () => true),
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
  getAgentWithStatus: vi.fn(),
  listAgentsWithStatus: vi.fn(async () => []),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  createAgentFromExistingWorkspace: vi.fn(),
  setAgentClaudeMdContent: vi.fn(),
  getAgentClaudeMdContent: vi.fn(),
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: vi.fn(),
    ensureRunning: vi.fn(),
    getCachedInfo: vi.fn(() => ({ status: 'stopped', port: null })),
    getHealthWarnings: vi.fn(() => []),
    removeClient: vi.fn(),
  },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    isSessionActive: vi.fn(() => false),
    isSessionAwaitingInput: vi.fn(() => false),
    hasActiveSessionsForAgent: vi.fn(() => false),
    hasSessionsAwaitingInputForAgent: vi.fn(() => false),
    isSubscribed: vi.fn(() => true),
    subscribeToSession: vi.fn(),
    markSessionActive: vi.fn(),
    setSlashCommands: vi.fn(),
    broadcastGlobal: vi.fn(),
    broadcastSessionUpdate: vi.fn(),
    broadcastSessionEvent: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
  },
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: { getPendingReviewsForAgent: vi.fn(() => []) },
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  revokeProxyToken: vi.fn(),
  validateProxyToken: vi.fn(),
}))

// ----------------------------------------------------------------------------
// Import the route + service (after mocks)
// ----------------------------------------------------------------------------

import agentsRouter from './agents'
import {
  setPolicy,
  getPolicy,
  listPoliciesForCaller,
} from '@shared/lib/services/x-agent-policy-service'

// ----------------------------------------------------------------------------
// Test app
// ----------------------------------------------------------------------------

const CALLER = 'caller-agent'
const TARGET_A = 'target-a'
const TARGET_B = 'target-b'

let app: Hono

beforeEach(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xap-routes-test-'))
  testSqlite = new Database(':memory:')
  testDb = drizzle(testSqlite, { schema })
  const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
  migrate(testDb, { migrationsFolder })

  authModeEnabled = false
  currentUserId = 'user-default'
  vi.clearAllMocks()
  mockGetAgent.mockImplementation(async (slug: string) => ({
    slug,
    frontmatter: { name: slug === TARGET_A ? 'Target A' : slug === TARGET_B ? 'Target B' : slug, createdAt: '2024-01-01' },
    instructions: '',
  }))

  app = new Hono()
  app.route('/api/agents', agentsRouter)
})

afterEach(async () => {
  testSqlite?.close()
  await fs.promises.rm(testDir, { recursive: true, force: true })
})

// ============================================================================
// GET /api/agents/:id/x-agent-policies
// ============================================================================

describe('GET /api/agents/:id/x-agent-policies', () => {
  it('returns empty list when no policies exist', async () => {
    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ policies: [] })
  })

  it('returns rows for the caller, with target name lookup', async () => {
    await setPolicy(CALLER, 'invoke', TARGET_A, 'allow')
    await setPolicy(CALLER, 'read', TARGET_B, 'block')
    await setPolicy(CALLER, 'list', null, 'allow')

    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`)
    const body = await res.json()
    expect(body.policies).toHaveLength(3)
    const byKey = Object.fromEntries(
      body.policies.map((p: { operation: string; targetAgentSlug: string | null; decision: string; targetAgentName: string | null }) => [
        `${p.operation}:${p.targetAgentSlug ?? '_'}`,
        { decision: p.decision, name: p.targetAgentName },
      ]),
    )
    expect(byKey['invoke:target-a']).toEqual({ decision: 'allow', name: 'Target A' })
    expect(byKey['read:target-b']).toEqual({ decision: 'block', name: 'Target B' })
    expect(byKey['list:_']).toEqual({ decision: 'allow', name: null })
  })

  it('does not return rows for OTHER callers', async () => {
    await setPolicy('other-caller', 'invoke', TARGET_A, 'allow')
    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`)
    const body = await res.json()
    expect(body.policies).toEqual([])
  })

  it('handles a missing target agent (deleted) by returning name=null', async () => {
    await setPolicy(CALLER, 'invoke', 'ghost', 'allow')
    mockGetAgent.mockImplementation(async (slug: string) => (slug === 'ghost' ? null : { slug, frontmatter: { name: slug, createdAt: '2024-01-01' }, instructions: '' }))
    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`)
    const body = await res.json()
    expect(body.policies).toHaveLength(1)
    expect(body.policies[0].targetAgentName).toBeNull()
  })

  it('in auth mode, hides policies whose target the viewer cannot see (ACL filter)', async () => {
    authModeEnabled = true
    currentUserId = 'user-viewer'

    await setPolicy(CALLER, 'invoke', TARGET_A, 'allow') // visible target
    await setPolicy(CALLER, 'invoke', TARGET_B, 'block') // INVISIBLE target
    await setPolicy(CALLER, 'list', null, 'allow')       // null target — always shown

    // ACL: user-viewer can see TARGET_A only (not TARGET_B)
    await testDb.insert(schema.user).values([
      { id: 'user-viewer', name: 'V', email: 'v@t', emailVerified: false },
    ])
    await testDb.insert(schema.agentAcl).values([
      { id: 'acl-1', userId: 'user-viewer', agentSlug: TARGET_A, role: 'viewer', createdAt: new Date() },
      { id: 'acl-2', userId: 'user-viewer', agentSlug: CALLER, role: 'viewer', createdAt: new Date() },
    ])

    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const slugs = body.policies.map((p: { targetAgentSlug: string | null }) => p.targetAgentSlug)
    expect(slugs).toContain(TARGET_A)
    expect(slugs).toContain(null) // 'list' policy still shown
    expect(slugs).not.toContain(TARGET_B)
  })
})

// ============================================================================
// PUT /api/agents/:id/x-agent-policies
// ============================================================================

describe('PUT /api/agents/:id/x-agent-policies', () => {
  it('replaces all policies for the caller', async () => {
    await setPolicy(CALLER, 'invoke', TARGET_A, 'allow')
    await setPolicy(CALLER, 'list', null, 'allow')

    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policies: [
          { operation: 'invoke', targetSlug: TARGET_B, decision: 'block' },
        ],
      }),
    })
    expect(res.status).toBe(200)

    const remaining = listPoliciesForCaller(CALLER)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].targetAgentSlug).toBe(TARGET_B)
    expect(remaining[0].decision).toBe('block')
    // Old rows are gone
    expect(getPolicy(CALLER, 'invoke', TARGET_A)).toBeNull()
    expect(getPolicy(CALLER, 'list', null)).toBeNull()
  })

  it('rejects invalid payload with 400', async () => {
    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: [{ operation: 'bogus', targetSlug: null, decision: 'allow' }] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a policy targeting the caller itself with 400', async () => {
    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policies: [{ operation: 'invoke', targetSlug: CALLER, decision: 'allow' }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts an empty list (clears all caller policies)', async () => {
    await setPolicy(CALLER, 'invoke', TARGET_A, 'allow')
    const res = await app.request(`/api/agents/${CALLER}/x-agent-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: [] }),
    })
    expect(res.status).toBe(200)
    expect(listPoliciesForCaller(CALLER)).toHaveLength(0)
  })

  it('does not affect policies of other callers', async () => {
    await setPolicy('other-caller', 'invoke', TARGET_A, 'allow')
    await app.request(`/api/agents/${CALLER}/x-agent-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policies: [{ operation: 'invoke', targetSlug: TARGET_B, decision: 'block' }],
      }),
    })
    expect(getPolicy('other-caller', 'invoke', TARGET_A)?.decision).toBe('allow')
  })

  it('treats decision=review as default (no row stored)', async () => {
    await app.request(`/api/agents/${CALLER}/x-agent-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policies: [
          { operation: 'invoke', targetSlug: TARGET_A, decision: 'allow' },
          { operation: 'read', targetSlug: TARGET_A, decision: 'review' },
        ],
      }),
    })
    const rows = listPoliciesForCaller(CALLER)
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('invoke')
  })
})
