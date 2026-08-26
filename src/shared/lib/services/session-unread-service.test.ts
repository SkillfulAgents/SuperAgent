/**
 * "Mark as Unread" marks live in their own table rather than on session
 * metadata, so the dot works for sessions that never produced a notification
 * without putting a file read on the polled endpoints that project it.
 *
 * Unlike notification read state they are per-user: a mark is one person's
 * reminder, not a team-visible acknowledgement.
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

const ALICE = 'user-alice'
const BOB = 'user-bob'

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
    expect(await getSessionIdsMarkedUnread('agent-a', ALICE)).toEqual(new Set())

    await markSessionUnread('agent-a', 'sess-1', ALICE)

    expect(await getSessionIdsMarkedUnread('agent-a', ALICE)).toEqual(new Set(['sess-1']))
  })

  it('clears the mark', async () => {
    await markSessionUnread('agent-a', 'sess-1', ALICE)
    await clearSessionUnread('sess-1', ALICE)

    expect(await getSessionIdsMarkedUnread('agent-a', ALICE)).toEqual(new Set())
  })

  it('scopes marks to their own agent', async () => {
    await markSessionUnread('agent-a', 'sess-a', ALICE)
    await markSessionUnread('agent-b', 'sess-b', ALICE)

    expect(await getSessionIdsMarkedUnread('agent-a', ALICE)).toEqual(new Set(['sess-a']))
    expect(await getSessionIdsMarkedUnread('agent-b', ALICE)).toEqual(new Set(['sess-b']))
  })

  // The clear fires on every session open and the client skips its cache
  // invalidation when nothing was written — refetching the session list and
  // re-enriching every agent for a no-op is what this return value avoids.
  it('reports whether the write actually changed anything', async () => {
    expect(await clearSessionUnread('never-marked', ALICE)).toBe(false)
    expect(await markSessionUnread('agent-a', 'sess-1', ALICE)).toBe(true)
    expect(await markSessionUnread('agent-a', 'sess-1', ALICE)).toBe(false)
    expect(await clearSessionUnread('sess-1', ALICE)).toBe(true)
  })

  it('keeps the original timestamp when a marked session is re-marked', async () => {
    const markedAt = () =>
      (testSqlite
        .prepare('SELECT marked_at FROM session_unread_marks WHERE session_id = ? AND user_id = ?')
        .get('sess-1', ALICE) as { marked_at: number }).marked_at

    await markSessionUnread('agent-a', 'sess-1', ALICE)
    const first = markedAt()
    await markSessionUnread('agent-a', 'sess-1', ALICE)

    expect(markedAt()).toBe(first)
  })

  describe('per-user scoping', () => {
    it('does not show one user a mark another user raised', async () => {
      await markSessionUnread('agent-a', 'sess-1', ALICE)

      expect(await getSessionIdsMarkedUnread('agent-a', ALICE)).toEqual(new Set(['sess-1']))
      expect(await getSessionIdsMarkedUnread('agent-a', BOB)).toEqual(new Set())
    })

    // The whole point of scoping: a teammate opening the session must not
    // clear your reminder to come back to it.
    it('leaves another user mark alone when one user opens the session', async () => {
      await markSessionUnread('agent-a', 'sess-1', ALICE)
      await markSessionUnread('agent-a', 'sess-1', BOB)

      expect(await clearSessionUnread('sess-1', BOB)).toBe(true)

      expect(await getSessionIdsMarkedUnread('agent-a', ALICE)).toEqual(new Set(['sess-1']))
      expect(await getSessionIdsMarkedUnread('agent-a', BOB)).toEqual(new Set())
    })

    it('lets two users hold a mark on the same session at once', async () => {
      expect(await markSessionUnread('agent-a', 'sess-1', ALICE)).toBe(true)
      expect(await markSessionUnread('agent-a', 'sess-1', BOB)).toBe(true)

      const rows = testSqlite
        .prepare('SELECT COUNT(*) AS n FROM session_unread_marks WHERE session_id = ?')
        .get('sess-1') as { n: number }
      expect(rows.n).toBe(2)
    })
  })

  // Outside auth mode getCurrentUserId() returns the 'local' sentinel rather
  // than nothing, so single-user installs are an ordinary one-user case here —
  // not a "no user, skip the feature" case.
  it('round-trips a mark for the local sentinel user', async () => {
    expect(await markSessionUnread('agent-a', 'sess-1', 'local')).toBe(true)

    expect(await getSessionIdsMarkedUnread('agent-a', 'local')).toEqual(new Set(['sess-1']))
    expect(await getSessionIdsMarkedUnreadByAgents(['agent-a'], 'local').then((m) => m.get('agent-a')))
      .toEqual(new Set(['sess-1']))

    expect(await clearSessionUnread('sess-1', 'local')).toBe(true)
    expect(await getSessionIdsMarkedUnread('agent-a', 'local')).toEqual(new Set())
  })

  describe('getSessionIdsMarkedUnreadByAgents', () => {
    it('groups by agent in one query', async () => {
      await markSessionUnread('agent-a', 'sess-a1', ALICE)
      await markSessionUnread('agent-a', 'sess-a2', ALICE)
      await markSessionUnread('agent-b', 'sess-b1', ALICE)

      const byAgent = await getSessionIdsMarkedUnreadByAgents(['agent-a', 'agent-b'], ALICE)

      expect(byAgent.get('agent-a')).toEqual(new Set(['sess-a1', 'sess-a2']))
      expect(byAgent.get('agent-b')).toEqual(new Set(['sess-b1']))
    })

    it('excludes other users marks', async () => {
      await markSessionUnread('agent-a', 'sess-alice', ALICE)
      await markSessionUnread('agent-a', 'sess-bob', BOB)

      const byAgent = await getSessionIdsMarkedUnreadByAgents(['agent-a'], ALICE)

      expect(byAgent.get('agent-a')).toEqual(new Set(['sess-alice']))
    })

    it('omits agents with no marks rather than returning empty sets', async () => {
      await markSessionUnread('agent-a', 'sess-a1', ALICE)

      const byAgent = await getSessionIdsMarkedUnreadByAgents(['agent-a', 'agent-quiet'], ALICE)

      expect(byAgent.has('agent-quiet')).toBe(false)
    })

    it('returns an empty map for no agents without querying', async () => {
      expect(await getSessionIdsMarkedUnreadByAgents([], ALICE)).toEqual(new Map())
    })
  })

  // A mark outliving its session would be an unreachable row: nothing lists the
  // session any more, so nothing could ever clear it.
  it('drops every user mark for a deleted session and leaves the others alone', async () => {
    await markSessionUnread('agent-a', 'sess-gone', ALICE)
    await markSessionUnread('agent-a', 'sess-gone', BOB)
    await markSessionUnread('agent-a', 'sess-kept', ALICE)

    expect(await deleteSessionUnreadMarks(['sess-gone'])).toBe(2)

    expect(await getSessionIdsMarkedUnread('agent-a', ALICE)).toEqual(new Set(['sess-kept']))
    expect(await getSessionIdsMarkedUnread('agent-a', BOB)).toEqual(new Set())
  })
})
