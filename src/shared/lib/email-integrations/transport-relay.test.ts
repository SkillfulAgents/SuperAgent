import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'

let handle: TestDatabase, testDb: AppDatabase
const transport = vi.hoisted(() => ({ json: vi.fn(), message: vi.fn(), canonicalThreadId: vi.fn(), unwatch: vi.fn(), watch: vi.fn() }))
const relayEndpoints = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', name: 'Email inboxes', status: 'active' })),
  disable: vi.fn(async () => {}),
}))
const reported = vi.hoisted(() => vi.fn())
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('./live', () => ({ watchEmail: transport.watch }))
vi.mock('./gateway-client', async importOriginal => ({ ...await importOriginal<typeof import('./gateway-client')>(), clientFor: () => transport }))
vi.mock('../services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'test', getPlatformAuthStatus: () => ({ email: 'owner@example.com' }), getStoredPlatformMemberId: () => 'sub_owner' }))
vi.mock('../services/webhook-trigger-service', () => ({ resolvePlatformMemberForCandidates: async () => null }))
vi.mock('../error-reporting', () => ({ captureException: reported }))
vi.mock('../webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relayEndpoints.create, disableEndpoint: relayEndpoints.disable }),
}))

import { createAgentIntegration, getAgentIntegration } from '../services/agent-integration-service'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import type { IntegrationRelayHost } from '../agent-integrations/transport'
import { createFakeWebhookRelay, type FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'
import type { RelayEvent } from '../webhook-relay'
import { PlatformEmailAgentIntegration } from './platform-email-agent-integration'
import { EmailGatewayError } from './gateway-client'
import { emailConfigSchema, emailMessageSchema, parseEmailConfig } from './config-schema'
import { EmailRelays } from './webhooks'

const config = emailConfigSchema.parse({ localPart: 'helper', displayName: 'Helper', mailboxId: '00000000-0000-4000-8000-000000000001', address: 'helper@company.ongamut.so', platformOrgId: 'org', platformMemberId: 'member' })
const message = emailMessageSchema.parse({ id: '00000000-0000-4000-8000-000000000002', mailboxId: config.mailboxId, threadId: 'thread', direction: 'inbound', messageId: '<m@example>', replyToMessageId: null, from: 'owner@example.com', to: [config.address], cc: [], bcc: [], replyTo: [], subject: 'Hello', text: 'Hi', html: null, status: 'received', createdAt: 20, authentication: { dmarc: 'pass' } })
const CONSUMER = 'email-integrations:whep_1'
/** The relay host the manager offers when it has a relay; email registers through its own `EmailRelays`. */
const offeredRelay: IntegrationRelayHost = { attach: () => { throw new Error('email attaches through EmailRelays') } }

let relay: FakeWebhookRelay, id: string, connector: PlatformEmailAgentIntegration
let events: Array<{ cursor: number; type: string; messageId: string | null }>
async function connectorWith(hostRelay: IntegrationRelayHost | null) {
  const created = new PlatformEmailAgentIntegration((await getAgentIntegration(id))!, new EmailRelays(() => relay))
  created.bindHost({ session: async () => undefined, relay: hostRelay })
  return created
}
const webhookPuts = () => transport.json.mock.calls.filter(([path]) => path.endsWith('/webhook'))
const storedConfig = async () => parseEmailConfig((await getAgentIntegration(id))!.config)

/** The gateway's pointer, as the relay hands it over. */
function relayedPointer(cursor: number, secret: string): RelayEvent {
  const eventId = `evt_${cursor}`, timestamp = '1000000000'
  const body = JSON.stringify({ type: 'message.received', id: eventId, cursor, mailboxId: config.mailboxId, messageId: message.id, data: {}, createdAt: 1 })
  const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64')).update(`${eventId}.${timestamp}.${body}`).digest('base64')
  return { id: `whe_${cursor}`, endpointId: 'whep_1', type: 'CUSTOM_WEBHOOK', createdAt: '', payload: { kind: 'event', verified: true, headers: { 'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }, body } }
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks()
  handle = await createTestDatabase(); testDb = handle.db
  relay = createFakeWebhookRelay()
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'platform-email', config })
  events = []
  transport.watch.mockReturnValue(transport.unwatch)
  transport.message.mockResolvedValue(message)
  transport.json.mockImplementation(async (path: string, _schema: unknown, body?: { url: string }) => {
    if (path === '/me') return { orgId: 'org', memberId: 'member' }
    if (path.startsWith('/events')) {
      const after = Number(new URL(path, 'https://gateway.test').searchParams.get('after'))
      const data = events.filter(event => event.cursor > after)
      return { data, hasMore: false, cursor: data.at(-1)?.cursor ?? after }
    }
    if (path.endsWith('/webhook')) return { webhook: { url: body!.url } }
    return { status: 'active', domain: { status: 'ready' } }
  })
})
afterEach(async () => { await connector?.disconnect(); vi.useRealTimers(); await handle.close() })

it('with a relay, registers the webhook, opens no stream, and polls on each pointer', async () => {
  connector = await connectorWith(offeredRelay)
  const inputs = vi.fn().mockResolvedValue('accepted'); connector.onEvent(inputs)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)

  const stored = await storedConfig()
  expect(transport.watch).not.toHaveBeenCalled()
  expect(webhookPuts()).toEqual([[`/mailboxes/${config.mailboxId}/webhook`, expect.anything(), { url: 'https://relay.test/v1/hooks/whep_1', secret: stored.webhookSecret }, 'PUT']])
  expect(relay.consumers.get(CONSUMER)).toMatchObject({ scope: 'sub_owner', endpointIds: ['whep_1'] })
  expect(connector.activeTransport()).toBe('relay')

  events.push({ cursor: 4, type: 'message.received', messageId: message.id })
  expect(await relay.deliver(CONSUMER, [relayedPointer(4, stored.webhookSecret!)])).toEqual(new Map([['whe_4', 'accepted']]))
  expect(inputs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: message.id, payload: message }))
  expect((await storedConfig()).eventCursor).toBe(4)
})

it('retries a pointer its poll could not reach, and keeps polling every 30 seconds', async () => {
  connector = await connectorWith(offeredRelay)
  const inputs = vi.fn().mockResolvedValue('accepted'); connector.onEvent(inputs)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)
  const { webhookSecret } = await storedConfig()

  // The gateway posted before the event is readable.
  expect(await relay.deliver(CONSUMER, [relayedPointer(5, webhookSecret!)])).toEqual(new Map([['whe_5', 'retry']]))

  events.push({ cursor: 5, type: 'message.received', messageId: message.id })
  await vi.advanceTimersByTimeAsync(30000)
  expect(inputs).toHaveBeenCalledOnce()
  expect(await relay.deliver(CONSUMER, [relayedPointer(5, webhookSecret!)])).toEqual(new Map([['whe_5', 'accepted']]))
  expect(inputs).toHaveBeenCalledOnce()
})

it('polls again for a pointer that arrives while an older poll is running', async () => {
  connector = await connectorWith(offeredRelay)
  const inputs = vi.fn().mockResolvedValue('accepted'); connector.onEvent(inputs)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)
  const { webhookSecret } = await storedConfig()

  // The timed poll reads the events before this one exists, then stalls.
  let release!: () => void
  const json = transport.json.getMockImplementation()!
  transport.json.mockImplementationOnce(async (path: string, ...rest: unknown[]) => {
    const snapshot = await json(path, ...rest)
    await new Promise<void>(resolve => { release = resolve })
    return snapshot
  })
  await vi.advanceTimersByTimeAsync(30000)
  events.push({ cursor: 7, type: 'message.received', messageId: message.id })
  const delivered = relay.deliver(CONSUMER, [relayedPointer(7, webhookSecret!)])
  await vi.waitFor(() => expect(release).toBeDefined())
  release()

  expect(await delivered).toEqual(new Map([['whe_7', 'accepted']]))
  expect(inputs).toHaveBeenCalledOnce()
})

it('without a relay, uses the stream and leaves webhooks alone', async () => {
  connector = await connectorWith(null)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)

  expect(transport.watch).toHaveBeenCalledOnce()
  expect(relayEndpoints.create).not.toHaveBeenCalled()
  expect(webhookPuts()).toEqual([])
  expect(connector.activeTransport()).toBe('direct')
})

it('uses the stream when the relay cannot mint an endpoint', async () => {
  relayEndpoints.create.mockRejectedValueOnce(new IntegrationSetupError('This workspace has reached its limit of active webhook endpoints.'))
  connector = await connectorWith(offeredRelay)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)

  expect(transport.watch).toHaveBeenCalledOnce()
  expect(webhookPuts()).toEqual([])
  expect(relay.consumers.size).toBe(0)
  expect(connector.activeTransport()).toBe('direct')
  expect(reported).not.toHaveBeenCalled()
})

it('uses the stream when the gateway refuses the webhook, and reports it', async () => {
  const json = transport.json.getMockImplementation()!
  transport.json.mockImplementation(async (path: string, ...rest: unknown[]) => {
    if (path.endsWith('/webhook')) throw new EmailGatewayError(503, 'Email gateway is unavailable. Please retry.')
    return json(path, ...rest)
  })
  connector = await connectorWith(offeredRelay)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)

  expect(transport.watch).toHaveBeenCalledOnce()
  expect(relay.consumers.size).toBe(0)
  expect(connector.activeTransport()).toBe('direct')
  expect(reported).toHaveBeenCalledWith(expect.any(EmailGatewayError), expect.objectContaining({ tags: expect.objectContaining({ operation: 'webhooks' }) }))
})

it('stops claiming on disconnect, and drops pointers that arrive meanwhile', async () => {
  connector = await connectorWith(offeredRelay)
  const inputs = vi.fn(); connector.onEvent(inputs)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)
  const { webhookSecret } = await storedConfig()
  await connector.disconnect()

  expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual([])
  expect(connector.activeTransport()).toBeNull()
  events.push({ cursor: 6, type: 'message.received', messageId: message.id })
  // The next connect polls from the stored cursor, so nothing is lost.
  expect(await relay.deliver(CONSUMER, [relayedPointer(6, webhookSecret!)])).toEqual(new Map([['whe_6', 'discard']]))
  expect(inputs).not.toHaveBeenCalled()
})

it('stands down when disconnected while it registers the webhook', async () => {
  let release!: () => void
  const json = transport.json.getMockImplementation()!
  transport.json.mockImplementation(async (path: string, ...rest: unknown[]) => {
    if (path.endsWith('/webhook')) await new Promise<void>(resolve => { release = resolve })
    return json(path, ...rest)
  })
  connector = await connectorWith(offeredRelay)
  const connecting = connector.connect()
  await vi.waitFor(() => expect(release).toBeDefined())
  await connector.disconnect()
  release(); await connecting
  await vi.advanceTimersByTimeAsync(60000)

  expect(relay.consumers.size).toBe(0)
  expect(transport.watch).not.toHaveBeenCalled()
  expect(transport.json.mock.calls.some(([path]) => path.startsWith('/events'))).toBe(false)
})
