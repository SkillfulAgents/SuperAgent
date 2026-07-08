import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ============================================================================
// Mocks (same surface as trigger-manager.test.ts)
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
  getWebhookTriggersByComposioId: (...args: unknown[]) => mockGetWebhookTriggersByComposioId(...args),
  markTriggerFired: (...args: unknown[]) => mockMarkTriggerFired(...args),
  markTriggerFailed: vi.fn().mockResolvedValue(undefined),
  resolvePlatformMemberForCandidates: () => null,
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

const mockPollAndClaimEvents = vi.fn()
const mockAcknowledgeEvents = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/services/webhook-events-client', () => ({
  pollAndClaimEvents: (...args: unknown[]) => mockPollAndClaimEvents(...args),
  acknowledgeEvents: (...args: unknown[]) => mockAcknowledgeEvents(...args),
}))

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

const ENDPOINT_ID = 'whep_11111111-2222-4333-8444-555555555555'

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

function envelopeEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    composio_trigger_id: ENDPOINT_ID,
    trigger_type: 'CUSTOM_WEBHOOK',
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
    created_at: '2026-07-06T00:00:00Z',
  }
}

describe('TriggerManager custom webhook endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSession.mockResolvedValue({ id: 'session_123' })
    mockGetWebhookTriggersByComposioId.mockResolvedValue([customTrigger])
  })

  // Stop even when an assertion throws mid-test — the singleton's isRunning
  // guard would otherwise no-op every later start().
  afterEach(() => {
    triggerManager.stop()
  })

  it('frames UNVERIFIED events as untrusted external data', async () => {
    mockPollAndClaimEvents.mockResolvedValue({
      events: [envelopeEvent('whe_1', { verified: false })],
      realtime: null,
    })

    await triggerManager.start()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Handle the incoming webhook')
    expect(prompt).toContain('Signature verified: NO')
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain('deploy')
    expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_1'], 'sub_test_member')
  })

  it('frames verified events as signature verified', async () => {
    mockPollAndClaimEvents.mockResolvedValue({
      events: [envelopeEvent('whe_2', { verified: true })],
      realtime: null,
    })

    await triggerManager.start()

    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Signature verified: YES')
    expect(prompt).not.toContain('untrusted')
  })

  it('fails closed: an unparseable envelope still gets the untrusted framing', async () => {
    mockPollAndClaimEvents.mockResolvedValue({
      events: [
        {
          id: 'whe_drift',
          composio_trigger_id: ENDPOINT_ID,
          trigger_type: 'CUSTOM_WEBHOOK',
          // Envelope drift: no `verified`/`kind` — must never fall back to the
          // trusted Composio framing for public-URL input.
          payload: { body: '{"deploy":"finished"}' },
          created_at: '2026-07-06T00:00:00Z',
        },
      ],
      realtime: null,
    })

    await triggerManager.start()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Signature verified: NO')
    expect(prompt).toContain('untrusted')
  })

  it('acks handshake events without spawning a session', async () => {
    mockPollAndClaimEvents.mockResolvedValue({
      events: [
        envelopeEvent('whe_hs', {
          kind: 'handshake',
          handshake_type: 'slack_url_verification',
        }),
      ],
      realtime: null,
    })

    await triggerManager.start()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockMarkTriggerFired).not.toHaveBeenCalled()
    expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_hs'], 'sub_test_member')
  })

  it('spawns for real events but not handshakes in a mixed batch, acking all', async () => {
    mockPollAndClaimEvents.mockResolvedValue({
      events: [
        envelopeEvent('whe_hs', { kind: 'handshake', handshake_type: 'dropbox_challenge' }),
        envelopeEvent('whe_real'),
      ],
      realtime: null,
    })

    await triggerManager.start()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).not.toContain('handshake')
    // Both events acked (handshake included) so nothing re-fires.
    expect(mockAcknowledgeEvents).toHaveBeenCalledWith(['whe_hs', 'whe_real'], 'sub_test_member')
  })

  it('leaves Composio events on the classic payload framing', async () => {
    mockGetWebhookTriggersByComposioId.mockResolvedValue([
      { ...customTrigger, kind: 'composio', triggerType: 'GMAIL_NEW_EMAIL', composioTriggerId: 'ti_abc' },
    ])
    mockPollAndClaimEvents.mockResolvedValue({
      events: [
        {
          id: 'whe_c',
          composio_trigger_id: 'ti_abc',
          trigger_type: 'GMAIL_NEW_EMAIL',
          payload: { subject: 'Hello' },
          created_at: '',
        },
      ],
      realtime: null,
    })

    await triggerManager.start()

    const prompt = mockCreateSession.mock.calls[0][0].initialMessage as string
    expect(prompt).toContain('Webhook payload:')
    expect(prompt).not.toContain('Signature verified')
  })
})
