import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

const state = vi.hoisted(() => ({
  db: null as TestDatabase['db'] | null,
  experimentOn: new Set<string>(),
  agents: new Set<string>(),
  // user → agents they can read
  readable: new Map<string, Set<string>>(),
  sessions: new Map<string, { isActive: boolean; isAwaitingInput: boolean }>(),
  requests: new Map<string, { kind: string; blocking: boolean; autoApproved: boolean }[]>(),
}))

vi.mock('@shared/lib/db', () => ({ get db() { return state.db } }))
vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: (c: Context) => (c.get('user' as never) as { id: string }).id,
}))
vi.mock('../middleware/auth', () => ({
  Authenticated: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-User')
    if (!id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user' as never, { id } as never)
    return next()
  },
  getReadableAgentIds: async (c: Context, ids: readonly string[]) => {
    const mine = state.readable.get((c.get('user' as never) as { id: string }).id) ?? new Set()
    return new Set(ids.filter((id) => mine.has(id)))
  },
}))
vi.mock('@shared/lib/services/user-settings-service', () => ({
  isExperimentEnabled: async (userId: string, id: string) => id === 'todo-board' && state.experimentOn.has(userId),
}))
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: async (slug: string) => state.agents.has(slug),
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      sessions: {
        isKnown: async (id: string) => state.sessions.has(`${slug}/${id}`),
        isActive: (id: string) => state.sessions.get(`${slug}/${id}`)?.isActive ?? false,
        isAwaitingInput: (id: string) => state.sessions.get(`${slug}/${id}`)?.isAwaitingInput ?? false,
      },
      inputs: { snapshot: (id: string) => state.requests.get(`${slug}/${id}`) ?? [] },
    }),
  },
}))

import todosRouter from './todos'

const app = new Hono().route('/api/todos', todosRouter)
let database: TestDatabase

function call(path: string, method = 'GET', body?: unknown, user = 'alice') {
  return app.request(`/api/todos${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Test-User': user },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function createDraft(body: Record<string, unknown> = { title: 'Write the report' }, user = 'alice') {
  const res = await call('', 'POST', body, user)
  expect(res.status).toBe(201)
  return res.json()
}

async function startDraft(agentSlug = 'agent-a', sessionId = 'session-1') {
  const draft = await createDraft({ title: 'Write the report', agentSlug })
  state.sessions.set(`${agentSlug}/${sessionId}`, { isActive: true, isAwaitingInput: false })
  const { claim } = await (await call(`/${draft.id}/claim`, 'POST', {})).json()
  const res = await call(`/${draft.id}/start`, 'POST', { sessionId, claim })
  expect(res.status).toBe(200)
  return res.json()
}

beforeEach(async () => {
  database = await createTestDatabase()
  state.db = database.db
  state.experimentOn = new Set(['alice', 'bob'])
  state.agents = new Set(['agent-a', 'agent-b'])
  state.readable = new Map([['alice', new Set(['agent-a', 'agent-b'])], ['bob', new Set(['agent-a'])]])
  state.sessions = new Map()
  state.requests = new Map()
})

afterEach(async () => {
  await database.close()
})

describe('the experiment gate', () => {
  it('hides every endpoint from someone who has not turned it on', async () => {
    state.experimentOn.delete('alice')
    expect((await call('')).status).toBe(404)
    expect((await call('', 'POST', { title: 'x' })).status).toBe(404)
  })
})

describe('drafts', () => {
  it('creates, lists and edits a draft', async () => {
    const draft = await createDraft({ title: 'Write the report', description: 'Q3 numbers', agentSlug: 'agent-a' })
    expect(draft).toMatchObject({ status: 'draft', column: 'drafts', agentSlug: 'agent-a', sessionId: null })

    const edited = await call(`/${draft.id}`, 'PATCH', { description: 'Q3 and Q4 numbers' })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({ description: 'Q3 and Q4 numbers' })

    const list = await (await call('')).json()
    expect(list.todos).toHaveLength(1)
    expect(list.todos[0]).toMatchObject({ id: draft.id, description: 'Q3 and Q4 numbers' })
  })

  it('refuses an empty draft and unknown fields', async () => {
    expect((await call('', 'POST', { title: '  ', description: '' })).status).toBe(400)
    expect((await call('', 'POST', { title: 'x', status: 'done' })).status).toBe(400)
  })

  it('accepts a draft with only a description', async () => {
    expect((await call('', 'POST', { title: '', description: 'Look into churn' })).status).toBe(201)
  })

  it('assigns only agents that exist and the person can see', async () => {
    expect((await call('', 'POST', { title: 'x', agentSlug: 'ghost' })).status).toBe(404)
    expect((await call('', 'POST', { title: 'x', agentSlug: 'agent-b' }, 'bob')).status).toBe(404)
    const draft = await createDraft({ title: 'x' }, 'bob')
    expect((await call(`/${draft.id}`, 'PATCH', { agentSlug: 'agent-b' }, 'bob')).status).toBe(404)
  })

  it('keeps each person\'s board to themselves', async () => {
    const draft = await createDraft()
    expect((await (await call('', 'GET', undefined, 'bob')).json()).todos).toEqual([])
    expect((await call(`/${draft.id}`, 'PATCH', { title: 'mine now' }, 'bob')).status).toBe(404)
    expect((await call(`/${draft.id}`, 'DELETE', undefined, 'bob')).status).toBe(404)
  })

  it('deletes a draft', async () => {
    const draft = await createDraft()
    expect((await call(`/${draft.id}`, 'DELETE')).status).toBe(204)
    expect((await (await call('')).json()).todos).toEqual([])
  })
})

describe('starting', () => {
  it('links the session the agent was started in', async () => {
    const todo = await startDraft()
    expect(todo).toMatchObject({ status: 'active', column: 'working', agentSlug: 'agent-a', sessionId: 'session-1' })
  })

  it('needs an agent on the draft', async () => {
    const draft = await createDraft()
    expect((await call(`/${draft.id}/claim`, 'POST', {})).status).toBe(409)
  })

  it('claims only for an agent the person can still see', async () => {
    const draft = await createDraft({ title: 'x', agentSlug: 'agent-a' })
    state.readable.get('alice')!.delete('agent-a')
    expect((await call(`/${draft.id}/claim`, 'POST', {})).status).toBe(404)
  })

  it('lets one start claim a draft: a second tab is refused before it makes a session', async () => {
    const draft = await createDraft({ title: 'x', agentSlug: 'agent-a' })
    const claims = await Promise.all([call(`/${draft.id}/claim`, 'POST', {}), call(`/${draft.id}/claim`, 'POST', {})])
    expect(claims.map((r) => r.status).sort()).toEqual([200, 409])
    const listed = (await (await call('')).json()).todos[0]
    expect(listed).toMatchObject({ id: draft.id, starting: true })
  })

  it('a released claim lets the draft be started again', async () => {
    const draft = await createDraft({ title: 'x', agentSlug: 'agent-a' })
    const { claim } = await (await call(`/${draft.id}/claim`, 'POST', {})).json()
    expect((await call(`/${draft.id}/release`, 'POST', { claim })).status).toBe(204)
    expect((await (await call('')).json()).todos[0].starting).toBe(false)
    expect((await call(`/${draft.id}/claim`, 'POST', {})).status).toBe(200)
  })

  it('refuses a session the agent does not have', async () => {
    const draft = await createDraft({ title: 'x', agentSlug: 'agent-a' })
    const { claim } = await (await call(`/${draft.id}/claim`, 'POST', {})).json()
    state.sessions.set('agent-b/session-1', { isActive: true, isAwaitingInput: false })
    expect((await call(`/${draft.id}/start`, 'POST', { sessionId: 'session-1', claim })).status).toBe(404)
  })

  it('refuses a link without the claim', async () => {
    const draft = await createDraft({ title: 'x', agentSlug: 'agent-a' })
    await call(`/${draft.id}/claim`, 'POST', {})
    state.sessions.set('agent-a/session-1', { isActive: true, isAwaitingInput: false })
    expect((await call(`/${draft.id}/start`, 'POST', { sessionId: 'session-1', claim: 'guess' })).status).toBe(409)
    expect((await call(`/${draft.id}/start`, 'POST', { sessionId: 'session-1' })).status).toBe(400)
  })

  it('refuses to start twice', async () => {
    const todo = await startDraft()
    expect((await call(`/${todo.id}/claim`, 'POST', {})).status).toBe(409)
  })

  it('a started item is no longer editable as a draft', async () => {
    const todo = await startDraft()
    expect((await call(`/${todo.id}`, 'PATCH', { title: 'changed' })).status).toBe(409)
  })
})

describe('adding a session that already exists', () => {
  it('puts an idle session on the board as an item with updates', async () => {
    state.sessions.set('agent-a/session-1', { isActive: false, isAwaitingInput: false })
    const res = await call('/sessions', 'POST', { title: 'Quarterly report', agentSlug: 'agent-a', sessionId: 'session-1' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ title: 'Quarterly report', status: 'active', column: 'has_updates', sessionId: 'session-1' })
  })

  it('puts a working session in Working', async () => {
    state.sessions.set('agent-a/session-1', { isActive: true, isAwaitingInput: false })
    const res = await call('/sessions', 'POST', { title: 'Quarterly report', agentSlug: 'agent-a', sessionId: 'session-1' })
    expect(res.status).toBe(201)
    expect((await res.json()).column).toBe('working')
  })

  it('adds a session once: adding it again returns the item already on the board', async () => {
    state.sessions.set('agent-a/session-1', { isActive: false, isAwaitingInput: false })
    const body = { title: 'Quarterly report', agentSlug: 'agent-a', sessionId: 'session-1' }
    const [first, second] = await Promise.all([call('/sessions', 'POST', body), call('/sessions', 'POST', body)])
    expect([first.status, second.status].sort()).toEqual([200, 201])
    expect((await first.json()).id).toBe((await second.json()).id)
    expect((await (await call('')).json()).todos).toHaveLength(1)
  })

  it('returns a started item already on the board, in whatever column it is', async () => {
    const started = await startDraft()
    await call(`/${started.id}/status`, 'POST', { status: 'done' })
    const res = await call('/sessions', 'POST', { title: 'Another title', agentSlug: 'agent-a', sessionId: 'session-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: started.id, title: 'Write the report', status: 'done' })
  })

  it('lets two people each put the same session on their own board', async () => {
    state.sessions.set('agent-a/session-1', { isActive: false, isAwaitingInput: false })
    const body = { title: 'Quarterly report', agentSlug: 'agent-a', sessionId: 'session-1' }
    expect((await call('/sessions', 'POST', body, 'alice')).status).toBe(201)
    expect((await call('/sessions', 'POST', body, 'bob')).status).toBe(201)
  })

  it('refuses a session the agent does not have, or of an agent the person cannot see', async () => {
    expect((await call('/sessions', 'POST', { title: 'Report', agentSlug: 'agent-a', sessionId: 'missing' })).status).toBe(404)
    state.sessions.set('agent-b/session-1', { isActive: false, isAwaitingInput: false })
    expect((await call('/sessions', 'POST', { title: 'Report', agentSlug: 'agent-b', sessionId: 'session-1' }, 'bob')).status).toBe(404)
  })

  it('needs a title', async () => {
    state.sessions.set('agent-a/session-1', { isActive: false, isAwaitingInput: false })
    expect((await call('/sessions', 'POST', { title: '  ', agentSlug: 'agent-a', sessionId: 'session-1' })).status).toBe(400)
  })
})

describe('board columns', () => {
  it('follow the session live', async () => {
    const todo = await startDraft()
    const column = async () => (await (await call('')).json()).todos.find((t: { id: string }) => t.id === todo.id).column

    state.sessions.set('agent-a/session-1', { isActive: true, isAwaitingInput: false })
    expect(await column()).toBe('working')

    state.sessions.set('agent-a/session-1', { isActive: true, isAwaitingInput: true })
    expect(await column()).toBe('needs_input')

    state.sessions.set('agent-a/session-1', { isActive: false, isAwaitingInput: false })
    expect(await column()).toBe('has_updates')
  })

  it('say what a Needs input item is waiting for', async () => {
    const todo = await startDraft()
    const listed = async () => (await (await call('')).json()).todos.find((t: { id: string }) => t.id === todo.id)

    state.requests.set('agent-a/session-1', [{ kind: 'script_run', blocking: true, autoApproved: false }])
    expect((await listed()).ask).toBeNull() // still working: the column decides first

    state.sessions.set('agent-a/session-1', { isActive: true, isAwaitingInput: true })
    expect(await listed()).toMatchObject({ column: 'needs_input', ask: 'permission' })
  })

  it('stop reading the session of an agent the person lost access to', async () => {
    const todo = await startDraft()
    state.readable.get('alice')!.delete('agent-a')
    const listed = (await (await call('')).json()).todos[0]
    expect(listed).toMatchObject({ id: todo.id, status: 'active', column: 'has_updates' })
  })
})

describe('status changes', () => {
  it('marks done, archives, and reopens', async () => {
    const todo = await startDraft()
    const done = await call(`/${todo.id}/status`, 'POST', { status: 'done' })
    expect(await done.json()).toMatchObject({ status: 'done', column: 'done' })
    const archived = await call(`/${todo.id}/status`, 'POST', { status: 'archived' })
    expect(await archived.json()).toMatchObject({ status: 'archived', column: 'archived' })
    await call(`/${todo.id}/status`, 'POST', { status: 'done' })
    const reopened = await call(`/${todo.id}/status`, 'POST', { status: 'active' })
    expect(await reopened.json()).toMatchObject({ status: 'active', column: 'working' })
  })

  it('archives a draft and puts it back in Drafts', async () => {
    const draft = await createDraft()
    const archived = await call(`/${draft.id}/status`, 'POST', { status: 'archived' })
    expect(await archived.json()).toMatchObject({ status: 'archived', column: 'archived' })
    const back = await call(`/${draft.id}/status`, 'POST', { status: 'draft' })
    expect(await back.json()).toMatchObject({ status: 'draft', column: 'drafts' })
  })

  it('refuses a move the item cannot make', async () => {
    const draft = await createDraft()
    expect((await call(`/${draft.id}/status`, 'POST', { status: 'done' })).status).toBe(409)
    expect((await call(`/${draft.id}/status`, 'POST', { status: 'draft' })).status).toBe(409)
    expect((await call(`/${draft.id}/status`, 'POST', { status: 'started' })).status).toBe(400)
    expect((await call('/missing/status', 'POST', { status: 'done' })).status).toBe(404)
  })
})

describe('ordering', () => {
  it('lists in board order and moves an item where it was dragged', async () => {
    const older = await createDraft({ title: 'Older' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await createDraft({ title: 'Newer' })
    const titles = async () => (await (await call('')).json()).todos.map((t: { title: string }) => t.title)
    expect(await titles()).toEqual(['Newer', 'Older'])

    const moved = await call(`/${older.id}/position`, 'POST', { position: newer.position + 1 })
    expect(await moved.json()).toMatchObject({ id: older.id, position: newer.position + 1 })
    expect(await titles()).toEqual(['Older', 'Newer'])
  })

  it('refuses a position that is not a number, and another person\'s item', async () => {
    const draft = await createDraft()
    expect((await call(`/${draft.id}/position`, 'POST', { position: 'top' })).status).toBe(400)
    expect((await call(`/${draft.id}/position`, 'POST', { position: 1 }, 'bob')).status).toBe(404)
  })
})
