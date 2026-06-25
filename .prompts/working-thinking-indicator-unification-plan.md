# Unified working/"thinking" indicator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Drive the chat working/"thinking" indicator off the generic session-lifecycle signals (one source of truth) instead of a per-request-type allowlist, so it settles honestly on idle / error / awaiting-input across every provider and new request types are handled automatically.

**Architecture:** Signal-layer unification. `message-persister` emits `session_awaiting_input` on the per-session SSE stream (today global-only) whenever the agent waits on a human; the chat-integration-manager settles its indicator on that signal (plus the existing `session_idle` / `session_error`) and stops gating the indicator on the eight `*_request` event types. Connectors and the app are untouched. The #308 idle watchdog stays as the stall backstop.

**Tech Stack:** TypeScript, Node, Vitest. Files under `src/shared/lib/`. Test harness: `MockChatClientConnector` + a stubbed `TelegramConnector` (see `perpetual-thinking.repro.test.ts`).

## Global Constraints

- Do NOT run `npm run build` (breaks the dev server). Verify with `npm run typecheck` and `npm run lint`.
- Tee long test output: `... 2>&1 | tee /tmp/<name>.txt`.
- Validate any JSON crossing a DB/file boundary with a Zod schema (not relevant to this change — no new persisted JSON).
- The design doc is `.prompts/working-thinking-indicator-unification-design.md`; `git rm` both `.prompts/*` files before the PR.
- Push with `git push upstream HEAD:refactor/chat-integration-working-thinking`. Base `main`.

## File structure

- Modify: `src/shared/lib/container/message-persister.ts` — `markSessionAwaitingInput` (per-session emit), `handleBrowserInputRequestTool` (subagent awaiting fix). Promotion re-emit stays untouched (global-only).
- Modify: `src/shared/lib/chat-integrations/chat-integration-manager.ts` — extract `settleIndicator`, add `session_awaiting_input` case, drop `clearWorkingWatchdog` from the `*_request` cases, verify re-arm on `handleInteractiveResponse`.
- Test: `src/shared/lib/container/message-persister.test.ts` — backend emission tests.
- Test: `src/shared/lib/chat-integrations/perpetual-thinking.repro.test.ts` — extend with indicator-settle-on-awaiting tests; update the watchdog-pause test. (Or a sibling `indicator-unification.test.ts` if cleaner; match existing style.)

---

### Task 1: Backend — emit `session_awaiting_input` on the per-session SSE stream

**Files:**
- Modify: `src/shared/lib/container/message-persister.ts:587-602` (`markSessionAwaitingInput`)
- Test: `src/shared/lib/container/message-persister.test.ts`

**Interfaces:**
- Produces: a `{ type: 'session_awaiting_input', sessionId, agentSlug }` event delivered to BOTH per-session SSE subscribers (`addSSEClient`) and global subscribers, on the first awaiting transition per turn (idempotent via `state.isAwaitingInput`).

- [ ] **Step 1: Write the failing test.** In `message-persister.test.ts`, match the existing harness (how it constructs the persister and drives a tool-use through the stream processor). Register an `addSSEClient(sessionId, cb)` subscriber, drive an `AskUserQuestion` (or `mcp__user-input__request_*`) tool-use through the public stream-processing path, and assert the per-session subscriber received an event with `type: 'session_awaiting_input'`. If a direct driver isn't available, assert via the smallest public seam that reaches `markSessionAwaitingInput`.

```ts
it('emits session_awaiting_input on the per-session SSE stream when the agent awaits input', async () => {
  const received: any[] = []
  persister.addSSEClient(sessionId, (e) => received.push(e))
  // ...drive an AskUserQuestion tool_use for `sessionId` through the stream processor...
  expect(received.some((e) => e?.type === 'session_awaiting_input')).toBe(true)
})
```

- [ ] **Step 2: Run it, verify it FAILS** (today the event is global-only).

Run: `npx vitest run src/shared/lib/container/message-persister.test.ts -t "per-session" 2>&1 | tee /tmp/t1.txt`
Expected: FAIL — no `session_awaiting_input` on the per-session stream.

- [ ] **Step 3: Implement.** In `markSessionAwaitingInput`, dual-broadcast the payload; leave `promoteAutomatedSession` untouched.

```ts
private markSessionAwaitingInput(sessionId: string): void {
  const state = this.streamingStates.get(sessionId)
  if (state && !state.isAwaitingInput) {
    state.isAwaitingInput = true
    const payload = { type: 'session_awaiting_input', sessionId, agentSlug: state.agentSlug }
    // Per-session SSE so the chat-integration-manager (a per-session subscriber)
    // can settle its working indicator off the generic signal. Global stays for
    // the sidebar/promotion consumers.
    this.broadcastToSSE(sessionId, payload)
    this.broadcastGlobal(payload)
    if (state.agentSlug) {
      this.promoteAutomatedSession(sessionId, state.agentSlug).catch((err) => {
        console.error('[MessagePersister] Failed to promote automated session:', err)
      })
    }
  }
}
```

- [ ] **Step 4: Run it, verify it PASSES.** Also add/keep an assertion that a global subscriber still receives the event (no regression).

Run: `npx vitest run src/shared/lib/container/message-persister.test.ts 2>&1 | tee /tmp/t1.txt`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/shared/lib/container/message-persister.ts src/shared/lib/container/message-persister.test.ts
git commit -m "feat(chat): emit session_awaiting_input on the per-session SSE stream"
```

---

### Task 2: Backend — raise awaiting for subagent browser-input (close the codex gap)

**Files:**
- Modify: `src/shared/lib/container/message-persister.ts:2570-2600` (`handleBrowserInputRequestTool`)
- Test: `src/shared/lib/container/message-persister.test.ts`

**Why:** `handleBrowserInputRequestTool` broadcasts `browser_input_request` (`:2591`) but the generic awaiting mark only lives on the main stream path (`:1719`). Subagent/sidechain call sites (`:1312`, `:1435`) therefore emit the card without raising awaiting — a stuck-indicator gap once the per-type watchdog-clear is dropped in Task 3. Marking awaiting inside the handler covers all three call sites and structurally co-locates "emit card" with "mark awaiting." Idempotent, so the main-path double-mark is harmless.

**Interfaces:**
- Produces: `session_awaiting_input` (per-session + global, via Task 1) for every `browser_input_request`, including subagent ones.

- [ ] **Step 1: Write the failing test.** Drive the subagent/sidechain browser-input path (or call the handler through the smallest available seam) for `sessionId` and assert a per-session subscriber receives `session_awaiting_input`.

```ts
it('raises session_awaiting_input for a subagent browser_input_request', async () => {
  const received: any[] = []
  persister.addSSEClient(sessionId, (e) => received.push(e))
  // ...drive a subagent browser_input_request for `sessionId`...
  expect(received.some((e) => e?.type === 'browser_input_request')).toBe(true)
  expect(received.some((e) => e?.type === 'session_awaiting_input')).toBe(true)
})
```

- [ ] **Step 2: Run it, verify it FAILS** (awaiting not raised on the subagent path today).

Run: `npx vitest run src/shared/lib/container/message-persister.test.ts -t "subagent" 2>&1 | tee /tmp/t2.txt`
Expected: FAIL — `browser_input_request` present, `session_awaiting_input` absent.

- [ ] **Step 3: Implement.** Inside `handleBrowserInputRequestTool`, after the `browser_input_request` broadcast, add `this.markSessionAwaitingInput(sessionId)`. Confirm the subagent call sites (`:1312`, `:1435`) pass the PARENT `sessionId` (the chat-attached session), not a subagent id; if they pass a child id, mark the parent.

- [ ] **Step 4: Run it, verify it PASSES.**

Run: `npx vitest run src/shared/lib/container/message-persister.test.ts 2>&1 | tee /tmp/t2.txt`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/shared/lib/container/message-persister.ts src/shared/lib/container/message-persister.test.ts
git commit -m "fix(chat): mark awaiting input for subagent browser_input_request"
```

---

### Task 3: Chat manager — settle the indicator off the signal, drop the per-type allowlist

**Files:**
- Modify: `src/shared/lib/chat-integrations/chat-integration-manager.ts` — `settleTurn` (~:1442), add `settleIndicator`, add `session_awaiting_input` case (~:1686), drop `clearWorkingWatchdog` from the `*_request` cases (~:1666-1684)
- Test: `src/shared/lib/chat-integrations/perpetual-thinking.repro.test.ts`

**Interfaces:**
- Consumes: `MockChatClientConnector` (`.stoppedWorking: string[]`, `.sentMessages`), `makeManaged(connector, chatId)`, `processSSEEvent(managed, event)` — all from the existing repro test.
- Produces: `settleIndicator(managed: ManagedConnector): void` = `stopWorking` + `clearWorkingWatchdog`.

- [ ] **Step 1: Write the failing tests** (extend `perpetual-thinking.repro.test.ts`).

```ts
describe('indicator settles on session_awaiting_input (generic, no per-type case)', () => {
  it('Mock: session_awaiting_input stops the working indicator', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-await')
    await processSSEEvent(managed, { type: 'stream_start' })           // arm
    await processSSEEvent(managed, { type: 'session_awaiting_input', sessionId: 's', agentSlug: 'a' })
    expect(connector.stoppedWorking).toContain('chat-await')
  })

  it('OPEN/CLOSED: an UNKNOWN request type still settles via session_awaiting_input — no allowlist entry', async () => {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-new')
    await processSSEEvent(managed, { type: 'stream_start' })           // arm
    // A brand-new request type the manager does NOT enumerate:
    await processSSEEvent(managed, { type: 'slack_write_request', toolUseId: 'tu-x' })
    // message-persister raises the generic signal for it; the manager settles on that, not the type:
    await processSSEEvent(managed, { type: 'session_awaiting_input', sessionId: 's', agentSlug: 'a' })
    expect(connector.stoppedWorking).toContain('chat-new')
  })

  it('Telegram: session_awaiting_input tears down the keep-alive heartbeat', async () => {
    vi.useFakeTimers()
    try {
      const { connector, sendRichMessageDraft } = makeRealDmConnector()
      const managed = makeManaged(connector, DM_CHAT)
      await connector.startWorking(DM_CHAT)
      await processSSEEvent(managed, { type: 'session_awaiting_input', sessionId: 's', agentSlug: 'a' })
      const at = sendRichMessageDraft.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sendRichMessageDraft.mock.calls.length).toBe(at)   // no more "Thinking…"
    } finally { vi.useRealTimers() }
  })
})
```

- [ ] **Step 2: Run them, verify they FAIL** (no `session_awaiting_input` case today → indicator never settles on it).

Run: `npx vitest run src/shared/lib/chat-integrations/perpetual-thinking.repro.test.ts -t "session_awaiting_input" 2>&1 | tee /tmp/t3.txt`
Expected: FAIL.

- [ ] **Step 3: Implement.** Add the helper, route `settleTurn` through it, add the case, drop the per-type watchdog-clear.

```ts
/** Settle the visible working indicator: stop the per-provider heartbeat and
 *  disarm the idle watchdog. Idempotent, provider-agnostic. The one primitive
 *  every "agent is no longer actively working" path goes through. */
function settleIndicator(managed: ManagedConnector): void {
  managed.connector.stopWorking(managed.chatId).catch(() => {})
  clearWorkingWatchdog(managed)
}
```

In `settleTurn`, replace the first two lines with `settleIndicator(managed)`:
```ts
async function settleTurn(managed: ManagedConnector): Promise<void> {
  settleIndicator(managed)
  try {
    await finalizeStreaming(managed)
    await resolvePendingToolMessages(managed)
  } catch (err) {
    console.error('[ChatIntegrationManager] Failed to finalize turn:', err)
    reportError(err, 'settle-turn', { integrationId: managed.integration.id, chatId: managed.chatId })
  }
}
```

Add the case in the `processSSEEvent` switch (next to `session_idle`):
```ts
case 'session_awaiting_input': {
  // The agent is now waiting on the human. Settle the working indicator — the
  // request card is the waiting affordance, so "Thinking…" would be a lie.
  // Generic: any request type reaches here via this one signal, so there is no
  // per-type case to maintain. The turn is NOT over, so do not finalize streaming.
  settleIndicator(managed)
  break
}
```

In the eight `*_request` cases, DELETE the `clearWorkingWatchdog(managed)` line and update the comment. Keep `sendUserRequestCard`:
```ts
case 'user_question_request':
case 'secret_request':
case 'file_request':
case 'connected_account_request':
case 'remote_mcp_request':
case 'browser_input_request':
case 'script_run_request':
case 'computer_use_request': {
  // Render the request card. The working indicator is settled by the generic
  // session_awaiting_input signal, NOT per-type here. Dropping the old per-request
  // watchdog-clear is deliberate: it keeps the idle watchdog armed as the backstop
  // if a request path ever fails to raise awaiting.
  try {
    await managed.connector.sendUserRequestCard(managed.chatId, data as UserRequestEvent)
  } catch (err) {
    console.error(`[ChatIntegrationManager] Failed to send user request card (${eventType}):`, err)
    reportError(err, 'send-user-request-card', { integrationId: managed.integration.id, provider: managed.integration.provider, eventType })
  }
  break
}
```

- [ ] **Step 4: Update the moved test.** The existing "watchdog is paused while a user-request card is outstanding" test (`perpetual-thinking.repro.test.ts:240`) relied on the per-type `clearWorkingWatchdog`. Update it to drive `session_awaiting_input` (as the real flow now does) and assert the indicator settled + no stall notice:

```ts
it('is paused while awaiting input (the awaiting signal settles the indicator + disarms the watchdog)', async () => {
  vi.useFakeTimers()
  try {
    const connector = new MockChatClientConnector()
    const managed = makeManaged(connector, 'chat-watch')
    await processSSEEvent(managed, { type: 'stream_start' })
    await processSSEEvent(managed, { type: 'user_question_request', toolUseId: 'tu-1', questions: [{ question: 'Which DB?' }] })
    await processSSEEvent(managed, { type: 'session_awaiting_input', sessionId: 's', agentSlug: 'a' })
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 60 * 1000)
    expect(connector.stoppedWorking).toContain('chat-watch')
    expect(stalledMessageSent(connector)).toBe(false)
  } finally { vi.useRealTimers() }
})
```

- [ ] **Step 5: Run the full repro file + verify PASS.** Also grep `sse-event-processing.test.ts` and `sse-error-resilience.test.ts` for any assertion that depended on a `*_request` event clearing the watchdog and update likewise.

Run: `npx vitest run src/shared/lib/chat-integrations/perpetual-thinking.repro.test.ts src/shared/lib/chat-integrations/sse-event-processing.test.ts src/shared/lib/chat-integrations/sse-error-resilience.test.ts 2>&1 | tee /tmp/t3.txt`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/shared/lib/chat-integrations/chat-integration-manager.ts src/shared/lib/chat-integrations/perpetual-thinking.repro.test.ts
git commit -m "refactor(chat): settle the working indicator off session_awaiting_input, not a per-type allowlist"
```

---

### Task 4: Lifecycle completeness — re-arm on response + auto-approved script + cross-provider sweep

**Files:**
- Modify (if needed): `src/shared/lib/chat-integrations/chat-integration-manager.ts:1344` (`handleInteractiveResponse`)
- Test: `src/shared/lib/chat-integrations/perpetual-thinking.repro.test.ts`

- [ ] **Step 1: Verify re-arm on response.** Read `handleInteractiveResponse` (~:1344). When the human submits a response to a request, the agent resumes — the indicator should return promptly. If the handler already calls `startWorking` (directly or via the resumed dispatch), no change. If NOT, add `managed.connector.startWorking(managed.chatId).catch(() => {})` + `armWorkingWatchdog(managed)` after the response is forwarded, mirroring the dispatch site (~:853). State the finding either way.

- [ ] **Step 2: Write the auto-approved-script test** (asserts honesty: an auto-running script keeps the indicator on and settles on idle, not on the request event).

```ts
it('auto-approved script_run keeps the indicator on (no awaiting), settles on session_idle', async () => {
  const connector = new MockChatClientConnector()
  const managed = makeManaged(connector, 'chat-script')
  await processSSEEvent(managed, { type: 'stream_start' })                 // arm
  await processSSEEvent(managed, { type: 'script_run_request', toolUseId: 'tu-s' }) // auto-approved: NO awaiting follows
  expect(connector.stoppedWorking).not.toContain('chat-script')            // still working
  await processSSEEvent(managed, { type: 'session_idle' })
  expect(connector.stoppedWorking).toContain('chat-script')                // settles on idle
})
```

- [ ] **Step 3: Write the re-arm test** (only if Step 1 added re-arm; otherwise document why it already holds).

```ts
it('re-arms the indicator when the human answers a request', async () => {
  // settle on awaiting → human responds → indicator armed again
  // (drive handleInteractiveResponse / the resume path; assert startWorking ran)
})
```

- [ ] **Step 4: Run the full chat-integrations + message-persister suites.**

Run: `npx vitest run src/shared/lib/chat-integrations src/shared/lib/container/message-persister.test.ts 2>&1 | tee /tmp/t4.txt`
Expected: PASS (watch for pre-existing flaky DB tests noted in memory — those are not ours).

- [ ] **Step 5: Typecheck + lint.**

Run: `npm run typecheck 2>&1 | tee /tmp/tc.txt && npm run lint 2>&1 | tee /tmp/lint.txt`
Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add src/shared/lib/chat-integrations/chat-integration-manager.ts src/shared/lib/chat-integrations/perpetual-thinking.repro.test.ts
git commit -m "feat(chat): re-arm indicator on response; cover auto-approved script + cross-provider settle"
```

---

## Self-review (spec coverage)

- Design part A (per-session emit, promotion stays global, subagent fix, auto-approved doc) → Tasks 1, 2, 4-Step-2.
- Design part B (settleIndicator, session_awaiting_input case, drop per-type clear) → Task 3.
- Design part C (connectors/app untouched) → no task; asserted by the unchanged-behavior tests + typecheck.
- Tests 1-10 from the design → Task 1 (#5), Task 2 (#8), Task 3 (#1,3,4,6,7), Task 4 (#9), promotion-global guard (#10) belongs in Task 1 Step 4 (assert global still fires) + a focused assertion that the per-session stream does NOT receive a second awaiting from promotion (add to Task 1 if the harness can drive promotion).
- Whole-branch cross-model review + PR-ready: separate session tasks (#4, #5), after this plan's tasks are green.
