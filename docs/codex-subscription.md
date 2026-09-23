# Codex subscription (SUP-907)

Codex Subscription is an optional provider in Settings → Model Providers. It uses
ChatGPT device sign-in and the public client ID used by the official Codex CLI.
The existing onboarding flow is unchanged. Device authentication must be enabled
for the account; eligibility is determined by the upstream service.

The app owns the access/refresh pair and account ID per connection. The device
grant is bound to its initiating user, owner, provider type and reconnect target.
The browser receives a login ID, link, code and account label, never tokens.
Grok and Codex share the sign-in UI and database refresh coordination. Containers
receive only access credentials; account headers are rebuilt after refresh, so a
reconnect cannot send a new token with the previous account's header.

## Subscription adapter

Requests use `https://chatgpt.com/backend-api/codex/responses`, not the public
API billing endpoint. Messages translation uses the shared package from SUP-908.
The Codex adapter supplies instructions, sets `store: false`, forces streaming
and removes unsupported output-limit/service-tier fields. Codex controls the
output limit. Non-streaming SDK calls, including hosted WebSearch, collect the
completed Responses event and use the same shared response codec. Truncated
streams fail, and unsupported-model errors retain Codex's `detail` message.

This provider reports `supportsDirectApi = false`: the integration is through the
agent proxy. Summaries, naming and dashboard LLM calls use the existing global
API-capable summarizer. Choosing Codex as the app default preserves that helper
selection and cannot make Codex the summarizer. API-equivalent cost display uses
the existing shared model prices.

The built-in list derives from the code-driven GPT catalog, limited to Codex
model IDs observed in discovery. It uses the subscription's 272,000-token context
window and does not advertise API speed tiers. Model search filters hidden models.
Discovery currently sends `client_version=0.156.1`: the old 0.116.0 probe returned
only a hidden review model. This version is a compatibility setting, not an
installed CLI dependency. Keep it current as upstream model availability changes.

## Live validation

Tested with the user's temporary **ChatGPT Pro** device login. Other plans and
actual exhausted/revoked accounts were not exercised. The public API rejected this
subscription credential with HTTP 403. Current third-party use of the CLI's public
OAuth client and subscription endpoints is verified behavior, not a claim of an
upstream compatibility guarantee or a dedicated Gamut client registration.

A real `superagent-container:sup907-codex` image ran the bundled Claude agent SDK,
Gamut prompts and real browser service with **gpt-5.6-sol**:

| Case | Observed result |
| --- | --- |
| Question + continuation | 17 × 23 = 391, then +9 = 400 |
| Bash and Read | Wrote exact bytes, computed SHA-256 and read the file back |
| Deferred ToolSearch | Loaded browser schemas, opened example.com and read Example Domain |
| Image in a tool result | Identified COPPER, two blue circles, red triangle and green square |
| Hosted WebSearch | Found official Python TaskGroup docs and its introduction in Python 3.11 |
| SDK process restart/resume | Recalled 5:35 PM from history and added ten minutes to give 5:45 PM |
| App-managed refresh | Five concurrent callers received one persisted rotated pair; late rejection reused the new generation |
| Credential boundary | Runtime descriptor contained no refresh token; model discovery succeeded after refresh |

Main session: `0f659f4e-90e0-4a1f-a0d2-caff58ca33f0`.
Restart/resume session: `4d28ead7-8188-4fd4-a5e8-33d5e4f895c2`.

The service accepted low/medium/high reasoning settings, but emitted no encrypted
reasoning blocks in these runs or the additional GPT-5.5 high-effort probe. Live
encrypted replay is therefore **unverified**. The shared codec supports replay
when supplied, scoped by provider ID, account, endpoint and model; automated tests
cover same-account replay and dropping it across an account change. No foreign
reasoning state is forwarded. Normal conversation history and resume passed live.

`GET https://chatgpt.com/backend-api/wham/usage` returned HTTP 200 with
`rate_limit.primary_window` and `secondary_window`, alongside model/review limits.
This confirms an HTTP allowance source exists for the tested account. Allowance
presentation belongs to the separate usage UI work; this PR does not add bars or
an unavailable placeholder. Subscription exhaustion behavior is covered by error
presentation tests, not a deliberately exhausted live account.

Local verification: 400 focused app tests plus three provider tests; 38 affected
DB tests also passed with libsql. The full container suite passed 1,284 tests with
10 skips, followed by the 20-test proxy suite after adding the Codex error-envelope
regression. Typecheck and lint passed (existing lint warnings only). Screenshots
were captured in light/dark mode from scratch mock data.
