import { describe, it, expect, beforeEach, vi } from 'vitest'

// ============================================================================
// Mocks
// ============================================================================

const mockCreateSession = vi.fn()
const mockEnsureRunning = vi.fn().mockResolvedValue({
  createSession: mockCreateSession,
})

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: (...args: unknown[]) => mockEnsureRunning(...args),
  },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
  }),
}))

const mockSubscribeToSession = vi.fn()
const mockMarkSessionActive = vi.fn()
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    subscribeToSession: (...args: unknown[]) => mockSubscribeToSession(...args),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
  },
}))

const mockTriggerNotification = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerWebhookSessionStarted: (...args: unknown[]) => mockTriggerNotification(...args),
  },
}))

const mockGetWebhookTriggersByComposioId = vi.fn()
const mockMarkTriggerFired = vi.fn().mockResolvedValue(undefined)
const mockMarkTriggerFailed = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  getWebhookTriggersByComposioId: (...args: unknown[]) => mockGetWebhookTriggersByComposioId(...args),
  markTriggerFired: (...args: unknown[]) => mockMarkTriggerFired(...args),
  markTriggerFailed: (...args: unknown[]) => mockMarkTriggerFailed(...args),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  registerSession: vi.fn().mockResolvedValue(undefined),
  updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn().mockResolvedValue([]),
}))

const mockAgentExists = vi.fn().mockResolvedValue(true)
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...args: unknown[]) => mockAgentExists(...args),
}))

const mockPollAndClaimEvents = vi.fn()
const mockAcknowledgeEvents = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/services/webhook-events-client', () => ({
  pollAndClaimEvents: () => mockPollAndClaimEvents(),
  acknowledgeEvents: (...args: unknown[]) => mockAcknowledgeEvents(...args),
}))

vi.mock('@shared/lib/services/supabase-realtime-client', () => ({
  SupabaseRealtimeClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isActive: () => false,
    updateToken: vi.fn(),
  })),
}))

// Import after mocks
import { triggerManager } from './trigger-manager'

describe('TriggerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSession.mockResolvedValue({ id: 'session_123' })
  })

  describe('start', () => {
    it('polls for events on startup', async () => {
      mockPollAndClaimEvents.mockResolvedValue({
        events: [],
        realtime: null,
      })

      await triggerManager.start()
      expect(mockPollAndClaimEvents).toHaveBeenCalledTimes(1)

      triggerManager.stop()
    })

    it('processes pending events from poll', async () => {
      const trigger = {
        id: 'trigger_1',
        agentSlug: 'test-agent',
        composioTriggerId: 'ti_abc',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Handle this email',
        name: 'Email Handler',
        status: 'active',
        fireCount: 0,
      }

      mockPollAndClaimEvents.mockResolvedValue({
        events: [
          {
            id: 'whe_1',
            composio_trigger_id: 'ti_abc',
            trigger_type: 'GMAIL_NEW_EMAIL',
            payload: { subject: 'Hello' },
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
        realtime: null,
      })

      mockGetWebhookTriggersByComposioId.mockResolvedValue([trigger])

      await triggerManager.start()

      // Verify session was created
      expect(mockEnsureRunning).toHaveBeenCalledWith('test-agent')
      expect(mockCreateSession).toHaveBeenCalledTimes(1)
      const createArgs = mockCreateSession.mock.calls[0][0]
      expect(createArgs.initialMessage).toContain('Handle this email')
      expect(createArgs.initialMessage).toContain('"subject": "Hello"')

      // Verify trigger was marked as fired
      expect(mockMarkTriggerFired).toHaveBeenCalledWith('trigger_1', 'session_123')

      // Verify events were acknowledged
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_1'])

      triggerManager.stop()
    })

    it('batches multiple events for the same trigger', async () => {
      const trigger = {
        id: 'trigger_1',
        agentSlug: 'test-agent',
        composioTriggerId: 'ti_abc',
        prompt: 'Handle emails',
        name: 'Batch Test',
        status: 'active',
        fireCount: 0,
      }

      mockPollAndClaimEvents.mockResolvedValue({
        events: [
          { id: 'whe_1', composio_trigger_id: 'ti_abc', trigger_type: 'GMAIL', payload: { subject: 'A' }, created_at: '' },
          { id: 'whe_2', composio_trigger_id: 'ti_abc', trigger_type: 'GMAIL', payload: { subject: 'B' }, created_at: '' },
          { id: 'whe_3', composio_trigger_id: 'ti_abc', trigger_type: 'GMAIL', payload: { subject: 'C' }, created_at: '' },
        ],
        realtime: null,
      })

      mockGetWebhookTriggersByComposioId.mockResolvedValue([trigger])

      await triggerManager.start()

      // Only one session for all 3 events
      expect(mockCreateSession).toHaveBeenCalledTimes(1)
      const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
      expect(prompt).toContain('Event 1:')
      expect(prompt).toContain('Event 2:')
      expect(prompt).toContain('Event 3:')

      // All 3 events acknowledged
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_1', 'whe_2', 'whe_3'])

      triggerManager.stop()
    })

    it('acks events when trigger is not found in SQLite', async () => {
      mockPollAndClaimEvents.mockResolvedValue({
        events: [
          { id: 'whe_orphan', composio_trigger_id: 'ti_gone', trigger_type: 'X', payload: {}, created_at: '' },
        ],
        realtime: null,
      })

      mockGetWebhookTriggersByComposioId.mockResolvedValue([])

      await triggerManager.start()

      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_orphan'])

      triggerManager.stop()
    })

    it('marks trigger as failed when agent does not exist', async () => {
      mockPollAndClaimEvents.mockResolvedValue({
        events: [
          { id: 'whe_1', composio_trigger_id: 'ti_abc', trigger_type: 'X', payload: {}, created_at: '' },
        ],
        realtime: null,
      })

      mockGetWebhookTriggersByComposioId.mockResolvedValue([{
        id: 'trigger_1',
        agentSlug: 'deleted-agent',
        composioTriggerId: 'ti_abc',
        prompt: 'Test',
        status: 'active',
        fireCount: 0,
      }])

      mockAgentExists.mockResolvedValue(false)

      await triggerManager.start()

      expect(mockMarkTriggerFailed).toHaveBeenCalledWith('trigger_1', 'Agent no longer exists')
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_1'])
      expect(mockCreateSession).not.toHaveBeenCalled()

      triggerManager.stop()
      mockAgentExists.mockResolvedValue(true) // restore for other tests
    })
  })
})
