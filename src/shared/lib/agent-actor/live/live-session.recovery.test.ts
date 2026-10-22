/**
 * A session whose runtime went away under it: the socket dropping (reattach,
 * or a mid-turn death the runtime is asked to recover), recovery claiming
 * the sessions that were mid-turn, holding the messages sent meanwhile, and
 * settling them when it fails.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client. The container runtime is the harness's double:
 * `runtime.unexpectedDeath` and `runtime.fatalResult` stand for what
 * `ContainerRuntime` does with a dead runtime.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from '@shared/lib/container/types'

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
import { finalizeAutomationStatus } from '@shared/lib/services/session-service'

const live = attachLiveSessionsHarness()
const sessions = (slug: string = 'test-agent') => live.sessions(slug)

/**
 * The runtime cannot bring the dead turn back: it settles the sessions it
 * claims for recovery, as `ContainerRuntime`'s recovery does when it gives up.
 */
function recoveryFails(slug: string): void {
  live.runtime.unexpectedDeath.mockImplementation((sessionId) => {
    const agent = sessions(slug)
    agent.settleRecovering(agent.claimMidTurnForRecovery(sessionId === undefined ? undefined : [sessionId]))
  })
}

afterEach(() => {
  live.reset()
  live.runtime.unexpectedDeath.mockReset()
  live.runtime.fatalResult.mockReset()
  vi.clearAllMocks()
})

describe('LiveSessions', () => {
  const SESSION_ID = 'test-session-1'
  const AGENT_SLUG = 'test-agent'

  let mockClient: StreamClient
  let sseEvents: any[]
  let sseCleanup: () => void

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
  })

  describe('attaching to replay the last turn (attachReplaying)', () => {
    /** Hold the next attach's handshake open until the returned release. */
    const holdNextAttach = () => {
      let release!: () => void
      const ready = new Promise<void>((resolve) => { release = resolve })
      const attach = vi.mocked(mockClient.subscribeToStream).getMockImplementation()!
      vi.mocked(mockClient.subscribeToStream).mockImplementationOnce((id, onMessage) => ({ ...attach(id, onMessage), ready }))
      return release
    }

    it('reverts a silent cold attachment even when subscribing recreates the streaming state', async () => {
      sessions().unsubscribe(SESSION_ID)
      const release = holdNextAttach()
      const attaching = sessions().attachReplaying(SESSION_ID, mockClient)
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'cold-process' })
      release()
      await attaching
      expect(sessions().isActive(SESSION_ID)).toBe(false)
    })

    it('preserves a real running turn even if the pending-inclusive generation is unchanged', async () => {
      const release = holdNextAttach()
      const attaching = sessions().attachReplaying(SESSION_ID, mockClient)
      const before = sessions().turnGeneration(SESSION_ID)
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      expect(sessions().turnGeneration(SESSION_ID)).toBe(before)
      release()
      await attaching
      expect(sessions().isActive(SESSION_ID)).toBe(true)
    })

    it.each(['send', 'output', 'result'] as const)('preserves a new %s during attachment', async (kind) => {
      const release = holdNextAttach()
      const attaching = sessions().attachReplaying(SESSION_ID, mockClient)
      if (kind === 'send') sessions().markActive(SESSION_ID)
      else if (kind === 'output') mockClient.emit({ type: 'assistant', message: { role: 'assistant', content: 'still running' } })
      else {
        mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
        mockClient.emit({ type: 'result', subtype: 'success', replayed: true, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
      }
      release()
      await attaching
      expect(sessions().isActive(SESSION_ID)).toBe(true)
    })

    it('does not emit a second completion after terminal replay', async () => {
      const release = holdNextAttach()
      const attaching = sessions().attachReplaying(SESSION_ID, mockClient)
      mockClient.emit({ type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
      release()
      await attaching
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sseEvents.filter(event => event.type === 'session_idle')).toHaveLength(1)
    })

    it('tags the mark and its undo provisional, and the replay it attached for not', async () => {
      const release = holdNextAttach()
      const attaching = sessions().attachReplaying(SESSION_ID, mockClient)
      mockClient.emit({ type: 'result', subtype: 'success', replayed: true, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
      release()
      await attaching
      const activity = sseEvents.filter(event => event.type === 'session_active' || event.type === 'session_idle')
      expect(activity.map(event => [event.type, event.provisional === true])).toEqual([
        ['session_active', true],
        ['session_idle', false],
      ])
    })

    it('tags the undo of a silent cold attachment provisional', async () => {
      await sessions().attachReplaying(SESSION_ID, mockClient)
      const activity = sseEvents.filter(event => event.type === 'session_active' || event.type === 'session_idle')
      expect(activity.map(event => [event.type, event.provisional])).toEqual([
        ['session_active', true],
        ['session_idle', true],
      ])
      expect(sessions().isActive(SESSION_ID)).toBe(false)
    })

    it('leaves an attached, busy session as it is', async () => {
      sessions().markActive(SESSION_ID)
      const attaches = vi.mocked(mockClient.subscribeToStream).mock.calls.length
      await sessions().attachReplaying(SESSION_ID, mockClient)
      expect(vi.mocked(mockClient.subscribeToStream).mock.calls).toHaveLength(attaches)
      expect(sessions().isActive(SESSION_ID)).toBe(true)
    })
  })
})

// ============================================================================
// connection_closed → re-subscribe (ELECTRON-Q unhandled rejection guard)
// ============================================================================

describe('connection_closed re-subscribe', () => {
  const SESSION_ID = 'reconnect-session'
  const AGENT_SLUG = 'reconnect-agent'

  afterEach(() => {
    sessions(AGENT_SLUG).unsubscribe(SESSION_ID)
    vi.clearAllMocks()
  })

  it('does not leak an unhandled rejection when the re-subscribe ready promise rejects', async () => {
    let callback: ((message: StreamMessage) => void) | null = null
    let subscribeCount = 0

    const client = {
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
      // Container still reports the session as running, so the closed
      // connection takes the re-subscribe branch.
      getSession: vi.fn(() => Promise.resolve({ isRunning: true } as any)),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      interruptSession: vi.fn(),
      subscribeToStream: vi.fn((_sessionId: string, cb: (message: StreamMessage) => void) => {
        callback = cb
        subscribeCount += 1
        // First subscribe (initial) resolves; the re-subscribe rejects to mirror
        // a failed reconnect (getPortOrThrow → "Container is not running").
        return {
          unsubscribe: vi.fn(),
          ready: subscribeCount === 1
            ? Promise.resolve()
            : Promise.reject(new Error('Container is not running')),
        }
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as ContainerClient

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      // Not mid-turn: a socket that drops mid-turn is the runtime's to
      // recover (see "mid-turn recovery snapshot"), not a reattach.
      await sessions(AGENT_SLUG).subscribe(SESSION_ID, client, SESSION_ID)

      // Simulate the WebSocket dropping — the container synthesizes this message.
      callback!({
        type: 'connection_closed',
        content: { type: 'connection_closed' },
        timestamp: new Date(),
        sessionId: SESSION_ID,
      })

      // Let getSession().then(...) and the rejected ready settle.
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      // Re-subscribe was attempted (initial + reconnect) and the rejected
      // `ready` promise was caught, not leaked.
      expect(subscribeCount).toBe(2)
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// ============================================================================
// connection lost mid-turn → session_error (not a silent session_idle)
// ============================================================================
//
// When the runtime vanishes while a turn is in flight (container crash, guest
// OOM kill, VM death), the WebSocket closes, and when the runtime cannot bring
// the turn back, markInactive settles the session. Settling with session_idle
// presents as the agent just stopping with no explanation — the terminal
// broadcast must be session_error instead.

describe('connection lost mid-turn', () => {
  const SESSION_ID = 'mid-turn-death-session'
  const AGENT_SLUG = 'mid-turn-death-agent'

  let mockClient: StreamClient
  let sseEvents: any[]
  let sseCleanup: () => void

  const dropConnection = async () => {
    mockClient.emit({ type: 'connection_closed' })
    // Let the close settle: mid-turn the runtime's recovery gives up;
    // otherwise the default mock getSession resolves null → markInactive.
    await new Promise((r) => setTimeout(r, 0))
  }

  beforeEach(async () => {
    recoveryFails(AGENT_SLUG)
    mockClient = createStreamClient()
    await sessions(AGENT_SLUG).subscribe(SESSION_ID, mockClient, SESSION_ID)
    const sse = live.collect(AGENT_SLUG, SESSION_ID)
    sseEvents = sse.events
    sseCleanup = sse.stop
  })

  afterEach(() => {
    sseCleanup()
    sessions(AGENT_SLUG).unsubscribe(SESSION_ID)
    vi.clearAllMocks()
  })

  it('broadcasts session_error (not session_idle) when the connection drops mid-turn', async () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sseEvents.length = 0

    await dropConnection()

    const errors = sseEvents.filter((e) => e.type === 'session_error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/stopped unexpectedly/i)
    expect(errors[0].error).toMatch(/out of memory/i)
    expect(errors[0].terminalReason).toBe('connection_lost')
    expect(errors[0].isActive).toBe(false)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
    // The session still settles: no longer active, activity reads idle.
    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(false)
    expect(sessions(AGENT_SLUG).activity(SESSION_ID)).toBe('idle')
  })

  it('also announces the mid-turn death on the global stream (sidebar/notifications)', async () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)

    await dropConnection()

    const errors: any[] = live.host.sent('global').filter((e) => e.type === 'session_error')
    expect(errors).toHaveLength(1)
    expect(errors[0].sessionId).toBe(SESSION_ID)
    expect(errors[0].agentSlug).toBe(AGENT_SLUG)
    expect(errors[0].terminalReason).toBe('connection_lost')
  })

  it('settles quietly with session_idle when the connection drops while idle', async () => {
    // No active turn — e.g. the container auto-slept between turns.
    sseEvents.length = 0

    await dropConnection()

    expect(sseEvents.filter((e) => e.type === 'session_error')).toHaveLength(0)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
  })

  it('does not report an error when the connection drops after a user interrupt', async () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).markInterrupted(SESSION_ID)
    sseEvents.length = 0

    await dropConnection()

    expect(sseEvents.filter((e) => e.type === 'session_error')).toHaveLength(0)
  })
})

describe('mid-turn recovery snapshot', () => {
  const SESSION_ID = 'recover-session'
  const AGENT_SLUG = 'recover-agent'
  let mockClient: StreamClient

  beforeEach(async () => {
    mockClient = createStreamClient()
    await sessions(AGENT_SLUG).subscribe(SESSION_ID, mockClient, SESSION_ID)
  })

  afterEach(() => {
    sessions(AGENT_SLUG).unsubscribe(SESSION_ID)
    vi.clearAllMocks()
  })

  it('snapshots active sessions and skips session_error while they are recovering', () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    expect(sessions(AGENT_SLUG).claimMidTurnForRecovery()).toEqual([SESSION_ID])
    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(true)
    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(true)

    sessions(AGENT_SLUG).markAllInactive()
    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(true)
    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(true)
  })

  it('snapshots only the requested session ids', async () => {
    const otherId = 'recover-session-2'
    await sessions(AGENT_SLUG).subscribe(otherId, mockClient, otherId)
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).markActive(otherId)

    expect(sessions(AGENT_SLUG).claimMidTurnForRecovery([SESSION_ID])).toEqual([SESSION_ID])
    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(true)
    expect(sessions(AGENT_SLUG).isRecovering(otherId)).toBe(false)

    sessions(AGENT_SLUG).unsubscribe(otherId)
  })

  it('settles recovering sessions when the agent is stopped', () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).claimMidTurnForRecovery()
    sessions(AGENT_SLUG).markAllInactive({ settleRecovering: true })
    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(false)
    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(false)
  })

  it('does not claim a session a recovery or restart already holds', () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    expect(sessions(AGENT_SLUG).claimMidTurnForRecovery()).toEqual([SESSION_ID])
    expect(sessions(AGENT_SLUG).claimMidTurnForRecovery()).toEqual([])
  })

  it('does not snapshot idle or interrupted sessions', async () => {
    expect(sessions(AGENT_SLUG).claimMidTurnForRecovery()).toEqual([])
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).markInterrupted(SESSION_ID)
    expect(sessions(AGENT_SLUG).claimMidTurnForRecovery()).toEqual([])
  })

  it('coalesces user text while recovering and keeps each message uuid', () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).claimMidTurnForRecovery()
    expect(sessions(AGENT_SLUG).coalesceIfRecovering(SESSION_ID, { uuid: 'u1', text: 'first' })).toBe(true)
    expect(sessions(AGENT_SLUG).coalesceIfRecovering(SESSION_ID, { uuid: 'u2', text: 'second' })).toBe(true)
    expect(sessions(AGENT_SLUG).takeCoalesced(SESSION_ID)).toEqual([
      { uuid: 'u1', text: 'first' },
      { uuid: 'u2', text: 'second' },
    ])
    expect(sessions(AGENT_SLUG).coalesceIfRecovering('other', { uuid: 'u3', text: 'nope' })).toBe(false)
  })

  it('drops a coalesced user message by uuid', () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).claimMidTurnForRecovery()
    sessions(AGENT_SLUG).coalesceIfRecovering(SESSION_ID, { uuid: 'u1', text: 'first' })
    sessions(AGENT_SLUG).coalesceIfRecovering(SESSION_ID, { uuid: 'u2', text: 'second' })
    expect(sessions(AGENT_SLUG).dropCoalesced(SESSION_ID, 'u1')).toBe(true)
    expect(sessions(AGENT_SLUG).takeCoalesced(SESSION_ID)).toEqual([{ uuid: 'u2', text: 'second' }])
  })

  it('does not log coalesced message content when settling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).claimMidTurnForRecovery()
    sessions(AGENT_SLUG).coalesceIfRecovering(SESSION_ID, { uuid: 'u1', text: 'secret user text' })
    sessions(AGENT_SLUG).settleRecovering([SESSION_ID])
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret user text')
    warn.mockRestore()
  })

  it('settles recovering sessions as connection_lost and writes automation status', () => {
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).claimMidTurnForRecovery()
    sessions(AGENT_SLUG).settleRecovering([SESSION_ID])
    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(false)
    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(false)
    expect(finalizeAutomationStatus).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, 'failed')
  })

  it('defers a fatal SIGKILL result to unexpected-death recovery', async () => {
    mockClient.onFatalResult = vi.fn(() => 'defer_for_recovery' as const)
    sessions(AGENT_SLUG).markActive(SESSION_ID)

    mockClient.emit({
      type: 'result',
      subtype: 'error',
      fatal: true,
      error: 'The agent process was killed due to running out of memory.',
    })

    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(true)
    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(false)
    expect(live.runtime.unexpectedDeath).toHaveBeenCalledWith()
    // The runtime keeps the kind for its recovery to report.
    expect(live.runtime.fatalResult).toHaveBeenCalledWith(mockClient, 'oom_sigkill')
    expect(live.runtime.fatalResult).toHaveLastReturnedWith('defer_for_recovery')
  })

  it('does not snapshot a fatal SIGKILL when no recovery callback is registered', async () => {
    // The runtime decides whether a fatal result is recovered: one that will
    // not recover it settles the turn, whatever the client offers.
    live.runtime.fatalResult.mockReturnValue('settle')
    mockClient.onFatalResult = vi.fn(() => 'defer_for_recovery' as const)
    sessions(AGENT_SLUG).markActive(SESSION_ID)

    mockClient.emit({
      type: 'result',
      subtype: 'error',
      fatal: true,
      error: 'The agent process was killed due to running out of memory.',
    })

    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(false)
    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(false)
    expect(live.runtime.unexpectedDeath).not.toHaveBeenCalled()
  })

  it('does not settle mid-turn on connection_closed when recovery is registered', async () => {
    const otherId = 'recover-session-2'
    const otherClient = createStreamClient()
    await sessions(AGENT_SLUG).subscribe(otherId, otherClient, otherId)
    sessions(AGENT_SLUG).markActive(SESSION_ID)
    sessions(AGENT_SLUG).markActive(otherId)

    mockClient.emit({ type: 'connection_closed' })
    await new Promise((r) => setTimeout(r, 0))

    expect(live.runtime.unexpectedDeath).toHaveBeenCalledWith(SESSION_ID)
    expect(live.runtime.unexpectedDeath).toHaveBeenCalledTimes(1)
    expect(sessions(AGENT_SLUG).isActive(SESSION_ID)).toBe(true)
    expect(sessions(AGENT_SLUG).isActive(otherId)).toBe(true)
    expect(sessions(AGENT_SLUG).isRecovering(SESSION_ID)).toBe(false)
    expect(sessions(AGENT_SLUG).isRecovering(otherId)).toBe(false)
    // Dead transport is detached so recovery's isSubscribed gate resubscribes.
    expect(sessions(AGENT_SLUG).isSubscribed(SESSION_ID)).toBe(false)
    expect(sessions(AGENT_SLUG).isSubscribed(otherId)).toBe(true)
    sessions(AGENT_SLUG).unsubscribe(otherId)
  })
})
