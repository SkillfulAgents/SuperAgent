import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

// Lossless container→host stream: the host tracks a per-session
// (epoch, seq) cursor over the relayed messages and passes it on every
// (re)subscribe, so the container can replay exactly what was missed during a
// reconnect gap. The attach hello carries the container incarnation's epoch:
// a mismatch means the previous process (and the turn + background tasks
// running in it) died — the host reconciles instead of waiting forever for
// terminal signals that can no longer arrive.

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

// Unique session id per test: a failing assertion skips the trailing
// unsubscribe, and subscribeToSession deliberately carries prior flags (incl.
// activeBackgroundTasks) for a same-session re-subscribe — so a reused id
// would leak one test's state into the next.
let sessionCounter = 0

// Unconditional teardown (assertion failures skip a test's trailing cleanup).
let teardown: (() => void) | null = null

type Cursor = { epoch: string; sinceSeq: number } | undefined

function createCursorClient(sessionId: string): {
  client: ContainerClient
  send: (content: Record<string, unknown>) => Promise<void>
  cursors: Cursor[]
} {
  let callback: ((message: StreamMessage) => void) | null = null
  const cursors: Cursor[] = []
  const client = {
    subscribeToStream: vi.fn(
      (_sid: string, cb: (message: StreamMessage) => void, cursor?: Cursor) => {
        callback = cb
        cursors.push(cursor)
        return { unsubscribe: vi.fn(), ready: Promise.resolve() }
      }
    ),
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
    getSession: vi.fn(() => Promise.resolve(null)),
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
    await new Promise((r) => setImmediate(r))
  }
  return { client, send, cursors }
}

const hello = (epoch: string, maxSeq: number) => ({
  type: 'system',
  subtype: 'capabilities',
  session_state_events: true,
  epoch,
  max_seq: maxSeq,
})
const LEGACY_HELLO = { type: 'system', subtype: 'capabilities', session_state_events: true }
const assistant = (seq: number) => ({
  type: 'assistant',
  seq,
  message: { content: [{ type: 'text', text: 'hi' }] },
})
const result = (seq: number) => ({ type: 'result', subtype: 'success', seq })
const idle = (seq: number) => ({
  type: 'system',
  subtype: 'session_state_changed',
  state: 'idle',
  seq,
})
const bgLaunch = (seq: number) => ({
  type: 'user',
  seq,
  message: { content: [] },
  tool_use_result: { backgroundTaskId: 'bg-1' },
})

async function setUp(subscribeOpts?: { fromStart?: boolean }) {
  vi.resetModules()
  const { messagePersister } = await import('./message-persister')
  const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
  const sessionId = `cursor-test-session-${++sessionCounter}`
  const { client, send, cursors } = createCursorClient(sessionId)

  const sseEvents: Array<Record<string, unknown>> = []
  const removeSSE = messagePersister.addSSEClient(sessionId, (data) => {
    sseEvents.push(data as Record<string, unknown>)
  })
  teardown = () => {
    removeSSE()
    messagePersister.unsubscribeFromSession(sessionId)
  }

  await messagePersister.subscribeToSession(sessionId, client, sessionId, AGENT_SLUG, subscribeOpts)

  const resubscribe = () =>
    messagePersister.subscribeToSession(sessionId, client, sessionId, AGENT_SLUG)

  return { messagePersister, notificationManager, sessionId, sseEvents, send, cursors, resubscribe }
}

const countIdle = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e['type'] === 'session_idle').length
const countMessagesUpdated = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e['type'] === 'messages_updated').length

// =====================================================================
// Tests
// =====================================================================

describe('stream cursor + epoch reconcile', () => {
  afterEach(() => {
    teardown?.()
    teardown = null
    vi.clearAllMocks()
  })

  it('tracks the (epoch, seq) cursor and passes it on re-subscribe', async () => {
    const { messagePersister, sessionId, send, cursors, resubscribe } = await setUp()

    // First attach carries no cursor (live-only).
    expect(cursors[0]).toBeUndefined()

    await send(hello('epoch-1', 4))
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(5))
    await send(assistant(6))

    await resubscribe()
    expect(cursors[1]).toEqual({ epoch: 'epoch-1', sinceSeq: 6 })
  })

  it('settles from replayed terminal events after a reconnect gap', async () => {
    const { messagePersister, notificationManager, sessionId, sseEvents, send, cursors, resubscribe } =
      await setUp()

    await send(hello('epoch-1', -1))
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))
    // ...the turn's result + idle are emitted during a WS gap and never seen live.

    await resubscribe()
    expect(cursors[1]).toEqual({ epoch: 'epoch-1', sinceSeq: 0 })

    // The container replays exactly what was missed (same epoch).
    await send(hello('epoch-1', 2))
    await send(result(1))
    await send(idle(2))

    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
  })

  it('epoch mismatch mid-turn settles as interrupted: no completion notification, tasks dropped', async () => {
    const { messagePersister, notificationManager, sessionId, sseEvents, send, resubscribe } =
      await setUp()

    await send(hello('epoch-1', -1))
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))
    await send(bgLaunch(1))
    expect(messagePersister.isSessionActive(sessionId)).toBe(true)

    // Container restarted during the gap: new incarnation, fresh numbering.
    // The turn and its background task died with the old process.
    await resubscribe()
    await send(hello('epoch-2', -1))

    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(countIdle(sseEvents)).toBe(1)
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()

    // The dead task must not wedge future settles: a fresh turn on the new
    // epoch settles normally on its idle.
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))
    await send(result(1))
    await send(idle(2))
    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(countIdle(sseEvents)).toBe(2)
  })

  it('epoch mismatch after a seen result settles WITH the completion notification', async () => {
    const { messagePersister, notificationManager, sessionId, sseEvents, send, resubscribe } =
      await setUp()

    await send(hello('epoch-1', -1))
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))
    await send(result(1))
    // The reply is done; only the settling idle was pending when the
    // container died. The user still deserves the "done" signal.

    await resubscribe()
    await send(hello('epoch-2', -1))

    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(countIdle(sseEvents)).toBe(1)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
  })

  it('an epoch mismatch while the grace timer is armed settles exactly once', async () => {
    // The grace backstop arms a setTimeout after the result; fake timers for
    // this one test so its window can be driven past deterministically.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { messagePersister, notificationManager, sessionId, sseEvents, send, resubscribe } =
        await setUp()

      await send(hello('epoch-1', -1))
      messagePersister.markSessionActive(sessionId, AGENT_SLUG)
      await send(assistant(0))
      await send(result(1)) // result seen, idle pending → grace arms

      // The container died inside the grace window; the re-attach hello
      // carries a new epoch and the reconcile settles (with the notification).
      await resubscribe()
      await send(hello('epoch-2', -1))

      expect(countIdle(sseEvents)).toBe(1)
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

      // The armed grace window elapsing afterwards must not settle again.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(countIdle(sseEvents)).toBe(1)
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a same-epoch hello on re-attach reconciles nothing: a mid-turn session stays active', async () => {
    const { messagePersister, notificationManager, sessionId, sseEvents, send, resubscribe } =
      await setUp()

    await send(hello('epoch-1', -1))
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))

    // Same incarnation across the reconnect gap: the turn is still running.
    await resubscribe()
    await send(hello('epoch-1', 0))

    expect(messagePersister.isSessionActive(sessionId)).toBe(true)
    expect(countIdle(sseEvents)).toBe(0)
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
  })

  it('skips already-processed seqs (duplicate delivery is idempotent)', async () => {
    const { messagePersister, sessionId, sseEvents, send } = await setUp()

    await send(hello('epoch-1', -1))
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))
    const updatedAfterFirst = countMessagesUpdated(sseEvents)

    // The same message delivered again (overlapping replay / duplicate socket).
    await send(assistant(0))
    expect(countMessagesUpdated(sseEvents)).toBe(updatedAfterFirst)
  })

  it('seq-less frames are processed but never advance the cursor', async () => {
    const { messagePersister, sessionId, sseEvents, send, cursors, resubscribe } = await setUp()

    await send(hello('epoch-1', -1))
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))
    await send({ type: 'browser_active', active: false })

    expect(sseEvents.some((e) => e['type'] === 'browser_active')).toBe(true)
    await resubscribe()
    expect(cursors[1]).toEqual({ epoch: 'epoch-1', sinceSeq: 0 })
  })

  it('legacy hello without epoch keeps today\'s behavior: no cursor on re-subscribe', async () => {
    const { messagePersister, notificationManager, sessionId, send, cursors, resubscribe } =
      await setUp()

    await send(LEGACY_HELLO)
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
    await send({ type: 'result', subtype: 'success' })
    await send({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    await resubscribe()
    expect(cursors[1]).toBeUndefined()
  })

  it('a hello with an epoch but no max_seq is treated as legacy (no cursor)', async () => {
    const { messagePersister, sessionId, send, cursors, resubscribe } = await setUp()

    await send({ type: 'system', subtype: 'capabilities', session_state_events: true, epoch: 'epoch-1' })
    messagePersister.markSessionActive(sessionId, AGENT_SLUG)
    await send(assistant(0))

    // Baselining a missing max_seq would make this re-subscribe request a
    // full-history replay of an old session — the dead-background-task wedge.
    await resubscribe()
    expect(cursors[1]).toBeUndefined()
    expect(messagePersister.isSessionActive(sessionId)).toBe(true)
  })

  it('a from-start subscribe replays the just-created session it would otherwise have missed', async () => {
    // The stuck-case this kills: createSession dispatches the first turn
    // BEFORE the host subscribes. A fast first turn's result+idle land before
    // the attach — live-only, they are gone, and the session pins "working"
    // forever (no result seen means the grace backstop can never arm).
    const { messagePersister, notificationManager, sessionId, sseEvents, send, cursors } =
      await setUp({ fromStart: true })

    // The first attach must request everything from the very start.
    expect(cursors[0]).toEqual({ sinceSeq: -1 })

    messagePersister.markSessionActive(sessionId, AGENT_SLUG)

    // Container replays the whole young history after the hello: the first
    // turn already ran to completion inside the attach gap.
    await send(hello('epoch-1', 2))
    await send(assistant(0))
    await send(result(1))
    await send(idle(2))

    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(countIdle(sseEvents)).toBe(1)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
  })
})
