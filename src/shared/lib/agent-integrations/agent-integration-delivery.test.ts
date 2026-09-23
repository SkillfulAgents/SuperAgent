import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations, chatIntegrationSessions, integrationDeliveries } from '../db/schema'
import { AgentIntegrationManager } from './agent-integration-manager'
import { AgentIntegrationRegistry } from './registry'
import { MockChatAgentIntegration } from '../chat-integrations/mock-connector'
import { TaskManagerAgentIntegration } from '../task-manager-integrations/task-manager-agent-integration'
import type { TaskEvent } from '../task-manager-integrations/types'
import type { AgentIntegrationRecord } from './types'
import { getAgentIntegration } from '../services/agent-integration-service'
import { getAgentIntegrationSession, archiveAgentIntegrationSession } from '../services/agent-integration-session-service'
import { requireIntegrationReconnect } from './lifecycle'
import { deliveryStore } from './delivery-store'
import { MessageNotAcceptedError } from '../container/message-dispatch-error'
import type { CreateSessionOptions } from '../container/types'
let handle: TestDatabase
let database: AppDatabase
vi.mock('../db', () => ({ get db() { return database } }))
const runtime = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), start: vi.fn(), receipt: vi.fn(), register: vi.fn(), interrupt: vi.fn(), attach: vi.fn(), subscribed: vi.fn(), subscribe: vi.fn() }))
vi.mock('../agent-actor', () => ({ agentRegistry: { get: () => ({
  container: { start: runtime.start }, inputs: { open: () => [], cancelAwaiting: async () => {} },
  sessions: { create: runtime.create, register: runtime.register, updateMetadata: async () => {}, markActive: () => {},
    subscribeStream: runtime.attach, isStreamSubscribed: runtime.subscribed, activity: () => 'working', isAwaitingInput: () => false },
  messages: { send: runtime.send, interrupt: runtime.interrupt, findLastEntry: runtime.receipt,
    subscribe: runtime.subscribe, withSend: (_id: string, send: () => Promise<void>) => send() },
}) } }))
vi.mock('../services/agent-service', () => ({ agentExists: async () => true }))
vi.mock('../config/settings', () => ({ getSettings: () => ({}), getEffectiveModels: () => ({ agentModel: 'test' }) }))
vi.mock('../services/agent-preferences-service', () => ({ readAgentPreferences: async () => ({}) }))
vi.mock('../services/secrets-service', () => ({ getSecretEnvVars: async () => [] }))
vi.mock('../container/message-persister', () => ({ messagePersister: { addGlobalNotificationClient: () => () => {} } }))
vi.mock('../notifications/notification-manager', () => ({ notificationManager: { triggerChatIntegrationEvent: async () => {} } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))
vi.mock('../services/connection-sync-service', () => ({ syncRemoteMcpAgents: async () => {} }))
class Chat extends MockChatAgentIntegration {
  acknowledgeInput = vi.fn(async () => {})
  input(id = 'input', chatId = 'conversation') { return this.emitEvent({ type: 'input', id, externalId: chatId, timestamp: new Date(), payload: {
    externalMessageId: id, chatId, text: id, userId: 'human', timestamp: new Date(),
  } }) }
  cancel() { return this.emitEvent({ type: 'cancel', externalId: 'conversation' }) }
}
class Tasks extends TaskManagerAgentIntegration {
  readonly provider = 'linear'
  readonly definition = { provider: 'linear', family: 'task-manager', name: 'Tasks', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } }
  constructor(row: AgentIntegrationRecord) { super(row) }
  async connect() { this.connected = true }
  async disconnect() { this.connected = false }
  protected publishMessage = vi.fn(async () => {})
  protected taskGuidance() { return 'Reply to this issue.' }
  protected async hydrateTask() { return { id: 'conversation', identifier: 'TEST-1', title: 'Test', description: '', url: 'https://example.com', updatedAt: '', properties: {}, comments: [], attachments: [], truncated: false } }
  input(id = 'input') { return this.acceptTaskEvent({ id, taskId: 'conversation', interactionId: 'conversation', kind: 'invocation', timestamp: new Date().toISOString(), text: id, replyTarget: { commentId: 'thread' }, payload: {} } satisfies TaskEvent) }
}
let manager: AgentIntegrationManager
let adapter: Chat | Tasks
async function start(provider: 'slack' | 'telegram' | 'imessage' | 'linear' = 'slack') {
  if (!(await getAgentIntegration('integration'))) await database.insert(chatIntegrations).values({
    id: 'integration', provider, agentSlug: 'agent', config: '{}', requireApproval: false, createdAt: new Date(), updatedAt: new Date(),
  }).run()
  adapter = provider === 'linear' ? new Tasks((await getAgentIntegration('integration'))!) : Object.assign(new Chat(), { provider })
  const registry = new AgentIntegrationRegistry([{ definition: adapter.definition, policy: adapter, create: async () => adapter }])
  manager = new AgentIntegrationManager(registry)
  await manager.start()
}
async function rows() { return database.select().from(integrationDeliveries).all() }
beforeEach(async () => {
  handle = await createTestDatabase(); database = handle.db; vi.clearAllMocks()
  runtime.create.mockImplementation(async (options: CreateSessionOptions) => {
    // POST /sessions and SessionManager both reject a missing/empty first input.
    if (!options.initialMessage) throw Object.assign(new Error('initialMessage is required'), { status: 400 })
    expect(options.initialMessageUuid).toBeTruthy()
    expect((await rows()).find(row => row.id === options.initialMessageUuid)?.state).toBe('sending')
    return { id: `session-${runtime.create.mock.calls.length}` }
  })
  runtime.attach.mockResolvedValue(undefined); runtime.subscribed.mockReturnValue(true)
  runtime.subscribe.mockImplementation(() => () => {})
  runtime.send.mockResolvedValue(undefined); runtime.start.mockResolvedValue(undefined); runtime.receipt.mockResolvedValue(null)
  runtime.interrupt.mockResolvedValue({ interrupted: true })
})
afterEach(async () => { vi.restoreAllMocks(); manager?.stop(); await new Promise(resolve => setTimeout(resolve, 20)); await handle.close() })

describe('shared manager durability with real integration storage', () => {
  it.each(['slack', 'telegram', 'imessage', 'linear'] as const)('uses one durable path and immediate running-session delivery for %s', async provider => {
    await start(provider)
    runtime.send.mockImplementation(async (sessionId: string, _text: string, uuid: string) => {
      expect((await getAgentIntegrationSession('integration', 'conversation'))?.sessionId).toBe(sessionId)
      expect((await rows()).find(row => row.id === uuid)?.state).toBe('sending')
    })
    await adapter.input('first')
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    await adapter.input('second'); await adapter.input('first')
    await vi.waitFor(async () => expect((await rows()).filter(row => row.state === 'delivered')).toHaveLength(2))
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(runtime.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ initialMessage: expect.stringContaining('first') }))
    expect(runtime.send.mock.calls[0][0]).toBe('session-1')
    if (adapter instanceof Chat) expect(adapter.acknowledgeInput).toHaveBeenCalledTimes(2)
  })
  it('recovers locally accepted input after a manager restart', async () => {
    await start(); await adapter.disconnect()
    await adapter.input('saved') // manager persists before a live transport is available
    expect((await rows())[0].state).toBe('pending')
    manager.stop(); await start()
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    expect(runtime.create).toHaveBeenCalledOnce()
    expect(runtime.send).not.toHaveBeenCalled()
  })
  it.each(['pause', 'authorization', 'reset', 'cancel'] as const)('%s during preparation prevents spending and does not resume the old input', async action => {
    await start()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const prepare = vi.spyOn(adapter, 'prepareInput').mockImplementationOnce(async () => { await gate; return { text: 'late' } })
    await adapter.input()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled())
    if (action === 'pause') await manager.pauseIntegration('integration')
    if (action === 'authorization') await requireIntegrationReconnect({ integrationId: 'integration', expectedConfig: '{}', config: {}, message: 'Reconnect' })
    if (action === 'reset') {
      // Clearing by mapping ID also covers sessions not currently observed by a connector.
      await database.insert((await import('../db/schema')).chatIntegrationSessions).values({ id: 'mapping', integrationId: 'integration', externalChatId: 'conversation', sessionId: 'old', createdAt: new Date(), updatedAt: new Date() }).run()
      await manager.clearSessionById('mapping'); await archiveAgentIntegrationSession('mapping')
    }
    if (action === 'cancel') await (adapter as Chat).cancel()
    release()
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('cancelled'))
    expect(runtime.send).not.toHaveBeenCalled()
    expect(runtime.create).not.toHaveBeenCalled()
  })
  it.each(['reset', 'timeout', 'missing session'] as const)('sends one nonempty first input after %s', async reason => {
    await start()
    await adapter.input('first')
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    if (reason === 'reset') {
      await adapter.input('/clear')
      await vi.waitFor(async () => expect((await rows()).find(row => row.eventId === '/clear')?.state).toBe('delivered'))
    } else if (reason === 'timeout') {
      vi.spyOn(adapter, 'sessionPolicy').mockReturnValue({ name: 'Chat', metadata: {}, timeoutHours: 1 })
      await database.update(chatIntegrationSessions).set({ updatedAt: new Date(0) }).run()
    } else {
      runtime.send.mockRejectedValueOnce(new MessageNotAcceptedError('session-gone', 'Session not found'))
    }
    await adapter.input('after')
    await vi.waitFor(async () => expect((await rows()).find(row => row.eventId === 'after')?.state).toBe('delivered'))
    expect(runtime.create).toHaveBeenCalledTimes(2)
    expect(runtime.create.mock.calls[1][0]).toMatchObject({ initialMessage: expect.stringContaining('after') })
    // A missing-session refusal may call send; the new session's input never does.
    expect(runtime.send).toHaveBeenCalledTimes(reason === 'missing session' ? 1 : 0)
  })
  it.each(['attach', 'send'] as const)('retains the input and follow-ups after %s self-heal fails before acceptance', async path => {
    await start(); await adapter.input('first')
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    if (path === 'attach') {
      runtime.subscribed.mockReturnValue(false)
      runtime.attach.mockRejectedValueOnce(new Error('Session not found'))
    } else runtime.send.mockRejectedValueOnce(new MessageNotAcceptedError('session-gone', 'Session not found'))
    runtime.create.mockRejectedValueOnce(new MessageNotAcceptedError('unavailable', 'Container stopped'))
    await adapter.input('retry-me')
    await vi.waitFor(async () => expect((await rows()).find(row => row.eventId === 'retry-me')).toMatchObject({ state: 'pending', sessionId: null, attempts: 1 }))
    // A newer input creates a replacement mapping during the first input's backoff.
    await adapter.input('follow-up')
    await vi.waitFor(async () => expect((await rows()).find(row => row.eventId === 'follow-up')?.state).toBe('delivered'))
    await vi.waitFor(async () => expect((await rows()).find(row => row.eventId === 'retry-me')?.state).toBe('delivered'), { timeout: 4000 })
    expect((await rows()).every(row => row.state === 'delivered')).toBe(true)
    expect(runtime.send).toHaveBeenLastCalledWith('session-3', expect.stringContaining('retry-me'), expect.any(String))
  })
  it('another chat reset during the sending checkpoint does not cancel this input', async () => {
    await start(); await adapter.input('first')
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    await database.insert(chatIntegrationSessions).values({ id: 'other', integrationId: 'integration', externalChatId: 'other', sessionId: 'other-session', createdAt: new Date(), updatedAt: new Date() }).run()
    const handoff = deliveryStore.handoff.bind(deliveryStore)
    let reset = false
    vi.spyOn(deliveryStore, 'handoff').mockImplementation(async (...args) => {
      const accepted = await handoff(...args)
      if (!reset) { reset = true; await manager.clearSessionById('other'); await archiveAgentIntegrationSession('other') }
      return accepted
    })
    await adapter.input('unaffected')
    await vi.waitFor(async () => expect((await rows()).find(row => row.eventId === 'unaffected')?.state).toBe('delivered'))
    expect(runtime.send).toHaveBeenCalledOnce()
    expect((await rows()).every(row => row.noticeState === 'none')).toBe(true)
  })
  it.each(['slack', 'telegram', 'imessage', 'linear'] as const)('finishes accepted creation through a connector replacement for %s', async provider => {
    await start(provider)
    let finishCreate!: () => void
    const gate = new Promise<void>(resolve => { finishCreate = resolve })
    const create = runtime.create.getMockImplementation()!
    runtime.create.mockImplementationOnce(async options => { await gate; return create(options) })
    const previous = adapter
    await previous.input('first')
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce())
    adapter = provider === 'linear' ? new Tasks((await getAgentIntegration('integration'))!) : Object.assign(new Chat(), { provider })
    const deliver = vi.spyOn(adapter, 'deliver')
    await manager.reconnectAll()
    finishCreate()
    await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ state: 'delivered', sessionId: 'session-1' }))
    expect((await getAgentIntegrationSession('integration', 'conversation'))?.sessionId).toBe('session-1')
    runtime.subscribe.mock.calls.at(-1)![1]({ type: 'session_idle' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }), expect.objectContaining({ type: 'turn-completed' })))
    await adapter.input('follow-up')
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledWith('session-1', expect.stringContaining('follow-up'), expect.any(String)))
    expect(runtime.create).toHaveBeenCalledOnce()
  })
  it('saves routing while teardown has removed the connector, then restores delivery on connect', async () => {
    await start()
    let finishCreate!: () => void
    const createGate = new Promise<void>(resolve => { finishCreate = resolve })
    const create = runtime.create.getMockImplementation()!
    runtime.create.mockImplementationOnce(async options => { await createGate; return create(options) })
    await adapter.input('first')
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce())
    let finishDisconnect!: () => void
    const disconnectGate = new Promise<void>(resolve => { finishDisconnect = resolve })
    const old = adapter
    const disconnect = vi.spyOn(old, 'disconnect').mockImplementation(async () => { await disconnectGate })
    adapter = Object.assign(new Chat(), { provider: 'slack' })
    runtime.subscribed.mockReturnValue(false)
    const reconnect = manager.reconnectAll()
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce())
    try {
      finishCreate()
      await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ state: 'delivered', sessionId: 'session-1' }))
      expect((await getAgentIntegrationSession('integration', 'conversation'))?.sessionId).toBe('session-1')
      expect(runtime.attach).not.toHaveBeenCalled()
    } finally { finishDisconnect(); await reconnect }
    await vi.waitFor(() => expect(runtime.attach).toHaveBeenCalledWith('session-1', 'session-1'))
    const deliver = vi.spyOn(adapter, 'deliver')
    runtime.subscribe.mock.calls.at(-1)![1]({ type: 'session_idle' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }), expect.objectContaining({ type: 'turn-completed' })))
  })
  it.each(['pause', 'cancel', 'authorization'] as const)('%s while creation is in flight prevents a late mapping', async action => {
    await start()
    let finishCreate!: () => void
    const gate = new Promise<void>(resolve => { finishCreate = resolve })
    const create = runtime.create.getMockImplementation()!
    runtime.create.mockImplementationOnce(async options => { const result = await create(options); await gate; return result })
    await adapter.input('first')
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce())
    if (action === 'pause') await manager.pauseIntegration('integration')
    if (action === 'cancel') await (adapter as Chat).cancel()
    if (action === 'authorization') await requireIntegrationReconnect({ integrationId: 'integration', expectedConfig: '{}', config: {}, message: 'Reconnect' })
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('cancelled'))
    finishCreate()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await getAgentIntegrationSession('integration', 'conversation')).toBeNull()
    expect(runtime.register).not.toHaveBeenCalled()
    expect(runtime.attach).not.toHaveBeenCalled()
  })
  it('does not replay a creation whose response was lost after the first input may have run', async () => {
    await start()
    runtime.create.mockRejectedValueOnce(new Error('connection reset after POST /sessions'))
    await adapter.input('first')
    await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ state: 'uncertain', noticeState: 'sent' }))
    manager.stop(); await start()
    expect(runtime.create).toHaveBeenCalledOnce()
    expect(runtime.send).not.toHaveBeenCalled()
  })
  it('retains known acceptance when new-session registration fails after creation', async () => {
    await start()
    runtime.register.mockRejectedValueOnce(new Error('temporary metadata failure'))
    await adapter.input('first')
    await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ state: 'delivered', sessionId: 'session-1', noticeState: 'none' }))
    manager.stop(); await start()
    expect(runtime.create).toHaveBeenCalledOnce()
    expect(runtime.receipt).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
  })
  it('does not repeat a successful route notice after a later preparation failure and restart', async () => {
    await start()
    const resolve = adapter.resolveRoute.bind(adapter)
    vi.spyOn(adapter, 'resolveRoute').mockImplementation(event => ({ ...resolve(event), notice: 'Starting work' }))
    const deliver = vi.spyOn(adapter, 'deliver')
    runtime.start.mockRejectedValueOnce(new Error('temporarily unavailable'))
    await adapter.input('first')
    await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ state: 'pending', attempts: 1 }))
    expect(deliver.mock.calls.filter(([, output]) => output.type === 'message' && output.text === 'Starting work')).toHaveLength(1)
    manager.stop(); await start()
    const afterRestart = vi.spyOn(adapter, 'deliver')
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'), { timeout: 4000 })
    expect(afterRestart.mock.calls.filter(([, output]) => output.type === 'message' && output.text === 'Starting work')).toHaveLength(0)
  })
  it('reconciles a known runtime UUID on startup without another send', async () => {
    await start(); await adapter.input()
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    manager.stop()
    const row = (await rows())[0]
    await database.update(integrationDeliveries).set({ state: 'sending', owner: 'dead-host' }).where(eq(integrationDeliveries.id, row.id)).run()
    runtime.receipt.mockImplementation(async (_session, predicate: (entry: unknown) => boolean) => {
      const receipt = { type: 'user', uuid: row.id }
      expect(predicate(receipt)).toBe(true)
      expect(predicate({ type: 'user', uuid: 'different-message' })).toBe(false)
      return receipt
    })
    await start()
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    expect(runtime.create).toHaveBeenCalledOnce()
    expect(runtime.send).not.toHaveBeenCalled()
  })
})
