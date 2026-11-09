# Team directories

An admin connects a workspace directory (Slack first) in **Settings → Team Directory**. Its people who aren't on Gamut can then be found wherever an agent is shared or a teammate is mentioned, both of which read `GET /api/agents/:id/access/search-users`. The code is in `src/shared/lib/team-directory/`. The ticket is SUP-1563.

## Providers

A provider implements `TeamDirectoryProvider` (`types.ts`) and is listed in `registry.ts`:

- `info` describes its connect form: fields, setup steps and an optional setup link. The Settings tab draws the form from this alone.
- `credentialsSchema` validates what the form posts. The result is stored sealed.
- `verify(credentials)` checks the credentials and names the workspace (`tenantId`, `tenantName`). It throws `DirectoryConnectError` with a message the admin can act on.
- `open(connection)` returns a `TeamDirectory`:
  - `listUsers()` returns everyone in the directory.
  - `notifyUser?()` is optional, for providers that can message a person.

The provider leaves out non-people: bots and app users, guests, people invited but not joined, and deactivated accounts. It reports `emailVerified` only when the provider vouches for the address.

Nothing outside `providers/` may branch on which provider it is. This covers search, merging, the cache, the routes and the UI. A second provider only implements the interface and registers itself. `testing/fake-directory-provider.ts` is a test-only provider that goes through every one of those paths; the tests run it alongside Slack to show this.

### Slack

The Slack provider (`providers/slack.ts`) uses a bot token (`xoxb-`) with `users:read` and `users:read.email`. Settings links to Slack's "create an app" page with a manifest that asks for just those scopes.

- `verify` calls `auth.test` and reads the granted scopes from `x-oauth-scopes`. If that header is missing, it asks for one page of `users.list` instead.
- The tenant is the Enterprise Grid id when there is one, because user ids span a grid's workspaces. Otherwise it is the team id.
- `listUsers` pages through `users.list`, 200 at a time, up to 5,000 people.
  - It leaves out deleted users, bots, app users, Slackbot, restricted and ultra-restricted users (guests), and invited users.
  - A user's email counts as verified only when Slack sets `is_email_confirmed`.
- A 429 is waited out (Retry-After) up to three times.

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
