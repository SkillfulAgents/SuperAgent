import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { ENDPOINT_ID } = vi.hoisted(() => ({ ENDPOINT_ID: 'whep_11111111-2222-4333-8444-555555555555' }))

// ============================================================================
// Mocks (same surface as trigger-manager.test.ts)
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
  }),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    subscribeToSession: vi.fn(),
    markSessionActive: vi.fn(),
  },
}))

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerWebhookSessionStarted: vi.fn().mockResolvedValue(undefined),
  },
}))

const mockGetWebhookTriggersByComposioId = vi.fn()
const mockMarkTriggerFired = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  getDistinctPlatformMemberIdsForActiveTriggers: () => ['sub_test_member'],
  getSubscribedComposioTriggerIds: () => [ENDPOINT_ID, 'ti_abc'],
  getWebhookTriggersByComposioId: (...args: unknown[]) => mockGetWebhookTriggersByComposioId(...args),
  markTriggerFired: (...args: unknown[]) => mockMarkTriggerFired(...args),
  markTriggerFailed: vi.fn().mockResolvedValue(undefined),
  resolveTriggerPrincipal: () => null,
  getConnectedAccountOwnerUserId: () => null,
}))

vi.mock('@shared/lib/services/session-service', () => ({
  registerSession: vi.fn().mockResolvedValue(undefined),
  updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn().mockResolvedValue([]),
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: vi.fn().mockResolvedValue(true),
}))

vi.mock('@shared/lib/webhook-relay', async () => {
  const { createFakeWebhookRelay } = await import('@shared/lib/webhook-relay/testing/fake-webhook-relay')
  const relay = createFakeWebhookRelay()
  return { getWebhookRelay: () => relay, LOCAL_RELAY_SCOPE: 'local' }
})

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => 'opaque_test_token',
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_userId: string | null | undefined, fn: () => unknown) => fn(),
  attribution: {
    requiresActingMember: () => false,
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

async function startAndDeliver(events: RelayEvent[]) {
  await triggerManager.start()
  return relay.deliver('webhook-triggers:sub_test_member', events)
}

const customTrigger = {
  id: 'trigger_custom_1',
  agentSlug: 'test-agent',
  kind: 'custom',
  composioTriggerId: ENDPOINT_ID,
  connectedAccountId: null,
  triggerType: 'CUSTOM_WEBHOOK',
  prompt: 'Handle the incoming webhook',
  name: 'Custom endpoint',
  status: 'active',
  fireCount: 0,
}

function envelopeEvent(id: string, overrides: Record<string, unknown> = {}): RelayEvent {
  return {
    id,
    endpointId: ENDPOINT_ID,
    type: 'CUSTOM_WEBHOOK',
    payload: {
      kind: 'event',
      verified: false,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      query: {},
      content_type: 'application/json',
      body: '{"deploy":"finished"}',
      body_encoding: 'utf8',
      received_at: '2026-07-06T00:00:00Z',
      ...overrides,
    },
    createdAt: '2026-07-06T00:00:00Z',
  }
}

describe('TriggerManager custom webhook endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    relay.reset()
    mockCreateSession.mockResolvedValue({ id: 'session_123' })
    mockGetWebhookTriggersByComposioId.mockResolvedValue([customTrigger])
  })

  // Stop even when an assertion throws mid-test — the singleton's isRunning
  // guard would otherwise no-op every later start().
  afterEach(() => {
    triggerManager.stop()
  })

  it('frames UNVERIFIED events as untrusted external data', async () => {
    const results = await startAndDeliver([envelopeEvent('whe_1', { verified: false })])

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Handle the incoming webhook')
    expect(prompt).toContain('Signature verified: NO')
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain('deploy')
    expect(results).toEqual(new Map([['whe_1', 'accepted']]))
  })

  it('frames verified events as signature verified', async () => {
    await startAndDeliver([envelopeEvent('whe_2', { verified: true })])

    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Signature verified: YES')
    expect(prompt).not.toContain('untrusted')
  })

  it('fails closed: an unparseable envelope still gets the untrusted framing', async () => {
    await startAndDeliver([
      {
        id: 'whe_drift',
        endpointId: ENDPOINT_ID,
        type: 'CUSTOM_WEBHOOK',
        // Envelope drift: no `verified`/`kind` — must never fall back to the
        // trusted Composio framing for public-URL input.
        payload: { body: '{"deploy":"finished"}' },
        createdAt: '2026-07-06T00:00:00Z',
      },
    ])

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Signature verified: NO')
    expect(prompt).toContain('untrusted')
  })

  it('settles handshake events without spawning a session', async () => {
    const results = await startAndDeliver([
      envelopeEvent('whe_hs', {
        kind: 'handshake',
        handshake_type: 'slack_url_verification',
      }),
    ])

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockMarkTriggerFired).not.toHaveBeenCalled()
    expect(results).toEqual(new Map([['whe_hs', 'discard']]))
  })

  it('spawns for real events but not handshakes in a mixed batch, settling all', async () => {
    const results = await startAndDeliver([
      envelopeEvent('whe_hs', { kind: 'handshake', handshake_type: 'dropbox_challenge' }),
      envelopeEvent('whe_real'),
    ])

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).not.toContain('handshake')
    // Both events settled (handshake included) so nothing re-fires.
    expect(results).toEqual(new Map([['whe_hs', 'accepted'], ['whe_real', 'accepted']]))
  })

  it('leaves Composio events on the classic payload framing', async () => {
    mockGetWebhookTriggersByComposioId.mockResolvedValue([
      { ...customTrigger, kind: 'composio', triggerType: 'GMAIL_NEW_EMAIL', composioTriggerId: 'ti_abc' },
    ])
    await startAndDeliver([
      { id: 'whe_c', endpointId: 'ti_abc', type: 'GMAIL_NEW_EMAIL', payload: { subject: 'Hello' }, createdAt: '' },
    ])

    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Webhook payload:')
    expect(prompt).not.toContain('Signature verified')
  })
})
