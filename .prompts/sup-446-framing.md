status: draft

# SUP-446 framing (bug-fix Gate A)

Ticket: https://linear.app/datawizz/issue/SUP-446/mark-sessions-awaiting-during-proxy-review-approval-stuck-working
Branch: `fix/proxy-review-awaiting-surfacing`
Class proposal: **contained** (full pipeline; not trivial - shared awaiting bit + multi-termination clear paths)

## Broken path

1. Agent hits a review-gated connected-account / MCP / x-agent call (default policy parks for Allow/Deny).
2. System shows the Allow/Deny card (desktop stack + chat integrations).
3. System never records "waiting on the human" on the session activity bit the chat tick reads.
4. Activity stays "working," so Telegram/Slack keep painting Working… for the whole park.
5. User can still Allow/Deny - not a deadlock; the label lies next to a working card.
6. Sidebar already looks right (sessions API ORs pending reviews into badges). Open conversation status + chat tick do not.

## Prior-fix thread

- Indicator honesty saga: #330 projection, #339 pull tick, #369 ask UX - all merged.
- Same Root A family as SUP-424 (subagent asks never surface) - different road; 424 In Review; do sequentially if both touch the persister.
- #405 (draft) is the Root B/C catch-all; does not close this gap.
- Sidebar OR for pending reviews already shipped (API enrichment) - symptom patch for badges only.
- Proxy review path has always broadcast the card globally without marking awaiting (original design gap, unmasked when #339 removed time-based backstops).

## Reproduction map

- Chat integrations row: exercise real paint path; flag/fallback lies apply to rich vs HTML, not this gap.
- Closest honest harness for *this* defect: in-process activity projection while a review is pending (deterministic). Live Telegram is optional confirmation of the paint consequence, not required to prove the state lie.
- Naive lie to avoid: fixing only the chat connector clear without flipping the activity bit - symptom vanishes for one path, returns on the next tick.

## Informal observation (pre-Gate A)

Scratch repro already failed once as expected:
pending review present → activity reads `working`, awaiting false.
Formal Phase 2 still requires 3 consecutive confirms after Gate A sign-off.

## Proposed scope

**In**
- Honest activity while a proxy review is parked (chat tick stops painting Working…).
- Clear that honesty on every review end path (allow, deny, abort, timeout, reject-all, bulk resolve) so mark-on-park cannot reintroduce stuck-blank.
- Regression test that fails before / passes after.

**Out**
- SUP-424 subagent input surfacing.
- #405 stuck-indicator catch-all / from-start replay.
- Unifying the two awaiting stores (SUP-213).
- Changing review policy defaults or the Allow/Deny card UX itself.

**Open scope pick (needs Gate A answer)**
- Desktop open-chat "Working…" strip: card already shows via pending-request stack; the strip computes awaiting from a different list that omits proxy reviews. Persister-only fix may leave that strip lying. Include strip honesty in this PR, or flag as adjacent follow-up?

## Proposed Phase 2 harness

1. In-process: active session + `requestReview` → observe activity stays `working` and awaiting false while pending > 0. Confirm 3 consecutive runs.
2. (Optional live) Telegram/desktop: trigger a review-gated send, observe Working… while card visible - only if (1) is contested.

Failure that counts: pending review > 0 AND activity ≠ awaiting (or chat still paints a busy Working… label).

## Success criteria (for later gates; not yet signed)

- While a proxy review is pending for an active session, activity reads awaiting (not working).
- After every termination path, activity is no longer stuck awaiting because of that review.
- No cross-clear of a genuine secret/question/file wait when a review resolves (or the inverse).
- Footprint stays a focused fix; sequential after SUP-424 if both land on the persister.
