/**
 * Automated sessions (cron, webhook, chat, x-agent) as their live sessions
 * treat them: promotion to interactive when one starts waiting on the user,
 * and the automation's outcome written to its metadata once it settles.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client; the session metadata is a mocked service, and
 * the global feed is read off the recording host port.
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
import { finalizeAutomationStatus, getSessionMetadata, updateSessionMetadata } from '@shared/lib/services/session-service'

const SESSION_ID = 'test-session-1'
const AGENT_SLUG = 'test-agent'

const live = attachLiveSessionsHarness()
const sessions = (slug: string = AGENT_SLUG) => live.sessions(slug)

let mockClient: StreamClient

/** The global feed from now on, as a subscriber that joined now would see it. */
function collectGlobalEvents(): () => any[] {
  const start = live.host.sends.length
  return () => live.host.sends.slice(start).filter(([name]) => name === 'global').map(([, event]) => event)
}

beforeEach(async () => {
  mockClient = createStreamClient()
  await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
})

afterEach(() => {
  sessions().unsubscribe(SESSION_ID)
  live.reset()
  vi.clearAllMocks()
})

// ============================================================================
// Automated session promotion
// ============================================================================

describe('automated session promotion', () => {
  beforeEach(() => {
    // Promotion fires on the awaiting rising edge, which requires an active
    // turn — as in production, where the automated send marks active first.
    sessions().markActive(SESSION_ID)
  })

  function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: toolName },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  it('promotes a scheduled session when user input is requested', async () => {
    vi.mocked(getSessionMetadata).mockResolvedValueOnce({
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
    })

    simulateToolUse('AskUserQuestion', 'tool-1', {
      questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
    })

    // Let the async promotion complete
    await vi.waitFor(() => {
      expect(updateSessionMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        { promotedToInteractive: true },
      )
    })
  })

  it('promotes a webhook session when user input is requested', async () => {
    vi.mocked(getSessionMetadata).mockResolvedValueOnce({
      isWebhookExecution: true,
      webhookTriggerId: 'trigger-1',
    })

    simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
      secretName: 'API_KEY',
      reason: 'Need it',
    })

    await vi.waitFor(() => {
      expect(updateSessionMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        { promotedToInteractive: true },
      )
    })
  })

  it('promotes a chat integration session when user input is requested', async () => {
    vi.mocked(getSessionMetadata).mockResolvedValueOnce({
      isChatIntegrationSession: true,
      chatIntegrationId: 'chat-1',
    })

    simulateToolUse('mcp__user-input__request_file', 'tool-1', {
      description: 'Upload a file',
    })

    await vi.waitFor(() => {
      expect(updateSessionMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        { promotedToInteractive: true },
      )
    })
  })

  it('promotes an x-agent session when user input is requested', async () => {
    vi.mocked(getSessionMetadata).mockResolvedValueOnce({
      invokedByAgentSlug: 'caller-agent',
    })

    simulateToolUse('AskUserQuestion', 'tool-1', {
      questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
    })

    await vi.waitFor(() => {
      expect(updateSessionMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        { promotedToInteractive: true },
      )
    })
  })

  // Args-keyed metadata mock for the two broadcast tests below. A
  // mockResolvedValueOnce is consumed by ANY caller — this suite has
  // fire-and-forget promotes still in flight from earlier tests (CI's
  // slower interleaving even surfaced one carrying TRANSPOSED ids), and a
  // stray both eats a queued Once and pollutes an unfiltered event capture.
  // Keying on the exact (agentSlug, sessionId) pair keeps strays on the
  // null path. mockImplementation survives clearAllMocks, so restore the
  // suite default afterwards.
  function withHiddenScheduledMetadata(agentSlug: string, sessionId: string): () => void {
    vi.mocked(getSessionMetadata).mockImplementation((store, id) =>
      Promise.resolve(
        store.slug === agentSlug && id === sessionId
          ? ({ isScheduledExecution: true, scheduledTaskId: 'task-1' } as never)
          : null,
      ),
    )
    return () => {
      vi.mocked(getSessionMetadata).mockImplementation(() => Promise.resolve(null))
    }
  }

  it('a direct promote of a non-awaiting session broadcasts session_updated, not an awaiting assertion', async () => {
    // A dedicated id pair: ambient stray promotes target SESSION_ID /
    // AGENT_SLUG, so a unique pair makes this test hermetic no matter what
    // is still in flight — no streaming state exists for it, which is
    // exactly the settled shape the else-branch broadcast covers.
    const PROMOTE_SESSION = 'direct-promote-session'
    const PROMOTE_AGENT = 'direct-promote-agent'
    const restoreMetadata = withHiddenScheduledMetadata(PROMOTE_AGENT, PROMOTE_SESSION)
    const events = collectGlobalEvents()

    try {
      // The human-message route (agents.ts) promotes before delivery, usually
      // on a session that is NOT awaiting. Clients echo session_awaiting_input
      // into their caches as STATE (working + orange dot), so that promote
      // must send the assertion-free refetch nudge instead.
      await sessions(PROMOTE_AGENT).promoteAutomated(PROMOTE_SESSION)

      const forSession = (e: { sessionId?: string; agentSlug?: string }) =>
        e.sessionId === PROMOTE_SESSION || e.agentSlug === PROMOTE_AGENT
      expect(events().filter((e) => e.type === 'session_awaiting_input' && forSession(e))).toHaveLength(0)
      const updated = events().filter((e) => e.type === 'session_updated' && forSession(e))
      expect(updated).toHaveLength(1)
      expect(updated[0]).toMatchObject({ sessionId: PROMOTE_SESSION, agentSlug: PROMOTE_AGENT })
    } finally {
      restoreMetadata()
    }
  })

  it('a promote on the awaiting rising edge still asserts session_awaiting_input', async () => {
    const restoreMetadata = withHiddenScheduledMetadata(AGENT_SLUG, SESSION_ID)
    const events = collectGlobalEvents()

    simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })

    await vi.waitFor(() => {
      expect(updateSessionMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        { promotedToInteractive: true },
      )
    })
    // The session genuinely awaits here, so the state assertion is correct.
    const forSession = (e: { sessionId?: string }) => e.sessionId === SESSION_ID
    expect(
      events().filter((e) => e.type === 'session_awaiting_input' && forSession(e)).length,
    ).toBeGreaterThanOrEqual(1)
    expect(events().filter((e) => e.type === 'session_updated' && forSession(e))).toHaveLength(0)
    restoreMetadata()
  })

  it('does not promote a regular (non-automated) session', async () => {
    vi.mocked(getSessionMetadata).mockResolvedValueOnce({
      name: 'Regular session',
    })

    simulateToolUse('AskUserQuestion', 'tool-1', {
      questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
    })

    // Give the async code a chance to run
    await new Promise((r) => setTimeout(r, 50))

    expect(updateSessionMetadata).not.toHaveBeenCalled()
  })

  it('does not double-promote an already promoted session', async () => {
    vi.mocked(getSessionMetadata).mockResolvedValueOnce({
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
      promotedToInteractive: true,
    })

    simulateToolUse('AskUserQuestion', 'tool-1', {
      questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
    })

    await new Promise((r) => setTimeout(r, 50))

    expect(updateSessionMetadata).not.toHaveBeenCalled()
  })

  it('re-broadcasts session_awaiting_input after promotion so sidebar refetches', async () => {
    vi.mocked(getSessionMetadata).mockResolvedValueOnce({
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
    })

    const globalEvents = collectGlobalEvents()

    simulateToolUse('AskUserQuestion', 'tool-1', {
      questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
    })

    await vi.waitFor(() => {
      expect(updateSessionMetadata).toHaveBeenCalled()
    })

    const awaitingEvents = globalEvents().filter(e => e.type === 'session_awaiting_input')
    // First broadcast is immediate (before promotion), second is after metadata update
    expect(awaitingEvents.length).toBeGreaterThanOrEqual(2)
  })
})

describe('automation outcome metadata', () => {
  // Guard rules (regular session, promoted legacy session, already-final
  // outcome) live inside finalizeAutomationStatus and are covered by
  // session-service.metadata.test.ts against real files. Here we cover the
  // wiring: result → status mapping, and the not-automation caching that
  // spares interactive sessions repeat metadata reads.
  beforeEach(() => {
    vi.mocked(finalizeAutomationStatus).mockResolvedValue('updated')
  })

  function sendResult(isError: boolean) {
    mockClient.emit(isError ? {
      type: 'result',
      subtype: 'error_during_execution',
      error: 'Execution failed',
      is_error: true,
      duration_ms: 100,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 0 },
    } : {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  it('finalizes a successful result as succeeded once the session settles (legacy result-driven idle)', async () => {
    // No state-events authority and no background work: the result itself
    // settles the session, so success persists in the same flow.
    sendResult(false)

    await vi.waitFor(() => {
      expect(finalizeAutomationStatus).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        'succeeded',
      )
    })
  })

  it('defers success past open background work and persists only at the settled idle', async () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
    mockClient.emit({
      type: 'system', subtype: 'task_started', task_type: 'local_workflow',
      task_id: 'bg1', tool_use_id: 'bg-tool', workflow_name: 'demo', description: 'demo workflow',
    })

    // The turn's result is a clean success, but the background task keeps
    // the session running — the outcome must NOT be finalized yet, or a
    // later failure could never correct it.
    sendResult(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finalizeAutomationStatus).not.toHaveBeenCalled()

    // Premature turn-end idle while the task still runs: still not settled.
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finalizeAutomationStatus).not.toHaveBeenCalled()

    // Task settles, then the truly-settled idle persists the success.
    mockClient.emit({
      type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'bg-tool', status: 'completed',
    })
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

    await vi.waitFor(() => {
      expect(finalizeAutomationStatus).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        'succeeded',
      )
    })
    expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
  })

  it('lets a later failure win over an earlier unsettled success', async () => {
    sessions().markActive(SESSION_ID)
    mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })

    // First (merged-turn) result succeeds but the runtime never goes idle —
    // a queued message continues the turn.
    sendResult(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finalizeAutomationStatus).not.toHaveBeenCalled()

    // The continuation fails: the failure is terminal immediately.
    sendResult(true)
    await vi.waitFor(() => {
      expect(finalizeAutomationStatus).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        'failed',
      )
    })

    // The settling idle must not resurrect the stale success.
    mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
  })

  it('finalizes an errored result as failed', async () => {
    sendResult(true)

    await vi.waitFor(() => {
      expect(finalizeAutomationStatus).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        'failed',
      )
    })
  })

  it('stops asking after a session is known not to be an automation session', async () => {
    vi.mocked(finalizeAutomationStatus).mockResolvedValue('not-automation')

    sendResult(false)
    await vi.waitFor(() => {
      expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
    })

    sendResult(false)
    // A second turn's result must not trigger another metadata read.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
  })

  it('does not finalize on a gracefully interrupted turn', async () => {
    // Error-shaped but terminal_reason marks a deliberate stop; a
    // container-internal restart continues the turn, so the automation's
    // real outcome is still pending.
    mockClient.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools',
      duration_ms: 100,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 0 },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finalizeAutomationStatus).not.toHaveBeenCalled()
  })

  it('keeps consulting the metadata while the session is an automation session', async () => {
    vi.mocked(finalizeAutomationStatus).mockResolvedValue('updated')

    sendResult(false)
    await vi.waitFor(() => {
      expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
    })

    sendResult(true)
    await vi.waitFor(() => {
      expect(finalizeAutomationStatus).toHaveBeenCalledTimes(2)
    })
  })
})
