import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { batch } from '@shared/lib/db/batch'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import {
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  setTodoStatus,
  startTodo,
  unlinkAgentStatements,
  unlinkTodosFromSessions,
  updateDraft,
} from './todo-service'

const ME = 'user-me'
const SOMEONE_ELSE = 'user-other'
let handle: TestDatabase

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
})

afterEach(async () => {
  await handle.close()
})

async function startedTodo(agentSlug = 'agent-a', sessionId = 'session-1') {
  const draft = await createTodo(ME, { title: 'Write the report', description: '', agentSlug })
  const started = await startTodo(ME, draft.id, agentSlug, sessionId)
  if (!started.ok) throw new Error('could not start')
  return started.todo
}

describe('drafts', () => {
  it('are created as drafts with no session', async () => {
    const todo = await createTodo(ME, { title: 'Plan the offsite', description: 'Three days', agentSlug: null })
    expect(todo).toMatchObject({ status: 'draft', sessionId: null, agentSlug: null, title: 'Plan the offsite' })
    expect(await getTodo(ME, todo.id)).toMatchObject({ title: 'Plan the offsite', description: 'Three days' })
  })

  it('belong to the person who wrote them', async () => {
    const todo = await createTodo(ME, { title: 'Mine', description: '' })
    expect(await getTodo(SOMEONE_ELSE, todo.id)).toBeUndefined()
    expect(await listTodos(SOMEONE_ELSE)).toEqual([])
    expect(await updateDraft(SOMEONE_ELSE, todo.id, { title: 'Theirs' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await deleteTodo(SOMEONE_ELSE, todo.id)).toBe(false)
  })

  it('can be edited and reassigned until started', async () => {
    const todo = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    const edited = await updateDraft(ME, todo.id, { description: 'More detail', agentSlug: 'agent-b' })
    expect(edited.ok && edited.todo).toMatchObject({ title: 'Draft', description: 'More detail', agentSlug: 'agent-b' })
    const unassigned = await updateDraft(ME, todo.id, { agentSlug: null })
    expect(unassigned.ok && unassigned.todo.agentSlug).toBeNull()
  })

  it('list newest change first', async () => {
    const first = await createTodo(ME, { title: 'First', description: '' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await createTodo(ME, { title: 'Second', description: '' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await updateDraft(ME, first.id, { title: 'First, edited' })
    expect((await listTodos(ME)).map((t) => t.title)).toEqual(['First, edited', 'Second'])
  })
})

describe('starting', () => {
  it('links the session and makes the item active', async () => {
    const todo = await startedTodo()
    expect(todo).toMatchObject({ status: 'active', agentSlug: 'agent-a', sessionId: 'session-1' })
    expect(todo.startedAt).toBeInstanceOf(Date)
  })

  it('refuses a session of an agent the draft is no longer assigned to', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    await updateDraft(ME, draft.id, { agentSlug: 'agent-b' })
    expect(await startTodo(ME, draft.id, 'agent-a', 'session-1')).toEqual({ ok: false, reason: 'conflict' })
  })

  it('happens once: a second start of the same draft is a conflict', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    const results = await Promise.all([
      startTodo(ME, draft.id, 'agent-a', 'session-1'),
      startTodo(ME, draft.id, 'agent-a', 'session-2'),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'conflict' }])
  })

  it('freezes the brief: a started item is no longer a draft to edit', async () => {
    const todo = await startedTodo()
    expect(await updateDraft(ME, todo.id, { description: 'changed' })).toEqual({ ok: false, reason: 'conflict' })
  })
})

describe('status changes', () => {
  it('done, archived, back to done, and reopened', async () => {
    const todo = await startedTodo()
    const done = await setTodoStatus(ME, todo.id, 'done')
    expect(done.ok && done.todo).toMatchObject({ status: 'done' })
    expect(done.ok && done.todo.completedAt).toBeInstanceOf(Date)
    expect((await setTodoStatus(ME, todo.id, 'archived')).ok).toBe(true)
    expect((await setTodoStatus(ME, todo.id, 'done')).ok).toBe(true)
    const reopened = await setTodoStatus(ME, todo.id, 'active')
    expect(reopened.ok && reopened.todo).toMatchObject({ status: 'active', completedAt: null })
  })

  it('a draft cannot be marked done or archived', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '' })
    expect(await setTodoStatus(ME, draft.id, 'done')).toEqual({ ok: false, reason: 'conflict' })
    expect(await setTodoStatus(ME, draft.id, 'archived')).toEqual({ ok: false, reason: 'conflict' })
  })

  it('active work goes to done before archive', async () => {
    const todo = await startedTodo()
    expect(await setTodoStatus(ME, todo.id, 'archived')).toEqual({ ok: false, reason: 'conflict' })
  })

  it('a missing item is not found', async () => {
    expect(await setTodoStatus(ME, 'nope', 'done')).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('deleting sessions and agents', () => {
  it('a deleted session sends work in progress back to Drafts', async () => {
    const todo = await startedTodo('agent-a', 'session-1')
    await unlinkTodosFromSessions('agent-a', ['session-1'])
    expect(await getTodo(ME, todo.id)).toMatchObject({ status: 'draft', sessionId: null, startedAt: null, agentSlug: 'agent-a' })
  })

  it('a deleted session leaves finished work in place, unlinked', async () => {
    const todo = await startedTodo('agent-a', 'session-1')
    await setTodoStatus(ME, todo.id, 'done')
    await unlinkTodosFromSessions('agent-a', ['session-1'])
    expect(await getTodo(ME, todo.id)).toMatchObject({ status: 'done', sessionId: null })
    // Without its session there is nothing to reopen.
    expect(await setTodoStatus(ME, todo.id, 'active')).toEqual({ ok: false, reason: 'conflict' })
  })

  it('only the deleted agent\'s session id is matched', async () => {
    const mine = await startedTodo('agent-a', 'shared-id')
    const other = await startedTodo('agent-b', 'shared-id')
    await unlinkTodosFromSessions('agent-a', ['shared-id'])
    expect((await getTodo(ME, mine.id))?.status).toBe('draft')
    expect(await getTodo(ME, other.id)).toMatchObject({ status: 'active', sessionId: 'shared-id' })
  })

  it('a deleted agent lets go of every item it had', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    const active = await startedTodo('agent-a', 'session-1')
    const done = await startedTodo('agent-a', 'session-2')
    await setTodoStatus(ME, done.id, 'done')
    const elsewhere = await startedTodo('agent-b', 'session-3')

    await batch(unlinkAgentStatements('agent-a'))

    expect(await getTodo(ME, draft.id)).toMatchObject({ status: 'draft', agentSlug: null })
    expect(await getTodo(ME, active.id)).toMatchObject({ status: 'draft', agentSlug: null, sessionId: null })
    expect(await getTodo(ME, done.id)).toMatchObject({ status: 'done', agentSlug: null, sessionId: null })
    expect(await getTodo(ME, elsewhere.id)).toMatchObject({ status: 'active', agentSlug: 'agent-b' })
  })
})
