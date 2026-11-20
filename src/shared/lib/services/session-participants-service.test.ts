import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, asc, eq, inArray, isNotNull, min, sql } from 'drizzle-orm'
import { setMaxBoundParameters } from '@shared/lib/db/bound-parameters'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('../db', () => ({
  get db() { return testDb },
}))

import { getSessionParticipants, sessionParticipantsQuery } from './session-participants-service'
import { getUserSummaries } from './user-profile-service'

/**
 * What the sessions route did before the single read, statement for statement:
 * the rows in IN lists of 500 session ids, then the users.
 */
async function participantsBeforeSingleRead(agentSlug: string, sessionIds: readonly string[]) {
  const ids = [...new Set(sessionIds)]
  const rows: { sessionId: string; userId: string }[] = []
  for (let i = 0; i < ids.length; i += 500) {
    const firstAt = min(schema.messageAuthor.createdAt)
    const found = await testDb
      .select({ sessionId: schema.messageAuthor.sessionId, userId: schema.messageAuthor.userId, firstAt })
      .from(schema.messageAuthor)
      .where(and(
        eq(schema.messageAuthor.agentSlug, agentSlug),
        inArray(schema.messageAuthor.sessionId, ids.slice(i, i + 500)),
        isNotNull(schema.messageAuthor.userId),
      ))
      .groupBy(schema.messageAuthor.sessionId, schema.messageAuthor.userId)
      .orderBy(asc(firstAt), asc(schema.messageAuthor.userId))
      .all()
    for (const row of found) if (row.userId) rows.push({ sessionId: row.sessionId, userId: row.userId })
  }
  const profiles = await getUserSummaries(rows.map(row => row.userId))
  const bySession = new Map<string, unknown[]>()
  for (const row of rows) {
    const profile = profiles.get(row.userId)
    if (!profile) continue
    const list = bySession.get(row.sessionId)
    if (list) list.push(profile)
    else bySession.set(row.sessionId, [profile])
  }
  return bySession
}

/** Statements sent to the driver from here on: every one is prepared by the drizzle session. */
function countStatements(): () => number {
  const prepare = vi.spyOn((testDb as unknown as { session: { prepareQuery(): unknown } }).session, 'prepareQuery')
  return () => prepare.mock.calls.length
}

/** Each session with its people in order, as the route serializes them. */
const shape = (result: Map<string, unknown[]>) => [...result].sort(([a], [b]) => a.localeCompare(b))

/**
 * `count` sessions of agent-a: every fifth has no author row, every seventh
 * only an integration's, the rest one to three people writing several times;
 * agent-b holds rows under the same session ids, written by someone else.
 */
async function seedMixed(count: number): Promise<string[]> {
  const people = ['ann', 'bob', 'cat']
  const ids = Array.from({ length: count }, (_, i) => `s-${String(i).padStart(5, '0')}`)
  const rows: (typeof schema.messageAuthor.$inferInsert)[] = []
  ids.forEach((sessionId, i) => {
    rows.push({ id: `other-${i}`, sessionId, agentSlug: 'agent-b', userId: 'dan', createdAt: new Date(1) })
    if (i % 5 === 0) return
    if (i % 7 === 0) {
      rows.push({ id: `int-${i}`, sessionId, agentSlug: 'agent-a', integrationId: 'int-1', display: '{}', createdAt: new Date(10) })
      return
    }
    for (let m = 0; m < 4; m++) {
      // Later sessions start with a different person, and two people can share a first instant.
      const userId = people[(i + m) % (1 + (i % 3))]!
      rows.push({ id: `m-${i}-${m}`, sessionId, agentSlug: 'agent-a', userId, createdAt: new Date(1000 + (m >> 1)) })
    }
  })
  for (let i = 0; i < rows.length; i += 100) await testDb.insert(schema.messageAuthor).values(rows.slice(i, i + 100)).run()
  return ids
}

let seq = 0
async function authored(sessionId: string, userId: string | null, at: number, agentSlug = 'agent-a') {
  seq++
  await testDb.insert(schema.messageAuthor).values({
    id: `m-${seq}`,
    sessionId,
    agentSlug,
    userId,
    ...(userId ? {} : { integrationId: 'int-1', display: '{}' }),
    createdAt: new Date(at),
  }).run()
}

describe('getSessionParticipants', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    for (const id of ['ann', 'bob', 'cat']) {
      await testDb.insert(schema.user).values({ id, name: id.toUpperCase(), email: `${id}@co.com`, emailVerified: true }).run()
    }
  })

  afterEach(async () => {
    setMaxBoundParameters(undefined)
    await handle.close()
  })

  it('lists each person once, in the order they first wrote', async () => {
    await authored('s1', 'bob', 100)
    await authored('s1', 'ann', 200)
    await authored('s1', 'bob', 300)
    await authored('s2', 'cat', 50)

    const result = await getSessionParticipants('agent-a', ['s1', 's2'])
    expect(result.get('s1')?.map(p => p.id)).toEqual(['bob', 'ann'])
    expect(result.get('s1')?.[0]).toMatchObject({ name: 'BOB', email: 'bob@co.com' })
    expect(result.get('s2')?.map(p => p.id)).toEqual(['cat'])
  })

  it('leaves out integration authors, other agents and sessions not asked for', async () => {
    await authored('s1', null, 100)
    await authored('s1', 'ann', 200, 'agent-b')
    await authored('s3', 'ann', 300)

    const result = await getSessionParticipants('agent-a', ['s1'])
    expect(result.size).toBe(0)
  })

  it('leaves out the person billed for a message another agent sent', async () => {
    await testDb.insert(schema.messageAuthor).values({ id: 'm-agent', sessionId: 's1', agentSlug: 'agent-a', billedUserId: 'ann', authorAgentSlug: 'agent-b', createdAt: new Date(100) }).run()
    await authored('s1', 'bob', 200)

    const result = await getSessionParticipants('agent-a', ['s1'])
    expect(result.get('s1')?.map(p => p.id)).toEqual(['bob'])
  })

  it('reads a list longer than the named-id cap', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `s-${i}`)
    await authored('s-1200', 'ann', 100)
    const result = await getSessionParticipants('agent-a', ids)
    expect(result.get('s-1200')?.map(p => p.id)).toEqual(['ann'])
  })

  it('reads nothing for no sessions', async () => {
    await authored('s1', 'ann', 100)
    const statements = countStatements()

    expect((await getSessionParticipants('agent-a', [])).size).toBe(0)
    expect(statements()).toBe(0)
  })

  // The route sends every listed id; 100 is the largest bounded list (?limit=).
  it.each([1, 10, 100, 101, 1500])('reads the participants of %i sessions in one statement', async (count) => {
    await testDb.insert(schema.user).values({ id: 'dan', name: 'DAN', email: 'dan@co.com', emailVerified: true }).run()
    const ids = await seedMixed(count)
    const statements = countStatements()

    const result = await getSessionParticipants('agent-a', ids)

    expect(statements()).toBe(1)
    // The counter sees the statements this replaced: one per 500 ids, then the users if anyone wrote.
    const before = await participantsBeforeSingleRead('agent-a', ids)
    expect(statements()).toBe(1 + Math.ceil(count / 500) + (before.size ? 1 : 0))
    expect(shape(result)).toEqual(shape(before))
  })

  it.each([
    ['a named list', 40],
    ['the whole list', 400],
  ])('answers what the chunked statements did for part of an agent\'s sessions (%s)', async (_name, asked) => {
    await testDb.insert(schema.user).values([
      { id: 'dan', name: 'DAN', email: 'dan@co.com', emailVerified: true },
      { id: 'eve', name: 'Eve', email: 'eve@co.com', emailVerified: false, status: 'invited', avatarOverride: '/api/profile/images/0f8fad5b-d9cb-469f-a165-70867728950e.png' },
    ]).run()
    const all = await seedMixed(600)
    await authored(all[1]!, 'eve', 5)
    // Asked-for ids repeat, and some belong to no session at all.
    const ids = [...all.slice(0, asked), all[1]!, 'no-such-session']

    const result = await getSessionParticipants('agent-a', ids)

    expect(shape(result)).toEqual(shape(await participantsBeforeSingleRead('agent-a', ids)))
    expect(result.get(all[1]!)?.[0]).toMatchObject({ id: 'eve', invited: true })
    expect([...result.keys()].every(id => ids.includes(id))).toBe(true)
    expect([...result.values()].flat().some(p => p.id === 'dan')).toBe(false)
    expect(result.has(all[0]!)).toBe(false)
    expect(result.has(all[asked]!)).toBe(false)
  })

  it.each([10, 400])('drops a deleted user from every session (%i sessions)', async (count) => {
    await testDb.insert(schema.user).values({ id: 'dan', name: 'DAN', email: 'dan@co.com', emailVerified: true }).run()
    const ids = await seedMixed(count)
    await testDb.delete(schema.user).where(eq(schema.user.id, 'ann')).run()

    const result = await getSessionParticipants('agent-a', ids)

    expect([...result.values()].flat().some(p => p.id === 'ann')).toBe(false)
    expect(shape(result)).toEqual(shape(await participantsBeforeSingleRead('agent-a', ids)))
  })

  it.each([1, 99, 100])('reserves the agent bind for %i session ids on D1', (count) => {
    setMaxBoundParameters(100)
    const ids = Array.from({ length: count }, (_, i) => `s-${i}`)
    expect(sessionParticipantsQuery('agent-a', new Set(ids)).toSQL().params).toEqual([
      'agent-a', ...(count <= 99 ? ids : [JSON.stringify(ids)]),
    ])
  })

  it.each([101, 5000])('binds only the agent for %i session ids', (count) => {
    const ids = new Set(Array.from({ length: count }, (_, i) => `s-${i}`))
    expect(sessionParticipantsQuery('agent-a', ids).toSQL().params).toEqual(['agent-a'])
  })

  it.each([1, 100, 101])('finds the agent\'s rows through the primary key, not a table scan (%i ids)', async (count) => {
    const ids = new Set(Array.from({ length: count }, (_, i) => `s-${i}`))
    const plan = await testDb.all<{ detail: string }>(sql`explain query plan ${sessionParticipantsQuery('agent-a', ids).getSQL()}`)
    const details = plan.map(row => row.detail)
    expect(details.some(detail => /^SEARCH message_author USING .*INDEX sqlite_autoindex_message_author_1 \(agent_slug=\?/.test(detail))).toBe(true)
    expect(details.some(detail => /^SEARCH user USING INDEX sqlite_autoindex_user_1 \(id=\?\)/.test(detail))).toBe(true)
    expect(details.some(detail => detail.startsWith('SCAN message_author') || detail.startsWith('SCAN user'))).toBe(false)
  })
})
