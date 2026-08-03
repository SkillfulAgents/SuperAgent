status: signed-off 2026-08-03 (Gate B passed; this brief is the implementing session's contract)

# Fix brief: dispatch automated blocking tools on all three delivery roads

Read `.prompts/subagent-automated-tools-root-cause.md` first. Do not re-litigate the diagnosis —
Gate B settled the root cause, the fix shape, and the decided-against ledger.

## The signed-off fix shape

One file: `src/shared/lib/container/message-persister.ts` (plus the regression test).

1. **Extract** the automated-tool name-match chain from the main-stream `content_block_stop`
   handler (~lines 2835–2940: the `mcp__user-input__` checks for schedule_task, schedule_resume,
   list_scheduled_tasks, cancel_scheduled_task, pause_scheduled_task, resume_scheduled_task,
   get_available_triggers, setup_trigger, list_triggers, cancel_trigger,
   create_webhook_endpoint, update_webhook_endpoint, inspect_webhook_events) into a private
   `dispatchAutomatedBlockingTool(sessionId, toolName, toolUseId, toolInput, agentSlug)` —
   the automated sibling of `dispatchBlockingUserInputTool` (:1142). #562 is the precedent for
   this exact extraction shape; mirror its structure and comment style.
2. **Call it from the three delivery roads**:
   - main-stream `content_block_stop` (replacing the inline chain — behavior unchanged),
   - `handleSubagentStreamEvent` `content_block_stop` (:2675–2728), next to the existing
     `dispatchBlockingUserInputTool` call,
   - the subagent complete-assistant block (~:2302–2326), same placement.
3. **First-delivery-wins guard** inside `dispatchAutomatedBlockingTool`: a per-session
   `Set<toolUseId>` of already-dispatched automated calls. Stream-stop and complete-assistant can
   both deliver the same tool_use; mutating handlers (schedule_task creates a DB row) must execute
   once. The human tools dedupe via `userInputRequestManager.getOpenRequest` (:1154); automated
   tools have no registry entry, hence the set. Scope it to the streaming state (cleared with it)
   so it cannot grow unbounded.

Keep the gating at the call sites identical to the human-tool pattern. No container changes, no UI
changes, no registry integration, no recovery-path work. Out of scope (flagged, separate tickets):
the unchecked `response.ok` on `resolveContainerInput` pushes, and recovery of missed automated
deliveries.

## Reproduction and regression test

`src/shared/lib/container/subagent-automated-tools.repro.test.ts` sits UNTRACKED in this worktree,
already written and observed red 3/3 (`4 failed | 2 passed`: main-stream controls pass, both
subagent roads deliver zero `/inputs/<id>/resolve` pushes for both list tools). Adopt it as the
regression suite:

- Rename to drop `.repro` (e.g. `subagent-automated-tools-dispatch.test.ts`). No ticket IDs in
  filenames.
- Observe it red before the fix and green after; both observations are mandatory
  (`superpowers:test-driven-development`).
- Add one dedupe case: the same toolUseId delivered via subagent stream AND complete-assistant →
  the handler executes once (assert one push for that id, and for a mutating case assert
  `createScheduledTask` was called exactly once).
- The test builds frames the way `message-persister.request-lifecycle.test.ts` does — it is the
  production frame dialect, not a hand-rolled fixture.

## Implementing-session duties (verbatim from bug-fix-workflow)

- **Failing test first.** The regression test must fail before the fix and pass after it, both
  observed. A test that passes before the fix is testing something else.
- **State the red observation in the commit message, naming the input that fails** — e.g.
  "Verified red: a list_triggers tool_use on the subagent stream road gets zero /inputs pushes
  without the shared dispatcher."
- **Never cite the maintainer's PRs as precedent in the commit or PR body.** Factual lineage is
  fine; "follows #562's approach" is not. Argue merits or cite file paths.
- **Do not hand-build regression-test input** beyond the established frame helpers (see above).
- **Smallest fix.** Footprint tripwire: >5 source files (excluding tests) = stop and report.
  Expected: 1 source file + 1 test file.
- **A new helper is a tripwire — grep for its home first.** `dispatchAutomatedBlockingTool` has no
  existing home (verified in diagnosis: the chain exists inline at exactly one site).
- **Dead code:** the inline main-path chain the extraction replaces is part of this fix — remove
  it. Nothing else.
- **Cursor review hold.** No `git add` / commit until Jeremy explicitly says go.
- **The `Co-authored-by: Cursor` trailer is not yours to strip.** State it once, move on.
- **Verify:** `npx vitest run src/shared/lib/container/subagent-automated-tools-dispatch.test.ts`
  red→green, then `npx vitest run src/shared/lib/container/` (code-motion regression check on the
  persister suites), then `npm run typecheck && npm run lint`. Do NOT run `npm build` (dev-server
  rule). Root runs prove nothing about `agent-container/` — this fix does not touch it.
- **Evidence before assertions** (`superpowers:verification-before-completion`).

## Gate C (present to Jeremy, batched)

Lead with the actual flow (what the shipped fix does now, plain English, regenerated from the
code), then: the diff, the red→green evidence, the footprint delta, and the sibling table from the
root-cause note (13 tools × 2 roads → fixed by the shared dispatcher; theoretical items flagged
not fixed). One batched go/revise/stop ask. Go authorizes the commit and the pr-ready handoff.

## After Gate C go

Invoke `pr-ready-loop` in a fresh Cursor GPT 5.6 review session, pointing its kickoff at
`.prompts/subagent-automated-tools-root-cause.md` so the audit inherits the bug context. Its two
bug-shaped questions: does the fix touch more than the root cause requires; does the regression
test pin the cause (the dispatch parity) or only the symptom (the two list tools). `.prompts/`
files get `git rm`'d net-zero before the PR opens, except the root-cause note travels until
ticket + PR are drafted (to-ticket drafts from it).
