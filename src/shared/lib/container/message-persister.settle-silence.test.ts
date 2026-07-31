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

import {
  messagePersister,
  isReplayOfProcessedResult,
  STREAM_SILENCE_REATTACH_MS,
} from './message-persister'
import { notificationManager } from '@shared/lib/notifications/notification-manager'

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
  // Present on every real result frame (see the sdk206-* captures) and the only
  // turn identity a replayed frame carries.
  uuid: z.string().min(1),
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

const TURN_RESULT_UUID = '97469a01-fc94-42a0-a9e0-4064206cfccb'

// Replay leads with the finished turn's informationals, before its result.
function informationalFrame(opts?: { replayed?: boolean }) {
  return {
    type: 'system' as const,
    subtype: 'informational' as const,
    message: 'Context low',
    uuid: 'a1b2c3d4-0000-4000-8000-00000000000a',
    ...(opts?.replayed ? { replayed: true } : {}),
  }
}

function resultFrame(opts?: { replayed?: boolean; uuid?: string }) {
  return resultFrameSchema.parse({
    type: 'result',
    subtype: 'success',
    result: 'Updated files.',
    is_error: false,
    uuid: opts?.uuid ?? TURN_RESULT_UUID,
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
  _setTurnSettled: (settled: boolean) => void
  _armReplay: (frames: unknown[]) => void
} {
  let messageCallback: ((message: StreamMessage) => void) | null = null
  let failNextSubscribe = false
  let replayBatch: unknown[] = []
  // What the container reports about its own turn. Default false = a turn is
  // genuinely running, which is the healthy long-tool-call case.
  let turnSettled = false
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
    _setTurnSettled(settled: boolean) {
      turnSettled = settled
    },
    /** Frames the container will replay to every subsequent attach. */
    _armReplay(frames: unknown[]) {
      replayBatch = frames
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
    getSession: vi.fn(() => Promise.resolve({ isRunning: true, turnSettled })),
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
      // The container replays its last finished turn to EVERY late joiner, not
      // just the first — so a reattach re-delivers the same batch. A double
      // that replays only once cannot see a recovery that loops on its own
      // replay.
      for (const content of replayBatch) {
        callback({ type: 'message', content, timestamp: new Date(), sessionId: 'settle-silence' })
      }
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
    _setTurnSettled: (settled: boolean) => void
    _armReplay: (frames: unknown[]) => void
  }
}

describe('isReplayOfProcessedResult', () => {
  const SEEN = '97469a01-fc94-42a0-a9e0-4064206cfccb'

  it('a host with no result memory has nothing to be stale against', () => {
    expect(isReplayOfProcessedResult(null, SEEN)).toBe(false)
  })

  it('an unidentifiable result counts as already processed, never as new', () => {
    // Fail-safe direction: cannot prove new, so it must not be allowed to settle.
    expect(isReplayOfProcessedResult(SEEN, undefined)).toBe(true)
    expect(isReplayOfProcessedResult(SEEN, '')).toBe(true)
  })

  it('separates the turn already seen from the one that was missed', () => {
    expect(isReplayOfProcessedResult(SEEN, SEEN)).toBe(true)
    expect(isReplayOfProcessedResult(SEEN, 'b2f0a1c4-0000-4000-8000-000000000002')).toBe(false)
  })
})

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

  it('a quiet stream on a turn the container is still running never touches the transport', async () => {
    // The reason quiet alone must not trigger recovery: long builds, test runs
    // and a session parked on a permission card are all silent for minutes. The
    // stream is unbuffered fan-out, so a swap loses whatever is emitted in the
    // close/open gap - permission requests included.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._setTurnSettled(false)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS * 10)

    expect(client.getSession).toHaveBeenCalledTimes(10)
    expect(client.subscribeToStream).toHaveBeenCalledTimes(1)
    expect(messagePersister.getSessionActivity(SESSION)).not.toBe('idle')
  })

  it('a container that cannot answer is not evidence the turn ended', async () => {
    messagePersister.markSessionActive(SESSION, AGENT)
    // A build older than turnSettled omits the field. Unknown is not "finished".
    ;(client.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ isRunning: true })

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS * 3)

    expect(client.subscribeToStream).toHaveBeenCalledTimes(1)
    expect(messagePersister.getSessionActivity(SESSION)).not.toBe('idle')
  })

  it('stream silence on a turn the container has finished reattaches and settles from replay', async () => {
    // Cause: half-open (or any lost terminal frames). Nothing detects the dead
    // peer; reattach is the recovery road close never reaches.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    // Idle never arrives.
    expect(client.subscribeToStream).toHaveBeenCalledTimes(1)
    client._setTurnSettled(true)

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
    // Container late-join replay for a finished turn (result + idle). The result
    // is one the host already processed, so it is dropped; the idle behind it
    // still settles, because a result WAS seen for this turn.
    client._sendMessage(resultFrame({ replayed: true }))
    client._sendMessage(sessionStateFrame('idle', { replayed: true }))

    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
  })

  it('a failed silence replacement is handled as the current connection closing', async () => {
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    client._failNextSubscribe()
    client._setTurnSettled(true)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    await Promise.resolve()
    await Promise.resolve()

    expect(client.subscribeToStream).toHaveBeenCalledTimes(3)
  })

  it('a replay of an already-finished turn never settles the turn waiting on it', async () => {
    // A send that wedges leaves the session marked active while the container
    // sits idle from the PREVIOUS turn. The probe finds a settled container,
    // reattaches, and the container replays that earlier turn's terminal
    // frames. Settling on them reports a completion - and persists a success -
    // for a message that never reached the agent.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    client._sendMessage(sessionStateFrame('idle'))
    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
    ;(notificationManager.triggerSessionComplete as ReturnType<typeof vi.fn>).mockClear()

    // Next turn: marked active, send never lands, container stays idle.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._setTurnSettled(true)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    // Replay of the PREVIOUS turn - same result uuid the host already processed.
    client._sendMessage(resultFrame({ replayed: true }))
    client._sendMessage(sessionStateFrame('idle', { replayed: true }))

    expect(messagePersister.getSessionActivity(SESSION)).not.toBe('idle')
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
  })

  it('a replay of a turn the host never saw end does settle it', async () => {
    // The mirror of the case above, so the guard cannot pass by rejecting every
    // replay: this is the genuine loss the recovery exists for.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    client._sendMessage(sessionStateFrame('idle'))

    messagePersister.markSessionActive(SESSION, AGENT)
    client._setTurnSettled(true)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    // This turn's own ending, never delivered live - a different result uuid.
    client._sendMessage(resultFrame({ replayed: true, uuid: 'b2f0a1c4-0000-4000-8000-000000000002' }))
    client._sendMessage(sessionStateFrame('idle', { replayed: true }))

    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
  })

  it('a container that accepts the probe but never answers keeps the probe running', async () => {
    // The half-open case this recovery exists for reaches the HTTP probe too.
    // If the next probe were only scheduled after the answer came back, a hang
    // would silently end the recovery for the rest of the session.
    messagePersister.markSessionActive(SESSION, AGENT)
    ;(client.getSession as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS * 4)

    expect(client.getSession).toHaveBeenCalledTimes(4)
  })

  it('a rejected replay does not strand the turn it was rejected for', async () => {
    // The counterpart to the guard above: dropping the stale result stops the
    // false completion, but leaves a turn nothing can settle. It must reach a
    // terminal state rather than sit active forever.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._sendMessage(capabilitiesFrame())
    client._sendMessage(resultFrame())
    client._sendMessage(sessionStateFrame('idle'))
    ;(notificationManager.triggerSessionComplete as ReturnType<typeof vi.fn>).mockClear()

    messagePersister.markSessionActive(SESSION, AGENT)
    client._setTurnSettled(true)

    // The container will replay this batch to every attach, in FIFO order. The
    // leading informational must not be mistaken for live traffic: doing so
    // clears the pending verdict, so each reattach triggers a replay that
    // resets the recovery and it never ends.
    client._armReplay([
      informationalFrame({ replayed: true }),
      resultFrame({ replayed: true }),
      sessionStateFrame('idle', { replayed: true }),
    ])

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS * 4)

    expect(messagePersister.isSessionActive(SESSION)).toBe(false)
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
  })

  it('a settled container with nothing left to replay is not reattached repeatedly', async () => {
    // A container-side process replacement clears the replay, so the reattach
    // has nothing to deliver. Repeating the swap would only re-run the frame
    // loss without learning anything new.
    messagePersister.markSessionActive(SESSION, AGENT)
    client._setTurnSettled(true)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    expect(client.subscribeToStream).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS * 5)

    expect(client.subscribeToStream).toHaveBeenCalledTimes(2)
    // Not a completion: nothing here proved the work succeeded.
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
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
    client._setTurnSettled(true)

    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_REATTACH_MS)
    expect(client.subscribeToStream).toHaveBeenCalledTimes(2)

    client._sendMessage(resultFrame({ replayed: true }))
    client._sendMessage(backgroundTasksFrame([], { replayed: true }))
    client._sendMessage(sessionStateFrame('idle', { replayed: true }))

    expect(messagePersister.getSessionActivity(SESSION)).toBe('idle')
  })
})
