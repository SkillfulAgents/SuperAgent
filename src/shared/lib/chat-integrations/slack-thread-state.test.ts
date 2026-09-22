import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'
import { createSlackThreadStateStore, MAX_TRACKED_SLACK_THREADS } from './slack-thread-state'

let testDir: string
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
vi.mock('@shared/lib/db', () => ({ get db() { return db } }))

function openDatabase() {
  sqlite = new Database(path.join(testDir, 'superagent.db'))
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
}

function addSession(integrationId: string, externalChatId: string, archived = false) {
  const id = crypto.randomUUID()
  db.insert(schema.chatIntegrationSessions).values({
    id, integrationId, externalChatId, sessionId: id,
    createdAt: new Date(), updatedAt: new Date(), archivedAt: archived ? new Date() : null,
  }).run()
}

beforeEach(async () => {
  testDir = mkdtempSync(path.join(tmpdir(), 'slack-thread-state-'))
  openDatabase()
  for (const id of ['integration-a', 'integration-b']) {
    db.insert(schema.chatIntegrations).values({
      id, agentSlug: 'agent', provider: 'slack', config: '{}', createdAt: new Date(), updatedAt: new Date(),
    }).run()
  }
})
afterEach(async () => {
  sqlite.close()
  rmSync(testDir, { recursive: true, force: true })
})

describe('durable Slack thread participation', () => {
  it('retains all shared-session thread anchors when the database and store reopen', async () => {
    addSession('integration-a', 'C123') // one session for both threads
    const store = createSlackThreadStateStore('integration-a')
    await store.load('U_BOT')
    await store.save('U_BOT', ['C123|1000.001', 'C123|2000.001'])
    sqlite.close()
    openDatabase()

    expect(await createSlackThreadStateStore('integration-a').load('U_BOT'))
      .toEqual(['C123|1000.001', 'C123|2000.001'])
    expect(await createSlackThreadStateStore('integration-b').load('U_BOT')).toEqual([])
  })

  it('backfills existing active thread mappings once without admitting channel-wide or archived sessions', async () => {
    addSession('integration-a', 'C123|1000.001')
    addSession('integration-a', 'C123|1000.001') // legacy duplicate mapping
    addSession('integration-a', 'C123')
    addSession('integration-a', 'D123')
    addSession('integration-a', 'C123|2000.001', true)
    addSession('integration-b', 'C123|3000.001')
    const store = createSlackThreadStateStore('integration-a')
    expect((await store.load('U_BOT'))).toEqual(['C123|1000.001'])

    // Once state exists it is authoritative; evicted keys must not return on restart.
    await store.save('U_BOT', ['C123|4000.001'])
    expect(await createSlackThreadStateStore('integration-a').load('U_BOT')).toEqual(['C123|4000.001'])
  })

  it('retains participation after session archive, matching /clear without a restart', async () => {
    addSession('integration-a', 'C123|1000.001')
    const store = createSlackThreadStateStore('integration-a')
    await store.load('U_BOT')
    db.update(schema.chatIntegrationSessions).set({ archivedAt: new Date() }).run()
    expect(await createSlackThreadStateStore('integration-a').load('U_BOT')).toEqual(['C123|1000.001'])
  })

  it('resets participation when an installation switches bot identities, without reseeding old sessions', async () => {
    addSession('integration-a', 'C123|1000.001')
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
    db.delete(schema.chatIntegrations).where(eq(schema.chatIntegrations.id, 'integration-a')).run()
    expect(db.select().from(schema.slackThreadState).all()).toEqual([{
      integrationId: 'integration-b', botUserId: 'U_BOT', activeThreads: ['C123|2000.001'],
    }])
  })
})
