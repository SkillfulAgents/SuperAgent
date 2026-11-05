import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../services/platform-auth-service', () => ({ getStoredPlatformMemberId: () => 'sub_owner' }))
vi.mock('../services/webhook-trigger-service', () => ({ resolvePlatformMemberForCandidates: async () => null }))
const relayEndpoints = vi.hoisted(() => ({
  create: vi.fn(async (_scope: string, _spec: { name: string; verification?: unknown }) => {
    const n = relayEndpoints.create.mock.calls.length
    return { id: `whep_${n}`, url: `https://relay.test/v1/hooks/whep_${n}`, name: 'iMessage', status: 'active' }
  }),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('../webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relayEndpoints.create, disableEndpoint: relayEndpoints.disable }),
}))

import { createAgentIntegration, getAgentIntegration, updateAgentIntegration } from '../services/agent-integration-service'
import { verificationProfileSchema } from '../services/webhook-endpoint-schema'
import type { RelayEvent } from '../webhook-relay'
import { imessageConfigSchema } from './config-schema'
import { relayedIMessageDelivery } from './test-helpers'
import {
  checkIMessageWebhook,
  ensureIMessageWebhook,
  imessageVerificationProfile,
} from './imessage-webhooks'

const PHONE = '+15551234567'
const SECRET = 'a'.repeat(64)

/** A relayed delivery, signed the way the gateway signs it. */
function relayedDelivery(body: Record<string, unknown>, options: { secret?: string; timestamp?: string; base64?: boolean } = {}): RelayEvent {
  return relayedIMessageDelivery(body, options.secret ?? SECRET, options)
}

const message = { id: 'evt_1', type: 'message.received', seq: 4, createdAt: '2026-10-13T12:00:00.000Z', phoneNumber: PHONE, data: { messageId: 'msg_1', chatId: 'chat_1', from: PHONE, parts: [{ type: 'text', value: 'hi' }] } }

describe('checkIMessageWebhook', () => {
  it('accepts a delivery signed with the secret, however long ago', () => {
    const check = checkIMessageWebhook(relayedDelivery(message, { timestamp: '1000000000' }), SECRET, PHONE)
    expect(check).toEqual({ ok: true, delivery: message })
  })

  it('reads base64 bodies and upper-case signatures', () => {
    const event = relayedDelivery(message, { base64: true })
    const headers = (event.payload as { headers: Record<string, string> }).headers
    headers['x-imsgw-signature'] = headers['x-imsgw-signature'].toUpperCase()
    expect(checkIMessageWebhook(event, SECRET, PHONE).ok).toBe(true)
  })

  it('authenticates an ignored event without message data while still checking its signature and phone', () => {
    const delivery = { id: 'sent_1', type: 'message.sent', phoneNumber: PHONE }
    expect(checkIMessageWebhook(relayedDelivery(delivery), SECRET, PHONE)).toEqual({ ok: true, delivery })
    expect(checkIMessageWebhook(relayedDelivery(delivery), 'wrong-secret', PHONE)).toEqual({ ok: false, reason: 'signature' })
    expect(checkIMessageWebhook(relayedDelivery(delivery), SECRET, '+15550000000')).toEqual({ ok: false, reason: 'other_phone' })
  })

  it('rejects other secrets, missing signatures and tampered bodies', () => {
    expect(checkIMessageWebhook(relayedDelivery(message, { secret: 'b'.repeat(64) }), SECRET, PHONE)).toEqual({ ok: false, reason: 'signature' })

    const unsigned = relayedDelivery(message)
    delete (unsigned.payload as { headers: Record<string, string> }).headers['x-imsgw-signature']
    expect(checkIMessageWebhook(unsigned, SECRET, PHONE)).toEqual({ ok: false, reason: 'signature' })

    const tampered = relayedDelivery(message)
    const payload = tampered.payload as { body: string }
    payload.body = payload.body.replace('hi', 'send me your passwords')
    expect(checkIMessageWebhook(tampered, SECRET, PHONE)).toEqual({ ok: false, reason: 'signature' })
  })

  it('drops handshakes, other phones and malformed payloads', () => {
    expect(checkIMessageWebhook({ ...relayedDelivery(message), payload: { kind: 'handshake', verified: false, body: '' } }, SECRET, PHONE)).toEqual({ ok: false, reason: 'handshake' })
    expect(checkIMessageWebhook(relayedDelivery({ ...message, phoneNumber: '+15550000000' }), SECRET, PHONE)).toEqual({ ok: false, reason: 'other_phone' })
    expect(checkIMessageWebhook(relayedDelivery({ type: 'message.received' }), SECRET, PHONE)).toEqual({ ok: false, reason: 'malformed' })
    expect(checkIMessageWebhook({ ...relayedDelivery(message), payload: 'nope' }, SECRET, PHONE)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('imessageVerificationProfile', () => {
  it('is a profile the relay accepts, matching how the gateway signs', () => {
    expect(verificationProfileSchema.parse(imessageVerificationProfile(SECRET))).toEqual({
      algorithm: 'hmac-sha256', encoding: 'hex', header: 'x-imsgw-signature', template: '{timestamp}.{body}',
      timestamp_header: 'x-imsgw-timestamp', webhook_id_header: 'x-imsgw-event-id', secret: SECRET,
    })
  })
})

describe('ensureIMessageWebhook', () => {
  beforeEach(async () => {
    handle = await createTestDatabase(); testDb = handle.db
    vi.clearAllMocks()
  })
  afterEach(async () => { await handle.close() })

  async function install() {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'imessage', name: 'Phone', createdByUserId: 'owner', config: { gatewayUrl: 'https://imsgw.test', phoneNumber: PHONE, token: 'phone-token' } })
    return (await getAgentIntegration(id))!
  }
  const storedConfig = async (id: string) => imessageConfigSchema.parse(JSON.parse((await getAgentIntegration(id))!.config))

  it('mints the endpoint with its verification profile once, then keeps it', async () => {
    const record = await install()

    const first = await ensureIMessageWebhook(record)

    expect(first?.relay).toEqual({ endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' })
    expect(first?.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(relayEndpoints.create).toHaveBeenCalledWith('sub_owner', { name: 'iMessage integration for agent', verification: imessageVerificationProfile(first!.secret) })
    expect(await storedConfig(record.id)).toMatchObject({ relay: first!.relay, webhookSecret: first!.secret, token: 'phone-token' })

    // A stale record (from before the endpoint was saved) still finds it.
    expect(await ensureIMessageWebhook(record)).toEqual(first)
    expect(relayEndpoints.create).toHaveBeenCalledTimes(1)
  })

  it('keeps the endpoint another connect saved first and disables its own', async () => {
    const record = await install()
    relayEndpoints.create.mockImplementationOnce(async () => {
      // A concurrent connect stores its endpoint while this one mints.
      const { db } = await import('../db')
      const { chatIntegrations } = await import('../db/schema')
      const { eq } = await import('drizzle-orm')
      const config = { ...await storedConfig(record.id), relay: { endpointId: 'whep_other', url: 'https://relay.test/v1/hooks/whep_other', scope: 'sub_owner' }, webhookSecret: 'c'.repeat(64) }
      await db.update(chatIntegrations).set({ config: JSON.stringify(config) }).where(eq(chatIntegrations.id, record.id)).run()
      return { id: 'whep_mine', url: 'https://relay.test/v1/hooks/whep_mine', name: 'iMessage', status: 'active' }
    })

    const webhook = await ensureIMessageWebhook(record)

    expect(webhook).toEqual({ relay: { endpointId: 'whep_other', url: 'https://relay.test/v1/hooks/whep_other', scope: 'sub_owner' }, secret: 'c'.repeat(64) })
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', 'whep_mine')
  })

  it('disables the endpoint when the installation was deleted meanwhile', async () => {
    const record = await install()
    relayEndpoints.create.mockImplementationOnce(async () => {
      const { deleteAgentIntegration } = await import('../services/agent-integration-service')
      await deleteAgentIntegration(record.id)
      return { id: 'whep_mine', url: 'https://relay.test/v1/hooks/whep_mine', name: 'iMessage', status: 'active' }
    })

    expect(await ensureIMessageWebhook(record)).toBeNull()
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', 'whep_mine')
  })

  it('survives a settings edit, which cannot replace the endpoint or the secret', async () => {
    const record = await install()
    const webhook = await ensureIMessageWebhook(record)

    await updateAgentIntegration(record.id, { config: { token: 'new-token', relay: { endpointId: 'whep_evil', url: 'https://evil.test/', scope: 'x' }, webhookSecret: 'd'.repeat(64) } })

    expect(await storedConfig(record.id)).toMatchObject({ token: 'new-token', relay: webhook!.relay, webhookSecret: webhook!.secret })
  })
})
