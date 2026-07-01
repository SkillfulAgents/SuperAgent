import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import { promises as fs } from 'fs'
import type { ContainerClient, StreamMessage } from '@shared/lib/container/types'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

// COMPOSITION test for the per-task overlap guard (SUP-329).
//
// The scheduler unit test (task-scheduler.overlap-guard.test.ts) mocks the
// occupied predicate, and the message-persister suite proves the predicate's
// runtime semantics from real captures — but nothing tests the SEAM between
// them. This test closes that gap: it drives the REAL messagePersister with a
// REAL SUPERAGENT_CAPTURE_DIR stream (the background-bash-premature-idle capture,
// the ac23bdd8 regression) and then invokes the REAL taskScheduler guard against
// that live streaming state. No mock stands between the captured SDK events and
// the hold/fire decision.
//
// A run_in_background Bash keeps the session isActive=true / isAwaitingInput=false
// (it emits session_waiting_background at the premature turn-end idle), so the
// guard must HOLD while the bash is pending and FIRE once the session truly
// settles. Both halves are asserted against the same real persister instance the
// scheduler reads from.

// ---------------------------------------------------------------------------
// Mock surface. The message-persister and its transitive deps are mocked exactly
// as the existing capture-replay suites do (queued-message-idle-replay /
// subagent-task-events-replay) so the REAL persister imports cleanly — EXCEPT we
// never mock message-persister itself. On top of that we mock the scheduler's own
// dependencies. Where a module is imported by BOTH (scheduled-task-service,
// session-service, notification-manager, config/settings, schedule-parser) the
// mock exports the union of what each side needs.
// ---------------------------------------------------------------------------

const mockGetDueTasks = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockMarkTaskFailed = vi.fn()
const mockUpdateNextExecution = vi.fn()
const mockRecordTaskSkip = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  // Scheduler side
  getDueTasks: (...a: unknown[]) => mockGetDueTasks(...a),
  markTaskExecuted: (...a: unknown[]) => mockMarkTaskExecuted(...a),
  markTaskFailed: (...a: unknown[]) => mockMarkTaskFailed(...a),
  updateNextExecution: (...a: unknown[]) => mockUpdateNextExecution(...a),
  recordTaskSkip: (...a: unknown[]) => mockRecordTaskSkip(...a),
  // Persister side
  createScheduledTask: vi.fn(),
  listPendingScheduledTasks: vi.fn(() => Promise.resolve([])),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  cancelScheduledTask: vi.fn(),
  pauseScheduledTask: vi.fn(),
  resumeScheduledTask: vi.fn(),
}))

const mockGetSessionForScheduledExecution = vi.fn()
const mockRegisterSession = vi.fn()

vi.mock('@shared/lib/services/session-service', () => ({
  // Scheduler side
  getSessionForScheduledExecution: (...a: unknown[]) => mockGetSessionForScheduledExecution(...a),
  registerSession: (...a: unknown[]) => mockRegisterSession(...a),
  // Persister side
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
}))

const mockTriggerScheduledSessionStarted = vi.fn()

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    // Scheduler side
    triggerScheduledSessionStarted: (...a: unknown[]) => mockTriggerScheduledSessionStarted(...a),
    // Persister side
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('@shared/lib/config/settings', () => ({
  // Scheduler side
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
    dashboardBuilderModel: 'claude-sonnet-4-20250514',
  }),
  // Persister side
  getSettings: () => ({}),
  VALID_SCRIPT_TYPES: { darwin: ['applescript', 'shell'], linux: ['shell'], win32: ['powershell'] },
}))

const mockGetNextCronTime = vi.fn()

vi.mock('@shared/lib/services/schedule-parser', () => ({
  // Scheduler side
  getNextCronTime: (...a: unknown[]) => mockGetNextCronTime(...a),
  // Persister side
  getFrequencyWarning: vi.fn(() => null),
  getScheduleCountWarning: vi.fn(() => null),
  validateScheduleExpression: vi.fn(() => ({ valid: true })),
}))

// Scheduler-only deps
const mockEnsureRunning = vi.fn()
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: { ensureRunning: (...a: unknown[]) => mockEnsureRunning(...a) },
}))

const mockAgentExists = vi.fn()
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...a: unknown[]) => mockAgentExists(...a),
}))

const mockGetSecretEnvVars = vi.fn()
vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: (...a: unknown[]) => mockGetSecretEnvVars(...a),
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_u: string | null | undefined, fn: () => unknown) => fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

// Persister-only transitive deps (mirrors the existing replay suites).
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
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({ connectedAccounts: {} }))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => '/nonexistent',
}))

// Real modules under test — same registry, so the scheduler's
// `import { messagePersister }` resolves to THIS instance.
import { messagePersister } from '@shared/lib/container/message-persister'
import { taskScheduler } from '@shared/lib/scheduler/task-scheduler'

// ---------------------------------------------------------------------------
// Fixture + replay plumbing (mirrors queued-message-idle-replay.test.ts)
// ---------------------------------------------------------------------------

interface FixtureEntry {
  t: number
  message: StreamMessage
}

async function loadFixture(): Promise<{ sessionId: string; agentSlug: string; entries: FixtureEntry[] }> {
  const fixtureDir = path.join(
    __dirname,
    '..',
    'container',
    '__fixtures__',
    'background-bash-premature-idle',
  )
  const meta = JSON.parse(await fs.readFile(path.join(fixtureDir, 'metadata.json'), 'utf8'))
  const raw = await fs.readFile(path.join(fixtureDir, 'stream-input.jsonl'), 'utf8')
  const entries = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
  return { sessionId: meta.sessionId, agentSlug: meta.agentSlug, entries }
}

function createReplayClient(): { client: ContainerClient; send: (m: StreamMessage) => void } {
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

const tick = () => new Promise((r) => setImmediate(r))

const reanchoredAt = new Date('2026-06-26T17:05:00.000Z')

function dueRecurringTask(lastSessionId: string): ScheduledTask {
  return {
    id: 'task-1',
    agentSlug: 'agent-one',
    scheduleType: 'cron',
    scheduleExpression: '*/5 * * * *',
    prompt: 'Run the recurring report',
    name: 'Recurring report',
    status: 'pending',
    nextExecutionAt: new Date('2026-06-26T17:00:00.000Z'),
    lastExecutedAt: null,
    isRecurring: true,
    executionCount: 3,
    consecutiveSkips: 0,
    lastSkippedAt: null,
    lastSessionId,
    createdBySessionId: null,
    createdByUserId: 'user-1',
    timezone: null,
    model: null,
    effort: null,
    createdAt: new Date('2026-06-26T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
  }
}

describe('overlap guard against a real background-bash capture (persister ↔ scheduler seam)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let fixtureSessionId: string

  beforeEach(() => {
    taskScheduler.stop()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.clearAllMocks()
    mockGetDueTasks.mockResolvedValue([])
    mockGetSessionForScheduledExecution.mockResolvedValue(null)
    mockAgentExists.mockResolvedValue(true)
    mockGetSecretEnvVars.mockResolvedValue([])
    mockRegisterSession.mockResolvedValue(undefined)
    mockTriggerScheduledSessionStarted.mockResolvedValue(undefined)
    mockUpdateNextExecution.mockResolvedValue(undefined)
    mockRecordTaskSkip.mockResolvedValue(undefined)
    mockMarkTaskExecuted.mockResolvedValue(undefined)
    mockGetNextCronTime.mockReturnValue(reanchoredAt)
    // The freshly-fired session uses a mocked container client whose stream
    // subscription resolves immediately (subscribeToSession awaits `ready`).
    mockEnsureRunning.mockResolvedValue({
      createSession: vi.fn(() => Promise.resolve({ id: 'fired-session-new' })),
      subscribeToStream: vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() })),
    })
  })

  afterEach(() => {
    taskScheduler.stop()
    if (fixtureSessionId) messagePersister.unsubscribeFromSession(fixtureSessionId)
    messagePersister.unsubscribeFromSession('fired-session-new')
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('HOLDS while the backgrounded bash is live, then FIRES once the session truly settles', async () => {
    const { sessionId, agentSlug, entries } = await loadFixture()
    fixtureSessionId = sessionId
    const { client, send } = createReplayClient()

    // Wire the REAL persister to the replay stream, exactly like the POST
    // /messages route: subscribe, then mark active on the first user message.
    await messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)
    messagePersister.markSessionActive(sessionId, agentSlug)

    // ---- Replay until the first "backgrounded bash pending" checkpoint ----
    // We stop at the first moment the persister reports the occupied shape from
    // the real stream: active, not awaiting input, with a live background task.
    let occupiedIdx = -1
    for (let i = 0; i < entries.length; i++) {
      send(entries[i].message)
      await tick()
      if (
        messagePersister.isSessionActive(sessionId) &&
        !messagePersister.isSessionAwaitingInput(sessionId) &&
        messagePersister.getActiveBackgroundTasks(sessionId).length > 0
      ) {
        occupiedIdx = i
        break
      }
    }
    expect(occupiedIdx).toBeGreaterThan(-1)
    // Sanity: this is the exact predicate the guard evaluates, sourced from the
    // real persister rather than a mock.
    expect(messagePersister.isSessionActive(sessionId)).toBe(true)
    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(false)

    // ---- Invoke the REAL scheduler guard against that live state ----
    mockGetDueTasks.mockResolvedValue([dueRecurringTask(sessionId)])
    await taskScheduler.triggerExecution()

    // HELD: no second session spun up, schedule not advanced, skip recorded.
    expect(mockEnsureRunning).not.toHaveBeenCalled()
    expect(mockAgentExists).not.toHaveBeenCalled()
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    expect(mockRecordTaskSkip).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).toHaveBeenCalledWith('task-1')

    // ---- Replay the remainder of the capture to the truly-settled idle ----
    for (let i = occupiedIdx + 1; i < entries.length; i++) {
      send(entries[i].message)
      await tick()
    }
    // The real capture ends with the authoritative settled idle once both
    // backgrounded bashes have reported completion.
    expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    expect(messagePersister.getActiveBackgroundTasks(sessionId)).toHaveLength(0)

    // ---- Invoke the guard again now that the slot is free ----
    await taskScheduler.triggerExecution()

    // FIRES exactly once: a new session is created and the schedule re-anchors
    // forward. No additional skip was recorded (still just the one hold).
    expect(mockEnsureRunning).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).toHaveBeenCalledTimes(1)
    expect(mockUpdateNextExecution).toHaveBeenCalledTimes(1)
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'fired-session-new')
  })
})
