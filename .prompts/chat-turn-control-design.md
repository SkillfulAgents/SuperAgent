# Chat turn control - `/stop` affordance + stall nudge

Status: design SETTLED with Jeremy (2026-07-06), grounded against merged main; adversarial codex pass DONE, all findings triaged and folded in below.
Next: TDD implementation.
Branch: `feat/chat-turn-control` (this worktree), rebased onto `upstream/main` (PR B merged as squash `5bc8cbf2`, #339).

## Context (read first)

This is the follow-up to PR B, the pull-based chat working/thinking indicator refactor (#339, merged).
PR B rebuilt the indicator as a pure-pull, self-healing projection (a per-session ~1s tick reads `getSessionActivity` and paints/clears) and DELETED the old 5-minute working watchdog.
That watchdog used to auto-clear the indicator after 5 min of silence and nudge "send your message again" - but it never actually recovered the session (it didn't flip `isActive` or interrupt the turn), and clearing the indicator while the turn was still running was the dishonest part.

PR B's deliberate consequence: a hung turn now shows honest "Working…" indefinitely, matching the desktop app (which also has no auto-timeout).
The app's recovery is a Stop button; chat has no equivalent.
This PR closes that gap and makes the recovery discoverable.

## The problem

On a true permanent hang (container alive, the turn is stuck, and no terminal SSE event ever arrives), `getSessionActivity` stays `'working'` forever, so the tick honestly paints "Working…" forever.
That is correct - the session genuinely is working from the persister's view - but the user has no in-chat way to stop it.
Their only recovery today is `/clear` (abandons the conversation and loses context) or waiting for a connection drop / container eviction to settle it.

The desktop app handles this with a Stop button wired to the interrupt route, which force-marks the session inactive locally even on a wedged container.
Chat has no Stop affordance, and a bare `/stop` command would be undiscoverable (no trigger telling the user it exists).

## The design (settled)

Two parts, symbiotic: the command is the recovery, the nudge is the discovery trigger that makes the command usable.

### Gate semantics (corrected 2026-07-06 during implementation, approved)

All three gates use TURN-LIFECYCLE semantics, not the indicator's `BUSY_ACTIVITIES` (which deliberately excludes `streaming` and `awaiting` for surface-ownership reasons):

- `/stop` and busy-`/clear` gate on `messagePersister.isSessionActive(sessionId)`.
A turn hung mid-stream (`streaming`) or parked on a question (`awaiting`) is still an in-flight turn the user must be able to stop - the app Stop button's any-time semantics.
- The nudge fires only when the AGENT owes progress: activity not `idle` (turn settled) and not `awaiting` (the USER owes input; a person pondering the agent's question is never nudged).
`streaming` IS nudge-eligible: a healthy stream emits deltas constantly and every delta resets the timer, so seven straight minutes of mid-stream silence is the hang signature.

Found in implementation: the original spec borrowed `BUSY_ACTIVITIES`, which made a mid-stream hang unstoppable from chat and un-nudged.

### Part 1 - `/stop` command (the recovery)

A chat command that interrupts the current turn, reusing the SAME path the app's Stop button uses.

- NEW shared helper `interruptAgentSession(agentSlug, sessionId)` in `src/shared/lib/container/interrupt-session.ts`, the interrupt route body factored out verbatim: read cached container info; if the container is not running, settle locally only; otherwise `client.interruptSession(sessionId)`; then `markSessionInterrupted(sessionId)` + `reviewManager.denyAllForAgent(agentSlug)` REGARDLESS of the result.
The key property: it ALWAYS unsticks the session locally, even on a wedged or dead container.
The API route (`src/api/routes/agents.ts:1925`) becomes a thin wrapper (auth + params + response) around the helper.
The helper is a LEAF module: nothing in `src/shared/lib/container/` may import it (`container-manager` already imports `message-persister`, which lazy-imports back to avoid a cycle - do not extend that graph).
The chat manager imports it via dynamic `await import(...)`, matching its existing container-manager idiom (`chat-integration-manager.ts:717`).
All three deps (`containerManager`, `messagePersister`, `reviewManager`) live in `src/shared/lib/`, so the helper is shared→shared with no API-layer inversion.
- `denyAllForAgent` is INCLUDED (settled): exact parity with the app's Stop button and maximal reuse of the existing route body.
It is agent-scoped, so a `/stop` in one chat can deny a pending tool-approval in a sibling chat of the same agent; accepted - the collision is rare and recoverable (the agent re-asks), and a wedged tool-approval is a top hang cause, so omitting it would make `/stop` fail on the very hangs it exists for.
- Wire `/stop` in `chat-integration-manager.ts`'s command block next to `/start` (`:705`) and `/clear` (`:711`).
Placement inside that block inherits the `decideInboundAccess` gate (`:676`), which runs before any command; blocked chats never reach `/stop`.
- `/stop` does NOT tear down the chat-session mapping (unlike `/clear`): conversation context survives, and the next message runs as a fresh turn in the same conversation instead of queuing behind the hung one.
- `/stop` discards the WHOLE in-flight turn, including any mid-turn messages queued as steering (interrupt clears the container's queued sends).
That is the intended "reset" semantics; the ack copy tells the user to resend.
- `/stop` sets `managed.turnNotified = true`: a stale `session_error` already sitting in the SSE queue would otherwise send a second, contradictory error notice after the stop ack; the existing latch check (`:1810`) suppresses it.
- `/stop` rides the normal per-chat serial inbound queue (settled: accept + document).
The dominant hang - a turn wedged in the container - does NOT occupy that queue: the message handler returns right after `client.sendMessage` (`:846`), so `/stop` enters an empty queue and runs immediately.
The one true blocking case is the delivery hand-off itself freezing (a wedged container's HTTP call never returning, or a hung `ensureRunning` on the new-session path); that is a missing-timeout root cause fixed separately (see Out of scope).
Queue-jumping was REJECTED: it reorders bursts - a `/stop` could execute before the message sent just before it, which then dispatches AFTER the interrupt and resurrects work the user just killed.
- Indicator settlement is event-driven, not tick-driven: `markSessionInterrupted` (`message-persister.ts:577`) broadcasts `session_idle` (`:595`), which the manager's own SSE subscription routes to `clearIndicator` + `finalizeTurn` (`chat-integration-manager.ts:1794`).
Scope: that path exists only while a managed subscription is live - which is the only state `/stop` is reachable from anyway; the persister settles its own state regardless.
The pull tick is only the backstop.
- `/clear` on a BUSY session now interrupts FIRST via the same helper, then archives ("clear = stop + forget").
Today `/clear` only unsubscribes and clears the indicator (`stopSession` `:978`), leaving the container turn running orphaned and burning tokens with nowhere to deliver.
- Acks: active turn stopped → "⏹ Stopped. Send a message to start again."; nothing running → "⏹ Nothing is running right now." (graceful, no error).

### Part 2 - stall nudge (the discovery trigger)

A per-session SILENCE timer: armed at turn dispatch, RESET on every SSE event, fired after 7 minutes of total silence, at which point it sends ONE informational message pointing at `/stop`.
"Once" is per USER MESSAGE, not per container-turn: a steering message mid-turn re-opens the latch, so a user who steered and then got 7 more minutes of silence gets a second nudge - each nudge is preceded by a user action.
It NEVER touches the indicator.

- `ManagedConnector` (`chat-integration-manager.ts:124`) gains `stallNudgeTimer?` and `stallNotified?`.
- ARM at BOTH dispatch points: the existing-session send path (near `markSessionActive`, `:847`) and `startNewChatSession` (`:959`).
Reset `stallNotified = false` per turn at dispatch.
- RESET the timer SYNCHRONOUSLY in the `addSSEClient` subscription callback (`:521`, next to `armIndicatorIfBusy`), BEFORE the serialization queue.
NOT inside `processSSEEvent`: a backed-up SSE queue (handlers awaiting connector work) must not let the nudge fire while events are in fact arriving - the same reasoning the indicator wake already uses.
- CANCEL (not just reset) on the terminal events `session_idle` (`:1794`) and `session_error` (`:1802`), on `/stop`, in every teardown path that clears `indicatorTickTimer` today, AND in `subscribeChatSession`'s resubscribe cleanup (`:517`, alongside `stopIndicatorTick`) so a session swap cannot leave a stale timer running.
- FIRE: at most once per turn (`stallNotified` latch - SEPARATE from `turnNotified`, so a nudge never suppresses a later `session_error` notice).
The timer closure CAPTURES its sessionId; at fire time, check the captured id is still `managed.sessionId` AND the activity is agent-owed (not `idle`, not `awaiting` - see Gate semantics above), so neither a swapped session, a settled turn, nor a user pondering the agent's question is ever nudged.
Send the nudge; touch nothing else.
- Delivery is best-effort, AT-MOST-ONCE: set `stallNotified` BEFORE sending, `.catch(log)` the send.
A missed nudge is cheaper than a double nudge - deliberately the opposite of the `session_error` notice, which releases its latch on delivery failure to stay at-least-once.
- `STALL_NUDGE_MS = 7 * 60_000`, hardcoded const.
No setting (YAGNI until someone asks).

Copy:

> ⏳ Still working on this. Could be a long-running step, or the turn might be stuck. If it looks hung, send `/stop` to reset it and try again.

The sent string is PLAIN TEXT: the backticks above are doc formatting, not part of the copy (iMessage renders backticks literally; Slack uses different markup).

### The guardrails (keep the nudge honest and non-annoying)

1. The nudge NEVER paints or clears the indicator.
The indicator stays 100% pull-tick-driven plus the four explicit clears (PR B's invariant).
The timer is named `stallNudgeTimer`, nothing indicator-related, so no one wires it back into the indicator path.
2. Reset on any SSE event, so it fires on SILENCE - the actual hang signature - and a healthy long turn that streams output every few seconds never trips it.
3. 7-minute threshold (settled): clears most legitimately-silent long tools (builds, installs, browser waits) before nudging.
4. False positives are ACCEPTED (settled): a silent-but-alive tool longer than 7 min can trip it.
The copy frames `/stop` as OPTIONAL ("might be stuck") and never asserts the agent died, so a false positive is mildly noisy, not harmful.
5. Fire at most ONCE per turn, and re-check the session is still busy at fire time.

## Interaction with `fix/stuck-chat-indicator` (unmerged sibling branch)

That branch fixes sessions that LOOK busy but are not (lost terminal signals, failed turn-start sends) by settling them - after it, those sessions go non-busy, so the fire-time busy re-check suppresses the nudge for them automatically.
What remains for `/stop` + nudge is exactly the class it cannot touch: a turn that is genuinely wedged and honestly busy.
Overlap check (2026-07-06): its `agents.ts` change is in the messages route, not the interrupt route; its manager changes are `clearIndicator`'s `yieldingToStream` flag and the `message` event case - disjoint from every insertion point here.
Rebase in either merge order is trivial.

## Per-connector realization

The `/stop` command and the nudge message are plain commands/text, so they work on ALL connectors (Telegram, Slack, iMessage) with no per-connector code.

Optional enhancement, later, NOT required for this PR: inline "⏹ Stop" buttons where supported.
Ship the command first; buttons are purely additive.

## Code anchors (re-anchored against merged main, 2026-07-06)

- Command block: `chat-integration-manager.ts:705` (`/start`), `:711` (`/clear` → `clearChatSession` at `:997`). Add `/stop` here.
- Access gate above the commands: `decideInboundAccess` at `:676`; blocked chats return by `:697`.
- Dispatch points: `client.sendMessage` `:846` + `markSessionActive` `:847` (existing session); `startNewChatSession` `:959` (new session). `turnNotified` reset `:898`.
- SSE processing: `processSSEEvent` `:1659`; `session_idle` `:1794`; `session_error` `:1802` (with the `turnNotified` latch `:1810`).
- Turn-in-flight predicate: `messagePersister.isSessionActive` (`message-persister.ts:266`); nudge fire eligibility: `getSessionActivity` not `idle`/`awaiting` (see Gate semantics).
- `ManagedConnector` type: `:124`.
- Interrupt route to factor: `src/api/routes/agents.ts:1925` (`denyAllForAgent` at `:1955`).
- `markSessionInterrupted`: `src/shared/lib/container/message-persister.ts:577` (broadcasts `session_idle` at `:595`).

## Test matrix

TDD. Two harnesses, matched to what each can exercise: `sse-event-processing.test.ts` constructs `ManagedConnector` directly and only drives `processSSEEvent` - use it for the pure timer/event cases; command, gating, queue, and interrupt cases need the manager-level harness (`chat-integration-e2e.test.ts`) with mocked `getClient` / `getCachedInfo` / `interruptSession` / `reviewManager`.
Fake timers for the nudge.

| # | Scenario | Expected |
|---|---|---|
| 1 | `/stop` on an active session | `isActive` false; indicator clears via the `session_idle` broadcast; next message is a fresh turn (not queued) |
| 2 | `/stop` on an idle session | graceful ack, no error |
| 3 | `/stop` from a disallowed chat | rejected by the access gate, no interrupt |
| 4 | `/stop` on a wedged / not-running container | still marks inactive locally; indicator unsticks |
| 5 | nudge after 7 min of total SILENCE | exactly one message; copy points at `/stop` |
| 6 | nudge on a healthy long turn (periodic SSE events) | never fires (reset on each event) |
| 7 | nudge path touches the indicator | NO `startWorking` / `stopWorking` from the nudge (assert) |
| 8 | nudge fires twice in one multi-segment turn | at most one message (latch) |
| 9 | nudge after the turn already settled or while awaiting user input | does not fire (cancelled on terminal events + settled/awaiting re-check at fire time) |
| 10 | nudge then `/stop` | `/stop` interrupts and clears; timer cancelled |
| 11 | `/clear` during a running turn | interrupts via the helper FIRST, then archives + clears |
| 12 | `/stop` racing an already-enqueued `session_error` | no stale error notice after the stop ack (`turnNotified` set by `/stop`) |
| 13 | nudge send fails (connector throws) | latch stays set, no retry, error logged |
| 14 | resubscribe / session swap while a stall timer is armed | timer cancelled; no nudge for the old session |

Plus route parity for the helper extraction: the interrupt route's existing behavior (running and not-running container cases) is preserved through the refactor.

## Out of scope

- Inline Stop buttons (additive follow-up).
- Any change to the indicator projection - that is PR B; this PR must NOT touch the tick or the four clears.
- Auto-interrupt-on-resend (rejected: too magical, would cancel legitimately-slow work).
- Out-of-band / queue-jumping `/stop` (rejected: reorders bursts and resurrects killed work; see Part 1).
- Bounding the container client's send call with a timeout - the real fix for a frozen delivery hand-off blocking the inbound queue.
Root-cause follow-up, benefits every queued message, not just `/stop`.

## Pre-PR cleanup

Per repo convention: `git rm` this `.prompts/` doc (add-then-remove, net zero) before opening the PR, and revert any incidental `package-lock.json` churn.
