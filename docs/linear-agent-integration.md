# Linear agent integration

`LinearAgentIntegration` extends `TaskManagerAgentIntegration`, which extends
`AgentIntegration`. The application manager consumes only the base contract.
The task family owns issue sessions, a durable inbox, per-issue execution order,
context preparation, session-bound tools, and final publication. Linear owns
OAuth identities, direct event delivery, GraphQL, and comment threads.

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
integration revokes its token. Remove the OAuth application in Linear settings
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
delegation, canceled/archived issues, and confirmed lost issue access stop work
before accepting a recovered backlog. Stop timestamps prevent old requests from
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

The container exposes `integrations.list_integration_tools` and
`integrations.execute_integration_tool`. The SDK supplies its current session ID;
the model cannot supply an issue ID. The authenticated host resolves the session's
installation and destination before exposing operations:

- Read the current issue, properties, discussion and linked attachments.
- Edit the title, description or priority.
- Change status using a state from the issue's team.
- Add an HTTPS attachment link, rename it, or remove a linked attachment.
- Prepare an exact final Markdown reply, with optional workspace file attachments, for publication after a successful turn.

Edits check the issue's `updatedAt` before mutation. This detects intervening
changes but is not an atomic compare-and-swap: Linear can accept a concurrent
edit between that read and the mutation. Attachment changes verify ownership.
Tool authorization is checked again after token renewal and before HTTP dispatch.

After durably accepting a new comment request, the app adds an eyes reaction to the
triggering comment (including a reply, rather than its thread root). Duplicate events
are not acknowledged again, and a failed reaction does not block the run. Context-only
updates do not receive reactions.

Only the final answer is published, as a comment under the app's own name and in
the originating thread where applicable. Long answers use the configured
summarizer; failure falls back to the final answer. Progress deltas, tool traces,
and model reasoning are not posted. Failures suppress prepared success drafts.
Pending publications retry with the same saved UUID and content. Restarting does
not repeat a potentially side-effecting run.

Single-question replies can resume a waiting turn in Linear. Secrets, permission
approvals, file-upload requests from the user and complex forms must be completed in the Gamut issue session.
Stop work in Gamut, remove delegation, or cancel the issue.

## Outbound file attachments

`prepare_task_reply` accepts an optional `attachments` array; there is no separate
model-facing upload tool. For example:

```json
{
  "body": "Here is the graph and the underlying data.",
  "attachments": [
    { "path": "/workspace/output/chart.png", "caption": "First 15 Fibonacci numbers" },
    { "path": "/workspace/output/data.csv", "filename": "fibonacci.csv" }
  ]
}
```

A reply can include up to five files, each at most 10 MiB (Gamut's initial limit).
Paths must resolve to files inside the current agent's workspace. Preparation
snapshots the bytes in a private host spool and saves their metadata alongside the
exact reply. Each prepare call replaces the entire draft, including its attachments;
an invalid replacement preserves the previous draft. Files are not uploaded or
posted until the turn succeeds. Failure or cancellation suppresses the success draft.

The task-manager abstraction owns staging, limits, upload checkpoints and cleanup.
The Linear adapter uses `fileUpload` and a signed server-side PUT into Linear's private
storage. The existing app OAuth scopes suffice; webhooks and public hosting are not
required. PNG, JPEG, GIF and WebP images are embedded in the final comment; other files
are linked for download. Captions are included below each file. This supports outbound
files, not automatically downloading files referenced in incoming issue comments.

Upload receipts are saved after each successful upload. Comment retries reuse those
assets and the existing publication UUID, including after restart. Attachment URLs
are added after text processing so summarization cannot remove them. A crash between
an upload completing and its receipt being saved can leave an unreferenced Linear
asset; recovery can repeat that upload, but still uses the same comment UUID.
Local snapshots are removed on delivery, draft replacement, failure, cancellation,
or integration removal. Recovery prunes abandoned snapshots older than 24 hours
while retaining pending publications. Failed uploads remain in the durable outbox
and retry without posting a partial comment.

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

Live validation used a temporary client-credentials app in Test Team (TES-5 and
TES-6), with webhooks disabled. Production setup uses authorization-code OAuth
with refresh tokens; a separate app was subsequently authorized through the HTTPS
dev instance and used for delegation and comment follow-ups on TES-7. A live two-app
installation isolation smoke test remains outstanding. Outbound attachment delivery was
subsequently verified end to end on TES-8 through the running agent: Linear stored one
app-authored comment with a native image node and a native CSV file node; authenticated
downloads matched the workspace files byte for byte.

A shared renderer for automated integration messages is tracked in
[SUP-879](https://linear.app/datawizz/issue/SUP-879). It will separate display metadata
(integration name, provider/type, source link and preview) from model-facing context.
Until then, the shared conversation viewer still displays the context text.

References: [app manifests](https://linear.app/developers/oauth-app-manifests),
[OAuth](https://linear.app/developers/oauth-2-0-authentication),
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

The first recovery query must succeed before the integration connects. After
connection, three consecutive failed syncs mark it unhealthy and notify once per
outage, while bounded automatic retries continue. A successful sync restores
connection health; the shared manager clears the error. WebSocket failures alone
do not mark it unhealthy while direct polling still succeeds.

App-authored comments are retained as issue context, but cannot implicitly invoke
an agent or answer its pending question. App-authored mentions and assignments do
not invoke another agent, and app-authored status changes do not start new work.
Human requests and cancellation controls continue to work normally.
