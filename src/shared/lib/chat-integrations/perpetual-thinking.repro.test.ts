/**
 * REPRODUCTION: Telegram "Thinking…" bubble runs forever after a turn that ends
 * on a non-idle terminal event (an error result, or any path where the host
 * never broadcasts `session_idle`).
 *
 * Root cause (verified end-to-end):
 *  - The working indicator is a 1s keep-alive `setInterval` in TelegramConnector
 *    (`workingTimers`) that re-sends `<tg-thinking>✨ Thinking…</tg-thinking>` to
 *    the shared draft_id until `stopWorking` clears it.
 *  - On the streaming path, `stopWorking` is reached ONLY via the first
 *    `stream_delta` of a segment (guarded by an empty accumulator) or `session_idle`.
 *  - When a turn ends in an error, message-persister broadcasts `session_error`
 *    (NOT `session_idle`) and suppresses the later authoritative idle. But
 *    `processSSEEvent` has NO `session_error` case — so nothing ever calls
 *    `stopWorking`. The heartbeat re-stamps "Thinking…" forever (until the
 *    connector disconnects / the server restarts).
 *
 * These tests assert the DESIRED behavior (the heartbeat stops). On current
 * code the error/missing-idle cases FAIL — that failure IS the reproduction.
 * The `session_idle` case is the positive control and passes today.
 */

import { describe, it, expect, vi } from 'vitest'
import { processSSEEvent, finalizeStreaming, type ManagedConnector } from './chat-integration-manager'
import { TelegramConnector } from './telegram-connector'
import { MockChatClientConnector } from './mock-connector'
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

describe('REPRO: perpetual "Thinking…" after a non-idle terminal event', () => {
  it('LEAKS: an error-terminal turn (after a finished response) keeps re-sending "Thinking…" forever', async () => {
    vi.useFakeTimers()
    try {
      const { connector, sendRichMessageDraft } = makeRealDmConnector()
      const managed = makeManaged(connector, DM_CHAT)

      // 1) A message arrives → the manager arms the indicator (dispatch site).
      await connector.startWorking(DM_CHAT, 'working')

      // 2) The agent streams a full answer. The first token clears the bubble and
      //    the user SEES the response ("it finished its response").
      await processSSEEvent(managed, { type: 'stream_start' })
      managed.streamingState.lastUpdateTime = 0
      await processSSEEvent(managed, { type: 'stream_delta', text: 'Here is your answer.' })

      // 3) The agent begins one more segment (very common: text → tool → text, or
      //    a trailing assistant block). stream_start RE-ARMS the keep-alive timer.
      await processSSEEvent(managed, { type: 'stream_start' })
      // Let the (un-awaited) startWorking inside processSSEEvent arm its interval.
      await vi.advanceTimersByTimeAsync(1)

      // 4) ...but the turn ends in an ERROR (e.g. API overloaded / rate limit). In
      //    production the persister sets isActive=false → emits session_activity('idle')
      //    → THEN broadcasts session_error. The idle activity tears the
      //    indicator down; session_error only finalizes + surfaces the message.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'idle' })
      await processSSEEvent(managed, {
        type: 'session_error',
        error: 'Overloaded (API 529)',
        apiErrorCode: 'overloaded_error',
        isActive: false,
      })

      const sendsAtError = sendRichMessageDraft.mock.calls.length

      // No further events arrive. Any draft send in this idle window is the
      // keep-alive heartbeat re-stamping "Thinking…".
      await vi.advanceTimersByTimeAsync(30_000)
      const sendsAfter30s = sendRichMessageDraft.mock.calls.length

      // DESIRED: the indicator is torn down on the terminal event → no more sends.
      // ACTUAL (bug): ~30 extra sends — "Thinking…" forever until restart.
      expect(sendsAfter30s).toBe(sendsAtError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('LEAKS: a turn that errors before any text streams strands the bubble immediately', async () => {
    vi.useFakeTimers()
    try {
      const { connector, sendRichMessageDraft } = makeRealDmConnector()
      const managed = makeManaged(connector, DM_CHAT)

      // Message arrives → indicator armed. Agent errors immediately (no stream_delta
      // ever clears it). e.g. rate-limit / auth / context-overflow on the first turn.
      // In production the persister emits session_activity('idle') before session_error;
      // that signal — not the terminal case — tears the indicator down.
      await connector.startWorking(DM_CHAT, 'working')
      await processSSEEvent(managed, { type: 'session_activity', activity: 'idle' })
      await processSSEEvent(managed, {
        type: 'session_error',
        error: 'rate_limit',
        apiErrorCode: 'rate_limit_error',
        isActive: false,
      })

      const sendsAtError = sendRichMessageDraft.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)

      // DESIRED: stopped. ACTUAL (bug): keeps firing forever.
      expect(sendRichMessageDraft.mock.calls.length).toBe(sendsAtError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('LEAKS (race): a fire-and-forget startWorking must register the heartbeat before its send, so a racing stopWorking clears it', async () => {
    vi.useFakeTimers()
    try {
      const { connector, sendRichMessageDraft } = makeRealDmConnector()

      // Real dispatch / stream_start call startWorking fire-and-forget (un-awaited).
      // If the keep-alive interval is registered only AFTER the initial awaited send,
      // a terminal stopWorking that runs in that window finds no timer, and the late
      // startWorking installs one after teardown — "Thinking…" leaks. The fix
      // registers the interval synchronously, before the await.
      void connector.startWorking(DM_CHAT, 'working')
      // A terminal event settles the turn immediately, before the initial send resolves.
      await connector.stopWorking(DM_CHAT)
      // Let the in-flight startWorking send resolve.
      await vi.advanceTimersByTimeAsync(1)
      const sendsAfterStop = sendRichMessageDraft.mock.calls.length

      // No heartbeat should remain after the racing stop.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sendRichMessageDraft.mock.calls.length).toBe(sendsAfterStop)
    } finally {
      vi.useRealTimers()
    }
  })

  it('CONTROL: the same flow ending in session_idle correctly stops the heartbeat', async () => {
    vi.useFakeTimers()
    try {
      const { connector, sendRichMessageDraft } = makeRealDmConnector()
      const managed = makeManaged(connector, DM_CHAT)

      await connector.startWorking(DM_CHAT, 'working')
      await processSSEEvent(managed, { type: 'stream_start' })
      managed.streamingState.lastUpdateTime = 0
      await processSSEEvent(managed, { type: 'stream_delta', text: 'Here is your answer.' })
      await processSSEEvent(managed, { type: 'stream_start' })
      await vi.advanceTimersByTimeAsync(1)

      // Proper terminal flow: the persister emits session_activity('idle') (which stops
      // the indicator + clears the timer) right before the authoritative session_idle.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'idle' })
      await processSSEEvent(managed, { type: 'session_idle' })
      const sendsAtIdle = sendRichMessageDraft.mock.calls.length

      await vi.advanceTimersByTimeAsync(30_000)
      expect(sendRichMessageDraft.mock.calls.length).toBe(sendsAtIdle)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Idle-silence watchdog (backstop for stalls / missing terminal events) ──
// Even when NO terminal event ever arrives (a true SDK stall, a dropped stream,
// a future event type nobody wired up), "Thinking…" must not run forever. The
// watchdog clears the indicator after a stretch of total SSE silence, and resets
// on any activity so a healthy long turn is never cut off.

const WATCHDOG_MS = 5 * 60 * 1000

function stalledMessageSent(connector: MockChatClientConnector): boolean {
  return connector.sentMessages.some((m) => /taking longer|send your message again/i.test(m.message.text))
}

describe('REPRO: idle-silence watchdog', () => {
  it('fires after the silence threshold: clears the indicator and tells the user', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-watch')

      // A turn begins (a busy session_activity arms the indicator + the watchdog), then total silence.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1000)

      expect(connector.stoppedWorking).toContain('chat-watch')
      expect(stalledMessageSent(connector)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT fire on a healthy long turn: any SSE event resets the silence clock', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-watch')

      await processSSEEvent(managed, { type: 'session_activity', activity: 'working' }) // arm
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000) // 2 min — still alive
      await processSSEEvent(managed, { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' }) // activity → reset
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000) // 2 min since reset (< threshold)

      expect(connector.stoppedWorking).not.toContain('chat-watch')
      expect(stalledMessageSent(connector)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is paused while a user-request card is outstanding (silence is the user, not a stall)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-watch')

      await processSSEEvent(managed, { type: 'session_activity', activity: 'working' }) // arm
      // In production a *_request makes the persister flip isAwaitingInput → emit
      // session_activity('awaiting'), which clears the watchdog before the card is shown.
      // Model that paired signal here so the silence below is a genuine human wait.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'awaiting' })
      await processSSEEvent(managed, {
        type: 'user_question_request',
        toolUseId: 'tu-1',
        questions: [{ question: 'Which DB?' }],
      })
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 60 * 1000) // long human wait, past threshold

      expect(stalledMessageSent(connector)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT fire after session_error already settled the turn (and never double-notifies)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-watch')

      // A turn arms the indicator + watchdog, then errors. In production the persister
      // emits session_activity('idle') before session_error: the idle activity clears
      // the watchdog, and session_error sends ONE curated error message.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
      await processSSEEvent(managed, { type: 'session_activity', activity: 'idle' })
      await processSSEEvent(managed, {
        type: 'session_error',
        error: 'boom',
        apiErrorCode: 'overloaded_error',
        isActive: false,
      })
      const messagesAfterError = connector.sentMessages.length

      // Well past the watchdog threshold: the watchdog must NOT also fire (no
      // stall notice, no second message piled on the error).
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 60 * 1000)

      expect(stalledMessageSent(connector)).toBe(false)
      expect(connector.sentMessages.length).toBe(messagesAfterError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a FAILED watchdog notice releases the latch, so a later real session_error still reaches the user', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      // The watchdog notice send fails (transient), every later send succeeds.
      let failNext = true
      const realSend = connector.sendMessage.bind(connector)
      connector.sendMessage = async (chatId, message) => {
        if (failNext) {
          failNext = false
          throw new Error('transient send failure')
        }
        return realSend(chatId, message)
      }
      const managed = makeManaged(connector, 'chat-watch')

      // Arm, then total silence trips the watchdog — whose notice send throws.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1000)

      // A genuine error then arrives. It must NOT be suppressed by the failed notice.
      await processSSEEvent(managed, {
        type: 'session_error',
        error: 'boom',
        apiErrorCode: 'rate_limit_error',
        isActive: false,
      })

      const errorDelivered = connector.sentMessages.some((m) => /rate limit/i.test(m.message.text))
      expect(errorDelivered).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits at most ONE stall notice per turn, even if it stalls again in a later segment', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-watch')

      // Segment 1 of the turn: arm, then total silence trips the watchdog → notice #1.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1000)

      // Same turn continues (a new segment, NO new user dispatch in between) and
      // stalls again. The once-per-turn latch — reset at dispatch, not per
      // segment — must suppress a second notice.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1000)

      const stallNotices = connector.sentMessages.filter((m) =>
        /taking longer|send your message again/i.test(m.message.text),
      )
      expect(stallNotices.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── session_error → curated, code-specific message (and NEVER the raw error) ──
// The headline fix: an errored turn settles the indicator AND surfaces a short,
// sanitized message keyed off apiErrorCode. The producer puts the raw internal
// error (which can carry file paths / tokens) in `data.error`; the consumer must
// read only `apiErrorCode` and never echo `data.error` into the chat.

// ── finalizeStreaming is synchronously idempotent ──────────────────────────
// The watchdog tears down off the per-chat SSE queue, so its settleTurn can race
// a late stream event that also finalizes. finalizeStreaming must claim its buffer
// before its first await, so two concurrent calls send the final text only once.

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

describe('reconcileIndicator via session_activity', () => {
  it('a busy activity starts the indicator + arms the watchdog', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-w')
    await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
    expect(connector.typingIndicators).toContain('chat-w')
  })

  it('a non-busy activity stops the indicator', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-w')
    await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
    await processSSEEvent(managed, { type: 'session_activity', activity: 'idle' })
    expect(connector.stoppedWorking).toContain('chat-w')
  })

  it('projects the activity-specific label onto the connector (working/thinking/compacting/retrying)', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-w')
    for (const activity of ['working', 'thinking', 'compacting', 'retrying'] as const) {
      await processSSEEvent(managed, { type: 'session_activity', activity })
    }
    expect(connector.workingActivities).toEqual(['working', 'thinking', 'compacting', 'retrying'])
  })
})

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
    it(`apiErrorCode=${c.code ?? 'null'} → curated message, no raw error`, async () => {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-err')

      // The persister emits session_activity('idle') before session_error; that signal
      // settles the indicator, session_error only surfaces the curated message.
      await processSSEEvent(managed, { type: 'session_activity', activity: 'idle' })
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
      // The indicator is also torn down on the error path.
      expect(connector.stoppedWorking).toContain('chat-err')
    })
  }
})

// ── Task 5: settleTurn split into indicator-free finalizeTurn ──────────────
// Terminal cases (session_idle / session_error) now ONLY finalize the turn; the
// indicator is reconcile-driven off session_activity. In production the persister
// emits a non-busy session_activity immediately BEFORE the terminal broadcast, so the
// manager stops the indicator on that signal — not on the terminal case itself.
// The watchdog is the one exception: a stall means state still says working, so
// it must force the indicator off directly.

describe('Task 5: finalizeTurn split — terminal cases finalize, indicator is reconcile-driven', () => {
  it('session_idle finalizes streamed text but does not itself stop the indicator (session_activity does)', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-i')
    await processSSEEvent(managed, { type: 'session_activity', activity: 'working' })
    await processSSEEvent(managed, { type: 'stream_delta', text: 'Answer.' })
    connector.stoppedWorking = []
    await processSSEEvent(managed, { type: 'session_idle' })
    // idle commits the streamed text…
    expect(connector.finalizedMessages.some((m) => /Answer\./.test(m.finalText))).toBe(true)
    // …but does NOT itself tear down the indicator — that is session_activity's job now.
    expect(connector.stoppedWorking).not.toContain('chat-i')
    // The indicator settles via the session_activity('idle') the persister emits on idle:
    await processSSEEvent(managed, { type: 'session_activity', activity: 'idle' })
    expect(connector.stoppedWorking).toContain('chat-i')
  })
})

// ── Honest, activity-specific Telegram label ───────────────────────────────
// The native draft is labeled by what the agent is actually doing, not a single
// hardcoded "Thinking…". The label tracks the latest activity even mid-turn.

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
