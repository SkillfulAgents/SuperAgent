status: draft

# SUP-446 root cause

## Intended fix flow (for Gate B)

**Before**
```
review parks
  → show Allow/Deny card
  → activity bit stays "not waiting"
  → chat tick paints Working…
  → open-chat strip paints Working… (strip list omits proxy reviews)
```

**After**
```
review parks
  → show Allow/Deny card
  → mark agent's active session(s) as waiting
  → activity reads awaiting → chat tick clears Working…
  → open-chat strip treats parked proxy review as waiting → "Waiting for input…"
review ends (allow / deny / abort / timeout / reject-all / bulk resolve)
  → clear waiting only when nothing else still needs the human
  → card dismisses; activity honest again
```

## Root cause claim

**State/mutation + boundary miss (one mechanism, two consumers):**

Proxy review is a blocked-on-human path that travels an agent-scoped global card road and never writes the session awaiting bit. The chat tick reads that bit via `computeActivity`, so it stays `working`. The open-chat strip independently computes awaiting from stream pending arrays that never included proxy reviews, so it also stays Working… while the card stack correctly shows Allow/Deny.

This is Root A of the stuck-indicator saga (blocked-on-human not marked awaiting), sibling road to SUP-424 (different file/road: card never shows vs card shows / label lies).

## Evidence

- Repro 3×: pending review + active session → `isAwaitingInput=false`, activity=`working`.
- Zero `markSessionAwaiting*` under `src/shared/lib/proxy/`.
- `broadcastReview` emits global `session_awaiting_input` with `review` payload, no `sessionId`.
- Chat `handleGlobalNotification` posts card and returns - no persister mark, no indicator settle tied to awaiting.
- Strip `isAwaitingInput` ORs six stream pending lists; omits proxy reviews (those live in `usePendingRequests` / `usePendingProxyReviews`).
- Sidebar already ORs `hasAgentLevelReviews` into session badges - badge honesty without activity honesty.
- Timeout + `rejectAll` today skip `proxy_review_resolved` broadcast - mark-on-park without clear-on-those-paths reintroduces stuck-blank.

## Coverage ledger (root-cause lenses)

| Class | Verdict |
|---|---|
| Race / concurrency | Ruled out as primary - failure is deterministic with a single pending review; no interleaving required. Clear races matter for the *fix* (shared bit) but are not the cause of the lie. |
| State / mutation | **Confirmed** - awaiting bit never written on park; strip state never includes proxy reviews. |
| Boundary / input | Contributing shape - agent-scoped review has no sessionId; attribution uses active sessions for the agent. Not a null/overflow bug. |
| Config / environment | Ruled out - reproduces in-process with no env; default review policy only makes the path common. |
| Lifecycle / teardown | Secondary trap for the fix (timeout / rejectAll / tool-result clear of shared bit), not the reason the lie appears on park. |
| Wrong layer / symptom patch | Sidebar OR is the prior symptom patch; this ticket is the missing source-of-truth write + strip consumer. |

## Decided-against (so far)

| Rejected | Why |
|---|---|
| Chat-only clearIndicator on card show | Tick re-reads activity next interval and re-paints Working… if bit still false (#339 invariant). |
| Relying on sidebar/API OR alone | Already shipped; does not drive chat tick or strip. |
| Unifying two awaiting stores (SUP-213) | Design-shaped; out of scope. |
| Folding into #405 catch-all | Different root class (B/C); would bury a named Root A fix. |
| Waiting for SUP-424 to invent a shared public seam | Refuted 2026-07-17 - no shared seam; two PRs, sequential if both touch persister. |

## Sibling sweep (Phase 3.6)

| Class | Sites |
|---|---|
| Vulnerable (this ticket) | `review-broadcast` / `requestReview` / `requestXAgentReview` + proxy, mcp-proxy, x-agent callers; chat global handler cards without mark; strip omits proxy; dashboard reviews same store. |
| Vulnerable (already ticketed) | SUP-424 subagent sidechain missing mark/handlers for ask/secret/file/account/mcp/browser. |
| Safe | Top-level blocking tools mark; capability/script/CU mark when prompting; chat SSE cards after persister mark. |
| Theoretical | Review with no active session (activity already idle; agent-level flags cover badges). |

Do **not** fix SUP-424 in this run. Fix at the review-manager / persister mark+clear seam + strip consumer so all requestReview callers inherit.

## Fix shape (for Gate B - not the diff)

1. Public mark/clear awaiting for the agent's active session(s) when a review parks / ends.
2. Clear on **every** termination path, including today's silent timeout and rejectAll (must broadcast or clear).
3. Shared single awaiting bit: clear only when no other pending human wait remains (union both request shelves / skip auto-approved leftovers - see awaiting-two-stores memory), or equivalent refcount/reasons - do not cross-clear secret/question.
4. Strip: OR parked proxy reviews into open-chat awaiting (same honesty as the card stack).
5. Regression tests: activity awaiting while pending; strip Waiting…; clears on allow/deny/timeout/rejectAll without stuck-blank; no cross-clear when another wait is open.

## Falsification (Phase 3.5, codex)

Log: `/tmp/sup-446-falsify-codex.txt`

**Second cause offered:** agent-scoped review vs session-scoped awaiting - no deterministic session to mark.

**Arbitration:** not a second cause of the Working… lie. It restates the same gap (no mark) plus the existing attribution heuristic. With one active session the repro is fully explained by never writing the bit. Multi-session attribution already governs the card and OS notification (`getActiveSessionIdsForAgent`); marking those same session(s) makes activity honest without inventing a new owner-session invariant.

**Unexplained symptom offered:** wrong-session card routing when multiple sessions are active.

**Arbitration:** real adjacent behavior, pre-existing, not the SUP-446 symptom. Out of scope unless Gate B expands.

**DESIGN-SHAPED (codex):** yes - claimed need for single owner session as source of truth.

**Arbitration: NOT design-shaped for this ticket.** Need is honest activity while a review is parked and honest clear on every end path, plus strip OR. That is a local mark/clear on the existing agent→active-sessions heuristic + strip consumer. Single-owner redesign would be a separate feature; escape hatch not taken.

Hypothesis **survives** with the above notes.
