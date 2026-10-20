/**
 * The background work a session's process holds open (`BackgroundTasks`,
 * through the session): backgrounded Bash commands, background subagents and
 * workflows, the SDK's level set, a stop that spares or drops them, and how
 * each keeps the session waiting until it settles.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'

const SESSION_ID = 'test-session-1'
const AGENT_SLUG = 'test-agent'

const live = attachLiveSessionsHarness()
const sessions = (slug: string = AGENT_SLUG) => live.sessions(slug)

let mockClient: StreamClient
let sseEvents: any[]
let sseCleanup: () => void

// One `user_request_created` per open request, carrying the registry
// envelope — the only request wire there is.
const requestCards = (kind: string) =>
  sseEvents.filter((e) => e.type === 'user_request_created' && e.request?.kind === kind)

beforeEach(async () => {
  mockClient = createStreamClient()
  await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)

  const sse = live.collect(AGENT_SLUG, SESSION_ID)
  sseEvents = sse.events
  sseCleanup = sse.stop
})

afterEach(() => {
  sseCleanup()
  sessions().unsubscribe(SESSION_ID)
  live.reset()
  vi.clearAllMocks()
})

// ============================================================================
// Stop that spares background tasks (the container kept the CLI process)
// ============================================================================

describe('stopping the turn while background tasks run', () => {
  function startBackgroundTask(taskId: string) {
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: taskId },
      message: { content: [{ type: 'tool_result', tool_use_id: `tool-${taskId}`, content: 'Running' }] },
    })
  }

  it('keeps background tasks and the session active when the process was kept', async () => {
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID, { processKept: true })

    expect(sessions().backgroundTasks(SESSION_ID).map((t) => t.taskId)).toEqual(['bg-1'])
    expect(sessions().isActive(SESSION_ID)).toBe(true)
    const waiting = sseEvents.filter((e) => e.type === 'session_waiting_background')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ interrupted: true, backgroundTaskCount: 1 })
    expect(waiting[0].backgroundTasks.map((t: { taskId: string }) => t.taskId)).toEqual(['bg-1'])
    expect(sseEvents.some((e) => e.type === 'session_idle')).toBe(false)
  })

  it('settles to idle when the process was kept but nothing runs in the background', async () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID, { processKept: true })

    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
    expect(sseEvents.some((e) => e.type === 'session_waiting_background')).toBe(false)
  })

  it('drops background tasks when the process was replaced', async () => {
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID)

    expect(sessions().backgroundTasks(SESSION_ID)).toEqual([])
    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
  })

  it('retires a spared task on its stopped notification after the stop', async () => {
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    sessions().markInterrupted(SESSION_ID, { processKept: true })
    sseEvents.length = 0

    // The CLI's answer to stop_task.
    mockClient.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bg-1',
      status: 'stopped',
      summary: 'Stopped by user',
    })

    expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'bg-1')).toHaveLength(1)
    expect(sessions().backgroundTasks(SESSION_ID)).toEqual([])
  })

  it('settles the session when the last spared task is stopped while the runtime is parked', async () => {
    // Seen on the real CLI: after stop_task it emits background_tasks_changed,
    // task_updated and task_notification(stopped) and nothing else — no
    // wake turn, no second idle.
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    mockClient.emit({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    sessions().markInterrupted(SESSION_ID, { processKept: true })
    expect(sessions().isActive(SESSION_ID)).toBe(true)
    sseEvents.length = 0

    vi.useFakeTimers()
    try {
      mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      mockClient.emit({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'killed' } })
      mockClient.emit({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'stopped', summary: '' })

      expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'bg-1')).toHaveLength(1)
      // Not yet: a stopped subagent's wake turn gets a moment to show up.
      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
      vi.advanceTimersByTime(1600)
    } finally {
      vi.useRealTimers()
    }

    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('leaves the settle to the runtime when the stopped task wakes the agent', async () => {
    // A stopped subagent still wakes the agent (running → result → idle);
    // settling first would flap the session idle → active → idle.
    sessions().markActive(SESSION_ID)
    startBackgroundTask('agent-1')
    mockClient.emit({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    sessions().markInterrupted(SESSION_ID, { processKept: true })
    sseEvents.length = 0

    vi.useFakeTimers()
    try {
      mockClient.emit({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'stopped', summary: '' })
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      vi.advanceTimersByTime(1600)
    } finally {
      vi.useRealTimers()
    }

    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
    expect(sessions().isActive(SESSION_ID)).toBe(true)
  })

  it('does not settle on a completed task — the runtime wakes the agent for it', async () => {
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    sseEvents.length = 0

    mockClient.emit({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed', summary: 'done' })

    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
    expect(sessions().isActive(SESSION_ID)).toBe(true)
  })

  it('treats a stopped task_updated as terminal too', async () => {
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bg-1',
      patch: { status: 'stopped' },
    })

    expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'bg-1')).toHaveLength(1)
  })

  it('skips the stopped turn’s stale content but lets the wake turn through', async () => {
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    sessions().markInterrupted(SESSION_ID, { processKept: true })
    sseEvents.length = 0

    const textDelta = () => mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late words' } },
    })

    // Still in the pipe from the aborted turn: dropped.
    textDelta()
    expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(false)

    // The task settles and the runtime wakes the agent for it.
    mockClient.emit({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    textDelta()

    expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(true)
    expect(sessions().isActive(SESSION_ID)).toBe(true)
  })

  const runtime = (state: 'idle' | 'running') =>
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state })
  const abortedResult = () =>
    mockClient.emit({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming' })
  const lateDelta = (text: string) =>
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

  it('leaves a wake turn alone when it started while the stop was in flight', async () => {
    sessions().markActive(SESSION_ID)
    runtime('running')
    startBackgroundTask('bg-1')
    const turnGenerationBefore = sessions().turnGeneration(SESSION_ID)

    // The container answers the interrupt only after the stopped turn's
    // result; in that window the last task settles and wakes the agent.
    abortedResult()
    runtime('idle')
    mockClient.emit({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
    runtime('running')
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID, { processKept: true, turnGenerationBefore })

    expect(sessions().isActive(SESSION_ID)).toBe(true)
    expect(sseEvents.some((e) => e.type === 'session_idle' || e.type === 'session_waiting_background')).toBe(false)
    lateDelta('the task finished')
    expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(true)
  })

  it('leaves a wake turn alone when the stop was a no-op between turns', async () => {
    // Parked on background work: the container has no turn to stop and
    // answers at once, but a task can still settle and wake the agent
    // before that answer is acted on. No result is involved at all.
    sessions().markActive(SESSION_ID)
    runtime('running')
    startBackgroundTask('bg-1')
    mockClient.emit({ type: 'result', subtype: 'success', is_error: false })
    runtime('idle')
    const turnGenerationBefore = sessions().turnGeneration(SESSION_ID)

    mockClient.emit({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
    runtime('running')
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID, { processKept: true, turnGenerationBefore })

    expect(sessions().isActive(SESSION_ID)).toBe(true)
    expect(sseEvents.some((e) => e.type === 'session_idle' || e.type === 'session_waiting_background')).toBe(false)
    lateDelta('the task finished')
    expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(true)
  })

  it('settles the stopped turn when the stop returns before its idle frame', async () => {
    // The aborted result is in, the idle that follows it is not yet: the
    // runtime still reads running, but no new turn has started.
    sessions().markActive(SESSION_ID)
    runtime('running')
    const turnGenerationBefore = sessions().turnGeneration(SESSION_ID)
    abortedResult()
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID, { processKept: true, turnGenerationBefore })

    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
  })

  it('does not mistake the stopped turn’s own late running frame for a new turn', async () => {
    // Stop pressed in the send → running window: the turn being stopped
    // announces itself only after the generation was read.
    sessions().markActive(SESSION_ID)
    const turnGenerationBefore = sessions().turnGeneration(SESSION_ID)
    runtime('running')
    abortedResult()
    runtime('idle')
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID, { processKept: true, turnGenerationBefore })

    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
  })

  it('still clears the stopped turn when the runtime has not moved on', async () => {
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    runtime('running')
    const turnGenerationBefore = sessions().turnGeneration(SESSION_ID)
    sseEvents.length = 0

    sessions().markInterrupted(SESSION_ID, { processKept: true, turnGenerationBefore })

    expect(sseEvents.filter((e) => e.type === 'session_waiting_background')).toHaveLength(1)
    lateDelta('late words')
    expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(false)
  })

  it('lets a spared background subagent raise an input request after the stop', async () => {
    sessions().markActive(SESSION_ID)
    for (const toolId of ['task-fg', 'task-bg']) {
      mockClient.emit({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name: 'Agent' } },
      })
      mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    }
    mockClient.emit({
      type: 'user',
      tool_use_result: { status: 'async_launched', agentId: 'agent-bg' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'task-bg', content: 'Launched' }] },
    })
    sessions().markInterrupted(SESSION_ID, { processKept: true })
    sseEvents.length = 0

    const browserInputFrom = (parentToolId: string, toolId: string) =>
      mockClient.emit({
        type: 'assistant',
        parent_tool_use_id: parentToolId,
        message: {
          content: [{
            type: 'tool_use',
            id: toolId,
            name: 'mcp__user-input__request_browser_input',
            input: { message: 'Log in to GitHub.', requirements: [] },
          }],
        },
      })

    // The foreground subagent died with the turn: its late frame is stale.
    browserInputFrom('task-fg', 'sub-fg-1')
    expect(requestCards('browser_input')).toHaveLength(0)
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)

    // The background one is still running and now needs the user.
    browserInputFrom('task-bg', 'sub-bg-1')
    const cards = requestCards('browser_input')
    expect(cards).toHaveLength(1)
    expect(cards[0].request.id).toBe('sub-bg-1')
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('tells a late-joining client whether the turn output ended or is still running alongside a task', async () => {
    // A task launched mid-turn does not make the session "waiting on
    // background work": the turn is still streaming. Only the turn's end
    // does, and the next turn (a send or a wake) undoes it.
    sessions().markActive(SESSION_ID)
    startBackgroundTask('bg-1')
    expect(sessions().isWaitingBackground(SESSION_ID)).toBe(false)

    mockClient.emit({ type: 'result', subtype: 'success', is_error: false })
    expect(sessions().isWaitingBackground(SESSION_ID)).toBe(true)

    runtime('running')
    expect(sessions().isWaitingBackground(SESSION_ID)).toBe(false)

    mockClient.emit({ type: 'result', subtype: 'success', is_error: false })
    expect(sessions().isWaitingBackground(SESSION_ID)).toBe(true)
    sessions().markActive(SESSION_ID)
    expect(sessions().isWaitingBackground(SESSION_ID)).toBe(false)

    // A soft stop that spares the task ends the turn the same way.
    sessions().markInterrupted(SESSION_ID, { processKept: true })
    expect(sessions().isWaitingBackground(SESSION_ID)).toBe(true)
  })

  it('keeps a background subagent but drops the foreground one', async () => {
    sessions().markActive(SESSION_ID)
    for (const toolId of ['task-fg', 'task-bg']) {
      mockClient.emit({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name: 'Agent' } },
      })
      mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    }
    // The background launch acknowledges immediately; the foreground one is
    // still running its blocking call.
    mockClient.emit({
      type: 'user',
      tool_use_result: { status: 'async_launched', agentId: 'agent-bg' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'task-bg', content: 'Launched' }] },
    })
    expect(sessions().backgroundTasks(SESSION_ID)).toMatchObject([{ taskId: 'agent-bg', isSubagent: true }])

    sessions().markInterrupted(SESSION_ID, { processKept: true })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    sseEvents.length = 0

    // The foreground subagent died with the turn: its late result is not a completion.
    mockClient.emit({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'task-fg', content: 'done' }] },
    })
    expect(sseEvents.filter((e) => e.type === 'subagent_completed')).toHaveLength(0)

    // The background subagent is still tracked and settles through its task signal.
    mockClient.emit({ type: 'system', subtype: 'task_updated', task_id: 'agent-bg', patch: { status: 'stopped' } })
    expect(sseEvents.filter((e) => e.type === 'subagent_completed')).toHaveLength(1)
    expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'agent-bg')).toHaveLength(1)
  })
})

// ============================================================================
// Background Bash task tracking
// ============================================================================

describe('background Bash task tracking', () => {
  it('detects backgroundTaskId from tool_use_result and broadcasts start event', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'abc123' },
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-bash-1',
          content: 'Command running in background with ID: abc123.',
        }],
      },
    })

    const startEvents = sseEvents.filter(e => e.type === 'background_task_started')
    expect(startEvents).toHaveLength(1)
    expect(startEvents[0].taskId).toBe('abc123')
    expect(startEvents[0].startedAt).toBeTypeOf('number')
  })

  it('keeps isActive true when result arrives with pending background tasks', () => {
    sessions().markActive(SESSION_ID)

    // Inject a background task
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running in background' }] },
    })

    // Agent turn ends
    mockClient.emit({
      type: 'result',
      subtype: 'success',
    })

    // Session should still be active
    expect(sessions().isActive(SESSION_ID)).toBe(true)
  })

  it('broadcasts session_waiting_background instead of session_idle when bg tasks pending', () => {
    sessions().markActive(SESSION_ID)

    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })

    sseEvents.length = 0

    mockClient.emit({
      type: 'result',
      subtype: 'success',
    })

    const waitingEvents = sseEvents.filter(e => e.type === 'session_waiting_background')
    expect(waitingEvents).toHaveLength(1)
    expect(waitingEvents[0].backgroundTaskCount).toBe(1)

    // Should NOT have session_idle
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
  })

  it('clears background task on system task-completion and goes idle', () => {
    sessions().markActive(SESSION_ID)

    // Start background task
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })

    // Agent turn ends (stays active due to bg task)
    mockClient.emit({
      type: 'result',
      subtype: 'success',
    })
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    sseEvents.length = 0

    // SDK delivers task completion as a system message with task_id and status
    mockClient.emit({
      type: 'system',
      subtype: 'task_completed',
      task_id: 'bg-1',
      tool_use_id: 'tool-1',
      status: 'completed',
      summary: 'Background command completed (exit code 0)',
    })

    const completedEvents = sseEvents.filter(e => e.type === 'background_task_completed')
    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0].taskId).toBe('bg-1')

    // Now when the next result arrives, session should go idle
    mockClient.emit({
      type: 'result',
      subtype: 'success',
    })

    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
  })

  it('clears background task on task_updated completed (busy-completion path) and goes idle', () => {
    // Regression: when a backgrounded task settles while the agent is still busy
    // (a foreground tool was in flight), the SDK delivers the completion as a
    // `task_updated` patch rather than a matching `task_notification`. The session
    // must clear it from that signal or the session stays pinned in
    // session_waiting_background forever. See background-bash-busy-completion fixture.
    sessions().markActive(SESSION_ID)

    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-busy' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })

    // Agent turn ends with the bg task still pending → stays active.
    mockClient.emit({ type: 'result', subtype: 'success' })
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    sseEvents.length = 0

    // Busy-path completion: a `task_updated` patch, NOT a `task_notification`.
    mockClient.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bg-busy',
      patch: { status: 'completed', end_time: Date.now() },
    })

    const completedEvents = sseEvents.filter(e => e.type === 'background_task_completed')
    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0].taskId).toBe('bg-busy')

    // Next result should now go idle rather than re-emit session_waiting_background.
    mockClient.emit({ type: 'result', subtype: 'success' })
    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
  })

  it('ignores task_updated for non-terminal status or untracked task', () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-x' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    sseEvents.length = 0

    // Non-terminal status → no clear.
    mockClient.emit({
      type: 'system', subtype: 'task_updated', task_id: 'bg-x', patch: { status: 'running' },
    })
    // Terminal status but unknown task id → no clear.
    mockClient.emit({
      type: 'system', subtype: 'task_updated', task_id: 'bg-unknown', patch: { status: 'completed' },
    })

    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-x')
  })

  it('session_state_changed idle keeps a still-running bg task tracked (no premature phantom-clear)', () => {
    // Regression (ac23bdd8): a backgrounded Bash command (task_type=local_bash) is
    // still running at turn-end. The SDK fires session_state_changed:idle at turn-end
    // ANYWAY — it re-fires 'running' + a terminal task signal when the command
    // actually finishes. The idle handler must NOT treat the still-running task as a
    // phantom: clearing it + finalizing here drops the indicator and un-gates
    // auto-sleep mid-job (the exact failure run_in_background prevents). It must keep
    // the task tracked, keep the session active, and surface waiting-on-background.
    // activeBackgroundTasks only ever holds local_bash tasks, and those always get a
    // later terminal signal — so the old "missed signal → phantom" premise never
    // holds. See the background-bash-premature-idle replay fixture (real capture).
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-running' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    // Turn ends with the task still tracked → session stays active (waiting).
    mockClient.emit({ type: 'result', subtype: 'success' })
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    sseEvents.length = 0

    // Turn-end idle arrives WHILE the bash is still running.
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    // Not cleared, not finalized — surfaced as waiting-on-background instead.
    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-running')
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    // The real terminal signal (task_updated{completed}) then clears it...
    sseEvents.length = 0
    mockClient.emit({
      type: 'system', subtype: 'task_updated', task_id: 'bg-running', patch: { status: 'completed' },
    })
    expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toContain('bg-running')
    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)

    // ...and the subsequent, truly-settled idle finalizes the session.
    sseEvents.length = 0
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('backstop: session_state_changed idle is a no-op with no pending tasks (no spurious idle)', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
  })

  it('sends the whole live list with every frame that changes it', () => {
    // Clients replace their copy with it, so a frame one of them missed
    // cannot leave a stale row (or Stop-dialog entry) behind.
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-2' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Running' }] },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1' }, { task_id: 'bg-2', task_type: 'local_bash', description: 'Watch the build' }],
    })
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-2' }] })

    const ids = (e: Record<string, unknown>) => (e.backgroundTasks as Array<{ taskId: string }>).map(t => t.taskId)
    const listFrames = sseEvents.filter(e =>
      ['background_task_started', 'background_task_updated', 'background_task_completed', 'session_waiting_background'].includes(e.type as string))
    expect(listFrames.map(e => [e.type, ids(e)])).toEqual([
      ['background_task_started', ['bg-1']],
      ['background_task_started', ['bg-1', 'bg-2']],
      ['background_task_updated', ['bg-1', 'bg-2']],
      // Once when the turn's output ends, again when the runtime reports idle.
      ['session_waiting_background', ['bg-1', 'bg-2']],
      ['session_waiting_background', ['bg-1', 'bg-2']],
      ['background_task_completed', ['bg-2']],
    ])
    expect(listFrames[2].backgroundTasks).toEqual([
      expect.objectContaining({ taskId: 'bg-1' }),
      expect.objectContaining({ taskId: 'bg-2', taskType: 'local_bash', description: 'Watch the build' }),
    ])
  })

  it('backstop: session_state_changed running does not clear pending tasks', () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-keep' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    sseEvents.length = 0
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-keep')
  })

  it('background_tasks_changed self-heals a task whose terminal signal never arrives', () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-lost' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    mockClient.emit({ type: 'result', subtype: 'success' })
    sseEvents.length = 0

    // The SDK's snapshot no longer lists the task — it finished, but the
    // per-task terminal signal is (in this scenario) lost. Without the
    // snapshot the task would pin the session in waiting-background forever.
    mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toEqual(['bg-lost'])
    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)

    // A late terminal signal for the already-cleared task no-ops.
    sseEvents.length = 0
    mockClient.emit({
      type: 'system', subtype: 'task_updated', task_id: 'bg-lost', patch: { status: 'completed' },
    })
    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)

    // The settled idle now finalizes.
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('background_tasks_changed announcing an unregistered task blocks idle (union gate)', () => {
    // The snapshot LEADS per-task signals: it can announce a task before the
    // registration metadata (task_started / tool-result) arrives. An idle in
    // that window must not finalize even though the incremental map is empty.
    sessions().markActive(SESSION_ID)
    // Mid-turn: the SDK announces the task (registration metadata not seen).
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-early', task_type: 'local_bash', description: 'Sleep' }],
    })
    mockClient.emit({ type: 'result', subtype: 'success' })
    sseEvents.length = 0

    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    const waiting = sseEvents.filter(e => e.type === 'session_waiting_background')
    expect(waiting).toHaveLength(1)
    expect(waiting[0].backgroundTaskCount).toBe(1)
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    // The task finishes: empty snapshot, then the settled idle finalizes.
    sseEvents.length = 0
    mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  // ------------------------------------------------------------------
  // Work no launch signal of ours registered. A background Bash command a
  // SUBAGENT launches returns its tool result on the sidechain, which
  // registers nothing — only the runtime's snapshot lists it. Seen in prod
  // (2026-09-09): a subagent started a local asset server that never
  // exited, and the session sat in waiting-background with an empty task
  // list and nothing to stop. The snapshot now registers every task it
  // lists, so the row, the Stop dialog entry and the per-task stop exist.
  describe('snapshot-only background work (subagent-launched tasks)', () => {
    // The runtime's snapshot is the full live set, so a launch alongside
    // other open work lists every id (the self-heal retires what it omits).
    function launchFromSubagent(taskId: string, liveTaskIds: string[] = [taskId]) {
      mockClient.emit({
        type: 'user',
        parent_tool_use_id: 'agent-tool-1',
        tool_use_result: { backgroundTaskId: taskId },
        message: { content: [{ type: 'tool_result', tool_use_id: `sub-tool-${taskId}`, content: 'Running' }] },
      })
      mockClient.emit({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: liveTaskIds.map((id) => ({ task_id: id, task_type: 'local_bash', description: 'Serve local assets' })),
      })
    }

    it('lists the task, labelled from the snapshot, while the session waits on it', () => {
      sessions().markActive(SESSION_ID)
      sseEvents.length = 0
      launchFromSubagent('nested-1')
      expect(sseEvents.filter(e => e.type === 'background_task_started')).toEqual([
        expect.objectContaining({ taskId: 'nested-1', taskType: 'local_bash', description: 'Serve local assets' }),
      ])

      // The subagent finishes; the lead's turn ends; the runtime reports idle.
      mockClient.emit({ type: 'result', subtype: 'success' })
      sseEvents.length = 0
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(1)
      expect(sessions().isWaitingBackground(SESSION_ID)).toBe(true)
      // What the UI (and the connected snapshot) get: the task, by name.
      expect(sessions().backgroundTasks(SESSION_ID)).toEqual([
        expect.objectContaining({ taskId: 'nested-1', taskType: 'local_bash', description: 'Serve local assets' }),
      ])
      expect(sessions().hasOnlyUntrackedBackgroundWork(SESSION_ID)).toBe(false)
    })

    it('lists it alongside a task the lead launched', () => {
      sessions().markActive(SESSION_ID)
      mockClient.emit({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-main' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      launchFromSubagent('nested-1', ['bg-main', 'nested-1'])

      expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toEqual(['bg-main', 'nested-1'])
    })

    it('merges the snapshot into a task a launch signal registered first, without a second start', () => {
      sessions().markActive(SESSION_ID)
      sseEvents.length = 0
      mockClient.emit({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-main' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      mockClient.emit({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-main', task_type: 'local_bash', description: 'Run the dev server' }],
      })
      // A repeat of the same level changes nothing and says nothing.
      mockClient.emit({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-main', task_type: 'local_bash', description: 'Run the dev server' }],
      })

      expect(sseEvents.filter(e => e.type === 'background_task_started').map(e => e.taskId)).toEqual(['bg-main'])
      expect(sseEvents.filter(e => e.type === 'background_task_updated')).toEqual([
        expect.objectContaining({ taskId: 'bg-main', taskType: 'local_bash', description: 'Run the dev server' }),
      ])
      expect(sessions().backgroundTasks(SESSION_ID)).toEqual([
        expect.objectContaining({ taskId: 'bg-main', description: 'Run the dev server' }),
      ])
    })

    it('keeps ambient tasks out of the client list, including when the flag flips', () => {
      // SDK >= 0.3.284 marks housekeeping tasks and live-update watchers
      // `ambient`: "hosts should exclude them from activity indicators".
      const level = (tasks: Array<{ task_id: string; ambient?: boolean }>) => mockClient.emit({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: tasks.map((t) => ({ task_type: 'local_bash', description: `Task ${t.task_id}`, ...t })),
      })
      const shown = () => sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)
      const frames = () => sseEvents
        .filter(e => typeof e.type === 'string' && e.type.startsWith('background_task_'))
        .map(e => [e.type, e.taskId])

      sessions().markActive(SESSION_ID)
      sseEvents.length = 0
      level([{ task_id: 'watcher', ambient: true }, { task_id: 'server' }])
      expect(shown()).toEqual(['server'])
      expect(frames()).toEqual([['background_task_started', 'server']])

      expect(sessions().hasOnlyUntrackedBackgroundWork(SESSION_ID)).toBe(false)

      // Still live work: the session waits on it rather than settling —
      // and with nothing left to show, a stop must escalate to reach it.
      mockClient.emit({ type: 'result', subtype: 'success' })
      level([{ task_id: 'watcher', ambient: true }])
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      expect(sessions().hasOnlyUntrackedBackgroundWork(SESSION_ID)).toBe(true)

      // Flips: to activity (the flag may simply be absent) and back.
      sseEvents.length = 0
      level([{ task_id: 'watcher' }])
      expect(shown()).toEqual(['watcher'])
      level([{ task_id: 'watcher', ambient: true }])
      expect(shown()).toEqual([])
      // Its end is not news to clients once it is ambient again.
      level([])
      expect(frames()).toEqual([
        ['background_task_started', 'watcher'],
        ['background_task_completed', 'watcher'],
      ])
    })

    it('clears once the task is stopped', () => {
      sessions().markActive(SESSION_ID)
      launchFromSubagent('nested-1')
      mockClient.emit({ type: 'result', subtype: 'success' })
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      // The per-task stop route's answer retires the id from both sides.
      sseEvents.length = 0
      mockClient.emit({
        type: 'system', subtype: 'task_notification', task_id: 'nested-1', tool_use_id: 'sub-tool-nested-1', status: 'stopped',
      })
      expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toEqual(['nested-1'])
      expect(sessions().backgroundTasks(SESSION_ID)).toEqual([])
    })

    it('a full stop settles the session', async () => {
      // markSessionInterrupted with processKept false is what a scope 'all'
      // stop produces: the snapshot is dropped and the session goes idle.
      sessions().markActive(SESSION_ID)
      launchFromSubagent('nested-1')
      mockClient.emit({ type: 'result', subtype: 'success' })
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      // The turn-scoped stop (process kept) spares the task...
      sseEvents.length = 0
      sessions().markInterrupted(SESSION_ID, { processKept: true })
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)

      // ...and the full stop settles it.
      sseEvents.length = 0
      sessions().markInterrupted(SESSION_ID, { processKept: false })
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    })
  })

  // ------------------------------------------------------------------
  // The level set must drain from BOTH directions. `background_tasks_changed`
  // is a level signal the SDK only re-emits on a membership CHANGE, and it
  // emits nothing at all when a fresh CLI process starts. So any id that
  // enters the snapshot and never leaves it pins the session in
  // waiting-background forever: every later session_state_changed:'idle'
  // takes the waiting branch instead of finalizing, and nothing — not a
  // terminal per-task signal, not Stop, not a re-subscribe — ever clears it.
  // These cover the three ways prod sessions got stuck that way.
  // ------------------------------------------------------------------

  // A background subagent as the wire delivers it: the SDK announces the
  // task (level + task_started), then the Agent tool's async-launch ack.
  function launchBackgroundAgent(agentId: string) {
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: agentId, task_type: 'local_agent', description: 'Verify policies' }],
    })
    mockClient.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: agentId,
      tool_use_id: `tool-${agentId}`,
      task_type: 'local_agent',
      description: 'Verify policies',
    })
    mockClient.emit({
      type: 'user',
      tool_use_result: { status: 'async_launched', isAsync: true, agentId },
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: `tool-${agentId}`,
          content: 'Async agent launched successfully.',
        }],
      },
    })
  }

  it('a failed task drains the snapshot when the removal frame never arrives', () => {
    // Mirror image of the self-heal test above: there the per-task terminal
    // signal was lost and the snapshot rescued the session; here the snapshot's
    // removal frame is the one that never comes. A task that ended outright
    // (stopped, failed, killed) retires from both sides on its own signal.
    sessions().markActive(SESSION_ID)
    launchBackgroundAgent('agent-bg-1')
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toEqual(['agent-bg-1'])

    // Turn ends while it runs → waiting, as designed.
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    sseEvents.length = 0

    // The subagent fails. Its terminal signal arrives; the removal snapshot does not.
    mockClient.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-bg-1',
      tool_use_id: 'tool-agent-bg-1',
      status: 'failed',
      summary: 'Agent failed',
    })
    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)

    // The wake turn's result + idle must now finalize the session.
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('a completed subagent the SDK still lists stays a tracked task until the snapshot drops it', () => {
    // Seen in prod (2026-09-29): a background subagent notified `completed`
    // ("stopped with background work of its own still running") while the
    // dev servers it started kept it a live task — the SDK kept listing it
    // and stop_task still found it. Retiring it on the notification removed
    // it from the rows and the Stop dialog while the snapshot kept the
    // session pinned "working" on nothing anyone could see.
    sessions().markActive(SESSION_ID)
    launchBackgroundAgent('agent-bg-1')
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    sseEvents.length = 0
    mockClient.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-bg-1',
      tool_use_id: 'tool-agent-bg-1',
      status: 'completed',
      summary: 'Agent finished; its dev server is still running',
    })

    // Its own turn is done — the subagent row completes — but the task stays
    // open, so the Stop dialog can still name it.
    expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(1)
    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toEqual(['agent-bg-1'])
    expect(sessions().hasOnlyUntrackedBackgroundWork(SESSION_ID)).toBe(false)

    // The wake turn ends with the task still live: still waiting.
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    // The SDK drops it when its background work ends; the session settles.
    sseEvents.length = 0
    mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toEqual(['agent-bg-1'])
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('a completed task the SDK no longer lists retires on its notification', () => {
    // The normal order: the snapshot drops the task, then the notification lands.
    sessions().markActive(SESSION_ID)
    launchBackgroundAgent('agent-bg-1')
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    sseEvents.length = 0
    mockClient.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-bg-1',
      tool_use_id: 'tool-agent-bg-1',
      status: 'completed',
    })
    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)
    expect(sessions().hasOnlyUntrackedBackgroundWork(SESSION_ID)).toBe(false)
  })

  it('Stop drains the snapshot so later turns still settle', () => {
    // The user hits Stop while a background task is live. The process is
    // replaced, so no terminal signal or removal snapshot will EVER arrive for
    // that id. If Stop clears only the incremental map, every subsequent turn
    // in the session ends in waiting-background instead of idle — the session
    // reads "Working…" at the end of every turn, permanently.
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-download' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-download', task_type: 'local_bash', description: 'yt-dlp' }],
    })

    sessions().markInterrupted(SESSION_ID)
    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)

    // A brand-new turn, with no background work at all.
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('process_restarted drops the snapshot from the dead process', () => {
    // The level set is per-process and a fresh CLI emits nothing at startup,
    // so ids from the previous process can never be retired by the SDK. The
    // container announces the replacement (idle eviction + --resume, crash,
    // MCP-injection restart) and the host must reset to the empty set.
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-doomed', task_type: 'local_bash', description: 'Sleep' }],
    })
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    // The CLI process is replaced; its background tasks died with it.
    mockClient.emit({ type: 'system', subtype: 'process_restarted' })

    sessions().markActive(SESSION_ID)
    sseEvents.length = 0
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('a capabilities handshake naming a new process instance drops the stale snapshot', () => {
    // The cold-resume path: the CLI is replaced while nothing is attached
    // (idle eviction + --resume, container restart), so the live
    // process_restarted broadcast reaches nobody — it fires before the
    // session is published and before the socket subscribes. The host state
    // survives that reconnect, so the handshake has to carry the process
    // identity and the host has to notice it changed.
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-1',
    })
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-orphan', task_type: 'local_bash', description: 'Sleep' }],
    })
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    // Reconnect after the process was replaced behind our back.
    mockClient.emit({
      type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-2',
    })

    sessions().markActive(SESSION_ID)
    sseEvents.length = 0
    mockClient.emit({ type: 'result', subtype: 'success' })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('a reattach to the SAME process instance keeps running tasks tracked', () => {
    // The other direction, and the reason this keys on identity rather than
    // "saw a handshake": an SSE/WebSocket reattach mid-job is the same live
    // CLI with the same tasks still running. Resetting there would drop the
    // indicator and un-gate auto-sleep on real work.
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-1',
    })
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-live' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-live', task_type: 'local_bash', description: 'yt-dlp' }],
    })
    mockClient.emit({ type: 'result', subtype: 'success' })

    sseEvents.length = 0
    // Transport reattach: same process, same handshake identity.
    mockClient.emit({
      type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-1',
    })

    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-live')

    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    expect(sessions().isActive(SESSION_ID)).toBe(true)
  })

  it('keeps process identity in sync across an interrupt-driven restart', () => {
    // The interrupt path restarts the query (claude-code.ts "Restarting query
    // after interrupt"), which mints a new process instance. But the host
    // drops every non-result frame while isInterrupted is set, so that
    // announcement was being swallowed — leaving the recorded identity one
    // process behind the container. The NEXT reattach then reads a changed
    // name and mistakes it for a restart, dropping background tasks that are
    // genuinely running: a live indicator lost and auto-sleep un-gated
    // mid-job, the exact failure the union gate exists to prevent.
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-A',
    })

    sessions().markInterrupted(SESSION_ID)
    // The container restarts the CLI in response, while we're still flagged
    // interrupted.
    mockClient.emit({
      type: 'system', subtype: 'process_restarted', process_instance: 'proc-B',
    })

    // New turn on the new process, with real background work.
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-live' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-live', task_type: 'local_bash', description: 'yt-dlp' }],
    })
    mockClient.emit({ type: 'result', subtype: 'success' })

    sseEvents.length = 0
    // A transport reattach. Same process as the one running bg-live, so
    // nothing may be dropped.
    mockClient.emit({
      type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-B',
    })

    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-live')

    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    expect(sessions().isActive(SESSION_ID)).toBe(true)
  })

  it('forwards command_lifecycle frames to SSE and drops malformed ones', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    mockClient.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' })
    mockClient.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'discarded' })
    // Unknown future states must flow through, not be filtered here.
    mockClient.emit({ type: 'command_lifecycle', command_uuid: 'u2', state: 'some_future_state' })
    // No uuid → nothing downstream can act; dropped.
    mockClient.emit({ type: 'command_lifecycle', state: 'discarded' })

    const forwarded = sseEvents.filter(e => e.type === 'command_lifecycle')
    expect(forwarded).toEqual([
      { type: 'command_lifecycle', commandUuid: 'u1', state: 'queued' },
      { type: 'command_lifecycle', commandUuid: 'u1', state: 'discarded' },
      { type: 'command_lifecycle', commandUuid: 'u2', state: 'some_future_state' },
    ])
    // The discarded message never ran: the host takes its mentions back.
    expect(live.host.sent('notification')).toEqual([
      { kind: 'message_discarded', agentSlug: AGENT_SLUG, sessionId: SESSION_ID, messageUuid: 'u1' },
    ])
  })

  it('ignores a malformed background_tasks_changed frame instead of clearing running tasks', () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-safe' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    sseEvents.length = 0

    // tasks is not an array / an element is missing task_id — acting on a
    // partial parse could clear a still-running task, so the frame must be
    // ignored outright.
    mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: 'garbage' })
    mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ nope: true }] })

    expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
    expect(sessions().backgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-safe')
  })

  it('tracks multiple concurrent background tasks', () => {
    sessions().markActive(SESSION_ID)

    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-2' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Running' }] },
    })

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(2)

    // Complete first task via system message
    mockClient.emit({
      type: 'system',
      subtype: 'task_completed',
      task_id: 'bg-1',
      status: 'completed',
    })

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)
    expect(sessions().backgroundTasks(SESSION_ID)[0].taskId).toBe('bg-2')
  })

  it('clears background tasks on session interrupt', async () => {
    sessions().markActive(SESSION_ID)

    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)

    sessions().markInterrupted(SESSION_ID)

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(0)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('does not duplicate background task on repeated tool_use_result', () => {
    sessions().markActive(SESSION_ID)

    // Same backgroundTaskId twice
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-dup' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })
    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-dup' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Running' }] },
    })

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)
  })

  it('preserves background tasks across re-subscribe', async () => {
    sessions().markActive(SESSION_ID)

    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-persist' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)

    // Re-subscribe (simulates reconnection)
    const newClient = createStreamClient()
    await sessions().subscribe(SESSION_ID, newClient, SESSION_ID)

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)
    expect(sessions().isActive(SESSION_ID)).toBe(true)

    // Clean up the new subscription
    sessions().unsubscribe(SESSION_ID)
  })

  it('returns empty array for unknown session', () => {
    expect(sessions().backgroundTasks('nonexistent')).toEqual([])
  })

  it('ignores system messages with task_id that do not match active bg tasks', () => {
    sessions().markActive(SESSION_ID)

    mockClient.emit({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-real' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)

    // System message with non-matching task_id
    mockClient.emit({
      type: 'system',
      subtype: 'task_completed',
      task_id: 'bg-nonexistent',
      status: 'completed',
    })

    // Should NOT have cleared our task
    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)
  })

  it('also detects snake_case background_task_id', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    mockClient.emit({
      type: 'user',
      tool_use_result: { background_task_id: 'snake-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
    })

    expect(sessions().backgroundTasks(SESSION_ID)).toHaveLength(1)
    expect(sessions().backgroundTasks(SESSION_ID)[0].taskId).toBe('snake-1')
  })
})
