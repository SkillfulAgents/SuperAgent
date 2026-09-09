import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatIntegration } from '@shared/lib/db/schema'
import type { IncomingMessage } from './base-connector'

const mocks = vi.hoisted(() => ({
  active: false,
  subscribed: false,
  send: vi.fn(),
  subscribe: vi.fn(),
  notice: vi.fn().mockResolvedValue(undefined),
  idle: vi.fn(),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    isSessionActive: () => mocks.active,
    markSessionActive: () => { mocks.active = true },
    markSessionIdle: (...args: unknown[]) => { mocks.active = false; mocks.idle(...args) },
    isSubscribed: () => mocks.subscribed,
    subscribeToSession: (...args: unknown[]) => mocks.subscribe(...args),
  },
}))
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: { ensureRunning: async () => ({ sendMessage: mocks.send }) },
}))
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
  mocks.active = false
  mocks.subscribed = false
  mocks.subscribe.mockImplementation(async () => { mocks.subscribed = true })
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

describe('chat session reconnect after idle eviction', () => {
  it.each(['slack', 'telegram', 'imessage'] as const)('awaits reconnect before sending into the same %s session', async (provider) => {
    let ready!: () => void
    mocks.subscribe.mockImplementation(() => new Promise<void>((resolve) => {
      ready = () => { mocks.subscribed = true; resolve() }
    }))
    const delivery = manager.handleIncomingMessageInner('integration', message, integration(provider))
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    expect(mocks.send).not.toHaveBeenCalled()
    ready()
    await delivery
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('existing-session', 'continue')
    expect(mocks.active).toBe(true)
  })

  it('rechecks the subscription after attachment preparation, before sending', async () => {
    mocks.subscribed = true
    vi.mocked(manager.buildMessageContent).mockImplementation(async () => {
      mocks.subscribed = false
      return { text: 'continue', failedFiles: [] }
    })
    mocks.send.mockImplementation(async () => {
      expect(mocks.active).toBe(true)
      expect(mocks.subscribed).toBe(true)
    })
    await manager.handleIncomingMessageInner('integration', message, integration('slack'))
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledOnce()
  })

  it('clears provisional activity when reconnect fails without sending the message', async () => {
    mocks.subscribed = true
    vi.mocked(manager.buildMessageContent).mockImplementation(async () => {
      mocks.subscribed = false
      return { text: 'continue', failedFiles: [] }
    })
    mocks.subscribe.mockRejectedValueOnce(new Error('connection unavailable'))
    await manager.handleIncomingMessageInner('integration', message, integration('slack'))
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.idle).toHaveBeenCalledExactlyOnceWith('agent', 'existing-session')
    expect(mocks.active).toBe(false)
    expect(mocks.notice).toHaveBeenCalledWith('chat', expect.objectContaining({ text: expect.stringContaining('Failed to send') }))
  })

  it('does not settle an already-active turn when a follow-up send fails', async () => {
    mocks.active = true
    mocks.subscribed = true
    mocks.send.mockRejectedValueOnce(new Error('connection unavailable'))
    await manager.handleIncomingMessageInner('integration', message, integration('slack'))
    expect(mocks.idle).not.toHaveBeenCalled()
    expect(mocks.active).toBe(true)
  })
})
