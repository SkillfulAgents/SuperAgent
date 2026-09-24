/**
 * The trigger manager against the REAL webhook relay (only the platform is
 * faked): when auth resolves the `local` scope to a member, the manager swaps
 * its `local` registration for a member one, and nothing the relay had
 * already claimed for the old registration may be lost, whether it was
 * queued or still in flight. trigger-manager.test.ts uses a fake relay and
 * can't see this.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateSession = vi.fn()
let mockClient: unknown
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      ensureRunning: async () => {
        mockClient = { createSession: mockCreateSession }
        return mockClient
      },
      getClient: () => mockClient,
    }),
  }
})
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getEffectiveModels: () => ({ agentModel: 'm', browserModel: 'm', agentEffort: 'low' }),
}))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { subscribeToSession: vi.fn(), markSessionActive: vi.fn() },
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: { triggerWebhookSessionStarted: vi.fn().mockResolvedValue(undefined) },
}))
const mockGetDistinctMemberIds = vi.fn<() => string[]>()
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  getDistinctPlatformMemberIdsForActiveTriggers: () => mockGetDistinctMemberIds(),
  getSubscribedComposioTriggerIds: () => ['ti_abc'],
  getWebhookTriggersByComposioId: async () => [
    { id: 't1', agentSlug: 'agent', composioTriggerId: 'ti_abc', prompt: 'Handle it', status: 'active', fireCount: 0 },
  ],
  markTriggerFired: vi.fn().mockResolvedValue(undefined),
  markTriggerFailed: vi.fn().mockResolvedValue(undefined),
  resolveTriggerPrincipal: () => null,
  getConnectedAccountOwnerUserId: () => null,
}))
vi.mock('@shared/lib/services/session-service', () => ({
  registerSession: vi.fn().mockResolvedValue(undefined),
  updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({ getSecretEnvVars: vi.fn().mockResolvedValue([]) }))
vi.mock('@shared/lib/services/agent-preferences-service', () => ({ readAgentPreferences: vi.fn().mockResolvedValue({}) }))
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: vi.fn().mockResolvedValue(true) }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'opaque_key' }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_userId: unknown, fn: () => unknown) => fn(),
  runOutsideAttribution: (fn: () => unknown) => fn(),
  attribution: { requiresActingMember: () => false },
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({ connectedAccounts: {} }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

const { relayHolder } = vi.hoisted(() => ({ relayHolder: { relay: null as unknown } }))
vi.mock('@shared/lib/webhook-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/webhook-relay')>()
  return { ...actual, getWebhookRelay: () => relayHolder.relay }
})

import type { RelayEvent } from '@shared/lib/webhook-relay'
import { PlatformWebhookRelayService } from '@shared/lib/webhook-relay/platform-webhook-relay-service'
import { triggerManager } from './trigger-manager'

let pending: RelayEvent[]
let acked: string[]
let claimGate: Promise<void> | null
let relay: PlatformWebhookRelayService

async function settle() {
  for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(0)
}

function addEvents(count: number) {
  for (let i = 0; i < count; i++) {
    pending.push({ id: `whe_${pending.length + acked.length}`, endpointId: 'ti_abc', type: 'GMAIL', payload: {}, createdAt: '' })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  pending = []
  acked = []
  claimGate = null
  relay = new PlatformWebhookRelayService({
    claim: async (_scope, endpointIds) => {
      const gate = claimGate
      if (gate) await gate
      const taken = pending.filter((event) => endpointIds.includes(event.endpointId)).slice(0, 50)
      pending = pending.filter((event) => !taken.includes(event))
      return { events: taken, claimed: taken.length, realtime: null }
    },
    acknowledge: async (_scope, ids) => {
      acked.push(...ids)
    },
    endpoints: {} as never,
    getToken: () => 'opaque_key',
    requiresMemberScope: () => false,
    createRealtime: () => {
      throw new Error('no realtime in this test')
    },
    detach: (fn) => fn(),
  })
  relayHolder.relay = relay
  relay.start()
  mockGetDistinctMemberIds.mockReturnValue([])
})

afterEach(() => {
  triggerManager.stop()
  relay.stop()
  vi.useRealTimers()
})

describe('trigger manager handover from local to a member registration', () => {
  it('delivers every event already queued for the local registration', async () => {
    addEvents(120)
    let release!: () => void
    const firstSession = new Promise<void>((resolve) => (release = resolve))
    let sessions = 0
    mockCreateSession.mockImplementation(async () => {
      if (++sessions === 1) await firstSession
      return { id: `session_${sessions}` }
    })

    await triggerManager.start()
    await settle()
    mockGetDistinctMemberIds.mockReturnValue(['sub_member'])
    await triggerManager.syncRegistrations()
    release()
    await settle()

    expect(new Set(acked).size).toBe(120)
    expect(acked).toHaveLength(120)
    expect(sessions).toBe(3)
  })

  it('delivers a claim that was in flight for the local registration', async () => {
    addEvents(1)
    let release!: () => void
    claimGate = new Promise<void>((resolve) => (release = resolve))
    mockCreateSession.mockResolvedValue({ id: 'session_1' })

    await triggerManager.start()
    await settle()
    mockGetDistinctMemberIds.mockReturnValue(['sub_member'])
    await triggerManager.syncRegistrations()
    claimGate = null
    release()
    await settle()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(acked).toEqual(['whe_0'])
  })
})
