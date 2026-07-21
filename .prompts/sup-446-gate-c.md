status: draft

# SUP-446 Gate C batch

## Actual flow (from code)

```
review parks
  → card broadcasts (unchanged)
  → active conversations for that agent marked waiting
  → chat tick reads awaiting → stops Working…
  → open-chat strip sees pending proxy reviews → Waiting for input…

review ends (allow / deny / abort / timeout / reject-all / bulk resolve)
  → card resolved broadcast (timeout/reject-all now included)
  → if no reviews left and no other real wait on the conversation → clear waiting
```

## Footprint (vs origin/main, product only)

| File | Role |
|---|---|
| `review-manager.ts` | mark on park; clear on all end paths; timeout/rejectAll broadcast |
| `message-persister.ts` | public mark + clear-if-unblocked (both request shelves) |
| `agent-activity-indicator.tsx` | OR pending proxy reviews into strip awaiting |
| + 2 test files | fail-then-pass regression |

3 source files (under tripwire).

## Verification

- Fail-before observed (6 tests).
- Pass-after: 79 tests green across regression + review-manager + activity indicator.
- typecheck clean; lint no new errors.
- Phase 6: opus + codex **NO HIGH FINDINGS**. MEDIUM flagged pre-existing tool_result clear (out of scope). LOW: bulk-path tests not exhaustive.

## Sibling sites

- SUP-424: flagged, not fixed (separate PR).
- This fix at review-manager seam covers all requestReview callers.

## Handoff note

User holds pr-ready-loop for a **separate session**. `.prompts/` still on branch for that session to `git rm` net-zero before PR.
