/**
 * A session's turn as its live state runs it: how a turn starts and ends
 * (results, the runtime's idle, a stop, a lost connection), what it answered
 * and how it ended (the replayable turn outcome, the completion
 * notification), the summary entry's recency, and the activity label the
 * state projects.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client; what they hand the host (notifications, the
 * global feed) is read off the recording host port.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { StreamMessage } from '@shared/lib/container/types'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
  recordErrorProvider: vi.fn(() => Promise.resolve()),
}))
const mockRecordSessionActivity = vi.fn()
const mockRecordProvisionalSessionActivity = vi.fn((_store: unknown, _id: string, at: number) => ({
  recordedAtMs: at,
  previous: { mtimeMs: at - 60_000, size: 10 },
}))
const mockRevertSessionActivity = vi.fn()
vi.mock('@shared/lib/services/session-summary-cache', () => ({
  recordSessionActivity: (...args: unknown[]) => mockRecordSessionActivity(...args),
  recordProvisionalSessionActivity: (...args: unknown[]) =>
    mockRecordProvisionalSessionActivity(...(args as [unknown, string, number])),
  revertSessionActivity: (...args: unknown[]) => mockRevertSessionActivity(...args),
}))
const mockAppendInformationalEntry = vi.fn((..._args: unknown[]) => Promise.resolve())
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: (...args: unknown[]) => mockAppendInformationalEntry(...args),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'
import type { SessionNotification } from '../host-port'
import { getSessionMetadata, recordErrorProvider } from '@shared/lib/services/session-service'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'

const SESSION_ID = 'test-session-1'
const AGENT_SLUG = 'test-agent'

const live = attachLiveSessionsHarness()
const sessions = (slug: string = AGENT_SLUG) => live.sessions(slug)

let mockClient: StreamClient
let sseEvents: any[]
let sseCleanup: () => void

const openStreamRequestIds = () =>
  userInputRequestManager.getStoreIdsForSession(AGENT_SLUG, SESSION_ID, 'stream')

/** A whole stream message, with its own timestamp, on the client's stream. */
const deliver = (client: StreamClient, message: StreamMessage) =>
  vi.mocked(client.subscribeToStream).mock.calls.at(-1)![1](message)

type SessionComplete = Extract<SessionNotification, { kind: 'session_complete' }>
/** The completion notifications the sessions sent the host. */
const completions = () =>
  live.host.sent('notification').filter((n): n is SessionComplete => n.kind === 'session_complete')
/** This session's completion notification, with these fields. */
const completion = (fields: Pick<SessionComplete, 'responseText' | 'responseTranscriptEndOffset'>): SessionComplete =>
  ({ kind: 'session_complete', agentSlug: AGENT_SLUG, sessionId: SESSION_ID, ...fields })

// A turn's completion notification goes out once the transcript's end is
// known (an async stat); let that settle before asserting on it, either way.
const flushNotifications = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  live.runtime.unexpectedDeath.mockReset()
  vi.clearAllMocks()
})

describe('replayable turn outcomes', () => {
  const snapshot = () => sessions().turnOutcome(SESSION_ID)
  const emit = (content: Record<string, unknown>) => mockClient.emit(content)
  const result = () => emit({ type: 'result', subtype: 'success', num_turns: 1, usage: {} })
  const idle = () => emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  const text = (value: string) => emit({ type: 'assistant', message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: value }] } })

  it('retains streamed text when no complete assistant frame was delivered', () => {
    sessions().markActive(SESSION_ID)
    emit({ type: 'stream_event', event: { type: 'message_start' } })
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Invoice 42 was sent.' } } })
    result()
    expect(snapshot()).toMatchObject({ status: 'completed', responseText: 'Invoice 42 was sent.' })
  })

  it('records the existing idle decision and retains its text across reattachment', async () => {
    sessions().markActive(SESSION_ID)
    emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    text('Invoice 42 was sent.')
    result()
    expect(snapshot()).toBeNull()
    idle()
    const completed = snapshot()
    expect(completed).toMatchObject({ status: 'completed', responseText: 'Invoice 42 was sent.' })
    await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
    expect(snapshot()).toEqual(completed)
    idle()
    expect(snapshot()).toEqual(completed)
  })

  it('records cancellation without changing the activity of surviving background work', async () => {
    sessions().markActive(SESSION_ID)
    text('Partial work.')
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-task', task_type: 'local_bash' }] })
    sessions().markInterrupted(SESSION_ID, { processKept: true })
    expect(snapshot()).toMatchObject({ status: 'cancelled', responseText: 'Partial work.' })
    expect(sessions().isActive(SESSION_ID)).toBe(true)
    expect(sseEvents.findLast(e => e.type === 'session_waiting_background').turnOutcome.status).toBe('cancelled')
  })

  it('retains the latest partial side effect on an error before its assistant frame', () => {
    sessions().markActive(SESSION_ID)
    text('Preparing the invoice.')
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'partial' } } })
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Invoice 42 was sent.' } } })
    emit({ type: 'result', subtype: 'error_during_execution', errors: ['Receipt upload failed.'] })
    expect(snapshot()).toMatchObject({ status: 'failed', responseText: 'Invoice 42 was sent.' })
    idle()
    expect(snapshot()?.status).toBe('failed')
  })
})

describe('turn analytics', () => {
  const emit = (content: Record<string, unknown>) => mockClient.emit(content)
  const responses = () => live.host.sent('analytics').filter(e => e.event.startsWith('agent_response_'))

  it('records which credential served a completed turn', () => {
    sessions().recordRuntime(SESSION_ID, { provider: 'claude-subscription', modelContextWindows: {} })
    sessions().markActive(SESSION_ID)
    emit({ type: 'result', subtype: 'success', num_turns: 1, usage: {} })
    expect(responses()).toEqual([{
      event: 'agent_response_completed',
      properties: { agentSlug: AGENT_SLUG, session_id: SESSION_ID, credential_source: 'byo:claude-subscription' },
    }])
  })

  it('records a failed Platform turn with its terminal reason, and nothing for a stop', () => {
    sessions().recordRuntime(SESSION_ID, { provider: 'platform', modelContextWindows: {} })
    sessions().markActive(SESSION_ID)
    emit({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'Payment required' })
    sessions().markActive(SESSION_ID)
    emit({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })
    expect(responses()).toEqual([{
      event: 'agent_response_failed',
      properties: expect.objectContaining({
        agentSlug: AGENT_SLUG, session_id: SESSION_ID, credential_source: 'platform', terminal_reason: 'api_error',
      }),
    }])
  })
})

describe('turn boundaries are made by their emitters, not by the fan-out', () => {
  const emit = (content: Record<string, unknown>) => mockClient.emit(content)
  const askQuestion = (id: string) => {
    emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'AskUserQuestion' } } })
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify({ questions: [{ question: 'Which?' }] }) } } })
    emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
  }

  it('fans a broadcast boundary-shaped event out unchanged, touching no state', () => {
    sessions().markActive(SESSION_ID)
    askQuestion('q-open')
    expect(openStreamRequestIds()).toEqual(['q-open'])

    const idle = { type: 'session_idle', isActive: false, outcome: 'completed' }
    sessions().emit(SESSION_ID, idle)
    sessions().emit(SESSION_ID, { type: 'session_active', isActive: true })
    sessions().emit(SESSION_ID, { type: 'stream_delta', text: 'not the answer' })

    expect(sseEvents).toContainEqual(idle)
    expect(sessions().turnOutcome(SESSION_ID)).toBeNull()
    expect(openStreamRequestIds()).toEqual(['q-open'])
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('puts the requests a new message supersedes on the stream before its session_active', () => {
    sessions().markActive(SESSION_ID)
    askQuestion('q-superseded')
    sseEvents.length = 0

    // A queued message is a boundary for parked asks too.
    sessions().markActive(SESSION_ID)

    const types = sseEvents.map((e) => e.type)
    expect(types.indexOf('user_request_resolved')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('user_request_resolved')).toBeLessThan(types.indexOf('session_active'))
    expect(sseEvents.find((e) => e.type === 'user_request_resolved')).toMatchObject({
      requestId: 'q-superseded',
      outcome: 'superseded',
    })
    expect(openStreamRequestIds()).toEqual([])
  })

  it('puts the requests an ended turn cancels on the stream before its session_idle, which carries the outcome', () => {
    // The runtime owns idle, so the result alone does not end the turn.
    emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
    sessions().markActive(SESSION_ID)
    emit({ type: 'assistant', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
    askQuestion('q-cancelled')
    emit({ type: 'result', subtype: 'success', num_turns: 1, usage: {} })
    sseEvents.length = 0

    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    const types = sseEvents.map((e) => e.type)
    expect(types.indexOf('user_request_resolved')).toBeLessThan(types.indexOf('session_idle'))
    const idle = sseEvents.find((e) => e.type === 'session_idle')
    expect(idle.turnOutcome).toEqual(sessions().turnOutcome(SESSION_ID))
    expect(idle.turnOutcome).toMatchObject({ status: 'completed', responseText: 'Done.' })
  })

  it('starts the streamed reply context over at each response, and only at a new turn', () => {
    sessions().markActive(SESSION_ID)
    emit({ type: 'stream_event', event: { type: 'message_start' } })
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first ' } } })
    // A queued message joins the response in progress.
    sessions().markActive(SESSION_ID)
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'reply' } } })
    emit({ type: 'result', subtype: 'error_during_execution', errors: ['boom'] })
    expect(sessions().turnOutcome(SESSION_ID)).toMatchObject({
      status: 'failed',
      responseText: 'first reply',
    })
  })
})

describe('session summary activity', () => {
  it('records complete top-level transcript frames with their source timestamp', () => {
    const timestamp = new Date('2026-08-07T18:00:00.000Z')

    deliver(mockClient, {
      type: 'message',
      content: { type: 'assistant', message: { role: 'assistant', content: 'done' } },
      timestamp,
      sessionId: SESSION_ID,
    })

    expect(mockRecordSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, timestamp)
  })

  it('records the session as active the moment a message is sent to it', () => {
    // The CLI appends the user entry as the turn starts but the SDK never
    // echoes it, so without this the session would keep its old place in
    // every cache-backed list until the first complete assistant frame.
    vi.useFakeTimers({ now: new Date('2026-08-07T18:30:00.000Z') })
    try {
      sessions().markActive(SESSION_ID)
    } finally {
      vi.useRealTimers()
    }

    expect(mockRecordProvisionalSessionActivity).toHaveBeenCalledTimes(1)
    expect(mockRecordProvisionalSessionActivity).toHaveBeenCalledWith(
      expect.objectContaining({ slug: AGENT_SLUG }),
      SESSION_ID,
      Date.parse('2026-08-07T18:30:00.000Z'),
    )
  })

  it('re-marking an active session for a queued message records again', () => {
    sessions().markActive(SESSION_ID)
    sessions().markActive(SESSION_ID)

    expect(mockRecordProvisionalSessionActivity).toHaveBeenCalledTimes(2)
  })

  it('reverts the send record when the send is rolled back before reaching the container', () => {
    sessions().markActive(SESSION_ID)
    const mark = mockRecordProvisionalSessionActivity.mock.results[0]!.value

    sessions().markIdle(SESSION_ID)

    expect(mockRevertSessionActivity).toHaveBeenCalledTimes(1)
    expect(mockRevertSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, mark)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('does not revert once the container has answered the send', () => {
    sessions().markActive(SESSION_ID)
    deliver(mockClient, {
      type: 'message',
      content: { type: 'assistant', message: { role: 'assistant', content: 'working' } },
      timestamp: new Date('2026-08-07T18:31:00.000Z'),
      sessionId: SESSION_ID,
    })

    sessions().markIdle(SESSION_ID)

    expect(mockRevertSessionActivity).not.toHaveBeenCalled()
  })

  it('ignores replayed catch-up frames whose host timestamp is arrival time', () => {
    // On the wire, SDK result frames carry no timestamp field, so the host
    // stamps Date.now() at arrival — a reconnect replay recorded here would
    // fabricate recency for a session that did nothing.
    deliver(mockClient, {
      type: 'message',
      content: { type: 'result', subtype: 'success', replayed: true },
      timestamp: new Date('2026-08-07T17:00:00.000Z'),
      sessionId: SESSION_ID,
    })

    expect(mockRecordSessionActivity).not.toHaveBeenCalled()
  })

  it('refreshes a session that finished while detached from its transcript mtime, not the replay time', async () => {
    sessions().markActive(SESSION_ID)
    mockRecordSessionActivity.mockClear()
    const transcriptStat = vi.spyOn(live.store(AGENT_SLUG).files, 'stat')
      .mockResolvedValueOnce({ kind: 'file', mtimeMs: 1_754_600_000_000, size: 4096 })

    deliver(mockClient, {
      type: 'message',
      content: { type: 'result', subtype: 'success', replayed: true },
      timestamp: new Date('2026-08-07T20:00:00.000Z'),
      sessionId: SESSION_ID,
    })
    await vi.waitFor(() => expect(mockRecordSessionActivity).toHaveBeenCalled())

    expect(transcriptStat).toHaveBeenCalledWith(expect.stringContaining(`${SESSION_ID}.jsonl`))
    expect(mockRecordSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, 1_754_600_000_000)
  })

  it('does not attribute a sidechain transcript frame to the parent session', () => {
    deliver(mockClient, {
      type: 'message',
      content: { type: 'assistant', parent_tool_use_id: 'tool-1' },
      timestamp: new Date('2026-08-07T19:00:00.000Z'),
      sessionId: SESSION_ID,
    })

    expect(mockRecordSessionActivity).not.toHaveBeenCalled()
  })
})

describe('completion notification response selection', () => {
  it('passes only the newest merged textual assistant response at authoritative idle', async () => {
    vi.spyOn(live.store(AGENT_SLUG).files, 'stat').mockResolvedValueOnce({ kind: 'file', size: 12_345, mtimeMs: 0 })
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system',
      subtype: 'capabilities',
      session_state_events: true,
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'working-entry',
      message: {
        id: 'msg-working',
        content: [{ type: 'text', text: 'I am still working.' }],
      },
    })
    // A new late frame for that older message ID also merges into its
    // original UI bubble; arrival order must not make it the final answer.
    mockClient.emit({
      type: 'assistant',
      uuid: 'working-late-tool-entry',
      message: {
        id: 'msg-working',
        content: [
          { type: 'tool_use', id: 'tool-late', name: 'Read', input: {} },
        ],
      },
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'final-thinking-entry',
      message: {
        id: 'msg-final',
        content: [{ type: 'thinking', thinking: 'Hidden reasoning' }],
      },
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'final-text-entry-1',
      message: {
        id: 'msg-final',
        content: [{ type: 'text', text: 'Final ' }],
      },
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'final-tool-entry',
      message: {
        id: 'msg-final',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        ],
      },
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'final-text-entry-2',
      message: {
        id: 'msg-final',
        content: [{ type: 'text', text: 'answer.' }],
      },
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'working-late-after-final',
      message: {
        id: 'msg-working',
        content: [
          { type: 'tool_use', id: 'tool-latest', name: 'Read', input: {} },
        ],
      },
    })
    // Replaying an older group after the final group must not roll the
    // candidate backward either; transcript UUID dedupe is turn-wide.
    mockClient.emit({
      type: 'assistant',
      uuid: 'working-entry',
      replayed: true,
      message: {
        id: 'msg-working',
        content: [{ type: 'text', text: 'I am still working.' }],
      },
    })
    // A reattached CLI can replay a persisted frame verbatim. The UI
    // deduplicates by UUID, so the notification source must do the same.
    mockClient.emit({
      type: 'assistant',
      uuid: 'final-text-entry-2',
      replayed: true,
      message: {
        id: 'msg-final',
        content: [{ type: 'text', text: 'answer.' }],
      },
    })
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    await flushNotifications()
    expect(completions()).toEqual([])
    mockClient.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })

    await flushNotifications()
    const call = completions().at(-1)
    expect(call).toMatchObject({ sessionId: SESSION_ID, agentSlug: AGENT_SLUG })
    expect(call?.responseText).toBe('Final answer.')
    expect(call?.responseTranscriptEndOffset).toBe(12_345)
  })

  it('ignores the synthetic "No response requested." placeholder as a response candidate', async () => {
    vi.spyOn(live.store(AGENT_SLUG).files, 'stat').mockResolvedValueOnce({ kind: 'file', size: 12_345, mtimeMs: 0 })
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system',
      subtype: 'capabilities',
      session_state_events: true,
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'real-entry',
      message: {
        id: 'msg-real',
        content: [{ type: 'text', text: 'Real answer.' }],
      },
    })
    // The CLI's stand-in after an interrupt: a newer assistant message id,
    // but nothing the model said. It must not replace the real answer.
    mockClient.emit({
      type: 'assistant',
      uuid: 'synthetic-entry',
      isApiErrorMessage: false,
      message: {
        id: 'msg-synthetic',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    })
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })

    await flushNotifications()
    const call = completions().at(-1)
    expect(call?.responseText).toBe('Real answer.')
  })

  const finishTurn = () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'assistant',
      uuid: 'final-entry',
      message: {
        id: 'msg-final',
        content: [{ type: 'text', text: 'Finished.' }],
      },
    })
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  it('bounds the completion by where the transcript ended when the turn did', async () => {
    let resolveStat: ((value: { kind: 'file'; size: number; mtimeMs: number }) => void) | undefined
    vi.spyOn(live.store(AGENT_SLUG).files, 'stat').mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveStat = resolve
      }),
    )
    finishTurn()
    // Read at the turn's end; sent once known.
    await flushNotifications()
    expect(completions()).toEqual([])
    resolveStat?.({ kind: 'file', size: 99, mtimeMs: 0 })
    await vi.waitFor(() => expect(completions()).toHaveLength(1))
    expect(completions()[0]).toEqual(completion({ responseText: 'Finished.', responseTranscriptEndOffset: 99 }))
  })

  it('does not hold the completion for a transcript stat that never answers', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(live.store(AGENT_SLUG).files, 'stat').mockImplementationOnce(() => new Promise(() => {}))
      finishTurn()
      await vi.advanceTimersByTimeAsync(1000)
      expect(completions()).toContainEqual(completion({
        responseText: 'Finished.',
        responseTranscriptEndOffset: null,
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  describe('announces a session\'s turns in the order they ended, whichever transcript read finishes first', () => {
    const finishTurnWith = (answer: string, id: string) => {
      sessions().markActive(SESSION_ID)
      mockClient.emit({ type: 'assistant', uuid: `${id}-entry`, message: { id: `msg-${id}`, content: [{ type: 'text', text: answer }] } })
      mockClient.emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
    }
    let resolveFirst: ((value: { kind: 'file'; size: number; mtimeMs: number }) => void) | undefined
    beforeEach(() => {
      vi.spyOn(live.store(AGENT_SLUG).files, 'stat')
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirst = resolve
        }))
        .mockImplementationOnce(async () => ({ kind: 'file', size: 200, mtimeMs: 0 }))
    })
    const expectInTurnOrder = async () => {
      await flushNotifications()
      // The second turn's read is done, but the first turn has not been announced yet.
      expect(completions()).toEqual([])
      resolveFirst?.({ kind: 'file', size: 100, mtimeMs: 0 })
      await vi.waitFor(() => expect(completions()).toHaveLength(2))
      expect(completions()).toEqual([
        completion({ responseText: 'First answer.', responseTranscriptEndOffset: 100 }),
        completion({ responseText: 'Second answer.', responseTranscriptEndOffset: 200 }),
      ])
    }

    it('on one attachment', async () => {
      finishTurnWith('First answer.', 'first')
      finishTurnWith('Second answer.', 'second')
      await expectInTurnOrder()
    })

    it('across a reattach between the two turns', async () => {
      finishTurnWith('First answer.', 'first')
      await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      finishTurnWith('Second answer.', 'second')
      await expectInTurnOrder()
    })

    it('across the session being forgotten and created again between the two turns', async () => {
      finishTurnWith('First answer.', 'first')
      sessions().unsubscribe(SESSION_ID)
      await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      finishTurnWith('Second answer.', 'second')
      await expectInTurnOrder()
    })
  })

  it('does not reuse working text when the newest assistant item is tool-only', async () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'assistant',
      uuid: 'working-entry',
      message: {
        id: 'msg-working',
        content: [{ type: 'text', text: 'Earlier working note.' }],
      },
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'tool-only-entry',
      message: {
        id: 'msg-tool-only',
        content: [
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
        ],
      },
    })
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    await flushNotifications()
    expect(completions()).toContainEqual(completion({
      responseText: '',
      responseTranscriptEndOffset: null,
    }))
  })

  it('does not reuse the prior answer when a queued turn produces no assistant item', async () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system',
      subtype: 'capabilities',
      session_state_events: true,
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'turn-a-answer',
      message: {
        id: 'msg-turn-a',
        content: [{ type: 'text', text: 'Answer for the first request.' }],
      },
    })

    // The second request is queued before turn A's result. It then ends with
    // no assistant frame (for example, a prompt hook blocks it).
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    // A delayed frame for turn A must still merge into turn A in the UI; it
    // cannot resurrect A as turn B's notification response.
    mockClient.emit({
      type: 'assistant',
      uuid: 'turn-a-late-frame',
      message: {
        id: 'msg-turn-a',
        content: [{ type: 'text', text: 'Stale turn-A text.' }],
      },
    })
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })

    await flushNotifications()
    expect(completions()).toHaveLength(1)
    expect(completions()).toContainEqual(completion({ responseText: '', responseTranscriptEndOffset: null }))
  })

  it.each([
    {
      label: 'resume',
      result: {
        type: 'result',
        subtype: 'resume',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      label: 'graceful interrupt',
      result: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ])('does not consume the queued-turn guard on $label results', ({ result }) => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system',
      subtype: 'capabilities',
      session_state_events: true,
    })
    sessions().markActive(SESSION_ID)

    mockClient.emit(result)

    const { response } = (sessions() as any).states.get(SESSION_ID)
    expect(response.queuedTurns).toBe(1)
    expect(response.resetBeforeNextOutput).toBe(false)

    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    expect(response.queuedTurns).toBe(0)
    expect(response.resetBeforeNextOutput).toBe(true)
  })

  it('settles a self-healed running event followed by idle without a new result', async () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system',
      subtype: 'capabilities',
      session_state_events: true,
    })
    mockClient.emit({
      type: 'assistant',
      uuid: 'completed-answer',
      message: {
        id: 'msg-completed',
        content: [{ type: 'text', text: 'Completed.' }],
      },
    })
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })
    await flushNotifications()
    live.host.sends.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
    })
    mockClient.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })

    expect(sessions().isActive(SESSION_ID)).toBe(false)
    await flushNotifications()
    expect(completions()).toHaveLength(1)
    expect(completions()).toContainEqual(completion({ responseText: '', responseTranscriptEndOffset: null }))
  })

  it('does not notify for a modern success-subtype error result', async () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'system',
      subtype: 'capabilities',
      session_state_events: true,
    })
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      errors: ['provider failed'],
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    mockClient.emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })

    await flushNotifications()
    expect(completions()).toEqual([])
  })

  it('does not notify when a legacy turn exits for resume', async () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'assistant',
      uuid: 'resume-answer',
      message: {
        id: 'msg-resume',
        content: [{ type: 'text', text: 'Pausing for resume.' }],
      },
    })
    mockClient.emit({
      type: 'result',
      subtype: 'resume',
      is_error: false,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    await flushNotifications()
    expect(completions()).toEqual([])
  })
})

// ============================================================================
// Informational banners (hook feedback, e.g. UserPromptSubmit blocks)
// ============================================================================

describe('informational system messages', () => {
  it('persists a warning banner to the transcript and broadcasts messages_updated', async () => {
    mockClient.emit({
      type: 'system',
      subtype: 'informational',
      uuid: 'info-uuid-1',
      content: 'UserPromptSubmit operation blocked by hook:\nCircuit breaker\n\nOriginal prompt: hello',
      level: 'warning',
      prevent_continuation: true,
    })

    expect(mockAppendInformationalEntry).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, {
      uuid: 'info-uuid-1',
      content: 'UserPromptSubmit operation blocked by hook:\nCircuit breaker\n\nOriginal prompt: hello',
      level: 'warning',
    })
    await vi.waitFor(() => {
      expect(sseEvents).toContainEqual({ type: 'messages_updated' })
    })
  })

  it('persists a blocking banner even without a warning level', async () => {
    mockClient.emit({
      type: 'system',
      subtype: 'informational',
      uuid: 'info-uuid-2',
      content: 'Operation blocked by hook',
      prevent_continuation: true,
    })

    expect(mockAppendInformationalEntry).toHaveBeenCalledTimes(1)
  })

  it('ignores info-level chatter (non-blocking status lines)', () => {
    mockClient.emit({
      type: 'system',
      subtype: 'informational',
      uuid: 'info-uuid-3',
      content: 'Loaded 3 skills',
      level: 'info',
    })

    expect(mockAppendInformationalEntry).not.toHaveBeenCalled()
    expect(sseEvents).not.toContainEqual({ type: 'messages_updated' })
  })

  it('ignores warning banners with no content', () => {
    mockClient.emit({
      type: 'system',
      subtype: 'informational',
      uuid: 'info-uuid-4',
      level: 'warning',
    })

    expect(mockAppendInformationalEntry).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Late-join replay (turn ended before the WebSocket attached)
// ============================================================================

describe('late-join replayed frames', () => {
  const sendCapabilities = () =>
    mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })

  it('settles a session whose blocked first turn ended before the socket attached', async () => {
    // The wedge signature: the route marked the session active, but no live
    // turn frames ever arrived (they fired into the WS attach gap).
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0
    sendCapabilities()

    mockClient.emit({
      type: 'system',
      subtype: 'informational',
      uuid: 'replay-info-1',
      content: 'Operation stopped by hook: no hey allowed',
      level: 'warning',
      prevent_continuation: true,
      replayed: true,
    })
    mockClient.emit({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 20, num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      replayed: true,
    })
    mockClient.emit({
      type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true,
    })

    expect(mockAppendInformationalEntry).toHaveBeenCalledTimes(1)
    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.some((e) => e.type === 'session_idle')).toBe(true)
  })

  it.each([
    { isChatIntegrationSession: true },
    { isScheduledExecution: true },
    { isWebhookExecution: true },
    { invokedByAgentSlug: 'caller' },
  ])('finishes attachment before releasing a missed completed turn (%j)', async (metadata) => {
    sessions().markActive(SESSION_ID)
    vi.mocked(getSessionMetadata).mockResolvedValue(metadata as never)
    const subscribe = vi.mocked(mockClient.subscribeToStream).getMockImplementation()!
    let finishReplay!: () => void
    let release!: ReturnType<typeof vi.fn<() => void>>
    vi.mocked(mockClient.subscribeToStream).mockImplementationOnce((...args) => {
      const stream = subscribe(...args)
      release = vi.fn(stream.unsubscribe)
      return { unsubscribe: release, ready: new Promise<void>(resolve => { finishReplay = resolve }) }
    })
    const subscription = sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      sendCapabilities()
      mockClient.emit({ type: 'result', subtype: 'success', is_error: false, replayed: true })
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true })
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      // Still attaching: the stream is held until the attach is done.
      expect(release).not.toHaveBeenCalled()
      finishReplay()
      await subscription
      expect(release).toHaveBeenCalled()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
    } finally {
      finishReplay()
      await subscription
      vi.mocked(getSessionMetadata).mockResolvedValue(null)
    }
  })

  it('ignores replayed frames when the live copies were already processed', () => {
    // A full live turn settles the session…
    sessions().markActive(SESSION_ID)
    sendCapabilities()
    mockClient.emit({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(sessions().isActive(SESSION_ID)).toBe(false)
    sseEvents.length = 0
    vi.clearAllMocks()

    // …then a reconnect replays the same terminal frames: all ignored.
    mockClient.emit({
      type: 'system', subtype: 'informational', uuid: 'replay-info-2',
      content: 'Operation stopped by hook: x', level: 'warning', replayed: true,
    })
    mockClient.emit({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 20, num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      replayed: true,
    })
    mockClient.emit({
      type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true,
    })

    expect(mockAppendInformationalEntry).not.toHaveBeenCalled()
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
    expect(sseEvents.filter((e) => e.type === 'turn_output_complete')).toHaveLength(0)
  })
})

describe('markIdle', () => {
  it('flips an active session back to idle and broadcasts session_idle', () => {
    sessions().markActive(SESSION_ID)
    expect(sessions().isActive(SESSION_ID)).toBe(true)
    sseEvents.length = 0

    sessions().markIdle(SESSION_ID)

    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
  })

  it('is a no-op on an already-idle session', () => {
    sseEvents.length = 0

    sessions().markIdle(SESSION_ID)

    expect(sseEvents).toHaveLength(0)
  })
})

// ============================================================================
// getSessionActivity
// ============================================================================

describe('activity', () => {
  it('projects the streaming-state flags onto an activity label', () => {
    // helper sets the three lifecycle flags on the session's live state
    const setFlags = (a: boolean, aw: boolean, s: boolean) => {
      const st = (sessions() as any).states.get(SESSION_ID)
      st.isActive = a; st.isAwaitingInput = aw; st.stream.isStreaming = s
    }
    sessions().markActive(SESSION_ID) // ensures a state exists

    setFlags(true, false, false);  expect(sessions().activity(SESSION_ID)).toBe('working')   // nothing more specific
    setFlags(true, false, true);   expect(sessions().activity(SESSION_ID)).toBe('streaming') // assistant text owns the surface
    setFlags(true, true, false);   expect(sessions().activity(SESSION_ID)).toBe('awaiting')  // waiting on the user
    setFlags(false, false, false); expect(sessions().activity(SESSION_ID)).toBe('idle')      // not active
  })

  it('honors the busy precedence (compacting > retrying > thinking > streaming), even with isStreaming set', () => {
    // isStreaming stale-true throughout (the api_retry-mid-stream case): the busy
    // states must still win, so chat shows "Compacting…/Retrying…/Thinking…" like the
    // app rather than dishonestly yielding to 'streaming'. As each clears, the next
    // down the ladder shows, and once all clear, streamed text owns the surface.
    sessions().markActive(SESSION_ID)
    const st = (sessions() as any).states.get(SESSION_ID)
    st.isActive = true; st.isAwaitingInput = false; st.stream.currentToolUse = null
    st.stream.isStreaming = true

    st.stream.isCompacting = true; st.stream.isRetrying = true; st.stream.isThinking = true
    expect(sessions().activity(SESSION_ID)).toBe('compacting')
    st.stream.isCompacting = false
    expect(sessions().activity(SESSION_ID)).toBe('retrying')
    st.stream.isRetrying = false
    expect(sessions().activity(SESSION_ID)).toBe('thinking')
    st.stream.isThinking = false
    expect(sessions().activity(SESSION_ID)).toBe('streaming')
  })

  it('a new turn (markSessionActive) clears a stale isCompacting/currentThinking from an abnormally-ended prior turn', () => {
    // The desktop app resets these on session_active/idle/error; chat must too, or a
    // turn that ended mid-compaction (error/interrupt before the compact summary)
    // wedges the next turn's label to "Compacting…". The state object is reused across turns.
    sessions().markActive(SESSION_ID)
    const st = (sessions() as any).states.get(SESSION_ID)
    st.isActive = false; st.stream.isCompacting = true; st.stream.isThinking = true; st.stream.isRetrying = true

    sessions().markActive(SESSION_ID) // next user message
    expect(st.stream.isCompacting).toBe(false)
    expect(st.stream.isThinking).toBe(false)
    expect(st.stream.isRetrying).toBe(false)
    expect(sessions().activity(SESSION_ID)).toBe('working')
  })

  it('keeps a running turn intact when a queued message re-marks an ALREADY-active session', () => {
    // Queueing a message mid-turn accepts it into the RUNNING turn — it is not a
    // turn boundary, so everything that turn is still doing survives. Driven with
    // the real frames, since the bug was that markSessionActive wiped exactly the
    // state those frames had just established. (SUP-736)
    sessions().markActive(SESSION_ID)
    mockClient.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    })
    mockClient.emit({
      type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, session_id: SESSION_ID, uuid: 'r1',
    })
    mockClient.emit({
      type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION_ID, uuid: 's1',
    })
    expect(sessions().activity(SESSION_ID)).toBe('compacting')
    sseEvents.length = 0

    sessions().markActive(SESSION_ID) // queued mid-turn

    // The app is told which of the two meanings this session_active carries.
    expect(sseEvents.find(e => e.type === 'session_active')).toMatchObject({ queuedMidTurn: true })
    // Chat's label walks back down the real ladder as each state ends, instead of
    // dropping straight to "Working…" the moment the message was queued.
    const st = (sessions() as any).states.get(SESSION_ID)
    expect(sessions().activity(SESSION_ID)).toBe('compacting')
    st.stream.isCompacting = false
    expect(sessions().activity(SESSION_ID)).toBe('retrying')
    st.stream.isRetrying = false
    expect(sessions().activity(SESSION_ID)).toBe('thinking')

    // And the open thinking block still closes under the id the app opened it
    // with — a nulled message id/block index would have re-keyed it to undefined.
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    expect(sseEvents.find(e => e.type === 'thinking_stop')).toMatchObject({ thinkingId: 'msg_1:0' })
  })

  it('is idle for an unknown session', () => {
    expect(sessions().activity('nope')).toBe('idle')
  })
})

// ============================================================================
// API error code tracking (apiErrorCode in session_error)
// ============================================================================

describe('API error code tracking', () => {
  it('captures error code from assistant message and includes it in session_error', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    // SDK sends assistant message with error field (e.g., auth failure)
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Invalid API key' }] },
      error: 'authentication_failed',
    })

    // SDK sends error result
    mockClient.emit({
      type: 'result',
      subtype: 'error_during_execution',
      error: 'Invalid API key',
      errors: ['Invalid API key'],
      is_error: true,
      duration_ms: 100,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const errorEvents = sseEvents.filter(e => e.type === 'session_error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].apiErrorCode).toBe('authentication_failed')
    expect(errorEvents[0].error).toBe('Invalid API key')
  })

  it('classifies a success-subtype result with is_error as an error turn (modern shape)', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    // The modern SDK dead-turn shape: subtype stays 'success', the error is
    // signaled via is_error + terminal_reason, and the human-readable
    // explanation lives in `result` (see sdk206-error-turn-invalid-model).
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 404,
      result: 'The selected model does not exist.',
      duration_ms: 100,
      num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const errorEvents = sseEvents.filter(e => e.type === 'session_error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].error).toBe('The selected model does not exist.')
    expect(errorEvents[0].terminalReason).toBe('api_error')
    expect(errorEvents[0].apiErrorStatus).toBe(404)
    expect(errorEvents[0].apiErrorCode).toBeNull()
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('broadcasts session_error with null apiErrorCode when no assistant error preceded', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    // Error result without a preceding assistant message error
    mockClient.emit({
      type: 'result',
      subtype: 'error',
      error: 'The agent process was terminated unexpectedly.',
      is_error: true,
      duration_ms: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const errorEvents = sseEvents.filter(e => e.type === 'session_error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].apiErrorCode).toBeNull()
  })

  it('clears lastApiErrorCode on new user message', () => {
    sessions().markActive(SESSION_ID)

    // First turn: assistant with error
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Rate limited' }] },
      error: 'rate_limit',
    })
    mockClient.emit({
      type: 'result',
      subtype: 'error_during_execution',
      error: 'Rate limited',
      errors: ['Rate limited'],
      is_error: true,
      duration_ms: 100,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    // New user message clears the error code
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    // Second turn: different error without assistant error field
    mockClient.emit({
      type: 'result',
      subtype: 'error',
      error: 'Process killed',
      is_error: true,
      duration_ms: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const errorEvents = sseEvents.filter(e => e.type === 'session_error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].apiErrorCode).toBeNull()
  })

  it('broadcasts stream_api_error when text was already streaming', () => {
    sessions().markActive(SESSION_ID)

    // Simulate SDK streaming text before the error
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Some text' } },
    })
    sseEvents.length = 0

    // Complete assistant message with error
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Some text' }] },
      error: 'rate_limit',
    })

    const apiErrorEvents = sseEvents.filter(e => e.type === 'stream_api_error')
    expect(apiErrorEvents).toHaveLength(1)
    expect(apiErrorEvents[0].apiErrorCode).toBe('rate_limit')
    // Should NOT broadcast a stream_delta (to avoid duplicating text)
    const deltas = sseEvents.filter(e => e.type === 'stream_delta')
    expect(deltas).toHaveLength(0)
  })

  it('broadcasts stream_delta when a finished answer never streamed', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    mockClient.emit({
      type: 'assistant',
      uuid: 'answer-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'check the inbox' },
          { type: 'text', text: 'Yes — got your email.' },
        ],
      },
    })

    const deltas = sseEvents.filter(e => e.type === 'stream_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe('Yes — got your email.')
  })

  it('does not repeat stream_delta when the answer already streamed', () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Yes — got your email.' } },
    })
    sseEvents.length = 0

    mockClient.emit({
      type: 'assistant',
      uuid: 'answer-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Yes — got your email.' }] },
    })

    expect(sseEvents.filter(e => e.type === 'stream_delta')).toHaveLength(0)
  })

  it('records which provider produced an API error message', () => {
    sessions().recordRuntime(SESSION_ID, { provider: 'platform', modelContextWindows: {} })
    sessions().markActive(SESSION_ID)

    mockClient.emit({
      type: 'assistant',
      uuid: 'error-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 402 {"error":"insufficient_balance"}' }] },
      error: 'billing_error',
    })

    expect(recordErrorProvider).toHaveBeenCalledExactlyOnceWith(expect.anything(), SESSION_ID, 'error-1', 'platform')
  })

  it('broadcasts stream_delta with apiErrorCode when no text was streaming', () => {
    sessions().markActive(SESSION_ID)
    sseEvents.length = 0

    // Complete assistant message with error (no prior streaming)
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Invalid API key' }] },
      error: 'authentication_failed',
    })

    const deltas = sseEvents.filter(e => e.type === 'stream_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe('Invalid API key')
    expect(deltas[0].apiErrorCode).toBe('authentication_failed')
    // Should NOT broadcast stream_api_error
    const apiErrorEvents = sseEvents.filter(e => e.type === 'stream_api_error')
    expect(apiErrorEvents).toHaveLength(0)
  })
})

// ============================================================================
// waitForIdle — sync x-agent invoke race protection
// ============================================================================

describe('waitForIdle', () => {
  const WAIT_SESSION = 'wait-session'

  afterEach(() => {
    sessions().unsubscribe(WAIT_SESSION)
  })

  it('resolves at once for a session with no state', async () => {
    await expect(sessions().waitForIdle(WAIT_SESSION)).resolves.toBe('idle')
  })

  it('answers timeout when an active session never goes idle', async () => {
    // Data, not an error class: the x-agent routes promote a sync invoke to
    // async on it, and an error's class does not survive a transport.
    sessions().markActive(WAIT_SESSION)
    expect(await sessions().waitForIdle(WAIT_SESSION, { timeoutMs: 200 })).toBe('timeout')
  })

  it('resolves once an active session goes idle (and preserves isActive across subscribe)', async () => {
    // Mirror the x-agent sync-invoke pattern: markSessionActive *before* subscribe
    sessions().markActive(WAIT_SESSION)
    const client = createStreamClient()
    await sessions().subscribe(WAIT_SESSION, client, WAIT_SESSION)
    // Without preservation, isActive would have been wiped here and waitForIdle
    // would resolve at once instead of waiting for the result event.
    expect(sessions().isActive(WAIT_SESSION)).toBe(true)

    const promise = sessions().waitForIdle(WAIT_SESSION)
    setTimeout(() => client.emit({ type: 'result', subtype: 'success' }), 50)
    await expect(promise).resolves.toBe('idle')
  })
})

// ============================================================================
// session_activity emission
// ============================================================================

describe('activity projection (pull)', () => {
  // The sessions no longer push session_activity (deleted with the push
  // machinery in the pull-projection refactor); activity() is the sole
  // source of truth and must never broadcast a session_activity SSE event.
  it('does not broadcast session_activity on markSessionActive', () => {
    sessions().markActive(SESSION_ID)
    expect(sseEvents.filter((e) => e.type === 'session_activity')).toHaveLength(0)
    expect(sessions().activity(SESSION_ID)).toBe('working')
  })

  // Iddo (review): message_start must NOT optimistically project 'streaming' before
  // the first content block's type is known. A message that opens directly with a
  // tool call (no preamble text) would otherwise flip streaming→working here, and
  // reconcileIndicator turns that non-busy→busy flip into stopWorking()+startWorking()
  // — Slack removes+re-adds its reaction and iMessage blinks the typing bubble, once
  // per tool-first assistant message in an agentic turn. 'streaming' is deferred to the
  // first text token instead.
  it('keeps a tool-first message on "working" without flipping through "streaming"', () => {
    sessions().markActive(SESSION_ID) // active → 'working'

    mockClient.emit({ type: 'stream_event', event: { type: 'message_start' } })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
    })

    expect(sessions().activity(SESSION_ID)).toBe('working')
  })

  it('projects "streaming" only when real text starts (first text_delta), not at message_start', () => {
    sessions().markActive(SESSION_ID) // active → 'working'
    mockClient.emit({ type: 'stream_event', event: { type: 'message_start' } })
    // No content yet: the agent is honestly 'working', not optimistically 'streaming'.
    expect(sessions().activity(SESSION_ID)).toBe('working')

    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    })
    // The first token yields the reply surface to the streamed text.
    expect(sessions().activity(SESSION_ID)).toBe('streaming')
  })

  // Regression: a mid-stream error must NOT emit a spurious busy activity right
  // before settling. The terminal transition has to settle in a SINGLE non-busy
  // emit reflecting the final state — an intermediate "isActive still true,
  // streaming just cleared" snapshot would briefly read 'working' and race
  // connectors (Slack's async reaction add/remove) into a stuck indicator.
  it('broadcasts no session_activity and settles to idle on a mid-stream error result', () => {
    sessions().markActive(SESSION_ID) // active → 'working'
    mockClient.emit({ type: 'stream_event', event: { type: 'message_start' } })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }) // → 'streaming'

    mockClient.emit({ type: 'result', subtype: 'error', error: 'boom' })

    expect(sseEvents.filter(e => e.type === 'session_activity')).toHaveLength(0)
    expect(sessions().activity(SESSION_ID)).toBe('idle')
  })

  // Same invariant for the connection-closed → markSessionInactive terminal
  // path: finalizeIdle's single non-busy emit covers the settle; clearing
  // streaming/awaiting must not emit a busy activity first.
  it('broadcasts no session_activity and settles to idle when markSessionInactive finalizes a streaming session', async () => {
    sessions().markActive(SESSION_ID) // active → 'working'
    mockClient.emit({ type: 'stream_event', event: { type: 'message_start' } })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }) // → 'streaming'

    // A socket that drops mid-turn is the runtime's to recover. This one
    // cannot, so it settles what it claimed: markInactive's terminal path.
    live.runtime.unexpectedDeath.mockImplementation((sessionId) => {
      sessions().settleRecovering(sessions().claimMidTurnForRecovery(sessionId === undefined ? undefined : [sessionId]))
    })
    mockClient.emit({ type: 'connection_closed' })
    await new Promise((r) => setTimeout(r, 0))

    expect(sseEvents.filter(e => e.type === 'session_activity')).toHaveLength(0)
    expect(sessions().activity(SESSION_ID)).toBe('idle')
  })
})
