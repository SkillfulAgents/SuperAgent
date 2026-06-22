import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock heavy dependencies so the manager module loads without a real DB or network.
vi.mock('@shared/lib/services/chat-integration-service', () => ({
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  getChatIntegration: vi.fn(),
  updateChatIntegrationStatus: vi.fn(),
}))

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  getChatIntegrationSession: vi.fn(),
  getChatIntegrationSessionBySessionId: vi.fn(),
  createChatIntegrationSession: vi.fn(),
  updateChatIntegrationSessionName: vi.fn(),
  archiveChatIntegrationSession: vi.fn(),
  touchChatIntegrationSession: vi.fn(),
  listActiveChatIntegrationSessions: vi.fn().mockReturnValue([]),
  resolveActiveSession: vi.fn(),
  getLastDisplayName: vi.fn(),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { persist: vi.fn() },
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: vi.fn((_slug: string, fn: () => unknown) => fn()),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

import { chatIntegrationManager } from './chat-integration-manager'
import { TelegramConnector } from './telegram-connector'

describe('chatIntegrationManager.shareDashboard', () => {
  afterEach(() => {
    ;(chatIntegrationManager as unknown as { connections: Map<string, unknown> }).connections.delete('int1')
  })

  it('calls sendDashboardCard on the TelegramConnector with the correct args', async () => {
    const conn = new TelegramConnector({ botToken: 'x' })
    const spy = vi.spyOn(conn, 'sendDashboardCard').mockResolvedValue('text')
    ;(chatIntegrationManager as unknown as { connections: Map<string, unknown> }).connections.set('int1', { connector: conn })

    const delivery = await chatIntegrationManager.shareDashboard('int1', 'chat1', {
      agentSlug: 'sales',
      dashboardSlug: 'wr',
      name: 'WR',
      allowButton: true,
    })

    expect(delivery).toBe('text')
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith('chat1', {
      integrationId: 'int1',
      agentSlug: 'sales',
      dashboardSlug: 'wr',
      name: 'WR',
      allowButton: true,
    })
  })

  it('rejects with "Telegram" error when connector is not a TelegramConnector', async () => {
    ;(chatIntegrationManager as unknown as { connections: Map<string, unknown> }).connections.set('int1', {
      connector: { provider: 'slack' } as unknown,
    })

    await expect(
      chatIntegrationManager.shareDashboard('int1', 'chat1', {
        agentSlug: 'sales',
        dashboardSlug: 'wr',
        name: 'WR',
        allowButton: true,
      }),
    ).rejects.toThrow(/Telegram/)
  })

  it('rejects with "not connected" when no connection exists for the id', async () => {
    await expect(
      chatIntegrationManager.shareDashboard('nonexistent', 'chat1', {
        agentSlug: 'sales',
        dashboardSlug: 'wr',
        name: 'WR',
        allowButton: true,
      }),
    ).rejects.toThrow(/not connected/)
  })
})
