import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

import {
  getChatAccess,
  decideInboundAccess,
  markNoticeSent,
  approveChatAccess,
} from './chat-integration-access-service'

describe('chat-integration-access-service — pending→approve→forward e2e', () => {
  const INT_ID = 'int-tg-e2e'

  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    const now = Date.now()
    testSqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
         VALUES (?, 'test-agent', 'telegram', '{}', 1, ?, ?)`,
      )
      .run(INT_ID, now, now)
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('drives the full pending→approve→forward flow', () => {
    // Step 1: first private contact → bootstrapped as allowed
    const d1 = decideInboundAccess({
      integrationId: INT_ID,
      externalChatId: 'chat-alice',
      chatType: 'private',
      userId: 'u-alice',
    })
    expect(d1).toEqual({ action: 'forward', sendNotice: false, status: 'bootstrapped' })

    const row1 = getChatAccess(INT_ID, 'chat-alice')
    expect(row1).not.toBeNull()
    expect(row1!.status).toBe('allowed')
    expect(row1!.approvalSource).toBe('auto_first_contact')

    // Step 2: second private contact → blocked + pending + sendNotice:true
    const d2 = decideInboundAccess({
      integrationId: INT_ID,
      externalChatId: 'chat-bob',
      chatType: 'private',
      userId: 'u-bob',
      preview: 'hello there',
    })
    expect(d2).toEqual({ action: 'blocked', sendNotice: true, status: 'pending' })

    const row2 = getChatAccess(INT_ID, 'chat-bob')
    expect(row2).not.toBeNull()
    expect(row2!.status).toBe('pending')
    expect(row2!.requestNoticeSentAt).toBeNull()

    // Step 2b: mark notice sent → subsequent call returns sendNotice:false (reply-once)
    markNoticeSent(row2!.id)

    const d2b = decideInboundAccess({
      integrationId: INT_ID,
      externalChatId: 'chat-bob',
      chatType: 'private',
    })
    expect(d2b).toEqual({ action: 'blocked', sendNotice: false, status: 'pending' })

    const row2b = getChatAccess(INT_ID, 'chat-bob')
    expect(row2b!.requestNoticeSentAt).not.toBeNull()

    // Step 3: approve the pending row → returns true; row flips to allowed
    const approved = approveChatAccess(row2!.id, 'local')
    expect(approved).toBe(true)

    const row2Approved = getChatAccess(INT_ID, 'chat-bob')
    expect(row2Approved!.status).toBe('allowed')
    expect(row2Approved!.approvalSource).toBe('owner')
    expect(row2Approved!.decidedByUserId).toBe('local')

    // Step 4: next message from approved chat → forward
    const d3 = decideInboundAccess({
      integrationId: INT_ID,
      externalChatId: 'chat-bob',
      chatType: 'private',
    })
    expect(d3).toEqual({ action: 'forward', sendNotice: false, status: 'allowed' })

    // Sanity: first contact (alice) still allowed and unaffected
    expect(getChatAccess(INT_ID, 'chat-alice')!.status).toBe('allowed')
  })
})
