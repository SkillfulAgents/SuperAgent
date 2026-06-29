# PR B - Pull-based chat working/thinking indicator

Status: design locked, ready to implement.
Branch: `refactor/chat-indicator-pull-projection` (this worktree), based on fresh `upstream/main`.
Author of design: handoff from the PR A session (`fix/message-cancels-awaiting-input`).

## Context handoff (read first)

This is a focused refactor of the chat working/thinking indicator into a pure-pull, self-healing projection.
It is deliberately separate from PR A.

PR A (`fix/message-cancels-awaiting-input`, a different worktree) is the FEATURE work: honest AskUserQuestion rendering (multiSelect toggle + Done, typed-message-as-"Other"), cancel-on-message for awaiting input, and secret/file requests routing to the desktop-only fallback.
PR A touches no indicator/emit code.

This PR (PR B) owns ALL of the indicator / emit / thinking / working / `session_activity` mess.
The split rule was: any code that touches the indicator-projection layer lives here, not in PR A.

Two things from PR A's branch are SUBSUMED here and must NOT be carried forward as-is:
- The commit `52db2479` ("settle the working indicator when a request card is shown") was a race-patch band-aid on the push model.
The pull model replaces it; do not port that patch.
Its insight survives as the "immediate clear on card-show" event below.
- The `autoApproved?: boolean` field that PR A added to `script_run_request` (in `src/shared/lib/tool-definitions/types.ts`) was added only for that band-aid's guard.
Under pull it is unnecessary (auto-approved runs never mark awaiting, so the tick naturally reads `working` and keeps the indicator up).
Decide whether to keep the type field for documentation or drop it; the pull logic does not need it.

Base note: this worktree branched from `upstream/main`, which has #330 (the projection groundwork) but NOT PR A.
PR B is independent of PR A.
When you start implementing, re-fetch `upstream` and rebase onto fresh `upstream/main` (per repo convention).
If PR A has merged by then, the rebase brings it in; the two are largely non-overlapping at the hunk level.

Line numbers below are approximate and taken from the PR A worktree; symbol names are stable, so grep for the symbol on this branch's actual base rather than trusting the line number.

## The problem

The chat indicator (Telegram "Working…/Thinking…/Compacting…/Retrying…", kept alive by a 1s heartbeat) has regressed repeatedly.
Each fix settles one turn-lifecycle transition and a different untested transition then leaks the heartbeat, re-stamps a stale label, or shows the wrong state.
This is the whack-a-mole.

Concrete current bug (verified): after the final streamed reply, `message_stop` sets `isStreaming = false` and re-projects the activity to `working` (the agent might still be doing post-text work, so this is not wrong in general).
The chat manager paints that `working` immediately (`startWorking` sends right away, it does not just arm the heartbeat), so a "Working…" indicator is re-painted at the end of essentially every turn and only cleared when `session_idle` lands.
If idle lags past the 1s heartbeat, the stale "Working…" re-stamps.

Root cause class: the indicator is PUSH-driven (the persister emits a `session_activity` event on each state change; the manager paints immediately on each), and the 1s heartbeat re-sends a CACHED label rather than re-reading the truth.
So a missed event, a mis-ordered event, or a speculative emit leaks or flickers, and a leaked label survives because the heartbeat never re-checks reality.

## Mental model (locked)

One brain, two dumb projections.

- Brain = the raw streaming-state flags in the persister: `isActive`, `isStreaming`, `isAwaitingInput`, `currentThinking`, `isCompacting`, `isRetrying`.
This is the single source of truth.
- `computeActivity(state)` (in the persister) is NOT the brain.
It is already the chat-side projection of the brain into one label, with the precedence: `awaiting` > `compacting` > `retrying` > `thinking` > `streaming` > `working` > `idle`.
Read it via `getSessionActivity(sessionId)`.
- The desktop app projects the same brain through its OWN inline logic (`agent-activity-indicator.tsx` `statusText`).
The app is untouched by this PR.
- After this PR, Telegram/chat becomes a dumb, self-healing projection of `getSessionActivity`.

Important divergence (intentional, keep it): the app shows "Working…" during reply-text streaming because the streamed text is a separate bubble.
Chat suppresses the indicator during reply-text streaming because in chat the streamed text IS the reply.
So `streaming` is a NON-busy (cleared) state for chat.
Every other state matches the app.

The projection RULES are still duplicated (app inline vs `computeActivity`).
That duplication is the "drift seam".
Unifying them into one shared projection is a SEPARATE future PR and is explicitly out of scope here.

## Design

### The one invariant

The tick is the only thing that PAINTS. Events only ever CLEAR.

Paints are where flicker lives (you may be wrong that it is "working").
Clears are always safe (when a card appears or the turn ends, the indicator should be down, no guessing).
So we pull (sample on an interval) for the risky direction and allow immediate clears on the safe direction.

### The tick (manager-owned, per-session, alive for the subscription)

- Owned by the chat manager (it already holds `getSessionActivity` and the managed connectors).
- Lifetime is tied to the SSE subscription for the session, NOT to turn boundaries.
Start the tick when the manager subscribes the session; stop it only on unsubscribe / teardown.
Do not self-terminate on idle.
- Cadence: ~750ms-1s (tune; keep at or under the old `WORKING_REFRESH_MS` so Telegram drafts stay alive).
- Each tick: read `getSessionActivity(sessionId)`, then:
  - busy state (`working`/`thinking`/`compacting`/`retrying`) -> paint that label via `reconcileIndicator` -> `connector.startWorking(activity)`.
  On Telegram this re-render is also the keep-alive.
  - non-busy state (`streaming`/`awaiting`/`idle`) -> clear via `connector.stopWorking()`, IDEMPOTENTLY: only call the connector if the indicator is currently shown, so idle ticks make zero API calls.
- The tick is the self-healing backstop: any stuck or wrong indicator is corrected within one tick because the tick re-reads truth every interval.
This is what structurally kills the whack-a-mole (a leaked label cannot survive a tick).

Clearing is EXPLICIT, never passive.
On Telegram the indicator is a persistent native draft (`<tg-thinking>`) that does not auto-expire; the typing-action fallback only expires after ~5s.
So stopping the tick does NOT clear the indicator.
The clear is always an explicit `stopWorking`.
Stopping the tick is only resource cleanup at teardown.

### The four immediate clears

Fire an idempotent clear the moment the session transitions INTO a non-busy state, so the settle is instant instead of up to one tick late.
The tick backstops anything these miss.

1. Request card shown - all 8 types: `user_question_request`, `secret_request`, `file_request`, `connected_account_request`, `remote_mcp_request`, `browser_input_request`, `script_run_request`, `computer_use_request`. Enters `awaiting`. (This is `52db2479`'s insight, now intentional.)
2. First reply `text_delta` (stream-start). Enters `streaming`.
3. `session_idle`. Turn ended.
4. `session_error`. Errored turn ended (the historical perpetual-"Thinking…" case).

Deliberately NOT clears (this boundary is the design):
- `message_stop` - no action. We do not yet know if work continues (tool) or ends (idle). Acting here is the original flicker bug. The tick plus the subsequent idle/tool event decide.
- Turn start (idle->working) and answer-resolved / cancel (awaiting->working) - these ARM, not clear. Only the tick paints. "Working…" appears within at most one tick; do NOT add an immediate-paint exception (that reopens the speculative-paint seam).

### Connectors go dumb

`startWorking(activity)` = "render this label now". `stopWorking()` = "clear now". No internal timing, no turn knowledge.

Per-connector realization:
- Telegram: the tick re-renders the draft each tick for keep-alive. A clear must YIELD the draft (so a starting stream can reuse the same draft_id), not destroy it. The stream-start clear is near-free because the streamed reply overwrites the draft in place.
- Slack: clear/paint on CHANGE only; do not re-post every tick (there is no draft to keep alive). The keep-alive policy is per-connector, not one-size.
- iMessage / others: whatever they already do for `startWorking`/`stopWorking`; the manager drives them identically.

### What gets deleted (this is a net simplification)

Verify each has no remaining consumer on the actual base before removing.
- The connector self-heartbeat: `workingTimers` map and the `setInterval` inside Telegram `startWorking` (~`telegram-connector.ts:459-476`). The manager's tick replaces it.
- The push machinery: `emitActivityState` (persister, ~`message-persister.ts:373`) and the `session_activity` SSE event, plus the manager's `session_activity` case (~`chat-integration-manager.ts:1728`). The tick reads `getSessionActivity` directly, so the event has no consumer left. KEEP `getSessionActivity` (~`message-persister.ts:367`) and `computeActivity` (~`message-persister.ts:349`).
- The 5-minute working watchdog: `armWorkingWatchdog` / `clearWorkingWatchdog` (~`chat-integration-manager.ts:1473-1487`). The tick is the backstop now.
- `52db2479`'s card-handler settle and its `autoApproved` guard - subsumed by clear #1 and the tick.

Confirmed during design: `use-message-stream.ts` (the app's indicator) does NOT consume `session_activity` (grep is empty; the persister comment says nothing listens for it globally), so removing the push path is chat-only and cannot regress the app.
Re-confirm on the actual base before deleting.

## Success criteria

All 13 turn transitions settle honestly, with no "Working…" between `message_stop` and `idle`, at most one tick of latency on arming, instant settle on the four clear events, and a forced-stuck indicator self-correcting within one tick.

| # | Transition | Expected indicator |
|---|---|---|
| 1 | turn start -> working | paints "Working…" within <= 1 tick |
| 2 | streaming reply text | cleared (stream owns the surface) |
| 3 | thinking / extended-thinking | "Thinking…" |
| 4 | compacting | "Compacting…" |
| 5 | retrying (api_retry mid-stream) | "Retrying…" |
| 6 | awaiting (each of the 8 request types) | cleared instantly on card-show |
| 7 | auto-approved script_run | stays "Working…" (never marks awaiting) |
| 8 | card shown then later activity | no stale "Working…" over the card |
| 9 | answered (tap / Done / typed Other) | re-arms "Working…" via the tick |
| 10 | message cancels awaiting (top-level reject AND subagent interrupt) | settles, then re-arms working for the fresh turn |
| 11 | session_idle | cleared instantly |
| 12 | session_error | cleared instantly (no perpetual leak) |
| 13 | re-arm after user replies | paints "Working…" again |

## Testing strategy

Use fake timers and advance ticks across each sequence.
Key assertions:
- `streaming -> message_stop -> idle`: the tick must NEVER paint "Working…" (the headline fix).
- `streaming -> message_stop -> tool execution`: the tick paints "Working…" after a tick (honest continued work).
- `session_error` with no following idle: cleared, and stays cleared across subsequent ticks.
- Self-heal: force the indicator "shown" while `getSessionActivity` returns `idle`; assert the next tick clears it.
- Idle ticks make zero connector calls (idempotent clear).
- Card-show fires an immediate clear without waiting for a tick.
Reuse the existing `sse-event-processing.test.ts` and connector test harnesses where possible.

## Out of scope

- The desktop app indicator (`agent-activity-indicator.tsx`, `use-message-stream.ts`) - untouched.
- `computeActivity`'s precedence rules - unchanged; we only change how the result is consumed.
- Unifying the app and chat projection rules (the drift seam) - separate future PR.

## Risks / edge cases

- Streaming-draft collision: the tick must treat `streaming` as hands-off and never clobber the reply draft. The clear must yield, not destroy, a reusable surface.
- Rapid turn boundaries (answer -> immediate new turn): the tick re-reads truth each interval, so it self-corrects; verify no double-paint.
- Slack/other connectors: ensure the tick does not spam non-draft surfaces (change-only).
- Subscription lifetime: confirm the tick is reliably torn down on unsubscribe so we do not leak timers for dead sessions.

## Pre-PR cleanup

Per repo convention, AI planning docs are committed on-branch for handoff only.
`git rm` this `.prompts/` doc (add-then-remove, net zero) before opening PR B, and revert any incidental `package-lock.json` churn.
