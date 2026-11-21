import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { chatIntegrations, integrationDeliveries } from '@shared/lib/db/schema'
import { createFakeWebhookRelay } from '@shared/lib/webhook-relay/testing/fake-webhook-relay'
import { IntegrationRelays } from '@shared/lib/agent-integrations/relay-transport'
import { deliveryStore } from '@shared/lib/agent-integrations/delivery-store'
import { teamsConfigSchema } from '@shared/lib/chat-integrations/config-schema'
import { toPublicChatIntegration } from '@shared/lib/chat-integrations/public'
import { createAgentIntegration, DuplicateIntegrationIdentityError, getAgentIntegration } from '@shared/lib/services/agent-integration-service'
import { TeamsConnector } from '@shared/lib/chat-integrations/teams-connector'
import teamsMessages from './teams-messages'

const config = teamsConfigSchema.parse({
  tenantId: '9fde1600-3645-41fc-a87d-fc0083bcdf75', appId: 'a03cd25e-8578-4dae-a664-dd7706848807',
  clientSecret: 'test-only-password', messagingEndpoint: 'https://host.test/teams',
})
const activity = {
  type: 'message', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/emea/',
  conversation: { id: 'chat', tenantId: config.tenantId }, recipient: { id: `28:${config.appId}` },
}
const getConnector = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: { getConnector } }))
let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
beforeEach(async () => { handle = await createTestDatabase(); getConnector.mockReset() })
afterEach(async () => { await handle.close(); vi.restoreAllMocks() })

function post(payload: unknown = activity, bearer = 'Bearer unit-test', path = config.appId) {
  return teamsMessages.request(`/${path}`, {
    method: 'POST', headers: { Authorization: bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
}

it('keeps two agents separate, prevents duplicate app registrations, and withholds credentials from public rows', async () => {
  await createAgentIntegration({ agentSlug: 'first', provider: 'teams', config })
  await expect(createAgentIntegration({ agentSlug: 'second', provider: 'teams', config: { ...config, clientSecret: 'another-secret' } })).rejects.toThrow(DuplicateIntegrationIdentityError)
  const secondApp = '862b385b-1ef4-494b-8119-a7d045ebaded'
  const secondId = await createAgentIntegration({ agentSlug: 'second', provider: 'teams', config: { ...config, appId: secondApp } })
  const rows = await handle.db.select().from(chatIntegrations).all()
  expect(rows).toHaveLength(2)
  const safe = toPublicChatIntegration(rows[0])
  expect(safe.teams).toEqual({ tenantId: config.tenantId, appId: config.appId, deliveryMode: 'https', messagingEndpoint: config.messagingEndpoint })
  expect(JSON.stringify(safe)).not.toContain(config.clientSecret)
  expect((await post({ ...activity, recipient: { id: `28:${secondApp}` } }, 'Bearer unit-test', secondApp)).status).toBe(503)
  expect(getConnector).toHaveBeenCalledWith(secondId)
})

it('rejects mismatched routing and authentication before delivery and preserves synchronous invoke responses', async () => {
  await createAgentIntegration({ agentSlug: 'first', provider: 'teams', config })
  const connector = new TeamsConnector(config)
  getConnector.mockReturnValue(connector)
  const auth = vi.spyOn(connector.api, 'authenticate').mockRejectedValueOnce(new Error('invalid')).mockResolvedValue(undefined)
  const accept = vi.spyOn(connector, 'acceptActivity').mockResolvedValueOnce('retry').mockResolvedValueOnce('duplicate')
    .mockResolvedValueOnce({ status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: { type: 'AdaptiveCard' } } })
  expect((await post(activity, '')).status).toBe(401)
  expect((await post(activity, 'Bearer unit-test', config.tenantId)).status).toBe(400)
  expect((await post({ ...activity, conversation: { tenantId: config.appId } })).status).toBe(404)
  expect((await post()).status).toBe(401)
  expect(accept).not.toHaveBeenCalled()
  expect((await post()).status).toBe(503)
  expect((await post()).status).toBe(200)
  const invoke = await post({ ...activity, type: 'invoke' })
  expect(await invoke.json()).toMatchObject({ statusCode: 200, value: { type: 'AdaptiveCard' } })
  expect(auth).toHaveBeenCalledTimes(4)
})

it('does not expose socket or private gateway installations through the direct HTTP route', async () => {
  const socket = { ...config, deliveryMode: 'socket' }
  await createAgentIntegration({ agentSlug: 'first', provider: 'teams', config: socket })
  expect((await post()).status).toBe(404)
  const otherId = 'f8146f3f-b463-48a8-9aa4-b6cc9fb42154'
  await createAgentIntegration({ agentSlug: 'second', provider: 'teams', config: { ...config, appId: otherId, relay: { scope: 'local', url: 'https://relay.test', endpointId: 'test' } } })
  expect((await post({ ...activity, recipient: { id: otherId } }, 'Bearer unit-test', otherId)).status).toBe(404)
  expect(getConnector).not.toHaveBeenCalled()
})

it('retains a verified activity while the private host is detached and durably accepts it once across reconnects', async () => {
  const relay = createFakeWebhookRelay()
  const relays = new IntegrationRelays(() => relay)
  const binding = { endpointId: 'whep_test', scope: 'local', url: 'https://platform.test/v1/hooks/whep_test' }
  const privateConfig = { ...config, relay: binding }
  const id = await createAgentIntegration({ provider: 'teams', agentSlug: 'private', config: privateConfig })
  const record = (await getAgentIntegration(id))!
  async function connect() {
    const connector = new TeamsConnector(privateConfig, undefined, record)
    connector.bindHost({ relay: relays.hostFor(id), session: async () => undefined })
    connector.onEvent(event => event.type === 'input' ? deliveryStore.accept(id, event, connector.resolveRoute(event)) : undefined)
    await connector.connect()
    return connector
  }
  const received = {
    ...activity, id: 'msg', text: 'Hello', from: { id: '29:user', aadObjectId: '7f06ce0d-36b4-4840-aaa8-275efcc28388' },
    conversation: { ...activity.conversation, conversationType: 'personal' },
  }
  const event = {
    id: 'delivery', endpointId: binding.endpointId, type: 'CUSTOM_WEBHOOK', createdAt: new Date().toISOString(),
    payload: { kind: 'event', verified: true, body: JSON.stringify(received) },
  }
  const consume = async (payload = event.payload) => (await relay.deliver(`integration:${id}`, [{ ...event, payload }])).get(event.id)
  const first = await connect()
  await first.disconnect()
  expect(await consume()).toBe('retry')
  const second = await connect()
  expect(await consume({ ...event.payload, verified: false })).toBe('discard')
  expect(await consume()).toBe('accepted')
  await second.disconnect()
  const third = await connect()
  expect(await consume()).toBe('duplicate')
  expect(await handle.db.select().from(integrationDeliveries).all()).toHaveLength(1)
  await third.disconnect()
})
