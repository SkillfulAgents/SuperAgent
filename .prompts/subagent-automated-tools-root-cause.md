status: signed-off 2026-08-03 (Gate B: root cause + fix shape approved; handoff to fresh implementing session elected)

# Root cause: automated blocking tools never dispatched on subagent delivery roads

## Broken path

```
agent spawns a subagent
  → subagent calls list_triggers / list_scheduled_tasks (any of 13 automated tools)
  → container parks a pending promise (input-manager createPendingWithType), marks session awaiting
  → host watches for these tool names ONLY on the main-stream content_block_stop path
  → subagent stream + subagent complete-assistant roads have no branch for them
  → nobody ever POSTs /inputs/:toolUseId/resolve
  → UI shows "waiting for user input" with nothing to answer
  → container TTL rejects after 10 min: "Input request timed out"
```

Main-chat calls work (the one road that dispatches). Not cloud-specific — user reproduced locally 2026-08-03.

## Reproduction (observed 3/3, deterministic)

Harness: `src/shared/lib/container/subagent-automated-tools.repro.test.ts` (mock-frame replay
against the real persister, modeled on `message-persister.request-lifecycle.test.ts`).
Result each run: `4 failed | 2 passed`.

- PASS (controls): main stream × {list_triggers, list_scheduled_tasks} → host pushes `/inputs/<id>/resolve`
- FAIL (the bug): subagent stream × both tools → zero pushes
- FAIL (the bug): subagent complete-assistant × both tools → zero pushes

## Root cause (code)

`src/shared/lib/container/message-persister.ts`:

- Main stream `content_block_stop` (~2811–2930+): name-matches all 13 automated tools → handlers → `resolveContainerInput`/`rejectContainerInput` (3588–3609).
- Subagent stream `content_block_stop` (2675–2728): dispatches only `dispatchBlockingUserInputTool` (human tools), `request_script_run`, `mcp__computer-use__*`, Task/Agent/Workflow review. No automated-tool branches.
- Subagent complete-assistant block (~2302–2326): same three, no automated tools.
- Each automated handler has exactly one call site (main stream). Grep-verified at HEAD.

History: this is a never-built gap, not a regression. SUP-424 scoped only the human input tools;
Iddo's #562 (2026-07-23) built the unified dispatcher `dispatchBlockingUserInputTool` for them
across all 3 roads and deliberately left automated tools where they were (main stream only).
The tools themselves last changed in #477.

## Falsification (codex, 1 round, 2026-08-03)

- Second cause attempted: container loses `toolUseId` before parking → refuted by its own code read
  (`consumeCurrentToolUseId` precedes `createPendingWithType`) and by the zero-push observation
  (host never dispatched at all).
- Unexplained symptom sought: none — "says waiting for user input, never surfaces" is what the
  claim predicts (#527 marks the pending awaiting; no card type exists for automated tools).
- Verdict: claim survives both.

## Coverage ledger

| Hypothesis class | Status |
|---|---|
| Missing branch on sibling delivery path | CONFIRMED (this bug) |
| Race / timing | Ruled out — 3/3 deterministic in-process repro |
| Config / environment drift | Ruled out — reproduces with mocked-empty stores, no config on path |
| Regression from a recent commit | Ruled out — gap predates #562; handlers were never wired on subagent roads |
| Auth (cloud host→container token) | Not this bug. Adjacent flag: `resolveContainerInput` never checks `response.ok` and `BaseContainerClient.fetch` has no timeout — a container-side 401 is silently swallowed. FLAG, separate ticket. |
| Container-side keying (toolUseId slot race) | Ruled out for this bug (zero host pushes = host never sent). Single-slot `currentToolUseId` race under parallel MCP calls remains a THEORETICAL sibling, recorded below. |

## Sibling sweep (mechanism: per-road name-match chains that drifted)

- VULNERABLE: all 13 automated tools (`AUTOMATED_INPUT_TYPES`, input-manager.ts:35–50) × 2 missing
  roads (subagent stream, subagent complete-assistant). Reachable by any subagent tool call;
  verified live by the user for the two list tools.
- THEORETICAL: recovery path (`REQUEST_KIND_BY_TOOL_NAME`, :1184–1191) cannot re-establish automated
  requests after a missed delivery. Normally sub-second resolves; record, do not fix.
- THEORETICAL: `currentToolUseId` single-slot cross-tagging under two blocking MCP calls in one
  assistant block (input-manager.ts:76–118). Record, do not fix.
- SAFE: human input tools on all 3 roads (unified dispatcher, registry-deduped, #562).

## Intended fix flow

Before: only main-conversation tool calls are watched → subagent calls park forever.
After: one shared automated-tool dispatcher is invoked from all three delivery roads
(main stream, subagent stream, subagent complete-assistant) → a subagent's call is answered
in milliseconds exactly like a main-chat call → a duplicate delivery of the same call is
answered once, not executed twice.

## Fix shape (proposed at Gate B)

Extract the main-path automated-tool name-match chain into a private
`dispatchAutomatedBlockingTool(sessionId, toolName, toolUseId, toolInput, agentSlug)` —
the automated sibling of `dispatchBlockingUserInputTool` (#562 is the in-repo precedent) — and
call it from the three roads. Add first-delivery-wins dedupe keyed by toolUseId (automated tools
have no registry entry to dedupe on; a stream+complete double delivery of a MUTATING tool like
schedule_task must not execute twice). One source file + the regression test.

## Decided against

| Shape | Why rejected |
|---|---|
| Copy the 13 branches into the subagent handler(s) | ~90 duplicated lines per road; this bug IS the drift that pattern produces |
| Container-side redesign (automated tools call host HTTP directly instead of park-and-wait) | Design-shaped, cross-package, new auth surface; unnecessary for the defect |
| Fix the silent resolve-push swallow in the same PR | Adjacent bug, different mechanism; flag + separate ticket keeps the diff reviewable |
