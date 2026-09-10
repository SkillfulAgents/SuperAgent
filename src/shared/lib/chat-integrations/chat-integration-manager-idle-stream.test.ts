import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatIntegration } from '@shared/lib/db/schema'
import type { IncomingMessage } from './base-connector'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  withSessionSend: vi.fn(),
  notice: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    isSubscribed: () => true,
    withSessionSend: (...args: unknown[]) => mocks.withSessionSend(...args),
  },
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
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: async () => true }))
vi.mock('@shared/lib/services/chat-integration-access-service', () => ({
  decideInboundAccess: () => ({ action: 'allowed' }),
  isChatAllowed: () => true,
}))
vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  resolveActiveSession: () => ({ id: 'mapping', sessionId: 'existing-session', displayName: 'Chat' }),
  touchChatIntegrationSession: vi.fn(),
}))
vi.mock('./resolve-awaiting-input', () => ({ consumeOrCancelAwaitingInput: async () => false }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { chatIntegrationManager } from './chat-integration-manager'

const manager = chatIntegrationManager as unknown as {
  connections: Map<string, unknown>
  lastSessionTouch: Map<string, number>
  handleIncomingMessageInner(id: string, message: IncomingMessage, integration: ChatIntegration): Promise<void>
  subscribeChatSession(integrationId: string, chatId: string, sessionId: string): void
  deriveDisplayName(): string
  buildMessageContent(): Promise<{ text: string; failedFiles: string[] }>
}
const message: IncomingMessage = {
  chatId: 'chat', text: 'continue', externalMessageId: 'message', userId: 'user', timestamp: new Date(),
}
function integration(provider: ChatIntegration['provider']): ChatIntegration {
  return { id: 'integration', agentSlug: 'agent', provider, sessionTimeout: null } as ChatIntegration
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withSessionSend.mockImplementation((_slug, _session, _client, send: () => Promise<void>) => send())
  mocks.send.mockResolvedValue(undefined)
  manager.connections.set('integration', { connector: { sendMessage: mocks.notice } })
  vi.spyOn(manager, 'subscribeChatSession').mockImplementation(() => {})
  vi.spyOn(manager, 'deriveDisplayName').mockReturnValue('Chat')
  vi.spyOn(manager, 'buildMessageContent').mockResolvedValue({ text: 'continue', failedFiles: [] })
})
afterEach(() => {
  manager.connections.delete('integration')
  manager.lastSessionTouch.clear()
  vi.restoreAllMocks()
})

describe('chat session delivery', () => {
  it.each(['slack', 'telegram', 'imessage'] as const)('uses the shared send lifecycle for the same %s session', async (provider) => {
    await manager.handleIncomingMessageInner('integration', message, integration(provider))
    expect(mocks.withSessionSend).toHaveBeenCalledExactlyOnceWith(
      'agent', 'existing-session', expect.objectContaining({ sendMessage: mocks.send }), expect.any(Function),
    )
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('existing-session', 'continue')
  })

  it('enters the shared send lifecycle after attachment preparation', async () => {
    let prepared = false
    vi.mocked(manager.buildMessageContent).mockImplementation(async () => {
      prepared = true
      return { text: 'continue', failedFiles: [] }
    })
    mocks.withSessionSend.mockImplementation(async (_slug, _session, _client, send: () => Promise<void>) => {
      expect(prepared).toBe(true)
      await send()
    })
    await manager.handleIncomingMessageInner('integration', message, integration('slack'))
    expect(mocks.send).toHaveBeenCalledOnce()
  })

  it('reports a shared reconnect failure without sending', async () => {
    mocks.withSessionSend.mockRejectedValueOnce(new Error('connection unavailable'))
    await manager.handleIncomingMessageInner('integration', message, integration('slack'))
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.notice).toHaveBeenCalledWith('chat', expect.objectContaining({ text: expect.stringContaining('Failed to send') }))
  })
})
