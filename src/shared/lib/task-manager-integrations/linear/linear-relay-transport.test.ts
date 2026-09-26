/**
 * The Linear connector in relay mode: the app's webhooks arrive through the
 * host's webhook relay (faked here), are verified, read back by id from
 * Linear (fetch is faked), and handed over exactly like live socket events.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
import type { IntegrationEvent } from '../../agent-integrations/types'
import type { FakeWebhookRelay } from '../../webhook-relay/testing/fake-webhook-relay'
import type { RelayEvent } from '../../webhook-relay'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => true) }))
vi.mock('./mcp', () => ({ checkLinearMcp: vi.fn(async () => true) }))
vi.mock('./subscriptions', () => ({ LinearSubscriptions: class { constructor() { throw new Error('relay mode must not open a socket') } } }))
const relay = vi.hoisted(() => ({ current: null as FakeWebhookRelay | null }))
vi.mock('../../webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webhook-relay')>()),
  getWebhookRelay: () => relay.current,
}))
import { createFakeWebhookRelay } from '../../webhook-relay/testing/fake-webhook-relay'
import { deliveryStore } from '../../agent-integrations/delivery-store'
import { createAgentIntegration, getAgentIntegration } from '../../services/agent-integration-service'
import { LinearAgentIntegration } from './linear-agent-integration'
import { getLinearConfig, updateLinearConfig } from './store'

const secret = 'lin_wh_secret'
const at = '2026-09-24T10:00:00.000Z'
const now = Date.parse(at)
const binding = { endpointId: 'whep_linear', url: 'https://relay.test/v1/hooks/whep_linear', scope: 'sub_owner' }
const consumerId = () => `integration:${id}`
const issue = { id: 'issue', identifier: 'TES-1', title: 'Test', updatedAt: at, archivedAt: null, delegate: { id: 'app' }, state: { id: 'todo', name: 'Todo', type: 'unstarted' } }
const notification = { id: 'notif-1', type: 'issueAssignedToYou', createdAt: at, updatedAt: at, user: { id: 'app' }, actor: { id: 'human', app: false }, issue, comment: null }
const withdrawal = { id: 'h-1', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, fromDelegate: { id: 'app' }, toDelegate: null, fromState: null, toState: null, archived: null }

let id: string
let integration: LinearAgentIntegration
let events: IntegrationEvent[]
let linear: Record<string, () => Response>
let deliveries = 0

function delivery(body: object, signWith = secret): RelayEvent {
  const raw = JSON.stringify({ createdAt: at, webhookTimestamp: now, organizationId: 'org', webhookId: 'hook', ...body })
  return {
    id: `whe_${++deliveries}`, endpointId: binding.endpointId, type: 'CUSTOM_WEBHOOK', createdAt: at,
    payload: {
      kind: 'event', verified: false, body: raw, body_encoding: 'utf8', received_at: at,
      headers: { 'linear-signature': createHmac('sha256', signWith).update(raw).digest('hex'), 'linear-event': 'x' },
    },
  }
}
const assignment = () => delivery({ type: 'AppUserNotification', action: 'issueAssignedToYou', appUserId: 'app', oauthClientId: 'c', notification: { id: 'notif-1' } })
const deliver = async (...batch: RelayEvent[]) => relay.current!.deliver(consumerId(), batch)

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks()
  relay.current = createFakeWebhookRelay()
  handle = await createTestDatabase(); testDb = handle.db
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'secret', transport: 'relay', relay: binding, webhookSecret: secret,
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app', appName: 'Agent' },
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
  } })
  integration = new LinearAgentIntegration((await getAgentIntegration(id))!)
  events = []
  integration.onEvent(async event => {
    if (event.type !== 'input') { events.push(event); return }
    const result = await deliveryStore.accept(id, event, integration.resolveRoute(event))
    if (result === 'accepted') events.push(event)
    return result
  })
  linear = {
    viewer: () => Response.json({ data: { viewer: { id: 'app', name: 'Agent', displayName: 'Agent', app: true, avatarUrl: null, organization: { id: 'workspace', name: 'Test' } } } }),
    'notification(id:$id)': () => Response.json({ data: { notification } }),
    'issue(id:$id)': () => Response.json({ data: { issue: { ...issue, delegate: null, newest: { nodes: [withdrawal] }, oldest: { nodes: [withdrawal] } } } }),
    reactionCreate: () => Response.json({ data: { reactionCreate: { success: true } } }),
  }
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: { body: string }) => {
    const { query } = JSON.parse(options.body) as { query: string }
    const key = Object.keys(linear).find(name => query.includes(name))
    if (!key) throw new Error(`Unexpected Linear request: ${query}`)
    return linear[key]()
  }))
})
afterEach(async () => { await integration.disconnect(); await handle.close(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function connect() { integration.bindHost({ session: async () => undefined }); await integration.connect() }

describe('Linear over the webhook relay', () => {
  it('receives an assignment with the event id direct mode uses, and acknowledges a redelivery as a duplicate', async () => {
    await connect()
    expect(integration.isConnected()).toBe(true)

    const first = assignment()
    expect(await deliver(first)).toEqual(new Map([[first.id, 'accepted']]))
    expect(events.map(event => event.type === 'input' && event.id)).toEqual(['assignment:notif-1'])

    const again = assignment()
    expect(await deliver(again)).toEqual(new Map([[again.id, 'duplicate']]))
    expect(events).toHaveLength(1)
  })

  it('keeps deliveries the saved secret does not verify, and fails until a new secret is saved', async () => {
    const errors = vi.fn(); integration.onError(errors)
    await connect()
    const signedElsewhere = () => delivery({ type: 'AppUserNotification', action: 'issueAssignedToYou', appUserId: 'app', notification: { id: 'notif-1' } }, 'the-real-secret')

    const held = signedElsewhere()
    expect(await deliver(held, assignment())).toEqual(new Map([[held.id, 'retry'], [`whe_${deliveries}`, 'retry']]))
    expect(errors).toHaveBeenCalledOnce()
    expect(integration.isConnected()).toBe(false)
    // Nothing more is claimed; what's waiting stays for the right secret.
    expect(relay.current!.consumers.get(consumerId())?.endpointIds).toEqual([])
    await vi.waitFor(async () => expect((await getLinearConfig(id)).webhookSecretStatus).toBe('rejected'))
    integration = new LinearAgentIntegration((await getAgentIntegration(id))!)
    await expect(connect()).rejects.toThrow('signatures do not match')

    await updateLinearConfig(id, config => ({ ...config, webhookSecret: 'the-real-secret', webhookSecretStatus: undefined }))
    integration = new LinearAgentIntegration((await getAgentIntegration(id))!)
    integration.onEvent(async event => event.type === 'input' ? deliveryStore.accept(id, event, integration.resolveRoute(event)) : undefined)
    await connect()
    expect(await deliver(held)).toEqual(new Map([[held.id, 'accepted']]))
    await vi.waitFor(async () => expect((await getLinearConfig(id)).webhookSecretStatus).toBe('verified'))
  })

  it('drops forgeries once the saved secret has verified a delivery', async () => {
    const errors = vi.fn(); integration.onError(errors)
    await connect()
    await deliver(assignment())

    const forged = delivery({ type: 'AppUserNotification', action: 'issueAssignedToYou', appUserId: 'app', notification: { id: 'notif-1' } }, 'forged')
    expect(await deliver(forged)).toEqual(new Map([[forged.id, 'discard']]))
    expect(errors).not.toHaveBeenCalled()
    expect(integration.isConnected()).toBe(true)
  })

  it('stops the task when a person withdraws the delegation, once however often the webhook comes', async () => {
    await connect()
    const update = () => delivery({ type: 'Issue', action: 'update', data: { id: 'issue', delegateId: null }, updatedFrom: { delegateId: 'app', updatedAt: at } })

    const first = update()
    expect(await deliver(first)).toEqual(new Map([[first.id, 'discard']]))
    await deliver(update())
    expect(events).toEqual([{ type: 'cancel', externalId: 'issue' }])
  })

  it('retries while Linear cannot be read, and discards what no longer exists', async () => {
    await connect()
    const reads = vi.fn(() => new Response('unavailable', { status: 503 }))
    linear['notification(id:$id)'] = reads
    const [outage, behind] = [assignment(), assignment()]
    expect(await deliver(outage, behind)).toEqual(new Map([[outage.id, 'retry'], [behind.id, 'retry']]))
    // The rest of the batch waits for the retry instead of timing out in turn.
    expect(reads).toHaveBeenCalledOnce()

    linear['notification(id:$id)'] = () => Response.json({ errors: [{ message: 'Entity not found: Notification', extensions: { code: 'INPUT_ERROR' } }] })
    const gone = assignment()
    expect(await deliver(gone)).toEqual(new Map([[gone.id, 'discard']]))
    expect(events).toEqual([])
  })

  it('stops claiming once disconnected, and hands waiting events to the next connection', async () => {
    await connect()
    await integration.disconnect()
    expect(integration.isConnected()).toBe(false)
    expect(relay.current!.consumers.get(consumerId())?.endpointIds).toEqual([])
    const waiting = assignment()
    expect(await deliver(waiting)).toEqual(new Map([[waiting.id, 'retry']]))

    integration = new LinearAgentIntegration((await getAgentIntegration(id))!)
    integration.onEvent(async event => event.type === 'input' ? deliveryStore.accept(id, event, integration.resolveRoute(event)) : undefined)
    await connect()
    expect(await deliver(waiting)).toEqual(new Map([[waiting.id, 'accepted']]))
  })

  it('will not connect without the signing secret', async () => {
    await updateLinearConfig(id, config => ({ ...config, webhookSecret: undefined }))
    integration = new LinearAgentIntegration((await getAgentIntegration(id))!)

    await expect(connect()).rejects.toThrow('Paste the webhook signing secret')
    expect(relay.current!.consumers.size).toBe(0)
  })
})
