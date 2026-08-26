/**
 * "Mark as Unread" marks live in their own table rather than on session
 * metadata, so the dot works for sessions that never produced a notification
 * without putting a file read on the polled endpoints that project it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
  },
}))

import {
  markSessionUnread,
  clearSessionUnread,
  getSessionIdsMarkedUnread,
  getSessionIdsMarkedUnreadByAgents,
  deleteSessionUnreadMarks,
} from './session-unread-service'

describe('session-unread-service', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('raises a mark and lists it for the agent', async () => {
    expect(await getSessionIdsMarkedUnread('agent-a')).toEqual(new Set())

    await markSessionUnread('agent-a', 'sess-1')

    expect(await getSessionIdsMarkedUnread('agent-a')).toEqual(new Set(['sess-1']))
  })

  it('clears the mark', async () => {
    await markSessionUnread('agent-a', 'sess-1')
    await clearSessionUnread('sess-1')

    expect(await getSessionIdsMarkedUnread('agent-a')).toEqual(new Set())
  })

  it('scopes marks to their own agent', async () => {
    await markSessionUnread('agent-a', 'sess-a')
    await markSessionUnread('agent-b', 'sess-b')

    expect(await getSessionIdsMarkedUnread('agent-a')).toEqual(new Set(['sess-a']))
    expect(await getSessionIdsMarkedUnread('agent-b')).toEqual(new Set(['sess-b']))
  })

  // The clear fires on every session open and the client skips its cache
  // invalidation when nothing was written — refetching the session list and
  // re-enriching every agent for a no-op is what this return value avoids.
  it('reports whether the write actually changed anything', async () => {
    expect(await clearSessionUnread('never-marked')).toBe(false)
    expect(await markSessionUnread('agent-a', 'sess-1')).toBe(true)
    expect(await markSessionUnread('agent-a', 'sess-1')).toBe(false)
    expect(await clearSessionUnread('sess-1')).toBe(true)
  })

  it('keeps the original timestamp when a marked session is re-marked', async () => {
    await markSessionUnread('agent-a', 'sess-1')
    const first = testSqlite
      .prepare('SELECT marked_at FROM session_unread_marks WHERE session_id = ?')
      .get('sess-1') as { marked_at: number }

    await markSessionUnread('agent-a', 'sess-1')
    const second = testSqlite
      .prepare('SELECT marked_at FROM session_unread_marks WHERE session_id = ?')
      .get('sess-1') as { marked_at: number }

    expect(second.marked_at).toBe(first.marked_at)
  })

  describe('getSessionIdsMarkedUnreadByAgents', () => {
    it('groups by agent in one query', async () => {
      await markSessionUnread('agent-a', 'sess-a1')
      await markSessionUnread('agent-a', 'sess-a2')
      await markSessionUnread('agent-b', 'sess-b1')

      const byAgent = await getSessionIdsMarkedUnreadByAgents(['agent-a', 'agent-b'])

      expect(byAgent.get('agent-a')).toEqual(new Set(['sess-a1', 'sess-a2']))
      expect(byAgent.get('agent-b')).toEqual(new Set(['sess-b1']))
    })

    it('omits agents with no marks rather than returning empty sets', async () => {
      await markSessionUnread('agent-a', 'sess-a1')

      const byAgent = await getSessionIdsMarkedUnreadByAgents(['agent-a', 'agent-quiet'])

      expect(byAgent.has('agent-quiet')).toBe(false)
    })

    it('returns an empty map for no agents without querying', async () => {
      expect(await getSessionIdsMarkedUnreadByAgents([])).toEqual(new Map())
    })
  })

  // A mark outliving its session would be an unreachable row: nothing lists the
  // session any more, so nothing could ever clear it.
  it('drops marks for deleted sessions and leaves the others alone', async () => {
    await markSessionUnread('agent-a', 'sess-gone')
    await markSessionUnread('agent-a', 'sess-kept')

    expect(await deleteSessionUnreadMarks(['sess-gone'])).toBe(1)

    expect(await getSessionIdsMarkedUnread('agent-a')).toEqual(new Set(['sess-kept']))
  })
})
