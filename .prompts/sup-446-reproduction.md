status: confirmed 2026-07-20

# SUP-446 reproduction

## Harness

In-process activity projection while a review is pending
(`src/shared/lib/proxy/proxy-review-awaiting.repro.test.ts`).

## Observed failure (3 consecutive)

| Run | pending reviews | isAwaitingInput | getSessionActivity |
|---|---|---|---|
| 1 | 1 | false | `working` (expected `awaiting`) |
| 2 | 1 | false | `working` |
| 3 | 1 | false | `working` |

Log: `/tmp/sup-446-phase2-3x.txt`

## Strip honesty (structural)

Open-chat strip (`AgentActivityIndicator`) computes "Waiting for input…" only from
stream pending arrays (secret / account / question / file / remote-MCP / browser).
Proxy reviews are rendered by `usePendingRequests` (includes `proxy_review`) but are
absent from the strip's awaiting check - so with only a parked review, the card slot
can show Allow/Deny while the strip still paints Working….

No live app on 47891/47892 this session; strip confirmed by source + the dual-path
split above. Live Telegram deferred unless Phase 8 needs a seam check.

## What counts as the bug

Review pending > 0 and activity ≠ awaiting (chat tick), and/or strip still Working…
while a proxy-review card is the only wait.
