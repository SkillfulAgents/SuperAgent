/**
 * ResolveAgent() and the agent role middlewares against a real database: a
 * member's request reads the agent and their role on it in one statement, and
 * who is let in is what two statements decided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

let authMode = true
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode }))

// The session is whoever the `x-test-user` header names: this file is about what follows it.
const users: Record<string, { id: string; role?: string }> = {
  member: { id: 'member' },
  viewer: { id: 'viewer' },
  outsider: { id: 'outsider' },
  admin: { id: 'admin', role: 'admin' },
}
vi.mock('@shared/lib/auth/index', () => ({
  getAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const user = users[headers.get('x-test-user') ?? '']
        return { response: user ? { user, session: { id: `session-${user.id}`, userId: user.id } } : null, headers: new Headers() }
      },
    },
  }),
}))
vi.mock('@shared/lib/meeting-integrations/participant-credential', () => ({
  authenticateMeetingParticipant: async (cookie: string | undefined) =>
    cookie === 'participant' ? { userId: 'member', agentSlug: AGENT, sessionId: 'meeting-session' } : null,
  meetingParticipantMayRequest: () => true,
}))

import { Authenticated, AgentAdmin, AgentRead, AgentUser, ResolveAgent, getAgentId, getAuthorizedAgentRole, getResolvedAgent } from './auth'

const AGENT = 'a1b2c3d4e5'
const OTHER_AGENT = 'f6g7h8i9j0'

function app(): Hono {
  const api = new Hono()
  api.use('*', Authenticated())
  api.use('/agents/:id/*', ResolveAgent())
  const answer: MiddlewareHandler = async (c) =>
    c.json({ id: getAgentId(c), name: getResolvedAgent(c).name, role: getAuthorizedAgentRole(c) })
  api.get('/agents/:id', ResolveAgent(), AgentRead(), answer)
  api.get('/agents/:id/read', AgentRead(), answer)
  api.get('/agents/:id/use', AgentUser(), answer)
  api.get('/agents/:id/admin', AgentAdmin(), answer)
  return api
}

function request(path: string, user: string | null, headers: Record<string, string> = {}) {
  return app().request(path, { headers: { ...(user ? { 'x-test-user': user } : {}), ...headers } })
}

beforeEach(async () => {
  authMode = true
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(schema.agents).values([
    { slug: AGENT, name: 'Sales', createdAt: new Date(0), runtime: 'local' },
    { slug: OTHER_AGENT, name: 'Research', createdAt: new Date(0), runtime: 'local' },
  ]).run()
  await testDb.insert(schema.user).values(Object.values(users).map(({ id }) => ({ id, name: id, email: `${id}@example.test` }))).run()
  await testDb.insert(schema.agentAcl).values([
    { id: 'acl-1', userId: 'member', agentSlug: AGENT, role: 'user', createdAt: new Date(0) },
    { id: 'acl-2', userId: 'viewer', agentSlug: AGENT, role: 'viewer', createdAt: new Date(0) },
    { id: 'acl-3', userId: 'outsider', agentSlug: OTHER_AGENT, role: 'owner', createdAt: new Date(0) },
  ]).run()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('a member on an agent route', () => {
  it('reads the agent and their role in one statement', async () => {
    const select = vi.spyOn(testDb, 'select')

    const response = await request(`/agents/sales-${AGENT}/use`, 'member')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: AGENT, name: 'Sales', role: 'user' })
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('reads it once when the route lists ResolveAgent() again', async () => {
    const select = vi.spyOn(testDb, 'select')

    const response = await request(`/agents/${AGENT}`, 'viewer')

    expect(await response.json()).toEqual({ id: AGENT, name: 'Sales', role: 'viewer' })
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('is refused in the same single statement when their role is too low or absent', async () => {
    const select = vi.spyOn(testDb, 'select')

    expect((await request(`/agents/${AGENT}/use`, 'viewer')).status).toBe(403)
    expect((await request(`/agents/${AGENT}/admin`, 'member')).status).toBe(403)
    expect((await request(`/agents/${AGENT}/read`, 'outsider')).status).toBe(403)
    expect(select).toHaveBeenCalledTimes(3)
  })
})

describe('who is let in', () => {
  it.each([
    ['member', 'read', 200], ['member', 'use', 200], ['member', 'admin', 403],
    ['viewer', 'read', 200], ['viewer', 'use', 403], ['viewer', 'admin', 403],
    ['outsider', 'read', 403], ['outsider', 'use', 403], ['outsider', 'admin', 403],
    ['admin', 'read', 200], ['admin', 'use', 200], ['admin', 'admin', 200],
  ] as const)('%s on /%s is %i', async (user, route, status) => {
    expect((await request(`/agents/${AGENT}/${route}`, user)).status).toBe(status)
    expect((await request(`/agents/sales-${AGENT}/${route}`, user)).status).toBe(status)
  })

  it('keeps one agent\'s role off another', async () => {
    const response = await request(`/agents/${OTHER_AGENT}/admin`, 'outsider')
    expect(await response.json()).toEqual({ id: OTHER_AGENT, name: 'Research', role: 'owner' })
    expect((await request(`/agents/${OTHER_AGENT}/read`, 'member')).status).toBe(403)
  })

  it('answers 404 for an agent that does not exist, whoever asks', async () => {
    for (const user of ['member', 'outsider', 'admin']) {
      expect((await request('/agents/sales-zzzzzzzzzz/read', user)).status).toBe(404)
    }
  })

  it('answers 401 without a session, before any agent is read', async () => {
    const select = vi.spyOn(testDb, 'select')
    expect((await request(`/agents/${AGENT}/read`, null)).status).toBe(401)
    expect(select).not.toHaveBeenCalled()
  })

  it('reads an admin\'s agent without a role, as owner', async () => {
    const select = vi.spyOn(testDb, 'select')
    const leftJoin = vi.fn()
    select.mockImplementation(((...args: []) => {
      const builder = Object.getPrototypeOf(testDb).select.apply(testDb, args)
      const from = builder.from.bind(builder)
      builder.from = (table: never) => {
        const query = from(table)
        const join = query.leftJoin.bind(query)
        query.leftJoin = (...joinArgs: [never, never]) => { leftJoin(); return join(...joinArgs) }
        return query
      }
      return builder
    }) as never)

    const response = await request(`/agents/${AGENT}/admin`, 'admin')

    expect(await response.json()).toEqual({ id: AGENT, name: 'Sales', role: 'owner' })
    expect(select).toHaveBeenCalledTimes(1)
    expect(leftJoin).not.toHaveBeenCalled()
  })

  it('confines a meeting participant to its agent without reading a role', async () => {
    const select = vi.spyOn(testDb, 'select')

    const own = await request(`/agents/${AGENT}/use`, null, { cookie: 'participant' })
    expect(await own.json()).toEqual({ id: AGENT, name: 'Sales', role: 'user' })
    expect((await request(`/agents/${AGENT}/admin`, null, { cookie: 'participant' })).status).toBe(403)
    expect((await request(`/agents/${OTHER_AGENT}/read`, null, { cookie: 'participant' })).status).toBe(403)
    expect(select).toHaveBeenCalledTimes(3)
  })

  it('lets everyone in as owner outside auth mode, with one read of the agent', async () => {
    authMode = false
    const select = vi.spyOn(testDb, 'select')

    const response = await request(`/agents/sales-${AGENT}/admin`, null)

    expect(await response.json()).toEqual({ id: AGENT, name: 'Sales', role: 'owner' })
    expect(select).toHaveBeenCalledTimes(1)
  })
})

describe('a role middleware with no ResolveAgent() in front', () => {
  it('reads the role itself', async () => {
    const api = new Hono()
    api.use('*', Authenticated())
    api.get('/bare/:id', AgentUser(), (c) => c.json({ role: getAuthorizedAgentRole(c) }))
    const select = vi.spyOn(testDb, 'select')

    const allowed = await api.request(`/bare/${AGENT}`, { headers: { 'x-test-user': 'member' } })
    expect(await allowed.json()).toEqual({ role: 'user' })
    expect((await api.request(`/bare/${AGENT}`, { headers: { 'x-test-user': 'viewer' } })).status).toBe(403)
    expect(select).toHaveBeenCalledTimes(2)
  })
})
