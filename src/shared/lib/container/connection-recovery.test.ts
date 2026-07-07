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

  it('does not drop a fresh subscription installed by a concurrent re-subscribe', async () => {
    const { messagePersister, sessionId, client, send, getSession } = await setUp()

    // handleConnectionClosed queries the container asynchronously; hold that
    // check open so a concurrent send-route re-subscribe can install a fresh
    // live socket under this sessionId while the check is in flight. Dropping
    // the entry then would delete a LIVE subscription — isSubscribed() would
    // lie false and the next turn would run with no stream.
    let resolveGetSession: (v: unknown) => void = () => {}
    getSession.mockReturnValue(new Promise((r) => { resolveGetSession = r }))

    // Enter handleConnectionClosed; its getSession stays parked (unresolved).
    await send({ type: 'connection_closed' })

    // Concurrent re-subscribe replaces the entry with a fresh live unsubscribe.
    await messagePersister.subscribeToSession(sessionId, client, sessionId, AGENT_SLUG)
    expect(messagePersister.isSubscribed(sessionId)).toBe(true)

    // Now the stale check resolves "session gone".
    resolveGetSession(null)
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))

    // Only the dead socket's entry may be dropped — the fresh one survives.
    expect(messagePersister.isSubscribed(sessionId)).toBe(true)
  })

  it('a fromStart subscribe that never connects settles instead of pinning active', async () => {
    // Regression guard for the mark-active-BEFORE-subscribe reorder: if the WS
    // never opens, base-container-client synthesizes a connection_closed through
    // the callback (asynchronously, AFTER doSubscribeToSession installs the
    // subscription entry). With isActive already true and the container gone,
    // that must SETTLE the session and drop the dead entry — not leave it pinned
    // "working" with a stale subscription. This is why the reorder needs no
    // try/catch cleanup: the self-heal already covers a failed attach.
    vi.resetModules()
    const { messagePersister } = await import('./message-persister')
    const sessionId = `recovery-fail-session-${++sessionCounter}`

    const getSession = vi.fn(() => Promise.resolve<unknown>(null)) // container gone
    const client = {
      subscribeToStream: vi.fn((_sid: string, cb: (message: StreamMessage) => void) => {
        // Mirror setupWebSocket().catch: connection_closed lands async, after the
        // subscription entry is installed and after `ready` rejects.
        setImmediate(() =>
          cb({
            type: 'connection_closed',
            content: { type: 'connection_closed' },
            timestamp: new Date(),
            sessionId,
          } as StreamMessage),
        )
        return { unsubscribe: vi.fn(), ready: Promise.reject(new Error('WS connect failed')) }
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

    teardown = () => messagePersister.unsubscribeFromSession(sessionId)

    // Fixed call-site order: mark active BEFORE subscribing.
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await messagePersister
      .subscribeToSession(sessionId, client, sessionId, AGENT_SLUG, { fromStart: true })
      .catch(() => {}) // ready rejects → subscribeToSession throws; the heal is async
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))

    // Settled via the synthesized connection_closed, not pinned working.
    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(messagePersister.isSubscribed(sessionId)).toBe(false)
  })
})
