/**
 * Pull-based chat working/thinking indicator.
 *
 * The indicator is a self-healing projection of the agent's activity:
 *  - The manager owns a per-session TICK (alive for the SSE subscription, not a
 *    turn). Each tick reads `messagePersister.getSessionActivity(sessionId)` and
 *    reconciles the connector. The tick is the ONLY thing that PAINTS, and the
 *    self-healing backstop — a stuck or wrong indicator self-corrects within one
 *    tick because the tick re-reads reality every interval.
 *  - Events only ever CLEAR (four immediate clears: card-show, first reply token,
 *    session_idle, session_error), so the settle is instant; the tick backstops.
 *
 * This kills the old whack-a-mole: there is no connector self-heartbeat re-stamping
 * a cached label, and no push `session_activity` event to miss/mis-order. The
 * perpetual-"Thinking…" leak (an error-terminal turn that never cleared) is now
 * structurally impossible: session_error clears immediately, and even if it didn't,
 * the next tick reads `idle` and never re-paints.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  processSSEEvent,
  finalizeStreaming,
  reconcileIndicator,
  clearIndicator,
  startIndicatorTick,
  stopIndicatorTick,
  INDICATOR_TICK_MS,
  type ManagedConnector,
} from './chat-integration-manager'
import { TelegramConnector } from './telegram-connector'
import { MockChatClientConnector } from './mock-connector'
import { messagePersister } from '@shared/lib/container/message-persister'
import type { ChatIntegration } from '@shared/lib/db/schema'
import type { SessionActivity } from '@shared/lib/types/agent'

function makeManaged(connector: ManagedConnector['connector'], chatId: string): ManagedConnector {
  return {
    connector,
    integration: {
      id: 'repro-integration',
      agentSlug: 'repro-agent',
      provider: 'telegram',
      name: 'Repro Bot',
      config: '{}',
      showToolCalls: false,
      status: 'active',
      errorMessage: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ChatIntegration,
    chatId,
    sseUnsubscribe: null,
    messageUnsubscribe: null,
    interactiveUnsubscribe: null,
    errorUnsubscribe: null,
    streamingState: { currentMessageId: null, accumulatedText: '', lastUpdateTime: 0 },
    currentToolInput: '',
    pendingToolMessages: [],
  }
}

/** A real TelegramConnector with a stubbed grammy bot that records draft sends. */
function makeRealDmConnector() {
  const connector = new TelegramConnector({ botToken: 'fake:token' })
  const sendRichMessageDraft = vi.fn().mockResolvedValue(true)
  const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 1 })
  ;(connector as unknown as { bot: unknown }).bot = {
    api: { raw: { sendRichMessageDraft, sendRichMessage }, sendChatAction: vi.fn() },
  }
  return { connector, sendRichMessageDraft }
}

const DM_CHAT = '999' // positive id → private DM → native <tg-thinking> draft path

afterEach(() => {
  vi.restoreAllMocks()
})

// ── reconcileIndicator: idempotent paint / clear ───────────────────────────────
// The manager tracks `indicatorShown`, so a busy reconcile always paints (the
// keep-alive), and a non-busy reconcile clears only when something is shown.

describe('reconcileIndicator (idempotent paint/clear)', () => {
  it('busy paints the label and marks the indicator shown', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-w')
    reconcileIndicator(managed, 'working')
    expect(connector.workingActivities).toEqual(['working'])
    expect(managed.indicatorShown).toBe(true)
  })

  it('busy re-paints on every call (keep-alive — Telegram re-renders the draft)', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-w')
    reconcileIndicator(managed, 'working')
    reconcileIndicator(managed, 'thinking')
    expect(connector.workingActivities).toEqual(['working', 'thinking'])
  })

  it('non-busy clears once, then is a no-op (zero extra connector calls)', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-w')
    reconcileIndicator(managed, 'working')
    reconcileIndicator(managed, 'idle')
    reconcileIndicator(managed, 'idle')
    reconcileIndicator(managed, 'streaming')
    expect(connector.stoppedWorking).toEqual(['chat-w']) // exactly one clear
    expect(managed.indicatorShown).toBe(false)
  })

  it('clearIndicator on a never-shown indicator makes zero connector calls', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-w')
    clearIndicator(managed)
    expect(connector.stoppedWorking).toEqual([])
  })
})

// ── The per-session tick (pull) ────────────────────────────────────────────────
// Each tick reads getSessionActivity (spied here) and reconciles. Lifetime is the
// subscription, not the turn — it self-heals and keeps Telegram drafts alive.

describe('per-session indicator tick (pull)', () => {
  it('paints the busy label each tick (keep-alive)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 3)
      expect(connector.workingActivities).toEqual(['working', 'working', 'working'])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('idle ticks make zero connector calls', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')
      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 3)
      expect(connector.typingIndicators).toEqual([])
      expect(connector.stoppedWorking).toEqual([])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears within one tick when activity goes non-busy', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      const spy = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      expect(managed.indicatorShown).toBe(true)
      spy.mockReturnValue('idle')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      expect(connector.stoppedWorking).toEqual(['chat-t'])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('self-heals a forced-stuck indicator within one tick', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      managed.indicatorShown = true // forced stuck (a leaked label)
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')
      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      expect(connector.stoppedWorking).toEqual(['chat-t'])
      expect(managed.indicatorShown).toBe(false)
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('streaming is non-busy: never paints (the stream owns the surface)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('streaming')
      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 2)
      expect(connector.workingActivities).toEqual([])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopIndicatorTick halts further paints', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      stopIndicatorTick(managed)
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 3)
      expect(connector.workingActivities).toEqual(['working']) // only the first tick
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── 13-transition acceptance (the design's checklist) ──────────────────────────

describe('13-transition acceptance', () => {
  // #2 + headline: streaming → message_stop → idle. The stream clears the indicator and
  // message_stop takes no action, but BETWEEN message_stop and idle the session still
  // reads 'working' (isActive true, streaming cleared — computeActivity falls through to
  // 'working'; the gap widens under stateEventsAuthority where idle arrives on a separate
  // event). So the honest guarantee is NOT "never paints": it is "no flash when idle lands
  // within a tick, and at most ONE self-healing 'Working…' if idle lags a full tick." This
  // kills the OLD deterministic every-turn flash + the perpetual re-stamp; a bounded,
  // self-healing ≤1-tick flash can still occur on a lagging settle. These two tests pin
  // both arms of that — driving getSessionActivity through the REAL working→idle window,
  // not mocking it to 'idle' up front.
  it('streaming→stop→idle (idle within a tick): no end-of-turn flash', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-h')
      managed.indicatorShown = true
      await processSSEEvent(managed, { type: 'stream_delta', text: 'answer' }) // first token clears
      expect(connector.stoppedWorking).toContain('chat-h')
      // idle has already landed by the time the tick samples (message_stop→idle sub-tick).
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')
      startIndicatorTick(managed, 'sess-h')
      await processSSEEvent(managed, { type: 'session_idle' })
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 3)
      expect(connector.workingActivities).toEqual([]) // no flash
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('streaming→stop→idle (idle lags a tick): exactly one self-healing "Working…"', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-h')
      managed.indicatorShown = true
      await processSSEEvent(managed, { type: 'stream_delta', text: 'answer' }) // first token clears
      // The reply finished, but idle LAGS: the session still reads 'working' in the gap.
      const spy = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
      startIndicatorTick(managed, 'sess-h')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS) // a tick fires in the gap → one honest paint
      expect(connector.workingActivities).toEqual(['working']) // ≤1-tick flash, bounded
      // idle finally lands; the next tick self-heals and there are no further paints.
      spy.mockReturnValue('idle')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 3)
      expect(connector.workingActivities).toEqual(['working']) // still exactly one — self-healed
      expect(managed.indicatorShown).toBe(false)
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  // #1/#7: streaming → message_stop → tool execution: tick paints working (honest).
  it('streaming→stop→tool: the tick paints "Working…" after a tick (honest work)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-h')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working') // tool work continues
      startIndicatorTick(managed, 'sess-h')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      expect(connector.workingActivities).toEqual(['working'])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  // #3/#4/#5: thinking / compacting / retrying project honestly via the tick.
  it('projects thinking / compacting / retrying labels', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-h')
      const spy = vi.spyOn(messagePersister, 'getSessionActivity')
      spy.mockReturnValue('thinking')
      startIndicatorTick(managed, 'sess-h')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      spy.mockReturnValue('compacting')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      spy.mockReturnValue('retrying')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      expect(connector.workingActivities).toEqual(['thinking', 'compacting', 'retrying'])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  // #12: session_error with no following idle stays cleared across ticks.
  it('session_error stays cleared across subsequent ticks (no perpetual leak)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-h')
      managed.indicatorShown = true
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')
      await processSSEEvent(managed, { type: 'session_error', apiErrorCode: 'overloaded_error', isActive: false })
      startIndicatorTick(managed, 'sess-h')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 3)
      expect(connector.workingActivities).toEqual([])
      expect(connector.stoppedWorking).toEqual(['chat-h']) // one clear, no re-paint
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  // #9/#10/#13: awaiting resolves → re-arm working via the TICK (no immediate paint).
  it('re-arms working via the tick after awaiting resolves (no immediate paint on resolve)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-h')
      const spy = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('awaiting')
      startIndicatorTick(managed, 'sess-h')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      expect(connector.workingActivities).toEqual([]) // awaiting shows nothing
      spy.mockReturnValue('working') // user answered, fresh turn
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)
      expect(connector.workingActivities).toEqual(['working'])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── finalizeStreaming is synchronously idempotent ──────────────────────────────
// Two terminal paths can finalize concurrently (session_idle + a late stream_start),
// so finalizeStreaming must claim its buffer before its first await.

describe('finalizeStreaming: concurrent calls send the final text exactly once', () => {
  it('claims the buffer synchronously, so a racing finalize is a no-op', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-fin')
    managed.streamingState = { currentMessageId: null, accumulatedText: 'final answer', lastUpdateTime: 0 }

    await Promise.all([finalizeStreaming(managed), finalizeStreaming(managed)])

    const finalSends = connector.sentMessages.filter((m) => m.message.text === 'final answer')
    expect(finalSends.length).toBe(1)
    expect(managed.streamingState.accumulatedText).toBe('')
  })

  it('restores the buffer if delivery fails, so a later finalize can retry (does not silently drop)', async () => {
    const connector = new MockChatClientConnector()
    connector.sendMessage = async () => {
      throw new Error('chat unreachable')
    }
    const managed = makeManaged(connector, 'chat-fin')
    managed.streamingState = { currentMessageId: null, accumulatedText: 'answer', lastUpdateTime: 0 }

    await expect(finalizeStreaming(managed)).rejects.toThrow()
    // The claimed text is restored (not lost) so a later terminal path can resend.
    expect(managed.streamingState.accumulatedText).toBe('answer')
  })
})

// ── session_idle commits the streamed text (finalize regression) ───────────────

describe('session_idle finalizes the streamed reply', () => {
  it('commits the accumulated text on idle', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-i')
    await processSSEEvent(managed, { type: 'stream_delta', text: 'Answer.' })
    await processSSEEvent(managed, { type: 'session_idle' })
    expect(connector.finalizedMessages.some((m) => /Answer\./.test(m.finalText))).toBe(true)
  })
})

// ── session_error → curated, code-specific message (and NEVER the raw error) ────
// An errored turn settles the indicator AND surfaces a short, sanitized message
// keyed off apiErrorCode. The producer puts the raw internal error (which can carry
// file paths / tokens) in `data.error`; the consumer must read only `apiErrorCode`.

describe('session_error: curated message by apiErrorCode, raw error never leaked', () => {
  const RAW_LEAK = '/Users/secret/path tok-abc123 stack-trace-line'
  const cases: Array<{ code: string | null; expect: RegExp }> = [
    { code: 'overloaded_error', expect: /overloaded/i },
    { code: 'rate_limit_error', expect: /rate limit/i },
    { code: 'authentication_failed', expect: /authenticate/i },
    { code: 'context_length_exceeded', expect: /too long|new conversation/i },
    { code: 'some_unknown_code', expect: /hit an error/i },
    { code: null, expect: /hit an error/i },
  ]

  for (const c of cases) {
    it(`apiErrorCode=${c.code ?? 'null'} → curated message, no raw error, indicator cleared`, async () => {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-err')
      managed.indicatorShown = true // the turn was showing the indicator

      await processSSEEvent(managed, {
        type: 'session_error',
        error: RAW_LEAK,
        apiErrorCode: c.code,
        isActive: false,
      })

      const text = connector.sentMessages.at(-1)?.message.text ?? ''
      expect(text).toMatch(c.expect)
      expect(text).not.toContain('/Users/secret/path')
      expect(text).not.toContain('tok-abc123')
      // The indicator is settled instantly on the error path.
      expect(connector.stoppedWorking).toContain('chat-err')
    })
  }
})

// ── Honest, activity-specific Telegram label ───────────────────────────────────
// The native draft is labeled by what the agent is actually doing. startWorking
// renders once per call (the manager's tick drives keep-alive).

describe('Telegram: the native draft is labeled by activity', () => {
  const cases: Array<{ activity: SessionActivity; label: string }> = [
    { activity: 'working', label: '✨ Working…' },
    { activity: 'thinking', label: '✨ Thinking…' },
    { activity: 'compacting', label: '🗜 Compacting…' },
    { activity: 'retrying', label: '🔄 Retrying…' },
  ]
  for (const { activity, label } of cases) {
    it(`${activity} → "${label}"`, async () => {
      const { connector, sendRichMessageDraft } = makeRealDmConnector()
      await connector.startWorking(DM_CHAT, activity)
      expect(sendRichMessageDraft).toHaveBeenLastCalledWith(expect.objectContaining({
        rich_message: { html: `<tg-thinking>${label}</tg-thinking>` },
      }))
      await connector.stopWorking(DM_CHAT)
    })
  }

  it('relabels in place when the activity changes mid-turn (working → compacting)', async () => {
    const { connector, sendRichMessageDraft } = makeRealDmConnector()
    await connector.startWorking(DM_CHAT, 'working')
    await connector.startWorking(DM_CHAT, 'compacting')
    expect(sendRichMessageDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      rich_message: { html: '<tg-thinking>🗜 Compacting…</tg-thinking>' },
    }))
    await connector.stopWorking(DM_CHAT)
  })
})

// ── Root C: authoritative surface teardown ─────────────────────────────────────
// The manager settles the indicator correctly, but the connector's VISIBLE surface can
// outlive that settle: a Telegram "Working…" draft on a no-stream terminal turn (an
// errored / card-only / file-only turn) lingers until the ~30s draft expiry because
// stopWorking was a no-op. stopWorking must be authoritative at the surface — while
// still YIELDING the shared draft to a streamed reply, which reuses the same draft_id
// and would be wiped by a blank.

describe('Telegram: stopWorking tears down a stranded "Working…" draft', () => {
  it('replaces the stale draft in place on a no-stream terminal turn (not a ~30s leak)', async () => {
    const { connector, sendRichMessageDraft } = makeRealDmConnector()
    await connector.startWorking(DM_CHAT, 'working')
    const workingDraftId = sendRichMessageDraft.mock.calls[0][0].draft_id
    sendRichMessageDraft.mockClear()

    // No streamed reply overwrote the draft, so stop must clear it in place rather
    // than wait out Telegram's ephemeral-draft expiry.
    await connector.stopWorking(DM_CHAT)

    expect(sendRichMessageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draft_id: workingDraftId, rich_message: { html: '' } }),
    )
  })

  it('is idempotent: a second stop makes no further draft call (no blank-draft spam)', async () => {
    const { connector, sendRichMessageDraft } = makeRealDmConnector()
    await connector.startWorking(DM_CHAT, 'working')
    await connector.stopWorking(DM_CHAT)
    sendRichMessageDraft.mockClear()
    await connector.stopWorking(DM_CHAT)
    expect(sendRichMessageDraft).not.toHaveBeenCalled()
  })

  it('yields the draft to an incoming stream: does NOT blank it (the reply reuses the draft_id)', async () => {
    const { connector, sendRichMessageDraft } = makeRealDmConnector()
    await connector.startWorking(DM_CHAT, 'working')
    sendRichMessageDraft.mockClear()

    // The first reply token settles the indicator, but the streamed reply reuses this
    // draft — blanking here would wipe/renumber the live reply, so stop is a no-op.
    await connector.stopWorking(DM_CHAT, { yieldingToStream: true })

    expect(sendRichMessageDraft).not.toHaveBeenCalled()
  })
})
