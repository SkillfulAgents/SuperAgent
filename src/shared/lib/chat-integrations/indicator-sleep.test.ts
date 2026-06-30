/**
 * Indicator sleep/wake: the TICK owns its own sleep — each tick a busy read keeps it
 * awake and the first of a sustained non-busy run starts the debounce, so an idle
 * session holds ZERO per-session timers without ever stranding a busy one. The settle
 * handlers only clear the indicator; they no longer schedule the sleep.
 *
 * Invariants under test (each maps to an adversarial-review finding):
 *  - CREATE-IF-ABSENT: a wake never restarts a running tick (else a fast event burst
 *    would keep resetting the interval and starve it — the draft would expire mid-turn).
 *  - ARM-ONCE: scheduleIndicatorSleep is idempotent, so the tick calling it every
 *    non-busy second never pushes the debounce back — it fires ~10s after the FIRST
 *    non-busy tick, and a busy tick in between cancels and restarts the window.
 *  - SLEEP GUARD: the sleep timer RE-READS activity when it fires and only stops the
 *    tick if still non-busy, so an auto-approved script run (card shown, session still
 *    'working') or a stale/late sleep can't kill a live tick.
 *  - stopIndicatorTick clears the pending sleep too, so an orphaned sleep from a prior
 *    subscription can't fire later and kill a freshly re-armed tick.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  processSSEEvent,
  reconcileIndicator,
  startIndicatorTick,
  stopIndicatorTick,
  scheduleIndicatorSleep,
  cancelIndicatorSleep,
  armIndicatorIfBusy,
  INDICATOR_TICK_MS,
  INDICATOR_SLEEP_MS,
  type ManagedConnector,
} from './chat-integration-manager'
import { MockChatClientConnector } from './mock-connector'
import { messagePersister } from '@shared/lib/container/message-persister'
import type { ChatIntegration } from '@shared/lib/db/schema'

function makeManaged(connector: ManagedConnector['connector'], chatId: string): ManagedConnector {
  return {
    connector,
    integration: {
      id: 'sleep-integration',
      agentSlug: 'sleep-agent',
      provider: 'telegram',
      name: 'Sleep Bot',
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

afterEach(() => {
  vi.restoreAllMocks()
})

// ── create-if-absent (no restart, no burst-starvation) ──────────────────────────

describe('startIndicatorTick: create-if-absent', () => {
  it('a second call while running does NOT restart the interval (no burst-starvation)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-a')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')

      startIndicatorTick(managed, 'sess-a')             // interval scheduled to fire at t=1000
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS / 2)   // t=500
      startIndicatorTick(managed, 'sess-a')             // wake again — must NOT reset the interval
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS / 2)   // t=1000

      // The original interval fired once at t=1000. Had the second call restarted it, the
      // next fire would be t=1500 and we'd see ZERO paints here.
      expect(connector.workingActivities).toEqual(['working'])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not create a second interval when one already runs', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-a')
    vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')

    startIndicatorTick(managed, 'sess-a')
    const first = managed.indicatorTickTimer
    startIndicatorTick(managed, 'sess-a')
    expect(managed.indicatorTickTimer).toBe(first) // same timer handle, not replaced
    stopIndicatorTick(managed)
  })
})

// ── sleep: stop the tick after a confirmed-idle lull ────────────────────────────

describe('scheduleIndicatorSleep', () => {
  it('stops the tick after the debounce when the session is non-busy', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-s')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')

      startIndicatorTick(managed, 'sess-s')
      scheduleIndicatorSleep(managed)
      expect(managed.sleepTimer).toBeTruthy()

      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeFalsy() // tick stopped
      expect(managed.sleepTimer).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('GUARD: never stops the tick if the session is still busy when the sleep fires', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-s')
      // The session is genuinely working (e.g. an auto-approved script run that showed a
      // card but never went 'awaiting'), so the debounce must NOT strand it.
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
      managed.sessionId = 'sess-s'
      // A non-firing tick handle so the sleep's fire-time guard is what's under test here,
      // isolated from the tick's own busy-cancel (which the tick-owner suite covers). The
      // guard defends the sub-tick window: the session goes busy after the last tick read
      // but before the sleep fires.
      managed.indicatorTickTimer = setInterval(() => {}, 1_000_000)
      scheduleIndicatorSleep(managed)
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)

      expect(managed.indicatorTickTimer).toBeTruthy() // tick survives — guard held
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a no-op when no tick is running (nothing to sleep)', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-s')
    scheduleIndicatorSleep(managed)
    expect(managed.sleepTimer).toBeFalsy() // no dangling timer
  })

  it('a fresh event cancels the pending sleep (wake keeps the tick alive)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-s')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')

      startIndicatorTick(managed, 'sess-s')
      scheduleIndicatorSleep(managed)
      expect(managed.sleepTimer).toBeTruthy()
      startIndicatorTick(managed, 'sess-s') // the wake — cancels the pending sleep
      expect(managed.sleepTimer).toBeFalsy()

      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeTruthy() // never slept
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── the tick owns its own sleep (single control loop) ───────────────────────────
// The tick is the ONE place that arms/cancels the sleep: a busy read keeps it awake,
// the first of a sustained non-busy run starts the debounce. This is what lets the
// settle handlers stay dumb (clear only) while the confirmation stays self-reading.

describe('the tick arms/cancels its own sleep', () => {
  it('arms a sleep on the first non-busy tick, then stops after the debounce', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      const activity = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')

      startIndicatorTick(managed, 'sess-t')                  // armed mid-turn (busy)
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // a busy tick arms NO sleep
      expect(managed.sleepTimer).toBeFalsy()

      activity.mockReturnValue('idle')                       // turn ends
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // first non-busy tick arms the sleep
      expect(managed.sleepTimer).toBeTruthy()

      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)  // debounce elapses
      expect(managed.indicatorTickTimer).toBeFalsy()         // slept
      expect(managed.sleepTimer).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a busy tick cancels a pending sleep — the window is CONTINUOUS, not cumulative', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      const activity = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')

      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // non-busy tick → arms the sleep
      expect(managed.sleepTimer).toBeTruthy()
      const firstSleep = managed.sleepTimer

      activity.mockReturnValue('working')                    // work resumes mid-debounce
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // busy tick → cancels the sleep
      expect(managed.sleepTimer).toBeFalsy()

      activity.mockReturnValue('idle')                       // settles again
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // non-busy tick → arms a FRESH window
      expect(managed.sleepTimer).toBeTruthy()
      expect(managed.sleepTimer).not.toBe(firstSleep)        // a new timer, not the cancelled one

      // The ORIGINAL deadline must pass WITHOUT sleeping — the window restarted from the blip,
      // it is not cumulative. The tick sleeps only on the FRESH 10s window. (Session is 'idle'
      // here, so the fire-time guard would NOT save it — only a true restart keeps it alive.)
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS - INDICATOR_TICK_MS * 2)
      expect(managed.indicatorTickTimer).toBeTruthy()        // original deadline ignored
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 2) // reach the fresh deadline
      expect(managed.indicatorTickTimer).toBeFalsy()          // slept on the new window only
    } finally {
      vi.useRealTimers()
    }
  })

  it('sleeps during a long pure-text stream, then RE-WAKES when work resumes (load-bearing exit)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-st')
      const activity = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('streaming')

      startIndicatorTick(managed, 'sess-st')                // armed; the session streams text (non-busy)
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)  // streaming tick → arms the sleep
      expect(managed.sleepTimer).toBeTruthy()
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS) // >10s of pure text, no tools → tick sleeps
      expect(managed.indicatorTickTimer).toBeFalsy()        // slept mid-stream (indicator already clear)
      expect(connector.workingActivities).toEqual([])       // nothing painted while streaming

      // A tool/thinking block resumes → the wake re-arms the slept tick and paints on the cold arm.
      activity.mockReturnValue('thinking')
      armIndicatorIfBusy(managed, 'sess-st', 'thinking')
      expect(managed.indicatorTickTimer).toBeTruthy()       // re-woken
      expect(connector.workingActivities).toEqual(['thinking'])
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('GUARD at the real t=N boundary: a busy resume in the last sub-tick keeps the tick (order-independent)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-b')
      const activity = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')

      startIndicatorTick(managed, 'sess-b')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // arms the sleep (~t=1000, deadline ~t=11000)
      expect(managed.sleepTimer).toBeTruthy()

      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS - INDICATOR_TICK_MS) // → ~t=10000, still idle
      activity.mockReturnValue('working')                    // work resumes just before the deadline
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // ~t=11000: the tick and the sleep fall due together
      expect(managed.indicatorTickTimer).toBeTruthy()        // survived — whichever fires first, the tick lives
      expect(connector.workingActivities).toContain('working')
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ARM-ONCE: a steady non-busy stream never resets the debounce (same timer, fires on time)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-t')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')

      startIndicatorTick(managed, 'sess-t')
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)   // arms the sleep (~t=1000)
      const firstSleep = managed.sleepTimer
      expect(firstSleep).toBeTruthy()

      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 3) // three more non-busy ticks
      expect(managed.sleepTimer).toBe(firstSleep)            // same handle — arm-once, never reset

      // …and it still fires on the ORIGINAL schedule, not pushed back by the later ticks.
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS - INDICATOR_TICK_MS * 3)
      expect(managed.indicatorTickTimer).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── orphaned sleep cannot kill a re-armed tick ──────────────────────────────────

describe('stopIndicatorTick clears the pending sleep', () => {
  it('an orphaned sleep from a torn-down subscription never fires to kill a new tick', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-o')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')

      startIndicatorTick(managed, 'sess-o')
      scheduleIndicatorSleep(managed)  // a sleep is now pending
      stopIndicatorTick(managed)       // teardown clears the tick AND the sleep
      expect(managed.sleepTimer).toBeFalsy()

      // A re-subscribe re-arms a fresh tick; the old sleep must be gone, not lurking.
      startIndicatorTick(managed, 'sess-o')
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeTruthy() // fresh tick survives
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── end-to-end through the real settle handlers ─────────────────────────────────

describe('settle handlers clear instantly but defer the sleep to the tick', () => {
  it('session_idle clears now and schedules NO sleep itself — the tick arms it next tick', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-i')
      managed.indicatorShown = true
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')

      startIndicatorTick(managed, 'sess-i')                     // tick armed (mid-turn)
      await processSSEEvent(managed, { type: 'session_idle' })  // settle: clears, owns no sleep
      expect(managed.indicatorShown).toBe(false)                // cleared instantly
      expect(managed.sleepTimer).toBeFalsy()                    // handler scheduled nothing

      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)      // the tick arms the sleep
      expect(managed.sleepTimer).toBeTruthy()
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeFalsy()            // slept
    } finally {
      vi.useRealTimers()
    }
  })

  it('session_error clears now and schedules NO sleep itself — the tick arms it next tick', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-e')
      managed.indicatorShown = true
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')

      startIndicatorTick(managed, 'sess-e')
      await processSSEEvent(managed, { type: 'session_error', apiErrorCode: null })
      expect(managed.indicatorShown).toBe(false)            // cleared instantly
      expect(managed.sleepTimer).toBeFalsy()                // handler scheduled nothing

      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)  // the tick arms the sleep
      expect(managed.sleepTimer).toBeTruthy()
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeFalsy()        // slept
    } finally {
      vi.useRealTimers()
    }
  })

  it('an auto-approved script_run card never sleeps the still-working session (BLOCKER)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-r')
      // Auto-approved host script: a card is broadcast but the session never goes
      // 'awaiting' — it stays 'working' while the script runs.
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')

      startIndicatorTick(managed, 'sess-r')
      await processSSEEvent(managed, { type: 'script_run_request', toolUseId: 'tu-1', autoApproved: true, script: 'npm test' })
      expect(managed.sleepTimer).toBeFalsy()           // handler schedules nothing…
      // …and every tick re-reads 'working', so the tick never arms a sleep at all.
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeTruthy()  // never stranded
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a real awaiting card lets the tick sleep (parked on the user, nothing to show)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-q')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('awaiting')

      startIndicatorTick(managed, 'sess-q')
      await processSSEEvent(managed, { type: 'user_question_request', toolUseId: 'tu-1', questions: [{ question: 'Which DB?' }] })
      expect(managed.sleepTimer).toBeFalsy()               // handler schedules nothing
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS)  // tick arms the sleep (awaiting = non-busy)
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeFalsy()        // slept while parked on the user
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── sanity: cancelIndicatorSleep ────────────────────────────────────────────────

describe('cancelIndicatorSleep', () => {
  it('clears a pending sleep and is safe to call when none is pending', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-c')
    cancelIndicatorSleep(managed) // no-op, no throw
    expect(managed.sleepTimer).toBeFalsy()

    // Paint something so a later non-busy reconcile has work — unrelated to sleep, just a
    // guard that reconcileIndicator stays importable/uncoupled from the sleep helpers.
    reconcileIndicator(managed, 'working')
    expect(managed.indicatorShown).toBe(true)
  })
})

// ── armIndicatorIfBusy: the shared arm-if-busy seam ─────────────────────────────
// This is the ONE primitive behind all three arm sites — subscribe, the per-event wake,
// and the health-check backstop — so pinning it here pins the rule they all rely on:
// the tick is armed iff the snapshot is busy, an idle snapshot holds zero timers, and a
// stray non-busy event neither arms a tick nor disturbs a pending sleep.

describe('armIndicatorIfBusy', () => {
  it('arms the tick AND paints immediately on a cold arm when busy (no ≤1s blank)', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-arm')
    armIndicatorIfBusy(managed, 'sess-arm', 'working')
    expect(managed.indicatorTickTimer).toBeTruthy()           // armed
    expect(connector.workingActivities).toEqual(['working'])  // painted now, not a tick later
    stopIndicatorTick(managed)
  })

  it('does NOT arm a tick when the snapshot is non-busy (no stray-event leak)', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-arm')
    armIndicatorIfBusy(managed, 'sess-arm', 'idle')
    armIndicatorIfBusy(managed, 'sess-arm', 'streaming')
    armIndicatorIfBusy(managed, 'sess-arm', 'awaiting')
    expect(managed.indicatorTickTimer).toBeFalsy()
    expect(connector.workingActivities).toEqual([])
  })

  it('a stray non-busy arm leaves a pending sleep intact (the tick still sleeps)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-arm')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')
      startIndicatorTick(managed, 'sess-arm')
      scheduleIndicatorSleep(managed)
      expect(managed.sleepTimer).toBeTruthy()

      armIndicatorIfBusy(managed, 'sess-arm', 'idle') // a stray non-busy event
      expect(managed.sleepTimer).toBeTruthy()         // sleep untouched → tick will still sleep

      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-arm or repaint when a tick already runs', () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-arm')
    armIndicatorIfBusy(managed, 'sess-arm', 'working')
    const handle = managed.indicatorTickTimer
    armIndicatorIfBusy(managed, 'sess-arm', 'thinking') // already running
    expect(managed.indicatorTickTimer).toBe(handle)            // same timer, not replaced
    expect(connector.workingActivities).toEqual(['working'])   // no second cold paint
    stopIndicatorTick(managed)
  })

  it('a busy arm cancels a pending sleep (re-activation keeps the tick alive)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-arm')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
      startIndicatorTick(managed, 'sess-arm')
      scheduleIndicatorSleep(managed)
      expect(managed.sleepTimer).toBeTruthy()

      armIndicatorIfBusy(managed, 'sess-arm', 'working') // re-activation
      expect(managed.sleepTimer).toBeFalsy()             // cancelled

      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeTruthy()    // never slept
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })
})
