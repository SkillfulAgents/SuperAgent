import { testDeliveryAttempt } from './testing/delivery-attempt'
import type { IntegrationRoute } from './types'
import type { DeliveryAttempt } from './delivery-queue'
vi.mock('./delivery-store', async () => ({ deliveryStore: (await import('./testing/memory-delivery-store')).memoryDeliveryStore() }))
import { inputEvent, mockChatIntegration } from '../chat-integrations/test-helpers'
import type { IntegrationInputEvent } from './types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatIntegration } from '@shared/lib/db/schema'
import type { IncomingMessage } from '../chat-integrations/chat-agent-integration'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  inDeliveryTurn: vi.fn(),
  notice: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({
    isSubscribed: () => true,
    inDeliveryTurn: (...args) => mocks.inDeliveryTurn(...args),
  }),
}))
vi.mock('@shared/lib/services/session-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/session-service')>()),
  getSessionMetadata: async () => null,
  updateSessionMetadata: async () => undefined,
}))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      ensureRunning: async () => ({ sendMessage: mocks.send }),
      // The actor reaches the client through getClient after start().
      getClient: () => ({ sendMessage: mocks.send }),
    }),
  }
})
vi.mock('@shared/lib/services/agent-integration-service', () => ({ getAgentIntegration: () => integration('slack') }))
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: async () => true }))
vi.mock('@shared/lib/services/chat-integration-access-service', () => ({
  decideInboundAccess: () => ({ action: 'allowed' }),
  isChatAllowed: () => true,
}))
vi.mock('@shared/lib/services/agent-integration-session-service', () => ({
  resolveActiveSession: () => ({ id: 'mapping', sessionId: 'existing-session', displayName: 'Chat' }),
  touchAgentIntegrationSession: vi.fn(),
}))
vi.mock('../chat-integrations/resolve-awaiting-input', () => ({ consumeOrCancelAwaitingInput: async () => false }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { agentIntegrationManager } from './agent-integration-manager'

const manager = agentIntegrationManager as unknown as {
  connections: Map<string, unknown>
  lastSessionTouch: Map<string, number>
  handleIncomingMessageInner(id: string, message: IntegrationInputEvent, integration: ChatIntegration, route: IntegrationRoute, attempt: DeliveryAttempt): Promise<void>
  subscribeChatSession(integrationId: string, chatId: string, sessionId: string): void
}
const message: IncomingMessage = {
  chatId: 'chat', text: 'continue', externalMessageId: 'message', userId: 'user', timestamp: new Date(),
}
function integration(provider: ChatIntegration['provider']): ChatIntegration {
  return { id: 'integration', agentSlug: 'agent', provider, sessionTimeout: null } as ChatIntegration
}

const connector = mockChatIntegration({ sendMessage: mocks.notice })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.inDeliveryTurn.mockImplementation((_slug, _session, work: () => Promise<unknown>) => work())
  mocks.send.mockResolvedValue({})
  manager.connections.set('integration', { connector, integration: integration('slack') })
  vi.spyOn(manager, 'subscribeChatSession').mockImplementation(() => {})
  vi.spyOn(connector, 'prepareInput').mockResolvedValue({ text: 'continue' })
})
afterEach(() => {
  manager.connections.delete('integration')
  manager.lastSessionTouch.clear()
  vi.restoreAllMocks()
})

describe('chat session delivery', () => {
  it.each(['slack', 'telegram', 'imessage'] as const)('uses the shared send lifecycle for the same %s session', async (provider) => {
    await manager.handleIncomingMessageInner('integration', inputEvent(message), integration(provider), connector.resolveRoute(inputEvent(message)), testDeliveryAttempt)
    expect(mocks.inDeliveryTurn).toHaveBeenCalledExactlyOnceWith('agent', 'existing-session', expect.any(Function))
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('existing-session', 'continue', 'delivery-uuid', expect.objectContaining({ sessionMetadata: null }))
  })

  it('enters the shared send lifecycle after attachment preparation', async () => {
    let prepared = false
    vi.mocked(connector.prepareInput).mockImplementation(async () => {
      prepared = true
      return { text: 'continue' }
    })
    mocks.inDeliveryTurn.mockImplementation(async (_slug, _session, work: () => Promise<unknown>) => {
      expect(prepared).toBe(true)
      return work()
    })
    await manager.handleIncomingMessageInner('integration', inputEvent(message), integration('slack'), connector.resolveRoute(inputEvent(message)), testDeliveryAttempt)
    expect(mocks.send).toHaveBeenCalledOnce()
  })

  it('propagates a shared reconnect failure to the durable scheduler without sending', async () => {
    mocks.inDeliveryTurn.mockRejectedValueOnce(new Error('connection unavailable'))
    await expect(manager.handleIncomingMessageInner('integration', inputEvent(message), integration('slack'), connector.resolveRoute(inputEvent(message)), testDeliveryAttempt)).rejects.toThrow('connection unavailable')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.notice).not.toHaveBeenCalled()
  })
})
