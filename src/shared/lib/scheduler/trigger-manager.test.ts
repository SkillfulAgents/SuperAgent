import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ============================================================================
// Mocks
// ============================================================================

const mockCreateSession = vi.fn()
const mockEnsureRunning = vi.fn().mockResolvedValue({
  createSession: mockCreateSession,
})

// The actor reaches the container client through getClient after start();
// hand back whatever ensureRunning last resolved to.
let mockClient: unknown
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      ensureRunning: async (...args: unknown[]) => {
        mockClient = await mockEnsureRunning(...args)
        return mockClient
      },
      getClient: () => mockClient,
    }),
  }
})

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
    agentEffort: 'low',
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
const mockGetSubscribedIds = vi.fn(() => ['ti_abc'])
const mockResolveTriggerPrincipal =
  vi.fn<(trigger: unknown) => { userId: string; memberId: string } | null>(() => null)
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  getDistinctPlatformMemberIdsForActiveTriggers: () => mockGetDistinctMemberIds(),
  getSubscribedComposioTriggerIds: () => mockGetSubscribedIds(),
  getWebhookTriggersByComposioId: (...args: unknown[]) => mockGetWebhookTriggersByComposioId(...args),
  markTriggerFired: (...args: unknown[]) => mockMarkTriggerFired(...args),
  markTriggerFailed: (...args: unknown[]) => mockMarkTriggerFailed(...args),
  resolveTriggerPrincipal: (trigger: unknown) => mockResolveTriggerPrincipal(trigger),
  getConnectedAccountOwnerUserId: () => null,
}))

const mockRegisterSession = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/services/session-service', () => ({
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
  updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn().mockResolvedValue([]),
}))

const mockReadAgentPreferences = vi.fn().mockResolvedValue({})
vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: (...args: unknown[]) => mockReadAgentPreferences(...args),
}))

const mockAgentExists = vi.fn().mockResolvedValue(true)
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...args: unknown[]) => mockAgentExists(...args),
}))

vi.mock('@shared/lib/webhook-relay', async () => {
  const { createFakeWebhookRelay } = await import('@shared/lib/webhook-relay/testing/fake-webhook-relay')
  const relay = createFakeWebhookRelay()
  return { getWebhookRelay: () => relay, LOCAL_RELAY_SCOPE: 'local' }
})

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

// Import after mocks
import { getWebhookRelay, type RelayEvent } from '@shared/lib/webhook-relay'
import type { FakeWebhookRelay } from '@shared/lib/webhook-relay/testing/fake-webhook-relay'
import { triggerManager } from './trigger-manager'

const relay = getWebhookRelay() as FakeWebhookRelay

function event(id: string, endpointId: string, type: string, payload: unknown = {}): RelayEvent {
  return { id, endpointId, type, payload, createdAt: '' }
}

/** Start the manager and deliver events to the member's consumer, as a claim would. */
async function startAndDeliver(events: RelayEvent[], memberId = 'sub_test_member') {
  await triggerManager.start()
  return relay.deliver(`webhook-triggers:${memberId}`, events)
}

describe('TriggerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    relay.reset()
    mockGetSubscribedIds.mockReturnValue(['ti_abc'])
    mockCreateSession.mockResolvedValue({ id: 'session_123' })
    mockReadAgentPreferences.mockResolvedValue({})
    mockGetDistinctMemberIds.mockReturnValue(['sub_test_member'])
    mockGetPlatformAccessToken.mockReturnValue('opaque_test_token')
    mockDecodeOrgIdFromToken.mockReturnValue(null)
    mockResolveTriggerPrincipal.mockReturnValue(null)
  })

  // Stop even when an assertion throws mid-test — the singleton's isRunning
  // guard would otherwise no-op every later start().
  afterEach(() => {
    triggerManager.stop()
  })

  describe('relay registration', () => {
    it("registers each trigger owner's subscribed endpoints on start", async () => {
      mockGetSubscribedIds.mockReturnValue(['whep_b', 'ti_a'])
      mockGetDistinctMemberIds.mockReturnValue(['sub_one', 'sub_two'])

      await triggerManager.start()

      expect([...relay.consumers.values()].map(({ id, scope, endpointIds }) => ({ id, scope, endpointIds }))).toEqual([
        { id: 'webhook-triggers:sub_one', scope: 'sub_one', endpointIds: ['ti_a', 'whep_b'] },
        { id: 'webhook-triggers:sub_two', scope: 'sub_two', endpointIds: ['ti_a', 'whep_b'] },
      ])
    })

    it('registers nothing when no trigger is subscribed', async () => {
      mockGetSubscribedIds.mockReturnValue([])

      await triggerManager.start()

      expect(relay.consumers.size).toBe(0)
    })

    it('updates endpoints, and drops members that no longer own triggers, on sync', async () => {
      mockGetDistinctMemberIds.mockReturnValue(['sub_one', 'sub_two'])
      await triggerManager.start()

      mockGetSubscribedIds.mockReturnValue(['ti_abc', 'whep_new'])
      mockGetDistinctMemberIds.mockReturnValue(['sub_one'])
      await triggerManager.syncRegistrations()

      expect([...relay.consumers.keys()]).toEqual(['webhook-triggers:sub_one'])
      expect(relay.consumers.get('webhook-triggers:sub_one')?.endpointIds).toEqual(['ti_abc', 'whep_new'])
      expect(relay.log.filter((entry) => entry.op !== 'register')).toEqual([
        { op: 'dispose', id: 'webhook-triggers:sub_two' },
        { op: 'update', id: 'webhook-triggers:sub_one' },
      ])
    })

    it('leaves an unchanged registration alone on sync', async () => {
      await triggerManager.start()
      await triggerManager.syncRegistrations()

      expect(relay.log).toEqual([{ op: 'register', id: 'webhook-triggers:sub_test_member' }])
    })

    it('does nothing on sync while stopped, and disposes on stop', async () => {
      await triggerManager.syncRegistrations()
      expect(relay.consumers.size).toBe(0)

      await triggerManager.start()
      triggerManager.stop()
      expect(relay.consumers.size).toBe(0)
    })

    it('opaque key with no known member: registers under the local scope', async () => {
      mockGetDistinctMemberIds.mockReturnValue([])

      await triggerManager.start()

      expect(relay.consumers.get('webhook-triggers:local')?.scope).toBe('local')
    })

    it('no platform token yet: still registers, under the local scope', async () => {
      mockGetDistinctMemberIds.mockReturnValue([])
      mockGetPlatformAccessToken.mockReturnValue(null)

      await triggerManager.start()

      expect([...relay.consumers.keys()]).toEqual(['webhook-triggers:local'])
    })

    it('org token with no known member: registers nothing rather than a bogus `::local` bearer', async () => {
      mockGetDistinctMemberIds.mockReturnValue([])
      mockGetPlatformAccessToken.mockReturnValue('org_jwt_token')
      mockDecodeOrgIdFromToken.mockReturnValue('org_123')

      await triggerManager.start()

      expect(relay.consumers.size).toBe(0)
    })
  })

  describe('delivery', () => {
    it('starts a session for a delivered event and accepts it', async () => {
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
      mockGetWebhookTriggersByComposioId.mockResolvedValue([trigger])

      const results = await startAndDeliver([event('whe_1', 'ti_abc', 'GMAIL_NEW_EMAIL', { subject: 'Hello' })])

      expect(mockEnsureRunning).toHaveBeenCalledWith('test-agent')
      expect(mockCreateSession).toHaveBeenCalledTimes(1)
      const createArgs = mockCreateSession.mock.calls[0][0]
      expect(createArgs.initialMessage).toContain('Handle this email')
      expect(createArgs.initialMessage).toContain('"subject": "Hello"')
      expect(mockMarkTriggerFired).toHaveBeenCalledWith('trigger_1', 'session_123')
      expect(mockRegisterSession).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'test-agent' }),
        'session_123',
        'Email Handler',
        expect.objectContaining({
          isWebhookExecution: true,
          webhookTriggerId: 'trigger_1',
          webhookInvocationCount: 1,
          automationStatus: 'running',
        }),
      )
      expect(results).toEqual(new Map([['whe_1', 'accepted']]))
    })

    it('batches multiple events for the same trigger', async () => {
      mockGetWebhookTriggersByComposioId.mockResolvedValue([{
        id: 'trigger_1',
        agentSlug: 'test-agent',
        composioTriggerId: 'ti_abc',
        prompt: 'Handle emails',
        name: 'Batch Test',
        status: 'active',
        fireCount: 0,
      }])

      const results = await startAndDeliver([
        event('whe_1', 'ti_abc', 'GMAIL', { subject: 'A' }),
        event('whe_2', 'ti_abc', 'GMAIL', { subject: 'B' }),
        event('whe_3', 'ti_abc', 'GMAIL', { subject: 'C' }),
      ])

      // Only one session for all 3 events
      expect(mockCreateSession).toHaveBeenCalledTimes(1)
      const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
      expect(prompt).toContain('Event 1:')
      expect(prompt).toContain('Event 2:')
      expect(prompt).toContain('Event 3:')
      expect(mockRegisterSession).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'test-agent' }),
        'session_123',
        'Batch Test',
        expect.objectContaining({
          webhookTriggerId: 'trigger_1',
          webhookInvocationCount: 3,
          automationStatus: 'running',
        }),
      )
      expect([...results.values()]).toEqual(['accepted', 'accepted', 'accepted'])
    })

    it('discards events with no active local trigger (e.g. paused)', async () => {
      mockGetWebhookTriggersByComposioId.mockResolvedValue([])

      const results = await startAndDeliver([event('whe_orphan', 'ti_abc', 'X')])

      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(results).toEqual(new Map([['whe_orphan', 'discard']]))
    })

    it('marks trigger as failed when agent does not exist, and still settles the event', async () => {
      mockGetWebhookTriggersByComposioId.mockResolvedValue([{
        id: 'trigger_1',
        agentSlug: 'deleted-agent',
        composioTriggerId: 'ti_abc',
        prompt: 'Test',
        status: 'active',
        fireCount: 0,
      }])
      mockAgentExists.mockResolvedValue(false)

      const results = await startAndDeliver([event('whe_1', 'ti_abc', 'X')])

      expect(mockMarkTriggerFailed).toHaveBeenCalledWith('trigger_1', 'Agent no longer exists')
      expect(results).toEqual(new Map([['whe_1', 'accepted']]))
      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(mockRegisterSession).not.toHaveBeenCalled()
      mockAgentExists.mockResolvedValue(true) // restore for other tests
    })

    it('settles events even when starting the session fails (no retry until SUP-934)', async () => {
      mockGetWebhookTriggersByComposioId.mockResolvedValue([{
        id: 'trigger_1',
        agentSlug: 'test-agent',
        composioTriggerId: 'ti_abc',
        prompt: 'Test',
        status: 'active',
        fireCount: 0,
      }])
      mockCreateSession.mockRejectedValue(new Error('container failed to start'))

      const results = await startAndDeliver([event('whe_1', 'ti_abc', 'X')])

      expect(results).toEqual(new Map([['whe_1', 'accepted']]))
    })

    it('settles each trigger group separately', async () => {
      mockGetWebhookTriggersByComposioId.mockImplementation(async (id: string) =>
        id === 'ti_abc'
          ? [{ id: 'trigger_1', agentSlug: 'test-agent', composioTriggerId: 'ti_abc', prompt: 'P', status: 'active', fireCount: 0 }]
          : [],
      )

      const results = await startAndDeliver([event('whe_1', 'ti_abc', 'X'), event('whe_2', 'ti_gone', 'X')])

      expect(results).toEqual(new Map([['whe_1', 'accepted'], ['whe_2', 'discard']]))
    })

    // SUP-226: runtime attribution must select the same user the events were
    // claimed under — the connected-account owner when the creator has no
    // platform member — so the session's proxy calls carry the correct acting member.
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
      mockGetWebhookTriggersByComposioId.mockResolvedValue([trigger])
      // Creator has no platform member; resolution falls back to the owner.
      mockResolveTriggerPrincipal.mockReturnValue({
        userId: 'owner_user',
        memberId: 'sub_owner_member',
      })

      await startAndDeliver([event('whe_1', 'ti_abc', 'GMAIL')])

      expect(mockResolveTriggerPrincipal).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByUserId: 'creator_user',
          connectedAccountId: 'ca_owned',
        }),
      )
      expect(mockRunWithOptionalUser).toHaveBeenCalledWith('owner_user', expect.any(Function))
      expect(mockCreateSession).toHaveBeenCalledTimes(1)
    })
  })

  describe('model, effort, and speed resolution', () => {
    // Preference order: trigger override > agent default > global default.
    async function fireTrigger(overrides: Record<string, unknown> = {}) {
      mockGetWebhookTriggersByComposioId.mockResolvedValue([{
        id: 'trigger_1',
        agentSlug: 'test-agent',
        composioTriggerId: 'ti_abc',
        prompt: 'Handle it',
        status: 'active',
        fireCount: 0,
        model: null,
        effort: null,
        speed: null,
        ...overrides,
      }])
      await startAndDeliver([event('whe_1', 'ti_abc', 'GMAIL')])
      expect(mockCreateSession).toHaveBeenCalledTimes(1)
      return mockCreateSession.mock.calls[0][0]
    }

    it('uses the global default when neither trigger nor agent set one', async () => {
      const args = await fireTrigger()
      expect(args.model).toBe('claude-sonnet-4-20250514')
      expect(args.effort).toBe('low')
      expect(args.speed).toBeUndefined()
    })

    it('falls back to the agent default over the global default', async () => {
      mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high', defaultSpeed: 'slow' })
      const args = await fireTrigger()
      expect(mockReadAgentPreferences).toHaveBeenCalledWith('test-agent')
      expect(args.model).toBe('opus')
      expect(args.effort).toBe('high')
      expect(args.speed).toBe('slow')
    })

    it('prefers the trigger override over the agent default', async () => {
      mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high', defaultSpeed: 'fast' })
      const args = await fireTrigger({ model: 'claude-haiku-4-5-20251001', effort: 'low', speed: 'slow' })
      expect(args.model).toBe('claude-haiku-4-5-20251001')
      expect(args.effort).toBe('low')
      expect(args.speed).toBe('slow')
    })

    it('a stored normal trigger speed beats a non-normal agent default', async () => {
      mockReadAgentPreferences.mockResolvedValue({ defaultSpeed: 'fast' })
      const args = await fireTrigger({ speed: 'normal' })
      expect(args.speed).toBe('normal')
    })
  })
})
