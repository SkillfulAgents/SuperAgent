vi.mock('./delivery-store', async () => ({ deliveryStore: (await import('./testing/memory-delivery-store')).memoryDeliveryStore() }))
import * as integrationStore from './store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InterruptSessionResult } from '../container/types'
import { AgentIntegration } from './agent-integration'
import { AgentIntegrationManager } from './agent-integration-manager'
import { AgentIntegrationRegistry } from './registry'
import { captureException } from '../error-reporting'
import { updateAgentIntegrationStatus } from '../services/agent-integration-service'
import type { AgentIntegrationRecord, IntegrationInputEvent, IntegrationOutput, IntegrationSessionContext, PreparedIntegrationInput } from './types'

const state = vi.hoisted(() => ({
  rows: [] as AgentIntegrationRecord[],
  mappings: new Map<string, { id: string; integrationId: string; externalChatId: string; sessionId: string; displayName?: string }>(),
  streams: new Map<string, (event: unknown) => void>(),
  global: undefined as ((event: unknown) => void) | undefined, interrupt: vi.fn<(sessionId: string) => Promise<InterruptSessionResult>>(),
  authorizationLost: undefined as ((change: { integrationId: string }) => void) | undefined,
  syncMcp: vi.fn(async () => true),
  claim: vi.fn(), notify: vi.fn().mockResolvedValue(undefined),
  markActive: vi.fn(), markIdle: vi.fn(), markProvisionalActive: vi.fn(), open: vi.fn(() => []),
  activity: vi.fn(() => 'idle'), recovery: [] as Array<{ externalId: string; sessionId?: string }>,
  create: vi.fn(), start: vi.fn(), send: vi.fn(), subscribeStream: vi.fn(), isStreamSubscribed: vi.fn(() => false), register: vi.fn(), metadata: vi.fn(),
  broadcast: vi.fn(), isActive: vi.fn(() => false),
  recordMessage: vi.fn(async (record: { display: unknown }) => record.display),
}))
vi.mock('@shared/lib/services/agent-integration-message-service', () => ({ recordIntegrationMessage: state.recordMessage }))
vi.mock('./lifecycle', () => ({ onIntegrationAuthorizationLost: (callback: typeof state.authorizationLost) => { state.authorizationLost = callback; return () => { state.authorizationLost = undefined } } }))
vi.mock('@shared/lib/services/connection-sync-service', () => ({ syncRemoteMcpAgents: state.syncMcp }))
vi.mock('@shared/lib/services/agent-integration-service', () => ({
  listStartupAgentIntegrations: () => state.rows,
  getAgentIntegration: (id: string) => state.rows.find(row => row.id === id),
  updateAgentIntegrationStatus: vi.fn(),
}))
vi.mock('@shared/lib/services/agent-integration-session-service', () => ({
  resolveActiveSession: (id: string, externalId: string) => state.mappings.get(`${id}:${externalId}`),
  createAgentIntegrationSession: (mapping: { integrationId: string; externalChatId: string; sessionId: string }) => {
    state.mappings.set(`${mapping.integrationId}:${mapping.externalChatId}`, { id: `mapping-${mapping.sessionId}`, ...mapping })
  },
  listActiveAgentIntegrationSessions: (id: string) => [...state.mappings.values()].filter(mapping => mapping.integrationId === id),
  getAgentIntegrationSession: (id: string, externalId: string) => state.mappings.get(`${id}:${externalId}`),
  getAgentIntegrationSessionBySessionId: (_agent: string, id: string) => [...state.mappings.values()].find(mapping => mapping.sessionId === id),
  listAgentIntegrationSessions: vi.fn(() => []),
  archiveAgentIntegrationSession: vi.fn(), updateAgentIntegrationSessionName: vi.fn(), touchAgentIntegrationSession: vi.fn(), getLastDisplayName: vi.fn(),
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: { exists: async () => true },
  agentRegistry: { get: () => ({
    container: { start: state.start },
    inputs: { claim: state.claim, open: state.open },
    sessions: {
      create: state.create, register: state.register, updateMetadata: state.metadata,
      activity: state.activity, isActive: state.isActive, activeIds: () => ['session-1'], markActive: state.markActive, markIdle: state.markIdle, markProvisionalActive: state.markProvisionalActive, subscribeStream: state.subscribeStream, isStreamSubscribed: state.isStreamSubscribed,
    },
    messages: {
      send: state.send, interrupt: state.interrupt, broadcastEvent: state.broadcast,
      withSend: (_session: string, callback: () => Promise<void>) => callback(),
      subscribe: (session: string, callback: (event: unknown) => void) => {
        state.streams.set(session, callback)
        return () => { state.streams.delete(session) }
      },
    },
  }) },
}))
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: async () => true }))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}), getEffectiveModels: () => ({ agentModel: 'test-model' }) }))
vi.mock('@shared/lib/services/agent-preferences-service', () => ({ readAgentPreferences: async () => ({}) }))
vi.mock('@shared/lib/services/secrets-service', () => ({ getSecretEnvVars: async () => [] }))
vi.mock('@shared/lib/container/message-persister', () => ({ messagePersister: { addGlobalNotificationClient: (callback: (event: unknown) => void) => { state.global = callback; return () => { state.global = undefined } } } }))
vi.mock('@shared/lib/notifications/notification-manager', () => ({ notificationManager: { triggerChatIntegrationEvent: state.notify } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

/** Deliberately has no messaging, typing, streaming, or other chat methods. */
class ObjectIntegration extends AgentIntegration {
  readonly provider = 'test-objects'
  readonly definition = { provider: this.provider, name: 'Objects', family: 'objects', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } }
  connected = false
  allowed = true
  outputs: Array<{ context: IntegrationSessionContext; output: IntegrationOutput }> = []
  released: IntegrationSessionContext[] = []
  prepareInput = vi.fn(async (event: IntegrationInputEvent): Promise<PreparedIntegrationInput> => ({ text: `Object context: ${(event.payload as { text: string }).text}` }))
  sessionsToRecover = async () => state.recovery
  session(externalId: string) { return this.host.session(externalId) }
  async connect() { this.connected = true }
  async disconnect() { this.connected = false }
  isConnected() { return this.connected }
  resolveRoute(event: IntegrationInputEvent) {
    return { externalId: (event.payload as { objectId: string }).objectId, interactionId: event.id, replyTarget: { comment: event.externalId }, action: 'run' as const }
  }
  async authorize() { return this.allowed }
  async isAllowed() { return this.allowed }
  sessionPolicy() { return { name: 'Object session', timeoutHours: null, metadata: {} } }
  async deliver(context: IntegrationSessionContext, output: IntegrationOutput) { this.outputs.push({ context, output }) }
  releaseSession(context: IntegrationSessionContext) { this.released.push(context) }
  response() {
    return this.emitEvent({ type: 'response', externalId: 'object-7', requestId: 'input-1', requestKind: 'input', value: 'yes' })
      .catch(error => this.emitError(error))
  }
  cancel(onInterrupted: () => void) { return this.emitEvent({ type: 'cancel', externalId: 'object-7', onInterrupted }) }
  fail(error: Error) { this.emitError(error) }
  input(comment: string, text = 'hello') {
    return this.emitEvent({ type: 'input', externalId: comment, id: comment, timestamp: new Date(), payload: { objectId: 'object-7', text } })
  }
}

function record(id: string): AgentIntegrationRecord {
  return { id, agentSlug: id, provider: 'test-objects', name: null, config: '{}', status: 'active', errorMessage: null,
    model: null, llmProviderId: null, effort: null, speed: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() }
}

let manager: AgentIntegrationManager
let adapter: ObjectIntegration
let registry: AgentIntegrationRegistry
beforeEach(async () => {
  vi.clearAllMocks()
  state.rows = [record('installation-a')]
  state.recovery = []
  state.activity.mockReturnValue('idle')
  state.markProvisionalActive.mockImplementation((id: string) => {
    state.markActive(id)
    state.activity.mockReturnValue('working')
    state.streams.get(id)?.({ type: 'session_active' })
    return () => {
      state.markIdle(id)
      state.activity.mockReturnValue('idle')
      state.streams.get(id)?.({ type: 'session_idle' })
    }
  })
  state.mappings.clear()
  state.streams.clear()
  state.create.mockImplementation(async () => ({ id: `session-${state.create.mock.calls.length}` }))
  state.subscribeStream.mockResolvedValue(undefined)
  state.isStreamSubscribed.mockReturnValue(false)
  state.start.mockResolvedValue(undefined)
  state.send.mockResolvedValue(undefined)
  adapter = new ObjectIntegration()
  registry = new AgentIntegrationRegistry([{ definition: adapter.definition, policy: adapter, create: async () => adapter }])
  manager = new AgentIntegrationManager(registry)
})
afterEach(() => manager.stop())

describe('AgentIntegration host contract', () => {
  it('creates a session and routes subsequent events by the provider logical key', async () => {
    await manager.start()
    await adapter.input('comment-one')
    await vi.waitFor(() => expect(state.mappings.size).toBe(1))
    await adapter.input('comment-two', 'follow-up')
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith('session-1', 'Object context: follow-up', expect.any(String)))
    expect(state.create).toHaveBeenCalledOnce()
    expect(state.mappings.get('installation-a:object-7')?.sessionId).toBe('session-1')
    expect(state.metadata).toHaveBeenCalledWith('session-1', { isAgentIntegrationSession: true, agentIntegrationId: 'installation-a' })
    expect('sendMessage' in adapter).toBe(false)
    expect(adapter.prepareInput).toHaveBeenCalledTimes(2)
  })

  describe('message display', () => {
    const presentation = { event: { type: 'comment', label: 'New comment' }, request: { text: 'Please look' }, source: { kind: 'task' as const, identifier: 'OBJ-7' } }
    const withDisplay = async (event: IntegrationInputEvent): Promise<PreparedIntegrationInput> =>
      ({ text: `Object context: ${(event.payload as { text: string }).text}`, display: presentation })
    const stored = {
      ...presentation, version: 1,
      integration: { id: 'installation-a', name: 'Objects', provider: 'test-objects', family: 'objects' },
    }

    it('records the card under the uuid the message is sent with and shows it live', async () => {
      adapter.prepareInput.mockImplementation(withDisplay)
      state.isActive.mockReturnValue(true)
      await manager.start()
      await adapter.input('comment-one')
      await vi.waitFor(() => expect(state.mappings.size).toBe(1))
      const initialMessageUuid = state.create.mock.calls[0][0].initialMessageUuid
      expect(initialMessageUuid).toEqual(expect.any(String))
      expect(state.recordMessage).toHaveBeenCalledWith({ id: initialMessageUuid, sessionId: 'session-1', agentSlug: 'installation-a', display: stored })

      await adapter.input('comment-two', 'follow-up')
      await vi.waitFor(() => expect(state.send).toHaveBeenCalledOnce())
      const [, text, uuid] = state.send.mock.calls[0]
      expect(text).toBe('Object context: follow-up')
      expect(state.recordMessage).toHaveBeenLastCalledWith({ id: uuid, sessionId: 'session-1', agentSlug: 'installation-a', display: stored })
      expect(state.broadcast).toHaveBeenCalledExactlyOnceWith('session-1', { type: 'user_message', uuid, content: text, queued: true, integration: stored })
    })

    it('records the card before the handoff, keyed by the delivery, so an uncertain send keeps it', async () => {
      adapter.prepareInput.mockImplementation(withDisplay)
      await manager.start()
      await adapter.input('comment-one')
      await vi.waitFor(() => expect(state.mappings.size).toBe(1))
      state.send.mockImplementationOnce(async () => {
        expect(state.recordMessage).toHaveBeenCalledTimes(2)
        throw new Error('socket hang up')
      })
      await adapter.input('comment-two', 'follow-up')
      await vi.waitFor(() => expect(state.send).toHaveBeenCalledOnce())
      expect(state.recordMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: state.send.mock.calls[0][2], sessionId: 'session-1' }))
    })

    it('sends without a card or broadcast when the provider describes none, or the card is rejected', async () => {
      await manager.start()
      await adapter.input('comment-one')
      await vi.waitFor(() => expect(state.mappings.size).toBe(1))
      await adapter.input('comment-two', 'follow-up')
      await vi.waitFor(() => expect(state.send).toHaveBeenCalledOnce())
      expect(state.recordMessage).not.toHaveBeenCalled()

      adapter.prepareInput.mockImplementation(withDisplay)
      state.recordMessage.mockResolvedValueOnce(null)
      await adapter.input('comment-three', 'again')
      await vi.waitFor(() => expect(state.send).toHaveBeenCalledTimes(2))
      expect(state.broadcast).not.toHaveBeenCalled()
    })
  })

  it('delivers fast replay with the reply target, distinguishing a segment from turn completion', async () => {
    state.subscribeStream.mockImplementation(async (id: string) => {
      state.streams.get(id)?.({ type: 'stream_end' })
      state.streams.get(id)?.({ type: 'session_idle' })
    })
    await manager.start()
    await adapter.input('comment-one')
    await vi.waitFor(() => expect(adapter.outputs.some(item => item.output.type === 'turn-completed')).toBe(true))
    const completed = adapter.outputs.filter(item => item.output.type === 'turn-completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].context).toMatchObject({ integration: { id: 'installation-a' }, externalId: 'object-7', sessionId: 'session-1', interactionId: 'comment-one', replyTarget: { comment: 'comment-one' } })
    expect(adapter.outputs.some(item => item.output.type === 'runtime' && (item.output.event as { type: string }).type === 'stream_end')).toBe(true)
  })

  it('handles stream events in arrival order even when the access check is slow', async () => {
    await manager.start()
    await adapter.input('comment-one')
    await vi.waitFor(() => expect(state.streams.has('session-1')).toBe(true))
    const handled = vi.spyOn(manager as unknown as { handleSSEEvent: (...args: unknown[]) => Promise<void> }, 'handleSSEEvent')
    // The access check is a database read; a slow one must not let a later
    // event overtake the one it guards.
    let release!: () => void
    vi.spyOn(adapter, 'isAllowed').mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    const emit = state.streams.get('session-1')!
    emit({ type: 'stream_end' })
    emit({ type: 'session_idle' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handled).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(2))
    expect(handled.mock.calls.map((call) => (call[2] as { type: string }).type)).toEqual(['stream_end', 'session_idle'])
  })

  it('keeps a failing access check inside the queue instead of rejecting the broadcaster', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await manager.start()
      await adapter.input('comment-one')
      await vi.waitFor(() => expect(state.streams.has('session-1')).toBe(true))
      const handled = vi.spyOn(manager as unknown as { handleSSEEvent: (...args: unknown[]) => Promise<void> }, 'handleSSEEvent')
      vi.spyOn(adapter, 'isAllowed').mockRejectedValueOnce(new Error('acl unavailable'))
      const emit = state.streams.get('session-1')!
      emit({ type: 'stream_end' }) // its check fails: reported, not thrown
      emit({ type: 'session_idle' }) // the queue keeps going
      await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1))
      expect((handled.mock.calls[0][2] as { type: string }).type).toBe('session_idle')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('does not revive a session that was cleared while its observation waited on the queue', async () => {
    await manager.start()
    await adapter.input('comment-one')
    await vi.waitFor(() => expect(state.streams.has('session-1')).toBe(true))
    const observed = vi.spyOn(adapter, 'observeSession')
    let release!: () => void
    vi.spyOn(adapter, 'isAllowed').mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    const emit = state.streams.get('session-1')!
    emit({ type: 'stream_end' }) // stalls on its access check
    emit({ type: 'session_idle' }) // waits behind it
    await new Promise((resolve) => setTimeout(resolve, 0))
    manager.stop() // the chat is cleared: its session is released
    expect(adapter.released).toHaveLength(1)
    const observedBeforeRelease = observed.mock.calls.length
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(observed.mock.calls.length).toBe(observedBeforeRelease)
  })

  it('does not deliver an event whose chat was cleared during its own access check', async () => {
    await manager.start()
    await adapter.input('comment-one')
    await vi.waitFor(() => expect(state.streams.has('session-1')).toBe(true))
    let checks = 0
    let release!: () => void
    vi.spyOn(adapter, 'isAllowed').mockImplementation(() => {
      checks += 1
      // The queued observation's check resolves; the handler's own check stalls.
      if (checks === 1) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => { release = () => resolve(true) })
    })
    const outputsBefore = adapter.outputs.length
    state.streams.get('session-1')!({ type: 'session_idle' })
    await vi.waitFor(() => expect(checks).toBe(2))
    manager.stop() // the chat is cleared while the handler waits
    expect(adapter.released).toHaveLength(1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(adapter.outputs.length).toBe(outputsBefore)
  })

  it('blocks input before preparation or runtime startup and blocks output after revocation', async () => {
    await manager.start()
    adapter.allowed = false
    await adapter.input('blocked')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.prepareInput).not.toHaveBeenCalled()
    expect(state.start).not.toHaveBeenCalled()
    adapter.allowed = true
    await adapter.input('allowed')
    await vi.waitFor(() => expect(state.streams.size).toBe(1))
    adapter.outputs = []
    adapter.allowed = false
    state.streams.get('session-1')?.({ type: 'session_idle' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.outputs).toEqual([])
  })

  it('keeps installations isolated and releases subscriptions and sessions on stop', async () => {
    const second = new ObjectIntegration()
    state.rows.push(record('installation-b'))
    const isolated = new AgentIntegrationRegistry([{ definition: adapter.definition, policy: adapter, create: async row => row.id === 'installation-a' ? adapter : second }])
    manager = new AgentIntegrationManager(isolated)
    await manager.start()
    await Promise.all([adapter.input('first'), second.input('second')])
    await vi.waitFor(() => expect(state.streams.size).toBe(2))
    expect(state.mappings.size).toBe(2)
    manager.stop()
    expect(state.streams.size).toBe(0)
    expect(adapter.connected).toBe(false)
    expect(second.connected).toBe(false)
    expect(adapter.released).toHaveLength(1)
    expect(second.released).toHaveLength(1)
    await adapter.input('after-stop')
    expect(state.create).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected response handler without marking the connection unhealthy', async () => {
    await manager.start()
    await vi.dynamicImportSettled()
    state.notify.mockClear()
    const failure = new Error('Input claim failed')
    state.claim.mockImplementationOnce(() => { throw failure })

    await adapter.response()
    await vi.dynamicImportSettled()

    expect(captureException).toHaveBeenCalledWith(failure, expect.objectContaining({
      tags: { component: 'agent-integration', operation: 'event-handler' },
      extra: expect.objectContaining({ eventType: 'response' }),
    }))
    expect(updateAgentIntegrationStatus).not.toHaveBeenCalled()
    expect(state.notify).not.toHaveBeenCalled()
    expect(adapter.isConnected()).toBe(true)
  })

  it('reports a synchronous routing failure and continues accepting subsequent input', async () => {
    await manager.start()
    await vi.dynamicImportSettled()
    state.notify.mockClear()
    const failure = new Error('Invalid route')
    vi.spyOn(adapter, 'resolveRoute').mockImplementationOnce(() => { throw failure })

    await expect(adapter.input('bad-comment')).rejects.toThrow('Invalid route')
    await vi.dynamicImportSettled()

    expect(captureException).toHaveBeenCalledWith(failure, expect.objectContaining({
      tags: { component: 'agent-integration', operation: 'event-handler' },
      extra: expect.objectContaining({ eventType: 'input' }),
    }))
    expect(updateAgentIntegrationStatus).not.toHaveBeenCalled()
    expect(state.notify).not.toHaveBeenCalled()
    expect(state.create).not.toHaveBeenCalled()
    await adapter.input('good-comment')
    await vi.waitFor(() => expect(state.mappings.size).toBe(1))
  })

  it('still marks genuine connector failures as errors and notifies the user', async () => {
    await manager.start()
    await vi.dynamicImportSettled()
    adapter.fail(new Error('Connection lost'))
    await vi.dynamicImportSettled()

    expect(updateAgentIntegrationStatus).toHaveBeenCalledWith('installation-a', 'error', 'Connection lost')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledWith(
      'installation-a', 'installation-a', 'test-objects bot', 'error', 'Connection lost',
    ))
  })

  it('creates and reuses an outbound object session without constructing a connector', async () => {
    const create = vi.fn()
    const offline = new AgentIntegrationRegistry([{ definition: adapter.definition, policy: adapter, create }])
    manager = new AgentIntegrationManager(offline)

    const sessionId = await manager.ensureSession('installation-a', 'object-7')
    expect(state.register).toHaveBeenCalledWith(sessionId, 'Object session')
    expect(state.metadata).toHaveBeenCalledWith(sessionId, { isAgentIntegrationSession: true, agentIntegrationId: 'installation-a' })
    expect(await manager.ensureSession('installation-a', 'object-7')).toBe(sessionId)
    expect(state.register).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
    expect(state.start).not.toHaveBeenCalled()

    adapter.allowed = false
    await expect(manager.ensureSession('installation-a', 'object-7')).rejects.toThrow('not allowed')
  })

  it('exposes provider metadata without creating a connection and rejects duplicate registration', async () => {
    const create = vi.fn()
    const metadataOnly = new AgentIntegrationRegistry([{ definition: adapter.definition, policy: adapter, create }])
    expect(metadataOnly.getDefinition('test-objects')?.family).toBe('objects')
    expect(metadataOnly.listDefinitions()).toEqual([adapter.definition])
    expect(create).not.toHaveBeenCalled()
    expect(() => metadataOnly.register({ definition: adapter.definition, policy: adapter, create })).toThrow('Duplicate integration provider')
  })
  it('acknowledges cancellation only after the mapped runtime confirms interruption', async () => {
    await manager.start()
    const acknowledged = vi.fn()
    await adapter.cancel(acknowledged)
    expect(state.interrupt).not.toHaveBeenCalled()
    expect(acknowledged).not.toHaveBeenCalled()
    await adapter.input('comment')
    await vi.waitFor(() => expect(state.mappings.size).toBe(1))
    state.interrupt.mockResolvedValue({ interrupted: false, processKept: true })
    await adapter.cancel(acknowledged)
    expect(acknowledged).not.toHaveBeenCalled()
    state.interrupt.mockResolvedValue({ interrupted: true, processKept: false })
    await adapter.cancel(acknowledged)
    expect(state.interrupt).toHaveBeenCalledWith('session-1')
    expect(acknowledged).toHaveBeenCalledOnce()
  })
  it.each(['global-first', 'session-first'])('routes reviews once when resolution arrives %s', async order => {
    await manager.start()
    await adapter.input('comment')
    await vi.waitFor(() => expect(state.mappings.size).toBe(1))
    adapter.outputs = []
    const request = { id: 'review', kind: 'proxy_review', blocking: true, autoApproved: false,
      scope: { agentSlug: 'installation-a', sessionId: 'another-session' }, payload: {} }
    state.global?.({ type: 'user_request_resolved', kind: 'proxy_review', outcome: 'answered', requestId: 'unrelated', scope: { agentSlug: 'installation-a' } })
    state.global?.({ type: 'user_request_created', request })
    state.global?.({ type: 'user_request_created', request: { ...request, scope: { agentSlug: 'installation-a' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.outputs).toEqual([])
    state.streams.get('session-1')?.({ type: 'user_request_created', request: { ...request, scope: { agentSlug: 'installation-a', sessionId: 'session-1' } } })
    await vi.waitFor(() => expect(adapter.outputs).toHaveLength(1))
    expect(adapter.outputs[0].output.type).toBe('request-opened')
    const resolution = { type: 'user_request_resolved', kind: 'proxy_review', outcome: 'answered', requestId: 'review', scope: { agentSlug: 'installation-a', sessionId: 'session-1' } }
    if (order === 'global-first') state.global?.(resolution)
    state.streams.get('session-1')?.(resolution)
    if (order === 'session-first') state.global?.(resolution)
    await vi.waitFor(() => expect(adapter.outputs).toHaveLength(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.outputs).toHaveLength(2)
    expect(adapter.outputs[1]).toMatchObject({ context: { sessionId: 'session-1' }, output: { type: 'request-resolved', requestId: 'review' } })
  })

})

it('review: a health check does not re-observe a session cleared during its access check', async () => {
  await manager.start()
  await adapter.input('review-comment')
  await vi.waitFor(() => expect(state.streams.size).toBe(1))
  let release!: (value: boolean) => void
  const blocked = new Promise<boolean>(resolve => { release = resolve })
  let reached!: () => void
  const checking = new Promise<void>(resolve => { reached = resolve })
  const observed = vi.spyOn(adapter, 'observeSession')
  vi.spyOn(adapter, 'isAllowed').mockImplementationOnce(() => { reached(); return blocked })
  const healthCheck = (manager as unknown as { runHealthChecks: () => Promise<void> }).runHealthChecks()
  await checking
  await manager.clearSessionById('mapping-session-1')
  expect(adapter.released).toHaveLength(1)
  observed.mockClear()
  release(true)
  await healthCheck
  expect(observed).not.toHaveBeenCalled()
})


it('review: reconnect must not restore a session cleared during its access read', async () => {
  await manager.start()
  await adapter.input('review-comment')
  await vi.waitFor(() => expect(state.streams.size).toBe(1))
  let release!: (value: boolean) => void
  const blocked = new Promise<boolean>(resolve => { release = resolve })
  let reached!: () => void
  const checking = new Promise<void>(resolve => { reached = resolve })
  vi.spyOn(adapter, 'isAllowed').mockImplementationOnce(() => { reached(); return blocked })
  const reconnecting = manager.addIntegration('installation-a')
  await checking
  // Match the clear route: stop live state, then archive the stored mapping.
  await manager.clearSessionById('mapping-session-1')
  state.recovery = []
  state.activity.mockReturnValue('idle')
  state.mappings.clear()
  expect(state.streams.has('session-1')).toBe(false)
  release(true)
  await reconnecting
  adapter.outputs = []
  state.streams.get('session-1')?.({ type: 'stream_delta', text: 'output from archived session' })
  await vi.waitFor(() => expect((manager as unknown as { messageQueues: Map<string, Promise<void>> }).messageQueues.has('sse:installation-a:object-7')).toBe(false))
  expect(adapter.outputs).toEqual([])
  expect(state.streams.has('session-1')).toBe(false)
})

it.each(['addIntegration', 'resumeIntegration'] as const)('review: a pause supersedes %s waiting for its integration row', async operation => {
  await manager.start()
  let release!: (value: AgentIntegrationRecord) => void
  const blocked = new Promise<AgentIntegrationRecord>(resolve => { release = resolve })
  let reached!: () => void
  const reading = new Promise<void>(resolve => { reached = resolve })
  const lookup = vi.spyOn(integrationStore, 'getIntegration').mockImplementationOnce(() => { reached(); return blocked })
  try {
    const snapshot = state.rows[0]
    const connecting = manager[operation]('installation-a')
    await reading
    await manager.pauseIntegration('installation-a')
    state.rows[0] = { ...snapshot, status: 'paused' }
    expect(manager.isIntegrationConnected('installation-a')).toBe(false)
    release(snapshot)
    await connecting
    expect(manager.isIntegrationConnected('installation-a')).toBe(false)
  } finally { lookup.mockRestore() }
})

it.each([1, 2])('review: stale rebuild read %i must not tear down a newer connection', async pausedRead => {
  await manager.start()
  let release!: (value: AgentIntegrationRecord) => void
  const blocked = new Promise<AgentIntegrationRecord>(resolve => { release = resolve })
  let reached!: () => void
  const reading = new Promise<void>(resolve => { reached = resolve })
  const original = integrationStore.getIntegration
  let reads = 0
  const lookup = vi.spyOn(integrationStore, 'getIntegration').mockImplementation(id => {
    if (++reads === pausedRead) { reached(); return blocked }
    return original(id)
  })
  try {
    const rebuilding = (manager as unknown as { rebuildIntegration: (id: string, operation: string) => Promise<void> }).rebuildIntegration('installation-a', 'review')
    await reading
    await manager.removeIntegration('installation-a')
    await manager.addIntegration('installation-a')
    expect(manager.isIntegrationConnected('installation-a')).toBe(true)
    release(state.rows[0])
    await rebuilding
    expect(manager.isIntegrationConnected('installation-a')).toBe(true)
  } finally { lookup.mockRestore() }
})


it('review: clearing during the final restoration lookup must prevent stale output', async () => {
  await manager.start()
  await adapter.input('review-comment')
  await vi.waitFor(() => expect(state.streams.size).toBe(1))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const reading = new Promise<void>(resolve => { reached = resolve })
  const original = integrationStore.getIntegrationSession
  const lookup = vi.spyOn(integrationStore, 'getIntegrationSession').mockImplementationOnce(async (id, externalId) => {
    // Capture a valid row, then delay the asynchronous read's completion.
    const snapshot = await original(id, externalId)
    reached()
    await blocked
    return snapshot
  })
  try {
    const reconnecting = manager.addIntegration('installation-a')
    await reading
    // Match the API route: clear live state, then archive the stored mapping.
    await manager.clearSessionById('mapping-session-1')
    state.recovery = []
  state.activity.mockReturnValue('idle')
  state.mappings.clear()
    expect(state.streams.has('session-1')).toBe(false)
    release()
    await reconnecting
    adapter.outputs = []
    state.streams.get('session-1')?.({ type: 'stream_delta', text: 'output from archived session' })
    await vi.waitFor(() => expect((manager as unknown as { messageQueues: Map<string, Promise<void>> }).messageQueues.has('sse:installation-a:object-7')).toBe(false))
    expect(adapter.outputs).toEqual([])
    expect(state.streams.has('session-1')).toBe(false)
  } finally { release(); lookup.mockRestore() }
})

it('review: a restoration retry cannot outlive a clear that is still in progress', async () => {
  const otherAdapter = new ObjectIntegration()
  state.rows.push(record('installation-b'))
  registry = new AgentIntegrationRegistry([{
    definition: adapter.definition,
    policy: adapter,
    create: async row => row.id === 'installation-a' ? adapter : otherAdapter,
  }])
  manager = new AgentIntegrationManager(registry)
  await manager.start()
  await adapter.input('first-chat')
  await vi.waitFor(() => expect(state.streams.has('session-1')).toBe(true))
  await otherAdapter.input('second-chat')
  await vi.waitFor(() => expect(state.streams.has('session-2')).toBe(true))

  const gate = () => {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
  }
  const firstRead = gate(), retryRead = gate(), clearRead = gate()
  const releaseFirst = gate(), releaseRetry = gate(), releaseClear = gate()
  const original = integrationStore.getIntegrationSession
  let restoringReads = 0
  const lookup = vi.spyOn(integrationStore, 'getIntegrationSession').mockImplementation(async (id, externalId) => {
    const snapshot = await original(id, externalId)
    if (id === 'installation-b') {
      // clearSessionById scans another live chat while the target is reconnecting.
      clearRead.release()
      await releaseClear.promise
    } else if (++restoringReads === 1) {
      firstRead.release()
      await releaseFirst.promise
    } else if (restoringReads === 2) {
      retryRead.release()
      await releaseRetry.promise
    }
    return snapshot
  })
  try {
    const reconnecting = manager.addIntegration('installation-a')
    await firstRead.promise
    const clearing = (async () => {
      await manager.clearSessionById('mapping-session-1')
      // Same ordering as the API: archive only after live cleanup completes.
      state.mappings.delete('installation-a:object-7')
    })()
    await clearRead.promise
    releaseFirst.release()
    // A cancelled restore may finish immediately without another database read.
    await Promise.race([retryRead.promise, reconnecting])
    releaseClear.release()
    await clearing
    expect(state.mappings.has('installation-a:object-7')).toBe(false)
    releaseRetry.release()
    await reconnecting
    adapter.outputs = []
    state.streams.get('session-1')?.({ type: 'stream_delta', text: 'output after completed clear' })
    await vi.waitFor(() => expect((manager as unknown as { messageQueues: Map<string, Promise<void>> }).messageQueues.has('sse:installation-a:object-7')).toBe(false))
    expect(adapter.outputs).toEqual([])
    expect(state.streams.has('session-1')).toBe(false)
    expect(state.streams.has('session-2')).toBe(true)
  } finally {
    releaseFirst.release(); releaseRetry.release(); releaseClear.release()
    lookup.mockRestore()
  }
})

describe('integration-owned MCP lifecycle', () => {
  it('refreshes the owning runtime on connect, pause and resume', async () => {
    (adapter.definition.capabilities as string[]).push('mcp')
    await manager.start()
    expect(state.syncMcp).toHaveBeenCalledExactlyOnceWith(['installation-a'])
    await manager.pauseIntegration('installation-a')
    expect(state.syncMcp).toHaveBeenCalledTimes(2)
    expect(updateAgentIntegrationStatus).toHaveBeenCalledWith('installation-a', 'paused', undefined)
    await manager.resumeIntegration('installation-a')
    expect(state.syncMcp).toHaveBeenCalledTimes(3)
  })

  it('leaves runtime MCP state alone for providers without the capability', async () => {
    await manager.start()
    await manager.pauseIntegration('installation-a')
    expect(state.syncMcp).not.toHaveBeenCalled()
  })
})


it.each(['active', 'error'] as const)('pause wins an already executing %s status write', async delayedStatus => {
  await manager.start()
  let release!: () => void
  let reached!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const writing = new Promise<void>(resolve => { reached = resolve })
  const status = vi.mocked(updateAgentIntegrationStatus)
  status.mockImplementation(async (id, next) => {
    if (next === delayedStatus) { reached(); await blocked }
    state.rows.find(row => row.id === id)!.status = next
    return true
  })
  try {
    const resuming = delayedStatus === 'active' ? manager.resumeIntegration('installation-a') : Promise.resolve(adapter.fail(new Error('transport failed')))
    await writing
    const pausing = manager.pauseIntegration('installation-a')
    release()
    await Promise.all([resuming, pausing])
    expect(state.rows[0].status).toBe('paused')
    expect(manager.isIntegrationConnected('installation-a')).toBe(false)
  } finally { release(); status.mockReset() }
})

it('a later resume wins a pause whose database write is still executing', async () => {
  await manager.start()
  let release!: () => void
  let reached!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const writing = new Promise<void>(resolve => { reached = resolve })
  const status = vi.mocked(updateAgentIntegrationStatus)
  status.mockImplementation(async (id, next) => {
    if (next === 'paused') { reached(); await blocked }
    state.rows.find(row => row.id === id)!.status = next
    return true
  })
  try {
    const pausing = manager.pauseIntegration('installation-a')
    await writing
    const resuming = manager.resumeIntegration('installation-a')
    release()
    await Promise.all([pausing, resuming])
    expect(state.rows[0].status).toBe('active')
    expect(manager.isIntegrationConnected('installation-a')).toBe(true)
  } finally { release(); status.mockReset() }
})


it('allows explicit setup activation after pausing without reconnecting a still-paused row', async () => {
  await manager.start()
  await manager.pauseIntegration('installation-a')
  state.rows[0].status = 'paused'
  await manager.addIntegration('installation-a')
  expect(manager.isIntegrationConnected('installation-a')).toBe(false)
  // OAuth completion persists active before addIntegration; it need not resume
  // a provider using the previous authorization first.
  state.rows[0].status = 'active'
  await manager.addIntegration('installation-a')
  expect(manager.isIntegrationConnected('installation-a')).toBe(true)
})


it('auto-pause refreshes the MCP environment after the paused status is persisted', async () => {
  (adapter.definition.capabilities as string[]).push('mcp')
  const connecting = vi.spyOn(adapter, 'connect').mockRejectedValue(new Error('upstream unavailable'))
  const status = vi.mocked(updateAgentIntegrationStatus)
  status.mockImplementation(async (id, next) => {
    state.rows.find(row => row.id === id)!.status = next
    return true
  })
  const projectedStatuses: string[] = []
  state.syncMcp.mockImplementation(async () => {
    projectedStatuses.push(state.rows[0].status)
    return true
  })
  const health = manager as unknown as { runHealthChecks(): Promise<void> }
  try {
    await manager.start()
    for (let attempt = 0; attempt < 14; attempt++) await health.runHealthChecks()
    expect(projectedStatuses).toEqual([])
    await health.runHealthChecks()
    expect(state.rows[0].status).toBe('paused')
    expect(projectedStatuses).toEqual(['paused'])
    expect(state.syncMcp).toHaveBeenCalledExactlyOnceWith(['installation-a'])
    const attempts = connecting.mock.calls.length
    await health.runHealthChecks()
    expect(connecting).toHaveBeenCalledTimes(attempts)
    expect(projectedStatuses).toEqual(['paused'])
  } finally {
    connecting.mockRestore()
    status.mockReset()
    state.syncMcp.mockReset().mockResolvedValue(true)
  }
})

it('rejects cancellation when the external target loses access', async () => {
  await manager.start()
  await adapter.input('comment')
  await vi.waitFor(() => expect(state.mappings.size).toBe(1))
  adapter.allowed = false
  const acknowledged = vi.fn()
  state.interrupt.mockResolvedValue({ interrupted: true, processKept: false })
  await adapter.cancel(acknowledged)
  expect(state.interrupt).not.toHaveBeenCalled()
  expect(acknowledged).not.toHaveBeenCalled()
})

it('contains a failed review-resolution delivery without poisoning later deliveries', async () => {
  await manager.start()
  await adapter.input('comment')
  await vi.waitFor(() => expect(state.mappings.size).toBe(1))
  adapter.outputs = []
  vi.spyOn(adapter, 'deliver').mockRejectedValueOnce(new Error('Delivery unavailable'))
  const resolution = { type: 'user_request_resolved', kind: 'proxy_review', outcome: 'answered', requestId: 'review', scope: { agentSlug: 'installation-a', sessionId: 'session-1' } }
  state.streams.get('session-1')?.(resolution)
  await vi.waitFor(() => expect(captureException).toHaveBeenCalled())
  state.streams.get('session-1')?.(resolution)
  await vi.waitFor(() => expect(adapter.outputs).toHaveLength(1))
})


describe('manager-owned runtime recovery', () => {
  function mapping(externalId: string, sessionId: string) {
    state.mappings.set(`installation-a:${externalId}`, { id: `mapping-${sessionId}`, integrationId: 'installation-a', externalChatId: externalId, sessionId })
  }
  it('reattaches only declared unfinished work and consumes completion replay before any new input', async () => {
    mapping('unfinished', 'old-session'); mapping('completed', 'settled-session')
    state.recovery = [{ externalId: 'unfinished', sessionId: 'old-session' }]
    state.subscribeStream.mockImplementation(async (id: string) => {
      // This fixture explicitly represents a settled runtime with a terminal
      // result to replay; a cold resume is covered separately with no frames.
      expect(state.activity()).toBe('working')
      state.activity.mockReturnValue('idle')
      state.streams.get(id)?.({ type: 'session_idle' })
    })
    await manager.start()
    await vi.waitFor(() => expect(adapter.outputs.some(x => x.output.type === 'turn-completed')).toBe(true))
    expect(state.subscribeStream).toHaveBeenCalledExactlyOnceWith('old-session', 'old-session')
    expect(state.create).not.toHaveBeenCalled()
    expect(state.send).not.toHaveBeenCalled()
  })
  it('undoes a silent cold attach without claiming that a turn completed', async () => {
    mapping('object-7', 'old-session')
    await manager.start()
    const context = await adapter.session('object-7')
    expect(state.markProvisionalActive).toHaveBeenCalledWith('old-session')
    expect(state.markIdle).toHaveBeenCalledWith('old-session')
    expect(context?.activity).toBe('idle')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.outputs).toEqual([])
    await adapter.input('follow-up')
    await vi.waitFor(() => expect(state.send).toHaveBeenCalled())
  })
  it('reads recovered idle activity without querying mappings or parsing provider access again', async () => {
    mapping('unfinished', 'old-session')
    await manager.start()
    const context = await adapter.session('unfinished')
    const mappingRead = vi.spyOn(integrationStore, 'getIntegrationSession').mockClear()
    const installationRead = vi.spyOn(integrationStore, 'getIntegration').mockClear()
    const accessCheck = vi.spyOn(adapter, 'isAllowed')
    expect(await adapter.session('unfinished')).toBe(context)
    expect(await adapter.session('unfinished')).toBe(context)
    expect(mappingRead).not.toHaveBeenCalled()
    expect(installationRead).not.toHaveBeenCalled()
    expect(accessCheck).not.toHaveBeenCalled()
    await manager.clearSessionById('mapping-old-session')
    expect(await adapter.session('unfinished')).toBeUndefined()
    expect(mappingRead).toHaveBeenCalled()
  })
  it('coalesces recovery and exposes live activity without giving the provider an actor', async () => {
    mapping('unfinished', 'old-session')
    let ready!: () => void
    state.subscribeStream.mockImplementation(() => new Promise<void>(resolve => { ready = resolve }))
    await manager.start()
    const one = adapter.session('unfinished'); const two = adapter.session('unfinished')
    await vi.waitFor(() => expect(state.subscribeStream).toHaveBeenCalledOnce())
    expect(adapter.outputs).toEqual([])
    ready()
    const [a, b] = await Promise.all([one, two])
    expect(a).toBe(b)
    expect(a?.activity).toBe('idle')
    state.activity.mockReturnValue('working')
    expect(a?.activity).toBe('working')
  })
  it('uses the fast path after a normal turn, but reattaches if its busy stream disappears', async () => {
    await manager.start(); await adapter.input('comment')
    await vi.waitFor(() => expect(state.mappings.size).toBe(1))
    state.isStreamSubscribed.mockReturnValue(true)
    state.activity.mockReturnValue('working')
    const context = await adapter.session('object-7')
    const mappingRead = vi.spyOn(integrationStore, 'getIntegrationSession').mockClear()
    expect(await adapter.session('object-7')).toBe(context)
    expect(mappingRead).not.toHaveBeenCalled()
    state.subscribeStream.mockClear()
    state.isStreamSubscribed.mockReturnValue(false)
    await adapter.session('object-7')
    expect(mappingRead).toHaveBeenCalled()
    expect(state.subscribeStream).toHaveBeenCalledExactlyOnceWith('session-1', 'session-1')
  })
  it('does not attach a replacement mapping for an older work item', async () => {
    mapping('unfinished', 'replacement')
    state.recovery = [{ externalId: 'unfinished', sessionId: 'old-session' }]
    await manager.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.start).not.toHaveBeenCalled()
    expect(state.subscribeStream).not.toHaveBeenCalled()
  })
  it('does not subscribe after a pause interrupts container startup', async () => {
    mapping('unfinished', 'old-session')
    let started!: () => void
    state.start.mockImplementation(() => new Promise<void>(resolve => { started = resolve }))
    await manager.start()
    const recovery = adapter.session('unfinished')
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce())
    await manager.pauseIntegration('installation-a')
    started()
    expect(await recovery).toBeUndefined()
    expect(state.subscribeStream).not.toHaveBeenCalled()
  })
  it('retains unknown activity after a failed attachment and retries locally accepted work', async () => {
    mapping('unfinished', 'old-session')
    state.subscribeStream.mockRejectedValueOnce(new Error('Container temporarily unavailable'))
    await manager.start()
    const context = await adapter.session('unfinished')
    expect(context?.activity).toBe('unknown')
    await adapter.session('unfinished')
    expect(context?.activity).toBe('idle')
    expect(state.subscribeStream).toHaveBeenCalledTimes(2)
  })
  it('reports a missing runtime session as a terminal failure', async () => {
    mapping('unfinished', 'old-session')
    state.subscribeStream.mockRejectedValue(new Error('Session not found'))
    await manager.start()
    await adapter.session('unfinished')
    await vi.waitFor(() => expect(adapter.outputs.some(x => x.output.type === 'turn-failed')).toBe(true))
  })
})


it('stops a revoked connector and refreshes its MCP projection without classifying revocation as an outage', async () => {
  (adapter.definition.capabilities as string[]).push('mcp')
  await manager.start()
  state.syncMcp.mockClear(); vi.mocked(captureException).mockClear()
  state.rows[0].status = 'disconnected'; state.rows[0].config = '{"revoked":true}'
  state.authorizationLost?.({ integrationId: 'installation-a' })
  await vi.waitFor(() => expect(adapter.connected).toBe(false))
  await vi.waitFor(() => expect(state.syncMcp).toHaveBeenCalledExactlyOnceWith(['installation-a']))
  expect(captureException).not.toHaveBeenCalled()
})
it('does not tear down replacement authorization on a late revocation notification', async () => {
  await manager.start()
  state.rows[0].config = '{"replacement":true}'
  state.authorizationLost?.({ integrationId: 'installation-a' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(adapter.connected).toBe(true)
})


it('restores a known busy session even when its runtime transport was lost', async () => {
  state.activity.mockReturnValue('working')
  state.mappings.set('installation-a:object-7', { id: 'mapping-old', integrationId: 'installation-a', externalChatId: 'object-7', sessionId: 'old' })
  state.recovery = [{ externalId: 'object-7', sessionId: 'old' }]
  await manager.start()
  await vi.waitFor(() => expect(state.subscribeStream).toHaveBeenCalledExactlyOnceWith('old', 'old'))
})
it('ignores mismatched and malformed session request frames', async () => {
  await manager.start(); await adapter.input('comment')
  await vi.waitFor(() => expect(state.mappings.size).toBe(1))
  adapter.outputs = []
  state.streams.get('session-1')?.({ type: 'user_request_created', request: { id: 'bad' } })
  state.streams.get('session-1')?.({ type: 'user_request_resolved', requestId: 'other', kind: 'question', outcome: 'answered', scope: { agentSlug: 'installation-a', sessionId: 'other-session' } })
  state.streams.get('session-1')?.({ type: 'session_idle' })
  await vi.waitFor(() => expect(adapter.outputs).toHaveLength(1))
  expect(adapter.outputs[0].output.type).toBe('turn-completed')
})


it('does not connect when the activation credential revision was invalidated during resume', async () => {
  state.rows[0].status = 'paused'
  const activate = vi.mocked(updateAgentIntegrationStatus).mockResolvedValueOnce(false)
  const connecting = vi.spyOn(adapter, 'connect')
  await manager.resumeIntegration('installation-a')
  expect(activate).toHaveBeenCalledWith('installation-a', 'active', null, { config: state.rows[0].config })
  expect(connecting).not.toHaveBeenCalled()
})


it('keeps activity and pending requests lazy during stream delivery', async () => {
  await manager.start(); await adapter.input('comment')
  await vi.waitFor(() => expect(state.mappings.size).toBe(1))
  state.open.mockClear(); state.activity.mockClear(); adapter.outputs = []
  state.streams.get('session-1')?.({ type: 'text_delta', text: 'hello' })
  await vi.waitFor(() => expect(adapter.outputs).toHaveLength(1))
  expect(state.open).not.toHaveBeenCalled()
  expect(state.activity).not.toHaveBeenCalled()
  expect(adapter.outputs[0].context.pendingRequests).toEqual([])
  expect(state.open).toHaveBeenCalledExactlyOnceWith('session-1')
})

it('tears down revoked authorization even if an unrelated config write followed the revocation', async () => {
  await manager.start()
  state.rows[0].status = 'disconnected'
  state.rows[0].config = '{"revoked":true,"transportHealth":"offline"}'
  state.authorizationLost?.({ integrationId: 'installation-a' })
  await vi.waitFor(() => expect(adapter.connected).toBe(false))
})
