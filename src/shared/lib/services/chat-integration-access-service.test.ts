import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import crypto from 'node:crypto'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

import {
  getChatAccess,
  isChatAllowed,
  decideInboundAccess,
  approveChatAccess,
  denyChatAccess,
  markNoticeSent,
} from './chat-integration-access-service'

describe('chat-integration-access-service', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    const now = Date.now()
    testSqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
         VALUES ('int-tg', 'test-agent', 'telegram', '{}', 1, ?, ?)`,
      )
      .run(now, now)
    testSqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
         VALUES ('int-slack', 'test-agent', 'slack', '{}', 0, ?, ?)`,
      )
      .run(now, now)
  })

  afterEach(() => {
    testSqlite?.close()
  })

  function seedPending(intId: string, chatId: string): string {
    const id = crypto.randomUUID()
    const now = Date.now()
    testSqlite
      .prepare(
        `INSERT INTO chat_integration_access
           (id, integration_id, external_chat_id, status, requested_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, intId, chatId, now, now, now)
    return id
  }

  function setRequireApproval(intId: string, val: boolean): void {
    testSqlite
      .prepare(`UPDATE chat_integrations SET require_approval = ? WHERE id = ?`)
      .run(val ? 1 : 0, intId)
  }

  describe('decideInboundAccess', () => {
    it('bootstraps the first private contact to allowed', () => {
      const d = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private', userId: 'u1' })
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'bootstrapped' })
      expect(getChatAccess('int-tg', 'c1')!.status).toBe('allowed')
      expect(getChatAccess('int-tg', 'c1')!.approvalSource).toBe('auto_first_contact')
    })

    it('second private chat → pending + notice once; reply-once on repeat', () => {
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' })
      const a = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private', preview: 'hi' })
      expect(a).toEqual({ action: 'blocked', sendNotice: true, status: 'pending' })
      markNoticeSent(getChatAccess('int-tg', 'c2')!.id)
      const b = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' })
      expect(b.sendNotice).toBe(false)
    })

    it('retries notice when prior send was not marked sent', () => {
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' }) // bootstrap
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' }) // pending, NOT marked
      const retry = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' })
      expect(retry.sendNotice).toBe(true) // requestNoticeSentAt still null
    })

    it('never bootstraps a group even as first contact', () => {
      const d = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group' })
      expect(d.action).toBe('blocked')
      expect(getChatAccess('int-tg', 'g1')!.status).toBe('pending')
    })

    it('forwards allowed, drops denied silently', () => {
      const id = seedPending('int-tg', 'c9'); approveChatAccess(id, 'local')
      expect(decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c9', chatType: 'private' }).action).toBe('forward')
      denyChatAccess(id, 'local')
      expect(decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c9', chatType: 'private' })).toEqual({ action: 'blocked', sendNotice: false, status: 'denied' })
    })

    it('caps pending+denied combined', () => {
      for (let i = 0; i < 100; i++) { const id = seedPending('int-tg', 'p' + i); if (i % 2) denyChatAccess(id, 'local') }
      const d = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'overflow', chatType: 'group' })
      expect(d).toEqual({ action: 'blocked', sendNotice: false, status: 'pending' })
      expect(getChatAccess('int-tg', 'overflow')).toBeNull() // not inserted
    })

    it('only one of two first private contacts bootstraps', () => {
      const a = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' })
      const b = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' })
      const allowed = ['c1', 'c2'].filter((c) => getChatAccess('int-tg', c)!.status === 'allowed')
      expect(allowed).toHaveLength(1)
      expect([a.status, b.status].sort()).toEqual(['bootstrapped', 'pending'])
    })
  })

  describe('isChatAllowed', () => {
    it('public bot (requireApproval false) → true', () => {
      setRequireApproval('int-tg', false)
      expect(isChatAllowed('int-tg', 'x')).toBe(true)
    })
    it('non-telegram provider → true', () => {
      expect(isChatAllowed('int-slack', 'c')).toBe(true)
    })
    it('unknown integration → false (fail closed)', () => {
      expect(isChatAllowed('nope', 'c')).toBe(false)
    })
  })
})
