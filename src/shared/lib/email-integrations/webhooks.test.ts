import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations } from '../db/schema'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../services/platform-auth-service', () => ({ getStoredPlatformMemberId: () => 'sub_owner' }))
vi.mock('../services/webhook-trigger-service', () => ({
  resolvePlatformMemberForCandidates: async ([userId]: string[]) => userId === 'user-other' ? { userId, memberId: 'sub_other' } : null,
}))
const relayEndpoints = vi.hoisted(() => ({
  create: vi.fn(async (_scope: string, _spec: { name: string; verification?: unknown }) => {
    const n = relayEndpoints.create.mock.calls.length
    return { id: `whep_${n}`, url: `https://relay.test/v1/hooks/whep_${n}`, name: 'Email inboxes', status: 'active' }
  }),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('../webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relayEndpoints.create, disableEndpoint: relayEndpoints.disable }),
}))

import { createAgentIntegration, getAgentIntegration } from '../services/agent-integration-service'
import { verificationProfileSchema } from '../services/webhook-endpoint-schema'
import { releaseIntegrationTransport } from '../agent-integrations/relay-transport'
import { createFakeWebhookRelay, type FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'
import type { RelayEvent } from '../webhook-relay'
import { emailConfigSchema, parseEmailConfig } from './config-schema'
import { EmailRelays, emailVerificationProfile, emailWebhookSigned, ensureEmailWebhook, readEmailWebhook, type EmailWebhook } from './webhooks'

// The Standard Webhooks reference vector (svix's own test case).
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330',
  body: '{"test": 2432232314}', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
}
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
const MAILBOX_A = '00000000-0000-4000-8000-00000000000a'
const MAILBOX_B = '00000000-0000-4000-8000-00000000000b'

/** A relayed gateway post, signed the way the gateway signs it. */
function relayedPost(pointer: { cursor: number; mailboxId: string }, secret = SECRET, eventId = `whe_${pointer.cursor}`): RelayEvent {
  const id = `evt_${pointer.cursor}`, timestamp = '1000000000'
  const body = JSON.stringify({ type: 'message.received', id, messageId: 'message-1', data: {}, createdAt: 1, ...pointer })
  const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')
  return {
    id: eventId, endpointId: 'whep_1', type: 'CUSTOM_WEBHOOK', createdAt: '',
    payload: { kind: 'event', verified: true, headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }, body, body_encoding: 'utf8' },
  }
}

function mailbox(mailboxId: string, extra: Record<string, unknown> = {}) {
  return emailConfigSchema.parse({ localPart: `box-${mailboxId.slice(-1)}`, displayName: 'Helper', mailboxId, address: `box-${mailboxId.slice(-1)}@company.ongamut.so`, platformOrgId: 'org', platformMemberId: 'member', ...extra })
}
const install = (mailboxId: string, createdByUserId?: string) => createAgentIntegration({ agentSlug: `agent-${mailboxId.slice(-1)}`, provider: 'platform-email', config: mailbox(mailboxId), createdByUserId })
const storedConfig = async (id: string) => parseEmailConfig((await getAgentIntegration(id))!.config)

beforeEach(async () => {
  vi.clearAllMocks()
  handle = await createTestDatabase(); testDb = handle.db
})
afterEach(async () => { await handle.close() })

describe('Standard Webhooks signatures', () => {
  const envelope = (headers: Record<string, string>, body = VECTOR.body) => ({ raw: Buffer.from(body), headers })
  const signed = { 'webhook-id': VECTOR.id, 'webhook-timestamp': VECTOR.timestamp, 'webhook-signature': VECTOR.signature }

  it('verifies the reference vector, among several signatures and in any header case, however old', () => {
    const { raw, headers } = envelope(signed)
    expect(emailWebhookSigned(raw, headers, VECTOR.secret)).toBe(true)
    expect(emailWebhookSigned(raw, { 'Webhook-Id': VECTOR.id, 'Webhook-Timestamp': VECTOR.timestamp, 'Webhook-Signature': `v1,bm90IGl0 ${VECTOR.signature}` }, VECTOR.secret)).toBe(true)
  })

  it('rejects another secret, a tampered body, another id and missing headers', () => {
    expect(emailWebhookSigned(Buffer.from(VECTOR.body), signed, SECRET)).toBe(false)
    expect(emailWebhookSigned(Buffer.from('{"test": 1}'), signed, VECTOR.secret)).toBe(false)
    expect(emailWebhookSigned(Buffer.from(VECTOR.body), { ...signed, 'webhook-id': 'msg_other' }, VECTOR.secret)).toBe(false)
    expect(emailWebhookSigned(Buffer.from(VECTOR.body), { 'webhook-signature': VECTOR.signature }, VECTOR.secret)).toBe(false)
    expect(emailWebhookSigned(Buffer.from(VECTOR.body), { ...signed, 'webhook-signature': VECTOR.signature.replace('v1,', 'v2,') }, VECTOR.secret)).toBe(false)
  })

  it('gives the relay a profile that checks the same signature', () => {
    expect(verificationProfileSchema.parse(emailVerificationProfile(SECRET))).toMatchObject({
      header: 'webhook-signature', template: '{webhook_id}.{timestamp}.{body}', timestamp_header: 'webhook-timestamp', webhook_id_header: 'webhook-id', secret_encoding: 'base64',
    })
  })

  it('reads a pointer from base64 bodies and drops handshakes and malformed posts', () => {
    const event = relayedPost({ cursor: 4, mailboxId: MAILBOX_A })
    const payload = event.payload as { body: string; body_encoding: string }
    payload.body = Buffer.from(payload.body).toString('base64'); payload.body_encoding = 'base64'
    const read = readEmailWebhook(event)
    expect(read.ok && read.pointer).toMatchObject({ cursor: 4, mailboxId: MAILBOX_A })
    expect(read.ok && emailWebhookSigned(read.raw, read.headers, SECRET)).toBe(true)

    expect(readEmailWebhook({ ...event, payload: { kind: 'handshake', verified: true, body: '' } })).toEqual({ ok: false, reason: 'handshake' })
    expect(readEmailWebhook({ ...event, payload: { kind: 'event', verified: true, body: '{"cursor":"4"}' } })).toEqual({ ok: false, reason: 'malformed' })
    expect(readEmailWebhook({ ...event, payload: { kind: 'event', verified: true, body: 'not json' } })).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('ensureEmailWebhook', () => {
  it('mints one endpoint with the Standard Webhooks profile and a gateway-valid secret, then reuses it', async () => {
    const id = await install(MAILBOX_A)
    const first = await ensureEmailWebhook({ id, createdByUserId: null })

    expect(first).toEqual({ relay: { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }, secret: expect.stringMatching(/^whsec_/) })
    expect(Buffer.from(first!.secret.slice('whsec_'.length), 'base64')).toHaveLength(32)
    expect(relayEndpoints.create).toHaveBeenCalledWith('sub_owner', { name: 'Email inboxes', verification: emailVerificationProfile(first!.secret) })
    expect(await storedConfig(id)).toMatchObject({ relay: first!.relay, webhookSecret: first!.secret })

    expect(await ensureEmailWebhook({ id, createdByUserId: null })).toEqual(first)
    expect(relayEndpoints.create).toHaveBeenCalledOnce()
  })

  it('shares one endpoint between mailboxes in the same scope, even when they connect together', async () => {
    const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
    const [webhookA, webhookB] = await Promise.all([ensureEmailWebhook({ id: a, createdByUserId: null }), ensureEmailWebhook({ id: b, createdByUserId: null })])

    expect(relayEndpoints.create).toHaveBeenCalledOnce()
    expect(webhookB).toEqual(webhookA)
    expect(await storedConfig(b)).toMatchObject({ relay: webhookA!.relay, webhookSecret: webhookA!.secret })
  })

  it('mints a separate endpoint for a mailbox claimed under another scope', async () => {
    const a = await install(MAILBOX_A)
    const b = await install(MAILBOX_B, 'user-other')
    const webhookA = await ensureEmailWebhook({ id: a, createdByUserId: null })
    const webhookB = await ensureEmailWebhook({ id: b, createdByUserId: 'user-other' })

    expect(relayEndpoints.create).toHaveBeenCalledTimes(2)
    expect(webhookB!.relay).toMatchObject({ endpointId: 'whep_2', scope: 'sub_other' })
    expect(webhookB!.secret).not.toBe(webhookA!.secret)
  })

  it('keeps the cursor and settings written while it stores the endpoint', async () => {
    const id = await install(MAILBOX_A)
    relayEndpoints.create.mockImplementationOnce(async () => {
      await testDb.update(chatIntegrations).set({ config: sql`json_set(${chatIntegrations.config}, '$.eventCursor', 9, '$.displayName', 'Renamed')` }).where(eq(chatIntegrations.id, id)).run()
      return { id: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', name: 'Email inboxes', status: 'active' }
    })
    await ensureEmailWebhook({ id, createdByUserId: null })

    expect(await storedConfig(id)).toMatchObject({ eventCursor: 9, displayName: 'Renamed', relay: { endpointId: 'whep_1' } })
  })

  it('disables a minted endpoint the installation no longer needs', async () => {
    const id = await install(MAILBOX_A)
    relayEndpoints.create.mockImplementationOnce(async () => {
      await testDb.delete(chatIntegrations).where(eq(chatIntegrations.id, id)).run()
      return { id: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', name: 'Email inboxes', status: 'active' }
    })

    expect(await ensureEmailWebhook({ id, createdByUserId: null })).toBeNull()
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', 'whep_1')
  })
})

describe('releasing a shared endpoint', () => {
  it('disables it only when the last installation using it goes', async () => {
    const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
    await ensureEmailWebhook({ id: a, createdByUserId: null })
    await ensureEmailWebhook({ id: b, createdByUserId: null })

    await releaseIntegrationTransport((await getAgentIntegration(a))!)
    expect(relayEndpoints.disable).not.toHaveBeenCalled()
    await testDb.delete(chatIntegrations).where(eq(chatIntegrations.id, a)).run()

    await releaseIntegrationTransport((await getAgentIntegration(b))!)
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', 'whep_1')
  })
})

describe('EmailRelays', () => {
  const webhook: EmailWebhook = { relay: { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }, secret: SECRET }
  const CONSUMER = 'email-integrations:whep_1'
  let relay: FakeWebhookRelay
  let relays: EmailRelays
  beforeEach(() => {
    relay = createFakeWebhookRelay()
    relays = new EmailRelays(() => relay)
  })

  it('registers one consumer per endpoint and wakes each mailbox once, to its newest pointer', async () => {
    const catchUpA = vi.fn(async (cursor: number) => cursor)
    const catchUpB = vi.fn(async () => 7)
    relays.attach(webhook, MAILBOX_A, catchUpA)
    relays.attach(webhook, MAILBOX_B, catchUpB)

    expect([...relay.consumers.keys()]).toEqual([CONSUMER])
    expect(relay.consumers.get(CONSUMER)).toMatchObject({ scope: 'sub_owner', endpointIds: ['whep_1'] })
    const results = await relay.deliver(CONSUMER, [
      relayedPost({ cursor: 3, mailboxId: MAILBOX_A }), relayedPost({ cursor: 5, mailboxId: MAILBOX_A }),
      relayedPost({ cursor: 6, mailboxId: MAILBOX_B }), relayedPost({ cursor: 8, mailboxId: MAILBOX_B }),
    ])

    expect(catchUpA).toHaveBeenCalledExactlyOnceWith(5)
    expect(catchUpB).toHaveBeenCalledExactlyOnceWith(8)
    // B's poll got to 7: the pointer past it waits for another try.
    expect(results).toEqual(new Map([['whe_3', 'accepted'], ['whe_5', 'accepted'], ['whe_6', 'accepted'], ['whe_8', 'retry']]))
  })

  it('retries pointers whose catch-up failed', async () => {
    relays.attach(webhook, MAILBOX_A, async () => { throw new Error('gateway down') })
    expect(await relay.deliver(CONSUMER, [relayedPost({ cursor: 3, mailboxId: MAILBOX_A })])).toEqual(new Map([['whe_3', 'retry']]))
  })

  it('drops posts for detached mailboxes, with bad signatures, and handshakes', async () => {
    const catchUp = vi.fn(async (cursor: number) => cursor)
    relays.attach(webhook, MAILBOX_A, catchUp)
    const handshake: RelayEvent = { id: 'whe_h', endpointId: 'whep_1', type: 'CUSTOM_WEBHOOK', createdAt: '', payload: { kind: 'handshake', verified: true, body: '' } }

    const results = await relay.deliver(CONSUMER, [
      relayedPost({ cursor: 3, mailboxId: MAILBOX_B }),
      relayedPost({ cursor: 4, mailboxId: MAILBOX_A }, `whsec_${Buffer.alloc(32, 9).toString('base64')}`),
      handshake,
    ])

    expect(results).toEqual(new Map([['whe_3', 'discard'], ['whe_4', 'discard'], ['whe_h', 'discard']]))
    expect(catchUp).not.toHaveBeenCalled()
  })

  it('stops claiming when the last mailbox detaches, and resumes at once when one attaches', async () => {
    const first = relays.attach(webhook, MAILBOX_A, async cursor => cursor)
    const other = relays.attach(webhook, MAILBOX_B, async cursor => cursor)
    first.detach()
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual(['whep_1'])
    expect(first.isAttached()).toBe(false)
    other.detach()
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual([])

    const next = relays.attach(webhook, MAILBOX_A, async cursor => cursor)
    expect(next.isAttached()).toBe(true)
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual(['whep_1'])
    expect(relay.log.filter(entry => entry.op === 'register')).toHaveLength(1)
    expect(relay.log.at(-1)).toEqual({ op: 'retryNow', id: CONSUMER })
  })

  it('ignores a stale detach after the mailbox reconnected', async () => {
    const stale = relays.attach(webhook, MAILBOX_A, async () => -1)
    const current = relays.attach(webhook, MAILBOX_A, async cursor => cursor)
    stale.detach()

    expect(current.isAttached()).toBe(true)
    expect(await relay.deliver(CONSUMER, [relayedPost({ cursor: 3, mailboxId: MAILBOX_A })])).toEqual(new Map([['whe_3', 'accepted']]))
  })
})
