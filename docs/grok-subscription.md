# Grok subscription (SUP-904)

Grok Subscription is a separate model provider. In Settings → Model Providers,
add a connection, choose Grok Subscription, and complete the device sign-in.
The app keeps the resulting credentials in that connection's database config;
the browser receives only an opaque, user/owner-bound login ID and account label.
The public OAuth client ID is the one used by OpenClaw, selected for this integration.
Built-in models remain code-driven; costs use the shared API-equivalent price list.

## Requests and refresh

All agent inference uses Grok's Responses endpoint through the on-demand
container proxy and `llm-endpoint-translation`. Deferred ToolSearch references
expand into the discovered tool schemas. The shared codec preserves separate
parallel calls, tool results, direct and tool-result images, mid-turn system notes,
and account-scoped encrypted reasoning. Native hosted WebSearch uses the same route.

Grok's subscription Messages SSE loses parallel call boundaries, omits delta
indexes, and reuses block indexes. The Messages stream-index repair from #1186
is removed: the Responses codec generates valid Messages events for the SDK.
Already-issued runtime descriptors marked `adapter: grok` also take Responses,
even if their old format field says Messages. Grok rejects reasoning effort
`none`, so disabled-thinking helper calls map to `low`. Other efforts are retained.

Only access tokens, expiry, account identity and credential generation reach the
container. Near expiry, or after one pre-stream 401, the proxy calls the app's
existing session-bound runtime endpoint. The app owns refresh-token exchange and
persists both rotated tokens together. A conditional database lease coalesces
refresh across workers, and a config/generation comparison prevents a late refresh
from overwriting a reconnect, edit or deletion. Old-generation rejections reuse
the current token. Quota errors and interrupted streams are not replayed.

Host-side helper and summarizer calls also use Responses through the shared
translation code and obtain credentials through this app service. A pre-stream
401 rebuilds the translation after refresh, so a reconnect cannot replay another
account's reasoning. Model discovery and subscription usage retain their existing
endpoints.

## Validation

The Responses migration was validated on 2026-09-24 with a real Grok 4.7
subscription, the production container proxy, Claude Agent SDK 0.3.281, and
`ClaudeCodeProcess`. The repeatable harness and preparation instructions are in
[`e2e/live/grok-responses`](../e2e/live/grok-responses/README.md).

| Case | Observed result |
| --- | --- |
| Question, continuation and process resume | 17 × 23 = 391; continuation +9 = 400; remembered marker after a fresh SDK process resumed the session |
| Bash, Read and Edit | Created a file, changed alpha to omega, independently checked its content and SHA-256 |
| Parallel Read | Three independent tool calls in one model response; all file markers returned |
| Parallel MCP web fetch | Deferred ToolSearch, then three same-name calls in one model response with distinct IDs and valid independent arguments; fetched all three pages and synthesized their markers |
| Direct user image | Identified COPPER, two blue circles, a red triangle and a green square |
| Image in a tool result | Read the PNG and identified its word, colors and shapes |
| Browser screenshot | Loaded deferred browser tools, opened a page in Chromium, requested a screenshot and identified its marker |
| Hosted WebSearch | Used native WebSearch for Python TaskGroup documentation and its Python 3.11 introduction |
| Host helper | Streamed 391 through Responses with disabled thinking mapped to low effort |
| Streaming regression from #1186 | Every live turn emitted text deltas with valid block indexes; reasoning followed by text also passed through the SDK in integration tests |

The live container run made 26 Responses requests and zero Messages requests.
All nine agent turns and the separate direct-image check passed with no tool or
stream-index errors. The parallel fetch case uses real MCP calls and real HTTP
fetches against local fixture pages through a test host bridge; hosted WebSearch
separately exercises live internet search. No external email/chat message was sent.
Delivery consumers were covered by the message-persister and chat SSE tests.

Automated validation passed 1,304 container tests and the full host suite of
13,859 tests with coverage, plus typecheck and lint. Host validation also passed
with container dependencies absent, matching the host CI installation. New regression
coverage includes interleaved parallel arguments, long MCP names, tool-result call
IDs, old runtime descriptors, images, deferred schemas, quota errors and a 401
reconnect that must not replay another account's reasoning. The generic persister
fallback from #1185 remains intact.

The SDK reported nonzero input/output/cache usage in this run. The app uses
shared API-equivalent pricing; these figures are not subscription quota usage.
Existing automated coverage also exercises OAuth ownership and credential secrecy,
refresh races/reconnect/deletion, libsql, sign-in polling/expiry/unmount, and pricing
aliases. This validation does not establish behavior on an exhausted account.
