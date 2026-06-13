import { describe, it, expect, afterEach, vi } from 'vitest'
import * as path from 'path'
import { promises as fs } from 'fs'
import type { ContainerClient, StreamMessage } from './types'

// Replay of the real premature-idle-on-queued-message capture (session
// d6ca7b70, 2026-06-11). The user queued a follow-up while the agent streamed
// its FINAL response. The message arrived too late to be steered into the
// running query, so the CLI completed the query (result success) with NO
// session_state_changed event — a CLI run starts in 'running' and only
// publishes its first transition, the final idle, at the very END of the
// session. The container then started a continuation run for the queued
// message 73ms later.
//
// The bug: the persister discovered state-event support by observing a state
// event — but the first one a session can ever produce arrives only at the
// final idle, so the first result was handled by the legacy result-driven
// path and the session flipped idle (working indicator off, completion
// notification fired) BEFORE the queued message's turn ran.
//
// The fix: the container announces `capabilities` (session_state_events) on
// WebSocket connect, before any relayed SDK message, so the persister treats
// state events as the idle authority from the session's very first turn.

// ----- Mocks for external dependencies (mirrors subagent-task-events-replay) -----

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

// ----- Fixture loading -----

interface FixtureEntry {
  t: number
  message: StreamMessage
}

async function loadFixture(): Promise<{ sessionId: string; agentSlug: string; entries: FixtureEntry[] }> {
  const fixtureDir = path.join(__dirname, '__fixtures__', 'queued-message-final-response')
  const meta = JSON.parse(await fs.readFile(path.join(fixtureDir, 'metadata.json'), 'utf8'))
  const raw = await fs.readFile(path.join(fixtureDir, 'stream-input.jsonl'), 'utf8')
  const entries = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
  return { sessionId: meta.sessionId, agentSlug: meta.agentSlug, entries }
}

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

async function setUpReplay(entries: FixtureEntry[], sessionId: string, agentSlug: string) {
  vi.resetModules()
  const { messagePersister } = await import('./message-persister')
  const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
  const { client, send } = createReplayClient()

  const sseEvents: Array<Record<string, unknown>> = []
  const cleanup = messagePersister.addSSEClient(sessionId, (data) => {
    sseEvents.push(data as Record<string, unknown>)
  })

  await messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)
  // The POST /messages route marks the session active when the first user
  // message is sent.
  messagePersister.markSessionActive(sessionId, agentSlug)

  const firstResultIdx = entries.findIndex((e) => e.message.content?.type === 'result')
  const sendRange = async (from: number, to: number) => {
    for (const entry of entries.slice(from, to)) {
      send(entry.message)
      await new Promise((r) => setImmediate(r))
    }
  }

  return { messagePersister, notificationManager, sseEvents, cleanup, firstResultIdx, sendRange }
}

const countIdle = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e['type'] === 'session_idle').length

// =====================================================================
// Tests
// =====================================================================

describe('queued-message-during-final-response replay (real capture, session d6ca7b70)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not flip idle at the first result while the queued message is still pending', async () => {
    const { sessionId, agentSlug, entries } = await loadFixture()
    const { messagePersister, notificationManager, sseEvents, cleanup, firstResultIdx, sendRange } =
      await setUpReplay(entries, sessionId, agentSlug)

    // Replay turn 1 up to (but not including) its result. The queued POST
    // landed mid-stream — the route re-marks the session active (no-op).
    await sendRange(0, firstResultIdx)
    messagePersister.markSessionActive(sessionId, agentSlug)

    // Deliver turn 1's result. In the real capture the CLI emits NO state
    // event here — the queued message keeps the runtime going, and the
    // continuation run only starts 73ms later.
    await sendRange(firstResultIdx, firstResultIdx + 1)

    // THE BUG: the legacy result-driven path finalized idle here.
    expect(countIdle(sseEvents)).toBe(0)
    expect(messagePersister.isSessionActive(sessionId)).toBe(true)
    // The premature completion notification was part of the same bug.
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
    // The turn's output is still announced so the renderer can reconcile the
    // just-streamed text against the transcript.
    expect(sseEvents.some((e) => e['type'] === 'turn_output_complete')).toBe(true)

    // Replay the continuation run through to the final result + state idle.
    await sendRange(firstResultIdx + 1, entries.length)

    // Exactly one idle, at the authoritative session_state_changed:'idle'.
    expect(countIdle(sseEvents)).toBe(1)
    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    cleanup()
    messagePersister.unsubscribeFromSession(sessionId)
  })

  it('legacy containers (no capabilities hello, no state events) keep result-driven idle', async () => {
    const { sessionId, agentSlug, entries } = await loadFixture()
    const legacyEntries = entries.filter(
      (e) =>
        e.message.content?.subtype !== 'capabilities' &&
        e.message.content?.subtype !== 'session_state_changed'
    )
    const { messagePersister, sseEvents, cleanup, sendRange } = await setUpReplay(
      legacyEntries,
      sessionId,
      agentSlug
    )

    await sendRange(0, legacyEntries.length)

    // Without the capability announcement the persister cannot know the
    // runtime will continue, so each result finalizes idle (the original
    // pre-state-events behavior — premature for queued messages, but the
    // session is never left stuck).
    expect(countIdle(sseEvents)).toBeGreaterThanOrEqual(1)
    expect(messagePersister.isSessionActive(sessionId)).toBe(false)

    cleanup()
    messagePersister.unsubscribeFromSession(sessionId)
  })
})
