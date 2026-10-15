import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

// A meeting bot's page carries the participant cookie instead of a session.
// These tests pin what that credential may and may not reach.
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => true }))
const mockGetSession = vi.fn(async () => null)
vi.mock('@shared/lib/auth/index', () => ({ getAuth: () => ({ api: { getSession: mockGetSession } }) }))
const participant = vi.hoisted(() => ({ value: null as null | { meetingId: string; agentSlug: string; sessionId: string; userId: string }, cookie: '' }))
vi.mock('@shared/lib/meeting-integrations/participant-credential', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/meeting-integrations/participant-credential')>()),
  authenticateMeetingParticipant: async (cookie: string | undefined) => { participant.cookie = cookie ?? ''; return participant.value },
}))
vi.mock('@shared/lib/db', () => ({ db: { select: () => { throw new Error('ACL must not be consulted for a participant') } } }))
vi.mock('@shared/lib/db/schema', () => ({ agentAcl: {}, connectedAccounts: {}, remoteMcpServers: {}, notifications: {} }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: async () => null }))
const attributed: string[] = []
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithRequestUser: (userId: string, fn: () => unknown) => { attributed.push(userId); return fn() },
  runWithOptionalUser: (_userId: string | null | undefined, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/services/agent-owner', () => ({ getAgentOwnerUserId: () => null }))
vi.mock('@shared/lib/agent-actor/agent-catalog', () => ({ agentCatalog: { resolve: async (slug: string) => slug === 'missing' ? null : slug } }))

import { Authenticated, AgentAdmin, AgentRead, AgentUser, EntityAgentRole, IsAdmin, OwnsAccount, ResolveAgent, getAuthorizedAgentRole, getMeetingParticipant } from './auth'

const TaskRole = EntityAgentRole({ paramName: 'taskId', lookupFn: async () => ({ agentSlug: 'research' }), contextKey: 'task', entityName: 'Task' })

function app() {
  const api = new Hono()
  api.use('*', Authenticated())
  const me = (c: { get: (key: never) => unknown }) => ({ user: (c.get('user' as never) as { id: string }).id })
  // What the participant page uses: its agent's session, files and browser view, and the voice routes.
  api.get('/api/agents/:id/files/*', ResolveAgent(), AgentRead(), c => c.json({ role: getAuthorizedAgentRole(c), participant: getMeetingParticipant(c)?.meetingId }))
  api.post('/api/agents/:id/sessions/:sessionId/messages', ResolveAgent(), AgentUser(), c => c.json({ ok: true }))
  api.get('/api/agents/:id/browser/status', ResolveAgent(), AgentRead(), c => c.json({ ok: true }))
  api.post('/api/voice/live/agents/:id/session', ResolveAgent(), AgentUser(), c => c.json(me(c)))
  api.get('/api/voice/configured', c => c.json(me(c)))
  // Routes under the same prefixes that grant by account rather than agent role.
  api.get('/api/agents/:id/sessions/:sessionId/browser-credentials', ResolveAgent(), IsAdmin(), c => c.json({ ok: true }))
  api.get('/api/agents/:id/sessions/:sessionId/tasks/:taskId', ResolveAgent(), TaskRole('viewer'), c => c.json({ ok: true }))
  api.delete('/api/agents/:id', ResolveAgent(), AgentAdmin(), c => c.json({ ok: true }))
  // The rest of the app.
  api.get('/api/me', c => c.json(me(c)))
  api.post('/api/agents', c => c.json(me(c)))
  api.get('/api/agents/my-roles', c => c.json(me(c)))
  api.get('/api/connected-accounts/:id', OwnsAccount(), c => c.json({ ok: true }))
  return api
}
const scope = { meetingId: 'm1', agentSlug: 'research', sessionId: 's1', userId: 'alice' }
const cookie = { headers: { cookie: 'gamut_meeting_participant=m1.tok' } }

describe('meeting participant credential through the auth middlewares', () => {
  beforeEach(() => { vi.clearAllMocks(); attributed.length = 0; participant.value = scope; participant.cookie = '' })

  it('stands in for the meeting owner on the voice routes the page needs, with the owner attributed', async () => {
    const res = await app().request('/api/voice/configured', cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: 'alice' })
    expect(participant.cookie).toBe('gamut_meeting_participant=m1.tok')
    expect(attributed).toEqual(['alice'])
    expect((await app().request('/api/voice/live/agents/research/session', { method: 'POST' })).status).toBe(200)
  })
  it('is only consulted after the session check fails', async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 'bob' }, session: {} } as never)
    const res = await app().request('/api/me')
    expect(await res.json()).toEqual({ user: 'bob' })
    expect(participant.cookie).toBe('')
  })
  it('reads and writes within its own agent and session as a user, without an ACL lookup', async () => {
    const read = await app().request('/api/agents/research/files/output/chart.png')
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ role: 'user', participant: 'm1' })
    expect((await app().request('/api/agents/research/sessions/s1/messages', { method: 'POST' })).status).toBe(200)
    expect((await app().request('/api/agents/research/browser/status')).status).toBe(200)
  })
  it('is refused for another agent, another session, or owner-level operations', async () => {
    expect((await app().request('/api/agents/other/files/x')).status).toBe(403)
    expect((await app().request('/api/agents/research/sessions/s2/messages', { method: 'POST' })).status).toBe(403)
    expect((await app().request('/api/agents/research', { method: 'DELETE' })).status).toBe(403)
  })
  it('never reaches the rest of the app as the owner', async () => {
    for (const [path, method] of [['/api/me', 'GET'], ['/api/agents', 'POST'], ['/api/agents/my-roles', 'GET'], ['/api/connected-accounts/acc', 'GET']] as const) {
      const res = await app().request(path, { method, ...cookie })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    expect(attributed).toEqual([])
  })
  it('is refused by grants that go by account even on routes it may reach', async () => {
    expect((await app().request('/api/agents/research/sessions/s1/browser-credentials')).status).toBe(403)
    expect((await app().request('/api/agents/research/sessions/s1/tasks/t1')).status).toBe(403)
  })
  it('answers 401 with the session challenge when neither a session nor a valid cookie is present', async () => {
    participant.value = null
    const res = await app().request('/api/agents/research/files/x', { headers: { cookie: 'gamut_meeting_participant=m1.stale' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBeTruthy()
  })
})
