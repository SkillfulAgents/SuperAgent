/**
 * Indicator sleep/wake: the tick stops after a lull and re-arms on any event, so an
 * idle session holds ZERO per-session timers without ever stranding a busy one.
 *
 * Invariants under test (each maps to an adversarial-review finding):
 *  - CREATE-IF-ABSENT: a wake never restarts a running tick (else a fast event burst
 *    would keep resetting the interval and starve it — the draft would expire mid-turn).
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

      startIndicatorTick(managed, 'sess-s')
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

describe('processSSEEvent drives sleep through the settle handlers', () => {
  it('session_idle schedules a sleep that stops the tick after the debounce', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-i')
      managed.indicatorShown = true
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('idle')

      startIndicatorTick(managed, 'sess-i')             // tick armed (mid-turn)
      await processSSEEvent(managed, { type: 'session_idle' })  // settle → schedules sleep
      expect(managed.sleepTimer).toBeTruthy()

      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeFalsy() // slept
    } finally {
      vi.useRealTimers()
    }
  })

  it('an auto-approved script_run card does NOT sleep the still-working session (BLOCKER)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-r')
      // Auto-approved host script: a card is broadcast but the session never goes
      // 'awaiting' — it stays 'working' while the script runs.
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')

      startIndicatorTick(managed, 'sess-r')
      await processSSEEvent(managed, { type: 'script_run_request', toolUseId: 'tu-1', autoApproved: true, script: 'npm test' })
      // The card handler cleared + scheduled a sleep, but the guard re-reads 'working'…
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeTruthy() // …so the tick is never stranded
      stopIndicatorTick(managed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a real awaiting card sleeps the tick (idle-on-the-user, nothing to show)', async () => {
    vi.useFakeTimers()
    try {
      const connector = new MockChatClientConnector()
      const managed = makeManaged(connector, 'chat-q')
      vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('awaiting')

      startIndicatorTick(managed, 'sess-q')
      await processSSEEvent(managed, { type: 'user_question_request', toolUseId: 'tu-1', questions: [{ question: 'Which DB?' }] })
      await vi.advanceTimersByTimeAsync(INDICATOR_SLEEP_MS)
      expect(managed.indicatorTickTimer).toBeFalsy() // slept while parked on the user
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
