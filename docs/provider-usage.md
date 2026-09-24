# Provider allowances (SUP-905)

Provider settings show allowance meters, reset times and remaining balances. The
provider dropdown in both model pickers shows the same data as labeled mini-bars
and balances. It remains hidden when there is only one connection. Fill always
means **consumed**: normal through 80%, orange above 80%, red above 95%.

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
- Grok: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, OAuth
  bearer and existing CLI headers. Uses included-usage percentage and period end;
  supports the legacy included-used/monthly-limit pair. Prepaid cents become USD.
  On-demand spend is not treated as subscription quota. Missing scalars do not
  imply zero usage/balance.
- Platform: existing `/v1/billing` service, with the requesting member's
  attribution. Shows seat consumption when its initial allowance is known,
  remaining seat credits, and separately labeled organization credits. No seat
  means no seat meter, not an empty allowance.

Subscriptions use the existing app credential resolver and retry one 401 with a
refreshed access token. Upstream reads have 10-second timeouts. No inference or
container is needed. The subscription HTTP responses are live-verified backend
contracts, parsed defensively as they evolve.

## Access, caching and failure behavior

`GET /api/llm-connections/:id/usage` permits global connections and the caller's
personal connections. An attached session does not grant access to another
member's private billing. Responses have `Cache-Control: no-store`, contain only
normalized values, and never expose upstream errors/credentials. There is no
shared server snapshot cache; Platform reads stay inside member attribution.

The renderer caches by user and connection, with 30-second freshness and
60-second polling while the surface is mounted and the document visible.
Connection edits invalidate usage. A failed refresh hides old data; disconnected
connections cannot keep showing cached usage.

## Validation

On 2026-09-24 UTC, the implemented adapters returned real Codex and Grok weekly
windows plus credit balances, and Platform organization credits using temporary
credentials. That Platform account had no seat; populated and exhausted seats
are covered by fixtures. Multi-window Codex responses, schema variations,
401 refresh, member isolation, zeros/missing values and color thresholds have
regression coverage. Light/dark screenshots use synthetic billing fixtures.
