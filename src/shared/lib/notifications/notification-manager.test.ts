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
  promoteAutomatedSession: vi.fn(async () => {}),
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
  messagePersister: {
    broadcastGlobal: mocks.broadcastGlobal,
    promoteAutomatedSession: mocks.promoteAutomatedSession,
  },
}))

const mockCreateNotification = mocks.createNotification
const mockGetSessionMetadata = mocks.getSessionMetadata
const mockBroadcastGlobal = mocks.broadcastGlobal
const mockPromoteAutomatedSession = mocks.promoteAutomatedSession

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

  it('creates notification for a promoted scheduled session', async () => {
    mockGetSessionMetadata.mockResolvedValue({
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
      promotedToInteractive: true,
    })
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_complete', sessionId: 'sess-1' })
    )
  })

  it('creates notification for a promoted webhook session', async () => {
    mockGetSessionMetadata.mockResolvedValue({
      isWebhookExecution: true,
      webhookTriggerId: 'trigger-1',
      promotedToInteractive: true,
    })
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_complete', sessionId: 'sess-1' })
    )
  })

  it('creates notification for a promoted chat-integration session', async () => {
    mockGetSessionMetadata.mockResolvedValue({
      isChatIntegrationSession: true,
      chatIntegrationId: 'chat-1',
      promotedToInteractive: true,
    })
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_complete', sessionId: 'sess-1' })
    )
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

  it('names the capability under review — a workflow launch is not "launch agents"', async () => {
    mockGetSessionMetadata.mockResolvedValue(null)
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'capability_review_workflows')
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('wants to run a workflow') })
    )

    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'capability_review_subagents')
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('wants to launch a subagent') })
    )
  })
})

describe('session_waiting promotes automated sessions to interactive', () => {
  // Session lists exclude non-promoted automated sessions, so a session_waiting
  // notification on one would raise unread indicators that point at nothing —
  // and could never be cleared. Every session_waiting must promote first.
  it('triggerSessionWaitingInput promotes before creating the notification', async () => {
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'secret')

    expect(mockPromoteAutomatedSession).toHaveBeenCalledWith('sess-1', 'agent-x')
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
    expect(mockPromoteAutomatedSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateNotification.mock.invocationCallOrder[0],
    )
  })

  it('triggerSessionApiReviewWaiting promotes too — the proxy-review path was the original gap', async () => {
    await notificationManager.triggerSessionApiReviewWaiting('sess-1', 'agent-x', 'review-1', 'Allow?')

    expect(mockPromoteAutomatedSession).toHaveBeenCalledWith('sess-1', 'agent-x')
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
  })

  it('triggerSessionComplete does not promote', async () => {
    await notificationManager.triggerSessionComplete('sess-1', 'agent-x')
    expect(mockPromoteAutomatedSession).not.toHaveBeenCalled()
  })

  it('a promotion failure does not block the notification', async () => {
    mockPromoteAutomatedSession.mockRejectedValueOnce(new Error('disk full'))
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'question')
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
  })

  it('promotes even when session_waiting notifications are disabled in settings', async () => {
    mocks.getUserSettings.mockReturnValueOnce({
      notifications: {
        enabled: true,
        sessionComplete: true,
        sessionWaiting: false,
        sessionScheduled: true,
      },
    })
    await notificationManager.triggerSessionWaitingInput('sess-1', 'agent-x', 'secret')
    expect(mockPromoteAutomatedSession).toHaveBeenCalledWith('sess-1', 'agent-x')
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })
})

describe('triggerSessionApiReviewWaiting — broadcast payload contract', () => {
  it('broadcasts actions + actionContext with index-aligned decisions', async () => {
    await notificationManager.triggerSessionApiReviewWaiting(
      'sess-1',
      'agent-x',
      'review-1',
      'Allow GET request to Gmail?',
    )

    expect(mockBroadcastGlobal).toHaveBeenCalledTimes(1)
    const payload = mockBroadcastGlobal.mock.calls[0][0]
    expect(payload).toMatchObject({
      type: 'os_notification',
      notificationType: 'session_waiting',
      sessionId: 'sess-1',
      agentSlug: 'agent-x',
      actions: [{ text: 'Approve' }, { text: 'Deny' }],
      actionContext: {
        kind: 'proxy_review',
        reviewId: 'review-1',
        agentSlug: 'agent-x',
        sessionId: 'sess-1',
        decisions: ['allow', 'deny'],
      },
    })
  })

  // Action context must include notificationId so the renderer's dispatcher
  // can mark the DB notification as read when the user clicks Approve/Deny
  // on the OS notification — otherwise the in-app unread badge keeps
  // counting events the user has clearly seen and acted on.
  it('stamps notificationId from createNotification into the actionContext', async () => {
    mockCreateNotification.mockResolvedValueOnce('notif-abc')
    await notificationManager.triggerSessionApiReviewWaiting(
      'sess-1',
      'agent-x',
      'review-1',
      'Allow?',
    )
    const payload = mockBroadcastGlobal.mock.calls[0][0]
    expect(payload.actionContext.notificationId).toBe('notif-abc')
  })

  it('uses "API Request Review" title for default kind', async () => {
    await notificationManager.triggerSessionApiReviewWaiting(
      'sess-1',
      'agent-x',
      'review-1',
      'Allow?',
    )
    const payload = mockBroadcastGlobal.mock.calls[0][0]
    expect(payload.title).toContain('API Request Review')
  })

  // S7: x-agent reviews aren't HTTP API requests — calling them
  // "API Request Review" is misleading. The trigger lets review-manager
  // pass `kind: 'agent_action'` for those, swapping the title.
  it('uses "Agent Action Review" title when kind is agent_action', async () => {
    await notificationManager.triggerSessionApiReviewWaiting(
      'sess-1',
      'agent-x',
      'review-1',
      'Allow agent to invoke target?',
      undefined,
      'agent_action',
    )
    const payload = mockBroadcastGlobal.mock.calls[0][0]
    expect(payload.title).toContain('Agent Action Review')
    expect(payload.title).not.toContain('API Request Review')
  })
})
