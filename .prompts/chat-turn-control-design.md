# Chat turn control - `/stop` affordance + stall nudge

Status: design locked (agreed in the PR B session), ready to implement.
Branch: `feat/chat-turn-control` (this worktree), STACKED on PR B (`refactor/chat-indicator-pull-projection`).
Author of design: handoff from the PR B session.

## Context handoff (read first)

This is the follow-up to PR B, the pull-based chat working/thinking indicator refactor.
PR B rebuilt the indicator as a pure-pull, self-healing projection (a per-session ~1s tick reads `getSessionActivity` and paints/clears) and DELETED the old 5-minute working watchdog.
That watchdog used to auto-clear the indicator after 5 min of silence and nudge "send your message again" - but it never actually recovered the session (it didn't flip `isActive` or interrupt the turn), and clearing the indicator while the turn was still running was the dishonest part.

PR B's deliberate consequence: a hung turn now shows honest "Working…" indefinitely, matching the desktop app (which also has no auto-timeout).
The app's recovery is a Stop button; chat has no equivalent.
This PR closes that gap and makes the recovery discoverable.

DEPENDENCY: this branch is based on PR B's HEAD.
It builds directly on PR B's manager refactor (the per-session tick, `processSSEEvent`, the subscribe/teardown lifecycle), so it genuinely depends on PR B.
Before implementing: re-fetch `upstream`, then rebase this branch onto the latest PR B branch, or onto `upstream/main` once PR B has merged.

## The problem

On a true permanent hang (container alive, the turn is stuck, and no terminal SSE event ever arrives), `getSessionActivity` stays `'working'` forever, so the tick honestly paints "Working…" forever.
That is correct - the session genuinely is working from the persister's view - but the user has no in-chat way to stop it.
Their only recovery today is `/clear` (abandons the conversation and loses context) or waiting for a connection drop / container eviction to settle it.

The desktop app handles this with a Stop button: while a turn runs, the composer's send button becomes "stop the agent," wired to the interrupt route, which force-marks the session inactive locally even on a wedged container.
Chat has no Stop affordance, and a bare `/stop` command would be undiscoverable (no trigger telling the user it exists).

## The design (locked)

Two parts, symbiotic: the command is the recovery, the nudge is the discovery trigger that makes the command usable.

### Part 1 - `/stop` command (the recovery)

A chat command that interrupts the current turn, reusing the SAME path the app's Stop button uses.

- Reuse the interrupt logic at `src/api/routes/agents.ts:1875` - `agents.post('/:id/sessions/:sessionId/interrupt', AgentUser(), ...)`.
Its body does: read cached container status; if the container is not running, just `markSessionInterrupted(sessionId)` locally; otherwise call `client.interruptSession(sessionId)` AND `markSessionInterrupted(sessionId)` regardless of the result.
The key property: it ALWAYS unsticks the session locally, even on a wedged or dead container.
Factor this body into a shared helper (e.g. `interruptAgentSession(agentSlug, sessionId)`) so both the API route and the chat manager call one implementation.
- Wire `/stop` in `chat-integration-manager.ts` alongside `/clear` (`:682`) and `/start` (`:676`).
Resolve the chat's active `sessionId` (the manager already resolves it in the send path via `chatSession.sessionId`), call the shared helper, and ack to the user (e.g. "⏹ Stopped. Send a message to start again.").
- Result: `isActive` flips false, so the pull tick clears the indicator within at most one tick, and the next message runs as a fresh turn instead of queuing behind the hung one.
- Auth: gate `/stop` exactly like the other chat commands via `isChatAllowed(integrationId, chatId)`.
Only an allowed chat can stop its own session.

### Part 2 - Stall nudge (the discovery trigger)

A per-session SILENCE timer: armed while a turn is active, RESET on every SSE event, and fired after a generous threshold of total silence (~5 min), at which point it sends ONE informational message pointing at `/stop`.
It NEVER touches the indicator.

This is the old watchdog's arm / reset / fire skeleton MINUS all indicator manipulation.
For reference, the deleted watchdog is in git history before PR B's manager commit: `git show <commit-before-PR-B-manager-commit>:src/shared/lib/chat-integrations/chat-integration-manager.ts` - look at `armWorkingWatchdog`, `resetWatchdogIfRunning`, `onWorkingWatchdogFired`.
Reuse the arm/reset/fire shape; strip every `reconcileIndicator` / `startWorking` / `stopWorking` / `finalizeTurn` call.
`onFire` sends only the nudge.

Draft copy:

> ⏳ Still working on this. Could be a long-running step, or the turn might be stuck. If it looks hung, send `/stop` to reset it and try again.

### The guardrails (keep the nudge honest and non-annoying)

1. The nudge NEVER paints or clears the indicator.
The indicator stays 100% pull-tick-driven (PR B's invariant).
Name the timer distinctly (`stallNudgeTimer`), not anything indicator-related, so no one wires it back into the indicator path.
2. Reset on any SSE event (the `resetWatchdogIfRunning` pattern, added at the top of `processSSEEvent`).
This makes it fire on SILENCE, the actual hang signature, so a healthy long turn that streams output every few seconds never trips it.
3. Generous threshold (~5 min; consider making it configurable).
A silent-but-alive tool (a long build that streams nothing) can still trip it, which is why guardrail 4 exists.
4. The copy frames `/stop` as OPTIONAL ("might be stuck"), and never asserts the agent died.
5. Fire at most ONCE per turn, and re-check the session is still busy (`getSessionActivity` returns a busy state) at fire time so it never nudges a turn that already settled.
PR B kept the `turnNotified` latch for the `session_error` notice - either share it or add a separate `stallNotified` latch reset once per turn at dispatch.

## Per-connector realization

The `/stop` command and the nudge message are plain commands/text, so they work on ALL connectors (Telegram, Slack, iMessage) with no per-connector code.

Optional enhancement, later, NOT required for this PR: inline "⏹ Stop" buttons on the indicator surface where supported (Telegram inline keyboard, Slack message button; iMessage has no buttons).
Ship the command first; buttons are purely additive.

## Code anchors

- Chat command parsing: `chat-integration-manager.ts:676` (`/start`), `:682` (`/clear` → `clearChatSession` at `:948`).
Add `/stop` here and mirror `clearChatSession`'s shape.
- Interrupt logic to factor into a shared helper: `src/api/routes/agents.ts:1875` (`POST /:id/sessions/:sessionId/interrupt`).
`markSessionInterrupted` is `src/shared/lib/container/message-persister.ts:518`.
- Nudge reset hook: the top of `processSSEEvent` in `chat-integration-manager.ts` (where `resetWatchdogIfRunning(managed)` used to be called before PR B removed it); arm the nudge on turn dispatch (the send path, near where `markSessionActive` is called).
- Nudge timer skeleton reference: the deleted watchdog in git history (see Part 2).

## Test matrix

TDD. Use fake timers for the nudge; reuse the chat-integration test harnesses (`sse-event-processing.test.ts`, `mock-connector.ts`).

| # | Scenario | Expected |
|---|---|---|
| 1 | `/stop` on an active session | `isActive` false; indicator clears within ≤1 tick; next message is a fresh turn (not queued) |
| 2 | `/stop` on an idle session | graceful ack, no error |
| 3 | `/stop` from a disallowed chat | rejected by `isChatAllowed`, no interrupt |
| 4 | `/stop` on a wedged / not-running container | still marks inactive locally; indicator unsticks |
| 5 | nudge after the threshold of total SILENCE | exactly one message; copy points at `/stop` |
| 6 | nudge on a healthy long turn (periodic SSE events) | never fires (reset on each event) |
| 7 | nudge path touches the indicator | NO `startWorking` / `stopWorking` from the nudge (assert) |
| 8 | nudge fires twice in one multi-segment turn | at most one message (latch) |
| 9 | nudge after the turn already settled | does not fire (re-check busy at fire time) |
| 10 | nudge then `/stop` | `/stop` interrupts and clears |

## Out of scope

- Inline Stop buttons (additive follow-up).
- Any change to the indicator projection - that is PR B; this PR must NOT touch the tick or the four clears.
- Auto-interrupt-on-resend (rejected: too magical, would cancel legitimately-slow work).

## Pre-PR cleanup

Per repo convention: `git rm` this `.prompts/` doc (add-then-remove, net zero) before opening the PR, and revert any incidental `package-lock.json` churn.
