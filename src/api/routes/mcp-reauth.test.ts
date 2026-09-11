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
const syncEnvironment = vi.fn()
const activeSessions = vi.fn<() => string[]>()
const interrupt = vi.fn()
const send = vi.fn()
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => true }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => currentUserId }))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    syncAgentSessionsAwaiting: vi.fn(), getActiveSessionIdsForAgent: () => activeSessions(),
    isSessionActive: () => true, getTurnGeneration: () => 3, markSessionInterrupted: vi.fn(),
    withSessionSend: async (_agent: string, _session: string, _client: unknown, deliver: () => Promise<void>) => deliver(),
  },
}))
vi.mock('@shared/lib/container/container-host', () => ({
  containerHost: {
    runtime: () => ({
      slug: 'shared-agent',
      getCachedInfo: () => ({ status: 'running' }),
      getClient: () => ({ interruptSession: interrupt, sendMessage: send }),
    }),
  },
}))
vi.mock('@shared/lib/container/connection-runtime-sync', () => ({
  syncAgentConnectionEnvironment: (...args: unknown[]) => syncEnvironment(...args),
}))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/platform-attribution', () => ({}))
vi.mock('@shared/lib/utils/file-storage', () => ({ resolveAgentId: vi.fn() }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn() }))

import mcpReauth from './mcp-reauth'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { getReplacementMcpId } from '@shared/lib/proxy/mcp-replacement'

type TestEnv = { Variables: { user: { id: string }; agentId: string } }
let app: Hono<TestEnv>
const oldUrl = 'https://custom-mcp.example/mcp?token=private-owner-token'
const newUrl = 'https://custom-mcp.example/mcp?token=member-token'

function mcp(id: string, userId: string, status: 'active' | 'auth_required' = 'active', url = newUrl) {
  testDb.insert(schema.remoteMcpServers).values({
    id, userId, status, url, name: 'Custom MCP', authType: 'oauth',
    accessToken: `secret-${id}`, createdAt: new Date(), updatedAt: new Date(),
  }).run()
}
function mapping(agentSlug: string, remoteMcpId: string) {
  testDb.insert(schema.agentRemoteMcps).values({
    id: `${agentSlug}-${remoteMcpId}`, agentSlug, remoteMcpId, createdAt: new Date(),
  }).run()
}
function mapped(agentSlug: string) {
  return testDb.select().from(schema.agentRemoteMcps).where(eq(schema.agentRemoteMcps.agentSlug, agentSlug)).all()
    .map((row) => row.remoteMcpId).sort()
}
function park(agentSlug = 'shared-agent') {
  const settled = mcpReauthManager.requestReauth({ agentSlug, mcpId: 'old', mcpName: 'Custom MCP', authType: 'oauth' })
    .catch((error: unknown) => error)
  const [request] = userInputRequestManager.getAgentScopedRequests(agentSlug)
  return { id: request.id, settled }
}
function url(requestId: string, agentSlug = 'shared-agent') {
  return `/api/agents/${agentSlug}/reauth-request/${requestId}/replace-mcp`
}
function replace(requestId: string, remoteMcpIds = ['mine'], agentSlug = 'shared-agent') {
  return app.request(url(requestId, agentSlug), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remoteMcpIds }),
  })
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  currentUserId = 'member'
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
      testDb.insert(schema.agentAcl).values({ id: `${agentSlug}-${userId}`, userId, agentSlug, role, createdAt: new Date() }).run()
    }
  }
  mcp('old', 'owner', 'auth_required', oldUrl)
  mcp('mine', 'member')
  mcp('theirs', 'owner')
  mapping('shared-agent', 'old')
  mapping('other-agent', 'old')
  app = new Hono<TestEnv>()
  app.use('/api/agents/:id/*', async (c, next) => {
    c.set('user', { id: currentUserId })
    c.set('agentId', c.req.param('id'))
    await next()
  })
  app.route('/api/agents', mcpReauth)
})
afterEach(() => {
  mcpReauthManager.rejectAll()
  userInputRequestManager.reset()
  sqlite.close()
})

describe('MCP connection replacement', () => {
  it('interrupts the active session and sends the replacement ID through the system-message path', async () => {
    activeSessions.mockReturnValue(['running-session'])
    const request = park()
    const response = await replace(request.id)
    expect(await response.json()).toEqual({ success: true, liveRefresh: true, sessionNotification: true })
    expect(interrupt).toHaveBeenCalledWith('running-session', { scope: 'turn' })
    expect(send).toHaveBeenCalledWith('running-session',
      expect.stringContaining('[SYSTEM] Connection to "Custom MCP" was replaced.'),
      expect.any(String), { shouldQuery: true })
    expect(send.mock.calls[0][1]).toContain('ID: mine.')
  })

  it('replaces only the shared agent mapping and refreshes before releasing the parked calls', async () => {
    const original = testDb.select().from(schema.remoteMcpServers).where(eq(schema.remoteMcpServers.id, 'old')).get()
    const request = park()
    const other = park('other-agent')
    syncEnvironment.mockImplementation(async () => {
      expect(mapped('shared-agent')).toEqual(['mine'])
      expect(userInputRequestManager.getOpenRequest(request.id)).not.toBeNull()
      return true
    })
    expect((await replace(request.id)).status).toBe(200)
    expect(getReplacementMcpId(await request.settled)).toBe('mine')
    expect(mapped('other-agent')).toEqual(['old'])
    expect(testDb.select().from(schema.remoteMcpServers).where(eq(schema.remoteMcpServers.id, 'old')).get()).toEqual(original)
    expect(userInputRequestManager.getOpenRequest(other.id)).not.toBeNull()
    expect(syncEnvironment).toHaveBeenCalledWith('shared-agent', 'remote-mcps', expect.objectContaining({ slug: 'shared-agent' }))
  })

  it('prefills with the member URL and never returns the original private URL', async () => {
    const request = park()
    const response = await app.request(url(request.id))
    expect(await response.json()).toEqual({ url: newUrl })
    testDb.delete(schema.remoteMcpServers).where(eq(schema.remoteMcpServers.id, 'mine')).run()
    expect(await (await app.request(url(request.id))).json()).toEqual({ url: '' })
  })

  it.each(['viewer', 'stranger'])('rejects a %s through the real agent ACL', async (userId) => {
    const request = park()
    currentUserId = userId
    expect((await app.request(url(request.id))).status).toBe(403)
    expect((await replace(request.id)).status).toBe(403)
    expect(mapped('shared-agent')).toEqual(['old'])
  })

  it('rejects another user’s replacement and cross-agent requests', async () => {
    const request = park()
    expect((await replace(request.id, ['theirs'])).status).toBe(404)
    expect((await replace(request.id, ['mine'], 'other-agent')).status).toBe(404)
    expect((await app.request(url(request.id, 'other-agent'))).status).toBe(404)
    expect(mapped('shared-agent')).toEqual(['old'])
  })

  it.each([
    { status: 'auth_required' as const, endpoint: newUrl, expected: 409 },
    { status: 'active' as const, endpoint: 'https://different.example/mcp', expected: 400 },
    { status: 'active' as const, endpoint: 'https://custom-mcp.example/other', expected: 400 },
  ])('rejects an incompatible connection: $status $endpoint', async ({ status, endpoint, expected }) => {
    mcp('invalid', 'member', status, endpoint)
    const request = park()
    expect((await replace(request.id, ['invalid'])).status).toBe(expected)
    expect(mapped('shared-agent')).toEqual(['old'])
    expect(userInputRequestManager.getOpenRequest(request.id)).not.toBeNull()
  })

  it('rejects stale cards and multiple replacements', async () => {
    const request = park()
    expect((await replace(request.id, ['mine', 'theirs'])).status).toBe(400)
    mcpReauthManager.dismiss(request.id, 'shared-agent')
    expect((await replace(request.id)).status).toBe(404)
    expect(mapped('shared-agent')).toEqual(['old'])
  })

  it('accepts an already assigned replacement without duplicating the mapping', async () => {
    mapping('shared-agent', 'mine')
    const request = park()
    expect((await replace(request.id)).status).toBe(200)
    expect(mapped('shared-agent')).toEqual(['mine'])
  })

  it('rolls back the mapping swap if unlink fails', async () => {
    sqlite.exec(`CREATE TRIGGER fail_unlink BEFORE DELETE ON agent_remote_mcps BEGIN SELECT RAISE(ABORT, 'test unlink failure'); END;`)
    const request = park()
    expect((await replace(request.id)).status).toBe(500)
    expect(mapped('shared-agent')).toEqual(['old'])
    expect(userInputRequestManager.getOpenRequest(request.id)).not.toBeNull()
    expect(syncEnvironment).not.toHaveBeenCalled()
  })
})
