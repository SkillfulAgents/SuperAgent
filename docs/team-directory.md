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

The Slack provider (`providers/slack.ts`) uses a bot token (`xoxb-`) with `users:read` and `users:read.email`, plus `chat:write` and `im:write` to DM invitations (`providers/slack-directory-app.ts`).

- **Usually Gamut makes that app.** The admin pastes the refresh token of an app configuration token, and one Install connects the directory. See [Connecting with one token](#connecting-with-one-token).
- **Or an admin makes it by hand.** "Use a Slack app you already have" takes a bot token. Settings links to Slack's "create an app" page with a manifest that asks for the four scopes. A token without the DM scopes still connects, with a notice that invitations won't go by DM.

The rest is the same either way:

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
| POST | `/install` | Connect with app-creation credentials alone: `{ installId, url }` ([Connecting with one token](#connecting-with-one-token)) |
| GET | `/install/:installId` | How that install went: `pending`, `connected`, `cancelled`, `failed` or `expired` |
| GET | `/install/callback` | Where the provider's install page returns. Public: the one-time state identifies the install |
| POST | `/:id/refresh` | List now: `{ ok, userCount }` or `{ ok: false, error }` |
| POST / DELETE | `/:id/provisioning` | Add or replace / remove the credentials for agents' apps ([Agent apps](#agent-apps)) |
| DELETE | `/:id` | Disconnect, drop the cached listing, and delete the app Gamut made for it |

Connecting and disconnecting are audited as `team_directory`.

Under `E2E_MOCK=true` the registry also has a **Demo Directory** (`testing/e2e-directory.ts`) with a fixed roster, for the auth E2E suite (`e2e/auth/specs/team-directory.spec.ts`) and PR screenshots. It connects with any key (its install page is the host's own callback, so the window comes straight back), or by hand with the token `acme-token`.

## Connecting with one token

`directory-app.ts`. When a provider's `provisioning` has `createDirectoryApp`, Settings offers its credentials as the way in. For Slack that is the refresh token of an app configuration token, the same one agents' apps need. The admin's steps:

1. **Paste.** Settings → Team Directory: open Slack's Your Apps, generate a token for the workspace, paste its refresh token, Continue (`POST /install`).
   - The host verifies the token, which rotates it once, then creates the directory's app with the host's callback as its redirect URL (`apps.manifest.create`; the app has no events, so no webhook relay).
   - The pending install is held in AppState (`oauth:directory-app-install`, 30 minutes), with the rotated credentials and the app sealed.
   - A failure from here on needs a new token, since the pasted one has been rotated.
2. **Install.** One click opens the provider's install page in a window (the system browser in the desktop app).
   - The callback consumes the state and exchanges the code (`completeInstall`). What it gives is the directory's credentials (Slack: the bot token).
   - The provider's own `verify` names the workspace, the directory is saved, and the provisioning credentials and the app (`directory_app`, sealed) are stored on its row. Agent apps are ready from then on.
   - Settings polls `GET /install/:installId` and closes the window once the install is done.
3. **Done.** The directory is listed straight away, like one connected by hand.

Other cases:

- **Declined.** A declined install leaves the state, so the same Install button can try again until it expires.
- **Failed.** An install that can't connect the directory deletes the app and reports why.
- **Reconnected.** Connecting a workspace again deletes the app Gamut made for it before.
- **Disconnected.** Disconnecting deletes the directory's app (`directoryAppCleanup`) when the provisioning credentials still work.
- **Abandoned.** An install left unfinished leaves its app behind in Slack.
- **HTTPS.** Slack's install page returns to the host's public URL (`HOST_PUBLIC_URL`, else the first trusted origin). Slack expects that URL to be HTTPS, so a desktop app on `http://localhost` should use a bot token.

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

## Agent apps

A connected directory whose provider has `provisioning` (`AgentIdentityProvisioning`, types.ts) can give each agent its own app in its workspace, with the agent's name, @handle, colour and avatar. Setting one up is **Create → Install** instead of copying tokens. Slack is the only one so far; Linear and GitHub can't create apps through an API, and Notion has no route at all. The host side is `provisioning.ts` and is the same for every provider.

### Credentials

They are sealed on the directory's row, apart from its own (`provisioning_credentials`, migration 0066), because they rotate and the people cache must not move with them. A directory [connected with one token](#connecting-with-one-token) has them from the start. For one connected by hand, an admin adds them under **Agent apps** in Settings → Team Directory.

- **Rotation.** `needsRotation` says when stored credentials are due: for Slack, an hour before the 12-hour app configuration token expires. They are rotated then, before any use, and by the `team-directory-provisioning` service's pass every 6 hours, so the chain survives weeks with no new apps.
- **One rotation at a time.** Rotations go through the lease `claim:team-directory-provisioning` per directory: Slack's rotation retires the old refresh token, so two at once would break the chain.
  - The holder decides from what is stored once it holds the lease (the holder before it may have just rotated).
  - It confirms the lease for the request's timeout before it sends.
  - It saves the new pair before anything uses it, conditional on `provisioning_revision`. A pair an admin added meanwhile stands.
- **A broken chain** (`ProvisioningCredentialsError`) marks the directory `needs_reconnect` with the reason. Apps already installed keep working, since their bot tokens are their own; only creating or changing apps waits for an admin to add a new token. An outage or rate limit leaves the pair as it is for the next pass.

### The setup flow

1. **Describe.** `GET …/providers/:provider/setup` adds `provisioning: { directoryId, workspace }` when an active directory can create that provider's apps and the provider receives webhooks. Any agent owner may use it.
2. **Create.** The setup form posts the usual input with `provision: { directoryId, name, description?, backgroundColor?, icon? }`. `icon` is the agent's avatar as a base64 PNG, rendered by the browser as for the manual "Download icon".
   - `prepareIntegrationSetup` takes `provision` out of what the provider sees. It requires webhooks.
   - It mints the relay endpoint, then has the provisioner create the app with that webhook URL and the host's OAuth callback.
   - It updates the endpoint's signature check with the app's secret.
   - It stores the provider's fields (Slack's `signingSecret`) and `provisionedApp` (`agent-integrations/provisioned-app.ts`, host-owned). The installation waits, `disconnected`.
   - If anything fails, the app and the endpoint are undone.
3. **Install.** `POST /:integrationId/authorize` on an installation with an uninstalled `provisionedApp` returns the provider's install URL with a one-time `state`, held in the strong AppState namespace `oauth:agent-app-install` for 30 minutes.
   - The callback consumes the state, then exchanges the code (Slack's `oauth.v2.access`) and writes the result (Slack's `botToken`). The installation goes `active`, and the host resumes it.
   - A replayed callback finds no state.
   - Installing with no click at all needs Slack's partner-only `managed_apps:install`.
4. **Rename and icon.** `POST /:integrationId/app { name?, icon? }`. For Slack, this exports the manifest, changes `display_information.name` and `bot_user.display_name`, and updates it. `apps.icon.set` sets the icon. An icon that fails at creation leaves `iconSet: false`, and the integration page offers "Set icon".
5. **Delete.** Deleting the installation deletes its app (`cleanupIntegrationResource`).

The client sees `provisionedApp` as `{ directoryId, installed, name, iconSet, settingsUrl? }`, never the app's secrets. The integration page's **App** card (`provisioned-app-card.tsx`) is the same for every provider.

### Slack specifics

`providers/slack-provisioning.ts`.

- **Credentials.** The admin pastes only the refresh token (`xoxe-…`): `tooling.tokens.rotate` takes nothing else and returns the access token (`xoxe.…`) and when it expires, so verifying is one rotation. Pasting the access token instead is refused with a message that says so. Added to a connected directory, the token must be for its workspace (a grid directory spans its workspaces); connecting one, it names its own.
- **Apps.** An agent's app uses the manifest from `slackAppManifest` (the same one manual setup prefills), the directory's own app `slackDirectoryAppManifest` (four scopes, no events); both add `oauth_config.redirect_urls`. The directory's app gets the Gamut logo as its icon (`slack-directory-icon.ts`, inlined like the vCard photo), best effort. `apps.icon.set` is multipart. `apps.manifest.export` / `apps.manifest.update` rename, and `apps.manifest.delete` deletes.
- **Limits.** The Manifest API is marked beta. `apps.manifest.create` and `apps.icon.set` are Tier 1 (about one a minute); apps are made one at a time from the setup form, so there is no queue yet.
- **Apps made by hand** have only a bot token, and Slack has no API for a bot to rename itself. The connector records the app's id (`auth.test` → `bots.info`, host-owned `appId`), and the integration page links to the app's settings in Slack instead.

