/**
 * Regression: a finished turn never settles when a settle frame is lost or
 * discarded. One case per cause, plus a positive control.
 *
 * Wire frames are built through Zod (and the production background-tasks
 * parser) so a hand-rolled shape cannot pin a dead path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import type { ContainerClient, StreamMessage } from './types'
import { parseBackgroundTasksChanged } from './background-tasks-changed'

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: vi.fn(() => Promise.resolve('t')),
  createSessionWake: vi.fn(() => Promise.resolve({ taskId: 'w', replaced: null })),
  listPendingScheduledTasks: vi.fn(() => Promise.resolve([])),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  cancelScheduledTask: vi.fn(() => Promise.resolve(true)),
  pauseScheduledTask: vi.fn(() => Promise.resolve(true)),
  resumeScheduledTask: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: vi.fn(() => 'UTC'),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
  VALID_SCRIPT_TYPES: { darwin: ['applescript', 'shell'], linux: ['shell'], win32: ['powershell'] },
}))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: vi.fn(() => '/mock/sessions'),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))
vi.mock('@shared/lib/db', () => ({ db: { select: vi.fn() } }))
vi.mock('@shared/lib/db/schema', () => ({ connectedAccounts: {} }))
vi.mock('./container-manager', () => ({
  containerManager: { getClient: () => ({ fetch: vi.fn(() => Promise.resolve({ ok: true })) }) },
}))

import { messagePersister, STREAM_SILENCE_REATTACH_MS } from './message-persister'

const capabilitiesFrameSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('capabilities'),
  session_state_events: z.boolean(),
})

const sessionStateFrameSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('session_state_changed'),
  state: z.enum(['idle', 'running']),
  replayed: z.boolean().optional(),
})

const resultFrameSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  replayed: z.boolean().optional(),
})

const backgroundTasksFrameSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('background_tasks_changed'),
    tasks: z.array(
      z.object({
        task_id: z.string(),
        task_type: z.string().optional(),
        description: z.string().optional(),
      })
    ),
    replayed: z.boolean().optional(),
  })
  .superRefine((frame, ctx) => {
    // Production parser is the authority for the tasks payload.
    if (!parseBackgroundTasksChanged(frame)) {
      ctx.addIssue({ code: 'custom', message: 'rejected by parseBackgroundTasksChanged' })
    }
  })

function capabilitiesFrame() {
  return capabilitiesFrameSchema.parse({
    type: 'system',
    subtype: 'capabilities',
    session_state_events: true,
  })
}

function sessionStateFrame(state: 'idle' | 'running', opts?: { replayed?: boolean }) {
  return sessionStateFrameSchema.parse({
    type: 'system',
    subtype: 'session_state_changed',
    state,
    ...(opts?.replayed ? { replayed: true } : {}),
  })
}

function resultFrame(opts?: { replayed?: boolean }) {
  return resultFrameSchema.parse({
    type: 'result',
    subtype: 'success',
    result: 'Updated files.',
    is_error: false,
    ...(opts?.replayed ? { replayed: true } : {}),
  })
}

function backgroundTasksFrame(
  tasks: Array<{ task_id: string; task_type?: string }>,
  opts?: { replayed?: boolean }
) {
  return backgroundTasksFrameSchema.parse({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks,
    ...(opts?.replayed ? { replayed: true } : {}),
  })
}

function createMockClient(): ContainerClient & {
  _sendMessage: (content: unknown) => void
  _flushCloses: () => void
  _failNextSubscribe: () => void
} {
  let messageCallback: ((message: StreamMessage) => void) | null = null
  let failNextSubscribe = false
  const pendingCloses: Array<() => void> = []
  const connectionClosed = (callback: (message: StreamMessage) => void) =>
    callback({
      type: 'connection_closed',
      content: { type: 'connection_closed' },
      timestamp: new Date(),
      sessionId: 'settle-silence',
    })
  const client = {
    _sendMessage(content: unknown) {
      if (!messageCallback) return
      messageCallback({
        type: 'message',
        content,
        timestamp: new Date(),
        sessionId: 'settle-silence',
      })
    },
    _flushCloses() {
      for (const close of pendingCloses.splice(0)) close()
    },
    _failNextSubscribe() {
      failNextSubscribe = true
    },
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
    getSession: vi.fn(() => Promise.resolve({ isRunning: true })),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    interruptSession: vi.fn(),
    subscribeToStream: vi.fn((_sessionId: string, callback: (message: StreamMessage) => void) => {
      if (failNextSubscribe) {
        failNextSubscribe = false
        connectionClosed(callback)
        return {
          unsubscribe: vi.fn(),
          ready: Promise.reject(new Error('replacement failed')),
        }
      }
      messageCallback = callback
      // Real half-open sockets deliver their close after the replacement is
      // installed. Keep each callback bound to the socket that owned it.
      const unsubscribe = vi.fn(() => {
        if (messageCallback === callback) messageCallback = null
        pendingCloses.push(() => connectionClosed(callback))
      })
      return { unsubscribe, ready: Promise.resolve() }
    }),
    on: vi.fn(),
    off: vi.fn(),
  }
  return client as unknown as ContainerClient & {
    _sendMessage: (content: unknown) => void
    _flushCloses: () => void
    _failNextSubscribe: () => void
  }
}

describe('settle silence / discarded settle memory', () => {
  const SESSION = 'settle-silence-session'
  const AGENT = 'settle-silence-agent'
  let client: ReturnType<typeof createMockClient>

  beforeEach(async () => {
    vi.useFakeTimers()
    client = createMockClient()
    await messagePersister.subscribeToSession(SESSION, client, SESSION, AGENT)
  })

  afterEach(() => {
    messagePersister.unsubscribeFromSession(SESSION)
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('POSITIVE CONTROL: result then idle on a healthy socket settles', () => {
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    client._sendMessage(sessionStateFrame('idle'))
    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
  })

  it('external re-subscribe between result and idle must not discard the idle', async () => {
    // Cause: subscribeToSession wiped lastResultSubtype; the idle guard then
    // treated a correctly-delivered idle as stale. No transport failure.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())

    await messagePersister.subscribeToSession(SESSION, client, SESSION, AGENT)
    client._flushCloses()
    client._sendMessage(sessionStateFrame('idle'))

    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
  })

  it('external re-subscribe does not let a bare idle settle a new turn', async () => {
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())

    await messagePersister.subscribeToSession(SESSION, client, SESSION, AGENT)
    client._flushCloses()
    client._sendMessage(sessionStateFrame('idle'))

    expect(messagePersister.getSessionActivity(SESSION)).not.toBe('idle')
  })

  it('a turn that starts on an already-quiet stream arms recovery', async () => {
    messagePersister.markSessionActive(SESSION, AGENT)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)

    expect(client.subscribeToStream).toHaveBeenCalledTimes(2)
  })

  it('stream silence while a turn is live reattaches and settles from late-join replay', async () => {
    // Cause: half-open (or any lost terminal frames). Nothing detects the dead
    // peer; reattach is the recovery road close never reaches.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    // Idle never arrives.
    expect(client.subscribeToStream).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    client._flushCloses()
    // Flush getSession().then from any connection_closed the detach synthesized.
    await Promise.resolve()
    await Promise.resolve()

    // Reattach is only transport recovery. Time alone never settles the turn.
    expect(messagePersister.getSessionActivity(SESSION)).not.toBe('idle')
    // Exactly one replacement subscribe — not silence reattach PLUS a stacked
    // handleConnectionClosed resubscribe (that double-applied stream_deltas).
    expect(client.subscribeToStream).toHaveBeenCalledTimes(2)
    expect(client.getSession).not.toHaveBeenCalled()
    // Container late-join replay for a finished turn (result + idle).
    client._sendMessage(resultFrame({ replayed: true }))
    client._sendMessage(sessionStateFrame('idle', { replayed: true }))

    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
  })

  it('a failed silence replacement is handled as the current connection closing', async () => {
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    client._failNextSubscribe()

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    await Promise.resolve()
    await Promise.resolve()

    expect(client.getSession).toHaveBeenCalledTimes(1)
    expect(client.subscribeToStream).toHaveBeenCalledTimes(3)
  })

  it('late-join replay with an empty background snapshot unpins a lost task terminal', async () => {
    // Cause: host holds a task whose removal snapshot was destroyed. Replay
    // must carry the container's latest background_tasks_changed, or the host
    // stays in waiting-background after the synthetic idle.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    client._sendMessage(
      backgroundTasksFrame([{ task_id: 'bg-1', task_type: 'local_bash' }])
    )
    client._sendMessage(sessionStateFrame('idle'))
    expect(messagePersister.getSessionActivity(SESSION)).not.toBe('idle')

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    expect(client.subscribeToStream).toHaveBeenCalledTimes(2)

    client._sendMessage(resultFrame({ replayed: true }))
    client._sendMessage(backgroundTasksFrame([], { replayed: true }))
    client._sendMessage(sessionStateFrame('idle', { replayed: true }))

    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
  })
})
