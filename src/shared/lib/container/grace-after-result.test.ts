import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import { promises as fs } from 'fs'
import type { ContainerClient, StreamMessage } from './types'

// Grace-after-result backstop: when a turn's `result` has been seen but the
// authoritative session_state_changed:'idle' never arrives (the SDK hangs in
// the post-result wind-down, or in the post-background-drain wind-down), the
// host settles itself after a short grace window instead of pinning the
// session "working" forever.
//
// The backstop is a DERIVED gate re-evaluated after every processed message —
// it arms only when the SDK's last word was "work done" (a result, with no
// background tasks left and nothing opened since) and disarms the moment any
// turn activity appears. It can therefore never fire during a genuinely
// running turn (the #339 trap), including the queued-continuation turn that
// starts 73ms after the previous result (real capture, session d6ca7b70).

// ----- Mocks for external dependencies (mirrors queued-message-idle-replay) -----

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

// Must match RESULT_IDLE_GRACE_MS in message-persister.ts.
const GRACE_MS = 10_000

const SESSION_ID = 'grace-test-session'
const AGENT_SLUG = 'test-agent'

function createReplayClient(): { client: ContainerClient; send: (message: StreamMessage) => void } {
  let callback: ((message: StreamMessage) => void) | null = null
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
    getSession: vi.fn(() => Promise.resolve(null)),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    getMessages: vi.fn(),
    interruptSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as ContainerClient
  return { client, send: (m) => callback?.(m) }
}

function streamMsg(content: Record<string, unknown>): StreamMessage {
  return {
    type: (content.type as string) ?? 'message',
    content,
    timestamp: new Date(),
    sessionId: SESSION_ID,
  } as StreamMessage
}

// Container message shapes (mirroring real captures)
const CAPABILITIES = { type: 'system', subtype: 'capabilities', session_state_events: true }
const RESULT_SUCCESS = { type: 'result', subtype: 'success' }
const STATE_IDLE = { type: 'system', subtype: 'session_state_changed', state: 'idle' }
const ASSISTANT_MSG = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }
const BROWSER_INACTIVE = { type: 'browser_active', active: false }
// A user message whose tool_use_result registers a backgrounded Bash task
const BG_TASK_LAUNCH = {
  type: 'user',
  message: { content: [] },
  tool_use_result: { backgroundTaskId: 'bg-1' },
}
// The idle/wake-path terminal notification that drains the task
const BG_TASK_DRAIN = { type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' }

async function setUp() {
  vi.resetModules()
  const { messagePersister } = await import('./message-persister')
  const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
  const { client, send: rawSend } = createReplayClient()

  const sseEvents: Array<Record<string, unknown>> = []
  const cleanup = messagePersister.addSSEClient(SESSION_ID, (data) => {
    sseEvents.push(data as Record<string, unknown>)
  })

  await messagePersister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)

  const send = async (content: Record<string, unknown>) => {
    rawSend(streamMsg(content))
    await new Promise((r) => setImmediate(r))
  }

  // The container announces state-event support on connect; the route marks
  // the session active when the user's message is sent.
  await send(CAPABILITIES)
  messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

  return { messagePersister, notificationManager, client, sseEvents, cleanup, send }
}

const countIdle = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e['type'] === 'session_idle').length

// ----- Fixture loading (real queued-message capture, session d6ca7b70) -----

interface FixtureEntry {
  t: number
  message: StreamMessage
}

async function loadQueuedFixture(): Promise<{
  sessionId: string
  agentSlug: string
  entries: FixtureEntry[]
}> {
  const fixtureDir = path.join(__dirname, '__fixtures__', 'queued-message-final-response')
  const meta = JSON.parse(await fs.readFile(path.join(fixtureDir, 'metadata.json'), 'utf8'))
  const raw = await fs.readFile(path.join(fixtureDir, 'stream-input.jsonl'), 'utf8')
  const entries = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
  return { sessionId: meta.sessionId, agentSlug: meta.agentSlug, entries }
}

// =====================================================================
// Tests
// =====================================================================

describe('grace-after-result backstop', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('settles a session whose idle never arrives after result (the post-result hang)', async () => {
    const { messagePersister, notificationManager, sseEvents, cleanup, send } = await setUp()

    await send(ASSISTANT_MSG)
    await send(RESULT_SUCCESS)

    // With state-event authority, result alone must not settle (that part is
    // existing behavior) — the session waits for idle...
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)
    expect(countIdle(sseEvents)).toBe(0)

    // ...but when idle never comes, the grace backstop settles it.
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1000)

    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
    // A merely-lost idle must not cost the user the completion notification.
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    cleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
  })

  it('never fires mid-turn: the queued continuation (real capture) cancels the pending grace', async () => {
    // Fixture timeline: turn-1 result → (+73ms) continuation system init →
    // turn 2 → turn-2 result → the ONLY session_state_changed:'idle'.
    const { entries } = await loadQueuedFixture()
    vi.resetModules()
    const { messagePersister } = await import('./message-persister')
    const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
    const { client, send: rawSend } = createReplayClient()

    const meta = await loadQueuedFixture()
    const sessionId = meta.sessionId
    const sseEvents: Array<Record<string, unknown>> = []
    const cleanup = messagePersister.addSSEClient(sessionId, (data) => {
      sseEvents.push(data as Record<string, unknown>)
    })
    await messagePersister.subscribeToSession(sessionId, client, sessionId, meta.agentSlug)
    messagePersister.markSessionActive(sessionId, meta.agentSlug)

    const sendRange = async (from: number, to: number) => {
      for (const entry of entries.slice(from, to)) {
        rawSend(entry.message)
        await new Promise((r) => setImmediate(r))
      }
    }
    const firstResultIdx = entries.findIndex((e) => e.message.content?.type === 'result')
    const secondResultIdx = entries.findIndex(
      (e, i) => i > firstResultIdx && e.message.content?.type === 'result'
    )

    // Turn 1 through its result: grace arms here.
    await sendRange(0, firstResultIdx + 1)
    const idleCountAtTurn1Result = countIdle(sseEvents)

    // The queued continuation's messages arrive (init + turn-2 activity), but
    // turn 2 then goes SILENT (a long tool). Advance far past the grace
    // window: the armed timer must have been cancelled by the turn-2 start —
    // firing here would flip idle mid-turn (the exact bug stateEventsAuthority
    // was built to kill).
    await sendRange(firstResultIdx + 1, secondResultIdx)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3)

    expect(countIdle(sseEvents)).toBe(idleCountAtTurn1Result)
    expect(messagePersister.isSessionActive(sessionId)).toBe(true)

    // Finish the capture (turn-2 result + authoritative idle): exactly one
    // idle, one notification — the grace path added nothing.
    await sendRange(secondResultIdx, entries.length)
    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    cleanup()
    messagePersister.unsubscribeFromSession(sessionId)
  })

  it('settles the second-idle hang: background task drains, then idle never arrives', async () => {
    const { messagePersister, notificationManager, sseEvents, cleanup, send } = await setUp()

    // A turn launches a backgrounded Bash task, finishes (result), and the SDK
    // fires the turn-end idle while the task still runs — the host correctly
    // refuses to settle (waiting on background).
    await send(ASSISTANT_MSG)
    await send(BG_TASK_LAUNCH)
    await send(RESULT_SUCCESS)
    await send(STATE_IDLE)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)
    expect(sseEvents.some((e) => e['type'] === 'session_waiting_background')).toBe(true)

    // Hours later the task's terminal notification drains it… and the SDK
    // hangs before the truly-settled second idle. No future result exists —
    // only the grace backstop can settle this.
    await send(BG_TASK_DRAIN)
    expect(countIdle(sseEvents)).toBe(0)

    await vi.advanceTimersByTimeAsync(GRACE_MS + 1000)

    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    cleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
  })

  it('is not disarmed by non-turn frames (browser_active) inside the grace window', async () => {
    const { messagePersister, sseEvents, cleanup, send } = await setUp()

    await send(ASSISTANT_MSG)
    await send(RESULT_SUCCESS)

    // The container's browser auto-stop broadcast rides the same stream and
    // says nothing about turn progress — it must not switch the backstop off.
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2)
    await send(BROWSER_INACTIVE)
    await vi.advanceTimersByTimeAsync(GRACE_MS)

    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)

    cleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
  })

  it('does not fire while the session is awaiting user input', async () => {
    const { messagePersister, sseEvents, cleanup, send } = await setUp()

    await send(ASSISTANT_MSG)
    await send(RESULT_SUCCESS)

    // An input request lands between arm and fire — settling would mask it
    // (computeActivity only reports 'awaiting' while isActive is true).
    messagePersister.recoverSessionAwaitingInput(SESSION_ID, AGENT_SLUG)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3)

    expect(countIdle(sseEvents)).toBe(0)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)
    expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

    cleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
  })

  it('survives a re-subscribe inside the result→idle window (state carried, timer re-armed)', async () => {
    const { messagePersister, notificationManager, client, sseEvents, cleanup, send } = await setUp()

    await send(ASSISTANT_MSG)
    await send(RESULT_SUCCESS)

    // A reconnect re-subscribes mid-window. The fresh streaming state must
    // carry the turn's "result seen" memory, and the grace must re-arm —
    // otherwise a hang after a reconnect sticks forever.
    await messagePersister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1000)

    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    cleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
  })

  it('stays inert when the authoritative idle arrives normally (no double settle)', async () => {
    const { messagePersister, notificationManager, sseEvents, cleanup, send } = await setUp()

    await send(ASSISTANT_MSG)
    await send(RESULT_SUCCESS)
    await send(STATE_IDLE)

    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    // The grace window elapsing afterwards must add nothing.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3)
    expect(countIdle(sseEvents)).toBe(1)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    cleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
  })

  it('never arms mid-turn (no result seen yet)', async () => {
    const { messagePersister, sseEvents, cleanup, send } = await setUp()

    // A turn is running — a long silent tool produces no messages for far
    // longer than the grace window. Nothing may settle.
    await send(ASSISTANT_MSG)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 20)

    expect(countIdle(sseEvents)).toBe(0)
    expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)

    cleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
  })
})
