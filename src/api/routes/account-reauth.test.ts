import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'

let testDb: ReturnType<typeof drizzle>
let sqlite: InstanceType<typeof Database>
let currentUserId = 'member'
let authMode = true
const syncEnvironment = vi.fn()
const activeSessions = vi.fn<() => string[]>()
const interrupt = vi.fn()
const send = vi.fn()

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => currentUserId }))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    syncAgentSessionsAwaiting: vi.fn(), getActiveSessionIdsForAgent: () => activeSessions(),
    isSessionActive: () => true, getTurnGeneration: () => 3, markSessionInterrupted: vi.fn(),
    withSessionSend: async (_agent: string, _session: string, _client: unknown, deliver: () => Promise<void>) => deliver(),
  },
}))
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getCachedInfo: () => ({ status: 'running' }),
    getClient: () => ({ interruptSession: interrupt, sendMessage: send }),
  },
}))
vi.mock('@shared/lib/container/connection-runtime-sync', () => ({
  syncAgentConnectionEnvironment: (...args: unknown[]) => syncEnvironment(...args),
}))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/platform-attribution', () => ({}))
vi.mock('@shared/lib/utils/file-storage', () => ({ resolveAgentId: vi.fn() }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn() }))

import accountReauth from './account-reauth'
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { getReplacementAccountId } from '@shared/lib/proxy/account-replacement'

type TestEnv = { Variables: { user: { id: string }; agentId: string } }
let app: Hono<TestEnv>

function account(id: string, userId: string, status: 'active' | 'expired' = 'active', toolkitSlug = 'slack') {
  testDb.insert(schema.connectedAccounts).values({
    id, userId, status, toolkitSlug, providerConnectionId: `provider-${id}`,
    displayName: id, createdAt: new Date(), updatedAt: new Date(),
  }).run()
}

function mapping(agentSlug: string, connectedAccountId: string) {
  testDb.insert(schema.agentConnectedAccounts).values({
    id: `${agentSlug}-${connectedAccountId}`, agentSlug, connectedAccountId, createdAt: new Date(),
  }).run()
}

function mappedAccounts(agentSlug: string) {
  return testDb.select().from(schema.agentConnectedAccounts)
    .where(eq(schema.agentConnectedAccounts.agentSlug, agentSlug)).all()
    .map((row) => row.connectedAccountId).sort()
}

function park(agentSlug = 'shared-agent') {
  const settled = accountReauthManager.requestReauth({
    agentSlug, accountId: 'old', toolkit: 'slack', accountStatus: 'expired',
  }).catch((error: unknown) => error)
  const [request] = userInputRequestManager.getAgentScopedRequests(agentSlug)
  return { id: request.id, settled }
}

function replace(requestId: string, accountIds = ['mine'], agentSlug = 'shared-agent') {
  return app.request(`/api/agents/${agentSlug}/reauth-request/${requestId}/replace-account`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountIds }),
  })
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  currentUserId = 'member'
  authMode = true
  syncEnvironment.mockReset().mockResolvedValue(true)
  activeSessions.mockReset().mockReturnValue([])
  interrupt.mockReset().mockResolvedValue({ interrupted: true, processKept: true })
  send.mockReset().mockResolvedValue(undefined)
  userInputRequestManager.reset()
  for (const id of ['owner', 'member', 'viewer', 'stranger']) {
    testDb.insert(schema.user).values({ id, name: id, email: `${id}@test.example` }).run()
  }
  for (const agentSlug of ['shared-agent', 'other-agent']) {
    for (const role of ['owner', 'user', 'viewer'] as const) {
      const userId = role === 'user' ? 'member' : role
      testDb.insert(schema.agentAcl).values({
        id: `${agentSlug}-${userId}`, userId, agentSlug, role, createdAt: new Date(),
      }).run()
    }
  }
  account('old', 'owner', 'expired')
  account('mine', 'member')
  account('theirs', 'owner')
  mapping('shared-agent', 'old')
  mapping('other-agent', 'old')

  // Supply the authenticated context established by the parent agents router;
  // exercise the real AgentUser middleware and ownership SQL in the child route.
  app = new Hono<TestEnv>()
  app.use('/api/agents/:id/*', async (c, next) => {
    c.set('user', { id: currentUserId })
    c.set('agentId', c.req.param('id'))
    await next()
  })
  app.route('/api/agents', accountReauth)
})

afterEach(() => {
  accountReauthManager.rejectAll()
  userInputRequestManager.reset()
  sqlite.close()
})

describe('account reauthentication replacement', () => {
  it('interrupts the active session and sends the replacement ID through the system-message path', async () => {
    activeSessions.mockReturnValue(['running-session'])
    const request = park()
    const response = await replace(request.id)
    expect(await response.json()).toEqual({ success: true, liveRefresh: true, sessionNotification: true })
    expect(interrupt).toHaveBeenCalledWith('running-session', { scope: 'turn' })
    expect(send).toHaveBeenCalledWith('running-session',
      expect.stringContaining('[SYSTEM] Connection to "Slack" was replaced.'),
      expect.any(String), { shouldQuery: true })
    expect(send.mock.calls[0][1]).toContain('ID: mine.')
  })

  it('lets a shared-agent member replace an owner connection only for that agent', async () => {
    const oldRecord = testDb.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, 'old')).get()
    const request = park()
    const other = park('other-agent')
    const response = await replace(request.id)

    expect(response.status).toBe(200)
    expect(getReplacementAccountId(await request.settled)).toBe('mine')
    expect(mappedAccounts('shared-agent')).toEqual(['mine'])
    expect(mappedAccounts('other-agent')).toEqual(['old'])
    expect(testDb.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, 'old')).get()).toEqual(oldRecord)
    expect(userInputRequestManager.getOpenRequest(other.id)).not.toBeNull()
    expect(syncEnvironment).toHaveBeenCalledWith('shared-agent', 'connected-accounts', expect.objectContaining({ slug: 'shared-agent' }))
  })

  it.each(['viewer', 'stranger'])('rejects a %s through the real agent ACL check', async (userId) => {
    currentUserId = userId
    const request = park()
    expect((await replace(request.id)).status).toBe(403)
    expect(mappedAccounts('shared-agent')).toEqual(['old'])
    expect(userInputRequestManager.getOpenRequest(request.id)).not.toBeNull()
  })

  it('rejects a replacement owned by another user', async () => {
    const request = park()
    expect((await replace(request.id, ['theirs'])).status).toBe(404)
    expect(mappedAccounts('shared-agent')).toEqual(['old'])
    expect(userInputRequestManager.getOpenRequest(request.id)).not.toBeNull()
  })

  it.each([
    { status: 'expired' as const, toolkit: 'slack', expected: 409 },
    { status: 'active' as const, toolkit: 'gmail', expected: 400 },
  ])('rejects an incompatible replacement: $status $toolkit', async ({ status, toolkit, expected }) => {
    account('invalid', 'member', status, toolkit)
    const request = park()
    expect((await replace(request.id, ['invalid'])).status).toBe(expected)
    expect(mappedAccounts('shared-agent')).toEqual(['old'])
  })

  it('rejects cross-agent and already-settled requests without changing mappings', async () => {
    const request = park()
    expect((await replace(request.id, ['mine'], 'other-agent')).status).toBe(404)
    accountReauthManager.dismiss(request.id, 'shared-agent')
    expect((await replace(request.id)).status).toBe(404)
    expect(mappedAccounts('shared-agent')).toEqual(['old'])
    expect(mappedAccounts('other-agent')).toEqual(['old'])
  })

  it('rejects missing original mappings and multiple replacements', async () => {
    const request = park()
    expect((await replace(request.id, ['mine', 'theirs'])).status).toBe(400)
    testDb.delete(schema.agentConnectedAccounts)
      .where(eq(schema.agentConnectedAccounts.agentSlug, 'shared-agent')).run()
    expect((await replace(request.id)).status).toBe(409)
    expect(mappedAccounts('shared-agent')).toEqual([])
    expect(userInputRequestManager.getOpenRequest(request.id)).not.toBeNull()
  })

  it('accepts an already-assigned replacement without duplicating its mapping', async () => {
    mapping('shared-agent', 'mine')
    const request = park()
    expect((await replace(request.id)).status).toBe(200)
    expect(mappedAccounts('shared-agent')).toEqual(['mine'])
  })

  it('rolls back the replacement if removing the old mapping fails', async () => {
    sqlite.exec(`CREATE TRIGGER fail_unlink BEFORE DELETE ON agent_connected_accounts
      BEGIN SELECT RAISE(ABORT, 'test unlink failure'); END;`)
    const request = park()
    expect((await replace(request.id)).status).toBe(500)
    expect(mappedAccounts('shared-agent')).toEqual(['old'])
    expect(userInputRequestManager.getOpenRequest(request.id)).not.toBeNull()
    expect(syncEnvironment).not.toHaveBeenCalled()
  })

  it('releases the pending call and reports a failed metadata refresh', async () => {
    syncEnvironment.mockResolvedValue(false)
    const request = park()
    const response = await replace(request.id)
    expect(await response.json()).toEqual({ success: true, liveRefresh: false, sessionNotification: false })
    expect(getReplacementAccountId(await request.settled)).toBe('mine')
    expect(mappedAccounts('shared-agent')).toEqual(['mine'])
  })

  it('preserves single-user mode behavior without an account owner restriction', async () => {
    authMode = false
    const request = park()
    expect((await replace(request.id, ['theirs'])).status).toBe(200)
    expect(mappedAccounts('shared-agent')).toEqual(['theirs'])
  })
})
