import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentIntegration } from './agent-integration'
import { AgentIntegrationManager } from './agent-integration-manager'
import { AgentIntegrationRegistry } from './registry'
import { captureException } from '../error-reporting'
import { updateChatIntegrationStatus } from '../services/chat-integration-service'
import type { AgentIntegrationRecord, IntegrationInputEvent, IntegrationOutput, IntegrationSessionContext } from './types'

const state = vi.hoisted(() => ({
  rows: [] as AgentIntegrationRecord[],
  mappings: new Map<string, { id: string; integrationId: string; externalChatId: string; sessionId: string; displayName?: string }>(),
  streams: new Map<string, (event: unknown) => void>(),
  claim: vi.fn(), notify: vi.fn().mockResolvedValue(undefined),
  create: vi.fn(), start: vi.fn(), send: vi.fn(), subscribeStream: vi.fn(), register: vi.fn(), metadata: vi.fn(),
}))
vi.mock('@shared/lib/services/chat-integration-service', () => ({
  listStartupChatIntegrations: () => state.rows,
  getChatIntegration: (id: string) => state.rows.find(row => row.id === id),
  updateChatIntegrationStatus: vi.fn(),
}))
vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  resolveActiveSession: (id: string, externalId: string) => state.mappings.get(`${id}:${externalId}`),
  createChatIntegrationSession: (mapping: { integrationId: string; externalChatId: string; sessionId: string }) => {
    state.mappings.set(`${mapping.integrationId}:${mapping.externalChatId}`, { id: `mapping-${mapping.sessionId}`, ...mapping })
  },
  listActiveChatIntegrationSessions: (id: string) => [...state.mappings.values()].filter(mapping => mapping.integrationId === id),
  getChatIntegrationSession: (id: string, externalId: string) => state.mappings.get(`${id}:${externalId}`),
  getChatIntegrationSessionBySessionId: vi.fn(),
  listChatIntegrationSessions: vi.fn(() => []),
  archiveChatIntegrationSession: vi.fn(), updateChatIntegrationSessionName: vi.fn(), touchChatIntegrationSession: vi.fn(), getLastDisplayName: vi.fn(),
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: { exists: async () => true },
  agentRegistry: { get: () => ({
    container: { start: state.start },
    inputs: { claim: state.claim },
    sessions: {
      create: state.create, register: state.register, updateMetadata: state.metadata,
      markActive: vi.fn(), subscribeStream: state.subscribeStream, isStreamSubscribed: () => false,
    },
    messages: {
      send: state.send,
      withSend: (_session: string, callback: () => Promise<void>) => callback(),
      subscribe: (session: string, callback: (event: unknown) => void) => {
        state.streams.set(session, callback)
        return () => { state.streams.delete(session) }
      },
    },
  }) },
}))
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: async () => true }))
vi.mock('@shared/lib/config/settings', () => ({ getEffectiveModels: () => ({ agentModel: 'test-model' }) }))
vi.mock('@shared/lib/services/agent-preferences-service', () => ({ readAgentPreferences: async () => ({}) }))
vi.mock('@shared/lib/services/secrets-service', () => ({ getSecretEnvVars: async () => [] }))
vi.mock('@shared/lib/container/message-persister', () => ({ messagePersister: { addGlobalNotificationClient: () => () => {} } }))
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
  prepareInput = vi.fn(async (event: IntegrationInputEvent) => ({ text: `Object context: ${(event.payload as { text: string }).text}` }))
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
  fail(error: Error) { this.emitError(error) }
  input(comment: string, text = 'hello') {
    return this.emitEvent({ type: 'input', externalId: comment, id: comment, timestamp: new Date(), payload: { objectId: 'object-7', text } })
  }
}

function record(id: string): AgentIntegrationRecord {
  return { id, agentSlug: id, provider: 'test-objects', name: null, config: '{}', status: 'active', errorMessage: null,
    model: null, effort: null, speed: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() }
}

let manager: AgentIntegrationManager
let adapter: ObjectIntegration
let registry: AgentIntegrationRegistry
beforeEach(async () => {
  vi.clearAllMocks()
  state.rows = [record('installation-a')]
  state.mappings.clear()
  state.streams.clear()
  state.create.mockImplementation(async () => ({ id: `session-${state.create.mock.calls.length}` }))
  state.subscribeStream.mockResolvedValue(undefined)
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
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith('session-1', 'Object context: follow-up'))
    expect(state.create).toHaveBeenCalledOnce()
    expect(state.mappings.get('installation-a:object-7')?.sessionId).toBe('session-1')
    expect(state.metadata).toHaveBeenCalledWith('session-1', {})
    expect('sendMessage' in adapter).toBe(false)
    expect(adapter.prepareInput).toHaveBeenCalledTimes(2)
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
    expect(updateChatIntegrationStatus).not.toHaveBeenCalled()
    expect(state.notify).not.toHaveBeenCalled()
    expect(adapter.isConnected()).toBe(true)
  })

  it('reports a synchronous routing failure and continues accepting subsequent input', async () => {
    await manager.start()
    await vi.dynamicImportSettled()
    state.notify.mockClear()
    const failure = new Error('Invalid route')
    vi.spyOn(adapter, 'resolveRoute').mockImplementationOnce(() => { throw failure })

    await expect(adapter.input('bad-comment')).resolves.toBeUndefined()
    await vi.dynamicImportSettled()

    expect(captureException).toHaveBeenCalledWith(failure, expect.objectContaining({
      tags: { component: 'agent-integration', operation: 'event-handler' },
      extra: expect.objectContaining({ eventType: 'input' }),
    }))
    expect(updateChatIntegrationStatus).not.toHaveBeenCalled()
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

    expect(updateChatIntegrationStatus).toHaveBeenCalledWith('installation-a', 'error', 'Connection lost')
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
    expect(state.metadata).toHaveBeenCalledWith(sessionId, {})
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
})
