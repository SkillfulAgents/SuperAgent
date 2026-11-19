import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: async (token: string) => (token === 'agent-token' ? 'agent' : token === 'other-token' ? 'other' : null),
}))

// Each agent's sessions, as its actor would answer for them.
interface FakeSession { name?: string; live?: 'active' | 'awaiting'; registeredOnly?: boolean }
const agents = vi.hoisted(() => ({ sessions: {} as Record<string, Record<string, FakeSession>>, renamed: [] as string[][] }))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (slug: string) => {
      const own = () => (agents.sessions[slug] ??= {})
      return {
        sessions: {
          readMetadata: async () => Object.fromEntries(Object.entries(own()).map(([id, { name }]) => [id, { name, createdByUserId: 'user-1' }])),
          isKnown: async (id: string) => Object.hasOwn(own(), id),
          exists: async (id: string) => Object.hasOwn(own(), id) && !own()[id].registeredOnly,
          isRegistered: async (id: string) => Object.hasOwn(own(), id),
          rename: async (id: string, name: string) => {
            own()[id].name = name
            agents.renamed.push([slug, id, name])
          },
          live: async (id: string) => ({ isActive: own()[id]?.live === 'active', isAwaitingInput: own()[id]?.live === 'awaiting' }),
        },
      }
    },
  },
}))
const deleted = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock('@shared/lib/services/session-deletion', () => ({
  deleteSessionAndRecords: async (slug: string, id: string) => {
    deleted.calls.push([slug, id])
    return delete agents.sessions[slug]?.[id]
  },
}))

const { default: router } = await import('./x-agent-sessions')
const app = new Hono().route('/api/x-agent/sessions', router)

const call = (method: string, path: string, body?: unknown, token: string | null = 'agent-token') =>
  app.request(`/api/x-agent/sessions${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

beforeEach(() => {
  agents.sessions = {
    agent: { s1: { name: 'Quarterly numbers' }, s2: {}, running: { name: 'In progress', live: 'active' }, waiting: { live: 'awaiting' }, pending: { name: 'Not started', registeredOnly: true } },
    other: { s1: { name: 'Another agent\'s session' }, theirs: { name: 'Private' } },
  }
  agents.renamed = []
  deleted.calls = []
})

describe('authentication', () => {
  it('refuses every route without a valid agent token', async () => {
    for (const [method, path, body] of [['GET', ''], ['PATCH', '/s1', { name: 'X' }], ['DELETE', '/s1']] as const) {
      expect((await call(method, path, body, null)).status).toBe(401)
      expect((await call(method, path, body, 'stale')).status).toBe(401)
    }
    expect(agents.renamed).toEqual([])
    expect(deleted.calls).toEqual([])
  })
})

describe('GET /', () => {
  it('answers the names of the caller\'s own sessions, and nothing else about them', async () => {
    const res = await call('GET', '')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      names: { s1: 'Quarterly numbers', running: 'In progress', pending: 'Not started' },
    })
  })

  it('answers each agent its own', async () => {
    expect(await (await call('GET', '', undefined, 'other-token')).json()).toEqual({
      names: { s1: 'Another agent\'s session', theirs: 'Private' },
    })
  })
})

describe('PATCH /:sessionId', () => {
  it('renames one of the caller\'s sessions through the actor', async () => {
    const res = await call('PATCH', '/s2', { name: '  Pricing decision  ' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 's2', name: 'Pricing decision' })
    expect(agents.renamed).toEqual([['agent', 's2', 'Pricing decision']])
  })

  it('renames a session that is running', async () => {
    expect((await call('PATCH', '/running', { name: 'Renamed mid-turn' })).status).toBe(200)
  })

  it('answers 404 for a session that is not the caller\'s, and leaves the other agent\'s alone', async () => {
    const res = await call('PATCH', '/theirs', { name: 'Taken over' })

    expect(res.status).toBe(404)
    expect(agents.renamed).toEqual([])
    expect(agents.sessions.other.theirs.name).toBe('Private')
  })

  it('renames only its own session when another agent has one with the same id', async () => {
    await call('PATCH', '/s1', { name: 'Mine, renamed' })

    expect(agents.sessions.agent.s1.name).toBe('Mine, renamed')
    expect(agents.sessions.other.s1.name).toBe('Another agent\'s session')
  })

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name that is too long', { name: 'x'.repeat(201) }],
    ['a name that is not text', { name: 42 }],
    ['no name', {}],
    ['a field that is not the name', { name: 'Fine', createdByUserId: 'someone-else' }],
    ['a field that is not the name', { name: 'Fine', isScheduledExecution: false }],
    ['a body that is not JSON', '{ not json'],
  ])('refuses %s and renames nothing', async (_what, body) => {
    expect((await call('PATCH', '/s1', body)).status).toBe(400)
    expect(agents.renamed).toEqual([])
  })
})

describe('DELETE /:sessionId', () => {
  it('deletes one of the caller\'s sessions, with what the host keeps about it', async () => {
    const res = await call('DELETE', '/s1')

    expect(res.status).toBe(204)
    expect(deleted.calls).toEqual([['agent', 's1']])
    expect(agents.sessions.other.s1).toBeDefined()
  })

  it('deletes a registration that never got a transcript', async () => {
    expect((await call('DELETE', '/pending')).status).toBe(204)
    expect(deleted.calls).toEqual([['agent', 'pending']])
  })

  it.each([['running', 'the session it is running in, or any other running one'], ['waiting', 'a session waiting for a person']])(
    'refuses to delete %s: %s',
    async (id) => {
      const res = await call('DELETE', `/${id}`)

      expect(res.status).toBe(409)
      expect(deleted.calls).toEqual([])
      expect(agents.sessions.agent[id]).toBeDefined()
    },
  )

  it('answers 404 for a session that is not the caller\'s, and deletes nothing', async () => {
    expect((await call('DELETE', '/theirs')).status).toBe(404)
    expect((await call('DELETE', '/never-existed')).status).toBe(404)
    expect(deleted.calls).toEqual([])
    expect(agents.sessions.other.theirs).toBeDefined()
  })
})
