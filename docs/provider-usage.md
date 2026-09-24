# Provider allowances (SUP-905)

Provider settings show allowance meters, reset times and remaining balances. The
provider dropdown in both model pickers shows the same data as labeled mini-bars
and balances. It remains hidden when there is only one connection. Fill always
means **consumed**, in the effort slider's blue at every level (no warning colors).

This is informational only. Exhaustion never disables a provider/model or changes
request routing. Missing/failed/unsupported reporting has no UI placeholder;
explicit zero balances remain visible. Historical token usage and API-equivalent
session costs are separate and unchanged.

## Provider contract and endpoints

`BaseLlmProvider.supportsUsage` advertises the capability and `getUsage()` returns
a validated snapshot with an observation timestamp and an array of windows and
balances. Built-in adapters:

- Codex: `GET https://chatgpt.com/backend-api/wham/usage`, OAuth bearer and
  `ChatGPT-Account-ID`. Window labels come from their durations, including a
  weekly primary window; optional review/additional buckets are preserved.
  Credit balances retain the `credits` unit and are not labeled as dollars.
  Accounts reporting `has_credits: false` do not show a balance row.
- Grok: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, OAuth
  bearer and existing CLI headers. Uses included-usage percentage and period end;
  supports the legacy included-used/monthly-limit pair. Prepaid cents become USD.
  On-demand spend is not treated as subscription quota. Missing scalars do not
  imply zero usage/balance.
- Kimi: `GET https://api.kimi.ai/coding/v1/usages` or `https://api.kimi.com/coding/v1/usages`,
  OAuth bearer and the same client headers as inference. Ratio windows are the
  5-hour, weekly, and monthly totals. When those ratios are absent, the count-based
  `usage` summary and `limits` rows are shown instead. `limit_month_code` is not a
  second total. A row that reports only `limit` and `remaining` still shows zero use.
- Platform: existing `/v1/billing` service, with the requesting member's
  attribution. Shows seat consumption when its initial allowance is known,
  remaining seat credits, and separately labeled organization credits. No seat
  means no seat meter, not an empty allowance.

Usage reads use the saved access token directly, with no OAuth refresh, retry or
credential writes. A 401 hides usage until an agent request or reconnect refreshes
the credentials; reporting cannot poison the shared inference credential state.
The sole upstream request has a 10-second timeout. No inference or
container is needed. The subscription HTTP responses are live-verified backend
contracts, parsed defensively as they evolve.

## Access, caching and failure behavior

`GET /api/llm-connections/:id/usage` permits global connections and the caller's
personal connections. An attached session does not grant access to another
member's private billing. Responses have `Cache-Control: no-store`, contain only
normalized values, and never expose upstream errors/credentials. Codex/Grok reads
are coalesced and cached for one minute per connection and
credential generation, including unavailable results. The process cache is bounded
to 256 entries. Platform stays uncached and inside member attribution. All adapters
use sanitized server warnings throttled to once per provider type per minute;
optional Platform reads bypass the normal billing service's Sentry reporting.

The renderer caches by user and connection, with one-minute freshness. Reads occur when
settings or the provider dropdown is opened; closed dropdown items do not mount
usage queries. There is no interval, focus or reconnect polling. Connection edits
invalidate only that connection's usage. A failed usage read hides old data; disconnected
connections cannot keep showing cached usage.

## Validation

On 2026-09-24 UTC, the implemented adapters returned real Codex and Grok weekly
windows plus credit balances, and Platform organization credits using temporary
credentials. That Platform account had no seat; populated and exhausted seats
are covered by fixtures. Multi-window Codex responses, schema variations,
401 isolation, cache coalescing, member isolation, zeros/missing values and the uniform bar color have
regression coverage. The no-credit-entitlement case is fixture-tested, not
confirmed with a live account. Light/dark screenshots use synthetic billing fixtures.
