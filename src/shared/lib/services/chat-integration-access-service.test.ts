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
  revokeChatAccess,
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

    // ── Short-circuit matrix (asserted directly on decideInboundAccess) ──
    // These branches fail/pass without ever consulting the access table, so the
    // invariant is "decision returned AND no row written".
    it('unknown integration → blocked/denied, no row written (fail closed)', () => {
      const d = decideInboundAccess({ integrationId: 'nope', externalChatId: 'c1', chatType: 'private' })
      expect(d).toEqual({ action: 'blocked', sendNotice: false, status: 'denied' })
      expect(getChatAccess('nope', 'c1')).toBeNull()
    })

    it('non-telegram integration → forward/allowed, no row written', () => {
      const d = decideInboundAccess({ integrationId: 'int-slack', externalChatId: 'c1', chatType: 'private' })
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'allowed' })
      expect(getChatAccess('int-slack', 'c1')).toBeNull()
    })

    it('non-telegram with requireApproval=true → forward/allowed, no row written (default-flip safety)', () => {
      // require_approval now defaults true for ALL providers; the provider check
      // must still short-circuit non-telegram before the flag is consulted, so a
      // reorder of the OR can't silently start gating Slack/iMessage.
      setRequireApproval('int-slack', true)
      const d = decideInboundAccess({ integrationId: 'int-slack', externalChatId: 'c1', chatType: 'private' })
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'allowed' })
      expect(getChatAccess('int-slack', 'c1')).toBeNull()
    })

    it('telegram with requireApproval=false → forward/allowed, no row written', () => {
      setRequireApproval('int-tg', false)
      const d = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' })
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'allowed' })
      expect(getChatAccess('int-tg', 'c1')).toBeNull()
    })

    it('never bootstraps a supergroup even as first contact', () => {
      const d = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'sg1', chatType: 'supergroup' })
      expect(d.action).toBe('blocked')
      expect(getChatAccess('int-tg', 'sg1')!.status).toBe('pending')
    })

    // ── Cap boundary (NONALLOWED_CAP = 100) ──
    it('99 non-allowed rows still admits a new pending insert (boundary)', () => {
      for (let i = 0; i < 99; i++) { const id = seedPending('int-tg', 'p' + i); if (i % 2) denyChatAccess(id, 'local') }
      const d = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'edge', chatType: 'group' })
      expect(d).toEqual({ action: 'blocked', sendNotice: true, status: 'pending' })
      expect(getChatAccess('int-tg', 'edge')!.status).toBe('pending')
    })

    it('allowed rows do not count toward the non-allowed cap', () => {
      for (let i = 0; i < 50; i++) { const id = seedPending('int-tg', 'a' + i); approveChatAccess(id, 'local') }
      for (let i = 0; i < 99; i++) { seedPending('int-tg', 'n' + i) }
      const d = decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'admit-me', chatType: 'group' })
      expect(d.status).toBe('pending')
      expect(getChatAccess('int-tg', 'admit-me')!.status).toBe('pending')
    })
  })

  describe('refreshPending (repeat pending contact)', () => {
    it('updates changed metadata but leaves requestNoticeSentAt untouched', () => {
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'Old', chatName: 'OldTitle', preview: 'old' })
      const id = getChatAccess('int-tg', 'g1')!.id
      markNoticeSent(id)
      const sentAt = getChatAccess('int-tg', 'g1')!.requestNoticeSentAt
      expect(sentAt).not.toBeNull()

      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'New', chatName: 'NewTitle', preview: 'new' })
      const row = getChatAccess('int-tg', 'g1')!
      expect(row.firstUserName).toBe('New')
      expect(row.title).toBe('NewTitle')
      expect(row.firstMessagePreview).toBe('new')
      expect(row.requestNoticeSentAt!.getTime()).toBe(sentAt!.getTime())
    })

    it('identical metadata is a no-op that does not bump updatedAt', () => {
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'U', chatName: 'T', preview: 'p' })
      const before = getChatAccess('int-tg', 'g1')!.updatedAt.getTime()
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'U', chatName: 'T', preview: 'p' })
      const after = getChatAccess('int-tg', 'g1')!.updatedAt.getTime()
      expect(after).toBe(before)
    })

    it('truncates an updated preview to 200 chars', () => {
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', preview: 'short' })
      decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', preview: 'x'.repeat(250) })
      expect(getChatAccess('int-tg', 'g1')!.firstMessagePreview!.length).toBe(200)
    })
  })

  describe('state-guarded transitions (wrong-state matrix)', () => {
    it('approve from denied → true, row becomes allowed/owner', () => {
      const id = seedPending('int-tg', 'c1'); denyChatAccess(id, 'local')
      expect(approveChatAccess(id, 'owner')).toBe(true)
      const row = getChatAccess('int-tg', 'c1')!
      expect(row.status).toBe('allowed')
      expect(row.approvalSource).toBe('owner')
    })

    it('approve from allowed → false (no-op), row unchanged', () => {
      const id = seedPending('int-tg', 'c1'); approveChatAccess(id, 'local')
      expect(approveChatAccess(id, 'owner')).toBe(false)
      expect(getChatAccess('int-tg', 'c1')!.status).toBe('allowed')
    })

    it('deny from denied → false (no-op), row unchanged', () => {
      const id = seedPending('int-tg', 'c1'); denyChatAccess(id, 'local')
      expect(denyChatAccess(id, 'owner')).toBe(false)
      expect(getChatAccess('int-tg', 'c1')!.status).toBe('denied')
    })

    it('revoke from pending → false, row stays pending', () => {
      const id = seedPending('int-tg', 'c1')
      expect(revokeChatAccess(id, 'owner')).toBe(false)
      expect(getChatAccess('int-tg', 'c1')!.status).toBe('pending')
    })

    it('revoke from denied → false, row stays denied', () => {
      const id = seedPending('int-tg', 'c1'); denyChatAccess(id, 'local')
      expect(revokeChatAccess(id, 'owner')).toBe(false)
      expect(getChatAccess('int-tg', 'c1')!.status).toBe('denied')
    })

    it('unknown id → false for approve/deny/revoke', () => {
      expect(approveChatAccess('missing', 'owner')).toBe(false)
      expect(denyChatAccess('missing', 'owner')).toBe(false)
      expect(revokeChatAccess('missing', 'owner')).toBe(false)
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
    it('non-telegram with requireApproval true → true (default-flip safety)', () => {
      setRequireApproval('int-slack', true)
      expect(isChatAllowed('int-slack', 'c')).toBe(true)
    })
    it('unknown integration → false (fail closed)', () => {
      expect(isChatAllowed('nope', 'c')).toBe(false)
    })

    // ── Status matrix for a telegram + requireApproval integration ──
    it('allowed row → true', () => {
      const id = seedPending('int-tg', 'c1'); approveChatAccess(id, 'owner')
      expect(isChatAllowed('int-tg', 'c1')).toBe(true)
    })
    it('pending row → false', () => {
      seedPending('int-tg', 'c1')
      expect(isChatAllowed('int-tg', 'c1')).toBe(false)
    })
    it('denied row → false', () => {
      const id = seedPending('int-tg', 'c1'); denyChatAccess(id, 'owner')
      expect(isChatAllowed('int-tg', 'c1')).toBe(false)
    })
    it('no row → false', () => {
      expect(isChatAllowed('int-tg', 'no-row')).toBe(false)
    })
  })
})
