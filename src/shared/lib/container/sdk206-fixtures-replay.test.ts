import { describe, it, expect, afterEach, vi } from 'vitest'
import * as path from 'path'
import { promises as fs } from 'fs'
import type { ContainerClient, StreamMessage } from './types'

// Replay of real SUPERAGENT_CAPTURE_DIR captures taken on claude-agent-sdk
// 0.3.206 / CLI 2.1.206 (the sdk206-* fixtures). These are the first captures
// containing the new protocol surface:
//   - command_lifecycle frames (top-level message type, per-command terminal state)
//   - system/background_tasks_changed (full live-task snapshot on membership change)
//   - result.terminal_reason (present on EVERY result, success included)
//   - the background-BY-DEFAULT subagent shape (Agent tool without run_in_background)
//   - task_started/task_notification for FOREGROUND Bash too (new CLI behavior),
//     which is why these tests derive "background" from the persister's own
//     background_task_started SSE rather than from raw task_* frames.
//
// The persister does not consume the new frames yet — these tests lock the
// derived-SSE contract on the new stream shapes BEFORE the bookkeeping
// refactors (background_tasks_changed authority swap, command_lifecycle ghost
// states) so those changes must keep every assertion here green.

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

const mockSessionsDir: { value: string } = { value: '/nonexistent' }
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => mockSessionsDir.value,
}))

// ----- Fixture loading -----

interface FixtureMeta {
  sessionId: string
  agentSlug: string
  description: string
  startActive: boolean
  backgroundTasks: Array<{
    taskId: string
    taskType?: string
    startedT?: number
    prematureIdleT: number | null
    realCompletionT: number | null
  }>
  totalEntries: number
}

async function loadFixture(fixtureName: string): Promise<{
  meta: FixtureMeta
  streamEntries: Array<{ t: number; message: StreamMessage }>
}> {
  const fixtureDir = path.join(__dirname, '__fixtures__', fixtureName)
  const meta = JSON.parse(await fs.readFile(path.join(fixtureDir, 'metadata.json'), 'utf8'))
  const raw = await fs.readFile(path.join(fixtureDir, 'stream-input.jsonl'), 'utf8')
  const streamEntries = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
  return { meta, streamEntries }
}

// ----- Mock container client -----

function createReplayClient(): {
  client: ContainerClient
  send: (message: StreamMessage) => void
} {
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
  return {
    client,
    send: (m) => callback?.(m),
  }
}

// ----- Tracked replay -----

// Per-entry snapshot taken right after each stream message is processed, so a
// test can assert session/background-task state at the exact frame that must
// (not) have changed it.
interface ReplaySnapshot {
  index: number
  t: number
  type?: string
  subtype?: string
  state?: string
  isActive: boolean
  bgStartedIds: string[]
  bgCompletedIds: string[]
  sessionIdleCount: number
  waitingBackgroundCount: number
}

async function replayTracked(fixtureName: string): Promise<{
  meta: FixtureMeta
  streamEntries: Array<{ t: number; message: StreamMessage }>
  sseEvents: Array<Record<string, unknown>>
  timeline: ReplaySnapshot[]
}> {
  const { meta, streamEntries } = await loadFixture(fixtureName)

  vi.resetModules()
  const { messagePersister } = await import('./message-persister')
  const { client, send } = createReplayClient()

  const sseEvents: Array<Record<string, unknown>> = []
  const cleanup = messagePersister.addSSEClient(meta.sessionId, (data) => {
    sseEvents.push(data as Record<string, unknown>)
  })

  // The turn-starting user message predates the capture window; the idle
  // handler's gates are keyed on isActive.
  if (meta.startActive) {
    messagePersister.markSessionActive(meta.sessionId, meta.agentSlug)
  }
  await messagePersister.subscribeToSession(meta.sessionId, client, meta.sessionId, meta.agentSlug)

  const timeline: ReplaySnapshot[] = []
  for (let i = 0; i < streamEntries.length; i++) {
    const entry = streamEntries[i]
    send(entry.message)
    await new Promise((r) => setImmediate(r))

    const c = (entry.message?.content ?? {}) as Record<string, unknown>
    timeline.push({
      index: i,
      t: entry.t,
      type: c['type'] as string | undefined,
      subtype: c['subtype'] as string | undefined,
      state: c['state'] as string | undefined,
      isActive: messagePersister.isSessionActive(meta.sessionId),
      bgStartedIds: sseEvents.filter((e) => e['type'] === 'background_task_started').map((e) => e['taskId'] as string),
      bgCompletedIds: sseEvents.filter((e) => e['type'] === 'background_task_completed').map((e) => e['taskId'] as string),
      sessionIdleCount: sseEvents.filter((e) => e['type'] === 'session_idle').length,
      waitingBackgroundCount: sseEvents.filter((e) => e['type'] === 'session_waiting_background').length,
    })
  }

  await new Promise((r) => setTimeout(r, 50))
  cleanup()
  messagePersister.unsubscribeFromSession(meta.sessionId)

  return { meta, streamEntries, sseEvents, timeline }
}

// ----- Generic invariants -----
// The externally observable contract every task-bearing fixture must satisfy,
// regardless of how liveness bookkeeping is implemented internally.

function assertBackgroundContract(timeline: ReplaySnapshot[], sseEvents: Array<Record<string, unknown>>) {
  const started = sseEvents.filter((e) => e['type'] === 'background_task_started').map((e) => e['taskId'] as string)
  const completed = sseEvents.filter((e) => e['type'] === 'background_task_completed').map((e) => e['taskId'] as string)

  // Every started background task completes exactly once, and nothing
  // completes that never started.
  expect([...completed].sort()).toEqual([...new Set(completed)].sort())
  expect([...completed].sort()).toEqual([...started].sort())

  // session_idle never fires while a background task is open, and the session
  // stays active the whole time a task is open.
  for (const snap of timeline) {
    const open = snap.bgStartedIds.length - snap.bgCompletedIds.length
    if (open > 0) {
      expect(snap.sessionIdleCount, `session_idle emitted at t=${snap.t} while ${open} bg task(s) open`).toBe(0)
      expect(snap.isActive, `session inactive at t=${snap.t} while ${open} bg task(s) open`).toBe(true)
    }
  }
}

function finalSnapshot(timeline: ReplaySnapshot[]): ReplaySnapshot {
  return timeline[timeline.length - 1]
}

// A "premature idle" is an SDK idle frame arriving while a background task is open.
function prematureIdleSnapshots(timeline: ReplaySnapshot[]): ReplaySnapshot[] {
  return timeline.filter(
    (s) =>
      s.type === 'system' &&
      s.subtype === 'session_state_changed' &&
      s.state === 'idle' &&
      s.bgStartedIds.length - s.bgCompletedIds.length > 0
  )
}

// =====================================================================
// Tests
// =====================================================================

describe('sdk 0.3.206 capture replays', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('background bash: two tasks with premature idle', () => {
    it('keeps both tasks tracked across premature idles and finalizes only when both complete', async () => {
      const { sseEvents, timeline } = await replayTracked('sdk206-bg-bash-two-tasks-premature-idle')

      assertBackgroundContract(timeline, sseEvents)

      const started = sseEvents.filter((e) => e['type'] === 'background_task_started')
      expect(started).toHaveLength(2)

      // The SDK fired idle at turn-end while both tasks were running; the
      // persister must have answered with session_waiting_background, not
      // finalization.
      expect(prematureIdleSnapshots(timeline).length).toBeGreaterThanOrEqual(1)
      const fin = finalSnapshot(timeline)
      expect(fin.waitingBackgroundCount).toBeGreaterThanOrEqual(1)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })

    it('carries background_tasks_changed snapshots that converge with the incremental map', async () => {
      // The snapshot frames are not consumed yet; this asserts the fixture is
      // internally consistent so the authority swap can be validated against
      // it. Observed wire ordering: each background_tasks_changed LEADS its
      // per-task signal (the snapshot announcing a membership change arrives
      // one frame before the task_started / task_notification the incremental
      // map keys on). So the honest invariant is convergence, not per-frame
      // equality: between one snapshot and the next, the incremental open set
      // must at some point equal the announced set.
      const { streamEntries, timeline } = await replayTracked('sdk206-bg-bash-two-tasks-premature-idle')

      const snapshotFrames = streamEntries
        .map((e, i) => ({ i, c: e.message.content as Record<string, unknown> }))
        .filter(({ c }) => c['type'] === 'system' && c['subtype'] === 'background_tasks_changed')
      expect(snapshotFrames.length).toBeGreaterThanOrEqual(3)

      for (let s = 0; s < snapshotFrames.length; s++) {
        const { i, c } = snapshotFrames[s]
        const announced = ((c['tasks'] as Array<{ task_id: string }>) ?? []).map((t) => t.task_id).sort()
        const windowEnd = s + 1 < snapshotFrames.length ? snapshotFrames[s + 1].i : timeline.length
        const converges = timeline.slice(i, windowEnd).some((snap) => {
          const openRegistered = snap.bgStartedIds.filter((id) => !snap.bgCompletedIds.includes(id)).sort()
          return JSON.stringify(openRegistered) === JSON.stringify(announced)
        })
        expect(
          converges,
          `background_tasks_changed at index ${i} (announcing [${announced}]) never matched by incremental tracking before the next snapshot`
        ).toBe(true)
      }
    })
  })

  describe('background bash: busy-path completion', () => {
    it('clears the background task mid-turn while the session is busy', async () => {
      const { sseEvents, timeline } = await replayTracked('sdk206-bg-bash-busy-completion')

      assertBackgroundContract(timeline, sseEvents)

      // Find the snapshot where the bg task's completion landed: the session
      // must still be mid-turn (active, no idle yet).
      const completionIdx = timeline.findIndex((s) => s.bgCompletedIds.length === 1)
      expect(completionIdx).toBeGreaterThan(-1)
      expect(timeline[completionIdx].isActive).toBe(true)
      expect(timeline[completionIdx].sessionIdleCount).toBe(0)

      const fin = finalSnapshot(timeline)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })
  })

  describe('background subagent: default (no run_in_background) — the new CLI default', () => {
    it('tracks the async subagent as a background task and finalizes after completion', async () => {
      const { sseEvents, timeline } = await replayTracked('sdk206-bg-subagent-default')

      assertBackgroundContract(timeline, sseEvents)

      const started = sseEvents.filter((e) => e['type'] === 'background_task_started')
      expect(started.length).toBeGreaterThanOrEqual(1)

      const fin = finalSnapshot(timeline)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })
  })

  describe('background subagent: explicit run_in_background with premature idle', () => {
    it('suppresses the premature idle and finalizes only after the subagent completes', async () => {
      const { sseEvents, timeline } = await replayTracked('sdk206-bg-subagent-premature-idle')

      assertBackgroundContract(timeline, sseEvents)
      expect(prematureIdleSnapshots(timeline).length).toBeGreaterThanOrEqual(1)

      const fin = finalSnapshot(timeline)
      expect(fin.waitingBackgroundCount).toBeGreaterThanOrEqual(1)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })
  })

  describe('synchronous subagents (explicit run_in_background:false)', () => {
    it('parallel: no background tasks registered, single settled idle', async () => {
      const { sseEvents, timeline } = await replayTracked('sdk206-parallel-subagents-sync')

      expect(sseEvents.filter((e) => e['type'] === 'background_task_started')).toHaveLength(0)
      const fin = finalSnapshot(timeline)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })

    it('sequential different types: no background tasks registered, single settled idle', async () => {
      const { sseEvents, timeline } = await replayTracked('sdk206-sequential-different-types')

      expect(sseEvents.filter((e) => e['type'] === 'background_task_started')).toHaveLength(0)
      const fin = finalSnapshot(timeline)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })
  })

  describe('queued message merging into the turn (command_lifecycle present)', () => {
    it('tolerates command_lifecycle frames and finalizes exactly once despite the single merged result', async () => {
      const { streamEntries, timeline } = await replayTracked('sdk206-queued-message-final-response')

      // Real-shape quirk this fixture exists for: TWO command_lifecycle:completed
      // frames but only ONE result message — the queued command merged into the
      // running turn.
      const lifecycleCompleted = streamEntries.filter((e) => {
        const c = e.message.content as Record<string, unknown>
        return c['type'] === 'command_lifecycle' && c['state'] === 'completed'
      })
      const results = streamEntries.filter((e) => (e.message.content as Record<string, unknown>)['type'] === 'result')
      expect(lifecycleCompleted).toHaveLength(2)
      expect(results).toHaveLength(1)

      const fin = finalSnapshot(timeline)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })
  })

  describe('interrupt with queued messages: the stream just stops', () => {
    it('leaves the session active — the wire carries no queued-fate or idle signal after interrupt', async () => {
      // The capture ends mid-turn: two command_lifecycle:queued frames, then
      // silence (the query died; host-side markSessionInterrupted — an API
      // action outside this stream — is what flips the UI today). Replay must
      // neither crash nor invent an idle. When interrupt-receipt adoption
      // lands, the receipt (not this stream) is what must resolve the queued
      // messages' fate.
      const { streamEntries, sseEvents, timeline } = await replayTracked('sdk206-queued-message-interrupt')

      const queuedFrames = streamEntries.filter((e) => {
        const c = e.message.content as Record<string, unknown>
        return c['type'] === 'command_lifecycle' && c['state'] === 'queued'
      })
      expect(queuedFrames).toHaveLength(2)
      // No cancelled/discarded lifecycle frames ever arrive.
      const terminalLifecycle = streamEntries.filter((e) => {
        const c = e.message.content as Record<string, unknown>
        return c['type'] === 'command_lifecycle' && ['cancelled', 'discarded'].includes(c['state'] as string)
      })
      expect(terminalLifecycle).toHaveLength(0)

      const fin = finalSnapshot(timeline)
      expect(fin.sessionIdleCount).toBe(0)
      expect(fin.isActive).toBe(true)
      expect(sseEvents.filter((e) => e['type'] === 'session_error')).toHaveLength(0)
    })
  })

  describe('local workflow run', () => {
    it('tracks the workflow as a background task and emits workflow_completed exactly once', async () => {
      const { sseEvents, timeline } = await replayTracked('sdk206-workflow-probe')

      assertBackgroundContract(timeline, sseEvents)
      expect(sseEvents.filter((e) => e['type'] === 'workflow_completed')).toHaveLength(1)

      const fin = finalSnapshot(timeline)
      expect(fin.sessionIdleCount).toBe(1)
      expect(fin.isActive).toBe(false)
    })
  })

  describe('dead turn via nonexistent model (terminal_reason: api_error)', () => {
    it('classifies the success-subtype-but-is_error result as an error turn', async () => {
      // REAL SHAPE: subtype "success" + is_error:true + terminal_reason
      // "api_error" + api_error_status 404. A subtype-only error check
      // classifies this as a successful turn and emits no session_error.
      const { streamEntries, sseEvents, timeline } = await replayTracked('sdk206-error-turn-invalid-model')

      const result = streamEntries
        .map((e) => e.message.content as Record<string, unknown>)
        .find((c) => c['type'] === 'result')
      expect(result).toBeDefined()
      expect(result!['subtype']).toBe('success')
      expect(result!['is_error']).toBe(true)
      expect(result!['terminal_reason']).toBe('api_error')

      const errors = sseEvents.filter((e) => e['type'] === 'session_error')
      expect(errors).toHaveLength(1)
      expect(errors[0]['terminalReason']).toBe('api_error')
      expect(errors[0]['apiErrorStatus']).toBe(404)
      // The api error code comes from the preceding synthetic assistant
      // message's error field, present in this capture.
      expect(errors[0]['apiErrorCode']).toBe('model_not_found')

      // The error settles the session at the result; the trailing SDK idle
      // frame must not double-finalize.
      const fin = finalSnapshot(timeline)
      expect(fin.isActive).toBe(false)
      expect(fin.sessionIdleCount).toBe(0)
    })
  })
})
