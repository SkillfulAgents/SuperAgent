# Linear agent integration

`LinearAgentIntegration` extends `TaskManagerAgentIntegration`, which extends
`AgentIntegration`. The application manager consumes only the base contract.
The task family owns issue sessions, a durable inbox, per-issue execution order,
context preparation, session-bound tools, and final publication. Linear owns
OAuth identities, signed event normalization, GraphQL, and native activities.

## Set up an identity

From the agent home, open **Task Platforms → Add Linear**. Sign in to Gamut first
so the hosted webhook relay can deliver events to this installation.

1. Choose the agent's name and open the prefilled Linear application form.
2. Create a **private** OAuth app for this agent. Choose its avatar in Linear.
   The form supplies the callback URL, webhook URL and event subscriptions.
3. Copy the client ID, client secret and webhook signing secret into Gamut.
4. Authorize in Linear. A workspace admin may need to approve the app and grant
   access to the intended teams.

Authorization uses `actor=app`, PKCE, expiring single-use state and the `read`,
`write`, `app:mentionable`, and `app:assignable` scopes. Gamut verifies `viewer.app`
and stores the workspace ID and app-user ID. The same external app identity
cannot be connected to a second agent. Reconnecting an existing installation
must return its original identity; create a new installation to change identity.
Credentials remain on the host. Public API responses and the agent container
never receive the Linear access token, refresh token or application secrets.
Refresh tokens rotate with one renewal in flight per installation. Disconnecting
and removing an integration disables its relay endpoint and revokes its token.
The Linear OAuth application itself can be removed in Linear settings.

## Events and sessions

Linear sends HTTPS webhooks to the existing hosted webhook relay. The relay
acknowledges ingestion; the desktop/web host polls only its endpoint's queued
events. The host verifies the raw-body HMAC and compares Linear's timestamp to
the relay's receipt time, allowing valid events to wait while the host is offline.
It commits the event to SQLite before acknowledging the relay delivery.

Native `AgentSessionEvent.created` and `prompted` events cover delegation,
mentions, and replies. Ordinary issue/comment/attachment updates refresh context
for issues already involved with the agent. Status changes trigger work only
when the integration's setting is enabled. Assignment remains human ownership;
agent delegation is separate. Completion of a run never changes issue status.

The session key is `(integration ID, issue UUID)`, with no inactivity timeout.
Each native interaction has a separate reply destination. Events for one issue
wait for its current turn to finish; different issues can run concurrently. A
new comment cannot redirect an older response. Every invocation reads a fresh
issue snapshot and paginates existing comments and linked attachments (up to
1,000 of each, with a truncation indicator).

The durable inbox deduplicates native events by session/activity ID and ordinary
updates by a stable content hash. Stop signals close the tool gate before
interrupting the runtime, and saved stop markers reject out-of-order invocations.
Revocation removes usable tokens and stops work. Permission changes recheck
active issue access; all subsequent operations remain subject to Linear's access
checks. A restart does not automatically repeat a partially executed run.
Pending final publications retry with the same saved UUID and content.

## Agent tools and output

The container exposes `integrations.list_integration_tools` and
`integrations.execute_integration_tool`. The SDK supplies its current session ID;
the model cannot supply an issue ID. The authenticated host resolves the session's
installation and destination before exposing operations:

- Read the current issue, properties, discussion and linked attachments.
- Edit the title, description or priority.
- Change status using a state from the issue's team.
- Add an HTTPS attachment link, rename it, or remove a linked attachment.
- Prepare an exact final Markdown reply for publication after a successful turn.

Edits check the issue's `updatedAt` before mutation. This detects intervening
changes but is not an atomic compare-and-swap: Linear can accept a concurrent
edit between that read and the mutation. Attachment changes verify ownership.
Tool authorization is checked again after token renewal and before HTTP dispatch.

Only the final answer is published. Long answers use the configured summarizer;
its timeout/failure falls back to the original final answer. Native response
activities produce Linear's threaded comments, so Gamut does not also create an
ordinary comment for the same response. Status-triggered work uses an ordinary
issue comment. Progress deltas, tool traces, and model reasoning are not posted.
Failures publish an error rather than a prepared success draft.

Single-question replies can resume a waiting turn in Linear. Secrets, permission
approvals, files and complex forms must be completed in the Gamut issue session.

## Deployment and validation limits

The hosted relay is required; this does not add a public listener to a desktop
installation. Keeping the host running gives prompt event handling. While it is
asleep or offline, work waits in the relay subject to the relay's retention and
claim policy. Such a host cannot satisfy Linear's 10-second initial-activity
recommendation; a permanently available worker would be a separate deployment
change. Polling uses a short interval with bounded backoff after errors.

Before enabling a real workspace, smoke-test app creation/authorization, team
access, delegation, a mention on another issue, a reply during a run, status
changes, stop, token revocation and an offline/reconnect cycle. Automated tests
use a local database and mocked provider/relay responses; they do not install an
app in a live customer workspace.

Creating OAuth applications through Linear's alpha API is deferred. The initial
setup intentionally uses supported prefilled application URLs.

References: [app manifests](https://linear.app/developers/oauth-app-manifests),
[OAuth](https://linear.app/developers/oauth-2-0-authentication),
[agents](https://linear.app/developers/agents),
[webhooks](https://linear.app/developers/webhooks),
[agent interaction](https://linear.app/developers/agent-interaction),
[signals](https://linear.app/developers/agent-signals).
