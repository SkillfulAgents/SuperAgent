import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { batch } from '@shared/lib/db/batch'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import {
  START_CLAIM_TTL_MS,
  appendTodoAttachment,
  claimStart,
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  moveTodo,
  releaseStart,
  removeTodoAttachment,
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

/** Claims a draft for a start and returns the token. */
async function claim(id: string, agentSlug = 'agent-a') {
  const claimed = await claimStart(ME, id, agentSlug)
  if (!claimed.ok) throw new Error('could not claim')
  return claimed.claim
}

async function startedTodo(agentSlug = 'agent-a', sessionId = 'session-1') {
  const draft = await createTodo(ME, { title: 'Write the report', description: '', agentSlug })
  const started = await startTodo(ME, draft.id, agentSlug, sessionId, await claim(draft.id, agentSlug))
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

  it('list newest first, and editing one does not move it', async () => {
    const first = await createTodo(ME, { title: 'First', description: '' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await createTodo(ME, { title: 'Second', description: '' })
    await updateDraft(ME, first.id, { title: 'First, edited' })
    expect((await listTodos(ME)).map((t) => t.title)).toEqual(['Second', 'First, edited'])
  })
})

describe('ordering', () => {
  it('puts an item where it was dragged', async () => {
    const a = await createTodo(ME, { title: 'A', description: '' })
    const b = await createTodo(ME, { title: 'B', description: '' })
    const moved = await moveTodo(ME, a.id, b.position + 1)
    expect(moved.ok && moved.todo.position).toBe(b.position + 1)
    expect((await listTodos(ME)).map((t) => t.title)).toEqual(['A', 'B'])
  })

  it('moves only the person\'s own items', async () => {
    const todo = await createTodo(ME, { title: 'Mine', description: '' })
    expect(await moveTodo(SOMEONE_ELSE, todo.id, 1)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('a status change lands the item on top of its new column', async () => {
    const todo = await startedTodo()
    await moveTodo(ME, todo.id, 0)
    const done = await setTodoStatus(ME, todo.id, 'done')
    expect(done.ok && done.todo.position).toBeGreaterThan(1_000_000)
  })
})

describe('starting', () => {
  it('links the session and makes the item active', async () => {
    const todo = await startedTodo()
    expect(todo).toMatchObject({ status: 'active', agentSlug: 'agent-a', sessionId: 'session-1' })
    expect(todo.startedAt).toBeInstanceOf(Date)
  })

  it('claims and links only for the agent the draft is given to', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    expect(await claimStart(ME, draft.id, 'agent-b')).toEqual({ ok: false, reason: 'conflict' })
    const token = await claim(draft.id, 'agent-a')
    expect(await startTodo(ME, draft.id, 'agent-b', 'session-1', token)).toEqual({ ok: false, reason: 'conflict' })
  })

  it('is claimed once: a second claim waits until the first is released', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    const claims = await Promise.all([claimStart(ME, draft.id, 'agent-a'), claimStart(ME, draft.id, 'agent-a')])
    expect(claims.filter((c) => c.ok)).toHaveLength(1)
    expect(claims.filter((c) => !c.ok)).toEqual([{ ok: false, reason: 'conflict' }])

    const held = claims.find((c) => c.ok)!
    if (!held.ok) throw new Error('unreachable')
    await releaseStart(ME, draft.id, 'someone-elses-token')
    expect((await claimStart(ME, draft.id, 'agent-a')).ok).toBe(false)
    await releaseStart(ME, draft.id, held.claim)
    expect((await claimStart(ME, draft.id, 'agent-a')).ok).toBe(true)
  })

  it('links only with the claim that holds it', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    const token = await claim(draft.id)
    expect(await startTodo(ME, draft.id, 'agent-a', 'session-1', 'not-the-claim')).toEqual({ ok: false, reason: 'conflict' })
    const started = await startTodo(ME, draft.id, 'agent-a', 'session-1', token)
    expect(started.ok && started.todo).toMatchObject({ status: 'active', startClaim: null, startClaimedAt: null })
  })

  it('a claim lapses, so a tab that went away mid-start does not hold the draft forever', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    await claim(draft.id)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + START_CLAIM_TTL_MS + 1_000)
      expect((await claimStart(ME, draft.id, 'agent-a')).ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('while claimed, the draft is not edited or archived out from under the start', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    await claim(draft.id)
    expect(await updateDraft(ME, draft.id, { title: 'Changed' })).toEqual({ ok: false, reason: 'conflict' })
    expect(await setTodoStatus(ME, draft.id, 'archived')).toEqual({ ok: false, reason: 'conflict' })
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

  it('a draft cannot be marked done', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '' })
    expect(await setTodoStatus(ME, draft.id, 'done')).toEqual({ ok: false, reason: 'conflict' })
    expect(await setTodoStatus(ME, draft.id, 'active')).toEqual({ ok: false, reason: 'conflict' })
  })

  it('a draft archives, and unarchives back to Drafts, never to Done', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    const archived = await setTodoStatus(ME, draft.id, 'archived')
    expect(archived.ok && archived.todo).toMatchObject({ status: 'archived', startedAt: null, completedAt: null })
    expect(await setTodoStatus(ME, draft.id, 'done')).toEqual({ ok: false, reason: 'conflict' })
    const back = await setTodoStatus(ME, draft.id, 'draft')
    expect(back.ok && back.todo).toMatchObject({ status: 'draft', agentSlug: 'agent-a' })
    expect((await startTodo(ME, draft.id, 'agent-a', 'session-1', await claim(draft.id))).ok).toBe(true)
  })

  it('archived work that was started unarchives to Done, never to Drafts', async () => {
    const todo = await startedTodo()
    await setTodoStatus(ME, todo.id, 'done')
    await setTodoStatus(ME, todo.id, 'archived')
    expect(await setTodoStatus(ME, todo.id, 'draft')).toEqual({ ok: false, reason: 'conflict' })
    expect((await setTodoStatus(ME, todo.id, 'done')).ok).toBe(true)
  })

  it('only an archived item goes back to Drafts', async () => {
    const todo = await startedTodo()
    expect(await setTodoStatus(ME, todo.id, 'draft')).toEqual({ ok: false, reason: 'conflict' })
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


const entry = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'note.txt',
  size: 4,
  mimeType: 'text/plain',
  addedAt: 1,
  kind: 'file' as const,
  path: '/workspace/uploads/todo/11111111-1111-4111-8111-111111111111/note.txt',
  agentSlug: 'agent-a',
}

describe('held files', () => {
  it('refuses to add or remove a file once the draft is claimed or started', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    await claim(draft.id)
    expect(await appendTodoAttachment(ME, draft.id, entry)).toEqual({ ok: false, reason: 'conflict' })
    expect(await removeTodoAttachment(ME, draft.id, entry.id)).toEqual({ ok: false, reason: 'conflict' })

    const started = await startedTodo()
    expect(await appendTodoAttachment(ME, started.id, entry)).toEqual({ ok: false, reason: 'conflict' })
    expect(await removeTodoAttachment(ME, started.id, entry.id)).toEqual({ ok: false, reason: 'conflict' })
  })

  it('appends a file on an unclaimed draft and removes it', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    const added = await appendTodoAttachment(ME, draft.id, entry)
    expect(added.ok && added.todo.attachments).toContain(entry.id)
    const removed = await removeTodoAttachment(ME, draft.id, entry.id)
    expect(removed.ok && removed.todo.attachments).toBe('[]')
  })

  it('replaces a pointer with the same id instead of adding a second', async () => {
    const draft = await createTodo(ME, { title: 'Draft', description: '', agentSlug: 'agent-a' })
    expect((await appendTodoAttachment(ME, draft.id, entry)).ok).toBe(true)
    const again = await appendTodoAttachment(ME, draft.id, { ...entry, name: 'other.txt' })
    expect(again.ok && JSON.parse(again.todo.attachments)).toEqual([{ ...entry, name: 'other.txt' }])
  })
})
