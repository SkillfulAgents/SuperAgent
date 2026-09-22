vi.mock('../agent-integrations/delivery-store', async () => ({ deliveryStore: (await import('../agent-integrations/testing/memory-delivery-store')).memoryDeliveryStore() }))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskManagerAgentIntegration } from './task-manager-agent-integration'
import { AgentIntegrationManager } from '../agent-integrations/agent-integration-manager'
import { AgentIntegrationRegistry } from '../agent-integrations/registry'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import type { TaskEvent } from './types'
const runtime = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'session' })), send: vi.fn(async () => {}),
  mapping: undefined as { id: string; integrationId: string; externalChatId: string; sessionId: string; displayName?: string } | undefined,
  row: { id: 'integration', agentSlug: 'agent', provider: 'tasks', config: '{}', status: 'active', name: null,
    errorMessage: null, model: null, effort: null, speed: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() } as AgentIntegrationRecord,
}))
vi.mock('../services/agent-integration-service', () => ({ listStartupAgentIntegrations: () => [runtime.row], getAgentIntegration: () => runtime.row }))
vi.mock('../services/agent-integration-session-service', () => ({
  listActiveAgentIntegrationSessions: () => [], resolveActiveSession: () => runtime.mapping,
  createAgentIntegrationSession: (mapping: Omit<NonNullable<typeof runtime.mapping>, 'id'>) => { runtime.mapping = { id: 'mapping', ...mapping } },
  getAgentIntegrationSession: () => runtime.mapping, touchAgentIntegrationSession: async () => {},
}))
vi.mock('../agent-actor', () => ({ agentRegistry: { get: () => ({
  container: { start: async () => {} },
  sessions: { create: runtime.create, register: async () => {}, updateMetadata: async () => {}, markActive: () => {},
    subscribeStream: async () => {}, isStreamSubscribed: () => true, activity: () => 'working' },
  messages: { send: runtime.send, subscribe: () => () => {}, withSend: (_id: string, send: () => Promise<void>) => send() },
}) } }))
vi.mock('../services/agent-service', () => ({ agentExists: async () => true }))
vi.mock('../config/settings', () => ({ getEffectiveModels: () => ({ agentModel: 'test-model' }) }))
vi.mock('../services/agent-preferences-service', () => ({ readAgentPreferences: async () => ({}) }))
vi.mock('../services/secrets-service', () => ({ getSecretEnvVars: async () => [] }))
vi.mock('../container/message-persister', () => ({ messagePersister: { addGlobalNotificationClient: () => () => {} } }))
vi.mock('../notifications/notification-manager', () => ({ notificationManager: { triggerChatIntegrationEvent: async () => {} } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))
vi.mock('../agent-integrations/lifecycle', () => ({ onIntegrationAuthorizationLost: () => () => {} }))
class Tasks extends TaskManagerAgentIntegration {
  readonly provider = 'tasks'
  readonly definition = { provider: 'tasks', name: 'Tasks', family: 'task-manager', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } }
  constructor() { super(runtime.row) }
  async connect() { this.connected = true }
  async disconnect() { this.connected = false }
  protected async publishMessage() {}
  protected taskGuidance() { return 'Reply through your MCP identity.' }
  protected async hydrateTask(taskId: string) { return { id: taskId, identifier: 'SUP-1', title: 'Work', description: '', url: 'https://example.com', updatedAt: 'now', properties: {}, comments: [], attachments: [], truncated: false } }
  input(id: string) { return this.acceptTaskEvent({ id, taskId: 'issue', interactionId: 'issue', kind: 'invocation', timestamp: new Date().toISOString(), text: id, replyTarget: { commentId: id }, payload: {} } satisfies TaskEvent) }
}
let manager: AgentIntegrationManager | undefined
afterEach(() => { manager?.stop(); vi.clearAllMocks() })
describe('task inputs through the shared integration manager', () => {
  it('sends the follow-up to the running session without a terminal frame or a new session', async () => {
    runtime.mapping = undefined
    const tasks = new Tasks()
    manager = new AgentIntegrationManager(new AgentIntegrationRegistry([{ definition: tasks.definition, policy: tasks, create: async () => tasks }]))
    await manager.start()
    await tasks.input('first-thread')
    await vi.waitFor(() => expect(runtime.mapping?.sessionId).toBe('session'))
    // The runtime remains working throughout this test. No completion/idle frame
    // arrives, so any task-family turn lock would prevent the following send.
    await tasks.input('second-thread')
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledWith('session', expect.stringContaining('comment thread second-thread'), expect.any(String)))
    expect(runtime.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ initialMessage: expect.stringContaining('comment thread first-thread'), initialMessageUuid: expect.any(String) }))
    expect(runtime.send).toHaveBeenCalledOnce()
  })
})
