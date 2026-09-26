# Linear agent integration

`LinearAgentIntegration` extends `TaskManagerAgentIntegration`, which extends
`AgentIntegration`. The application manager consumes only the base contract.
The task family owns issue routing, context preparation and reply guidance.
Follow-ups immediately enter the shared runtime's message queue, including during
running turns; there is no task-specific queue or turn-completion lock.
Linear owns OAuth identities and event
delivery, over its own socket or through the host's webhook relay. The official
Linear MCP owns outbound operations, through Gamut's shared MCP proxy.

## Set up an identity

From the agent home, open **External Integrations → Add Integration → Linear**. The live
connection works without a Gamut platform account, hosted relay, or public webhook
listener. When the host's webhook relay is available, setup offers webhooks instead
and selects them by default ([Webhook transport](#webhook-transport)).

1. Choose the agent's name in the shared setup modal and open its prefilled Linear application form.
2. Create a **private** OAuth app for this agent. Choose its avatar in Linear.
   The form supplies the callback URL, and leaves webhooks disabled for a live connection.
3. Copy the client ID and client secret into the same modal, then click **Connect**.
4. Authorize in the Linear window that opens. A workspace admin may need to approve the app and grant
   access to the intended teams. The setup modal stays open until authorization succeeds,
   then closes to show the account on agent home, like the other integrations. Errors and retries remain in the modal and reuse
   the same installation. Opening setup alone does not create an account.

Authorization uses `actor=app`, PKCE, expiring single-use state and the `read`,
`write`, `app:mentionable`, and `app:assignable` scopes. Gamut verifies `viewer.app`
and stores the workspace ID and app-user ID. The same external app identity
cannot be connected to a second agent. Reconnecting an existing installation
must return its original identity; create a new installation to change identity.
Credentials remain on the host. Public API responses and the agent container
never receive the Linear access token, refresh token or application secret.
Refresh tokens rotate with one renewal in flight per installation. Removing an
integration attempts token revocation and removes local access even when Linear is offline. Remove the OAuth application in Linear settings
if it is no longer needed.

## Webhook transport

With the relay transport, Linear's webhooks for the app arrive through the host's
[webhook relay](agent-integrations.md#transports) instead of a socket. Events queue
on the platform while the host is offline and are delivered when it is back, which
the live connection cannot do.

Setup differs in three places. The webhook URL must exist before the Linear app, so
**Get webhook URL** creates the installation (minting its relay endpoint) first. The
app-creation link then turns webhooks on with that URL and the `AppUserNotification`,
`Comment` and `Issue` resource types. Linear shows the app's webhook signing secret
once the app exists; it is pasted with the client ID and secret, and authorization
refuses to start without it. The secret stays on the host.

Each delivery is verified before anything else: `Linear-Signature` must be the hex
HMAC-SHA256 of the raw stored body, and the relay must have received it within a
minute of Linear's signed `webhookTimestamp`. Freshness is judged at receipt, not at
processing, because relayed events can be claimed much later. Handshakes and stale
deliveries are dropped. A signature mismatch before the saved secret has ever
verified a delivery almost always means the wrong secret was pasted: the event is
kept for later, nothing more is claimed, and the connection fails (and stays failed
across reconnects) until a new secret is saved, after which the waiting events are
verified again. Once the secret has verified a delivery, a mismatch is a forgery and
is dropped.

A webhook is then used only as a pointer: the notification, comment or issue it
names is read back through the same GraphQL fields as the live subscriptions and fed
into the same handling. Both transports therefore produce identical events and event
IDs (`assignment:`, `mention:`, `comment:`, `history:`), so switching transports
never runs a request twice. Issue webhooks only matter for delegation, status and
archival changes; the matching history entry records exactly that change (the same
values before and after) and is the closest one within ten seconds, so a neighbouring
change of the same kind is never replayed, and a stop is carried out once however
often its webhook arrives. Anything that isn't input is acknowledged and dropped.
Access errors (the entity was deleted or unshared) drop the delivery; other read
failures leave it with the relay, which offers it again with backoff, and the rest of
that batch waits for the retry instead of timing out in turn. Retried deliveries can
arrive after later ones; each is read back in its current state.

Switching an existing installation is explicit, from **Event Delivery** in its
settings. Moving to webhooks mints the endpoint and shows the URL, event types and a
field for the signing secret to configure in the Linear app; moving back disables the
endpoint and forgets the secret. Deliveries the relay had already claimed at that
moment are dropped. Either switch reconnects the integration.

## Live events

Each app identity has an authenticated `graphql-transport-ws` connection to
`wss://api.linear.app/graphql`. The bearer is supplied in the HTTP upgrade header.
Subscriptions include the notification, comment or issue-history event payload.
Each received event is routed directly into its issue session; there are no
notification scans, issue-history queries, recovery cursors or periodic checks.

There is no startup or reconnect catch-up and no polling fallback. Messages and
changes that occur while disconnected are not recovered. Reconnecting restores
the socket and local thread participation, then handles newly received events,
matching the Slack connector's delivery model. Opening a task session can still
fetch the current issue and discussion for context; that snapshot does not create
new invocations from missed messages.

The app's live assignment and mention notifications discover newly involved
issues, including a first mention on an undelegated issue. Notifications for other
recipients are ignored. Human replies in an involved thread and human comments on
delegated issues invoke the agent. Comment edits and other discussions provide
context; editing an old comment does not replay it as a new request. Status
changes invoke work only when enabled. External unassignment, cancellation and
archival events stop work, while the agent's own state changes let it finish its
reply. Human assignment and agent delegation remain separate.

The shared manager durably deduplicates overlapping comment and mention deliveries.
Thread participation persists as up to 1,000 issue/thread pairs in the existing
integration config, scoped to the app identity and workspace. Session mappings use
the existing integration session store. Locally accepted inputs and host failure
notices use the same [durable delivery and bounded retries](integration-delivery.md)
as Slack, Telegram and iMessage; there is no task-specific queue or remote catch-up.
Sockets pace registration,
maintain heartbeats, renew tokens and reconnect with bounded backoff. Subscription
failure is reported as an unhealthy connection; it never enables a polling path.

## Sessions, tools and output

Provider hooks implement creation, authorization and callbacks under the shared
`/api/agent-integrations` contract. Linear registers its setup and settings panels
with the common renderer; it has no separate management router. The
`list_agent_integrations` tool discovers Linear alongside chat accounts.

All providers share the Agent Home integration list, integration page, status/settings/model
controls, and read-only conversation viewer. Provider-specific setup fields live within
that layout. The API exposes a credential-free `PublicAgentIntegration` contract and
capabilities so the shared UI only offers supported controls. Existing chat API URLs
remain available as aliases.

The manager stamps every integration session as automated. Such sessions are hidden
from the main sidebar unless explicitly promoted for human interaction; legacy chat
and task metadata remains supported. Integration pages retain their conversation history.

The session key is `(integration ID, issue UUID)`, with no inactivity timeout. Linear
does not offer conversation reset, idle timeout, or streaming tool activity controls.
Follow-ups go straight into that session, including during a running turn, using
the runtime's existing queue/steering behavior. Each incoming message includes
its own reply destination and reads a
fresh issue snapshot, including paginated comments and linked attachments (up
to 1,000 of each, with a truncation indicator).

Outbound tools are exposed as an **integration-owned MCP connection** in every
session of the owning agent, including ordinary chat. The connection is derived
from the integration row, with a stable `integration:<id>` proxy ID and
`agent_integration_<id>` tool namespace. There is no `remote_mcp_servers` row,
separate assignment, permission editor, or independently removable connection.

The provider supplies `IntegrationMcpConnection` through the integration registry.
Container startup and runtime updates append these connections to `REMOTE_MCPS`.
Only identity metadata, tool names and the local proxy URL enter the container.
The shared MCP proxy validates the agent's container token and current parent
ownership/lifecycle, then gets an access token through the integration's existing
refresh path. It skips user-owned MCP policy/review prompts for this identity.
Calls use the normal transport and audit path; `mcp_audit_log.remote_mcp_id`
retains `integration:<id>` after the parent is removed. User-owned MCP behavior is
unchanged.

The upstream is Linear's hosted Streamable HTTP endpoint,
`https://mcp.linear.app/mcp`, authenticated with the existing app OAuth bearer.
Tool discovery uses the shared MCP handshake. Pausing removes the runtime
connection and blocks existing proxy clients. Resuming restores it. A rejected
credential requires reconnecting the parent integration, not a separate MCP
OAuth flow. Reauthorization cannot change the app identity.

After handing a new comment request to the manager, the adapter adds an eyes reaction
to that comment. Deduplicated events do not get a second reaction. A reaction
failure does not block the run.

The agent receives two kinds of guidance:

- Every session knows the agent has its own Linear identity, the workspace and
  MCP namespace, and where to reconnect it.
- An issue session additionally gets the issue UUID and reply thread. It should
  explicitly post a concise response through MCP, preserve human assignment and
  delegation, and only change status when asked. A final Gamut response is private.

There is **no automatic final-comment publisher or summarizer**, no custom ticket
CRUD gateway, and no second attachment toolset. MCP owns search, read, create,
update and comment operations. The agent must check results before claiming
success. An interrupted or failed run cannot retract an MCP mutation that already
succeeded. The provider never retries an agent turn or publishes a transcript draft.

For clarification, guidance asks the agent to comment in Linear and end the turn;
a human follow-up starts the next turn in the same issue session. Gamut-only input
such as secrets and permissions stays in Gamut. Issue comments remain new messages;
they are not consumed as answers to Gamut input cards. The shared host owns pending
requests, review resolution and runtime activity.

## Outbound file attachments

Use Linear MCP's native upload flow: `prepare_attachment_upload` returns signed
upload instructions; upload the workspace bytes using those instructions, then
`create_attachment_from_upload` attaches the asset to the issue. Use `save_comment`
to embed an image or link the returned asset in the reply. Tool schemas are
discovered from Linear, so file limits and supported operations follow the provider.
The integration does not stage files or maintain a second publication outbox.

## Outbound availability

Discovery runs once on connection and when accepted work needs tools, using a
five-minute cache for healthy results. It does not run periodically while idle.
If MCP is unavailable while preparing an input, the shared manager retries
preparation with a bounded budget, then delivers a failure notice if exhausted.
The shared integration UI shows **Degraded** when inbound events work
but MCP is unavailable; transient failures do not clear credentials. Proxy
failures also update outbound health. A 401 requires reconnecting the parent
identity. Outbound calls never need platform login or a webhook relay; inbound
events need the relay only with the webhook transport.

## Native agent panel and follow-ups

With webhooks disabled, the live test app reports `supportsAgentSessions: false`
and `agentSessionCreateOnIssue` returns “Agent sessions are not enabled for this
application.” V1 therefore uses named app identities, issue sessions and ordinary
comment threads. It does not expose Linear's native Agent Session panel, native
activity progress, or that panel's Stop signal.

Shared webhook delivery ([SUP-871](https://linear.app/datawizz/issue/SUP-871)) gives
Linear its webhook transport. Enabling the `AgentSessionEvent` category, and with it
the native panel, is a follow-up. OAuth app creation through Linear's alpha
API is also deferred; initial setup uses prefilled application URLs.

Live validation confirmed the existing app OAuth token authenticates to the hosted
MCP and `get_user("me")` returns the integration's app-user ID. Discovery returned
66 tools, including issue search/edit, comments and native uploads. A TEST-team
smoke test created an issue, posted an app-authored comment and reply, uploaded
and attached a CSV with the native tools, and marked the test issue Done. Unit tests cover
cross-agent isolation, pause/delete, shared token refresh, stale authorization
responses, auditing, outage recovery and both database drivers. Full two-app
end-to-end agent testing remains separate from the proxy isolation tests.

The app shows each Linear input as a ticket preview (identifier, title, status,
priority, labels, people and a description excerpt), with the invoking comment and its
author beneath it for comment events; an assignment shows the ticket alone. The preview
is built from the same snapshot the agent reads and stored beside the transcript; the
agent's input text is unchanged and stays behind the card's **Agent input** toggle. See
[Message display](agent-integrations.md#message-display).

References: [app manifests](https://linear.app/developers/oauth-app-manifests),
[OAuth](https://linear.app/developers/oauth-2-0-authentication),
[official MCP](https://linear.app/docs/mcp),
[public GraphQL schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql),
[rate limits](https://linear.app/developers/rate-limiting),
[file uploads](https://linear.app/developers/how-to-upload-a-file-to-linear),
[agent interaction](https://linear.app/developers/agent-interaction).

## Authorization recovery and ingestion health

Expired or cancelled OAuth attempts, failed token exchange, and revoked access show
**Reconnect needed** in the shared integration UI. Reconnect starts a fresh, one-use
OAuth attempt with stored app credentials; **Edit app credentials** replaces them.
The setup page can restart an unfinished attempt after a reload. Credentials and
provider error bodies are never returned to the browser.

After verifying the app identity, the integration opens its subscriptions and
reports connected only when they are ready. A socket outage reports unhealthy
until reconnect succeeds; repeated errors in the same outage are reported once.
The shared manager retains its standard connection health checks. These checks
rebuild failed connections but never fetch missed issues or messages.

App-authored comments are retained as issue context, but cannot implicitly invoke
an agent or answer its pending question. App-authored mentions and assignments do
not invoke another agent, and app-authored status changes do not start new work.
Human requests and cancellation controls continue to work normally.

## Storage

This provider introduces no database migrations or task-event tables. Credentials,
bounded thread membership and shared session mappings use the existing integration
storage. Durable inbound delivery and retry state are a separate shared-infrastructure
enhancement, not part of the Linear provider.
