import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

// Connection-loss recovery: when the container stream dies and cannot be
// re-attached, the host must drop the dead subscription entry so
// isSubscribed() tells the truth. A stale entry makes every send-message
// route skip its re-subscribe (`if (!isSubscribed) subscribe`), so the next
// turn runs with NO stream at all — no result is ever seen, the grace
// backstop can never arm, and the session is pinned "working" forever.
// Same for a connection_closed that arrives while the session is
// interrupted: the interrupted gate must not swallow the one frame whose
// handler exists to clean the connection state up.

// ----- Mocks for external dependencies (mirrors grace-after-result) -----

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: vi.fn(),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  VALID_SCRIPT_TYPES: { darwin: ['applescript', 'shell'], linux: ['shell'], win32: ['powershell'] },
}))
vi.mock('@shared/lib/computer-use/permission-manager', () => ({
  computerUsePermissionManager: {
    checkPermission: vi.fn(() => 'prompt_needed'),
    getGrabbedApp: vi.fn(() => undefined),
    setGrabbedApp: vi.fn(),
    clearGrabbedApp: vi.fn(),
    consumeOnceGrant: vi.fn(),
  },
}))
vi.mock('@shared/lib/computer-use/types', () => ({
  getRequiredPermissionLevel: vi.fn(() => 'use_application'),
  resolveTargetApp: vi.fn(() => undefined),
  READ_ONLY_METHODS: new Set(['apps', 'windows', 'status', 'displays', 'permissions']),
  TIMED_GRANT_DURATION_MS: 15 * 60 * 1000,
}))
vi.mock('@shared/lib/computer-use/executor', () => ({
  resolveAppFromWindowRef: vi.fn(() => undefined),
}))
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  createWebhookTrigger: vi.fn(() => Promise.resolve('trigger_new_id')),
  listActiveWebhookTriggers: vi.fn(() => Promise.resolve([])),
  cancelWebhookTriggerWithCleanup: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('@shared/lib/composio/triggers', () => ({
  getAvailableTriggers: vi.fn(() => Promise.resolve([])),
  enableComposioTrigger: vi.fn(() => Promise.resolve('composio_trigger_id')),
  deleteComposioTrigger: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: vi.fn(() => true),
}))
vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: vi.fn(() => Promise.resolve('UTC')),
}))
vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({ connectedAccounts: {} }))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => '/nonexistent',
}))

// ----- Helpers -----

const AGENT_SLUG = 'test-agent'

let sessionCounter = 0
let teardown: (() => void) | null = null

function createRecoveryClient(sessionId: string) {
  let callback: ((message: StreamMessage) => void) | null = null
  const getSession = vi.fn(() => Promise.resolve<unknown>(null))
  const client = {
    subscribeToStream: vi.fn((_sid: string, cb: (message: StreamMessage) => void) => {
      callback = cb
      return { unsubscribe: vi.fn(), ready: Promise.resolve() }
    }),
    start: vi.fn(),
    stop: vi.fn(),
    stopSync: vi.fn(),
    getInfoFromRuntime: vi.fn(),
    getInfo: vi.fn(),
    fetch: vi.fn(),
    waitForHealthy: vi.fn(),
    isHealthy: vi.fn(),
    getStats: vi.fn(),
    createSession: vi.fn(),
    getSession,
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    getMessages: vi.fn(),
    interruptSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as ContainerClient
  const send = async (content: Record<string, unknown>) => {
    callback?.({
      type: (content.type as string) ?? 'message',
      content,
      timestamp: new Date(),
      sessionId,
    } as StreamMessage)
    // handleConnectionClosed resolves getSession asynchronously — drain a few ticks
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  return { client, send, getSession }
}

async function setUp() {
  vi.resetModules()
  const { messagePersister } = await import('./message-persister')
  const sessionId = `recovery-test-session-${++sessionCounter}`
  const { client, send, getSession } = createRecoveryClient(sessionId)

  teardown = () => {
    messagePersister.unsubscribeFromSession(sessionId)
  }

  await messagePersister.subscribeToSession(sessionId, client, sessionId, AGENT_SLUG)
  await send({ type: 'system', subtype: 'capabilities', session_state_events: true })
  messagePersister.markSessionActive(sessionId, AGENT_SLUG)

  return { messagePersister, sessionId, client, send, getSession }
}

// =====================================================================
// Tests
// =====================================================================

describe('connection-loss recovery keeps isSubscribed honest', () => {
  afterEach(() => {
    teardown?.()
    teardown = null
    vi.clearAllMocks()
  })

  it('drops the subscription when the session is gone from the container', async () => {
    const { messagePersister, sessionId, send, getSession } = await setUp()
    getSession.mockResolvedValue(null)

    await send({ type: 'connection_closed' })

    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    // The stale entry is the bug: with it, the next send skips re-subscribe
    // and the turn runs invisibly — unfixably stuck.
    expect(messagePersister.isSubscribed(sessionId)).toBe(false)
  })

  it('drops the subscription when the container is unreachable', async () => {
    const { messagePersister, sessionId, send, getSession } = await setUp()
    getSession.mockRejectedValue(new Error('connect ECONNREFUSED'))

    await send({ type: 'connection_closed' })

    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(messagePersister.isSubscribed(sessionId)).toBe(false)
  })

  it('drops the subscription when the container reports the session not running', async () => {
    const { messagePersister, sessionId, send, getSession } = await setUp()
    getSession.mockResolvedValue({ id: sessionId, isRunning: false })

    await send({ type: 'connection_closed' })

    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(messagePersister.isSubscribed(sessionId)).toBe(false)
  })

  it('keeps the subscription when it successfully re-subscribes to a running session', async () => {
    const { messagePersister, sessionId, client, send, getSession } = await setUp()
    getSession.mockResolvedValue({ id: sessionId, isRunning: true })

    await send({ type: 'connection_closed' })

    expect(messagePersister.isSubscribed(sessionId)).toBe(true)
    // Re-subscribed on the same client (initial subscribe + reconnect).
    expect(client.subscribeToStream).toHaveBeenCalledTimes(2)
  })

  it('an interrupted session still processes connection_closed (the gate must not swallow it)', async () => {
    const { messagePersister, sessionId, send, getSession } = await setUp()
    await messagePersister.markSessionInterrupted(sessionId)
    getSession.mockResolvedValue(null)

    await send({ type: 'connection_closed' })

    expect(messagePersister.isSubscribed(sessionId)).toBe(false)
  })
})
