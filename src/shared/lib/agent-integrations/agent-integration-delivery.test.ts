import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations, integrationDeliveries } from '../db/schema'
import { AgentIntegrationManager } from './agent-integration-manager'
import { AgentIntegrationRegistry } from './registry'
import { MockChatAgentIntegration } from '../chat-integrations/mock-connector'
import { TaskManagerAgentIntegration } from '../task-manager-integrations/task-manager-agent-integration'
import type { TaskEvent } from '../task-manager-integrations/types'
import type { AgentIntegrationRecord } from './types'
import { getAgentIntegration } from '../services/agent-integration-service'
import { getAgentIntegrationSession, archiveAgentIntegrationSession } from '../services/agent-integration-session-service'
import { requireIntegrationReconnect } from './lifecycle'
let handle: TestDatabase
let database: AppDatabase
vi.mock('../db', () => ({ get db() { return database } }))
const runtime = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), start: vi.fn(), receipt: vi.fn(), register: vi.fn(), interrupt: vi.fn() }))
vi.mock('../agent-actor', () => ({ agentRegistry: { get: () => ({
  container: { start: runtime.start }, inputs: { open: () => [], cancelAwaiting: async () => {} },
  sessions: { create: runtime.create, register: runtime.register, updateMetadata: async () => {}, markActive: () => {},
    subscribeStream: async () => {}, isStreamSubscribed: () => true, activity: () => 'working', isAwaitingInput: () => false },
  messages: { send: runtime.send, interrupt: runtime.interrupt, findLastEntry: runtime.receipt,
    subscribe: () => () => {}, withSend: (_id: string, send: () => Promise<void>) => send() },
}) } }))
vi.mock('../services/agent-service', () => ({ agentExists: async () => true }))
vi.mock('../config/settings', () => ({ getEffectiveModels: () => ({ agentModel: 'test' }) }))
vi.mock('../services/agent-preferences-service', () => ({ readAgentPreferences: async () => ({}) }))
vi.mock('../services/secrets-service', () => ({ getSecretEnvVars: async () => [] }))
vi.mock('../container/message-persister', () => ({ messagePersister: { addGlobalNotificationClient: () => () => {} } }))
vi.mock('../notifications/notification-manager', () => ({ notificationManager: { triggerChatIntegrationEvent: async () => {} } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))
vi.mock('../services/connection-sync-service', () => ({ syncRemoteMcpAgents: async () => {} }))
class Chat extends MockChatAgentIntegration {
  acknowledgeInput = vi.fn(async () => {})
  input(id = 'input') { return this.emitEvent({ type: 'input', id, externalId: 'conversation', timestamp: new Date(), payload: {
    externalMessageId: id, chatId: 'conversation', text: id, userId: 'human', timestamp: new Date(),
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
  runtime.create.mockImplementation(async () => ({ id: `session-${runtime.create.mock.calls.length}` }))
  runtime.send.mockResolvedValue(undefined); runtime.start.mockResolvedValue(undefined); runtime.receipt.mockResolvedValue(null)
  runtime.interrupt.mockResolvedValue({ interrupted: true })
})
afterEach(async () => { manager?.stop(); await new Promise(resolve => setTimeout(resolve, 20)); await handle.close() })

describe('shared manager durability with real integration storage', () => {
  it.each(['slack', 'telegram', 'imessage', 'linear'] as const)('uses one durable path and immediate running-session delivery for %s', async provider => {
    await start(provider)
    runtime.send.mockImplementation(async (sessionId: string, _text: string, uuid: string) => {
      expect((await getAgentIntegrationSession('integration', 'conversation'))?.sessionId).toBe(sessionId)
      expect((await rows()).find(row => row.id === uuid)?.state).toBe('sending')
    })
    await adapter.input('first')
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(1))
    await adapter.input('second'); await adapter.input('first')
    await vi.waitFor(async () => expect((await rows()).filter(row => row.state === 'delivered')).toHaveLength(2))
    expect(runtime.send).toHaveBeenCalledTimes(2)
    expect(runtime.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ initialMessage: '' }))
    expect(runtime.send.mock.calls[0][0]).toBe(runtime.send.mock.calls[1][0])
    if (adapter instanceof Chat) expect(adapter.acknowledgeInput).toHaveBeenCalledTimes(2)
  })
  it('recovers locally accepted input after a manager restart', async () => {
    await start(); await adapter.disconnect()
    await adapter.input('saved') // manager persists before a live transport is available
    expect((await rows())[0].state).toBe('pending')
    manager.stop(); await start()
    await vi.waitFor(async () => expect((await rows())[0].state).toBe('delivered'))
    expect(runtime.send).toHaveBeenCalledOnce()
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
    expect(runtime.send).toHaveBeenCalledOnce()
  })
})
