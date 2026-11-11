import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { agentSessions } from '@shared/lib/db/schema'
import { createTestDatabase } from '@shared/lib/db/testing/create-test-database'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'
import { createDbSessionIndexStorage, dropDbSessionIndex } from './db-session-index-storage'
import { describeSessionIndexStorageContract } from './testing/session-index-storage-contract'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

describeSessionIndexStorageContract('DbSessionIndexStorage', () => ({
  storage: createDbSessionIndexStorage('agent-one'),
  other: createDbSessionIndexStorage('agent-two'),
}))

describe('DbSessionIndexStorage', () => {
  it('touches no database until an operation runs', () => {
    const select = vi.spyOn(database.db, 'select')
    createDbSessionIndexStorage('agent-one')
    expect(select).not.toHaveBeenCalled()
  })

  it('runs on the handle it is given', async () => {
    // A data migration's handle: not the one the app publishes.
    const migrating = await createTestDatabase()
    try {
      const storage = createDbSessionIndexStorage('agent-one', migrating.db)
      await storage.fill([{ sessionId: 's1', meta: { name: 'First' }, transcript: null }])
      await storage.update('s1', (current) => ({ ...current?.meta, starred: true }))
      await storage.touch(new Map([['s1', 5]]))

      expect((await storage.get('s1'))?.meta).toEqual({ name: 'First', starred: true })
      expect(await createDbSessionIndexStorage('agent-one').list()).toEqual([])
    } finally {
      await migrating.close()
    }
  })

  it('hands out a row whose stored metadata it cannot read as one without metadata, and the rest as they are', async () => {
    await database.db.insert(agentSessions).values([
      { agentSlug: 'agent-one', sessionId: 'wrong-shape', metadata: '{"name":42}', transcriptMtimeMs: 5, transcriptBirthtimeMs: 1, transcriptSize: 9 },
      { agentSlug: 'agent-one', sessionId: 'not-json', metadata: '{"name":' },
      { agentSlug: 'agent-one', sessionId: 'fine', metadata: '{"name":"Fine"}' },
    ]).run()
    const storage = createDbSessionIndexStorage('agent-one')

    expect((await storage.list()).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: 'fine', meta: { name: 'Fine' }, transcript: null },
      { sessionId: 'not-json', meta: null, transcript: null },
      { sessionId: 'wrong-shape', meta: null, transcript: { mtimeMs: 5, birthtimeMs: 1, size: 9 } },
    ])
    // And it can be given metadata again.
    await storage.update('wrong-shape', () => ({ name: 'Renamed' }))
    expect((await storage.get('wrong-shape'))?.meta).toEqual({ name: 'Renamed' })
  })

  it('drops every entry of an agent, and only that agent\'s', async () => {
    const one = createDbSessionIndexStorage('agent-one')
    const two = createDbSessionIndexStorage('agent-two')
    await one.update('s1', () => ({ name: 'One' }))
    await one.fill([{ sessionId: 's2', meta: null, transcript: { mtimeMs: 1, birthtimeMs: 0, size: 1 } }])
    await two.update('s1', () => ({ name: 'Two' }))

    await dropDbSessionIndex('agent-one')

    expect(await one.list()).toEqual([])
    expect(await database.db.select().from(agentSessions).where(eq(agentSessions.agentSlug, 'agent-two')).all()).toHaveLength(1)
  })
})
