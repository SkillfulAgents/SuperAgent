import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { eq } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'
import { createSlackThreadStateStore, MAX_TRACKED_SLACK_THREADS } from './slack-thread-state'

let handle: TestDatabase
let db: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return db } }))

async function addSession(integrationId: string, externalChatId: string, archived = false) {
  const id = crypto.randomUUID()
  await db.insert(schema.chatIntegrationSessions).values({
    id, integrationId, externalChatId, sessionId: id,
    createdAt: new Date(), updatedAt: new Date(), archivedAt: archived ? new Date() : null,
  }).run()
}

beforeEach(async () => {
  handle = await createTestDatabase()
  db = handle.db
  for (const id of ['integration-a', 'integration-b']) {
    await db.insert(schema.chatIntegrations).values({
      id, agentSlug: 'agent', provider: 'slack', config: '{}', createdAt: new Date(), updatedAt: new Date(),
    }).run()
  }
})
afterEach(async () => {
  await handle.close()
})

describe('durable Slack thread participation', () => {
  it('retains all shared-session thread anchors when the integration store is recreated', async () => {
    await addSession('integration-a', 'C123') // one session for both threads
    const store = createSlackThreadStateStore('integration-a')
    await store.load('U_BOT')
    await store.save('U_BOT', ['C123|1000.001', 'C123|2000.001'])

    expect(await createSlackThreadStateStore('integration-a').load('U_BOT'))
      .toEqual(['C123|1000.001', 'C123|2000.001'])
    expect(await createSlackThreadStateStore('integration-b').load('U_BOT')).toEqual([])
  })

  it('backfills existing active thread mappings once without admitting channel-wide or archived sessions', async () => {
    await addSession('integration-a', 'C123|1000.001')
    await addSession('integration-a', 'C123|1000.001') // legacy duplicate mapping
    await addSession('integration-a', 'C123')
    await addSession('integration-a', 'D123')
    await addSession('integration-a', 'C123|2000.001', true)
    await addSession('integration-b', 'C123|3000.001')
    const store = createSlackThreadStateStore('integration-a')
    expect((await store.load('U_BOT'))).toEqual(['C123|1000.001'])

    // Once state exists it is authoritative; evicted keys must not return on restart.
    await store.save('U_BOT', ['C123|4000.001'])
    expect(await createSlackThreadStateStore('integration-a').load('U_BOT')).toEqual(['C123|4000.001'])
  })

  it('retains participation after session archive, matching /clear without a restart', async () => {
    await addSession('integration-a', 'C123|1000.001')
    const store = createSlackThreadStateStore('integration-a')
    await store.load('U_BOT')
    await db.update(schema.chatIntegrationSessions).set({ archivedAt: new Date() }).run()
    expect(await createSlackThreadStateStore('integration-a').load('U_BOT')).toEqual(['C123|1000.001'])
  })

  it('resets participation when an installation switches bot identities, without reseeding old sessions', async () => {
    await addSession('integration-a', 'C123|1000.001')
    const store = createSlackThreadStateStore('integration-a')
    expect((await store.load('U_BOT'))).toEqual(['C123|1000.001'])
    expect((await store.load('U_OTHER_BOT'))).toEqual([])
    expect(await createSlackThreadStateStore('integration-a').load('U_OTHER_BOT')).toEqual([])
  })

  it('persists only the most recent threads in their LRU order', async () => {
    const keys = Array.from({ length: MAX_TRACKED_SLACK_THREADS + 3 }, (_, i) => `C123|${i}.001`)
    const store = createSlackThreadStateStore('integration-a')
    await store.save('U_BOT', keys)
    expect((await store.load('U_BOT'))).toEqual(keys.slice(3))
  })

  it('removes saved state when the owning integration is deleted', async () => {
    await createSlackThreadStateStore('integration-a').save('U_BOT', ['C123|1000.001'])
    await createSlackThreadStateStore('integration-b').save('U_BOT', ['C123|2000.001'])
    await db.delete(schema.chatIntegrations).where(eq(schema.chatIntegrations.id, 'integration-a')).run()
    expect(await db.select().from(schema.integrationState).all()).toEqual([{
      integrationId: 'integration-b', key: 'slack:participation',
      value: JSON.stringify({ botUserId: 'U_BOT', activeThreads: ['C123|2000.001'] }), availableAt: null,
    }])
  })
})
