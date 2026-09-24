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
window and offers Normal/Fast (no API-only Flex tier). The existing session speed
header selects `service_tier: "priority"` for Fast, matching the official Codex
client; Normal omits the tier. Discovery offers Fast only when the model advertises
it via `service_tiers` or `additional_speed_tiers`. Model search filters hidden models.
Fast mode uses more subscription credits; displayed costs remain API-equivalent.
The translator preserves the reported tier and does not label default-tier usage as
Fast merely because Fast was requested.
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

Local verification after review fixes: 413 focused app tests; 44 affected DB
and runtime tests also passed with libsql. The full container suite passed 1,294
tests with 10 skips. App/container typechecks and lint passed (existing warnings
only). Generic endpoint screenshots were captured in light/dark mode, with the
new token-limit setting saved through the real API.

Completed error events on the forced-streaming, non-streaming SDK path retain
upstream messages and status classification. Known subscription-quota failures
suppress SDK retries; transient server failures remain retryable. An initial
OAuth exchange without a refresh token asks the user to sign in again. Device
polling still treats 403/404 as pending, matching the official CLI protocol.

A second live app/container run on `superagent-container:provider-stack-reviewed`
verified credential rotation without restarting the SDK query. Session
`9db9cbb1-62fb-4f32-8474-59c48a5ad0ed` ran Bash, refreshed through the app-owned
credential service, and recalled its marker on the next turn. The credential
generation advanced from 1 to 2; the container logged no query restart.

### Fast-mode follow-up validation

With `superagent-container:codex-fast`, a real Gamut agent selected Fast on
`gpt-5.6-sol`, ran Bash, read a PNG through the Read tool, identified its colored
shapes, and continued with the remembered marker after switching to Normal.
Request-level tests cover Normal → Fast → Normal on one proxy listener, streaming
and JSON replies, and `priority`/`fast`/`default` served-tier echoes.

**Tier-reporting caveat, not evidence of a downgrade:** the subscription endpoint
returns `service_tier: "default"` even when Fast measurably increases output speed.
The original probe incorrectly treated this field as proof that Fast was not served.
The official Codex CLI 0.153.4, using the same temporary Pro account, reproduced
`priority` requests followed by a `default` completion over both HTTP and WebSockets.
Its native WebSocket request explicitly contained `service_tier: "priority"`.
The account had credits available, was below its usage limit, and discovery
advertised the `priority`/Fast tier for GPT-5.6 Sol.

A six-request, alternating-order comparison on GPT-5.6 Sol used the same prompt
(print integers 1 through 180), low reasoning effort, account and HTTP endpoint.
Fast changed only `service_tier: "priority"`; Normal omitted the field. All outputs
completed, with approximately 542–544 visible output tokens each. Throughput is
visible output tokens (reported output minus reasoning tokens) divided by the
interval from the first text delta to completion:

| Mode | Output tokens/sec, three runs | Median completion time |
| --- | --- | --- |
| Normal | 55, 55, 45 | 11.45 s |
| Fast | 82, 78, 78 | 8.50 s |

The median output rate increased about 1.42×, consistent with the model's advertised
1.5× Fast mode. This is a small live sample, not a latency guarantee or billing
measurement. Both modes still reported `default`; no transport or extra-header
change was required to obtain the measured speedup. The request mapping already
in this PR is correct. The official CLI maps Fast to `priority` as well:
https://github.com/openai/codex/blob/f5f08c54cb7a774594d3579c5731ea3e87f01c48/codex-rs/protocol/src/config_types.rs

**Accounting limitation:** because API-equivalent pricing currently follows the
reported usage tier, this backend echo can omit the Fast premium from the displayed
estimate. It does not measure actual subscription credits consumed. No synthetic
served-tier metadata or automatic retry is added.
