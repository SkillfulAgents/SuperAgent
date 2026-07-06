# Chat turn control - `/stop` affordance + stall nudge

Status: design SETTLED with Jeremy (2026-07-06), grounded against merged main.
Next: adversarial cross-model pass on this doc, then TDD implementation.
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

### Part 1 - `/stop` command (the recovery)

A chat command that interrupts the current turn, reusing the SAME path the app's Stop button uses.

- NEW shared helper `interruptAgentSession(agentSlug, sessionId)` in `src/shared/lib/container/interrupt-session.ts`, the interrupt route body factored out verbatim: read cached container info; if the container is not running, settle locally only; otherwise `client.interruptSession(sessionId)`; then `markSessionInterrupted(sessionId)` + `reviewManager.denyAllForAgent(agentSlug)` REGARDLESS of the result.
The key property: it ALWAYS unsticks the session locally, even on a wedged or dead container.
The API route (`src/api/routes/agents.ts:1925`) becomes a thin wrapper (auth + params + response) around the helper.
- `denyAllForAgent` is INCLUDED (settled): exact parity with the app's Stop button and maximal reuse of the existing route body.
It is agent-scoped, so a `/stop` in one chat can deny a pending tool-approval in a sibling chat of the same agent; accepted - the collision is rare and recoverable (the agent re-asks), and a wedged tool-approval is a top hang cause, so omitting it would make `/stop` fail on the very hangs it exists for.
- Wire `/stop` in `chat-integration-manager.ts`'s command block next to `/start` (`:705`) and `/clear` (`:711`).
Placement inside that block inherits the `decideInboundAccess` gate (`:676`), which runs before any command; blocked chats never reach `/stop`.
- `/stop` does NOT tear down the chat-session mapping (unlike `/clear`): conversation context survives, and the next message runs as a fresh turn in the same conversation instead of queuing behind the hung one.
- Indicator settlement is event-driven, not tick-driven: `markSessionInterrupted` (`message-persister.ts:577`) broadcasts `session_idle` (`:595`), which the manager's own SSE subscription already routes to `clearIndicator` + `finalizeTurn` (`chat-integration-manager.ts:1794`).
The pull tick is only the backstop.
- Acks: active turn stopped → "⏹ Stopped. Send a message to start again."; nothing running → "⏹ Nothing is running right now." (graceful, no error).

### Part 2 - stall nudge (the discovery trigger)

A per-session SILENCE timer: armed at turn dispatch, RESET on every SSE event, fired after 7 minutes of total silence, at which point it sends ONE informational message pointing at `/stop`.
It NEVER touches the indicator.

- `ManagedConnector` (`chat-integration-manager.ts:124`) gains `stallNudgeTimer?` and `stallNotified?`.
- ARM at BOTH dispatch points: the existing-session send path (near `markSessionActive`, `:847`) and `startNewChatSession` (`:959`).
Reset `stallNotified = false` per turn at dispatch.
- RESET the timer at the top of `processSSEEvent` (`:1659`) on every event.
- CANCEL (not just reset) on the terminal events `session_idle` (`:1794`) and `session_error` (`:1802`), on `/stop`, and in every teardown path that clears `indicatorTickTimer` today, so no timer dangles past a settled turn.
- FIRE: at most once per turn (`stallNotified` latch - SEPARATE from `turnNotified`, so a nudge never suppresses a later `session_error` notice); re-check `BUSY_ACTIVITIES.has(getSessionActivity(sessionId))` at fire time (the exact pattern at `:1643`) so a settled turn is never nudged; send the nudge; touch nothing else.
- `STALL_NUDGE_MS = 7 * 60_000`, hardcoded const.
No setting (YAGNI until someone asks).

Copy:

> ⏳ Still working on this. Could be a long-running step, or the turn might be stuck. If it looks hung, send `/stop` to reset it and try again.

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
- Busy predicate: `BUSY_ACTIVITIES` `:1518`; fire-time re-check pattern `:1643`.
- `ManagedConnector` type: `:124`.
- Interrupt route to factor: `src/api/routes/agents.ts:1925` (`denyAllForAgent` at `:1955`).
- `markSessionInterrupted`: `src/shared/lib/container/message-persister.ts:577` (broadcasts `session_idle` at `:595`).

## Test matrix

TDD. Fake timers for the nudge; reuse the chat-integration test harnesses (`sse-event-processing.test.ts`, `mock-connector.ts`).

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
| 9 | nudge after the turn already settled | does not fire (cancelled on terminal events + busy re-check at fire time) |
| 10 | nudge then `/stop` | `/stop` interrupts and clears; timer cancelled |

Plus route parity for the helper extraction: the interrupt route's existing behavior (running and not-running container cases) is preserved through the refactor.

## Out of scope

- Inline Stop buttons (additive follow-up).
- Any change to the indicator projection - that is PR B; this PR must NOT touch the tick or the four clears.
- Auto-interrupt-on-resend (rejected: too magical, would cancel legitimately-slow work).

## Pre-PR cleanup

Per repo convention: `git rm` this `.prompts/` doc (add-then-remove, net zero) before opening the PR, and revert any incidental `package-lock.json` churn.
