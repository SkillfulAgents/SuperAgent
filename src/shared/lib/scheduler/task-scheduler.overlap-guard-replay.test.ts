import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import { promises as fs } from 'fs'
import { createInMemorySessionStore } from '@shared/lib/agent-actor/testing/in-memory-session-store'
import type { ContainerClient, StreamMessage } from '@shared/lib/container/types'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

// The overlap guard end to end: the REAL message persister replays a real
// capture (background-bash-premature-idle: two run_in_background Bash tasks,
// each followed by a turn-end idle while the bash is still running), and the
// REAL scheduler reads that state through the real agent actor. The unit test
// mocks the busy predicate; this one checks that what the persister reports
// for a run with background work pending is what the guard needs to hold.

// ----- Scheduler-side mocks -----

const mockGetDueTasks = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockUpdateNextExecution = vi.fn()
const mockRecordTaskSkip = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: (...a: unknown[]) => mockGetDueTasks(...a),
  markTaskExecuted: (...a: unknown[]) => mockMarkTaskExecuted(...a),
  markTaskFailed: vi.fn(() => Promise.resolve()),
  updateNextExecution: (...a: unknown[]) => mockUpdateNextExecution(...a),
  recordTaskSkip: (...a: unknown[]) => mockRecordTaskSkip(...a),
  rescheduleAfterFailure: vi.fn(() => Promise.resolve()),
  // Persister side
  createScheduledTask: vi.fn(),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
}))

const mockEnsureRunning = vi.fn()
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

vi.mock('@shared/lib/services/session-service', () => ({
  getSessionForScheduledExecution: vi.fn(() => Promise.resolve(null)),
  registerSession: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('not-automation')),
}))

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerScheduledSessionStarted: vi.fn(() => Promise.resolve()),
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
    dashboardBuilderModel: 'claude-sonnet-4-20250514',
  }),
  getSettings: () => ({}),
  VALID_SCRIPT_TYPES: { darwin: ['applescript', 'shell'], linux: ['shell'], win32: ['powershell'] },
}))

const reanchoredAt = new Date('2026-06-26T17:05:00.000Z')
vi.mock('@shared/lib/services/schedule-parser', () => ({
  getNextCronTime: () => reanchoredAt,
}))

const mockAgentExists = vi.fn()
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...a: unknown[]) => mockAgentExists(...a),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn(() => Promise.resolve([])),
}))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_u: string | null | undefined, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

// ----- Persister-side mocks (mirrors the container replay suites) -----

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
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => '/nonexistent',
  getSessionJsonlPath: (_agentSlug: string, _sessionId: string) => '/nonexistent/session.jsonl',
}))

import { messagePersister } from '@shared/lib/container/message-persister'
import { agentRegistry } from '@shared/lib/agent-actor'
import { taskScheduler } from './task-scheduler'

// ----- Fixture plumbing -----

interface FixtureEntry {
  t: number
  message: StreamMessage
}

async function loadFixture(): Promise<{ sessionId: string; agentSlug: string; entries: FixtureEntry[] }> {
  const fixtureDir = path.join(__dirname, '..', 'container', '__fixtures__', 'background-bash-premature-idle')
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
    getSession: vi.fn(() => Promise.resolve(null)),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as ContainerClient
  return { client, send: (m) => callback?.(m) }
}

const tick = () => new Promise((r) => setImmediate(r))

function dueRecurringTask(agentSlug: string, lastSessionId: string): ScheduledTask {
  return {
    id: 'task-1',
    agentSlug,
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
    speed: null,
    resumeSessionId: null,
    createdAt: new Date('2026-06-26T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
  }
}

describe('overlap guard against a real background-bash capture', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    taskScheduler.stop()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.clearAllMocks()
    mockGetDueTasks.mockResolvedValue([])
    mockAgentExists.mockResolvedValue(true)
    mockUpdateNextExecution.mockResolvedValue(undefined)
    mockRecordTaskSkip.mockResolvedValue(undefined)
    mockMarkTaskExecuted.mockResolvedValue(undefined)
    mockEnsureRunning.mockResolvedValue({
      createSession: vi.fn(() => Promise.resolve({ id: 'fired-session-new' })),
      subscribeToStream: vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() })),
    })
  })

  afterEach(() => {
    taskScheduler.stop()
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('holds while the backgrounded bash runs, then fires once the session settles', async () => {
    const { sessionId, agentSlug, entries } = await loadFixture()
    // The registry attaches the actors' real session stores on first use;
    // swap in memory ones afterwards so the replay touches no disk.
    agentRegistry.get(agentSlug)
    messagePersister.attachSessionStores(createInMemorySessionStore)

    const { client, send } = createReplayClient()
    const sseTypes: unknown[] = []
    const removeSseClient = messagePersister.addSSEClient(agentSlug, sessionId, (data) => {
      sseTypes.push((data as { type?: unknown }).type)
    })
    await messagePersister.subscribeToSession(agentSlug, sessionId, client, sessionId)
    messagePersister.markSessionActive(agentSlug, sessionId)

    // Replay up to the first turn-end idle that arrives while a background bash
    // is still running: the moment the session tells clients it is waiting on
    // background work.
    let busyIdx = -1
    for (let i = 0; i < entries.length; i++) {
      send(entries[i].message)
      await tick()
      if (sseTypes.includes('session_waiting_background')) {
        busyIdx = i
        break
      }
    }
    expect(busyIdx).toBeGreaterThan(-1)
    expect(messagePersister.getActiveBackgroundTasks(agentSlug, sessionId).length).toBeGreaterThan(0)

    mockGetDueTasks.mockResolvedValue([dueRecurringTask(agentSlug, sessionId)])
    await taskScheduler.triggerExecution()

    expect(mockAgentExists).not.toHaveBeenCalled()
    expect(mockEnsureRunning).not.toHaveBeenCalled()
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    expect(mockRecordTaskSkip).toHaveBeenCalledExactlyOnceWith('task-1')

    // Replay the rest: both bashes report completion and the session settles.
    for (let i = busyIdx + 1; i < entries.length; i++) {
      send(entries[i].message)
      await tick()
    }
    expect(messagePersister.isSessionActive(agentSlug, sessionId)).toBe(false)
    expect(messagePersister.getActiveBackgroundTasks(agentSlug, sessionId)).toHaveLength(0)

    await taskScheduler.triggerExecution()

    expect(mockEnsureRunning).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).toHaveBeenCalledTimes(1)
    expect(mockUpdateNextExecution).toHaveBeenCalledExactlyOnceWith('task-1', reanchoredAt, 'fired-session-new')
    removeSseClient()
  })
})
