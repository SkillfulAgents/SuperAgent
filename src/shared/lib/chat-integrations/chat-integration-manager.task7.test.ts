import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Task 7 — gate outbound ensureSession for non-allowed chats.
//
// ensureSession is called by the /send route before logging the outbound
// message into the session JSONL. If the chat is not approved for the
// integration, it must throw before any session work happens.
//
// We mock the three service calls ensureSession makes up to (and including)
// the guard so no real DB or container access is needed.
// ---------------------------------------------------------------------------

const mockIsChatAllowed = vi.fn()

vi.mock('@shared/lib/services/chat-integration-access-service', () => ({
  isChatAllowed: (...args: unknown[]) => mockIsChatAllowed(...args),
  decideInboundAccess: vi.fn(),
  getChatAccess: vi.fn(),
  markNoticeSent: vi.fn(),
}))

const mockGetChatIntegration = vi.fn()

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: (...args: unknown[]) => mockGetChatIntegration(...args),
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  updateChatIntegrationStatus: vi.fn(),
}))

const mockResolveActiveSession = vi.fn()

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  getChatIntegrationSession: vi.fn(),
  getChatIntegrationSessionBySessionId: vi.fn(),
  createChatIntegrationSession: vi.fn(),
  updateChatIntegrationSessionName: vi.fn(),
  archiveChatIntegrationSession: vi.fn(),
  touchChatIntegrationSession: vi.fn(),
  listChatIntegrationSessions: vi.fn(),
  resolveActiveSession: (...args: unknown[]) => mockResolveActiveSession(...args),
  getLastDisplayName: vi.fn().mockReturnValue(null),
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: { ensureRunning: vi.fn() },
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: { submitDecision: vi.fn() },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

import { chatIntegrationManager } from './chat-integration-manager'

function fakeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-tg',
    agentSlug: 'test-agent',
    provider: 'telegram',
    name: 'Test Bot',
    status: 'active',
    requireApproval: true,
    sessionTimeout: null,
    createdByUserId: null,
    config: '{}',
    ...overrides,
  }
}

describe('ChatIntegrationManager.ensureSession — access gate (Task 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws when the chat is not approved for the integration', async () => {
    mockGetChatIntegration.mockReturnValue(fakeIntegration())
    mockIsChatAllowed.mockReturnValue(false)

    await expect(
      chatIntegrationManager.ensureSession('int-tg', 'chat-blocked'),
    ).rejects.toThrow('Chat chat-blocked is not allowed for integration int-tg')
  })

  it('returns the existing sessionId when the chat is approved', async () => {
    mockGetChatIntegration.mockReturnValue(fakeIntegration())
    mockIsChatAllowed.mockReturnValue(true)
    mockResolveActiveSession.mockReturnValue({ sessionId: 'existing-session-id' })

    const result = await chatIntegrationManager.ensureSession('int-tg', 'chat-allowed')

    expect(result).toBe('existing-session-id')
    expect(mockResolveActiveSession).toHaveBeenCalledWith(
      'int-tg',
      'chat-allowed',
      null,
      expect.any(Function),
    )
  })
})
