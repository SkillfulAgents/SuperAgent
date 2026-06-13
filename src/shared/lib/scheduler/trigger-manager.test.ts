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

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'http://localhost:3000',
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
const mockGetDistinctMemberIds = vi.fn(() => ['sub_test_member'])
const mockResolvePlatformMemberForCandidates =
  vi.fn<(candidates: Array<string | null | undefined>) => { userId: string; memberId: string } | null>(
    () => null,
  )
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  getDistinctPlatformMemberIdsForActiveTriggers: () => mockGetDistinctMemberIds(),
  getWebhookTriggersByComposioId: (...args: unknown[]) => mockGetWebhookTriggersByComposioId(...args),
  markTriggerFired: (...args: unknown[]) => mockMarkTriggerFired(...args),
  markTriggerFailed: (...args: unknown[]) => mockMarkTriggerFailed(...args),
  resolvePlatformMemberForCandidates: (...args: [Array<string | null | undefined>]) =>
    mockResolvePlatformMemberForCandidates(...args),
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
  pollAndClaimEvents: (...args: unknown[]) => mockPollAndClaimEvents(...args),
  acknowledgeEvents: (...args: unknown[]) => mockAcknowledgeEvents(...args),
}))

const mockGetPlatformAccessToken = vi.fn<() => string | null>(() => 'opaque_test_token')
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

const mockDecodeOrgIdFromToken = vi.fn<(token: string) => string | null>(() => null)
const mockRunWithOptionalUser = vi.fn(
  (_userId: string | null | undefined, fn: () => unknown) => fn(),
)
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (userId: string | null | undefined, fn: () => unknown) =>
    mockRunWithOptionalUser(userId, fn),
  attribution: {
    // Mirror the real impl, driven by the same mocks the tests already control.
    requiresActingMember: () => {
      const token = mockGetPlatformAccessToken()
      return token !== null && mockDecodeOrgIdFromToken(token) !== null
    },
  },
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ all: () => [] }),
        }),
      }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {},
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
    mockGetDistinctMemberIds.mockReturnValue(['sub_test_member'])
    mockGetPlatformAccessToken.mockReturnValue('opaque_test_token')
    mockDecodeOrgIdFromToken.mockReturnValue(null)
    mockResolvePlatformMemberForCandidates.mockReturnValue(null)
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
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_1'], 'sub_test_member')

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
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_1', 'whe_2', 'whe_3'], 'sub_test_member')

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
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_orphan'], 'sub_test_member')

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
      expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_1'], 'sub_test_member')
      expect(mockCreateSession).not.toHaveBeenCalled()

      triggerManager.stop()
      mockAgentExists.mockResolvedValue(true) // restore for other tests
    })

    // SUP-226: runtime attribution must select the same user the poller claimed
    // under — the connected-account owner when the creator has no platform
    // member — so the session's proxy calls carry the correct acting member.
    it('attributes the session to the connected-account owner when the creator lacks a platform member', async () => {
      const trigger = {
        id: 'trigger_1',
        agentSlug: 'test-agent',
        composioTriggerId: 'ti_abc',
        connectedAccountId: 'ca_owned',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Handle this email',
        status: 'active',
        fireCount: 0,
        createdByUserId: 'creator_user',
      }

      mockPollAndClaimEvents.mockResolvedValue({
        events: [
          { id: 'whe_1', composio_trigger_id: 'ti_abc', trigger_type: 'GMAIL', payload: {}, created_at: '' },
        ],
        realtime: null,
      })
      mockGetWebhookTriggersByComposioId.mockResolvedValue([trigger])
      // Creator has no platform member; resolution falls back to the owner.
      mockResolvePlatformMemberForCandidates.mockReturnValue({
        userId: 'owner_user',
        memberId: 'sub_owner_member',
      })

      await triggerManager.start()

      expect(mockResolvePlatformMemberForCandidates).toHaveBeenCalledWith([
        'creator_user',
        // resolveConnectedAccountOwner is read through the db mock (returns null here).
        null,
      ])
      expect(mockRunWithOptionalUser).toHaveBeenCalledWith('owner_user', expect.any(Function))
      expect(mockCreateSession).toHaveBeenCalledTimes(1)

      triggerManager.stop()
    })
  })

  describe('pollAndProcess fallback when memberIds is empty', () => {
    it('opaque key mode: polls with "local" placeholder', async () => {
      mockGetDistinctMemberIds.mockReturnValue([])
      mockGetPlatformAccessToken.mockReturnValue('opaque_test_token')
      mockDecodeOrgIdFromToken.mockReturnValue(null)
      mockPollAndClaimEvents.mockResolvedValue({ events: [], realtime: null })

      await triggerManager.start()

      expect(mockPollAndClaimEvents).toHaveBeenCalledTimes(1)
      expect(mockPollAndClaimEvents).toHaveBeenCalledWith('local')

      triggerManager.stop()
    })

    it('org JWT mode: skips poll to avoid bogus `::local` bearer', async () => {
      mockGetDistinctMemberIds.mockReturnValue([])
      mockGetPlatformAccessToken.mockReturnValue('org_jwt_token')
      mockDecodeOrgIdFromToken.mockReturnValue('org_123')
      mockPollAndClaimEvents.mockResolvedValue({ events: [], realtime: null })

      await triggerManager.start()

      expect(mockPollAndClaimEvents).not.toHaveBeenCalled()

      triggerManager.stop()
    })

    it('no platform token: skips poll', async () => {
      mockGetDistinctMemberIds.mockReturnValue([])
      mockGetPlatformAccessToken.mockReturnValue(null)
      mockPollAndClaimEvents.mockResolvedValue({ events: [], realtime: null })

      await triggerManager.start()

      expect(mockPollAndClaimEvents).not.toHaveBeenCalled()

      triggerManager.stop()
    })
  })
})
