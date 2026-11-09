# The session index

Each agent has a session index: one entry per session, holding what the app keeps about it (name, star, how it was started, its model binding, its automation outcome) and its transcript as last seen (last activity, birth time, size).

It replaced two things. `session-metadata.json` in the workspace held every session's metadata in one document that was rewritten whole on every change. The session summary cache held each transcript's stat in memory and rebuilt itself from a stat of every transcript after a restart and every five minutes. On a network volume with thousands of sessions both were slow: megabytes rewritten to rename one session, and thousands of round trips to list them.

## Who owns it

The agent's actor. The index is on its `SessionStore` (`store.index`), beside `files` and `config`, and everything outside the actor reaches it through `actor.sessions.*` like any other session operation.

Where the entries are stored is the actor's choice, behind `SessionIndexStorage` (`src/shared/lib/agent-actor/session-index.ts`):

- An actor in this process (`LocalAgentActor`) keeps them in the app database, table `agent_sessions`, through `db-session-index-storage.ts`. That module is the only one that reads or writes the table. The factory reset empties it with every other table.
- An actor that runs elsewhere (a Durable Object, say) implements the same seven operations on its own storage. It has no access to the host's database and needs none.
- Tests use `createInMemorySessionIndexStorage()`. One contract suite (`testing/session-index-storage-contract.ts`) runs against every implementation.

So do not query `agent_sessions` from a route or a service, do not join against it, and do not point a foreign key at it. A view across agents (the agents list) asks each actor.

## Two authorities

- **What the app keeps about a session**: the index is the truth. A change is a read-modify-write of one entry (`index.update`), safe against concurrent writers by compare-and-set, so the mutator may run more than once and must be synchronous and free of side effects.
- **Whether a session exists**: the transcripts directory is the truth. The CLI and the agent create and remove transcripts without telling the host, so every read that lists sessions first reconciles the index with the directory.

Reconciliation is cheap by construction:

| The directory… | A read costs |
|---|---|
| is unchanged since the last read (same mtime) | one stat of the directory |
| changed, or this is the first read after a restart | that stat, one listing of the directory, and one stat per transcript the index has **not** seen |

A transcript is statted once in its life. A transcript the listing lacks is confirmed gone by its own stat before its entry (metadata included) is dropped. A transcripts directory that is not there is no evidence of anything, and neither is one with no transcript in it (`index.canConfirmGone()`): a volume that went away can leave an empty directory at its path, and it must not cost every session its name. The price is that sessions really all removed by hand keep their entries until a transcript is written again or they are deleted in the app. The background prune of registrations whose transcript never came follows the same rule.

A directory's mtime cannot tell two changes in one tick of the filesystem's clock apart. So activity recorded for a transcript the index has not seen makes the next read list the directory again, whatever its mtime says (`index.lookAgain()`).

## Last activity

A session's last activity is **not** its transcript's mtime after the first sighting. Every transcript write the host knows of goes through `recordSessionActivity()` (`services/session-activity.ts`): a message sent, a stream frame received, an append, a rewrite. The index stores those behind the caller, one write at a time, and every read waits for them, so a read never answers with less than was recorded. A new place that writes a transcript must record it, or the session will not move up the list.

A send is recorded provisionally before the container confirms it (`recordProvisionalSessionActivity`): it shows in what is read, is taken back if the send fails, and is stored only once a real write follows.

## A registration without a transcript

A session is registered (an entry with metadata, no transcript) a moment before its first turn writes the transcript, and is listed from the registration meanwhile. One that is still alone after `NEW_SESSION_GRACE_MS` (an hour) is taken for deleted: it is left out of listings and removed in the background, after a stat confirms there is no transcript.

## `session-metadata.json` today

The file is the index's portable form (`services/session-metadata-file.ts`). Nothing reads it at runtime.

- **A full export** writes it into the archive from the index, each entry carrying `lastActivityAt`. Nothing is written into the workspace.
- **A full import** takes the archive's file into the new agent's index and removes it from the workspace. `lastActivityAt` is trusted, since an extracted transcript's mtime is the time of the import; a transcript the file does not mention is statted when first listed. A template import never carries the file.
- **A workspace from an older build** has one. Data migration `0010-import-session-metadata` takes every local agent's file into its index and removes it. It reads only the file; the transcripts are statted by the first listing. Nothing else ever reads the file, so while some agent's could not be taken in (an error, or a workspace with nothing in it, which is how one whose volume is not mounted looks), the migration answers `'incomplete'`, is not recorded, and runs again on the next boot.

Ingesting never replaces metadata the index already holds, so running it again over a half-ingested file changes nothing. A file that does not fit is set aside as `session-metadata.corrupt-<time>.json`, and every entry of it that does fit is still taken: the file was the agent's to edit, and one bad entry must not cost the others their names. The same goes for a stored row whose metadata cannot be read: that session lists as one without metadata, and the agent's listing does not fail.

## The agent's own view

An agent used to read its sessions' names from the file, and could rename one by editing it. The file is gone from the workspace, so the session helpers in its container (`agent-container/bin`) ask the host instead, at `/api/x-agent/sessions`, with the agent's own proxy token (`SUPERAGENT_HOST_API_URL` and `PROXY_TOKEN` are in every tool call's environment):

- `GET /` answers the names of the caller's sessions. `list-sessions.py` headlines each session with it, and falls back to first messages, saying why, when the host cannot be reached.
- `PATCH /:sessionId` renames one. It takes a name and nothing else: how a session was started and who started it are not the agent's to say, which the file never enforced.
- `DELETE /:sessionId` deletes one, through `deleteSessionAndRecords()`, the same function the app's own delete uses, so the notifications, unread marks and pending wake go with it. A session that is running or waiting for input is refused, which covers the one the agent is in.

`manage-session.py rename|delete` is the helper for the last two. The token names the agent, so no request can reach another agent's sessions. An agent that removes a transcript file by hand still takes the session off the list (the next read reconciles), but leaves those side records behind.

To look at an agent's session metadata by hand, an admin reads `GET /api/debug/agents/:id/session-metadata`. The E2E suite does the same (`e2e/helpers/session-metadata.ts`).

## Tests

- A test file that builds local session stores or real actors needs a place for the index. With a database: `perTestDatabase()` (`db/testing/per-test-database.ts`). Without one: mock `db-session-index-storage` with `inMemorySessionIndexModule()`.
- A test that drives live sessions with the session service mocked usually mocks `services/session-activity` too. Recording activity stores it in the background, and a background failure (no database, or one closed by the test's teardown) fails a test run by design.
- `perf/` pins the file operations of the session routes under a simulated network volume. Tighten a budget in the same change that earns it.
