import { deliveryStore } from '../../agent-integrations/delivery-store'
vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => true) }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationEvent } from '../../agent-integrations/types'
import type { DirectSubscriptionEvent } from './direct-schema'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
const outbound = vi.hoisted(() => ({ check: vi.fn(async () => true) }))
vi.mock('./mcp', () => ({ checkLinearMcp: outbound.check }))
const transport = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), ready: false,
  event: async (_event: DirectSubscriptionEvent) => {}, connected: async () => {}, error: (_error: Error) => {} }))
vi.mock('./subscriptions', () => ({ LinearSubscriptions: class {
  constructor(options: { onEvent: typeof transport.event; onReady: typeof transport.connected; onError: typeof transport.error }) {
    transport.event = options.onEvent; transport.connected = options.onReady; transport.error = options.onError
  }
  start = transport.start
  stop = transport.stop
  isReady() { return transport.ready }
} }))
import { LinearAgentIntegration } from './linear-agent-integration'
import { createAgentIntegration, deleteAgentIntegration, getAgentIntegration } from '../../services/agent-integration-service'
import { updateLinearConfig } from './store'
const at = '2026-09-02T00:00:00.000Z'
const issue = { id: 'issue', identifier: 'TES-1', title: 'Test', updatedAt: at, archivedAt: null, delegate: { id: 'app' }, state: { id: 'todo', name: 'Todo', type: 'unstarted' } }
const comment = { id: 'reply', body: 'Please help', createdAt: at, updatedAt: at, archivedAt: null, user: { id: 'human', app: false }, parent: { id: 'root' }, issue }
const mention: DirectSubscriptionEvent = { type: 'notificationCreated', data: { id: 'mention', user: { id: 'app' }, type: 'issueCommentMention', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, issue, comment } }
const assignment: DirectSubscriptionEvent = { type: 'notificationCreated', data: { id: 'assignment', user: { id: 'app' }, type: 'issueAssignedToYou', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, issue, comment: null } }
const cancellation: DirectSubscriptionEvent = { type: 'issueHistoryCreated', data: { id: 'cancel', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, fromDelegate: null, toDelegate: null, fromState: { id: 'todo' }, toState: { id: 'cancelled', name: 'Cancelled', type: 'canceled' }, archived: null, issue } }
let integration: LinearAgentIntegration
let id: string
let events: IntegrationEvent[]
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(at); vi.clearAllMocks(); outbound.check.mockReset().mockResolvedValue(true); transport.ready = false
  handle = await createTestDatabase(); testDb = handle.db
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'secret',
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app', appName: 'Agent' },
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
  } })
  integration = new LinearAgentIntegration((await getAgentIntegration(id))!)
  events = []; integration.onEvent(async event => {
      if (event.type === 'input') {
        if (await deliveryStore.accept(id, event, integration.resolveRoute(event)) !== 'accepted') return
        await integration.acknowledgeInput(event)
      }
      events.push(event)
    })
  fetchMock = vi.fn(async (_url: string, options: { body: string }) => {
    const { query } = JSON.parse(options.body)
    if (query.includes('reactionCreate')) return Response.json({ data: { reactionCreate: { success: true } } })
    if (query.includes('viewer')) return Response.json({ data: { viewer: { id: 'app', name: 'Agent', displayName: 'Agent', app: true, avatarUrl: null, organization: { id: 'workspace', name: 'Test' } } } })
    throw new Error('Unexpected polling/history request')
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { await integration.disconnect(); await handle.close(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function connect() { integration.bindHost({ session: async () => undefined }); await integration.connect(); transport.ready = true; await transport.connected() }
describe('Linear live event lifecycle', () => {
  it('does not catch up or run periodic requests on boot, while idle, or on socket reconnect', async () => {
    await connect()
    expect(fetchMock).toHaveBeenCalledTimes(1) // Identity verification only.
    expect(outbound.check).toHaveBeenCalledOnce()
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(3600000)
    transport.ready = false
    await vi.advanceTimersByTimeAsync(3600000)
    transport.ready = true; await transport.connected()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(outbound.check).toHaveBeenCalledOnce()
    expect(events).toEqual([])
  })
  it('uses subscription readiness for health and reports an outage once', async () => {
    const errors = vi.fn(); integration.onError(errors)
    const recovered = vi.fn(); integration.onRecovered(recovered)
    integration.bindHost({ session: async () => undefined }); await integration.connect()
    expect(integration.isConnected()).toBe(false)
    transport.ready = true; await transport.connected()
    expect(integration.isConnected()).toBe(true)
    expect(recovered).not.toHaveBeenCalled()
    transport.ready = false
    transport.error(new Error('Socket closed')); transport.error(new Error('Retry failed'))
    expect(errors).toHaveBeenCalledOnce()
    expect(integration.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(3600000)
    expect(fetchMock).toHaveBeenCalledOnce()
    transport.ready = true; await transport.connected()
    expect(integration.isConnected()).toBe(true)
    expect(recovered).toHaveBeenCalledOnce()
  })
  it('accepts a live assignment and deduplicates mention/comment deliveries and eyes reactions', async () => {
    await connect()
    await transport.event(assignment)
    await transport.event(mention)
    await transport.event({ type: 'commentCreated', data: comment })
    expect(events.filter(event => event.type === 'input').map(event => event.id)).toEqual(['assignment:assignment', 'comment:reply'])
    const reactions = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body)).filter(request => request.query.includes('reactionCreate'))
    expect(reactions).toHaveLength(1)
    expect(reactions[0].variables).toEqual({ input: { commentId: 'reply', emoji: 'eyes' } })
  })
  it('receives first mentions on undelegated issues, then follows only involved threads', async () => {
    await connect()
    const undelegated = { ...issue, delegate: null }
    await transport.event({ ...mention, data: { ...mention.data, issue: undelegated, comment } })
    await transport.event({ type: 'commentCreated', data: { ...comment, id: 'follow-up', issue: undelegated } })
    await transport.event({ type: 'commentCreated', data: { ...comment, id: 'unrelated-thread', parent: null, issue: undelegated } })
    expect(events.filter(event => event.type === 'input').map(event => event.id)).toEqual(['comment:reply', 'comment:follow-up'])
  })
  it('does not turn edits into replay of missed comments, and ignores unrelated issues and other recipients', async () => {
    await connect()
    await transport.event({ type: 'commentUpdated', data: comment })
    await transport.event({ type: 'commentCreated', data: { ...comment, issue: { ...issue, id: 'unrelated', delegate: null } } })
    await transport.event({ ...mention, data: { ...mention.data, user: { id: 'someone-else' } } })
    expect(events).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('applies live external cancellations but lets the agent finish after its own state change', async () => {
    await connect(); await transport.event(assignment)
    await transport.event({ ...cancellation, data: { ...cancellation.data, actor: { id: 'app', app: true } } })
    expect(events.filter(event => event.type === 'cancel')).toHaveLength(0)
    await transport.event(cancellation)
    expect(events.filter(event => event.type === 'cancel')).toHaveLength(1)
  })
  it('runs live human status changes only when enabled', async () => {
    await connect()
    const status = { ...cancellation, data: { ...cancellation.data, toState: { id: 'done', name: 'Done', type: 'completed' } } }
    await transport.event(status)
    expect(events).toEqual([])
    await updateLinearConfig(id, config => ({ ...config, runOnStatusChange: true }))
    await transport.event({ ...status, data: { ...status.data, id: 'another-change' } })
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  })
  it('restores local thread participation without retrieving missed messages', async () => {
    await connect(); await transport.event({ ...mention, data: { ...mention.data, issue: { ...issue, delegate: null } } })
    await integration.disconnect()
    integration = new LinearAgentIntegration((await getAgentIntegration(id))!)
    integration.onEvent(async event => {
      if (event.type === 'input') {
        if (await deliveryStore.accept(id, event, integration.resolveRoute(event)) !== 'accepted') return
        await integration.acknowledgeInput(event)
      }
      events.push(event)
    })
    await connect()
    expect(fetchMock.mock.calls.filter(([, options]) => JSON.parse(options.body).query.includes('viewer'))).toHaveLength(2)
    await transport.event({ type: 'commentCreated', data: { ...comment, id: 'after-restart', issue: { ...issue, delegate: null } } })
    expect(events.filter(event => event.type === 'input').map(event => event.id)).toEqual(['comment:reply', 'comment:after-restart'])
  })
  it('does not create a task retry queue during an MCP outage', async () => {
    outbound.check.mockResolvedValue(false)
    await connect()
    await transport.event(assignment)
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3600000)
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
    expect(outbound.check).toHaveBeenCalledOnce()
    expect(await integration.sessionsToRecover()).toEqual([])
  })
  it('contains deletion errors and ignores late frames after disconnect or reauthorization', async () => {
    await connect()
    await updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'replacement' }))
    await transport.event(assignment)
    await deleteAgentIntegration(id)
    await expect(transport.event(assignment)).resolves.toBeUndefined()
    await integration.disconnect()
    await transport.event(mention)
    await vi.advanceTimersByTimeAsync(3600000)
    expect(events).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('does not dispatch when paused while an incoming event is waiting on config', async () => {
    await connect()
    const accepting = transport.event(mention)
    await integration.disconnect()
    await accepting
    expect(events).toEqual([])
  })
  it('does not replay previously accepted messages when a new connector starts', async () => {
    await connect(); await transport.event(assignment)
    expect(events).toHaveLength(1)
    await integration.disconnect()
    integration = new LinearAgentIntegration((await getAgentIntegration(id))!)
    integration.onEvent(async event => {
      if (event.type === 'input') {
        if (await deliveryStore.accept(id, event, integration.resolveRoute(event)) !== 'accepted') return
        await integration.acknowledgeInput(event)
      }
      events.push(event)
    })
    await connect()
    await vi.advanceTimersByTimeAsync(3600000)
    expect(events).toHaveLength(1)
    expect(await integration.sessionsToRecover()).toEqual([])
  })
})
