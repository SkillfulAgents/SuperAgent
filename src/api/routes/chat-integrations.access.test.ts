/**
 * Access route tests for GET /:integrationId/access and
 * POST /:integrationId/access/:accessId/{approve,deny,revoke}.
 *
 * Uses the real access service against an in-memory test DB.
 * Mocks: auth middleware, chat-integration-service, session-service,
 * chat-integration-manager, config-schema, auth/config, audit-log-service,
 * error-reporting. Does NOT mock the access service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import crypto from 'node:crypto'
import * as schema from '@shared/lib/db/schema'

// ── In-memory test DB shared with the real access service ────────────────
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

// ── Auth middleware: faithful passthrough (mirrors sup229 test) ──────────
const mockAuthUser = { id: 'owner-user', name: 'Owner', email: 'owner@example.com' }
// Test-controlled caller role so the owner-gate is actually exercised. Default
// 'owner'; tests drop it to 'user' to assert 403 on owner-gated routes.
const mockAuthRole: { current: 'viewer' | 'user' | 'owner' } = { current: 'owner' }

vi.mock('../middleware/auth', () => {
  const RANK: Record<string, number> = { viewer: 0, user: 1, owner: 2 }
  return {
    Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
    AgentUser: () => async (c: any, next: () => Promise<void>) => {
      if (RANK[mockAuthRole.current] < RANK.user) return c.json({ error: 'Forbidden' }, 403)
      c.set('user', mockAuthUser); return next()
    },
    ResolveAgent: () => async (c: any, next: () => Promise<void>) => { c.set('agentId', c.req.param('id')); return next() },
    getAgentId: (c: any) => c.get('agentId') ?? c.req.param('id'),
    EntityAgentRole: (opts: any) => (minRole: string) => async (c: any, next: () => Promise<void>) => {
      const id = c.req.param(opts.paramName)
      const entity = await opts.lookupFn(id)
      if (!entity) return c.json({ error: `${opts.entityName} not found` }, 404)
      if (RANK[mockAuthRole.current] < RANK[minRole]) return c.json({ error: 'Forbidden' }, 403)
      c.set(opts.contextKey, entity)
      c.set('user', mockAuthUser)
      return next()
    },
  }
})

// ── Integration service: returns mock objects keyed by id ────────────────
const INTEGRATION_A = 'integration-a'
const INTEGRATION_B = 'integration-b'

const integrations: Record<string, { id: string; agentSlug: string }> = {
  [INTEGRATION_A]: { id: INTEGRATION_A, agentSlug: 'agent-a' },
  [INTEGRATION_B]: { id: INTEGRATION_B, agentSlug: 'agent-b' },
}
const mockGetChatIntegration = vi.fn((id: string) => integrations[id] ?? null)

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: (id: string) => mockGetChatIntegration(id),
  createChatIntegration: vi.fn(),
  updateChatIntegration: vi.fn(),
  updateChatIntegrationStatus: vi.fn(),
  deleteChatIntegration: vi.fn(),
  DuplicateBotTokenError: class DuplicateBotTokenError extends Error {},
}))

// ── Session service: mocked ─────────────────────────────────────────────
vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  getChatIntegrationSessionById: vi.fn(),
  archiveChatIntegrationSession: vi.fn(),
  listChatIntegrationSessions: vi.fn(() => []),
  deleteChatIntegrationSessionsByIntegration: vi.fn(),
}))

// ── Manager: mocked with spies on the new helpers ───────────────────────
const mockNotifyChatApproved = vi.fn().mockResolvedValue(undefined)
const mockTearDownChatSession = vi.fn().mockResolvedValue(undefined)
const mockReconcileAccess = vi.fn().mockResolvedValue(undefined)
const mockClearChatSessionById = vi.fn()

vi.mock('@shared/lib/chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: {
    clearChatSessionById: (id: string) => mockClearChatSessionById(id),
    notifyChatApproved: (...args: unknown[]) => mockNotifyChatApproved(...args),
    tearDownChatSession: (...args: unknown[]) => mockTearDownChatSession(...args),
    reconcileAccess: (...args: unknown[]) => mockReconcileAccess(...args),
    isIntegrationConnected: vi.fn(() => false),
    addIntegration: vi.fn(),
    removeIntegration: vi.fn(),
    pauseIntegration: vi.fn(),
    resumeIntegration: vi.fn(),
  },
}))

vi.mock('@shared/lib/chat-integrations/config-schema', () => ({
  validateChatIntegrationConfig: vi.fn(),
  CHAT_PROVIDERS: ['telegram', 'slack', 'imessage'],
  IMESSAGE_GATEWAY_URL: 'https://imessage.example.com',
  imessageSetupSchema: { safeParse: () => ({ success: true, data: {} }) },
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => mockAuthUser.id,
}))

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

import chatIntegrationsRouter from './chat-integrations'
import { createChatIntegration } from '@shared/lib/services/chat-integration-service'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'

function app() {
  const a = new Hono()
  a.route('/api/chat-integrations', chatIntegrationsRouter)
  return a
}

// ── DB seeding helpers ───────────────────────────────────────────────────

function seedIntegration(id: string, agentSlug: string) {
  const now = Date.now()
  testSqlite.prepare(
    `INSERT INTO chat_integrations (id, agent_slug, provider, config, created_at, updated_at)
     VALUES (?, ?, 'telegram', '{}', ?, ?)`,
  ).run(id, agentSlug, now, now)
}

function seedAccess(integrationId: string, externalChatId: string, status: 'pending' | 'allowed' | 'denied'): string {
  const id = crypto.randomUUID()
  const now = Date.now()
  testSqlite.prepare(
    `INSERT INTO chat_integration_access
       (id, integration_id, external_chat_id, status, requested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, integrationId, externalChatId, status, now, now, now)
  return id
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('chat-integrations access routes', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    vi.clearAllMocks()
    mockAuthRole.current = 'owner'
    mockGetChatIntegration.mockImplementation((id: string) => integrations[id] ?? null)
    mockNotifyChatApproved.mockResolvedValue(undefined)
    mockTearDownChatSession.mockResolvedValue(undefined)
    // Seed integration rows to satisfy FK constraints
    seedIntegration(INTEGRATION_A, 'agent-a')
    seedIntegration(INTEGRATION_B, 'agent-b')
  })

  afterEach(() => {
    testSqlite?.close()
  })

  // ── GET /:integrationId/access ─────────────────────────────────────────

  describe('GET /:integrationId/access', () => {
    it('returns all access rows for the integration', async () => {
      seedAccess(INTEGRATION_A, 'chat-1', 'pending')
      seedAccess(INTEGRATION_A, 'chat-2', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access`,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as unknown[]
      expect(body).toHaveLength(2)
    })

    it('filters rows when ?status= is valid', async () => {
      seedAccess(INTEGRATION_A, 'chat-1', 'pending')
      seedAccess(INTEGRATION_A, 'chat-2', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access?status=pending`,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as Array<{ status: string }>
      expect(body).toHaveLength(1)
      expect(body[0].status).toBe('pending')
    })

    it('returns 400 for an invalid ?status value', async () => {
      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access?status=bogus`,
      )
      expect(res.status).toBe(400)
    })

    it('returns only rows for the requested integration (does not bleed across integrations)', async () => {
      seedAccess(INTEGRATION_A, 'chat-a', 'pending')
      seedAccess(INTEGRATION_B, 'chat-b', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access`,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as Array<{ integrationId: string }>
      expect(body).toHaveLength(1)
      expect(body[0].integrationId).toBe(INTEGRATION_A)
    })
  })

  // ── POST approve ───────────────────────────────────────────────────────

  describe('POST /:integrationId/access/:accessId/approve', () => {
    it('transitions pending→allowed and returns ok:true', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-pending', 'pending')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/approve`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      // Verify the DB row was updated
      const row = testSqlite
        .prepare(`SELECT status FROM chat_integration_access WHERE id = ?`)
        .get(accessId) as { status: string } | undefined
      expect(row?.status).toBe('allowed')

      // Notice sent to the chat
      expect(mockNotifyChatApproved).toHaveBeenCalledWith(INTEGRATION_A, 'chat-pending')
    })

    it('returns ok:false for an already-allowed row and sends no notice', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-already', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/approve`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(false)
      expect(mockNotifyChatApproved).not.toHaveBeenCalled()
    })
  })

  // ── BOLA guard (security-critical) ────────────────────────────────────

  describe('BOLA guard', () => {
    it('returns 404 when the accessId belongs to a different integration and does not transition it', async () => {
      // seed an access row under integration B
      const bAccessId = seedAccess(INTEGRATION_B, 'chat-b', 'pending')

      // request uses integration A's id + B's accessId
      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${bAccessId}/approve`,
        { method: 'POST' },
      )

      expect(res.status).toBe(404)

      // The row must still be pending — transition must NOT have happened
      const row = testSqlite
        .prepare(`SELECT status FROM chat_integration_access WHERE id = ?`)
        .get(bAccessId) as { status: string } | undefined
      expect(row?.status).toBe('pending')

      // No side-effects
      expect(mockNotifyChatApproved).not.toHaveBeenCalled()
    })

    it('deny: 404 for a foreign accessId, row unchanged, no teardown', async () => {
      const bAccessId = seedAccess(INTEGRATION_B, 'chat-b', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${bAccessId}/deny`,
        { method: 'POST' },
      )

      expect(res.status).toBe(404)
      const row = testSqlite
        .prepare(`SELECT status FROM chat_integration_access WHERE id = ?`)
        .get(bAccessId) as { status: string } | undefined
      expect(row?.status).toBe('allowed')
      expect(mockTearDownChatSession).not.toHaveBeenCalled()
    })

    it('revoke: 404 for a foreign accessId, row unchanged, no teardown', async () => {
      const bAccessId = seedAccess(INTEGRATION_B, 'chat-b', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${bAccessId}/revoke`,
        { method: 'POST' },
      )

      expect(res.status).toBe(404)
      const row = testSqlite
        .prepare(`SELECT status FROM chat_integration_access WHERE id = ?`)
        .get(bAccessId) as { status: string } | undefined
      expect(row?.status).toBe('allowed')
      expect(mockTearDownChatSession).not.toHaveBeenCalled()
    })
  })

  // ── Audit-log verb mapping ────────────────────────────────────────────
  describe('audit logging', () => {
    it('approve logs details.access="approve"', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-1', 'pending')
      await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/approve`,
        { method: 'POST' },
      )
      expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ access: 'approve', accessId }) }),
      )
    })

    it('deny logs details.access="deny"', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-1', 'pending')
      await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/deny`,
        { method: 'POST' },
      )
      expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ access: 'deny', accessId }) }),
      )
    })

    it('revoke logs details.access="revoke"', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-1', 'allowed')
      await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/revoke`,
        { method: 'POST' },
      )
      expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ access: 'revoke', accessId }) }),
      )
    })

    it('a no-op transition (approve an already-allowed row) does not log an audit event', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-1', 'allowed')
      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/approve`,
        { method: 'POST' },
      )
      expect((await res.json() as { ok: boolean }).ok).toBe(false)
      expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalled()
    })
  })

  // ── POST revoke ────────────────────────────────────────────────────────

  describe('POST /:integrationId/access/:accessId/revoke', () => {
    it('tears down the session and returns ok:true for an allowed row', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-allowed', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/revoke`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      // The row should now be denied
      const row = testSqlite
        .prepare(`SELECT status FROM chat_integration_access WHERE id = ?`)
        .get(accessId) as { status: string } | undefined
      expect(row?.status).toBe('denied')

      // tearDownChatSession invoked with the right args
      expect(mockTearDownChatSession).toHaveBeenCalledWith(INTEGRATION_A, 'chat-allowed')
    })

    it('returns ok:false and does not tear down for a non-allowed (pending) row', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-pending', 'pending')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/revoke`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(false)
      expect(mockTearDownChatSession).not.toHaveBeenCalled()
    })
  })

  // ── POST deny ─────────────────────────────────────────────────────────

  describe('POST /:integrationId/access/:accessId/deny', () => {
    it('transitions pending→denied and returns ok:true', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-pending', 'pending')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/deny`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      const row = testSqlite
        .prepare(`SELECT status FROM chat_integration_access WHERE id = ?`)
        .get(accessId) as { status: string } | undefined
      expect(row?.status).toBe('denied')
      // tearDownChatSession IS called (it's a no-op when no live session exists);
      // the key is that it does not throw.
      expect(mockTearDownChatSession).toHaveBeenCalledWith(INTEGRATION_A, 'chat-pending')
    })

    it('tears down the live session when denying an already-allowed chat', async () => {
      const accessId = seedAccess(INTEGRATION_A, 'chat-allowed', 'allowed')

      const res = await app().request(
        `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/deny`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      // The row should now be denied
      const row = testSqlite
        .prepare(`SELECT status FROM chat_integration_access WHERE id = ?`)
        .get(accessId) as { status: string } | undefined
      expect(row?.status).toBe('denied')

      // tearDownChatSession must be called to kill the live SSE/forwarding session
      expect(mockTearDownChatSession).toHaveBeenCalledWith(INTEGRATION_A, 'chat-allowed')
    })
  })

  describe('PATCH /:integrationId/require-approval (owner-gated make-public)', () => {
    it('rejects a non-boolean requireApproval with 400', async () => {
      const res = await app().request(`http://localhost/api/chat-integrations/${INTEGRATION_A}/require-approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireApproval: 'false' }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'requireApproval must be a boolean' })
    })

    it('accepts a boolean requireApproval and persists it', async () => {
      const { updateChatIntegration } = await import('@shared/lib/services/chat-integration-service')
      const res = await app().request(`http://localhost/api/chat-integrations/${INTEGRATION_A}/require-approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireApproval: false }),
      })
      expect(res.status).toBe(200)
      expect(updateChatIntegration).toHaveBeenCalledWith(
        INTEGRATION_A,
        expect.objectContaining({ requireApproval: false }),
      )
      // Disabling approval does not reconcile sessions
      expect(mockReconcileAccess).not.toHaveBeenCalled()
    })

    it('reconciles running sessions when approval is turned ON', async () => {
      const res = await app().request(`http://localhost/api/chat-integrations/${INTEGRATION_A}/require-approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireApproval: true }),
      })
      expect(res.status).toBe(200)
      expect(mockReconcileAccess).toHaveBeenCalledWith(INTEGRATION_A)
    })
  })

  // ── Owner-role enforcement ─────────────────────────────────────────────
  // The role mock honors minRole, so these prove a non-owner 'user' is blocked
  // from the owner-gated access/management routes (not just hidden in the UI).

  describe('owner-role enforcement (user role rejected on owner-gated routes)', () => {
    it('GET /access returns 403 for a non-owner user', async () => {
      seedAccess(INTEGRATION_A, 'chat-1', 'pending')
      mockAuthRole.current = 'user'
      const res = await app().request(`http://localhost/api/chat-integrations/${INTEGRATION_A}/access`)
      expect(res.status).toBe(403)
    })

    it('PATCH /require-approval returns 403 for a non-owner user (no reconcile)', async () => {
      mockAuthRole.current = 'user'
      const res = await app().request(`http://localhost/api/chat-integrations/${INTEGRATION_A}/require-approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireApproval: false }),
      })
      expect(res.status).toBe(403)
      expect(mockReconcileAccess).not.toHaveBeenCalled()
    })

    it.each(['approve', 'deny', 'revoke'])(
      'POST /access/:id/%s returns 403 for a non-owner user (no spend, no teardown)',
      async (verb) => {
        const accessId = seedAccess(INTEGRATION_A, 'chat-1', 'pending')
        mockAuthRole.current = 'user'
        const res = await app().request(
          `http://localhost/api/chat-integrations/${INTEGRATION_A}/access/${accessId}/${verb}`,
          { method: 'POST' },
        )
        expect(res.status).toBe(403)
        expect(mockTearDownChatSession).not.toHaveBeenCalled()
        expect(mockNotifyChatApproved).not.toHaveBeenCalled()
      },
    )

    it('GET /access still succeeds for an owner (positive control)', async () => {
      seedAccess(INTEGRATION_A, 'chat-1', 'pending')
      mockAuthRole.current = 'owner'
      const res = await app().request(`http://localhost/api/chat-integrations/${INTEGRATION_A}/access`)
      expect(res.status).toBe(200)
    })
  })

  // ── Create route: make-public is owner-only, not settable at create ─────

  describe('POST /:id create — requireApproval not settable at create', () => {
    it('ignores requireApproval in the body so the public flip cannot bypass the owner gate', async () => {
      vi.mocked(createChatIntegration).mockReturnValue('new-int')
      mockGetChatIntegration.mockImplementation((id: string) =>
        id === 'new-int' ? { id: 'new-int', agentSlug: 'agent-a' } : (integrations[id] ?? null),
      )

      const res = await app().request('http://localhost/api/chat-integrations/agent-a', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'telegram', config: { botToken: 't' }, requireApproval: false }),
      })

      expect(res.status).toBe(201)
      // The route must NOT forward requireApproval — the service applies its secure
      // default (true). Making a bot public is owner-only via PATCH /require-approval.
      expect(vi.mocked(createChatIntegration)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(createChatIntegration).mock.calls[0][0]).not.toHaveProperty('requireApproval')
    })
  })
})
