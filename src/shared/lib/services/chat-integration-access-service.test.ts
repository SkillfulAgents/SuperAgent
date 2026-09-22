import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('../db', () => ({
  get db() { return testDb },
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
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db

    const now = new Date()
    await testDb.insert(schema.chatIntegrations).values([
      { id: 'int-tg', agentSlug: 'test-agent', provider: 'telegram', config: '{}', requireApproval: true, createdAt: now, updatedAt: now },
      { id: 'int-slack', agentSlug: 'test-agent', provider: 'slack', config: '{}', requireApproval: false, createdAt: now, updatedAt: now },
    ]).run()
  })

  afterEach(async () => {
    await handle.close()
  })

  async function seedPending(intId: string, chatId: string): Promise<string> {
    const id = crypto.randomUUID()
    const now = new Date()
    await testDb.insert(schema.chatIntegrationAccess).values({
      id, integrationId: intId, externalChatId: chatId, status: 'pending', requestedAt: now, createdAt: now, updatedAt: now,
    }).run()
    return id
  }

  async function setRequireApproval(intId: string, val: boolean): Promise<void> {
    await testDb.update(schema.chatIntegrations).set({ requireApproval: val }).where(eq(schema.chatIntegrations.id, intId)).run()
  }

  describe('decideInboundAccess', () => {
    it('bootstraps the first private contact to allowed', async () => {
      const d = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private', userId: 'u1' }))
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'bootstrapped' })
      expect((await getChatAccess('int-tg', 'c1'))!.status).toBe('allowed')
      expect((await getChatAccess('int-tg', 'c1'))!.approvalSource).toBe('auto_first_contact')
    })

    it('second private chat → pending + notice once; reply-once on repeat', async () => {
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' })
      const a = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private', preview: 'hi' }))
      expect(a).toEqual({ action: 'blocked', sendNotice: true, status: 'pending' })
      await markNoticeSent((await getChatAccess('int-tg', 'c2'))!.id)
      const b = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' }))
      expect(b.sendNotice).toBe(false)
    })

    it('retries notice when prior send was not marked sent', async () => {
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' }) // bootstrap
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' }) // pending, NOT marked
      const retry = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' }))
      expect(retry.sendNotice).toBe(true) // requestNoticeSentAt still null
    })

    it('never bootstraps a group even as first contact', async () => {
      const d = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group' }))
      expect(d.action).toBe('blocked')
      expect((await getChatAccess('int-tg', 'g1'))!.status).toBe('pending')
    })

    it('forwards allowed, drops denied silently', async () => {
      const id = await seedPending('int-tg', 'c9'); (await approveChatAccess(id, 'local'))
      expect((await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c9', chatType: 'private' })).action).toBe('forward')
      await denyChatAccess(id, 'local')
      expect((await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c9', chatType: 'private' }))).toEqual({ action: 'blocked', sendNotice: false, status: 'denied' })
    })

    it('caps pending+denied combined', async () => {
      for (let i = 0; i < 100; i++) { const id = await seedPending('int-tg', 'p' + i); if (i % 2) (await denyChatAccess(id, 'local')) }
      const d = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'overflow', chatType: 'group' }))
      expect(d).toEqual({ action: 'blocked', sendNotice: false, status: 'pending' })
      expect((await getChatAccess('int-tg', 'overflow'))).toBeNull() // not inserted
    })

    it('only one of two first private contacts bootstraps', async () => {
      const a = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' }))
      const b = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c2', chatType: 'private' }))
      const statuses = await Promise.all(['c1', 'c2'].map(async (c) => (await getChatAccess('int-tg', c))!.status))
      const allowed = statuses.filter((status) => status === 'allowed')
      expect(allowed).toHaveLength(1)
      expect([a.status, b.status].sort()).toEqual(['bootstrapped', 'pending'])
    })

    // ── Short-circuit matrix (asserted directly on decideInboundAccess) ──
    // These branches fail/pass without ever consulting the access table, so the
    // invariant is "decision returned AND no row written".
    it('unknown integration → blocked/denied, no row written (fail closed)', async () => {
      const d = (await decideInboundAccess({ integrationId: 'nope', externalChatId: 'c1', chatType: 'private' }))
      expect(d).toEqual({ action: 'blocked', sendNotice: false, status: 'denied' })
      expect((await getChatAccess('nope', 'c1'))).toBeNull()
    })

    it('non-telegram integration → forward/allowed, no row written', async () => {
      const d = (await decideInboundAccess({ integrationId: 'int-slack', externalChatId: 'c1', chatType: 'private' }))
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'allowed' })
      expect((await getChatAccess('int-slack', 'c1'))).toBeNull()
    })

    it('non-telegram with requireApproval=true → forward/allowed, no row written (default-flip safety)', async () => {
      // require_approval now defaults true for ALL providers; the provider check
      // must still short-circuit non-telegram before the flag is consulted, so a
      // reorder of the OR can't silently start gating Slack/iMessage.
      await setRequireApproval('int-slack', true)
      const d = (await decideInboundAccess({ integrationId: 'int-slack', externalChatId: 'c1', chatType: 'private' }))
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'allowed' })
      expect((await getChatAccess('int-slack', 'c1'))).toBeNull()
    })

    it('telegram with requireApproval=false → forward/allowed, no row written', async () => {
      await setRequireApproval('int-tg', false)
      const d = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'c1', chatType: 'private' }))
      expect(d).toEqual({ action: 'forward', sendNotice: false, status: 'allowed' })
      expect((await getChatAccess('int-tg', 'c1'))).toBeNull()
    })

    it('never bootstraps a supergroup even as first contact', async () => {
      const d = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'sg1', chatType: 'supergroup' }))
      expect(d.action).toBe('blocked')
      expect((await getChatAccess('int-tg', 'sg1'))!.status).toBe('pending')
    })

    // ── Cap boundary (NONALLOWED_CAP = 100) ──
    it('99 non-allowed rows still admits a new pending insert (boundary)', async () => {
      for (let i = 0; i < 99; i++) { const id = await seedPending('int-tg', 'p' + i); if (i % 2) (await denyChatAccess(id, 'local')) }
      const d = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'edge', chatType: 'group' }))
      expect(d).toEqual({ action: 'blocked', sendNotice: true, status: 'pending' })
      expect((await getChatAccess('int-tg', 'edge'))!.status).toBe('pending')
    })

    it('allowed rows do not count toward the non-allowed cap', async () => {
      for (let i = 0; i < 50; i++) { const id = await seedPending('int-tg', 'a' + i); (await approveChatAccess(id, 'local')) }
      for (let i = 0; i < 99; i++) { await seedPending('int-tg', 'n' + i) }
      const d = (await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'admit-me', chatType: 'group' }))
      expect(d.status).toBe('pending')
      expect((await getChatAccess('int-tg', 'admit-me'))!.status).toBe('pending')
    })
  })

  describe('refreshPending (repeat pending contact)', () => {
    it('updates changed metadata but leaves requestNoticeSentAt untouched', async () => {
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'Old', chatName: 'OldTitle', preview: 'old' })
      const id = (await getChatAccess('int-tg', 'g1'))!.id
      await markNoticeSent(id)
      const sentAt = (await getChatAccess('int-tg', 'g1'))!.requestNoticeSentAt
      expect(sentAt).not.toBeNull()

      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'New', chatName: 'NewTitle', preview: 'new' })
      const row = (await getChatAccess('int-tg', 'g1'))!
      expect(row.firstUserName).toBe('New')
      expect(row.title).toBe('NewTitle')
      expect(row.firstMessagePreview).toBe('new')
      expect(row.requestNoticeSentAt!.getTime()).toBe(sentAt!.getTime())
    })

    it('identical metadata is a no-op that does not bump updatedAt', async () => {
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'U', chatName: 'T', preview: 'p' })
      const before = (await getChatAccess('int-tg', 'g1'))!.updatedAt.getTime()
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', userName: 'U', chatName: 'T', preview: 'p' })
      const after = (await getChatAccess('int-tg', 'g1'))!.updatedAt.getTime()
      expect(after).toBe(before)
    })

    it('truncates an updated preview to 200 chars', async () => {
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', preview: 'short' })
      await decideInboundAccess({ integrationId: 'int-tg', externalChatId: 'g1', chatType: 'group', preview: 'x'.repeat(250) })
      expect((await getChatAccess('int-tg', 'g1'))!.firstMessagePreview!.length).toBe(200)
    })
  })

  describe('state-guarded transitions (wrong-state matrix)', () => {
    it('approve from denied → true, row becomes allowed/owner', async () => {
      const id = await seedPending('int-tg', 'c1'); (await denyChatAccess(id, 'local'))
      expect((await approveChatAccess(id, 'owner'))).toBe(true)
      const row = (await getChatAccess('int-tg', 'c1'))!
      expect(row.status).toBe('allowed')
      expect(row.approvalSource).toBe('owner')
    })

    it('approve from allowed → false (no-op), row unchanged', async () => {
      const id = await seedPending('int-tg', 'c1'); (await approveChatAccess(id, 'local'))
      expect((await approveChatAccess(id, 'owner'))).toBe(false)
      expect((await getChatAccess('int-tg', 'c1'))!.status).toBe('allowed')
    })

    it('deny from denied → false (no-op), row unchanged', async () => {
      const id = await seedPending('int-tg', 'c1'); (await denyChatAccess(id, 'local'))
      expect((await denyChatAccess(id, 'owner'))).toBe(false)
      expect((await getChatAccess('int-tg', 'c1'))!.status).toBe('denied')
    })

    it('revoke from pending → false, row stays pending', async () => {
      const id = await seedPending('int-tg', 'c1')
      expect((await revokeChatAccess(id, 'owner'))).toBe(false)
      expect((await getChatAccess('int-tg', 'c1'))!.status).toBe('pending')
    })

    it('revoke from denied → false, row stays denied', async () => {
      const id = await seedPending('int-tg', 'c1'); (await denyChatAccess(id, 'local'))
      expect((await revokeChatAccess(id, 'owner'))).toBe(false)
      expect((await getChatAccess('int-tg', 'c1'))!.status).toBe('denied')
    })

    it('unknown id → false for approve/deny/revoke', async () => {
      expect((await approveChatAccess('missing', 'owner'))).toBe(false)
      expect((await denyChatAccess('missing', 'owner'))).toBe(false)
      expect((await revokeChatAccess('missing', 'owner'))).toBe(false)
    })
  })

  describe('isChatAllowed', () => {
    it('public bot (requireApproval false) → true', async () => {
      await setRequireApproval('int-tg', false)
      expect((await isChatAllowed('int-tg', 'x'))).toBe(true)
    })
    it('non-telegram provider → true', async () => {
      expect((await isChatAllowed('int-slack', 'c'))).toBe(true)
    })
    it('non-telegram with requireApproval true → true (default-flip safety)', async () => {
      await setRequireApproval('int-slack', true)
      expect((await isChatAllowed('int-slack', 'c'))).toBe(true)
    })
    it('unknown integration → false (fail closed)', async () => {
      expect((await isChatAllowed('nope', 'c'))).toBe(false)
    })

    // ── Status matrix for a telegram + requireApproval integration ──
    it('allowed row → true', async () => {
      const id = await seedPending('int-tg', 'c1'); (await approveChatAccess(id, 'owner'))
      expect((await isChatAllowed('int-tg', 'c1'))).toBe(true)
    })
    it('pending row → false', async () => {
      await seedPending('int-tg', 'c1')
      expect((await isChatAllowed('int-tg', 'c1'))).toBe(false)
    })
    it('denied row → false', async () => {
      const id = await seedPending('int-tg', 'c1'); (await denyChatAccess(id, 'owner'))
      expect((await isChatAllowed('int-tg', 'c1'))).toBe(false)
    })
    it('no row → false', async () => {
      expect((await isChatAllowed('int-tg', 'no-row'))).toBe(false)
    })
  })
})
