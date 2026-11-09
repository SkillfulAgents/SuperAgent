# Team directories

An admin connects a workspace directory (Slack first) in **Settings → Team Directory**. Its people who aren't on Gamut can then be found wherever an agent is shared or a teammate is mentioned, both of which read `GET /api/agents/:id/access/search-users`. The code is in `src/shared/lib/team-directory/`. The ticket is SUP-1563.

## Providers

A provider implements `TeamDirectoryProvider` (`types.ts`) and is listed in `registry.ts`:

- `info` describes its connect form: fields, setup steps and an optional setup link. The Settings tab draws the form from this alone.
- `credentialsSchema` validates what the form posts. The result is stored sealed.
- `verify(credentials)` checks the credentials and names the workspace (`tenantId`, `tenantName`, and `notices` for what works but is limited, like a missing optional scope). It throws `DirectoryConnectError` with a message the admin can act on.
- `open(connection)` returns a `TeamDirectory`:
  - `listUsers()` returns everyone in the directory.
  - `notifyUser?()` is optional, for providers that can message a person. It gets a `DirectoryMessage` (headline, optional quote, link) in plain text and formats and escapes it itself.

The provider leaves out non-people: bots and app users, guests, people invited but not joined, and deactivated accounts. It reports `emailVerified` only when the provider vouches for the address.

Nothing outside `providers/` may branch on which provider it is. This covers search, merging, the cache, the routes and the UI. A second provider only implements the interface and registers itself. `testing/fake-directory-provider.ts` is a test-only provider that goes through every one of those paths; the tests run it alongside Slack to show this.

### Slack

The Slack provider (`providers/slack.ts`) uses a bot token (`xoxb-`) with `users:read` and `users:read.email`, plus `chat:write` and `im:write` to DM invitations. Settings links to Slack's "create an app" page with a manifest that asks for those four scopes. A token without the DM scopes still connects, with a notice that invitations won't go by DM.

- `verify` calls `auth.test` and reads the granted scopes from `x-oauth-scopes`. If that header is missing, it asks for one page of `users.list` instead.
- The tenant is the Enterprise Grid id when there is one, because user ids span a grid's workspaces. Otherwise it is the team id.
- `listUsers` pages through `users.list`, 200 at a time, up to 5,000 people.
  - It leaves out deleted users, bots, app users, Slackbot, restricted and ultra-restricted users (guests), and invited users.
  - A user's email counts as verified only when Slack sets `is_email_confirmed`.
- A 429 is waited out (Retry-After) up to three times.
- `notifyUser` opens a DM (`conversations.open`) and posts the message there (`chat.postMessage`), escaping `&`, `<` and `>`.

## Storage

`team_directories` holds one row per connected workspace, unique on `(provider, tenant_id)`.

- Credentials are AES-256-GCM sealed under a key derived from the deployment's auth secret (`credentials.ts`). They are bound to the provider and tenant.
- Connecting a workspace that is already connected replaces its credentials and bumps `revision`.
- `status` / `error_message` describe the last listing.

People are never stored.

## The cache

`cache.ts` keeps each directory's listing in AppState: the eventual namespace `cache:team-directory`, keyed by directory id and credentials revision.

- **Fresh for 10 minutes.** After that, the cached list is answered at once and a new listing runs in the background (`background()`).
- **Nothing cached yet.** A typed search waits up to 2.5 s for the listing and answers without that directory if it runs over. An empty search (the picker opening) only starts the listing, so the next keystroke finds it.
- **A failed listing** keeps the last good one, is not retried for a minute, and sets the directory's status to `error` with the message. The status is written only when it changes.
- **Concurrent searches** in one process share one listing (a process-local map of Promises). Two processes may both list a stale directory; the later write wins.
- **Expiry.** Entries expire 6 hours after the last write. Disconnecting deletes the directory's entry.

## Search

`search.ts` does all the matching, the same for every provider:

1. Read every connected directory's cached listing.
2. Merge people by **verified, lowercased email**. The first directory to list a person names them; later ones only fill in a missing avatar. People without a verified email are left out: an unverified address could be anyone's, and it can't safely name the account they sign in with later.
3. Rank by name prefix, then a word or email prefix, then a substring.
4. Drop anyone whose email belongs to an account of any status, chunked by 90 because D1 binds at most 100 parameters. Those people come back as accounts instead.

`invite-candidates.ts` puts accounts first (`kind: 'user'`), then directory people (`kind: 'directory'`, `notOnGamut: true`, `directoryRef: { directoryId, remoteId }`). Directory people are included in auth mode only, since local mode has nobody to share with. The endpoint is `AgentAdmin`, so only people who can share the agent see them. The types are in `candidate-schema.ts`, shared with the renderer.

## Routes

`/api/team-directories` (`src/api/routes/team-directories.ts`, admins only):

| Method | Path | |
|---|---|---|
| GET | `/` | Providers (`info`) and connected directories, without credentials |
| POST | `/test` | Verify `{ provider, credentials }` without saving |
| POST | `/` | Verify and connect (or replace the credentials of the same workspace), then list it in the background |
| POST | `/:id/refresh` | List now: `{ ok, userCount }` or `{ ok: false, error }` |
| DELETE | `/:id` | Disconnect and drop the cached listing |

Connecting and disconnecting are audited as `team_directory`.

Under `E2E_MOCK=true` the registry also has a **Demo Directory** (`testing/e2e-directory.ts`, token `acme-token`) with a fixed roster, for the auth E2E suite (`e2e/auth/specs/team-directory.spec.ts`) and PR screenshots.

## Invited users

Someone who isn't on Gamut yet becomes a real `user` row with `status: 'invited'` the first time someone shares an agent with, or mentions, them (`invited-users.ts`). Browsing a directory writes nothing.

- **The row.** It is named by a verified, lowercased email, has no account (so nobody can sign in as it), `emailVerified: false` until they join, and records `invitedByUserId` and the directory person (`directory_provider`, `directory_tenant_id`, `directory_remote_id`). If the email already has a row of any status, that row is used. Two concurrent invites land on one row (`insert … on conflict do nothing`, then read by email).
- **Everything else is unchanged.** `agent_acl`, mention chips and `notifications` key on `user.id`, so access granted and mentions made before they join are simply there when they do.
- **Sharing.** `POST /agents/:id/access` takes `{ directoryRef, role }` as well as `{ userId, role }`. The mention menu calls `POST /agents/:id/access/invitees { directoryRef }` when a directory person is picked, so the chip names a user id like any other; the share dialog that follows passes `notify: false`, because the mention tells them itself.
- **Telling them.** A share or a mention of an invited user sends a DM through the directory they came from (`notifyInvitedUser`), when it has `notifyUser`, carrying a one-time invite link (`/?invite=<token>`, `auth/invite-tokens.ts`: a SHA-256 digest in Better Auth's `verification` table, 30 days). With no channel nothing is sent; the notification still waits in Gamut. There is no email sender (self-hosted has no SMTP), so email is not a channel yet.

### Claiming

`auth/claim-invited-user.ts`. The status flip is the claim (`update … where status = 'invited'`), so of two racing sign-ins one claims. A claim sets the role (the Platform role on a platform-controlled deployment, else the default role), applies admin approval when it is on (banned, pending approval, as a new member would be), sets `emailVerified`, revokes the person's invite links, adds them to the Team Brain, and refreshes their agents' rosters.

- **SSO (OIDC, Google, Platform).** Better Auth links the login to the row by email (implicit linking). Linking fires no `user.create`, so the claim runs in `databaseHooks.account.create.after`. On a Platform sign-in that hook still runs inside the request's role context (`platform-role.ts`), which is how the Platform role reaches a linked row. An existing *active* user who links Platform keeps their role, as before.
- **Password.** The invite link opens a join form on the sign-in page (`invite-join-form.tsx`). `POST /api/auth/invite/claim { token, name, password }` (`api/routes/invite-claim.ts`, public, behind the auth rate limit) adds a credential account in one conditional statement (only while the row is invited and has none), claims, and the form then signs in as usual. It is off on platform-controlled deployments and when local auth is off; there the form points at SSO.
- **Sign-up.** Email sign-up for an invited address is refused with code `INVITED`, pointing at the invite link: signing up would prove nothing about the address.
- The user-create hooks skip invited rows; invited rows are made outside Better Auth anyway.

### Not members yet

Invited users are left out of: the Users tab list and count (Better Auth `list-users` filtered on `status`, which is declared as a user field; they are listed apart, removable), "everyone in the workspace" (`addAgentUsers` with no ids), who an agent acts for (`countOtherMembers`), email-integration allow-lists, and web push and APNs (`getPushableAgentSlugs`). In search they are accounts with `notOnGamut: true`; in rosters they carry `invited: true` ("Invite pending"), and their mention chips are dashed.
