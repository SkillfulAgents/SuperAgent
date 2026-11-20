import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMaxBoundParameters } from '@shared/lib/db/bound-parameters'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

// Which sessions each agent's actor has: its delete answers whether one was there.
const actors = vi.hoisted(() => ({ sessions: {} as Record<string, Set<string>> }))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      sessions: { delete: async (id: string) => actors.sessions[slug]?.delete(id) ?? false },
    }),
  },
}))
const cancelled = vi.hoisted(() => [] as string[][])
vi.mock('./scheduled-task-service', () => ({
  cancelPendingWakeForSession: async (slug: string, id: string) => {
    cancelled.push([slug, id])
  },
}))

import { messageAuthor, notifications, sessionUnreadMarks, todos } from '@shared/lib/db/schema'
import { createNotification } from './notification-service'
import { deleteSessionAndRecords, deleteSessionRecords } from './session-deletion'
import { markSessionUnread } from './session-unread-service'

const authors = async () =>
  (await database.db.select().from(messageAuthor).all()).map((row) => `${row.agentSlug}/${row.sessionId}`).sort()
const notified = async () =>
  (await database.db.select().from(notifications).all()).map((row) => `${row.agentSlug}/${row.sessionId}`).sort()

beforeEach(async () => {
  actors.sessions = { agent: new Set(['s1', 's2']), other: new Set(['s1']) }
  cancelled.length = 0
  for (const [agentSlug, sessionId] of [['agent', 's1'], ['agent', 's2'], ['other', 's1']]) {
    await database.db.insert(messageAuthor).values({
      id: `${agentSlug}-${sessionId}`, agentSlug, sessionId, integrationId: 'slack', display: '{}',
    }).run()
    await createNotification({ type: 'session_complete', agentSlug, sessionId, title: 't', body: 'b' })
  }
})

describe('deleteSessionAndRecords', () => {
  it('deletes the session and what the host keeps about it, and nothing of its other sessions', async () => {
    expect(await deleteSessionAndRecords('agent', 's2')).toBe(true)

    expect(actors.sessions.agent).toEqual(new Set(['s1']))
    expect(await authors()).toEqual(['agent/s1', 'other/s1'])
    expect(await notified()).toEqual(['agent/s1', 'other/s1'])
    expect(cancelled).toEqual([['agent', 's2']])
  })

  it('leaves another agent\'s records alone when it has a session with the same id', async () => {
    // An agent can make a transcript with any id in its own directory; the
    // records it reaches through a delete must still be its own.
    expect(await deleteSessionAndRecords('agent', 's1')).toBe(true)

    expect(actors.sessions.other).toEqual(new Set(['s1']))
    expect(await authors()).toEqual(['agent/s2', 'other/s1'])
    expect(await notified()).toEqual(['agent/s2', 'other/s1'])
  })

  it('touches nothing for a session the agent does not have', async () => {
    expect(await deleteSessionAndRecords('agent', 'unknown')).toBe(false)

    expect(await authors()).toHaveLength(3)
    expect(await notified()).toHaveLength(3)
    expect(cancelled).toEqual([])
  })
})

describe('deleteSessionRecords on a driver that binds at most 100 parameters a statement', () => {
  beforeEach(() => setMaxBoundParameters(100))
  afterEach(() => setMaxBoundParameters(undefined))

  /** How many parameters each statement run on the test database binds. */
  function countBoundParameters(): number[] {
    const counts: number[] = []
    const session = (database.db as unknown as { session: Record<string, (query: { params: unknown[] }, ...rest: unknown[]) => unknown> }).session
    for (const method of ['prepareQuery', 'prepareOneTimeQuery']) {
      const original = session[method].bind(session)
      vi.spyOn(session, method).mockImplementation((query, ...rest) => {
        counts.push(query.params.length)
        return original(query, ...rest)
      })
    }
    return counts
  }

  it.each([99, 100])('accounts for the agent bind when deleting %i sessions', async (count) => {
    const ids = Array.from({ length: count }, (_, i) => `session-${i}`)
    const counts = countBoundParameters()
    await deleteSessionRecords('agent', ids)
    expect(counts).toContain(count === 99 ? 100 : 2)
    expect(Math.max(...counts)).toBeLessThanOrEqual(100)
  })

  it('removes the records of more than 100 sessions of one agent', async () => {
    const sessionIds = Array.from({ length: 250 }, (_, i) => `retention-${i}`)
    for (const sessionId of sessionIds) {
      await database.db.insert(messageAuthor).values({
        id: `agent-${sessionId}`, agentSlug: 'agent', sessionId, integrationId: 'slack', display: '{}',
      }).run()
      await createNotification({ type: 'session_complete', agentSlug: 'agent', sessionId, title: 't', body: 'b' })
      await markSessionUnread('agent', sessionId, 'user-reader')
      await database.db.insert(todos).values({
        id: `todo-${sessionId}`, userId: 'user-reader', title: 'Write the report', agentSlug: 'agent', sessionId, status: 'active', position: 1, createdAt: new Date(), updatedAt: new Date(),
      }).run()
    }
    const counts = countBoundParameters()

    await deleteSessionRecords('agent', sessionIds)

    expect(Math.max(...counts)).toBeLessThanOrEqual(100)
    expect(await authors()).toEqual(['agent/s1', 'agent/s2', 'other/s1'])
    expect(await notified()).toEqual(['agent/s1', 'agent/s2', 'other/s1'])
    expect(await database.db.select().from(sessionUnreadMarks).all()).toEqual([])
    const unlinked = await database.db.select().from(todos).all()
    expect(unlinked).toHaveLength(250)
    expect(unlinked.every((todo) => todo.sessionId === null && todo.status === 'draft')).toBe(true)
  })
})
