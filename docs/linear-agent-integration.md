# Linear agent integration

`LinearAgentIntegration` extends `TaskManagerAgentIntegration`, which extends
`AgentIntegration`. The application manager consumes only the base contract.
The task family owns issue sessions, a durable inbox, per-issue execution order,
context preparation and run lifecycle. Linear owns OAuth identities and direct
event delivery. The official Linear MCP owns outbound operations, through Gamut's
shared MCP proxy.

## Set up an identity

From the agent home, open **External Integrations → Add Integration → Linear**. This works without a
Gamut platform account, hosted relay, or public webhook listener.

1. Choose the agent's name and continue to its integration page. Open the prefilled Linear application form there.
2. Create a **private** OAuth app for this agent. Choose its avatar in Linear.
   The form supplies the callback URL and leaves webhooks disabled.
3. Copy the client ID and client secret into Gamut.
4. Authorize in Linear. A workspace admin may need to approve the app and grant
   access to the intended teams.

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

## Direct events and recovery

Each app identity has an authenticated `graphql-transport-ws` connection to
`wss://api.linear.app/graphql`. The bearer is supplied in the HTTP upgrade header.
The host catches up through paginated GraphQL queries on boot, subscribes, then
scans again to cover the connection gap. Subscriptions carry small identifiers
that wake the same recovery path; they do not start runs directly.

The app's own assignment and mention notifications discover newly involved
issues, including a first mention on an undelegated issue. Comments and issue
history supply updates for involved issues. Human replies in an involved thread
and human comments on delegated issues invoke the agent. Other comments and
property changes are context. Status changes invoke work only when enabled in
the integration's settings. Self-authored comments and status changes do not
invoke the agent again. Human assignment and agent delegation remain separate.

The recovery cursor is persisted only after a complete batch has been durably
accepted. Queries overlap by one minute; stable event IDs deduplicate replay.
Pagination failures and transient errors retain the previous cursor. Removed
delegation and canceled/archived issues stop work before accepting a recovered
backlog. A transient access error does not cancel a turn. Inaccessible, completed
and archived issues move to slower checks; subscription hints or a new mention
wake them immediately. Routine reconciliation reads at most 25 involved issues
per pass and keeps per-issue cursors, rather than rescanning full histories.
`issue-cursor-store.ts` stores inbound checkpoints and scheduling metadata; it does
not synchronize ticket state with Gamut. Stop timestamps prevent old requests from
starting and prevent replayed stops from canceling newer work.

Sockets pace subscription registration (burst registration closed with code 4003
in live testing), use heartbeat checks, renew tokens, and reconnect with bounded
backoff.
Periodic reconciliation runs every five minutes while the socket is available;
when it is unavailable, direct polling runs every thirty seconds, backing off
after errors. A host that is asleep or offline handles work after reconnecting.
Recovery depends on notifications, comments, and history still retained and
accessible in Linear; this is not an unlimited event log. Large numbers of
involved issues increase query cost and remain subject to Linear's API limits.

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
Events for one issue wait for its current turn to finish; different issues can
run concurrently. Each invocation retains its reply destination and reads a
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

After durably accepting a new comment request, the adapter adds an eyes reaction
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
succeeded. Recovery does not replay a potentially side-effecting turn; legacy
publication drafts are retired without posting them again.

For clarification, guidance asks the agent to comment in Linear and end the turn;
a human follow-up starts the next turn in the same issue session. Gamut-only input
such as secrets and permissions stays in Gamut. Existing single-question requests
can also be answered from the originating Linear thread. Reviews only affect a
task when their agent and session scope match, and resolutions resume that request.

## Outbound file attachments

Use Linear MCP's native upload flow: `prepare_attachment_upload` returns signed
upload instructions; upload the workspace bytes using those instructions, then
`create_attachment_from_upload` attaches the asset to the issue. Use `save_comment`
to embed an image or link the returned asset in the reply. Tool schemas are
discovered from Linear, so file limits and supported operations follow the provider.
The integration does not stage files or maintain a second publication outbox.

## Outbound availability

Discovery runs on connect and refreshes every five minutes while healthy. Failed
probes retry with the thirty-second event poll. Incoming requests remain in the
durable inbox until outbound discovery succeeds. The shared integration UI shows
**Degraded** when inbound events work but MCP is unavailable; credentials are not
cleared for transient failures. Proxy failures also update outbound health. A 401
requires reconnecting the parent identity. No platform login or webhook relay is
needed for either direction.

## Native agent panel and follow-ups

With webhooks disabled, the live test app reports `supportsAgentSessions: false`
and `agentSessionCreateOnIssue` returns “Agent sessions are not enabled for this
application.” V1 therefore uses named app identities, issue sessions and ordinary
comment threads. It does not expose Linear's native Agent Session panel, native
activity progress, or that panel's Stop signal.

Shared webhook delivery and capability discovery are tracked in
[SUP-871](https://linear.app/datawizz/issue/SUP-871). That service can later upgrade
Linear and other integrations together. OAuth app creation through Linear's alpha
API is also deferred; initial setup uses prefilled application URLs.

Live validation confirmed the existing app OAuth token authenticates to the hosted
MCP and `get_user("me")` returns the integration's app-user ID. Discovery returned
66 tools, including issue search/edit, comments and native uploads. A TEST-team
smoke test created an issue, posted an app-authored comment and reply, uploaded
and attached a CSV with the native tools, and marked the test issue Done. Unit tests cover
cross-agent isolation, pause/delete, shared token refresh, stale authorization
responses, auditing, outage recovery and both database drivers. Full two-app
end-to-end agent testing remains separate from the proxy isolation tests.

A shared renderer for automated integration messages is tracked in
[SUP-879](https://linear.app/datawizz/issue/SUP-879). It will separate display metadata
(integration name, provider/type, source link and preview) from model-facing context.
Until then, the shared conversation viewer still displays the context text.

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

After verifying the app identity, the integration reports connected while initial
catch-up runs in the background. Dispatch and session restoration wait for that
catch-up to finish. Three consecutive failed recovery passes mark it unhealthy
and notify once per outage, while bounded retries continue. A successful recovery
restores connection health; the shared manager clears the error. WebSocket failures alone
do not mark it unhealthy while direct polling still succeeds.

App-authored comments are retained as issue context, but cannot implicitly invoke
an agent or answer its pending question. App-authored mentions and assignments do
not invoke another agent, and app-authored status changes do not start new work.
Human requests and cancellation controls continue to work normally.

## Migration compatibility

The unreleased task inbox and issue-cursor migrations are consolidated into
`0046_linear_agent_integrations`. Its journal timestamp follows all previous PR
migrations, and its table/index creation is idempotent. Fresh installs and earlier
PR test installations keep their credentials, sessions, queued work, cursors and
audit history. A redundant audit column from a previous test build may remain in
that database; current code uses the existing connection ID for attribution.
