# Chat Turn Control (`/stop` + stall nudge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give chat integrations an in-chat recovery for hung turns (`/stop`, sharing the app Stop button's interrupt path) plus a one-shot silence nudge that makes it discoverable, and make busy-`/clear` interrupt before archiving.

**Architecture:** A new leaf helper `interruptAgentSession(agentSlug, sessionId)` in `src/shared/lib/container/` is the single interrupt implementation; the existing API route becomes a thin wrapper and the chat manager calls it for `/stop` and busy-`/clear`. A per-chat silence timer (`stallNudgeTimer` on `ManagedConnector`) is armed at turn dispatch, reset synchronously on every SSE event before the serialization queue, cancelled on terminal events and teardown, and fires at most one nudge per turn after 7 minutes of total silence. The nudge never touches the indicator.

**Tech Stack:** TypeScript, Vitest (fake timers), existing chat-integration test harnesses (`sse-event-processing.test.ts` pattern, `chat-integration-e2e.test.ts` harness).

**Spec:** `.prompts/chat-turn-control-design.md` (same branch). Read it before starting.

## Global Constraints

- This is a git WORKTREE. Every Write/Edit MUST use absolute paths under `/Users/jeremybischoff/Desktop/SuperAgent/.claude/worktrees/feat+chat-turn-control/`. All paths below are relative to that root.
- NEVER run `npm run build` (breaks the dev server). Verify with `npm run typecheck` and `npm run lint`.
- Copy strings are LOCKED, verbatim, including emoji:
  - Nudge: `⏳ Still working on this. Could be a long-running step, or the turn might be stuck. If it looks hung, send /stop to reset it and try again.`
  - Stop ack: `⏹ Stopped. Send a message to start again.`
  - Idle ack: `⏹ Nothing is running right now.`
- No em dashes anywhere (copy, comments, commit messages). Use a plain dash.
- `STALL_NUDGE_MS = 7 * 60_000`. Hardcoded const, no setting.
- The nudge code paths MUST NOT call `startWorking`, `stopWorking`, `reconcileIndicator`, or `clearIndicator`. Do not modify `INDICATOR_TICK_MS`, `reconcileIndicator`, `clearIndicator`, or any existing clear site.
- `src/shared/lib/container/interrupt-session.ts` is a LEAF module: it must never be imported by `container-manager.ts` or `message-persister.ts`. The chat manager imports it via dynamic `await import(...)` (the existing idiom at `chat-integration-manager.ts:717`); the API route imports it statically.
- Match surrounding code style (comment density, naming, error handling). New comments explain WHY, in the file's existing voice.
- Commits: stage ONLY the files listed in the task. No co-author lines, no "Generated with" attribution.
- Vitest: run the targeted test files named in each task. The FULL unit suite has known pre-existing flakes (webhook/scheduler DB isolation); do not chase those.
- No new JSON persistence boundaries are introduced, so no new Zod schemas are needed.

## Deviation log

- 2026-07-06 (during Task 6, approved by Jeremy): all three gates corrected from `BUSY_ACTIVITIES` (indicator semantics) to turn-lifecycle semantics - `BUSY_ACTIVITIES` excludes `streaming`/`awaiting`, which made a mid-stream hang unstoppable and un-nudged.
Substitutions vs the code printed in Tasks 3-5: `stopChatTurn` and `clearChatSession` gate on `messagePersister.isSessionActive(sessionId)`; `onStallNudgeFired` re-checks `getSessionActivity(sessionId)` is not `'idle'` and not `'awaiting'`.
See the spec's "Gate semantics" section.

---

### Task 1: `interruptAgentSession` shared helper

**Files:**
- Create: `src/shared/lib/container/interrupt-session.ts`
- Test: `src/shared/lib/container/interrupt-session.test.ts`

**Interfaces:**
- Consumes: `containerManager.getClient(agentSlug)` / `containerManager.getCachedInfo(agentSlug)` (`./container-manager`), `messagePersister.markSessionInterrupted(sessionId)` (`./message-persister`), `reviewManager.denyAllForAgent(agentSlug)` (`@shared/lib/proxy/review-manager`).
- Produces: `interruptAgentSession(agentSlug: string, sessionId: string): Promise<InterruptOutcome>` where `export type InterruptOutcome = 'interrupted' | 'container-not-running' | 'error-settled-locally'`. Tasks 2, 4, 5 rely on exactly these names.

This is the interrupt route body (`src/api/routes/agents.ts:1925-1971`) factored out verbatim. The key property to preserve: it ALWAYS settles the session locally (`markSessionInterrupted` + `denyAllForAgent`), even on a wedged or dead container.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/lib/container/interrupt-session.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getClient = vi.fn()
const getCachedInfo = vi.fn()
vi.mock('./container-manager', () => ({
  containerManager: {
    getClient: (...args: unknown[]) => getClient(...args),
    getCachedInfo: (...args: unknown[]) => getCachedInfo(...args),
  },
}))

const markSessionInterrupted = vi.fn()
vi.mock('./message-persister', () => ({
  messagePersister: {
    markSessionInterrupted: (...args: unknown[]) => markSessionInterrupted(...args),
  },
}))

const denyAllForAgent = vi.fn()
vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    denyAllForAgent: (...args: unknown[]) => denyAllForAgent(...args),
  },
}))

import { interruptAgentSession } from './interrupt-session'

describe('interruptAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markSessionInterrupted.mockResolvedValue(undefined)
  })

  it('interrupts in the container and settles locally when running', async () => {
    const interruptSession = vi.fn().mockResolvedValue(true)
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'running' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(interruptSession).toHaveBeenCalledWith('session-1')
    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('interrupted')
  })

  it('settles locally without a container call when the container is not running', async () => {
    const interruptSession = vi.fn()
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'stopped' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(interruptSession).not.toHaveBeenCalled()
    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('container-not-running')
  })

  it('still settles locally when interruptSession returns false', async () => {
    const interruptSession = vi.fn().mockResolvedValue(false)
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'running' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('interrupted')
  })

  it('still settles locally when the container interrupt throws', async () => {
    const interruptSession = vi.fn().mockRejectedValue(new Error('wedged'))
    getClient.mockReturnValue({ interruptSession })
    getCachedInfo.mockReturnValue({ status: 'running' })

    const outcome = await interruptAgentSession('agent-1', 'session-1')

    expect(markSessionInterrupted).toHaveBeenCalledWith('session-1')
    expect(denyAllForAgent).toHaveBeenCalledWith('agent-1')
    expect(outcome).toBe('error-settled-locally')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/lib/container/interrupt-session.test.ts`
Expected: FAIL - cannot resolve `./interrupt-session`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/lib/container/interrupt-session.ts`:

```typescript
/**
 * Shared session-interrupt path - the app Stop button's implementation, factored
 * out of the interrupt route so chat /stop (and busy-/clear) reuse it exactly.
 *
 * The key property: it ALWAYS settles the session locally (markSessionInterrupted
 * + denyAllForAgent), even on a wedged or dead container, so the UI and the chat
 * indicator unstick no matter what the container does.
 *
 * LEAF module: must not be imported by container-manager or message-persister
 * (container-manager already imports message-persister, which lazy-imports back;
 * do not extend that graph).
 */

import { containerManager } from './container-manager'
import { messagePersister } from './message-persister'
import { reviewManager } from '@shared/lib/proxy/review-manager'

export type InterruptOutcome = 'interrupted' | 'container-not-running' | 'error-settled-locally'

export async function interruptAgentSession(agentSlug: string, sessionId: string): Promise<InterruptOutcome> {
  try {
    const client = containerManager.getClient(agentSlug)
    // Use cached status to avoid spawning a docker process
    const info = containerManager.getCachedInfo(agentSlug)

    // If the container isn't running, just mark the session as interrupted locally.
    // This handles the case where the container crashed/restarted but the UI still
    // shows the session active.
    if (info.status !== 'running') {
      console.log(`[InterruptSession] Container not running for ${agentSlug}, marking session ${sessionId} as interrupted locally`)
      await messagePersister.markSessionInterrupted(sessionId)
      reviewManager.denyAllForAgent(agentSlug)
      return 'container-not-running'
    }

    // Try to interrupt in the container
    const interrupted = await client.interruptSession(sessionId)

    // Even if the container interrupt fails (the session might not exist there
    // anymore), still mark it as interrupted locally to update the UI.
    if (!interrupted) {
      console.log(`[InterruptSession] Container interrupt returned false for session ${sessionId}, marking as interrupted locally`)
    }

    await messagePersister.markSessionInterrupted(sessionId)
    reviewManager.denyAllForAgent(agentSlug)
    return 'interrupted'
  } catch (error) {
    console.error('[InterruptSession] Failed to interrupt session:', error)
    // Even on error, settle locally to fix UI state. If THIS throws too, the
    // caller decides (the API route maps it to a 500).
    await messagePersister.markSessionInterrupted(sessionId)
    reviewManager.denyAllForAgent(agentSlug)
    return 'error-settled-locally'
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/container/interrupt-session.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/shared/lib/container/interrupt-session.ts src/shared/lib/container/interrupt-session.test.ts
git commit -m "feat(container): extract interruptAgentSession shared helper"
```

---

### Task 2: Interrupt route becomes a thin wrapper

**Files:**
- Modify: `src/api/routes/agents.ts:1925-1971` (the `POST /:id/sessions/:sessionId/interrupt` handler)
- Test: `src/api/routes/agents.test.ts` (existing tests must keep passing; do not add route tests - the helper's unit tests own the behavior)

**Interfaces:**
- Consumes: `interruptAgentSession`, `InterruptOutcome` from Task 1.
- Produces: identical HTTP responses to today (`{ success: true }`, `{ success: true, note: 'Container not running, session marked inactive' }`, `{ success: true, note: 'Error during interrupt, but session marked inactive' }`, or 500 `{ error: 'Failed to interrupt session' }`).

- [ ] **Step 1: Add the import**

In `src/api/routes/agents.ts`, next to the existing import at line 20 (`import { containerManager } from '@shared/lib/container/container-manager'`), add:

```typescript
import { interruptAgentSession } from '@shared/lib/container/interrupt-session'
```

- [ ] **Step 2: Replace the route body**

Replace the entire handler (currently `agents.ts:1925-1971`, from `agents.post('/:id/sessions/:sessionId/interrupt', ...)` through its closing `})`) with:

```typescript
// POST /api/agents/:id/sessions/:sessionId/interrupt - Interrupt an active session
agents.post('/:id/sessions/:sessionId/interrupt', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')

    const outcome = await interruptAgentSession(agentSlug, sessionId)

    if (outcome === 'container-not-running') {
      return c.json({ success: true, note: 'Container not running, session marked inactive' })
    }
    if (outcome === 'error-settled-locally') {
      return c.json({ success: true, note: 'Error during interrupt, but session marked inactive' })
    }
    return c.json({ success: true })
  } catch (error) {
    // Only reachable when even the helper's local settling threw.
    console.error('Failed to interrupt session:', error)
    return c.json({ error: 'Failed to interrupt session' }, 500)
  }
})
```

Note the behavior mapping from the old code: old "container not running" early-return → `'container-not-running'` note; old outer-catch-with-successful-fallback → `'error-settled-locally'` note (the helper does the fallback internally now); old outer-catch-with-failed-fallback → this catch → 500. Responses are identical for every path.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run src/api/routes/agents.test.ts`
Expected: typecheck clean; existing agents route tests pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/api/routes/agents.ts
git commit -m "refactor(api): interrupt route delegates to interruptAgentSession"
```

---

### Task 3: Stall-nudge timer state + helpers (unwired)

**Files:**
- Modify: `src/shared/lib/chat-integrations/chat-integration-manager.ts` (ManagedConnector at `:124-153`; new exported helpers after the indicator-tick helper block, near `stopIndicatorTick` at `:1610`)
- Test: Create `src/shared/lib/chat-integrations/stall-nudge.test.ts`

**Interfaces:**
- Consumes: `ManagedConnector`, `BUSY_ACTIVITIES`, `messagePersister.getSessionActivity(sessionId)` - all already in the manager module.
- Produces (exported from `chat-integration-manager.ts`; Tasks 4 and 6 rely on exactly these):
  - `STALL_NUDGE_MS: number` (= `7 * 60_000`)
  - `STALL_NUDGE_TEXT: string`
  - `armStallNudge(managed: ManagedConnector, sessionId: string): void`
  - `resetStallNudgeIfArmed(managed: ManagedConnector, sessionId: string): void`
  - `cancelStallNudge(managed: ManagedConnector): void`
  - New `ManagedConnector` fields: `stallNudgeTimer?: ReturnType<typeof setTimeout> | null`, `stallNotified?: boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/lib/chat-integrations/stall-nudge.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  armStallNudge,
  resetStallNudgeIfArmed,
  cancelStallNudge,
  STALL_NUDGE_MS,
  STALL_NUDGE_TEXT,
  type ManagedConnector,
} from './chat-integration-manager'
import { MockChatClientConnector } from './mock-connector'
import { messagePersister } from '@shared/lib/container/message-persister'
import type { ChatIntegration } from '@shared/lib/db/schema'

function createManagedConnector(overrides?: Partial<ManagedConnector>): ManagedConnector {
  const connector = new MockChatClientConnector()
  return {
    connector,
    integration: {
      id: 'test-integration',
      agentSlug: 'test-agent',
      provider: 'telegram',
      name: 'Test Bot',
      config: '{}',
      showToolCalls: false,
      status: 'active',
      errorMessage: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ChatIntegration,
    chatId: 'chat-123',
    sseUnsubscribe: null,
    messageUnsubscribe: null,
    interactiveUnsubscribe: null,
    errorUnsubscribe: null,
    streamingState: {
      currentMessageId: null,
      accumulatedText: '',
      lastUpdateTime: 0,
    },
    currentToolInput: '',
    pendingToolMessages: [],
    sessionId: 'session-1',
    ...overrides,
  }
}

function getMock(managed: ManagedConnector): MockChatClientConnector {
  return managed.connector as MockChatClientConnector
}

describe('stall nudge timer', () => {
  let activitySpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    activitySpy = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
  })

  afterEach(() => {
    vi.useRealTimers()
    activitySpy.mockRestore()
  })

  it('fires exactly one nudge after the silence threshold', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(1)
    expect(getMock(managed).sentMessages[0].message.text).toBe(STALL_NUDGE_TEXT)
    expect(managed.stallNotified).toBe(true)
  })

  it('reset defers firing - silence is measured from the last event', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS - 60_000)
    resetStallNudgeIfArmed(managed, 'session-1')
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS - 60_000)

    expect(getMock(managed).sentMessages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(getMock(managed).sentMessages).toHaveLength(1)
  })

  it('reset is a no-op when no timer is armed', () => {
    const managed = createManagedConnector()
    resetStallNudgeIfArmed(managed, 'session-1')
    expect(managed.stallNudgeTimer).toBeUndefined()
  })

  it('cancel prevents firing', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    cancelStallNudge(managed)

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS * 2)

    expect(getMock(managed).sentMessages).toHaveLength(0)
    expect(managed.stallNudgeTimer).toBeNull()
  })

  it('does not fire when the session is no longer busy at fire time', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    activitySpy.mockReturnValue('idle')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(0)
  })

  it('fires at most once per turn (latch survives a re-arm)', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)
    expect(getMock(managed).sentMessages).toHaveLength(1)

    armStallNudge(managed, 'session-1')
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(1)
  })

  it('does not fire for a stale session after a session swap', async () => {
    const managed = createManagedConnector({ sessionId: 'session-1' })
    armStallNudge(managed, 'session-1')
    managed.sessionId = 'session-2'

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(0)
  })

  it('keeps the latch set and does not throw when the send fails', async () => {
    const managed = createManagedConnector()
    vi.spyOn(managed.connector, 'sendMessage').mockRejectedValue(new Error('telegram down'))
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(managed.stallNotified).toBe(true)
  })

  it('never touches the indicator', async () => {
    const managed = createManagedConnector()
    const stopWorkingSpy = vi.spyOn(managed.connector, 'stopWorking')
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).workingActivities).toHaveLength(0)
    expect(stopWorkingSpy).not.toHaveBeenCalled()
    expect(managed.indicatorShown).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/lib/chat-integrations/stall-nudge.test.ts`
Expected: FAIL - `armStallNudge` (etc.) are not exported.

- [ ] **Step 3: Add the ManagedConnector fields**

In `chat-integration-manager.ts`, inside `ManagedConnector` (after the `turnNotified?: boolean` field at `:152`), add:

```typescript
  // Stall-nudge silence timer (see armStallNudge). Named to make its job
  // unmistakable: it NEVER paints or clears the indicator.
  stallNudgeTimer?: ReturnType<typeof setTimeout> | null
  // True once this turn's stall nudge has gone out, so a turn nudges at most once.
  stallNotified?: boolean
```

- [ ] **Step 4: Add the helpers**

In `chat-integration-manager.ts`, after `stopIndicatorTick` (`:1610` block, keeping the indicator helpers together but clearly separate), add:

```typescript
// ── Stall nudge ─────────────────────────────────────────────────────────
//
// A silence timer, NOT an indicator timer: armed at turn dispatch, reset on every
// SSE event (synchronously, before the serialization queue), cancelled on terminal
// events and teardown. After STALL_NUDGE_MS of total silence it sends ONE
// informational message pointing at /stop. It never paints or clears the
// indicator - that stays 100% tick-driven (PR B's invariant).

/** Silence threshold before the one-per-turn stall nudge. Generous so that most
 * legitimately-silent long tools (builds, installs, browser waits) finish first. */
export const STALL_NUDGE_MS = 7 * 60_000

/** Frames /stop as optional and never asserts the agent died: a silent-but-alive
 * tool past the threshold is expected, so a false positive must read as harmless. */
export const STALL_NUDGE_TEXT =
  '⏳ Still working on this. Could be a long-running step, or the turn might be stuck. If it looks hung, send /stop to reset it and try again.'

/**
 * (Re)arm the silence countdown for a turn. Captures sessionId so a fire after a
 * resubscribe/session swap is a no-op (checked against managed.sessionId).
 */
export function armStallNudge(managed: ManagedConnector, sessionId: string): void {
  if (managed.stallNudgeTimer) clearTimeout(managed.stallNudgeTimer)
  managed.stallNudgeTimer = setTimeout(() => onStallNudgeFired(managed, sessionId), STALL_NUDGE_MS)
}

/** Reset the countdown if one is armed - the every-SSE-event hook. An unarmed
 * managed session (turn already settled) stays unarmed. */
export function resetStallNudgeIfArmed(managed: ManagedConnector, sessionId: string): void {
  if (!managed.stallNudgeTimer) return
  armStallNudge(managed, sessionId)
}

/** Cancel outright: terminal events, /stop, teardown, resubscribe. */
export function cancelStallNudge(managed: ManagedConnector): void {
  if (managed.stallNudgeTimer) clearTimeout(managed.stallNudgeTimer)
  managed.stallNudgeTimer = null
}

function onStallNudgeFired(managed: ManagedConnector, sessionId: string): void {
  managed.stallNudgeTimer = null
  // Stale timer: the managed session moved on (resubscribe/swap). Never nudge
  // the old session.
  if (managed.sessionId !== sessionId) return
  // At most once per turn.
  if (managed.stallNotified) return
  // Re-read reality: only nudge a turn that is STILL busy, so a settled turn
  // whose cancel raced this fire stays silent.
  if (!BUSY_ACTIVITIES.has(messagePersister.getSessionActivity(sessionId))) return
  // Latch BEFORE sending: a missed nudge is cheaper than a double nudge (the
  // deliberate opposite of the session_error notice, which re-opens its latch
  // on delivery failure).
  managed.stallNotified = true
  managed.connector.sendMessage(managed.chatId, { text: STALL_NUDGE_TEXT }).catch((err) => {
    console.error('[ChatIntegrationManager] Failed to send stall nudge:', err)
  })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/chat-integrations/stall-nudge.test.ts`
Expected: 9 passed.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/shared/lib/chat-integrations/chat-integration-manager.ts src/shared/lib/chat-integrations/stall-nudge.test.ts
git commit -m "feat(chat): stall-nudge timer state and helpers (unwired)"
```

---

### Task 4: `/stop` command

**Files:**
- Modify: `src/shared/lib/chat-integrations/chat-integration-manager.ts` (command block at `:711-714`; new private method next to `clearChatSession` at `:997`)
- Test: `src/shared/lib/chat-integrations/chat-integration-e2e.test.ts` (extend the container-manager mock; new describe block)

**Interfaces:**
- Consumes: `interruptAgentSession` (Task 1, via dynamic import), `cancelStallNudge` (Task 3), `BUSY_ACTIVITIES`, `getChatIntegrationSession`, `messagePersister.getSessionActivity` - all already importable in the manager.
- Produces: `/stop` handling for all providers; `private stopChatTurn(integration, chatId, connector)`.

- [ ] **Step 1: Extend the e2e harness mocks**

In `chat-integration-e2e.test.ts`, replace the container-manager mock (currently only `ensureRunning`):

```typescript
// Mock the container manager — returns our mock client
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: vi.fn(),
    getClient: vi.fn(),
    getCachedInfo: vi.fn(),
  },
}))
```

In the imports-after-mocks section, add:

```typescript
import { messagePersister } from '@shared/lib/container/message-persister'
```

In `beforeEach`, after `(containerManager.ensureRunning as any).mockResolvedValue(mockContainerClient)`, add:

```typescript
    ;(containerManager.getClient as any).mockReturnValue(mockContainerClient)
    ;(containerManager.getCachedInfo as any).mockReturnValue({ status: 'running' })
```

- [ ] **Step 2: Write the failing tests**

Add a new describe block to `chat-integration-e2e.test.ts` (sibling of `'incoming message flow'`):

```typescript
  describe('/stop command', () => {
    async function startConversation(integrationId: string): Promise<string> {
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      // Wait on the DB mapping itself (created AFTER the container call, so
      // createSessionCalls is not the right sync point), then let the mock turn
      // fully settle so no late scenario event races the test body (e.g. a
      // trailing session_idle un-doing a simulated hang).
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-1'))
      await waitForCondition(() =>
        mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0, 3000)
      return listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-1')!.sessionId
    }

    it('interrupts an active turn, settles the session, and acks', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)

      // Simulate a hung turn: active in the persister, no terminal event coming
      messagePersister.markSessionActive(sessionId, 'test-agent')
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

      expect(interruptSpy).toHaveBeenCalledWith(sessionId)
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
      // The conversation mapping survives (unlike /clear)
      expect(listChatIntegrationSessions(integrationId)).toHaveLength(1)
    })

    it('acks gracefully when nothing is running', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Nothing is running right now.'))

      expect(interruptSpy).not.toHaveBeenCalled()
      // No session was created by the command
      expect(MockContainerClient.createSessionCalls).toHaveLength(0)
    })

    it('is blocked by the access gate for a non-approved chat', async () => {
      const integrationId = createTestIntegration()
      // Re-enable the approval gate that createTestIntegration disables
      testSqlite.prepare('UPDATE chat_integrations SET require_approval = 1 WHERE id = ?').run(integrationId)
      await chatIntegrationManager.addIntegration(integrationId)
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      // Let the (gated) handler drain
      await new Promise(r => setTimeout(r, 100))

      expect(interruptSpy).not.toHaveBeenCalled()
      expect(mockConnector.sentMessages.some(m => m.message.text?.includes('Stopped'))).toBe(false)
    })

    it('settles locally when the container is not running', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)

      messagePersister.markSessionActive(sessionId, 'test-agent')
      ;(containerManager.getCachedInfo as any).mockReturnValue({ status: 'stopped' })
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

      expect(interruptSpy).not.toHaveBeenCalled()
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    })
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/shared/lib/chat-integrations/chat-integration-e2e.test.ts`
Expected: the new `/stop` tests FAIL (no `/stop` handling; the text is forwarded to the agent instead). Pre-existing tests still pass.

- [ ] **Step 4: Wire the command**

In `chat-integration-manager.ts`, directly after the `/clear` block (`:711-714`), add:

```typescript
    // Handle /stop command — interrupt the in-flight turn, keep the conversation
    if (message.text.trim().toLowerCase() === '/stop') {
      await this.stopChatTurn(integration, chatId, conn.connector)
      return
    }
```

Add the method next to `clearChatSession` (`:997`):

```typescript
  /**
   * /stop — interrupt the chat's in-flight turn via the app Stop button's shared
   * path (interruptAgentSession always settles locally, even on a wedged
   * container). Unlike /clear, the session mapping survives: the next message
   * runs as a fresh turn in the same conversation. The whole in-flight turn is
   * discarded, including container-queued mid-turn messages.
   */
  private async stopChatTurn(
    integration: ChatIntegration,
    chatId: string,
    connector: ChatClientConnector,
  ): Promise<void> {
    const chatSession = getChatIntegrationSession(integration.id, chatId)
    const sessionId = chatSession?.sessionId
    if (!sessionId || !BUSY_ACTIVITIES.has(messagePersister.getSessionActivity(sessionId))) {
      await connector.sendMessage(chatId, { text: '⏹ Nothing is running right now.' }).catch(() => {})
      return
    }

    const managed = this.chatSessions.get(this.getChatSessionKey(integration.id, chatId))
    if (managed) {
      // The stop ack is this turn's terminal notice: a stale session_error may
      // already sit in the SSE queue, and the turnNotified latch keeps it from
      // sending a second, contradictory one.
      managed.turnNotified = true
      cancelStallNudge(managed)
    }

    // Lazy import, same idiom as the send path's container-manager import.
    const { interruptAgentSession } = await import('@shared/lib/container/interrupt-session')
    await interruptAgentSession(integration.agentSlug, sessionId)
    await connector.sendMessage(chatId, { text: '⏹ Stopped. Send a message to start again.' }).catch(() => {})
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/chat-integrations/chat-integration-e2e.test.ts`
Expected: all pass, including the four new `/stop` cases.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/shared/lib/chat-integrations/chat-integration-manager.ts src/shared/lib/chat-integrations/chat-integration-e2e.test.ts
git commit -m "feat(chat): /stop command interrupts the active turn"
```

---

### Task 5: Busy-`/clear` interrupts before archiving

**Files:**
- Modify: `src/shared/lib/chat-integrations/chat-integration-manager.ts` (`clearChatSession` at `:997-1015`)
- Test: `src/shared/lib/chat-integrations/chat-integration-e2e.test.ts`

**Interfaces:**
- Consumes: `interruptAgentSession` (dynamic import), `BUSY_ACTIVITIES`, `messagePersister.getSessionActivity`.
- Produces: no new surface; `/clear` semantics become "stop + forget".

- [ ] **Step 1: Write the failing test**

Add to the `/stop command` describe block's sibling level (inside `describe('Chat integration E2E', ...)`):

```typescript
  describe('/clear on a busy session', () => {
    it('interrupts the running turn before archiving', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      // Same deterministic setup as the /stop tests: wait on the DB mapping,
      // then let the mock turn settle before simulating the hang.
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-1'))
      await waitForCondition(() =>
        mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0, 3000)
      const sessionId = listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-1')!.sessionId

      messagePersister.markSessionActive(sessionId, 'test-agent')
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/clear', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text?.includes('Session cleared')))

      // Stop first: the turn must not keep running orphaned after the mapping is archived
      expect(interruptSpy).toHaveBeenCalledWith(sessionId)
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
      // And the clear still archived the mapping
      expect(listChatIntegrationSessions(integrationId)).toHaveLength(0)
    })
  })
```

Note: `listChatIntegrationSessions` returns non-archived sessions; if the existing harness helper filters differently, assert archival the same way the existing `/clear` test in this file does (mirror it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/chat-integrations/chat-integration-e2e.test.ts`
Expected: new test FAILS on `interruptSpy` (today `/clear` never interrupts).

- [ ] **Step 3: Implement**

In `clearChatSession` (`:997`), extend the existing `try` block. Current code:

```typescript
    try {
      const chatSession = getChatIntegrationSession(integrationId, chatId)
      if (chatSession) {
        this.teardownManagedSession(integrationId, chatId, { archive: chatSession.id })
      }
    } catch (err) {
```

becomes:

```typescript
    try {
      const chatSession = getChatIntegrationSession(integrationId, chatId)
      if (chatSession) {
        // Clear = stop + forget: without the interrupt, a busy turn keeps running
        // orphaned in the container (burning tokens with nowhere to deliver) after
        // the mapping is archived. Same shared path as /stop. Best-effort in its
        // own try so a failed interrupt can never block the archive below.
        if (BUSY_ACTIVITIES.has(messagePersister.getSessionActivity(chatSession.sessionId))) {
          try {
            const integration = getChatIntegration(integrationId)
            if (integration) {
              const { interruptAgentSession } = await import('@shared/lib/container/interrupt-session')
              await interruptAgentSession(integration.agentSlug, chatSession.sessionId)
            }
          } catch (err) {
            console.error('[ChatIntegrationManager] Failed to interrupt before clear:', err)
            reportError(err, 'clear-session-interrupt', { integrationId, chatId })
          }
        }
        this.teardownManagedSession(integrationId, chatId, { archive: chatSession.id })
      }
    } catch (err) {
```

(`getChatIntegration` and `reportError` are already imported at the top of the manager. The inner catch keeps the interrupt best-effort: a wedged interrupt must not stop the clear from archiving.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/chat-integrations/chat-integration-e2e.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/shared/lib/chat-integrations/chat-integration-manager.ts src/shared/lib/chat-integrations/chat-integration-e2e.test.ts
git commit -m "feat(chat): /clear interrupts a busy turn before archiving"
```

---

### Task 6: Wire the stall nudge into the turn lifecycle

**Files:**
- Modify: `src/shared/lib/chat-integrations/chat-integration-manager.ts` (five wiring sites, below)
- Test: `src/shared/lib/chat-integrations/sse-event-processing.test.ts`
- Test: `src/shared/lib/chat-integrations/chat-integration-e2e.test.ts` (end-to-end nudge cases)

**Interfaces:**
- Consumes: `armStallNudge`, `resetStallNudgeIfArmed`, `cancelStallNudge` (Task 3).
- Produces: the nudge is live end to end. No new exports.

The five sites (all in `chat-integration-manager.ts`; line anchors are pre-task and will have drifted slightly by now - locate by the quoted code):

- [ ] **Step 1: Write the failing tests**

Add to `sse-event-processing.test.ts` (using its existing `createManagedConnector` helper; add `armStallNudge` and `cancelStallNudge` to the existing import from `./chat-integration-manager`):

```typescript
describe('stall nudge lifecycle in processSSEEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('session_idle cancels an armed stall-nudge timer', async () => {
    const managed = createManagedConnector({ sessionId: 'session-1' })
    armStallNudge(managed, 'session-1')

    await processSSEEvent(managed, { type: 'session_idle' })

    expect(managed.stallNudgeTimer).toBeNull()
  })

  it('session_error cancels an armed stall-nudge timer', async () => {
    const managed = createManagedConnector({ sessionId: 'session-1' })
    armStallNudge(managed, 'session-1')

    await processSSEEvent(managed, { type: 'session_error', apiErrorCode: null })

    expect(managed.stallNudgeTimer).toBeNull()
  })

  it('does not send an error notice when turnNotified was already set (e.g. by /stop)', async () => {
    const managed = createManagedConnector({ turnNotified: true })

    await processSSEEvent(managed, { type: 'session_error', apiErrorCode: null })

    expect(getMock(managed).sentMessages).toHaveLength(0)
  })
})
```

(If an identical `turnNotified` suppression assertion already exists in this file, keep the existing one and skip the duplicate.)

Also add end-to-end nudge tests to `chat-integration-e2e.test.ts`. These prove the WIRING (arm at dispatch, silence fires, `/stop` cancels), which the unit tests cannot. Add to the imports-after-mocks section:

```typescript
import { STALL_NUDGE_MS, STALL_NUDGE_TEXT } from './chat-integration-manager'
import { SlowWorkScenario } from '@shared/lib/container/mock-container-client'
```

New describe block (sibling of `'/stop command'`):

```typescript
  describe('stall nudge end-to-end', () => {
    // A turn that opens with a couple of stream events (10ms/50ms) then goes
    // COMPLETELY silent for an hour - the hung-turn signature. Registered per
    // test so it can't leak into other suites.
    beforeEach(() => {
      MockContainerClient.scenarios.set('hang forever', new SlowWorkScenario(60 * 60_000))
    })
    afterEach(() => {
      MockContainerClient.scenarios.delete('hang forever')
    })

    it('nudges exactly once after the silence threshold on a hung turn', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      vi.useFakeTimers()
      try {
        mockConnector.simulateIncomingMessage('hang forever', 'chat-1', 'user-1')
        // Drive dispatch + the scenario's opening events (10ms/50ms)
        await vi.advanceTimersByTimeAsync(1000)
        expect(MockContainerClient.createSessionCalls.length).toBeGreaterThan(0)

        // 7 minutes of total silence → exactly one nudge, with the locked copy
        await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)
        expect(mockConnector.sentMessages.filter(m => m.message.text === STALL_NUDGE_TEXT)).toHaveLength(1)

        // Latch: another full silence window never produces a second nudge
        await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)
        expect(mockConnector.sentMessages.filter(m => m.message.text === STALL_NUDGE_TEXT)).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('/stop cancels the pending nudge', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      vi.useFakeTimers()
      try {
        mockConnector.simulateIncomingMessage('hang forever', 'chat-1', 'user-1')
        await vi.advanceTimersByTimeAsync(1000)

        mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
        await vi.advanceTimersByTimeAsync(1000)
        expect(mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.')).toBe(true)

        // Well past the threshold: the cancelled timer must never fire
        await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS * 2)
        expect(mockConnector.sentMessages.some(m => m.message.text === STALL_NUDGE_TEXT)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/lib/chat-integrations/sse-event-processing.test.ts src/shared/lib/chat-integrations/chat-integration-e2e.test.ts`
Expected: the two cancel tests FAIL (`stallNudgeTimer` still set); the nudge-fires e2e test FAILS (nothing arms the timer yet); the `/stop`-cancels test PASSES vacuously (no nudge exists at all yet) - it becomes meaningful once Step 3 lands, guarded by the nudge-fires test proving arming works. The suppression test may already pass.

- [ ] **Step 3: Wire the five sites**

**Site 1 - terminal events.** In `processSSEEvent`, add `cancelStallNudge(managed)` as the first line of BOTH the `session_idle` case and the `session_error` case:

```typescript
    case 'session_idle': {
      // Turn ended → settle the indicator instantly, then finalize the streamed text.
      // The tick sleeps itself once it reads the now-idle state.
      cancelStallNudge(managed)
      clearIndicator(managed)
      await finalizeTurn(managed)
      break
    }
```

(and the same one-liner at the top of `session_error`, before its `clearIndicator(managed)`.)

**Site 2 - synchronous reset on every event.** In `subscribeChatSession`'s `addSSEClient` callback, after the `armIndicatorIfBusy(...)` line and before `this.enqueueSSEEvent(...)`:

```typescript
      // Any event is a sign of life: re-arm the stall-nudge silence countdown.
      // Synchronous and BEFORE the queue, same reasoning as the wake above - a
      // backed-up handler must not let the nudge fire while events are arriving.
      resetStallNudgeIfArmed(session, sessionId)
```

**Site 3 - resubscribe cleanup.** In `subscribeChatSession`, the cleanup lines:

```typescript
    // Clean up any previous subscription + its indicator tick
    session.sseUnsubscribe?.()
    stopIndicatorTick(session)
```

become:

```typescript
    // Clean up any previous subscription + its indicator tick + any stall timer
    // (a session swap must not leave a stale countdown running)
    session.sseUnsubscribe?.()
    stopIndicatorTick(session)
    cancelStallNudge(session)
```

**Site 4 - teardown.** In `stopSession`, after its `stopIndicatorTick(session)` line, add:

```typescript
    cancelStallNudge(session)
```

**Site 5 - arm at both dispatch points.** In the existing-session send path, the post-dispatch block:

```typescript
    const dispatched = this.chatSessions.get(this.getChatSessionKey(integrationId, chatId))
    if (dispatched) {
      // New user turn: re-allow exactly one terminal notice (the session_error
      // message). Reset here, once per turn, so a single multi-segment turn can't
      // emit repeated notices.
      dispatched.turnNotified = false
    }
```

becomes:

```typescript
    const dispatched = this.chatSessions.get(this.getChatSessionKey(integrationId, chatId))
    if (dispatched) {
      // New user turn: re-allow exactly one terminal notice (the session_error
      // message). Reset here, once per turn, so a single multi-segment turn can't
      // emit repeated notices.
      dispatched.turnNotified = false
      // Same once-per-turn contract for the stall nudge, then start its countdown.
      dispatched.stallNotified = false
      armStallNudge(dispatched, sessionId)
    }
```

And in `startNewChatSession`, after `this.subscribeChatSession(integration.id, chatId, sessionId)` (its final line), add:

```typescript
    const managed = this.chatSessions.get(this.getChatSessionKey(integration.id, chatId))
    if (managed) {
      // First turn of a fresh session: start the stall-nudge countdown.
      managed.stallNotified = false
      armStallNudge(managed, sessionId)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/chat-integrations/sse-event-processing.test.ts src/shared/lib/chat-integrations/stall-nudge.test.ts src/shared/lib/chat-integrations/chat-integration-e2e.test.ts`
Expected: all pass.

- [ ] **Step 5: Structural check on the reset placement**

Run: `grep -n "resetStallNudgeIfArmed" src/shared/lib/chat-integrations/chat-integration-manager.ts`
Expected: exactly two hits - the exported function definition, and the call inside `subscribeChatSession`'s `addSSEClient` callback. It must NOT appear inside `processSSEEvent` (behind the serialization queue, where a backed-up handler could false-fire the nudge).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/shared/lib/chat-integrations/chat-integration-manager.ts src/shared/lib/chat-integrations/sse-event-processing.test.ts src/shared/lib/chat-integrations/chat-integration-e2e.test.ts
git commit -m "feat(chat): wire stall nudge into dispatch, SSE, and teardown lifecycle"
```

---

### Task 7: Full verification sweep

**Files:** none (verification only; fix-forward commits if anything is red).

- [ ] **Step 1: Full chat-integration + container + routes test pass**

Run: `npx vitest run src/shared/lib/chat-integrations src/shared/lib/container/interrupt-session.test.ts src/api/routes/agents.test.ts 2>&1 | tee /tmp/turn-control-tests.txt`
Expected: all pass. (Do not run the full unit suite as the gate - it has known pre-existing webhook/scheduler DB-isolation flakes.)

- [ ] **Step 2: Typecheck + lint over everything**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Spec conformance check**

Re-read `.prompts/chat-turn-control-design.md`'s test matrix (14 cases) and confirm each maps to a passing test:
- Cases 1-4 → Task 4 e2e tests
- Case 5 → Task 6 e2e "nudges exactly once after the silence threshold" (wiring) + stall-nudge unit "fires exactly one nudge" (helper)
- Case 6 → "reset defers firing" (unit) + Task 6 Step 5 structural check (reset placement)
- Case 7 → "never touches the indicator"
- Case 8 → "at most once per turn" (unit) + the latch assertion inside the Task 6 e2e nudge test
- Case 9 → "cancel prevents firing" + "not busy at fire time"
- Case 10 → Task 6 e2e "/stop cancels the pending nudge" (explicit)
- Case 11 → Task 5 e2e test
- Case 12 → Task 6 suppression test (+ `/stop` sets the latch, Task 4 Step 4)
- Case 13 → "keeps the latch set... when the send fails"
- Case 14 → "stale session after a session swap"

- [ ] **Step 4: Report**

Summarize green results. Remaining pre-PR work (NOT part of this plan's execution): manual smoke on a real Telegram integration, whole-branch review, then `git rm` both `.prompts/` docs and revert any `package-lock.json` churn before opening the PR.
