# Thinking cards reappear after a background-wait follow-up

Reproduced against `b254a55f1` (0.5.33) with both the mock runtime and a real
Docker container / Anthropic model. The retained regression tests failed before
the fix with **expected 0 cards, received 3** and now pass.

Before the fix, streamed thinking blocks were hidden when they matched persisted
thinking, but were not consumed from `sessionThinking`. The bug was a mismatch
between the lifetime of that stream state and the renderer's reconciliation
window (line references below describe the baseline):

1. The foreground turn finishes, but a background task keeps `isActive = true`.
   The persister broadcasts `turn_output_complete` and `session_waiting_background`
   ([message-persister.ts](../src/shared/lib/container/message-persister.ts), around line 2931).
2. A user sends `status ?`. `markSessionActive` derives `queuedMidTurn` solely
   from the old `isActive`, even though foreground work is over (lines 1795, 1851).
   The messages POST uses the same test and returns `queued: true`
   ([agents.ts](../src/api/routes/agents.ts), around line 2786).
3. The frontend preserves `sessionThinking` for `queuedMidTurn: true`
   ([use-message-stream.ts](../src/renderer/hooks/use-message-stream.ts), line 531).
   Neither foreground completion nor entering the background wait retires the
   matched blocks.
4. The runtime is no longer busy with the previous foreground turn, so it writes
   the follow-up as a normal user entry, not a `queued_command` attachment.
   The fetched user message therefore has no `queued: true` flag.
5. That message folds the preceding turn and also moves the thinking dedup scan's
   stopping point forward. The scan now stops before reaching the old thinking
   ([message-list.tsx](../src/renderer/components/messages/message-list.tsx), line 549).
6. All the retained blocks become "unpersisted" again and render after the
   transcript (line 1272). Stable thinking IDs do not help because the matching
   messages are outside the scan. Collapsing is a simultaneous effect of the new
   turn boundary; it does not remove the persisted messages from the scan input.

A genuinely queued mid-foreground-turn message has `queued: true` in the parsed
transcript and does not trigger this cutoff. A fresh send from idle normally
clears the thinking store. Background waiting exposes the disagreement between
those two cases. A long session only increases the number of retained cards;
three passes suffice to reproduce it.

## Run the reproductions

From the repository root, with dependencies installed:

```sh
npx vitest run src/renderer/components/messages/message-list.test.tsx -t 'background wait receives a new turn'
E2E_MOCK=true E2E_PORT=4317 npx playwright test e2e/specs/thinking-display.spec.ts --project=web-chromium --workers=1 --grep 'follow-up during a background wait'
```

The component test exercises both stable IDs and legacy text matching, verifies
the initial handoff, then adds a normal follow-up while keeping the session
active. The old turn folds and its live cards must remain retired.

The browser test streams three thinking passes, persists them, starts a mock
background Bash task, and finishes the foreground turn. It sends `status ?`
through the composer, verifies the POST reports `queued: true` while the fetched
message is a normal user entry, then checks that no old cards reappear below it.
It saves `before-followup.png`, `after-followup.png`, and a transcript attachment
under the Playwright test output. Cleanup stops the synthetic background task.

For manual use with the mock app, send `please think then wait for background`
in an already-open idle session, wait for `Thinking finished; waiting for the
background job.`, then send `status ?`. The mock job remains pending until stopped.

Validation: all 278 MessageList and message-stream unit tests and all 6 thinking
display browser tests pass, including the original reproductions. Coverage also
includes legacy text matching, persistence arriving across a turn boundary in
one refetch, transcript paging, and preserving an open block while consuming
completed ones. See the [real live probe](../e2e/live/thinking-followup/README.md)
for repeatable real-container/model validation and before/after results.

## Fix

Completed blocks hidden by reconciliation are consumed from the shared thinking
store after render. Stable IDs match across the loaded transcript so a refetch
containing both a block's persisted copy and a new turn's message also hands off
correctly. Text-prefix fallback remains scoped to the current turn, protecting
fresh blocks that reuse an old stock opener. Open blocks remain in the stream
store until they close, so subsequent deltas still append to the same episode.
The permanent handoff no longer relies on session activity being equivalent to
foreground-turn activity, and running background work retains its lifecycle.
