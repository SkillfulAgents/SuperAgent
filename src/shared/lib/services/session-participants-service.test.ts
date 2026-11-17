import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('../db', () => ({
  get db() { return testDb },
}))

import { getSessionParticipants } from './session-participants-service'

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

  it('reads past one chunk of session ids', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `s-${i}`)
    await authored('s-1200', 'ann', 100)
    const result = await getSessionParticipants('agent-a', ids)
    expect(result.get('s-1200')?.map(p => p.id)).toEqual(['ann'])
  })
})
