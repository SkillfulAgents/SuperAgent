import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock is hoisted above all top-level locals, so any mock factory that
// references a `vi.fn()` must define it inside `vi.hoisted` to be available.
const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(async () => 'notif-id'),
  getSessionMetadata: vi.fn(),
  getAgent: vi.fn(async () => ({ frontmatter: { name: 'Demo Agent' } })),
  getUserSettings: vi.fn(() => ({
    notifications: {
      enabled: true,
      sessionComplete: true,
      sessionWaiting: true,
      sessionScheduled: true,
    },
  })),
  broadcastGlobal: vi.fn(),
}))

vi.mock('@shared/lib/services/notification-service', () => ({
  createNotification: mocks.createNotification,
}))
vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMetadata: mocks.getSessionMetadata,
}))
vi.mock('@shared/lib/services/agent-service', () => ({
  getAgent: mocks.getAgent,
}))
vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: mocks.getUserSettings,
}))
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => false,
}))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { broadcastGlobal: mocks.broadcastGlobal },
}))

const mockCreateNotification = mocks.createNotification
const mockGetSessionMetadata = mocks.getSessionMetadata
const mockBroadcastGlobal = mocks.broadcastGlobal

import { notificationManager } from './notification-manager'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSessionMetadata.mockResolvedValue(null)
})

describe('triggerSessionComplete — automated-session gating', () => {
  it('creates a notification for a regular (non-automated) session', async () => {
    mockGetSessionMetadata.mockResolvedValue({
      isScheduledExecution: false,
      isWebhookExecution: false,
      isChatIntegrationSession: false,
    })

    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_complete',
        sessionId: 'sess-1',
        agentSlug: 'agent-x',
      })
    )
    expect(mockBroadcastGlobal).toHaveBeenCalledTimes(1)
  })

  it('creates a notification when no metadata exists (treat as user session)', async () => {
    mockGetSessionMetadata.mockResolvedValue(null)
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
  })

  it('skips creation for a scheduled-execution session', async () => {
    mockGetSessionMetadata.mockResolvedValue({ isScheduledExecution: true })
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockCreateNotification).not.toHaveBeenCalled()
    expect(mockBroadcastGlobal).not.toHaveBeenCalled()
  })

  it('skips creation for a webhook-execution session', async () => {
    mockGetSessionMetadata.mockResolvedValue({ isWebhookExecution: true })
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })

  it('skips creation for a chat-integration session', async () => {
    mockGetSessionMetadata.mockResolvedValue({ isChatIntegrationSession: true })
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })
})

describe('triggerSessionWaitingInput — NOT gated by automated-session flag', () => {
  it('creates a notification for a regular session', async () => {
    mockGetSessionMetadata.mockResolvedValue(null)
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'secret')
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_waiting',
        sessionId: 'sess-1',
        agentSlug: 'agent-x',
      })
    )
  })

  it('still fires for a scheduled-execution session — automated agents that block on input must surface', async () => {
    mockGetSessionMetadata.mockResolvedValue({ isScheduledExecution: true })
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'question')
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_waiting' })
    )
  })

  it('still fires for a webhook session', async () => {
    mockGetSessionMetadata.mockResolvedValue({ isWebhookExecution: true })
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'connected_account')
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
  })

  it('still fires for a chat-integration session', async () => {
    mockGetSessionMetadata.mockResolvedValue({ isChatIntegrationSession: true })
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'file')
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
  })
})
