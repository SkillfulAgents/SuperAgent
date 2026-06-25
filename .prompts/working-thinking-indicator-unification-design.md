# Unified working/"thinking" indicator — signal-layer design

Status: design, cross-model (codex) reviewed, pending final sign-off.
Branch: `refactor/chat-integration-working-thinking` (worktree off fresh `upstream/main`).
This file is a handoff artifact and must be `git rm`'d before the PR (net-zero add-then-remove).
Cross-model pass: codex read the design against the actual code; its P1 findings (promotion re-emit must stay global-only; subagent browser-input + auto-approved script awaiting gaps) are folded into parts A, the test list, and R1.

## Goal

Make the working/"thinking" indicator a single concept driven by one source of truth — the agent session's real lifecycle state — and mirrored by every surface a user reaches the agent from (the Gamut app, Telegram, Slack, future providers).

Two properties, in priority order:

1. Honesty — the indicator can never lie. It is on only while the agent is actually working, and settles the moment the agent is idle, waiting on the human, or errored.
2. Consistency — every surface reads the same status, so the experience matches wherever you are.

A refactor and simpler code fall out of this naturally; they are the by-product, not the goal.

This ends a recurring bug class. "Perpetual Thinking…" has shipped twice (most recently fixed for Telegram in #308). The root smell is that the chat layer decides when to clear the indicator off a hand-maintained allowlist of request types, so any new request type silently regresses into a stuck indicator. The forthcoming `slack_write_request` (in flight on `feat/slack-channel-context`) is the next instance, and is currently carrying a narrow stopgap for exactly this. This design makes that stopgap unnecessary.

## The unified contract

`message-persister` owns the session lifecycle and emits it as signals. Every surface renders its indicator as a pure function of the current state:

| Lifecycle state | Signal | Indicator behavior |
|---|---|---|
| Working | `session_active` (and the streaming / tool events that follow) | ON — "Thinking…" / typing |
| Waiting on the human | `session_awaiting_input` | SETTLE. In chat the request card is the waiting affordance; in the app the indicator relabels to "Waiting for input" |
| Done | `session_idle` | SETTLE |
| Errored | `session_error` | SETTLE + a friendly, non-leaking error message |
| (stall — no signal at all) | none | 5-minute silence watchdog (from #308) settles it as a backstop |

Honesty rule, stated once: never show "Thinking…" when the agent is not thinking. In chat, "waiting on the human" maps to OFF + the request card, not to a persistent typing indicator. That is a deliberate, honest mapping of the app's behavior onto a surface that has no "waiting" indicator variant — consistent in honesty even though the rendering differs.

## What grounding found (the two real facts that shape the design)

1. The awaiting **trigger** in `message-persister` is already generic. The tool-use handling raises awaiting off a pattern, not a per-type list (`message-persister.ts:1719`):

   ```ts
   if (
     state.currentToolUse.name === 'AskUserQuestion' ||
     (state.currentToolUse.name.startsWith('mcp__user-input__request_') &&
       state.currentToolUse.name !== 'mcp__user-input__request_script_run')
   ) {
     this.markSessionAwaitingInput(sessionId)
   }
   ```
   `computer_use` and `script_run` raise it from their own handlers, only when human approval is actually needed. Any new `mcp__user-input__request_*` tool is covered automatically.

2. But `session_awaiting_input` is broadcast **global-only** (`broadcastGlobal`, `message-persister.ts:591` and `:619`), never on the per-session SSE stream. The chat-integration-manager subscribes to the **per-session** stream (`addSSEClient`, `chat-integration-manager.ts:520`), so it never receives the awaiting signal. That blindness is *why* the chat manager fell back to enumerating the eight `*_request` event types itself (`chat-integration-manager.ts:1666-1684`) — that enumeration is the real allowlist, and it under-settles (it calls only `clearWorkingWatchdog`, not `stopWorking`).

So the fix is small and lands in two files. The connectors and the app need no changes.

## The change

### A. Backend — make awaiting a first-class per-session signal (`message-persister.ts`)

1. In `markSessionAwaitingInput`, emit `session_awaiting_input` on the per-session SSE stream (`broadcastToSSE`) in addition to the existing global broadcast. This is the signal the chat manager keys off.
2. Do NOT add the per-session emit to `promoteAutomatedSession`'s re-broadcast — it stays global-only. That re-emit runs asynchronously after the first mark, for a sidebar refetch; on the per-session stream it could land after the user has answered and the indicator has re-armed, producing a stale settle that kills a live indicator. (codex cross-model finding, P1.)
3. Close the two awaiting-emit gaps codex found, so every genuine "waiting on the human" case raises the signal:
   - Subagent browser-input: `handleBrowserInputRequestTool` broadcasts `browser_input_request` but never marks awaiting (the generic mark at `:1719` is only on the main stream path). Add `markSessionAwaitingInput` to that path. This is a real pre-existing bug — the app's global awaiting signal misses subagent browser-input today too — so the fix helps every surface.
   - Auto-approved `script_run`: it broadcasts `script_run_request` but intentionally does not mark awaiting, because the agent is not waiting — it is still running. That is correct: the indicator stays on and settles on the eventual `session_idle`. Documented as intended, no change.

- The trigger is otherwise unchanged — already generic for the `mcp__user-input__request_*` family.
- Extension point (open/closed): a request type outside that family raises awaiting from its own handler, exactly as `computer_use` and `script_run` already do. The #308 idle watchdog remains the backstop if a future path is missed.
- The promotion side-effect is idempotent and guarded; extra emissions only trigger a harmless sidebar refetch in the existing global consumer.

### B. Chat manager — key the indicator off the signals (`chat-integration-manager.ts`)

- Extract `settleIndicator(managed)` = `stopWorking` + `clearWorkingWatchdog`. This is the one shared primitive for "the agent is no longer actively working — settle the visible indicator." `settleTurn` (the terminal teardown for idle/error) calls it, so every settle path is identical.
- Add `case 'session_awaiting_input':` → `await settleIndicator(managed)`. This is the unification: awaiting settles the indicator generically, with no knowledge of the request type.
- The eight `*_request` cases lose their `clearWorkingWatchdog` line (the indicator is now handled by the awaiting signal). They keep `sendUserRequestCard` — card rendering is a separate, per-feature concern and stays as-is.
- `session_idle` / `session_error` are unchanged (they already call `settleTurn`).
- Arming is unchanged (dispatch + `stream_start`) so the user gets instant "Thinking…" on message receipt rather than waiting for `session_active`. The #308 idle watchdog stays as the stall backstop.
- Lifecycle completeness: re-arm the indicator when the human submits a response (`handleInteractiveResponse`), so "Thinking…" returns promptly after the user answers instead of waiting for the next `stream_start`. Verify during TDD whether this already happens; add only if missing.

### C. Connectors and app — no change

- Connectors: `startWorking` / `stopWorking` are already idempotent and safe to call unconditionally (verified across Slack, Telegram, iMessage, Mock). The provider seam is untouched — it stays the per-provider rendering boundary.
- App: the north-star reference, unchanged. Optional future improvement (out of scope): have the app's in-chat "awaiting" sub-state consume the generic `session_awaiting_input` instead of its own enumerated pending-request arrays (`agent-activity-indicator.tsx:56`), removing the app's latent per-type list too.

## Coordination with `feat/slack-channel-context`

- Verified: the Slack branch does not touch `message-persister.ts`, so part A is conflict-free.
- The only shared file is `chat-integration-manager.ts` (Slack adds ~101 lines). Normal merge on rebase; keep the indicator changes localized to the SSE-event switch and the new `settleIndicator` helper.
- `slack_write_request`: if implemented as an `mcp__user-input__request_*` tool it raises awaiting automatically and the indicator settles with zero new code; otherwise it adds one `markSessionAwaitingInput` call in its own handler. Either way the feature's stopgap watchdog case collapses to a no-op.

## Tests / success criteria

Unit tests against the exported `processSSEEvent` with the Mock connector, plus message-persister emission tests.

1. `session_idle` settles the indicator (`stopWorking` called) — turn completion.
2. `session_error` settles the indicator and sends a friendly message — the #308 regression scenario, preserved.
3. `session_awaiting_input` settles the indicator — awaiting input.
4. Open/closed (the whole point): a request type the chat manager does not enumerate, surfaced via `session_awaiting_input`, settles the indicator with no chat-manager allowlist entry. Paired with a message-persister test that a request tool raises `session_awaiting_input` on the per-session SSE stream.
5. `message-persister`: `session_awaiting_input` is delivered to per-session SSE subscribers (not only global), and existing global consumers still receive it.
6. No perpetual indicator: after awaiting / idle / error, `stopWorking` has run and the Telegram heartbeat timer is cleared.
7. Telegram behavior unchanged where already correct: the first streamed token drops "Thinking…"; the streaming response replaces the draft.
8. Subagent browser-input gap (codex P1): `handleBrowserInputRequestTool` raises `session_awaiting_input` on the per-session SSE stream, and the chat manager settles on it. Regression test for the gap the per-type allowlist removal would otherwise open.
9. Auto-approved `script_run`: broadcasts `script_run_request` but does NOT raise awaiting; the indicator stays on and settles on the subsequent `session_idle`, not on the request event.
10. Promotion re-emit (codex P1): `promoteAutomatedSession`'s re-broadcast does NOT reach per-session SSE subscribers (stays global), so it cannot stale-settle a re-armed indicator.

## Risks and decisions

- R1 — robustness depends on the signal. Instant settle depends on `message-persister` raising awaiting. The two known gaps (subagent browser-input, auto-approved script) are closed/documented in part A. The residual risk is a *future* request path that emits a card without marking awaiting; the #308 idle watchdog still settles it (degraded to a 5-minute settle, never a perpetual leak). Accepted trade-off of the signal-layer approach over a chat-layer generic settle; chosen for honesty (the signal fires only when truly awaiting, so auto-approved work keeps its indicator).
- R2 — adding the event to the per-session stream. The app's `use-message-stream` hook now also receives `session_awaiting_input` on the per-session SSE stream. Confirm it ignores the type (it derives "awaiting" from request arrays) so the app is unaffected.
- R3 — awaiting does not finalize streamed text. Unchanged from today: text streamed before a request commits on the next `stream_start`. No behavior change there.
- Decision — keep dispatch-arm (instant feedback) rather than arming on `session_active`.
- Decision — card rendering stays per-feature; not part of this unification.

## Out of scope

- App-side adoption of the generic signal (optional future improvement).
- A dedicated chat "waiting" indicator variant (product enhancement).
- Generalizing card rendering.
