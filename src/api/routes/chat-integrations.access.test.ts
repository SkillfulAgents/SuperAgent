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

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  AgentUser: () => async (c: any, next: () => Promise<void>) => { c.set('user', mockAuthUser); return next() },
  EntityAgentRole: (opts: any) => (_minRole: string) => async (c: any, next: () => Promise<void>) => {
    const id = c.req.param(opts.paramName)
    const entity = await opts.lookupFn(id)
    if (!entity) return c.json({ error: `${opts.entityName} not found` }, 404)
    c.set(opts.contextKey, entity)
    c.set('user', mockAuthUser)
    return next()
  },
}))

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
const mockClearChatSessionById = vi.fn()

vi.mock('@shared/lib/chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: {
    clearChatSessionById: (id: string) => mockClearChatSessionById(id),
    notifyChatApproved: (...args: unknown[]) => mockNotifyChatApproved(...args),
    tearDownChatSession: (...args: unknown[]) => mockTearDownChatSession(...args),
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
})
