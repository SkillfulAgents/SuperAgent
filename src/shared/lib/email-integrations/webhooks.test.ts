import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations } from '../db/schema'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../db', () => ({ get db() { return testDb } }))
const reported = vi.hoisted(() => vi.fn())
vi.mock('../error-reporting', () => ({ captureException: reported }))
vi.mock('../services/platform-auth-service', () => ({ getStoredPlatformMemberId: () => 'sub_owner' }))
vi.mock('../services/webhook-trigger-service', () => ({
  resolvePlatformMemberForCandidates: async ([userId]: string[]) => userId === 'user-other' ? { userId, memberId: 'sub_other' } : null,
}))
interface PlatformEndpoint { id: string; url: string; name: string; status: string; created_at?: string }
const relayEndpoints = vi.hoisted(() => {
  /** What listing answers: every endpoint, disabled ones too, newest first. */
  const platform: PlatformEndpoint[] = []
  const land = (name: string, id: string): PlatformEndpoint => {
    const endpoint = { id, url: `https://relay.test/v1/hooks/${id}`, name, status: 'active', created_at: new Date(platform.length * 1000).toISOString() }
    platform.unshift(endpoint)
    return endpoint
  }
  return {
    platform,
    land,
    create: vi.fn(async (_scope: string, spec: { name: string; verification?: unknown }, _request?: unknown) => land(spec.name, `whep_${relayEndpoints.create.mock.calls.length}`)),
    list: vi.fn(async (_scope: string, _request?: unknown): Promise<PlatformEndpoint[]> => platform.map(endpoint => ({ ...endpoint }))),
    disable: vi.fn(async (_scope: string, id: string, _request?: unknown) => {
      const endpoint = platform.find(candidate => candidate.id === id)
      if (endpoint) endpoint.status = 'disabled'
    }),
  }
})
vi.mock('../webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relayEndpoints.create, listEndpoints: relayEndpoints.list, disableEndpoint: relayEndpoints.disable }),
}))

import { appState, closeAppState, createLocalAppState, defineLease, digestKeyPart, initializeAppState, LocalAppStateBackend } from '../app-state'
import { createAgentIntegration, getAgentIntegration, updateAgentIntegration } from '../services/agent-integration-service'
import { verificationProfileSchema } from '../services/webhook-endpoint-schema'
import { RELAY_INTENT_REQUEST_TIMEOUT_MS, releaseIntegrationTransport } from '../agent-integrations/relay-transport'
import { toPublicAgentIntegration } from '../agent-integrations/serialization'
import { readIntegrationRelayIntent } from '../agent-integrations/transport'
import { createFakeWebhookRelay, type FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'
import { WebhookEndpointRequestTimeoutError, type RelayEvent } from '../webhook-relay'
import { emailConfigSchema, parseEmailConfig, type EmailRelayIntent } from './config-schema'
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
  relayEndpoints.platform.length = 0
  handle = await createTestDatabase(); testDb = handle.db
})
afterEach(async () => { await handle.close() })

const INTENT: EmailRelayIntent = { attemptId: '00000000000000aa', scope: 'sub_owner', endpointName: 'Email inboxes (00000000000000aa)', secret: SECRET }
/** What a process that died mid-provisioning leaves on an installation's row. */
const seedIntent = (id: string, intent: EmailRelayIntent = INTENT) => testDb.update(chatIntegrations)
  .set({ config: sql`json_set(${chatIntegrations.config}, '$.relayProvisioning', json(${JSON.stringify(intent)}))` })
  .where(eq(chatIntegrations.id, id)).run()
/** Another process: its own module state, the same AppState (held on globalThis) and the same database. */
async function secondProcess() {
  vi.resetModules()
  return import('./webhooks')
}
const mintLeases = defineLease({ name: 'lease:email:webhook-mint', ttlMs: 30_000 })
const mintLeaseKey = (scope = 'sub_owner') => mintLeases.key(digestKeyPart(scope))
/** The lease lapses under its holder, which notices only at its next renewal. */
const loseMintLease = () => appState().consume(mintLeaseKey())
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
/** Runs `before` as the next update statement is about to execute: an intruding write, or a failure in its place. */
function beforeNextUpdateRuns(before: () => Promise<void>): void {
  const update = testDb.update.bind(testDb)
  vi.spyOn(testDb, 'update').mockImplementationOnce(((table: never) => {
    const query = update(table)
    const set = query.set.bind(query)
    query.set = ((values: never) => {
      const filtered = set(values)
      const where = filtered.where.bind(filtered)
      filtered.where = ((condition: never) => {
        const ready = where(condition)
        const run = ready.run.bind(ready)
        ready.run = (async () => { await before(); return run() }) as never
        return ready
      }) as never
      return filtered
    }) as never
    return query
  }) as never)
}
/** A failed statement as drizzle reports it: its own message quotes the parameters. */
const failedQuery = (parameter: string) => new Error(`Failed query: update "chat_integrations" params: ${parameter}`, { cause: new Error('database is locked') })
const secretOf = (spec: { verification?: unknown } | undefined) => (spec?.verification as { secret: string }).secret

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
    expect(relayEndpoints.create).toHaveBeenCalledWith('sub_owner', { name: expect.stringMatching(/^Email inboxes \([0-9a-f]{16}\)$/), verification: emailVerificationProfile(first!.secret) }, { timeoutMs: RELAY_INTENT_REQUEST_TIMEOUT_MS })
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
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', 'whep_1', { timeoutMs: RELAY_INTENT_REQUEST_TIMEOUT_MS })
  })

  it('clears the intent when the endpoint is stored, and keeps the secret out of the name and the lease', async () => {
    const id = await install(MAILBOX_A)
    const answer = deferred<PlatformEndpoint>()
    relayEndpoints.create.mockImplementationOnce(() => answer.promise)
    const connecting = ensureEmailWebhook({ id, createdByUserId: null })
    await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())

    const [, spec] = relayEndpoints.create.mock.calls[0]!
    const { relayProvisioning } = await storedConfig(id)
    expect(relayProvisioning).toEqual({ attemptId: expect.stringMatching(/^[0-9a-f]{16}$/), scope: 'sub_owner', endpointName: spec.name, secret: secretOf(spec) })
    expect(spec.name).not.toContain(secretOf(spec))
    expect(JSON.stringify(await appState().get(mintLeaseKey()))).not.toContain(secretOf(spec))

    answer.resolve(relayEndpoints.land(spec.name, 'whep_1'))
    const webhook = await connecting
    expect(webhook!.secret).toBe(secretOf(spec))
    expect((await storedConfig(id)).relayProvisioning).toBeUndefined()
  })
})

describe('provisioning across processes', () => {
  const connect = (id: string) => ({ id, createdByUserId: null })

  describe('two installations in one scope', () => {
    it('mints once when they connect together in two processes', async () => {
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      const other = await secondProcess()

      const [webhookA, webhookB] = await Promise.all([ensureEmailWebhook(connect(a)), other.ensureEmailWebhook(connect(b))])

      expect(relayEndpoints.create).toHaveBeenCalledOnce()
      expect(webhookB).toEqual(webhookA)
      expect(await storedConfig(b)).toMatchObject({ relay: webhookA!.relay, webhookSecret: webhookA!.secret })
      expect((await storedConfig(a)).relayProvisioning).toBeUndefined()
      expect((await storedConfig(b)).relayProvisioning).toBeUndefined()
    })

    it('leaves the second process waiting while the first mints, then shares the endpoint', async () => {
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      const answer = deferred<PlatformEndpoint>()
      relayEndpoints.create.mockImplementationOnce(() => answer.promise)
      const first = ensureEmailWebhook(connect(a))
      await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())

      const other = await secondProcess()
      const second = other.ensureEmailWebhook(connect(b))
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(relayEndpoints.create).toHaveBeenCalledOnce()

      answer.resolve(relayEndpoints.land(relayEndpoints.create.mock.calls[0]![1].name, 'whep_1'))
      expect(await second).toEqual(await first)
      expect(relayEndpoints.create).toHaveBeenCalledOnce()
    })

    it('finishes a wait from the database as soon as the endpoint is there, without the lease', async () => {
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      const held = await mintLeases.acquire(mintLeaseKey())
      const waiting = ensureEmailWebhook(connect(b))
      await new Promise(resolve => setTimeout(resolve, 100))

      const relay = { endpointId: 'whep_attached', url: 'https://relay.test/v1/hooks/whep_attached', scope: 'sub_owner' }
      await testDb.update(chatIntegrations).set({ config: sql`json_set(${chatIntegrations.config}, '$.relay', json(${JSON.stringify(relay)}), '$.webhookSecret', ${SECRET})` }).where(eq(chatIntegrations.id, a)).run()

      expect(await waiting).toEqual({ relay, secret: SECRET })
      expect(relayEndpoints.create).not.toHaveBeenCalled()
      expect(await mintLeases.release(held!)).toBe(true)
    })

    it('takes up another installation\'s outstanding intent instead of minting beside it', async () => {
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      await seedIntent(a)
      relayEndpoints.land(INTENT.endpointName, 'whep_landed')

      const webhook = await ensureEmailWebhook(connect(b))

      expect(relayEndpoints.create).not.toHaveBeenCalled()
      expect(webhook).toEqual({ relay: { endpointId: 'whep_landed', url: 'https://relay.test/v1/hooks/whep_landed', scope: 'sub_owner' }, secret: SECRET })
      expect(await storedConfig(a)).toMatchObject({ relay: webhook!.relay, webhookSecret: SECRET })
      expect((await storedConfig(a)).relayProvisioning).toBeUndefined()
      expect(await storedConfig(b)).toMatchObject({ relay: webhook!.relay, webhookSecret: SECRET })
    })

    it('mints another installation\'s intent again, under its own name and secret, when nothing landed', async () => {
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      await seedIntent(a)

      const webhook = await ensureEmailWebhook(connect(b))

      expect(relayEndpoints.create).toHaveBeenCalledExactlyOnceWith('sub_owner', { name: INTENT.endpointName, verification: emailVerificationProfile(SECRET) }, expect.anything())
      expect(webhook!.secret).toBe(SECRET)
      expect((await storedConfig(a)).relay).toEqual(webhook!.relay)
      expect((await storedConfig(a)).relayProvisioning).toBeUndefined()
    })

    it('refuses a second intent in the scope when one lands between the read and the write', async () => {
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      beforeNextUpdateRuns(async () => { await seedIntent(a) })

      await ensureEmailWebhook(connect(b))

      expect(relayEndpoints.create).toHaveBeenCalledExactlyOnceWith('sub_owner', expect.objectContaining({ name: INTENT.endpointName }), expect.anything())
      expect(await storedConfig(a)).toMatchObject({ relay: { endpointId: 'whep_1' }, webhookSecret: SECRET })
      expect(await storedConfig(b)).toMatchObject({ relay: { endpointId: 'whep_1' }, webhookSecret: SECRET })
    })

    it('refuses an intent when the scope gets an endpoint between the read and the write', async () => {
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      const relay = { endpointId: 'whep_other', url: 'https://relay.test/v1/hooks/whep_other', scope: 'sub_owner' }
      beforeNextUpdateRuns(async () => {
        await testDb.update(chatIntegrations).set({ config: sql`json_set(${chatIntegrations.config}, '$.relay', json(${JSON.stringify(relay)}), '$.webhookSecret', ${SECRET})` }).where(eq(chatIntegrations.id, a)).run()
      })

      expect(await ensureEmailWebhook(connect(b))).toEqual({ relay, secret: SECRET })
      expect(relayEndpoints.create).not.toHaveBeenCalled()
    })
  })

  describe('waiting for the lease', () => {
    const timers = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const }
    /** Advances in steps, yielding to real I/O between them, so database calls can finish. */
    async function advance(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000)
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    afterEach(() => { vi.useRealTimers() })

    it('fails the connect rather than mint without the lease when the wait runs out', async () => {
      vi.useFakeTimers({ toFake: [...timers.toFake] })
      const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
      const answer = deferred<PlatformEndpoint>()
      relayEndpoints.create.mockImplementationOnce(() => answer.promise)
      const first = ensureEmailWebhook(connect(a))
      await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())

      const other = await secondProcess()
      const second = other.ensureEmailWebhook(connect(b)).catch((error: unknown) => error)
      await advance(61_000)

      expect(await second).toMatchObject({ message: expect.stringContaining('still setting up') })
      expect(relayEndpoints.create).toHaveBeenCalledOnce()
      expect((await storedConfig(b)).relay).toBeUndefined()
      expect((await storedConfig(b)).relayProvisioning).toBeUndefined()

      answer.resolve(relayEndpoints.land(relayEndpoints.create.mock.calls[0]![1].name, 'whep_1'))
      await advance(1_000)
      expect((await first)!.relay.endpointId).toBe('whep_1')
    })

    it('takes over from a holder that died: its lease lapses and the endpoint it minted is adopted', async () => {
      vi.useFakeTimers({ toFake: [...timers.toFake] })
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      relayEndpoints.land(INTENT.endpointName, 'whep_landed')
      expect(await mintLeases.acquire(mintLeaseKey())).not.toBeNull()

      const connecting = ensureEmailWebhook(connect(id))
      await advance(29_000)
      expect(relayEndpoints.list).not.toHaveBeenCalled()
      await advance(3_000)

      expect((await connecting)!.relay.endpointId).toBe('whep_landed')
      expect(relayEndpoints.create).not.toHaveBeenCalled()
    })
  })

  describe('owner replacement', () => {
    it('refuses the attach of a holder that lost the lease mid-mint, and disables what it minted', async () => {
      const id = await install(MAILBOX_A)
      const late = deferred<PlatformEndpoint>()
      relayEndpoints.create.mockImplementationOnce(() => late.promise)
      const first = ensureEmailWebhook(connect(id))
      await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())
      await loseMintLease()

      const other = await secondProcess()
      const second = await other.ensureEmailWebhook(connect(id))

      // Nothing had landed, so the successor minted: the same attempt, name and secret.
      expect(relayEndpoints.create).toHaveBeenCalledTimes(2)
      expect(relayEndpoints.create.mock.calls[1]![1]).toEqual(relayEndpoints.create.mock.calls[0]![1])
      expect(second!.relay.endpointId).toBe('whep_2')

      late.resolve(relayEndpoints.land(relayEndpoints.create.mock.calls[0]![1].name, 'whep_late'))

      expect(await first).toEqual(second)
      expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_late', expect.anything())
      expect((await storedConfig(id)).relay).toEqual(second!.relay)
    })

    it('refuses the attach of an attempt whose intent was replaced by a newer one', async () => {
      const id = await install(MAILBOX_A)
      const late = deferred<PlatformEndpoint>()
      relayEndpoints.create.mockImplementationOnce(() => late.promise)
      const first = ensureEmailWebhook(connect(id))
      await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())
      await seedIntent(id)

      late.resolve(relayEndpoints.land(relayEndpoints.create.mock.calls[0]![1].name, 'whep_late'))
      const webhook = await first

      expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_late', expect.anything())
      expect(relayEndpoints.create.mock.calls[1]![1].name).toBe(INTENT.endpointName)
      expect(webhook).toEqual({ relay: expect.objectContaining({ endpointId: 'whep_2' }), secret: SECRET })
    })

    it('leaves up an endpoint the successor adopted when the old holder\'s attach is refused', async () => {
      const id = await install(MAILBOX_A)
      const late = deferred<PlatformEndpoint>()
      relayEndpoints.create.mockImplementationOnce(async (_scope, spec) => {
        relayEndpoints.land(spec.name, 'whep_landed')
        return late.promise
      })
      const first = ensureEmailWebhook(connect(id))
      await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())
      await loseMintLease()

      const other = await secondProcess()
      const second = await other.ensureEmailWebhook(connect(id))
      expect(second!.relay.endpointId).toBe('whep_landed')

      late.resolve(relayEndpoints.platform[0]!)

      expect(await first).toEqual(second)
      expect(relayEndpoints.create).toHaveBeenCalledOnce()
      expect(relayEndpoints.disable).not.toHaveBeenCalled()
    })

    it('keeps the trail when disabling a refused endpoint fails, and finishes on the next connect', async () => {
      const id = await install(MAILBOX_A)
      const late = deferred<PlatformEndpoint>()
      relayEndpoints.create.mockImplementationOnce(() => late.promise)
      const first = ensureEmailWebhook(connect(id))
      await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())
      const intent = (await storedConfig(id)).relayProvisioning!
      await loseMintLease()
      const other = await secondProcess()
      const second = await other.ensureEmailWebhook(connect(id))

      // The platform stays down through this connect's own second try.
      relayEndpoints.disable.mockRejectedValueOnce(new Error('platform unreachable')).mockRejectedValueOnce(new Error('platform unreachable'))
      late.resolve(relayEndpoints.land(intent.endpointName, 'whep_late'))

      expect(await first).toEqual(second)
      expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: 'platform unreachable' }), expect.objectContaining({ tags: expect.objectContaining({ operation: 'release-relay-endpoint' }) }))
      const kept = await storedConfig(id)
      expect(kept.relay).toEqual(second!.relay)
      expect(kept.relayProvisioning).toEqual(intent)

      expect(await ensureEmailWebhook(connect(id))).toEqual(second)
      expect(relayEndpoints.disable).toHaveBeenLastCalledWith('sub_owner', 'whep_late', expect.anything())
      expect(relayEndpoints.disable).not.toHaveBeenCalledWith('sub_owner', second!.relay.endpointId, expect.anything())
      expect((await storedConfig(id)).relayProvisioning).toBeUndefined()
      expect(relayEndpoints.create).toHaveBeenCalledTimes(2)
    })

    it('does not mint when the lease is gone by the time it would', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      relayEndpoints.list.mockImplementationOnce(async () => { await loseMintLease(); return [] })

      await expect(ensureEmailWebhook(connect(id))).rejects.toMatchObject({ message: expect.stringContaining('Lost the lease') })

      expect(relayEndpoints.create).not.toHaveBeenCalled()
      expect((await storedConfig(id)).relayProvisioning).toEqual(INTENT)
    })

    it('does not mint when the renewal leaves less of the lease than the request can take', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      let clock = 1_000_000
      await closeAppState()
      await initializeAppState(createLocalAppState({ backend: new LocalAppStateBackend({ now: () => clock }) }))
      vi.spyOn(Date, 'now').mockImplementation(() => clock)
      // The renewal lands, then its answer takes 15 of the lease's 30 seconds to arrive.
      const state = appState()
      const compareAndSet = state.compareAndSet.bind(state)
      vi.spyOn(state, 'compareAndSet').mockImplementationOnce((async (...args: Parameters<typeof compareAndSet>) => {
        const answer = await compareAndSet(...args)
        clock += 15_000
        return answer
      }) as never)

      try {
        await expect(ensureEmailWebhook(connect(id))).rejects.toMatchObject({ message: expect.stringContaining('Lost the lease') })
      } finally {
        vi.mocked(Date.now).mockRestore()
      }

      expect(relayEndpoints.create).not.toHaveBeenCalled()
    })
  })

  describe('crash window', () => {
    it('adopts the same endpoint when the mint succeeded and storing it failed', async () => {
      const id = await install(MAILBOX_A)
      relayEndpoints.create.mockImplementationOnce(async (_scope, spec) => {
        beforeNextUpdateRuns(async () => { throw failedQuery(secretOf(spec)) })
        return relayEndpoints.land(spec.name, 'whep_1')
      })

      const error = await ensureEmailWebhook(connect(id)).catch((caught: unknown) => caught as Error)

      const [, spec] = relayEndpoints.create.mock.calls[0]!
      expect((error as Error).message).toContain('database is locked')
      expect((error as Error).message).not.toContain(secretOf(spec))
      expect(relayEndpoints.disable).not.toHaveBeenCalled()
      expect((await storedConfig(id)).relay).toBeUndefined()

      const other = await secondProcess()
      const webhook = await other.ensureEmailWebhook(connect(id))

      expect(relayEndpoints.create).toHaveBeenCalledOnce()
      expect(webhook).toEqual({ relay: expect.objectContaining({ endpointId: 'whep_1' }), secret: secretOf(spec) })
      expect(await storedConfig(id)).toMatchObject({ relay: webhook!.relay, webhookSecret: secretOf(spec) })
      expect((await storedConfig(id)).relayProvisioning).toBeUndefined()
    })

    it('treats a store whose answer was lost as maybe stored: the endpoint stays up and the next connect reads it', async () => {
      const id = await install(MAILBOX_A)
      const lost = vi.fn()
      relayEndpoints.create.mockImplementationOnce(async (_scope, spec) => {
        const update = testDb.update.bind(testDb)
        vi.spyOn(testDb, 'update').mockImplementationOnce(((table: never) => {
          const query = update(table)
          const set = query.set.bind(query)
          query.set = ((values: never) => {
            const filtered = set(values)
            const where = filtered.where.bind(filtered)
            filtered.where = ((condition: never) => {
              const ready = where(condition)
              const run = ready.run.bind(ready)
              ready.run = (async () => { await run(); lost(); throw failedQuery(secretOf(spec)) }) as never
              return ready
            }) as never
            return filtered
          }) as never
          return query
        }) as never)
        return relayEndpoints.land(spec.name, 'whep_1')
      })

      await expect(ensureEmailWebhook(connect(id))).rejects.toThrow('database is locked')

      expect(lost).toHaveBeenCalledOnce()
      expect(relayEndpoints.disable).not.toHaveBeenCalled()
      const webhook = await ensureEmailWebhook(connect(id))
      expect(webhook!.relay.endpointId).toBe('whep_1')
      expect(relayEndpoints.list).not.toHaveBeenCalled()
      expect(relayEndpoints.create).toHaveBeenCalledOnce()
    })

    it('adopts what a process left behind when it died right after minting', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      relayEndpoints.land(INTENT.endpointName, 'whep_landed')

      const webhook = await ensureEmailWebhook(connect(id))

      expect(relayEndpoints.create).not.toHaveBeenCalled()
      expect(webhook).toEqual({ relay: { endpointId: 'whep_landed', url: 'https://relay.test/v1/hooks/whep_landed', scope: 'sub_owner' }, secret: SECRET })
    })

    it('does not adopt a disabled endpoint or one of another name', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      relayEndpoints.land(INTENT.endpointName, 'whep_disabled').status = 'disabled'
      relayEndpoints.land('Email inboxes (00000000000000bb)', 'whep_other')
      relayEndpoints.land('Email inboxes', 'whep_old')

      const webhook = await ensureEmailWebhook(connect(id))

      expect(relayEndpoints.create).toHaveBeenCalledExactlyOnceWith('sub_owner', { name: INTENT.endpointName, verification: emailVerificationProfile(SECRET) }, expect.anything())
      expect(webhook!.relay.endpointId).toBe('whep_1')
    })

    it('does not mint when it cannot tell what landed', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      relayEndpoints.list.mockRejectedValueOnce(new Error('platform unreachable'))

      await expect(ensureEmailWebhook(connect(id))).rejects.toThrow('platform unreachable')

      expect(relayEndpoints.create).not.toHaveBeenCalled()
      expect((await storedConfig(id)).relayProvisioning).toEqual(INTENT)
    })
  })

  describe('a mint whose answer was lost', () => {
    it('reads a timeout as maybe landed: nothing is disabled, the intent stays, and the next connect adopts', async () => {
      const id = await install(MAILBOX_A)
      relayEndpoints.create.mockImplementationOnce(async (_scope, spec) => {
        relayEndpoints.land(spec.name, 'whep_landed')
        throw new WebhookEndpointRequestTimeoutError(RELAY_INTENT_REQUEST_TIMEOUT_MS)
      })

      await expect(ensureEmailWebhook(connect(id))).rejects.toBeInstanceOf(WebhookEndpointRequestTimeoutError)

      expect(relayEndpoints.disable).not.toHaveBeenCalled()
      const intent = (await storedConfig(id)).relayProvisioning!
      expect(intent.endpointName).toBe(relayEndpoints.create.mock.calls[0]![1].name)

      const webhook = await ensureEmailWebhook(connect(id))

      expect(relayEndpoints.create).toHaveBeenCalledOnce()
      expect(webhook).toEqual({ relay: expect.objectContaining({ endpointId: 'whep_landed' }), secret: intent.secret })
    })

    it('mints again with the same name and secret when nothing landed', async () => {
      const id = await install(MAILBOX_A)
      relayEndpoints.create.mockRejectedValueOnce(new WebhookEndpointRequestTimeoutError(RELAY_INTENT_REQUEST_TIMEOUT_MS))
      await expect(ensureEmailWebhook(connect(id))).rejects.toBeInstanceOf(WebhookEndpointRequestTimeoutError)
      const intent = (await storedConfig(id)).relayProvisioning!

      const webhook = await ensureEmailWebhook(connect(id))

      expect(relayEndpoints.create).toHaveBeenCalledTimes(2)
      expect(relayEndpoints.create.mock.calls[1]![1]).toEqual(relayEndpoints.create.mock.calls[0]![1])
      expect(webhook!.secret).toBe(intent.secret)
    })

    it('adopts the oldest when a lost mint landed late beside a retry, and disables the other once attached', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      relayEndpoints.land(INTENT.endpointName, 'whep_first')
      relayEndpoints.land(INTENT.endpointName, 'whep_second')
      let attachedWhenDisabled: unknown
      relayEndpoints.disable.mockImplementationOnce(async () => { attachedWhenDisabled = (await storedConfig(id)).relay?.endpointId })

      const webhook = await ensureEmailWebhook(connect(id))

      expect(webhook!.relay.endpointId).toBe('whep_first')
      expect(relayEndpoints.create).not.toHaveBeenCalled()
      expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_second', expect.anything())
      expect(attachedWhenDisabled).toBe('whep_first')
    })

    it('keeps the trail when disabling the spare fails', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id)
      relayEndpoints.land(INTENT.endpointName, 'whep_first')
      relayEndpoints.land(INTENT.endpointName, 'whep_second')
      relayEndpoints.disable.mockRejectedValueOnce(new Error('platform unreachable')).mockRejectedValueOnce(new Error('platform unreachable'))

      await ensureEmailWebhook(connect(id))
      expect((await storedConfig(id)).relayProvisioning).toEqual(INTENT)

      await ensureEmailWebhook(connect(id))
      expect(relayEndpoints.disable).toHaveBeenLastCalledWith('sub_owner', 'whep_second', expect.anything())
      expect((await storedConfig(id)).relay?.endpointId).toBe('whep_first')
      expect((await storedConfig(id)).relayProvisioning).toBeUndefined()
    })
  })

  it('takes another mailbox\'s endpoint over its own intent, and takes down what that intent left', async () => {
    const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
    await seedIntent(a)
    relayEndpoints.land(INTENT.endpointName, 'whep_spare')
    const relay = { endpointId: 'whep_shared', url: 'https://relay.test/v1/hooks/whep_shared', scope: 'sub_owner' }
    const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
    await testDb.update(chatIntegrations).set({ config: sql`json_set(${chatIntegrations.config}, '$.relay', json(${JSON.stringify(relay)}), '$.webhookSecret', ${secret})` }).where(eq(chatIntegrations.id, b)).run()

    expect(await ensureEmailWebhook(connect(a))).toEqual({ relay, secret })

    expect(relayEndpoints.create).not.toHaveBeenCalled()
    expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_spare', expect.anything())
    expect((await storedConfig(a)).relayProvisioning).toBeUndefined()
  })

  describe('an intent from another scope', () => {
    const elsewhere: EmailRelayIntent = { ...INTENT, scope: 'sub_gone' }

    it('takes down what it left there and provisions in the current scope', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id, elsewhere)
      relayEndpoints.land(elsewhere.endpointName, 'whep_old_scope')

      const webhook = await ensureEmailWebhook(connect(id))

      expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_gone', 'whep_old_scope', expect.anything())
      expect(relayEndpoints.create).toHaveBeenCalledOnce()
      expect(relayEndpoints.create.mock.calls[0]![0]).toBe('sub_owner')
      expect(relayEndpoints.create.mock.calls[0]![1].name).not.toBe(elsewhere.endpointName)
      expect(webhook!.relay.scope).toBe('sub_owner')
      expect(webhook!.secret).not.toBe(SECRET)
    })

    it('is not stuck behind a scope that no longer answers', async () => {
      const id = await install(MAILBOX_A)
      await seedIntent(id, elsewhere)
      relayEndpoints.list.mockRejectedValueOnce(new Error('member left the org'))

      const webhook = await ensureEmailWebhook(connect(id))

      expect(webhook!.relay.scope).toBe('sub_owner')
      expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: 'member left the org' }), expect.objectContaining({ tags: expect.objectContaining({ operation: 'abandon-relay-intent' }) }))
    })
  })

  it('keeps the intent through a settings edit, and never serializes it', async () => {
    const id = await install(MAILBOX_A)
    await seedIntent(id)

    await updateAgentIntegration(id, { config: { displayName: 'Renamed' } })

    const row = (await getAgentIntegration(id))!
    expect(parseEmailConfig(row.config)).toMatchObject({ displayName: 'Renamed', relayProvisioning: INTENT })
    expect(JSON.stringify(toPublicAgentIntegration(row))).not.toContain(SECRET)
    expect(JSON.stringify(toPublicAgentIntegration(row))).not.toContain('relayProvisioning')
    expect(readIntegrationRelayIntent(row.config)).toEqual({ attemptId: INTENT.attemptId, scope: INTENT.scope, endpointName: INTENT.endpointName })
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

describe('deleting an installation with an outstanding intent', () => {
  const connect = (id: string) => ({ id, createdByUserId: null })
  const remove = async (id: string) => {
    await releaseIntegrationTransport((await getAgentIntegration(id))!)
    await testDb.delete(chatIntegrations).where(eq(chatIntegrations.id, id)).run()
  }

  it('disables the endpoint its intent left behind', async () => {
    const id = await install(MAILBOX_A)
    await seedIntent(id)
    relayEndpoints.land(INTENT.endpointName, 'whep_landed')

    await remove(id)

    expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_landed', expect.anything())
  })

  it('forgets the intent before taking the endpoint down, so nothing attaches it meanwhile', async () => {
    const id = await install(MAILBOX_A)
    await seedIntent(id)
    relayEndpoints.land(INTENT.endpointName, 'whep_landed')
    let intentWhenDisabled: unknown = 'not checked'
    relayEndpoints.disable.mockImplementationOnce(async () => { intentWhenDisabled = (await storedConfig(id)).relayProvisioning })

    await releaseIntegrationTransport((await getAgentIntegration(id))!)

    expect(intentWhenDisabled).toBeUndefined()
  })

  it('never blocks deletion: a platform that does not answer is reported, without the secret', async () => {
    const id = await install(MAILBOX_A)
    await seedIntent(id)
    relayEndpoints.list.mockRejectedValueOnce(new Error('platform unreachable'))

    await expect(remove(id)).resolves.toBeUndefined()

    expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: 'platform unreachable' }), expect.objectContaining({ tags: expect.objectContaining({ operation: 'release-relay-intent' }) }))
    expect(JSON.stringify(reported.mock.calls)).not.toContain(SECRET)
  })

  it('has an attempt still running disable what it minted when its attach is refused', async () => {
    const id = await install(MAILBOX_A)
    const late = deferred<PlatformEndpoint>()
    relayEndpoints.create.mockImplementationOnce(() => late.promise)
    const connecting = ensureEmailWebhook(connect(id))
    await vi.waitFor(() => expect(relayEndpoints.create).toHaveBeenCalledOnce())

    await remove(id)
    expect(relayEndpoints.disable).not.toHaveBeenCalled()

    late.resolve(relayEndpoints.land(relayEndpoints.create.mock.calls[0]![1].name, 'whep_late'))
    expect(await connecting).toBeNull()
    expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_late', expect.anything())
  })

  it('releases an endpoint attached after the record being deleted was read', async () => {
    const id = await install(MAILBOX_A)
    await seedIntent(id)
    relayEndpoints.land(INTENT.endpointName, 'whep_landed')
    const record = (await getAgentIntegration(id))!
    await ensureEmailWebhook(connect(id))

    await releaseIntegrationTransport(record)

    expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_landed')
  })

  it('has another mailbox recovering the intent mint its own when the row goes first', async () => {
    const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
    await seedIntent(a)
    relayEndpoints.create.mockImplementationOnce(async (_scope, spec) => {
      await remove(a)
      return relayEndpoints.land(spec.name, 'whep_for_a')
    })

    const webhook = await ensureEmailWebhook(connect(b))

    expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_for_a', expect.anything())
    expect(relayEndpoints.create).toHaveBeenCalledTimes(2)
    expect(webhook!.relay.endpointId).toBe('whep_2')
    expect(webhook!.secret).not.toBe(SECRET)
  })

  it('leaves an endpoint another installation uses', async () => {
    const [a, b] = await Promise.all([install(MAILBOX_A), install(MAILBOX_B)])
    await seedIntent(a)
    relayEndpoints.land(INTENT.endpointName, 'whep_shared')
    const relay = { endpointId: 'whep_shared', url: 'https://relay.test/v1/hooks/whep_shared', scope: 'sub_owner' }
    await testDb.update(chatIntegrations).set({ config: sql`json_set(${chatIntegrations.config}, '$.relay', json(${JSON.stringify(relay)}), '$.webhookSecret', ${SECRET})` }).where(eq(chatIntegrations.id, b)).run()

    await remove(a)

    expect(relayEndpoints.disable).not.toHaveBeenCalled()
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
