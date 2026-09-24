# Grok subscription (SUP-904)

Grok Subscription is a separate model provider. In Settings → Model Providers,
add a connection, choose Grok Subscription, and complete the device sign-in.
The app keeps the resulting credentials in that connection's database config;
the browser receives only an opaque, user/owner-bound login ID and account label.
The public OAuth client ID is the one used by OpenClaw, selected for this integration.
Built-in models remain code-driven; costs use the shared API-equivalent price list.

## Requests and refresh

Ordinary agent requests use Grok's native Messages endpoint through the on-demand
container proxy. Compatibility adaptations fill missing object-schema `required`
arrays, lift images out of tool results, and remove incompatible thinking blocks.
Deferred ToolSearch references expand into the discovered tool schemas. Requests
containing hosted web search use Responses through `llm-endpoint-translation`.

Only access tokens, expiry, account identity and credential generation reach the
container. Near expiry, or after one pre-stream 401, the proxy calls the app's
existing session-bound runtime endpoint. The app owns refresh-token exchange and
persists both rotated tokens together. A conditional database lease coalesces
refresh across workers, and a config/generation comparison prevents a late refresh
from overwriting a reconnect, edit or deletion. Old-generation rejections reuse
the current token. Quota errors and interrupted streams are not replayed.

Host-side helper calls also obtain credentials through this app service. Grok
supports ordinary direct Messages calls, so it can be selected as a summarizer.
The container's hosted-web-search routing is not used by the host-side client.

## Validation

Live validation used a real Gamut agent container, bundled Claude SDK, Gamut
prompts and the user's temporary Grok OAuth account:

| Case | Observed result |
| --- | --- |
| Question and continuation | 17 × 23 = 391; continuation +9 = 400 |
| Bash and Read | Created and read a file; independently checked its content and SHA-256 |
| Deferred tool search | Loaded browser tools, opened example.com and read “Example Domain” through the container browser service |
| Image in a tool result | Read a PNG and identified COPPER, two blue circles, a red triangle and a green square |
| Hosted WebSearch | Retrieved Python TaskGroup documentation and its Python 3.11 introduction |
| App refresh | Five concurrent callers received one persisted generation and rotated token pair; a late rejection reused it |
| Host helper after refresh | Direct Messages request returned 72 for 8 × 9 |
| Credential boundary | Runtime descriptor contained no refresh token |

The SDK's final aggregate usage was zero in these runs. The app uses per-message
usage and shared pricing; Grok's observed `grok-4.7-build` response ID maps to the
existing `grok-4.7` price. This validation does not establish subscription quota
reporting or behavior on an actually exhausted account.

Automated coverage exercises OAuth ownership and credential secrecy, refresh
races/reconnect/deletion, libsql, proxy authentication retry and account-scoped
reasoning replay, schema/image adaptation, sign-in polling/expiry/unmount, and
pricing aliases. Light and dark settings screenshots accompany the PR.
